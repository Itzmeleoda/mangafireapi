import { Request, Response, NextFunction } from 'express';
import createHttpError from 'http-errors';
import crypto from 'crypto';

/**
 * OpenRouter-style API key auth.
 *
 * - Keys are provisioned via the API_KEYS env var (comma-separated).
 *   Generate one with:  npm run genkey
 * - Clients authenticate with ANY of:
 *     Authorization: Bearer mf-sk-...
 *     x-api-key: mf-sk-...
 *     ?api_key=mf-sk-...          (query param — keeps Vercel edge caching working,
 *                                  since requests with an Authorization header
 *                                  bypass the CDN cache)
 * - If API_KEYS is NOT set, the API runs open (dev mode) with a startup warning.
 * - A simple per-key sliding-window rate limiter is included (RATE_LIMIT env,
 *   default 60 req/min/key) with X-RateLimit-* response headers.
 */

const keys = (process.env.API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

const keyList = keys.map(k => Buffer.from(k));

export const authEnabled = keyList.length > 0;

// Constant-time comparison so key validity can't be probed via timing.
function keyMatches(candidate: string): boolean {
  const buf = Buffer.from(candidate);
  for (const valid of keyList) {
    if (valid.length === buf.length && crypto.timingSafeEqual(valid, buf)) return true;
  }
  return false;
}

// ---- per-key rate limiting (fixed 1-minute window, in-memory) ----
const RATE_LIMIT = Math.max(1, parseInt(process.env.RATE_LIMIT || '60', 10));
const buckets = new Map<string, { count: number; resetAt: number }>();

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled) return next();

  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const key =
    bearer ||
    (req.headers['x-api-key'] as string) ||
    (req.query.api_key as string) ||
    '';

  if (!key || !keyMatches(key)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="mangafire-api"');
    return next(
      createHttpError(
        401,
        'Missing or invalid API key. Send it as "Authorization: Bearer <key>", "x-api-key: <key>", or "?api_key=<key>".'
      )
    );
  }

  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 };
    buckets.set(key, bucket);
    // opportunistic cleanup so the map doesn't grow forever
    if (buckets.size > 1000) {
      for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
    }
  }
  bucket.count++;

  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT - bucket.count)));

  if (bucket.count > RATE_LIMIT) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return next(createHttpError(429, `Rate limit exceeded (${RATE_LIMIT} req/min per key).`));
  }

  next();
}

export function authStatus(): { authRequired: boolean; rateLimitPerMinute: number } {
  return { authRequired: authEnabled, rateLimitPerMinute: RATE_LIMIT };
}
