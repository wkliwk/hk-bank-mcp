import { z } from 'zod';
import { HkmaError, type HkmaErrorKind } from './errors.js';

/**
 * HKMA wraps every response in this envelope. Note that `success` lives in
 * `header`, not in `result` — the published documentation describes a different,
 * flatter shape that the live API does not use (verified in issue #1).
 *
 * Critically, a failed call still returns **HTTP 200**, so the status code alone
 * is never enough to decide whether a call worked.
 */
export const envelopeSchema = z.object({
  header: z.object({
    success: z.boolean(),
    err_code: z.string().nullable().optional(),
    err_msg: z.string().nullable().optional(),
  }),
  result: z
    .object({
      /** Records in THIS page — not a total. The API exposes no total count. */
      datasize: z.number(),
      records: z.array(z.unknown()),
    })
    .optional(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

export interface FetchOptions {
  /** Per-attempt timeout in ms. */
  timeoutMs?: number;
  /** Attempts after the first. Zero disables retrying. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. */
  retryBaseMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so backoff does not consume real time. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface RawPage {
  records: unknown[];
  /** Count of records in this page, as reported by the API. */
  datasize: number;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  maxRetries: 3,
  retryBaseMs: 400,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `err_code` values that mean the caller asked for something invalid. Retrying
 * these is pointless and just adds latency to a request that will never work.
 *
 * 9999 is HKMA's catch-all. It is returned for an oversized `pagesize`, which is
 * a caller bug, so it is treated as non-transient (see `endpoints.ts`, where each
 * endpoint declares a ceiling precisely so this is avoidable).
 */
const NON_RETRYABLE_ERR_CODES: ReadonlySet<string> = new Set(['9999']);

function classifyThrown(error: unknown): { kind: HkmaErrorKind; message: string } {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return { kind: 'timeout', message: 'HKMA API did not respond in time.' };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'timeout', message: 'HKMA API request was aborted before it responded.' };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { kind: 'network', message: `Could not reach the HKMA API: ${detail}` };
}

function hintFor(kind: HkmaErrorKind, errMsg?: string | null): string {
  switch (kind) {
    case 'timeout':
    case 'network':
    case 'upstream_unavailable':
    case 'malformed_response':
      return (
        'The HKMA public API is intermittently unavailable; this is an upstream outage, ' +
        'not a problem with the request. Tell the user the official source is not ' +
        'responding and offer to retry. Never substitute a remembered or estimated figure.'
      );
    case 'bad_request':
      return (
        'The request itself was rejected. Check the endpoint path and parameter names ' +
        'before trying again — retrying unchanged will fail identically.'
      );
    case 'api_error':
      return (
        `HKMA rejected the query${errMsg ? ` (${errMsg})` : ''}. The usual cause is a ` +
        'pagesize above what this endpoint allows; request a smaller page and use offset ' +
        'to read the rest.'
      );
    case 'schema_mismatch':
      return (
        'The API responded with an unexpected structure, which usually means the upstream ' +
        'format changed. Report that the data could not be read rather than guessing at it.'
      );
  }
}

/**
 * Fetch one page from the HKMA API.
 *
 * Handles the three failure shapes observed in issue #1: a timeout with no
 * response at all, an HTTP 502 carrying a small HTML body from the load
 * balancer, and an HTTP 200 whose envelope reports `success: false`.
 */
export async function fetchPage(url: string, options: FetchOptions = {}): Promise<RawPage> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const retryBaseMs = options.retryBaseMs ?? DEFAULTS.retryBaseMs;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: HkmaError | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    let error: HkmaError;

    try {
      const response = await doFetch(url, {
        signal: options.signal ?? AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });

      // A 502 from the load balancer arrives here with an HTML body, so the body
      // must never be parsed as JSON before the status is checked.
      if (response.status >= 500) {
        error = new HkmaError({
          kind: 'upstream_unavailable',
          message: `HKMA API returned HTTP ${response.status}.`,
          agentHint: hintFor('upstream_unavailable'),
          endpoint: url,
          httpStatus: response.status,
          attempts: attempt,
        });
      } else if (response.status >= 400) {
        throw new HkmaError({
          kind: 'bad_request',
          message: `HKMA API rejected the request with HTTP ${response.status}.`,
          agentHint: hintFor('bad_request'),
          endpoint: url,
          httpStatus: response.status,
          attempts: attempt,
        });
      } else {
        const body = await response.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          // Observed in practice: HTTP 200 is not a guarantee of JSON when a proxy
          // sits in front. Surfacing "Unexpected token '<'" would tell the model nothing.
          error = new HkmaError({
            kind: 'malformed_response',
            message: 'HKMA API returned a non-JSON response, which indicates an upstream outage.',
            agentHint: hintFor('malformed_response'),
            endpoint: url,
            httpStatus: response.status,
            attempts: attempt,
          });
          throw error;
        }

        const envelope = envelopeSchema.safeParse(parsed);
        if (!envelope.success) {
          throw new HkmaError({
            kind: 'schema_mismatch',
            message: 'HKMA API response did not match the expected envelope.',
            agentHint: hintFor('schema_mismatch'),
            endpoint: url,
            attempts: attempt,
            cause: envelope.error,
          });
        }

        const { header, result } = envelope.data;
        if (!header.success) {
          const errCode = header.err_code ?? undefined;
          const apiError = new HkmaError({
            kind: 'api_error',
            message: `HKMA API reported failure${errCode ? ` (err_code ${errCode})` : ''}.`,
            agentHint: hintFor('api_error', header.err_msg),
            endpoint: url,
            httpStatus: response.status,
            ...(errCode === undefined ? {} : { errCode }),
            attempts: attempt,
          });
          // A caller mistake such as an oversized pagesize must fail immediately;
          // retrying it three times only makes the user wait longer for the same error.
          if (errCode !== undefined && NON_RETRYABLE_ERR_CODES.has(errCode)) throw apiError;
          error = apiError;
        } else {
          return {
            records: result?.records ?? [],
            datasize: result?.datasize ?? 0,
          };
        }
      }
    } catch (thrown) {
      if (thrown instanceof HkmaError) {
        if (!thrown.isTransient && thrown.kind !== 'api_error') throw thrown;
        if (thrown.kind === 'api_error') throw thrown;
        error = thrown;
      } else {
        const { kind, message } = classifyThrown(thrown);
        error = new HkmaError({
          kind,
          message,
          agentHint: hintFor(kind),
          endpoint: url,
          attempts: attempt,
          cause: thrown,
        });
      }
    }

    lastError = error;
    if (attempt <= maxRetries) {
      // Exponential backoff with jitter, so a server retrying several endpoints
      // at once does not synchronise its attempts against a struggling upstream.
      const backoff = retryBaseMs * 2 ** (attempt - 1);
      await sleep(backoff + Math.floor(Math.random() * retryBaseMs));
    }
  }

  throw (
    lastError ??
    new HkmaError({
      kind: 'network',
      message: 'HKMA API request failed for an unknown reason.',
      agentHint: hintFor('network'),
      endpoint: url,
    })
  );
}
