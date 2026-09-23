/**
 * TTL cache with a stale fallback.
 *
 * Entries past their TTL are kept rather than evicted, because the upstream fails
 * often enough (issue #1) that a stale figure clearly labelled with its age is
 * more useful to a user than an error. `get` returns only fresh entries;
 * `getStale` is the deliberate fallback used after every retry has failed.
 */

export interface CacheEntry<T> {
  value: T;
  /** Epoch ms when the value was stored. */
  storedAt: number;
  /** Epoch ms after which `get` stops returning it. */
  expiresAt: number;
}

export interface CachedValue<T> {
  value: T;
  stale: boolean;
  /** Whole seconds since the value was fetched. */
  ageSeconds: number;
  /** Epoch ms when the upstream was actually read, not when it was served. */
  fetchedAt: number;
}

export interface TtlCacheOptions {
  /** Injectable clock so tests do not depend on wall time. */
  now?: () => number;
  /**
   * Hard ceiling on retained entries. Stale entries are useful, but a long-lived
   * server should not grow without bound; the oldest is dropped first.
   */
  maxEntries?: number;
}

export class TtlCache {
  readonly #entries = new Map<string, CacheEntry<unknown>>();
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(options: TtlCacheOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 500;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    const now = this.#now();
    // Re-inserting moves the key to the end of the Map's iteration order, which
    // is what makes the eviction below least-recently-written rather than random.
    this.#entries.delete(key);
    this.#entries.set(key, { value, storedAt: now, expiresAt: now + ttlMs });

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /**
   * Store with an explicit fetch time, for values assembled from several
   * fetches. The aggregate must carry the age of its oldest contributing
   * part, not the moment it was assembled (#34).
   */
  setFetchedAt<T>(key: string, value: T, ttlMs: number, fetchedAt: number): void {
    const now = this.#now();
    this.#entries.delete(key);
    this.#entries.set(key, { value, storedAt: fetchedAt, expiresAt: now + ttlMs });

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /** Fresh entries only. Returns undefined once the TTL has passed. */
  get<T>(key: string): CachedValue<T> | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (this.#now() >= entry.expiresAt) return undefined;
    return this.#toCachedValue<T>(entry, false);
  }

  /**
   * Any retained entry, fresh or expired. Use only when the upstream has failed —
   * callers must surface `stale` and `ageSeconds` to the user.
   */
  getStale<T>(key: string): CachedValue<T> | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    return this.#toCachedValue<T>(entry, this.#now() >= entry.expiresAt);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  #toCachedValue<T>(entry: CacheEntry<unknown>, stale: boolean): CachedValue<T> {
    return {
      value: entry.value as T,
      stale,
      ageSeconds: Math.floor((this.#now() - entry.storedAt) / 1000),
      fetchedAt: entry.storedAt,
    };
  }
}

/**
 * TTLs by data volatility. Locator and register datasets change on the order of
 * weeks, so caching them for a day costs nothing and removes most upstream calls.
 */
export const TTL = {
  /** Interest rates: published daily. */
  rates: 60 * 60 * 1000,
  /** ATM, branch and self-service locators. */
  locators: 24 * 60 * 60 * 1000,
  /** Registers of authorised institutions and the published scam list. */
  registers: 24 * 60 * 60 * 1000,
} as const;
