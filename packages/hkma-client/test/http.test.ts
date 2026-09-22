import { describe, expect, it } from 'vitest';
import { HkmaError } from '../src/errors.js';
import { fetchPage } from '../src/http.js';
import {
  apiFailureResponse,
  badGatewayResponse,
  htmlWith200Response,
  jsonResponse,
  noSleep,
  readFixture,
  scriptedFetch,
  timeoutStep,
} from './helpers.js';

const URL_ = 'https://api.hkma.gov.hk/public/bank-svf-info/banks-atm-locator?lang=en&pagesize=1';
const ok = () => jsonResponse(readFixture('atm-locator-en.json'));

describe('fetchPage', () => {
  it('returns records on a successful response', async () => {
    const { fetchImpl, calls } = scriptedFetch([ok]);
    const page = await fetchPage(URL_, { fetchImpl, sleep: noSleep });

    expect(page.records.length).toBeGreaterThan(0);
    expect(page.datasize).toBe(page.records.length);
    expect(calls).toHaveLength(1);
  });

  it('retries a 502 and succeeds on the next attempt', async () => {
    // The observed upstream failure: HTTP 502 with a 164-byte HTML body.
    const { fetchImpl, calls } = scriptedFetch([badGatewayResponse, ok]);
    const page = await fetchPage(URL_, { fetchImpl, sleep: noSleep });

    expect(page.records.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
  });

  it('retries a timeout and succeeds on the next attempt', async () => {
    const { fetchImpl, calls } = scriptedFetch([timeoutStep, ok]);
    const page = await fetchPage(URL_, { fetchImpl, sleep: noSleep });

    expect(page.records.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
  });

  it('treats HTML served with HTTP 200 as a transient outage, not a parse bug', async () => {
    const { fetchImpl } = scriptedFetch([htmlWith200Response]);
    const error = await fetchPage(URL_, { fetchImpl, sleep: noSleep, maxRetries: 0 }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(HkmaError);
    const hkmaError = error as HkmaError;
    expect(hkmaError.kind).toBe('malformed_response');
    expect(hkmaError.isTransient).toBe(true);
    // The model must never see "Unexpected token '<'" — it cannot act on that.
    expect(hkmaError.message).not.toMatch(/Unexpected token/);
    expect(hkmaError.agentHint).toMatch(/temporarily unavailable|intermittently unavailable/i);
  });

  it('gives up after exhausting retries and reports how many were attempted', async () => {
    const { fetchImpl, calls } = scriptedFetch([timeoutStep]);
    const error = (await fetchPage(URL_, {
      fetchImpl,
      sleep: noSleep,
      maxRetries: 2,
    }).catch((e: unknown) => e)) as HkmaError;

    expect(error).toBeInstanceOf(HkmaError);
    expect(error.kind).toBe('timeout');
    expect(calls).toHaveLength(3);
    expect(error.agentHint).toMatch(/Never substitute a remembered or estimated figure/i);
  });

  it('never retries a 4xx, because the request itself is wrong', async () => {
    const { fetchImpl, calls } = scriptedFetch([() => jsonResponse('{}', 404)]);
    const error = (await fetchPage(URL_, { fetchImpl, sleep: noSleep }).catch(
      (e: unknown) => e,
    )) as HkmaError;

    expect(error.kind).toBe('bad_request');
    expect(error.isTransient).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('never retries err_code 9999, which means the caller asked for too large a page', async () => {
    // HTTP 200 with header.success false — the status code alone would say "fine".
    const { fetchImpl, calls } = scriptedFetch([() => apiFailureResponse('9999')]);
    const error = (await fetchPage(URL_, { fetchImpl, sleep: noSleep }).catch(
      (e: unknown) => e,
    )) as HkmaError;

    expect(error.kind).toBe('api_error');
    expect(error.errCode).toBe('9999');
    expect(calls).toHaveLength(1);
    expect(error.agentHint).toMatch(/pagesize/i);
  });

  it('rejects a response whose envelope does not match the documented shape', async () => {
    const { fetchImpl } = scriptedFetch([() => jsonResponse('{"unexpected":true}')]);
    const error = (await fetchPage(URL_, { fetchImpl, sleep: noSleep }).catch(
      (e: unknown) => e,
    )) as HkmaError;

    expect(error.kind).toBe('schema_mismatch');
    expect(error.isTransient).toBe(false);
  });

  it('omits the stack from what an agent is shown', async () => {
    const { fetchImpl } = scriptedFetch([badGatewayResponse]);
    const error = (await fetchPage(URL_, {
      fetchImpl,
      sleep: noSleep,
      maxRetries: 0,
    }).catch((e: unknown) => e)) as HkmaError;

    expect(error.toAgentMessage()).not.toMatch(/\s+at\s/);
    expect(error.toAgentMessage().length).toBeLessThan(400);
  });
});
