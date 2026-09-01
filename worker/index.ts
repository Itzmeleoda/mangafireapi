/**
 * MangaFire API — Cloudflare Workers entry.
 *
 * Same routes, same auth model, same caching semantics as api/index.ts
 * (Express/Vercel), but built entirely on Web-standard APIs so it runs on
 * the Workers free tier. The parsers are shared: the build aliases
 * axios -> worker/shims/axios and axiosClient -> src/utils/fetchClient.
 *
 * Secrets (set with `wrangler secret put`):
 *   API_KEYS         comma-separated mf-sk-... keys (omit = open dev mode)
 *   SCRAPER_API_KEY  optional ScraperAPI fallback if egress IPs get blocked
 * Vars (wrangler.toml):
 *   RATE_LIMIT       requests/min per key (default 60)
 */

import scrapeHomePage from '../src/parsers/homePage';
import scrapeMangaInfo from '../src/parsers/infoPage';
import { scrapeSearchResults } from '../src/parsers/searchPage';
import scrapedMangaCategory from '../src/parsers/categoryPage';
import scrapedMangaGenre from '../src/parsers/genrePage';
import { getChapters, getChapterImages, getVolumes } from '../src/parsers/readPage';
import scrapeLatestPage from '../src/parsers/latestPage';
import { cache, TTL } from '../src/lib/cache';
import { parseMangaRef } from '../src/utils/normalize';
import { configureFetchClient, client, isCloudflareBlock } from '../src/utils/fetchClient';
import { MangaCategories } from '../src/types/manga';

export interface Env {
  API_KEYS?: string;
  SCRAPER_API_KEY?: string;
  SCRAPER_RENDER?: string;
  SCRAPER_PREMIUM?: string;
  RATE_LIMIT?: string;
}

// ---------------------------------------------------------------------------
// Auth (Web-standard; no node:crypto)
// ---------------------------------------------------------------------------

function parseKeys(env: Env): string[] {
  return (env.API_KEYS || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);
}

// Constant-time string compare (Workers have crypto.subtle but sync compare
// of equal-length UTF-8 is fine for this threat model).
function keyMatches(candidate: string, keys: string[]): boolean {
  const enc = new TextEncoder();
  const cand = enc.encode(candidate);
  for (const k of keys) {
    const kb = enc.encode(k);
    if (kb.length !== cand.length) continue;
    let diff = 0;
    for (let i = 0; i < kb.length; i++) diff |= kb[i] ^ cand[i];
    if (diff === 0) return true;
  }
  return false;
}

// Per-key sliding-window rate limiter (per-isolate, best effort).
const buckets = new Map<string, { count: number; resetAt: number }>();

function authenticate(
  req: Request,
  env: Env
): { ok: true; headers: Record<string, string> } | { ok: false; response: Response } {
  const keys = parseKeys(env);
  const rateLimit = Math.max(1, parseInt(env.RATE_LIMIT || '60', 10));
  if (keys.length === 0) return { ok: true, headers: {} };

  const url = new URL(req.url);
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const key = bearer || req.headers.get('x-api-key') || url.searchParams.get('api_key') || '';

  if (!key || !keyMatches(key, keys)) {
    return {
      ok: false,
      response: jsonError(
        401,
        'Missing or invalid API key. Send it as "Authorization: Bearer <key>", "x-api-key: <key>", or "?api_key=<key>".',
        { 'WWW-Authenticate': 'Bearer realm="mangafire-api"' }
      ),
    };
  }

  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 };
    buckets.set(key, bucket);
    if (buckets.size > 1000) {
      for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
    }
  }
  bucket.count++;

  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(rateLimit),
    'X-RateLimit-Remaining': String(Math.max(0, rateLimit - bucket.count)),
  };

  if (bucket.count > rateLimit) {
    return {
      ok: false,
      response: jsonError(429, `Rate limit exceeded (${rateLimit} req/min per key).`, {
        ...headers,
        'Retry-After': String(Math.ceil((bucket.resetAt - now) / 1000)),
      }),
    };
  }
  return { ok: true, headers };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, x-api-key, Content-Type',
};

