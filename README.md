# MangaFire API

A REST API that scrapes manga data from MangaFire.to, built to run on **Render**.

MangaFire sits behind Cloudflare and blocks datacenter IPs (Render included). This API solves that by optionally routing all scraping through [ScraperAPI](https://www.scraperapi.com/) — set one environment variable and the Cloudflare challenge is handled server-side, so your app only ever talks to this fast JSON API.

## MangaFire URL formats

MangaFire migrated its URLs (`/manga/{slug}.{id}` → `/title/{id}-{slug}`). All formats are accepted everywhere a manga id is expected:

| Form | Example |
|---|---|
| Full URL (current) | `https://mangafire.to/title/lx8vq-reborn-as-the-overpowered-genius-lord` |
| Current slug | `lx8vq-reborn-as-the-overpowered-genius-lord` |
| Legacy slug | `reborn-as-the-overpowered-genius-lord.lx8vq` |
| Bare id | `lx8vq` |

In URL path params (e.g. `/api/manga/:id`) full URLs can't be used because of the slashes — use `/api/resolve?url=...` first, or pass the slug/id form.

## Deploy on Render

1. Fork/clone this repo and push it to your GitHub.
2. In Render: **New → Web Service →** connect the repo. Render auto-detects `render.yaml`:
   - Build: `npm install && npm run build`
   - Start: `npm start`
3. Add environment variables (Render dashboard → Environment):

| Variable | Required | Purpose |
|---|---|---|
| `SCRAPER_API_KEY` | Yes (on Render) | ScraperAPI key — bypasses Cloudflare. Free tier: 1,000 credits. |
| `SCRAPER_RENDER` | No | `true` = full JS rendering (10 credits/request). Enable only if you still get 503 Cloudflare errors. |
| `SCRAPER_PREMIUM` | No | `true` = residential proxies (10 credits/request). |
| `MAX_RETRIES` | No | Retries on 403/429/5xx with backoff (default 3). |

4. Verify the bypass works before trusting parser output:

```
GET https://<your-app>.onrender.com/api/debug/fetch?path=/home
```

If `cloudflareBlocked` is `true`, enable `SCRAPER_RENDER=true` (and/or `SCRAPER_PREMIUM=true`) and check again.

> **Render free tier note:** services sleep after 15 min idle; the first request after sleep takes ~30–60s (cold start). The in-memory cache also resets on restart — that's expected.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/resolve?url=...` | Parse any MangaFire URL/slug/id → `{ id, slug, mangaId, pagePath, info, chapters }` |
| `GET /api/debug/fetch?path=/home` | Diagnostics: status, bytes, cloudflareBlocked, HTML snippet |
| `GET /api/home` | Home page — trending, most viewed, recently updated |
| `GET /api/search/:keyword?page=1` | Search manga by keyword |
| `GET /api/category/:category?page=1` | Browse by category (manga, manhwa, manhua, etc.) |
| `GET /api/genre/:genre?page=1` | Browse by genre |
| `GET /api/manga/:id` | Manga details |
| `GET /api/manga/:id/chapters` | Available languages |
| `GET /api/manga/:id/chapters/:lng` | Chapter list for a language |
| `GET /api/chapter/:chapterId` | Chapter image URLs (token-signed — they expire, fetch promptly) |
| `GET /api/volumes/:id?lang=en` | Volume list |
| `GET /api/updated?page=1` | Recently updated manga |
| `GET /api/newest?page=1` | Newest manga |
| `GET /api/added?page=1` | Recently added manga |
| `GET /api/cache/stats` | Cache statistics |
| `GET /proxy-image?url=...` | Image proxy (CORS bypass, sets MangaFire referer) |

## Typical flow from your app

```
# 1. Resolve the link the user pasted
GET /api/resolve?url=https://mangafire.to/title/lx8vq-reborn-as-the-overpowered-genius-lord
# → { "id": "lx8vq", "mangaId": "lx8vq-reborn-as-the-overpowered-genius-lord", ... }

# 2. Get available languages
GET /api/manga/lx8vq-reborn-as-the-overpowered-genius-lord/chapters
# → [{ "id": "en", "title": "English", "chapters": "145 Chapters" }, ...]

# 3. Get the chapter list
GET /api/manga/lx8vq-reborn-as-the-overpowered-genius-lord/chapters/en
# → [{ "number": "1", "title": "Chap 1", "chapterId": "3770773", ... }, ...]

# 4. Get page images for a chapter
GET /api/chapter/3770773
# → ["https://s209.mbfimg.org/...?token=...", ...]
```

## Local development

```bash
npm install
npm run dev                       # direct mode (works if your IP isn't Cloudflare-blocked)
SCRAPER_API_KEY=xxx npm run dev   # proxied mode
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `503 Blocked by Cloudflare challenge` | No/ineffective proxy | Set `SCRAPER_API_KEY`; if it persists set `SCRAPER_RENDER=true` |
| Fields are null/empty but status 200 | MangaFire changed its HTML | Use `/api/debug/fetch` to inspect the raw page and update the cheerio selectors in `src/parsers/` |
| Chapter image URLs 403 after a while | Signed URLs expired | Re-call `/api/chapter/:chapterId`; don't cache image URLs client-side for long |

## Deploy to Cloudflare Workers (free)

The free tier covers 100,000 requests/day — no credit card required. Workers
requests egress from Cloudflare's own network, which often passes MangaFire's
Cloudflare checks that block other datacenter IPs.

```bash
npm install                 # installs wrangler + esbuild
npm run worker:dev          # local test at http://localhost:8787
npx wrangler login          # one-time browser login
npx wrangler secret put API_KEYS   # paste your mf-sk-... key(s)
npm run worker:deploy       # live at https://mangafire-api.<you>.workers.dev
```

After deploying, verify the bypass actually works from Cloudflare's network:

```bash
curl "https://mangafire-api.<you>.workers.dev/api/debug/fetch?path=/home&api_key=<key>"
# "cloudflareBlocked": false  -> you're live with no proxy needed
# "cloudflareBlocked": true   -> also set: npx wrangler secret put SCRAPER_API_KEY
```

For local dev, copy `.dev.vars.example` to `.dev.vars` and put your test key in it.
The same codebase still deploys to Vercel (`api/index.ts`) unchanged.
