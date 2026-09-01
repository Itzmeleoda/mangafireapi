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
 *   ADMIN_KEY        enables the dashboard's key generator (POST /admin/keys);
 *                    keys it issues are HMAC-signed and need no storage
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
import { dashboardHtml } from './dashboard';

export interface Env {
  API_KEYS?: string;
  ADMIN_KEY?: string;
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

// ---------------------------------------------------------------------------
// Signed keys (created from the dashboard; no storage required)
//
// Format: mf-sk-<base64url(payload)>.<base64url(HMAC-SHA256(payload, ADMIN_KEY))>
// payload: { n: label, e: expiry epoch ms (0 = never), r: random hex }
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

async function createSignedKey(name: string, expiresInDays: number, secret: string): Promise<string> {
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  const payload = {
    n: (name || 'key').slice(0, 40),
    e: expiresInDays > 0 ? Date.now() + expiresInDays * 86_400_000 : 0,
    r: b64url(rand),
  };
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64url(await hmacSha256(secret, payloadB64));
  return `mf-sk-${payloadB64}.${sig}`;
}

async function verifySignedKey(key: string, secret: string): Promise<boolean> {
  const m = /^mf-sk-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key);
  if (!m) return false;
  const expected = b64url(await hmacSha256(secret, m[1]));
  if (expected.length !== m[2].length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
  if (diff !== 0) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(m[1])));
    if (payload.e && Date.now() > payload.e) return false; // expired
    return true;
  } catch {
    return false;
  }
}

// Per-key sliding-window rate limiter (per-isolate, best effort).
const buckets = new Map<string, { count: number; resetAt: number }>();

async function authenticate(
  req: Request,
  env: Env
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; response: Response }> {
  const keys = parseKeys(env);
  const rateLimit = Math.max(1, parseInt(env.RATE_LIMIT || '60', 10));
  if (keys.length === 0 && !env.ADMIN_KEY) return { ok: true, headers: {} };

  const url = new URL(req.url);
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const key = bearer || req.headers.get('x-api-key') || url.searchParams.get('api_key') || '';

  const valid = key
    ? keyMatches(key, keys) || (env.ADMIN_KEY ? await verifySignedKey(key, env.ADMIN_KEY) : false)
    : false;

  if (!valid) {
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
    if (url.pathname === '/health') {
      return json({
        status: 'ok',
        runtime: 'cloudflare-workers',
        authRequired: parseKeys(env).length > 0 || !!env.ADMIN_KEY,
        message: 'MangaFire API — try /api/home',
      });
    }

    // Admin: create signed API keys (used by the dashboard).
    if (url.pathname === '/admin/keys') {
      if (!env.ADMIN_KEY) return jsonError(503, 'Key creation is disabled: set the ADMIN_KEY secret on this Worker.');
      if (request.method !== 'POST') return jsonError(405, 'POST only');
      const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!bearer || !keyMatches(bearer, [env.ADMIN_KEY])) {
        return jsonError(401, 'Invalid admin secret.', { 'WWW-Authenticate': 'Bearer realm="mangafire-admin"' });
      }
      let body: { name?: string; expiresInDays?: number } = {};
      try { body = await request.json(); } catch { /* empty body is fine */ }
      const days = Math.min(365, Math.max(0, Math.floor(body.expiresInDays || 0)));
      const key = await createSignedKey(String(body.name || ''), days, env.ADMIN_KEY);
      return json({ key, expiresInDays: days || null });
    }

    // Dashboard UI (public page; key creation inside is admin-secret gated)
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(dashboardHtml(url.host, !!env.ADMIN_KEY), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // Everything else requires a key (when configured)
    const auth = await authenticate(request, env);
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