function json(data: unknown, init: { status?: number; headers?: Record<string, string>; cacheSeconds?: number } = {}): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
    ...(init.headers || {}),
  };
  if (init.cacheSeconds) {
    headers['Cache-Control'] = `public, s-maxage=${init.cacheSeconds}, stale-while-revalidate=${init.cacheSeconds * 2}`;
  }
  return new Response(JSON.stringify(data), { status: init.status || 200, headers });
}

function jsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: message, status }, { status, headers });
}

// ---------------------------------------------------------------------------
// Tiny router (path patterns with :params)
// ---------------------------------------------------------------------------

type Handler = (req: Request, params: Record<string, string>, env: Env) => Promise<Response> | Response;

interface Route {
  pattern: string[];
  handler: Handler;
  cacheSeconds?: number;
}

function route(pattern: string, handler: Handler, cacheSeconds?: number): Route {
  return { pattern: pattern.split('/').filter(Boolean), handler, cacheSeconds };
}

const routes: Route[] = [
  route('/api/key', (_req, _p, env) =>
    json({ valid: true, authRequired: parseKeys(env).length > 0, rateLimitPerMinute: parseInt(env.RATE_LIMIT || '60', 10) })
  ),
  route('/api/cache/stats', () => json(cache.stats())),

  route('/api/resolve', (req) => {
    const url = new URL(req.url).searchParams.get('url');
    if (!url) return jsonError(400, 'url query param required');
    try {
      const ref = parseMangaRef(url);
      const mangaId = ref.slug ? `${ref.id}-${ref.slug}` : ref.id;
      return json({
        id: ref.id,
        slug: ref.slug,
        mangaId,
        pagePath: ref.pagePath,
        info: `/api/manga/${encodeURIComponent(mangaId)}`,
        chapters: `/api/manga/${encodeURIComponent(mangaId)}/chapters`,
      });
    } catch (e) {
      return jsonError(400, (e as Error).message);
    }
  }),

  route('/api/debug/fetch', async (req) => {
    const path = (new URL(req.url).searchParams.get('path') || '/home').trim();
    if (!path.startsWith('/')) return jsonError(400, 'path must start with /');
    const r = await client.get(path, { validateStatus: () => true });
    const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    return json({
      path,
      status: r.status,
      bytes: body.length,
      cloudflareBlocked: isCloudflareBlock(r.status, body),
      snippet: body.slice(0, 500),
    });
  }),

  route('/api/home', () => cache.getOrFetch('home', scrapeHomePage, TTL.HOME).then(d => json(d, { cacheSeconds: TTL.HOME })), TTL.HOME),

  route('/api/search/:keyword', (req, p) => {
    const page = parseInt(new URL(req.url).searchParams.get('page') || '1') || 1;
    const keyword = decodeURIComponent(p.keyword);
    return cache.getOrFetch(`search:${keyword}:${page}`, () => scrapeSearchResults(keyword, page), TTL.SEARCH).then(d => json(d, { cacheSeconds: TTL.SEARCH }));
  }),

  route('/api/category/:category', (req, p) => {
    const page = parseInt(new URL(req.url).searchParams.get('page') || '1') || 1;
    return cache.getOrFetch(`category:${p.category}:${page}`, () => scrapedMangaCategory(p.category as MangaCategories, page), TTL.CATEGORY).then(d => json(d, { cacheSeconds: TTL.CATEGORY }));
  }),

  route('/api/genre/:genre', (req, p) => {
    const page = parseInt(new URL(req.url).searchParams.get('page') || '1') || 1;
    return cache.getOrFetch(`genre:${p.genre}:${page}`, () => scrapedMangaGenre(p.genre, page), TTL.GENRE).then(d => json(d, { cacheSeconds: TTL.GENRE }));
  }),

  route('/api/manga/:id', (_req, p) =>
    cache.getOrFetch(`manga-info:${p.id}`, () => scrapeMangaInfo(p.id), TTL.MANGA_INFO).then(d => json(d, { cacheSeconds: TTL.MANGA_INFO }))
  ),

  route('/api/manga/:id/chapters', (_req, p) =>
    cache.getOrFetch(`chapters:${p.id}`, () => getChapters(p.id), TTL.CHAPTERS).then(d => json(d, { cacheSeconds: TTL.CHAPTERS }))
  ),

  route('/api/manga/:id/chapters/:lng', (_req, p) =>
    cache.getOrFetch(`chapters:${p.id}:${p.lng}`, () => getChapters(p.id, p.lng), TTL.CHAPTERS).then(d => json(d, { cacheSeconds: TTL.CHAPTERS }))
  ),

  route('/api/chapter/:chapterId', (_req, p) =>
    cache.getOrFetch(`chapter-imgs:${p.chapterId}`, () => getChapterImages(p.chapterId), TTL.CHAPTER_IMGS).then(d => json(d, { cacheSeconds: TTL.CHAPTER_IMGS }))
  ),

  route('/api/volumes/:id', (req, p) => {
    const lang = new URL(req.url).searchParams.get('lang') || 'en';
    return cache.getOrFetch(`volumes:${p.id}:${lang}`, () => getVolumes(p.id, lang), TTL.VOLUMES).then(d => json(d, { cacheSeconds: TTL.VOLUMES }));
  }),

  route('/api/updated', (req) => latest(req, 'updated')),
  route('/api/newest', (req) => latest(req, 'newest')),
  route('/api/added', (req) => latest(req, 'added')),

  route('/proxy-image', async (req) => {
    const url = new URL(req.url).searchParams.get('url');
    if (!url) return jsonError(400, 'url query param required');
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonError(400, 'Only http/https URLs are allowed');
    }
    const upstream = await fetch(url, { headers: { Referer: 'https://mangafire.to/' } });
    if (!upstream.ok || !upstream.body) return jsonError(502, 'Failed to proxy image');
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=172800',
        ...CORS_HEADERS,
      },
    });
  }),
];

