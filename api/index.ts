import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import createHttpError, { HttpError } from 'http-errors';
import scrapeHomePage from '../src/parsers/homePage';
import scrapeMangaInfo from '../src/parsers/infoPage';
import { scrapeSearchResults } from '../src/parsers/searchPage';
import scrapedMangaCategory from '../src/parsers/categoryPage';
import scrapedMangaGenre from '../src/parsers/genrePage';
import { getChapters, getChapterImages, getVolumes } from '../src/parsers/readPage';
import scrapeLatestPage from '../src/parsers/latestPage';
import { cache, TTL } from '../src/lib/cache';
import { apiKeyAuth, authStatus } from '../src/lib/auth';
import { parseMangaRef } from '../src/utils/normalize';
import { client, isCloudflareBlock } from '../src/utils/axiosClient';
import { MangaCategories } from '../src/types/manga';
import axios from 'axios';

const app = express();

app.use(cors());
app.use(express.json());

/**
 * Tell Vercel's edge cache to serve repeat requests without invoking the
 * function at all — this is what makes the API fast in production.
 * Note: requests carrying an Authorization header bypass the CDN cache, so
 * clients that want edge-cached speed should send the key via ?api_key=.
 */
const edgeCache = (res: Response, seconds: number) => {
  res.setHeader('Cache-Control', `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 2}`);
};

app.get('/', (_req, res) => {
  res.json({ status: 'ok', ...authStatus(), message: 'MangaFire API — try /api/home' });
});

// Everything under /api/* and the image proxy requires a key (when configured).
app.use('/api', apiKeyAuth);
app.use('/proxy-image', apiKeyAuth);

// Key status check (OpenRouter-style /key endpoint — never echoes the key itself).
app.get('/api/key', (_req, res) => {
  res.json({ valid: true, ...authStatus() });
});

app.get('/proxy-image', async (req: Request, res: Response, next: NextFunction) => {
  const url = req.query.url as string;
  if (!url) return next(createHttpError(400, 'url query param required'));
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return next(createHttpError(400, 'Only http/https URLs are allowed'));
    }
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
      headers: { Referer: 'https://mangafire.to/' },
    });
    res.setHeader('Content-Type', String(response.headers['content-type'] || 'image/jpeg'));
    edgeCache(res, 86400);
    response.data.on('error', () => res.destroy());
    response.data.pipe(res);
  } catch {
    next(createHttpError(502, 'Failed to proxy image'));
  }
});

// Diagnostics: fetch any MangaFire path and report what actually came back.
// Use this on Render to confirm the Cloudflare bypass is working:
//   GET /api/debug/fetch?path=/home
app.get('/api/debug/fetch', async (req: Request, res: Response, next: NextFunction) => {
  const path = ((req.query.path as string) || '/home').trim();
  if (!path.startsWith('/')) return next(createHttpError(400, 'path must start with /'));
  try {
    const r = await client.get(path, { responseType: 'text', validateStatus: () => true });
    const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    res.json({
      path,
      status: r.status,
      bytes: body.length,
      cloudflareBlocked: isCloudflareBlock(r.status, body),
      snippet: body.slice(0, 500),
    });
  } catch (e) {
    next(e);
  }
});

// Resolve any MangaFire URL / slug / id into the pieces every other
// endpoint needs. Accepts the link format users actually paste:
//   /api/resolve?url=https://mangafire.to/title/lx8vq-reborn-as-the-overpowered-genius-lord
app.get('/api/resolve', (req: Request, res: Response, next: NextFunction) => {
  const url = req.query.url as string;
  if (!url) return next(createHttpError(400, 'url query param required'));
  try {
    const ref = parseMangaRef(url);
    res.json({
      id: ref.id,
      slug: ref.slug,
      mangaId: ref.slug ? `${ref.id}-${ref.slug}` : ref.id,
      pagePath: ref.pagePath,
      info: `/api/manga/${encodeURIComponent(ref.slug ? `${ref.id}-${ref.slug}` : ref.id)}`,
      chapters: `/api/manga/${encodeURIComponent(ref.slug ? `${ref.id}-${ref.slug}` : ref.id)}/chapters`,
    });
  } catch (e) {
    next(createHttpError(400, (e as Error).message));
  }
});

app.get('/api/cache/stats', (_req, res) => { res.json(cache.stats()); });

