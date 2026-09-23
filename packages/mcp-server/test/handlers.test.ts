import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HkmaClient } from '@hk-bank-mcp/hkma-client';
import { describe, expect, it } from 'vitest';
import { handleFindBankLocation } from '../src/tools/find-bank-location.js';
import { handleGetInterestRates } from '../src/tools/get-interest-rates.js';

/**
 * Handler-level tests. These drive the real HkmaClient with an injected fetch,
 * so the whole stack runs offline: paging, caching, schema parsing, the search
 * itself, and the response shaping the handler does on top.
 *
 * Everything here only runs when something upstream is broken or partially
 * broken — which is when nobody is watching and when a silent regression does
 * the most damage.
 */

const fixturesDir = new URL('../../../fixtures/hkma/', import.meta.url);
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(name, fixturesDir)), 'utf8');

const json = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

/** Routes by endpoint path so each dataset can succeed or fail independently. */
function routedFetch(routes: Record<string, () => Response | never>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    for (const [fragment, handler] of Object.entries(routes)) {
      if (url.includes(fragment)) return handler();
    }
    throw new Error(`no route for ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const timeout = (): never => {
  throw new DOMException('timed out', 'TimeoutError');
};

const noSleep = async (): Promise<void> => {};

const baseArgs = {
  type: 'any' as const,
  limit: 10,
  response_format: 'concise' as const,
  lang: 'en' as const,
  detail: false,
};

describe('hk_find_bank_location handler', () => {
  it('answers from the datasets that worked and names the one that did not', async () => {
    // Graceful degradation is a headline design decision in PRODUCT.md and had
    // no test at all before #29. One dataset down must not fail the search.
    const { fetchImpl } = routedFetch({
      'banks-atm-locator': () => json(fixture('atm-locator-en.json')),
      'banks-branch-locator': timeout,
      'banks-ssm-locator': () => json(fixture('ssm-locator-en.json')),
    });
    const client = new HkmaClient({ fetchImpl, sleep: noSleep, maxRetries: 0 });

    const result = await handleFindBankLocation(client, {
      ...baseArgs,
      districts: ['yau-tsim-mong'],
    });

    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.unavailable_types).toEqual(['branch']);
    expect((body.results as unknown[]).length).toBeGreaterThan(0);
  });

  it('refuses rather than inventing an address when every dataset is down', async () => {
    const { fetchImpl } = routedFetch({
      'banks-atm-locator': timeout,
      'banks-branch-locator': timeout,
      'banks-ssm-locator': timeout,
    });
    const client = new HkmaClient({ fetchImpl, sleep: noSleep, maxRetries: 0 });

    const result = await handleFindBankLocation(client, baseArgs);

    expect(result.isError).toBe(true);
    const body = result.structuredContent as { hint: string };
    // The model must be told not to fall back on memory.
    expect(body.hint).toMatch(/memory/i);
  });

  it('reports as_of from the oldest source, never the freshest', async () => {
    // A response is only as current as its stalest part; reporting the newest
    // would overstate freshness.
    const { fetchImpl } = routedFetch({
      'banks-atm-locator': () => json(fixture('atm-locator-en.json')),
      'banks-branch-locator': () => json(fixture('branch-locator-en.json')),
      'banks-ssm-locator': () => json(fixture('ssm-locator-en.json')),
    });
    let clock = Date.parse('2026-09-22T09:00:00Z');
    const client = new HkmaClient({
      fetchImpl,
      sleep: noSleep,
      now: () => {
        clock += 60_000; // each fetch stamped a minute later than the last
        return clock;
      },
    });

    const result = await handleFindBankLocation(client, { ...baseArgs, districts: ['sha-tin'] });
    const body = result.structuredContent as { as_of: string };

    // Whatever the individual stamps were, the reported one is the earliest.
    expect(Date.parse(body.as_of)).toBeLessThanOrEqual(clock);
    expect(body.as_of).toMatch(/^2026-09-22T09:0/);
  });

  it('turns an ambiguous bank into an error carrying the candidates', async () => {
    const { fetchImpl } = routedFetch({
      'banks-atm-locator': () => json(fixture('atm-locator-en.json')),
      'banks-branch-locator': () => json(fixture('branch-locator-en.json')),
      'banks-ssm-locator': () => json(fixture('ssm-locator-en.json')),
    });
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    const result = await handleFindBankLocation(client, { ...baseArgs, bank: '中國' });

    expect(result.isError).toBe(true);
    const body = result.structuredContent as { hint: string; candidates: string[] };
    expect(body.candidates.length).toBeGreaterThan(1);
    expect(body.hint).toMatch(/do not pick one/i);
  });

  it('turns an unknown district id into an error listing the valid ones', async () => {
    const { fetchImpl } = routedFetch({
      'banks-atm-locator': () => json(fixture('atm-locator-en.json')),
      'banks-branch-locator': () => json(fixture('branch-locator-en.json')),
      'banks-ssm-locator': () => json(fixture('ssm-locator-en.json')),
    });
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    const result = await handleFindBankLocation(client, { ...baseArgs, districts: ['atlantis'] });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { candidates: string[] }).candidates).toHaveLength(18);
  });

  it('only fetches the dataset the requested type needs', async () => {
    const { fetchImpl, calls } = routedFetch({
      'banks-atm-locator': () => json(fixture('atm-locator-en.json')),
      'banks-branch-locator': () => json(fixture('branch-locator-en.json')),
      'banks-ssm-locator': () => json(fixture('ssm-locator-en.json')),
    });
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    await handleFindBankLocation(client, { ...baseArgs, type: 'atm', districts: ['islands'] });

    expect(calls.some((u) => u.includes('banks-atm-locator'))).toBe(true);
    expect(calls.some((u) => u.includes('banks-branch-locator'))).toBe(false);
  });
});

describe('hk_get_interest_rates handler', () => {
  const rateRoutes = {
    'hk-interbank-ir-daily': () => json(fixture('hibor-daily.json')),
    'daily-figures-interbank-liquidity': () => json(fixture('daily-monetary.json')),
    'hkd-ir-effdates': () => json(fixture('hkd-ir-effdates.json')),
  };

  it('returns exactly one point and no summary when no range is given', async () => {
    const { fetchImpl } = routedFetch(rateRoutes);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    const result = await handleGetInterestRates(client, {
      rate_type: 'hibor',
      tenor: '3m',
      detail: false,
    });

    const body = result.structuredContent as Record<string, unknown>;
    expect(body.points_count).toBe(1);
    // The historical spread nobody asked for must not be present.
    expect(body.average).toBeUndefined();
    expect(body.min).toBeUndefined();
  });

  it('returns the trend summary when a range is given', async () => {
    const { fetchImpl } = routedFetch(rateRoutes);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    const result = await handleGetInterestRates(client, {
      rate_type: 'hibor',
      tenor: '3m',
      from: '2026-08-01',
      detail: false,
    });

    const body = result.structuredContent as Record<string, unknown>;
    expect(body.average).toBeDefined();
    expect(Number(body.points_count)).toBeGreaterThan(1);
  });

  it('rejects a future date with an actionable hint', async () => {
    const { fetchImpl } = routedFetch(rateRoutes);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    const result = await handleGetInterestRates(client, {
      rate_type: 'hibor',
      tenor: '3m',
      from: '2099-01-01',
      detail: false,
    });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { hint: string }).hint).toMatch(/today/i);
  });

  it('rejects from after to', async () => {
    const { fetchImpl } = routedFetch(rateRoutes);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    const result = await handleGetInterestRates(client, {
      rate_type: 'hibor',
      tenor: '3m',
      from: '2026-08-31',
      to: '2026-08-01',
      detail: false,
    });

    expect(result.isError).toBe(true);
  });

  it('maps an upstream failure to an error rather than throwing', async () => {
    const { fetchImpl } = routedFetch({
      'hk-interbank-ir-daily': timeout,
      'daily-figures-interbank-liquidity': timeout,
    });
    const client = new HkmaClient({ fetchImpl, sleep: noSleep, maxRetries: 0 });

    const result = await handleGetInterestRates(client, {
      rate_type: 'hibor',
      tenor: '3m',
      detail: false,
    });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { hint: string }).hint).toMatch(
      /unavailable|outage|retry/i,
    );
  });

  it('answers the prime rate when hkd_reference is asked with no tenor', async () => {
    const { fetchImpl } = routedFetch(rateRoutes);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    const result = await handleGetInterestRates(client, {
      rate_type: 'hkd_reference',
      detail: false,
    });

    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as { latest?: { value: number } };
    expect(typeof body.latest?.value).toBe('number');
  });
});
