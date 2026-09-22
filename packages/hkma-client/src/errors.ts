/**
 * Error classification for HKMA API calls.
 *
 * The upstream is intermittently unavailable (see issue #1): it returns HTTP 502
 * with a small HTML body from an Alibaba load balancer, or simply never responds.
 * The point of this taxonomy is that an LLM reading the error can tell the
 * difference between "the service is down, say so and offer to retry" and
 * "you asked for something impossible, fix the request".
 */
export type HkmaErrorKind =
  /** No response within the timeout. Transient. */
  | 'timeout'
  /** Socket/DNS failure. Transient. */
  | 'network'
  /** HTTP 5xx. Transient. */
  | 'upstream_unavailable'
  /** HTTP 200 but the body was not JSON — in practice a 502 HTML page. Transient. */
  | 'malformed_response'
  /** HTTP 4xx. The request itself is wrong; retrying will not help. */
  | 'bad_request'
  /** HTTP 200 with `header.success === false`. May or may not be the caller's fault. */
  | 'api_error'
  /** Response JSON did not match the expected schema. */
  | 'schema_mismatch';

const TRANSIENT: ReadonlySet<HkmaErrorKind> = new Set<HkmaErrorKind>([
  'timeout',
  'network',
  'upstream_unavailable',
  'malformed_response',
]);

export interface HkmaErrorOptions {
  kind: HkmaErrorKind;
  message: string;
  /** Plain-language next step for an LLM. Surfaced verbatim in tool errors. */
  agentHint: string;
  endpoint?: string;
  httpStatus?: number;
  /** HKMA's own `header.err_code`, e.g. "9999". */
  errCode?: string;
  attempts?: number;
  cause?: unknown;
}

export class HkmaError extends Error {
  readonly kind: HkmaErrorKind;
  readonly agentHint: string;
  readonly endpoint: string | undefined;
  readonly httpStatus: number | undefined;
  readonly errCode: string | undefined;
  readonly attempts: number | undefined;

  constructor(options: HkmaErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HkmaError';
    this.kind = options.kind;
    this.agentHint = options.agentHint;
    this.endpoint = options.endpoint;
    this.httpStatus = options.httpStatus;
    this.errCode = options.errCode;
    this.attempts = options.attempts;
  }

  /** Whether retrying the identical request could plausibly succeed. */
  get isTransient(): boolean {
    return TRANSIENT.has(this.kind);
  }

  /**
   * What a tool should hand back to the model. Deliberately excludes the stack —
   * a stack trace costs tokens and tells the model nothing it can act on.
   */
  toAgentMessage(): string {
    const parts = [this.message, this.agentHint];
    return parts.filter(Boolean).join(' ');
  }
}

/** Hint used when the service is down and we have nothing cached to fall back on. */
export const UPSTREAM_DOWN_HINT =
  'The HKMA public API is temporarily unavailable — this happens intermittently and is ' +
  'not caused by the request. Tell the user the official source is down right now and ' +
  'offer to try again. Do not estimate or recall a figure from memory.';
