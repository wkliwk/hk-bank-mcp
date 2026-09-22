import { beforeEach, describe, expect, it } from 'vitest';
import { TTL, TtlCache } from '../src/cache.js';

describe('TtlCache', () => {
  let clock = 0;
  const now = () => clock;
  let cache: TtlCache;

  beforeEach(() => {
    clock = 1_000_000;
    cache = new TtlCache({ now });
  });

  it('returns a value while it is fresh', () => {
    cache.set('k', [1, 2], 1000);
    expect(cache.get<number[]>('k')?.value).toEqual([1, 2]);
    expect(cache.get<number[]>('k')?.stale).toBe(false);
  });

  it('stops returning a value once the TTL has passed', () => {
    cache.set('k', 'v', 1000);
    clock += 1001;
    expect(cache.get('k')).toBeUndefined();
  });

  it('keeps expired entries so they can still be served during an outage', () => {
    cache.set('k', 'v', 1000);
    clock += 5000;

    const stale = cache.getStale<string>('k');
    expect(stale?.value).toBe('v');
    expect(stale?.stale).toBe(true);
    expect(stale?.ageSeconds).toBe(5);
  });

  it('reports a fresh entry as not stale via getStale', () => {
    cache.set('k', 'v', 10_000);
    clock += 2000;
    expect(cache.getStale<string>('k')?.stale).toBe(false);
  });

  it('evicts the oldest entry once the retention ceiling is reached', () => {
    const small = new TtlCache({ now, maxEntries: 2 });
    small.set('a', 1, 1000);
    small.set('b', 2, 1000);
    small.set('c', 3, 1000);

    expect(small.size).toBe(2);
    expect(small.has('a')).toBe(false);
    expect(small.has('c')).toBe(true);
  });

  it('caches locators far longer than rates, matching how often each changes', () => {
    expect(TTL.locators).toBeGreaterThan(TTL.rates);
    expect(TTL.registers).toBeGreaterThan(TTL.rates);
  });
});
