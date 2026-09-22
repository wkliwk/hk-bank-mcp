import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/cache.js';
import { HkmaClient } from '../src/client.js';
import { buildUrl, ENDPOINTS } from '../src/endpoints.js';
import type { HkmaError } from '../src/errors.js';
import {
  badGatewayResponse,
  jsonResponse,
  noSleep,
  readFixture,
  scriptedFetch,
  timeoutStep,
} from './helpers.js';

const atmOk = () => jsonResponse(readFixture('atm-locator-en.json'));
const hiborOk = () => jsonResponse(readFixture('hibor-daily.json'));

describe('HkmaClient', () => {
  it('parses records against the endpoint schema', async () => {
    const { fetchImpl } = scriptedFetch([hiborOk]);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    const result = await client.fetch('hiborDaily', { pagesize: 10 });
    const first = result.records[0] as { end_of_day: string; ir_3m?: number | null };

    expect(first.end_of_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.stale).toBe(false);
    expect(result.sourceId).toBe('hkma-monthly-bulletin');
  });

  it('serves a second identical call from cache without touching the network', async () => {
    const { fetchImpl, calls } = scriptedFetch([atmOk, atmOk]);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    await client.fetch('atmLocator', { pagesize: 20 });
    const second = await client.fetch('atmLocator', { pagesize: 20 });

    expect(calls).toHaveLength(1);
    expect(second.stale).toBe(false);
  });

  it('serves stale data rather than failing when the upstream is down', async () => {
    let clock = 1_000_000;
    const cache = new TtlCache({ now: () => clock });
    const { fetchImpl } = scriptedFetch([atmOk, timeoutStep]);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep, cache, maxRetries: 1 });

    const first = await client.fetch('atmLocator', { pagesize: 20 });
    expect(first.stale).toBe(false);

    // Past the 24h locator TTL, with the upstream now failing.
    clock += 25 * 60 * 60 * 1000;
    const second = await client.fetch('atmLocator', { pagesize: 20 });

    expect(second.stale).toBe(true);
    expect(second.ageSeconds).toBeGreaterThan(24 * 60 * 60);
    expect(second.records).toEqual(first.records);
  });

  it('reports as_of as the original fetch, not the moment it was served', async () => {
    // The bug this prevents is silent: a value served from a 20-hour-old cache
    // entry presenting itself as current. The server instructions tell the
    // model every figure carries as_of, so as_of must mean what it says.
    let clock = Date.parse('2026-09-22T09:00:00Z');
    const cache = new TtlCache({ now: () => clock });
    const { fetchImpl, calls } = scriptedFetch([atmOk, atmOk]);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep, cache, now: () => clock });

    const first = await client.fetch('atmLocator', { pagesize: 20 });
    expect(first.asOf).toBe('2026-09-22T09:00:00.000Z');

    // Twenty hours later, still inside the 24h locator TTL.
    clock += 20 * 60 * 60 * 1000;
    const second = await client.fetch('atmLocator', { pagesize: 20 });

    expect(calls).toHaveLength(1);
    expect(second.stale).toBe(false);
    expect(second.asOf).toBe('2026-09-22T09:00:00.000Z');
    expect(second.ageSeconds).toBe(20 * 60 * 60);
  });

  it('keeps as_of and ageSeconds consistent with each other', async () => {
    let clock = Date.parse('2026-09-22T09:00:00Z');
    const cache = new TtlCache({ now: () => clock });
    const { fetchImpl } = scriptedFetch([atmOk]);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep, cache, now: () => clock });

    await client.fetch('atmLocator', { pagesize: 20 });
    clock += 3 * 60 * 60 * 1000;
    const cached = await client.fetch('atmLocator', { pagesize: 20 });

    // A caller can derive one from the other; if they disagree, one is lying.
    const derived = (clock - Date.parse(cached.asOf)) / 1000;
    expect(cached.ageSeconds).toBe(derived);
  });

  it('reports as_of from the original fetch when serving stale data', async () => {
    let clock = Date.parse('2026-09-22T09:00:00Z');
    const cache = new TtlCache({ now: () => clock });
    const { fetchImpl } = scriptedFetch([atmOk, timeoutStep]);
    const client = new HkmaClient({
      fetchImpl,
      sleep: noSleep,
      cache,
      maxRetries: 1,
      now: () => clock,
    });

    await client.fetch('atmLocator', { pagesize: 20 });
    clock += 30 * 60 * 60 * 1000;
    const stale = await client.fetch('atmLocator', { pagesize: 20 });

    expect(stale.stale).toBe(true);
    expect(stale.asOf).toBe('2026-09-22T09:00:00.000Z');
  });

  it('throws when the upstream is down and nothing is cached to fall back on', async () => {
    const { fetchImpl } = scriptedFetch([timeoutStep]);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep, maxRetries: 1 });

    const error = (await client.fetch('atmLocator').catch((e: unknown) => e)) as HkmaError;

    expect(error.kind).toBe('timeout');
    expect(error.agentHint).toMatch(/offer to (retry|try again)/i);
  });

  it('does not mask a caller mistake with stale data', async () => {
    let clock = 1_000_000;
    const cache = new TtlCache({ now: () => clock });
    const { fetchImpl } = scriptedFetch([atmOk, () => jsonResponse('{}', 400)]);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep, cache });

    await client.fetch('atmLocator', { pagesize: 20 });
    clock += 25 * 60 * 60 * 1000;

    // A 400 is the caller's fault; answering it with old data would hide the bug.
    const error = (await client
      .fetch('atmLocator', { pagesize: 20 })
      .catch((e: unknown) => e)) as HkmaError;
    expect(error.kind).toBe('bad_request');
  });

  it('can be told not to serve stale data at all', async () => {
    let clock = 1_000_000;
    const cache = new TtlCache({ now: () => clock });
    const { fetchImpl } = scriptedFetch([atmOk, badGatewayResponse]);
    const client = new HkmaClient({
      fetchImpl,
      sleep: noSleep,
      cache,
      maxRetries: 0,
      staleOnError: false,
    });

    await client.fetch('atmLocator', { pagesize: 20 });
    clock += 25 * 60 * 60 * 1000;

    const error = (await client
      .fetch('atmLocator', { pagesize: 20 })
      .catch((e: unknown) => e)) as HkmaError;
    expect(error.kind).toBe('upstream_unavailable');
  });

  it('clamps an oversized pagesize instead of triggering err_code 9999', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => jsonResponse(readFixture('register-ais.json')),
    ]);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    // The register endpoint rejects anything around 200; asking for 5000 must not
    // be passed through verbatim.
    await client.fetch('authorisedInstitutions', { pagesize: 5000 });

    const requested = new URL(calls[0] ?? '').searchParams.get('pagesize');
    expect(Number(requested)).toBe(ENDPOINTS.authorisedInstitutions.maxPageSize);
  });

  it('pages through a dataset until a short page ends it', async () => {
    // The API reports no total, so a short page is the only end-of-data signal.
    const full = JSON.parse(readFixture('atm-locator-en.json')) as {
      header: unknown;
      result: { datasize: number; records: unknown[] };
    };
    const pageOf = (records: unknown[]) =>
      jsonResponse(
        JSON.stringify({
          header: { success: true },
          result: { datasize: records.length, records },
        }),
      );

    const size = ENDPOINTS.atmLocator.maxPageSize;
    const bigPage = Array.from({ length: size }, () => full.result.records[0]);
    const { fetchImpl, calls } = scriptedFetch([
      () => pageOf(bigPage),
      () => pageOf(full.result.records.slice(0, 3)),
    ]);
    const client = new HkmaClient({ fetchImpl, sleep: noSleep });

    const result = await client.fetchAll('atmLocator');

    expect(calls).toHaveLength(2);
    expect(result.records).toHaveLength(size + 3);
    expect(new URL(calls[1] ?? '').searchParams.get('offset')).toBe(String(size));
  });

  it('omits lang for endpoints that do not support it', () => {
    expect(buildUrl(ENDPOINTS.hiborDaily, { lang: 'tc' })).not.toMatch(/lang=/);
    expect(buildUrl(ENDPOINTS.atmLocator, { lang: 'tc' })).toMatch(/lang=tc/);
  });
});
