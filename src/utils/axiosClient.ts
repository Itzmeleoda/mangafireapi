import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import createHttpError from 'http-errors';
import http from 'http';
import https from 'https';

const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
// scraperapi (default) | scrapingbee | zenrows
const SCRAPER_PROVIDER = (process.env.SCRAPER_PROVIDER || 'scraperapi').toLowerCase();
// render=true makes ScraperAPI execute JavaScript (needed for tougher Cloudflare checks, costs 10 credits/request)
const SCRAPER_RENDER = process.env.SCRAPER_RENDER === 'true';
// premium=true routes through residential proxies (costs 10 credits/request)
const SCRAPER_PREMIUM = process.env.SCRAPER_PREMIUM === 'true';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'Cache-Control': 'no-cache',
  DNT: '1',
  Referer: 'https://mangafire.to/',
  'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
};

export const client = axios.create({
  baseURL: 'https://mangafire.to',
  // ScraperAPI (especially with render=true) needs more time than direct calls
  timeout: SCRAPER_KEY ? 90000 : 25000,
  maxRedirects: 10,
  headers: BROWSER_HEADERS,
  // Reuse TCP/TLS connections across requests — big latency win on warm
  // serverless invocations since the TLS handshake happens once.
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
});

/**
 * Detects a Cloudflare challenge/block page. Cloudflare often answers
 * challenges with HTTP 200/403 and a small HTML page instead of real content.
 */
export function isCloudflareBlock(status: number | undefined, data: unknown): boolean {
  if (status === 429) return false; // rate limit, handled by retry
  const body = typeof data === 'string' ? data : '';
  if (!body) return false;
  // Strong markers: present in challenge pages of ANY size (no length cap).
  if (
    /cdn-cgi\/challenge-platform|window\._cf_chl_opt|cf_chl_opt|challenge-platform\/h\/|<title>just a moment\.{0,3}<\/title>/i.test(
      body
    )
  )
    return true;
  // Weaker markers only on small bodies, to avoid false positives on real pages.
  const looksLikeChallenge =
    body.length < 30000 &&
    /cf-chl|cf-challenge|just a moment|attention required!|enable javascript and cookies/i.test(body);
  if (looksLikeChallenge) return true;
  // A bare 403 from a datacenter IP on this site is practically always Cloudflare
  if (status === 403 && body.length < 30000 && /cloudflare|access denied|blocked/i.test(body)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// ScraperAPI routing: when SCRAPER_API_KEY is set, every request is proxied.
// keep_headers=true is REQUIRED, otherwise ScraperAPI drops the browser
// headers above and Cloudflare instantly flags the request as a bot.
// ---------------------------------------------------------------------------
if (SCRAPER_KEY) {
  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    if (config.url?.startsWith('http://api.scraperapi.com')) return config; // already proxied
    const base = (config.baseURL || 'https://mangafire.to').replace(/\/$/, '');
    const path = config.url || '';
    const full = path.startsWith('http') ? path : `${base}${path}`;
    const url = encodeURIComponent(full);
    config.baseURL = '';
    let proxyUrl: string;
    if (SCRAPER_PROVIDER === 'scrapingbee') {
      proxyUrl = `https://app.scrapingbee.com/api/v1?api_key=${SCRAPER_KEY}&url=${url}`;
      if (SCRAPER_RENDER) proxyUrl += '&render_js=true';
      if (SCRAPER_PREMIUM) proxyUrl += '&premium_proxy=true';
    } else if (SCRAPER_PROVIDER === 'zenrows') {
      // Verified-working anti-CF combo: js_render + antibot + premium_proxy
      proxyUrl = `https://api.zenrows.com/v1/?apikey=${SCRAPER_KEY}&url=${url}`;
      if (SCRAPER_RENDER) proxyUrl += '&js_render=true';
      if (SCRAPER_PREMIUM) proxyUrl += '&premium_proxy=true';
      if (SCRAPER_RENDER || SCRAPER_PREMIUM) proxyUrl += '&antibot=true';
    } else {
      proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&keep_headers=true&url=${url}`;
      if (SCRAPER_RENDER) proxyUrl += '&render=true';
      if (SCRAPER_PREMIUM) proxyUrl += '&premium=true';
    }
    config.url = proxyUrl;
    return config;
  });
  console.log(
    `[axiosClient] Proxy enabled (provider=${SCRAPER_PROVIDER}, render=${SCRAPER_RENDER}, premium=${SCRAPER_PREMIUM})`
  );
} else {
  console.log('[axiosClient] Direct mode (no SCRAPER_API_KEY set)');
}

// ---------------------------------------------------------------------------
// Response interceptor: surface Cloudflare blocks as a clear 503 error so
// callers (and the /api/debug/fetch endpoint) can tell scraping failed vs.
// parsing failed. Retries transient/anti-bot responses with backoff.
// ---------------------------------------------------------------------------
client.interceptors.response.use(
  response => {
    if (isCloudflareBlock(response.status, response.data)) {
      throw createHttpError(
        503,
        'Blocked by Cloudflare challenge. Set SCRAPER_API_KEY (and optionally SCRAPER_RENDER=true / SCRAPER_PREMIUM=true) in your deployment environment (Vercel env vars).'
      );
    }
    return response;
  },
  async (error: AxiosError) => {
    const config = error.config as (InternalAxiosRequestConfig & { __retryCount?: number }) | undefined;
    const status = error.response?.status;

    // Retry transient / anti-bot responses with exponential backoff
    if (
      config &&
      (config.__retryCount || 0) < MAX_RETRIES &&
      (status === 403 || status === 429 || status === 500 || status === 502 || status === 503 || !status)
    ) {
      config.__retryCount = (config.__retryCount || 0) + 1;
      const delay = 1000 * Math.pow(2, config.__retryCount); // 2s, 4s, 8s
      console.warn(`[axiosClient] ${status || 'network error'} — retry ${config.__retryCount}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return client.request(config);
    }

    if (isCloudflareBlock(status, error.response?.data)) {
      throw createHttpError(
        503,
        'Blocked by Cloudflare challenge. Set SCRAPER_API_KEY (and optionally SCRAPER_RENDER=true / SCRAPER_PREMIUM=true) in your deployment environment (Vercel env vars).'
      );
    }
    throw error;
  }
);
