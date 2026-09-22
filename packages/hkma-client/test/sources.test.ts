import { describe, expect, it } from 'vitest';
import { DATA_SOURCES, findDataSource, HKMA_BASE_URL } from '../src/index.js';

describe('data sources', () => {
  it('exposes every source over HTTPS under the HKMA public API host', () => {
    expect(DATA_SOURCES.length).toBeGreaterThan(0);
    for (const source of DATA_SOURCES) {
      expect(source.baseUrl.startsWith(`${HKMA_BASE_URL}/`)).toBe(true);
      expect(new URL(source.baseUrl).protocol).toBe('https:');
    }
  });

  it('declares no source as needing auth, which is the project premise', () => {
    // If this ever fails, the "public data only, no credentials" promise in
    // PRODUCT.md has been broken and the README claim is no longer true.
    expect(DATA_SOURCES.every((source) => !source.requiresAuth)).toBe(true);
  });

  it('uses unique ids so tool responses can attribute a figure unambiguously', () => {
    const ids = DATA_SOURCES.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('documents freshness for every source', () => {
    // The spike (#1) found the monthly bulletin lags ~3 weeks while the daily
    // series is next-day. Callers must be able to see that difference.
    for (const source of DATA_SOURCES) {
      expect(source.freshness.length).toBeGreaterThan(10);
    }
  });

  it('looks up a source by id and returns undefined for an unknown one', () => {
    expect(findDataSource('hkma-bank-svf-info')?.name).toContain('Bank & SVF');
    expect(findDataSource('nope')).toBeUndefined();
  });
});
