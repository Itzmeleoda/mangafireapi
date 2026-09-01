import createHttpError from 'http-errors';

/**
 * Fetch-based HTTP client for Cloudflare Workers (and any runtime without
 * Node's http/https modules). Exposes the same shape the parsers use:
 *
 *   const content = await client.get('/home');
 *   content.data // string (html) or parsed JSON
 *
 * The worker build aliases `../utils/axiosClient` to this module, so the
 * parsers run unmodified on both Node (Express/Vercel) and Workers.
 *
 * Config (API keys, scraper proxy) comes from `configureFetchClient()`,
 * called once by the worker entry with the Worker's env bindings.
 */

export interface FetchClientConfig {
  scraperApiKey?: string;
  scraperRender?: boolean;
  scraperPremium?: boolean;
  maxRetries?: number;
}

let config: FetchClientConfig = { maxRetries: 3 };

export function configureFetchClient(c: FetchClientConfig): void {
  config = { maxRetries: 3, ...c };
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
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

const BASE_URL = 'https://mangafire.to';

/** Same Cloudflare challenge detection as the axios client. */
export function isCloudflareBlock(status: number | undefined, data: unknown): boolean {
  if (status === 429) return false;
  const body = typeof data === 'string' ? data : '';
  const looksLikeChallenge =
    body.length > 0 &&
    body.length < 30000 &&
    /cf-chl|cf-challenge|challenge-platform|just a moment|attention required!|cloudflare|enable javascript and cookies/i.test(
      body
    );
  if (looksLikeChallenge) return true;
  if (status === 403 && body.length < 30000 && /cloudflare|access denied|blocked/i.test(body)) return true;
  return false;
}

export interface ClientResponse<T = unknown> {
  status: number;
  data: T;
  headers: Headers;
}

export interface GetOptions {
  headers?: Record<string, string>;
  responseType?: 'text' | 'json';
  validateStatus?: (status: number) => boolean;
}

function buildUrl(path: string): string {
  const full = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  if (!config.scraperApiKey) return full;
  let proxyUrl = `http://api.scraperapi.com?api_key=${config.scraperApiKey}&keep_headers=true&url=${encodeURIComponent(full)}`;
  if (config.scraperRender) proxyUrl += '&render=true';
  if (config.scraperPremium) proxyUrl += '&premium=true';
  return proxyUrl;
}

const CLOUDFLARE_MSG =
  'Blocked by Cloudflare challenge. Set SCRAPER_API_KEY (and optionally SCRAPER_RENDER=true / SCRAPER_PREMIUM=true) in your Worker secrets.';

async function get<T = unknown>(path: string, opts: GetOptions = {}): Promise<ClientResponse<T>> {
  const url = buildUrl(path);
  const headers = { ...BROWSER_HEADERS, ...(opts.headers || {}) };
  const maxRetries = config.maxRetries ?? 3;

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.scraperApiKey ? 90000 : 25000);
      let res: Response;
      try {
        res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();

      if (opts.validateStatus && !opts.validateStatus(res.status)) {
        // Caller wants the raw response regardless of status (debug endpoint)
        return { status: res.status, data: text as unknown as T, headers: res.headers };
      }

      if (isCloudflareBlock(res.status, text)) {
        throw createHttpError(503, CLOUDFLARE_MSG);
      }

      // Retry transient / anti-bot statuses
      if ([403, 429, 500, 502, 503].includes(res.status) && attempt < maxRetries) {
        lastError = createHttpError(res.status, `Upstream returned ${res.status}`);
        continue;
      }

      let data: unknown = text;
      const contentType = res.headers.get('content-type') || '';
      if (opts.responseType === 'json' || contentType.includes('application/json')) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { status: res.status, data: data as T, headers: res.headers };
    } catch (err: any) {
      if (err?.status) throw err; // deliberate HTTP error (e.g. the 503 above) — don't retry
      lastError = err;
      if (attempt >= maxRetries) break;
    }
  }

  if (lastError && (lastError as any)?.status) throw lastError;
  throw createHttpError(502, (lastError as Error)?.message || 'Upstream fetch failed');
}

export const client = { get };
