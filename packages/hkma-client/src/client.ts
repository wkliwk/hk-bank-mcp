import { type CachedValue, TtlCache } from './cache.js';
import {
  buildUrl,
  ENDPOINTS,
  type EndpointDefinition,
  type EndpointId,
  type QueryParams,
} from './endpoints.js';
import { HkmaError } from './errors.js';
import { type FetchOptions, fetchPage } from './http.js';

export interface HkmaClientOptions extends FetchOptions {
  cache?: TtlCache;
  /**
   * Clock used to stamp `asOf`. Must be the same clock the cache uses, or a
   * cache hit will report an age the timestamp contradicts.
   */
  now?: () => number;
  /** Default language for endpoints that support it. */
  lang?: 'en' | 'tc' | 'sc';
  /**
   * Serve an expired cached value when every retry has failed. On by default:
   * the upstream is unreliable enough (issue #1) that a labelled stale figure
   * beats an error for almost every question a user asks.
   */
  staleOnError?: boolean;
}

export interface FetchResult<T> {
  records: T[];
  /** True when served from cache past its TTL because the upstream failed. */
  stale: boolean;
  /** Seconds since the data was fetched. Zero for a live response. */
  ageSeconds: number;
  /**
   * When the upstream was actually read, as an ISO timestamp.
   *
   * On a cache hit this is the original fetch, not now — otherwise a value
   * served from a 20-hour-old entry would present itself as current, which is
   * exactly the confusion the server instructions tell the model to avoid.
   */
  asOf: string;
  /** Data source id, so callers can attribute the figure. */
  sourceId: string;
}

/**
 * Client for the HKMA public API.
 *
 * Deliberately has no knowledge of MCP — it is a plain library so it stays
 * usable on its own, and so the protocol layer can be tested separately.
 */
export class HkmaClient {
  readonly #cache: TtlCache;
  readonly #options: HkmaClientOptions;
  readonly #clock: () => number;

  constructor(options: HkmaClientOptions = {}) {
    this.#clock = options.now ?? Date.now;
    this.#cache = options.cache ?? new TtlCache({ now: this.#clock });
    this.#options = options;
  }