function latest(req: Request, pageType: 'updated' | 'newest' | 'added'): Promise<Response> {
  const page = parseInt(new URL(req.url).searchParams.get('page') || '1') || 1;
  return cache
    .getOrFetch(`${pageType}:${page}`, () => scrapeLatestPage(pageType, page), TTL.LATEST)
    .then(d => json(d, { cacheSeconds: TTL.LATEST }));
}

function matchRoute(pathname: string): { route: Route; params: Record<string, string> } | null {
  const segments = pathname.split('/').filter(Boolean);
  // Prefer longer (more specific) patterns
  const sorted = [...routes].sort((a, b) => b.pattern.length - a.pattern.length);
  for (const r of sorted) {
    if (r.pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.pattern.length; i++) {
      const seg = r.pattern[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = segments[i];
      else if (seg !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    configureFetchClient({
      scraperApiKey: env.SCRAPER_API_KEY,
      scraperRender: env.SCRAPER_RENDER === 'true',
      scraperPremium: env.SCRAPER_PREMIUM === 'true',
    });

    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Public health endpoint
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        status: 'ok',
        runtime: 'cloudflare-workers',
        authRequired: parseKeys(env).length > 0,
        message: 'MangaFire API — try /api/home',
      });
    }

    // Everything else requires a key (when configured)
    const auth = authenticate(request, env);
    if (!auth.ok) return auth.response;

    const matched = matchRoute(url.pathname);
    if (!matched) return jsonError(404, 'Route not found');

    try {
      const res = await matched.route.handler(request, matched.params, env);
      // Merge rate-limit headers into the response
      for (const [k, v] of Object.entries(auth.headers)) res.headers.set(k, v);
      return res;
    } catch (err: any) {
      const status = err?.status || err?.statusCode || 500;
      return jsonError(status, err?.message || 'Internal server error');
    }
  },
};
