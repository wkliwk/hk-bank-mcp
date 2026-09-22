import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixturesDir = new URL('../../../fixtures/hkma/', import.meta.url);

export function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, fixturesDir)), 'utf8');
}

export function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** The exact shape the Alibaba load balancer returns when the upstream is down. */
export function badGatewayResponse(): Response {
  return new Response(readFixture('upstream-502.html'), {
    status: 502,
    headers: { 'content-type': 'text/html' },
  });
}

/** HTTP 200 carrying HTML — observed in the wild, and the reason bodies are not parsed blindly. */
export function htmlWith200Response(): Response {
  return new Response(readFixture('upstream-502.html'), {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

export function apiFailureResponse(errCode: string): Response {
  return jsonResponse(
    JSON.stringify({ header: { success: false, err_code: errCode, err_msg: null } }),
  );
}

/** A fetch stub that plays the given responses in order and records every call. */
export function scriptedFetch(steps: (() => Response | Promise<Response> | never)[]): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input.toString());
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === undefined) throw new Error('scriptedFetch ran out of steps');
    return await step();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

export function timeoutStep(): never {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

/** Backoff without real delay, so retry tests stay fast. */
export const noSleep = async (): Promise<void> => {};