  /**
   * Fetch one page, using the cache when fresh and falling back to a stale entry
   * when the upstream is down.
   */
  async fetch<Id extends EndpointId>(
    endpointId: Id,
    params: QueryParams = {},
  ): Promise<FetchResult<unknown>> {
    const definition = ENDPOINTS[endpointId] as EndpointDefinition<unknown>;
    const effective = this.#applyDefaults(definition, params);
    const url = buildUrl(definition, effective);

    const fresh = this.#cache.get<unknown[]>(url);
    if (fresh !== undefined) {
      return {
        records: fresh.value,
        stale: false,
        ageSeconds: fresh.ageSeconds,
        asOf: new Date(fresh.fetchedAt).toISOString(),
        sourceId: definition.sourceId,
      };
    }

    try {
      const page = await fetchPage(url, this.#options);
      const records = page.records.map((record) => definition.schema.parse(record));
      this.#cache.set(url, records, definition.ttlMs);
      return {
        records,
        stale: false,
        ageSeconds: 0,
        asOf: new Date(this.#clock()).toISOString(),
        sourceId: definition.sourceId,
      };
    } catch (error) {
      const fallback = this.#staleFallback<unknown[]>(url, error);
      if (fallback !== undefined) {
        return {
          records: fallback.value,
          stale: true,
          ageSeconds: fallback.ageSeconds,
          asOf: new Date(fallback.fetchedAt).toISOString(),
          sourceId: definition.sourceId,
        };
      }
      throw error;
    }
  }

  /**
   * Read an entire dataset by paging with `offset`.
   *
   * Necessary because the API reports no total count — `datasize` is the size of
   * the page returned — so the only way to know a dataset is exhausted is to read
   * until a short page comes back. Datasets are small (the largest locator is
   * about 2,000 records) and cached for a day, so this runs rarely.
   */
  async fetchAll<Id extends EndpointId>(
    endpointId: Id,
    params: Omit<QueryParams, 'pagesize' | 'offset'> = {},
    maxRecords = 10_000,
  ): Promise<FetchResult<unknown>> {
    const definition = ENDPOINTS[endpointId] as EndpointDefinition<unknown>;
    const pageSize = definition.maxPageSize;
    const cacheKey = `all:${definition.id}:${params.lang ?? this.#options.lang ?? 'en'}`;

    const fresh = this.#cache.get<unknown[]>(cacheKey);
    if (fresh !== undefined) {
      return {
        records: fresh.value,
        stale: false,
        ageSeconds: fresh.ageSeconds,
        asOf: new Date(fresh.fetchedAt).toISOString(),
        sourceId: definition.sourceId,
      };
    }

    try {
      const all: unknown[] = [];
      // An aggregate is only as fresh as its stalest page. Reporting the time
      // of the call here would present day-old cached pages as current and
      // defeat the whole point of as_of (#34).
      let anyStale = false;
      let oldestFetchedAt = this.#clock();
      for (let offset = 0; all.length < maxRecords; offset += pageSize) {
        const page = await this.fetch(endpointId, { ...params, pagesize: pageSize, offset });
        all.push(...page.records);
        if (page.stale) anyStale = true;
        oldestFetchedAt = Math.min(oldestFetchedAt, Date.parse(page.asOf));
        // A page smaller than requested means there is nothing left to read.
        if (page.records.length < pageSize) break;
      }
      // Only cache a genuinely fresh aggregate. Writing a stale one back with a
      // new TTL launders day-old data into a "fresh" entry, and every caller
      // for the next TTL is told it is current while ageSeconds says otherwise
      // (#34).
      if (!anyStale) this.#cache.setFetchedAt(cacheKey, all, definition.ttlMs, oldestFetchedAt);
      return {
        records: all,
        stale: anyStale,
        ageSeconds: Math.floor((this.#clock() - oldestFetchedAt) / 1000),
        asOf: new Date(oldestFetchedAt).toISOString(),
        sourceId: definition.sourceId,
      };
    } catch (error) {
      const fallback = this.#staleFallback<unknown[]>(cacheKey, error);
      if (fallback !== undefined) {
        return {
          records: fallback.value,
          stale: true,
          ageSeconds: fallback.ageSeconds,
          asOf: new Date(fallback.fetchedAt).toISOString(),
          sourceId: definition.sourceId,
        };
      }
      throw error;
    }
  }

  /**
   * Fetch a bounded window of a date-ordered time series, newest first.
   *
   * `fetchAll` pages until a short page ends the dataset — correct for the
   * small, finite locator datasets, wrong here: HIBOR daily data goes back to
   * 1996 (7,000+ records), so "page until exhausted" would issue dozens of
   * sequential requests and could take minutes. This instead requests newest
   * records first and stops as soon as either `maxRecords` is reached or the
   * oldest record fetched is at or before `oldestNeeded` — whichever comes
   * first — so a "past month" query touches one page, not the whole history.
   */
  async fetchTimeSeries<Id extends EndpointId>(
    endpointId: Id,
    params: { dateField: string; oldestNeeded?: string; maxRecords?: number } & Omit<
      QueryParams,
      'pagesize' | 'offset' | 'sortby' | 'sortorder'
    >,
  ): Promise<FetchResult<unknown>> {
    const { dateField, oldestNeeded, maxRecords = 500, ...rest } = params;
    const definition = ENDPOINTS[endpointId] as EndpointDefinition<unknown>;
    const pageSize = definition.maxPageSize;
    const cacheKey = `series:${definition.id}:${rest.lang ?? this.#options.lang ?? 'en'}:${oldestNeeded ?? ''}:${maxRecords}`;

    const fresh = this.#cache.get<unknown[]>(cacheKey);
    if (fresh !== undefined) {
      return {
        records: fresh.value,
        stale: false,
        ageSeconds: fresh.ageSeconds,
        asOf: new Date(fresh.fetchedAt).toISOString(),
        sourceId: definition.sourceId,
      };
    }

    try {
      const all: unknown[] = [];
      // Same reasoning as fetchAll: the aggregate inherits its stalest page.
      let anyStale = false;
      let oldestFetchedAt = this.#clock();
      for (let offset = 0; all.length < maxRecords; offset += pageSize) {
        const page = await this.fetch(endpointId, {
          ...rest,
          pagesize: pageSize,
          offset,
          sortby: dateField,
          sortorder: 'desc',
        });
        all.push(...page.records);
        if (page.stale) anyStale = true;
        oldestFetchedAt = Math.min(oldestFetchedAt, Date.parse(page.asOf));
        if (page.records.length < pageSize) break;
        if (oldestNeeded !== undefined) {
          const last = page.records[page.records.length - 1] as Record<string, unknown> | undefined;
          const lastDate = last?.[dateField];
          if (typeof lastDate === 'string' && lastDate <= oldestNeeded) break;
        }
      }
      const bounded = all.slice(0, maxRecords);
      // Same reasoning as fetchAll: never re-cache stale data as fresh.
      if (!anyStale) {
        this.#cache.setFetchedAt(cacheKey, bounded, definition.ttlMs, oldestFetchedAt);
      }
      return {
        records: bounded,
        stale: anyStale,
        ageSeconds: Math.floor((this.#clock() - oldestFetchedAt) / 1000),
        asOf: new Date(oldestFetchedAt).toISOString(),
        sourceId: definition.sourceId,
      };
    } catch (error) {
      const fallback = this.#staleFallback<unknown[]>(cacheKey, error);
      if (fallback !== undefined) {
        return {
          records: fallback.value,
          stale: true,
          ageSeconds: fallback.ageSeconds,
          asOf: new Date(fallback.fetchedAt).toISOString(),
          sourceId: definition.sourceId,
        };
      }
      throw error;
    }
  }

  get cache(): TtlCache {
    return this.#cache;
  }

  #applyDefaults(definition: EndpointDefinition<unknown>, params: QueryParams): QueryParams {
    const lang = params.lang ?? this.#options.lang ?? 'en';
    const requested = params.pagesize;
    // Clamp rather than reject: exceeding the ceiling returns err_code 9999,
    // and a silently smaller page is a far better outcome than a failed call.
    const pagesize =
      requested === undefined
        ? undefined
        : Math.min(Math.max(1, requested), definition.maxPageSize);
    return {
      ...params,
      ...(definition.supportsLang ? { lang } : {}),
      ...(pagesize === undefined ? {} : { pagesize }),
    };
  }

  /**
   * Stale data is only an acceptable answer when the upstream genuinely failed.
   * A malformed request must surface as an error, not be masked by old data.
   */
  #staleFallback<T>(key: string, error: unknown): CachedValue<T> | undefined {
    if (this.#options.staleOnError === false) return undefined;
    if (!(error instanceof HkmaError) || !error.isTransient) return undefined;
    return this.#cache.getStale<T>(key);
  }
}
