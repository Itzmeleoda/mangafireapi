# MangaFire API & MangaBot Integration Guide

A high-performance, edge-native REST API for [MangaFire](https://mangafire.to), built for **Cloudflare Workers** (100% free tier: 100,000 requests/day, no credit card required). It bypasses Cloudflare challenges, consumes MangaFire's internal JSON endpoints, and features built-in API key authentication, rate limiting, and an interactive admin dashboard.

---

## 🚀 Features

- **Edge-Fast Performance:** Deployed globally on Cloudflare Workers.
- **Internal JSON API:** Directly queries MangaFire's high-speed catalog and chapter endpoints.
- **Zero-Database Key Management:** Cryptographically signed API keys (`mf-sk-...`) verified statelessly via HMAC-SHA256 — no database or KV store needed!
- **Built-in Admin Dashboard & Playground:** Visit your worker's root URL (`/`) to generate keys, test endpoints live, and copy ready-made client code snippets.
- **Auto API Key Generation:** Programmatically generate API keys on the fly from your bot or onboarding flow using your admin secret.

---

## 🛠️ 1. Deployment & Setup

1. **Clone & Push to GitHub** (if not already done):
   ```bash
   git clone https://github.com/Itzmeleoda/mangafireapi.git
   cd mangafireapi
   ```

2. **Install Dependencies & Test Locally**:
   ```bash
   npm install
   npm run worker:dev
   ```

3. **Deploy to Cloudflare Workers**:
   ```bash
   npx wrangler login
   npx wrangler secret put ADMIN_KEY     # Enter a secure secret for minting keys
   npx wrangler secret put API_KEYS      # (Optional) Pre-existing comma-separated keys
   npm run worker:deploy
   ```

4. **Verify Live Deployment**:
   Open `https://mangafire-api.<your-subdomain>.workers.dev/` in your browser to access the interactive admin dashboard and API playground.

---

## 🔑 2. Auto API Key Generation

To prevent manual key creation, your backend or bot can programmatically generate instant API keys by calling the `/admin/keys` endpoint authenticated with your `ADMIN_KEY` secret.

### Request
```bash
POST https://mangafire-api.<your-subdomain>.workers.dev/admin/keys
Content-Type: application/json
Authorization: Bearer YOUR_ADMIN_KEY

{
  "label": "MangaBot Production - User 12345",
  "expiresInDays": 90
}
```

### Response
```json
{
  "success": true,
  "apiKey": "mf-sk-eyJhbGciOiJIUzI1Ni..._signed_sig",
  "keyInfo": {
    "label": "MangaBot Production - User 12345",
    "createdAt": 1718000000000,
    "expiresAt": 1725776000000
  }
}
```

### Example (Node.js / Bot Backend)
```javascript
async function generateUserApiKey(userLabel) {
  const res = await fetch('https://mangafire-api.your-subdomain.workers.dev/admin/keys', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.ADMIN_KEY}`
    },
    body: JSON.stringify({
      label: userLabel,
      expiresInDays: 365 // optional: 7, 30, 90, 365, or omit for never
    })
  });
  
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.apiKey; // Use this key for the user's bot requests
}
```

---

## 🤖 3. Implementing the API in MangaBot

All protected API endpoints require an API key passed via either:
- **Header:** `x-api-key: mf-sk-...` (Recommended)
- **Query Parameter:** `?api_key=mf-sk-...`

### Core MangaBot Workflow

1. **Search Manga** (`GET /api/search/:keyword`)
2. **Resolve / Get Details** (`GET /api/manga/:id`)
3. **Get Chapters** (`GET /api/manga/:id/chapters/:lng`)
4. **Get Chapter Pages** (`GET /api/chapter/:chapterId`)

### JavaScript / TypeScript Example (MangaBot Client)

```javascript
const API_BASE = 'https://mangafire-api.your-subdomain.workers.dev';
const API_KEY = 'mf-sk-your-generated-key';

async function fetchFromApi(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'x-api-key': API_KEY }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.result || json;
}

// 1. Search for manga by title
async function searchManga(query) {
  return await fetchFromApi(`/api/search/${encodeURIComponent(query)}`);
}

// 2. Get manga details & chapters
async function getMangaDetails(mangaId) {
  // mangaId can be slug like 'lx8vq-reborn-as-the-overpowered-genius-lord' or bare id 'lx8vq'
  return await fetchFromApi(`/api/manga/${mangaId}`);
}

// 3. Get chapter list for English ('en')
async function getChapters(mangaId, lang = 'en') {
  return await fetchFromApi(`/api/manga/${mangaId}/chapters/${lang}`);
}

// 4. Get readable image URLs for a chapter
async function getChapterPages(chapterId) {
  return await fetchFromApi(`/api/chapter/${chapterId}`);
}

// Example Usage in MangaBot command handler:
async function handleUserSearch(botMessage, query) {
  try {
    const results = await searchManga(query);
    botMessage.reply(`Found ${results.length} manga! Top result: ${results[0].title}`);
  } catch (err) {
    botMessage.reply(`Error searching manga: ${err.message}`);
  }
}
```

---

## 📡 4. Endpoint Reference

| Endpoint | Method | Description |
|---|---|---|
| `GET /` | `GET` | Interactive Admin Dashboard & API Playground |
| `GET /health` | `GET` | Health check (`{ ok: true, authRequired: true }`) |
| `POST /admin/keys` | `POST` | Mint a new signed API key (requires `Authorization: Bearer ADMIN_KEY`) |
| `GET /api/home` | `GET` | Home page trending / most viewed / recently updated |
| `GET /api/search/:keyword?page=1` | `GET` | Search manga by keyword |
| `GET /api/category/:category?page=1` | `GET` | Browse by category (`manga`, `manhwa`, `manhua`, etc.) |
| `GET /api/genre/:genre?page=1` | `GET` | Browse by genre |
| `GET /api/manga/:id` | `GET` | Manga details, alternative titles, description, stats |
| `GET /api/manga/:id/chapters` | `GET` | Available translation languages |
| `GET /api/manga/:id/chapters/:lng` | `GET` | Full chapter list for a specific language (e.g. `en`) |
| `GET /api/chapter/:chapterId` | `GET` | Direct high-res reader page image URLs for a chapter |
| `GET /api/resolve?url=...` | `GET` | Resolve any MangaFire URL or slug to standard IDs |
| `GET /proxy-image?url=...` | `GET` | CORS image proxy with required MangaFire headers |

---

## 🔒 Security Best Practices

1. **Keep `ADMIN_KEY` Secret:** Never expose your `ADMIN_KEY` in frontend code or public repositories. It should only reside in Cloudflare Worker Secrets (`wrangler secret put ADMIN_KEY`) and your secure bot backend environment variables.
2. **Distribute User Keys:** Use auto-generation (`POST /admin/keys`) on your backend to issue scoped, labeled user keys dynamically when users sign up or connect their bot session.
3. **Signed Key Expiry:** Set appropriate expiration intervals (`expiresInDays`) when minting keys to automatically invalidate inactive or old bot sessions.
