interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  /** Dedupes concurrent fetches for the same key (prevents cache stampede) */
  private inflight = new Map<string, Promise<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async getOrFetch<T>(key: string, fetcher: () => Promise<T>, ttlSeconds: number): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) return cached;

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const p = fetcher()
      .then(value => {
        this.set(key, value, ttlSeconds);
        this.inflight.delete(key);
        return value;
      })
      .catch(err => {
        this.inflight.delete(key);
        throw err;
      });
    this.inflight.set(key, p);
    return p;
  }

  stats(): { totalEntries: number; entries: { key: string; expiresIn: number }[] } {
    const now = Date.now();
    const entries: { key: string; expiresIn: number }[] = [];
    for (const [key, entry] of this.store.entries()) {
      const expiresIn = Math.round((entry.expiresAt - now) / 1000);
      if (expiresIn > 0) entries.push({ key, expiresIn });
      else this.store.delete(key);
    }
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return { totalEntries: entries.length, entries };
  }
}

export const cache = new MemoryCache();

export const TTL = {
  HOME: 5 * 60,
  LATEST: 2 * 60,
  SEARCH: 10 * 60,
  CATEGORY: 10 * 60,
  GENRE: 10 * 60,
  MANGA_INFO: 30 * 60,
  CHAPTERS: 15 * 60,
  // NOTE: MangaFire image URLs carry expiring tokens. Keep this TTL short
  // enough that cached URLs stay valid (1h is a safe upper bound).
  CHAPTER_IMGS: 60 * 60,
  VOLUMES: 30 * 60,
} as const;