app.get('/api/home', async (_req, res: Response, next: NextFunction) => {
  try { edgeCache(res, TTL.HOME); res.json(await cache.getOrFetch('home', scrapeHomePage, TTL.HOME)); } catch (e) { next(e); }
});

app.get('/api/search/:keyword', async (req: Request, res: Response, next: NextFunction) => {
  const { keyword } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  try { edgeCache(res, TTL.SEARCH); res.json(await cache.getOrFetch(`search:${keyword}:${page}`, () => scrapeSearchResults(keyword, page), TTL.SEARCH)); } catch (e) { next(e); }
});

app.get('/api/category/:category', async (req: Request, res: Response, next: NextFunction) => {
  const { category } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  try { edgeCache(res, TTL.CATEGORY); res.json(await cache.getOrFetch(`category:${category}:${page}`, () => scrapedMangaCategory(category as MangaCategories, page), TTL.CATEGORY)); } catch (e) { next(e); }
});

app.get('/api/genre/:genre', async (req: Request, res: Response, next: NextFunction) => {
  const { genre } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  try { edgeCache(res, TTL.GENRE); res.json(await cache.getOrFetch(`genre:${genre}:${page}`, () => scrapedMangaGenre(genre, page), TTL.GENRE)); } catch (e) { next(e); }
});

app.get('/api/manga/:id', async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  try { edgeCache(res, TTL.MANGA_INFO); res.json(await cache.getOrFetch(`manga-info:${id}`, () => scrapeMangaInfo(id), TTL.MANGA_INFO)); } catch (e) { next(e); }
});

app.get('/api/manga/:id/chapters', async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  try { edgeCache(res, TTL.CHAPTERS); res.json(await cache.getOrFetch(`chapters:${id}`, () => getChapters(id), TTL.CHAPTERS)); } catch (e) { next(e); }
});

app.get('/api/manga/:id/chapters/:lng', async (req: Request, res: Response, next: NextFunction) => {
  const { id, lng } = req.params;
  try { edgeCache(res, TTL.CHAPTERS); res.json(await cache.getOrFetch(`chapters:${id}:${lng}`, () => getChapters(id, lng), TTL.CHAPTERS)); } catch (e) { next(e); }
});

app.get('/api/chapter/:chapterId', async (req: Request, res: Response, next: NextFunction) => {
  const { chapterId } = req.params;
  try { edgeCache(res, TTL.CHAPTER_IMGS); res.json(await cache.getOrFetch(`chapter-imgs:${chapterId}`, () => getChapterImages(chapterId), TTL.CHAPTER_IMGS)); } catch (e) { next(e); }
});

app.get('/api/volumes/:id', async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const lang = (req.query.lang as string) || 'en';
  try { edgeCache(res, TTL.VOLUMES); res.json(await cache.getOrFetch(`volumes:${id}:${lang}`, () => getVolumes(id, lang), TTL.VOLUMES)); } catch (e) { next(e); }
});

app.get('/api/updated', async (req: Request, res: Response, next: NextFunction) => {
  const page = parseInt(req.query.page as string) || 1;
  try { edgeCache(res, TTL.LATEST); res.json(await cache.getOrFetch(`updated:${page}`, () => scrapeLatestPage('updated', page), TTL.LATEST)); } catch (e) { next(e); }
});

app.get('/api/newest', async (req: Request, res: Response, next: NextFunction) => {
  const page = parseInt(req.query.page as string) || 1;
  try { edgeCache(res, TTL.LATEST); res.json(await cache.getOrFetch(`newest:${page}`, () => scrapeLatestPage('newest', page), TTL.LATEST)); } catch (e) { next(e); }
});

app.get('/api/added', async (req: Request, res: Response, next: NextFunction) => {
  const page = parseInt(req.query.page as string) || 1;
  try { edgeCache(res, TTL.LATEST); res.json(await cache.getOrFetch(`added:${page}`, () => scrapeLatestPage('added', page), TTL.LATEST)); } catch (e) { next(e); }
});

app.use((_req: Request, _res: Response, next: NextFunction) => { next(createHttpError(404, 'Route not found')); });

app.use((err: HttpError, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error', status: err.status || 500 });
});

// On Vercel the default-exported app is used as the serverless handler —
// binding a port inside a function instance is wrong (and can crash warm
// invocations with EADDRINUSE), so only listen when running standalone.
if (!process.env.VERCEL) {
  const PORT = parseInt(process.env.PORT || '3000');
  app.listen(PORT, () => console.log(`MangaFire API running on port ${PORT}`));
}

export default app;
