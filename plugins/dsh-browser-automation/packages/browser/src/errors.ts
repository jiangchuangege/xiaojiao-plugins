/**
 * Stable error contract for the browser capability. Every user- or
 * model-visible failure crosses a provider or service boundary as a
 * {@link BrowserError}; unknown exceptions are normalized to `UNKNOWN` at
 * the provider boundary. Messages are non-sensitive by construction:
 * they never embed absolute paths, browser argv, environment variables,
 * secrets, raw stderr, HTML, cookies, headers, or undisclosed URLs.
 * @module @dsh-browser-automation/dsh-browser/errors
 */

/** Every stable error code the browser capability can produce. */
export const BROWSER_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_AMBIGUOUS',
  'RUNTIME_MISSING',
  'SESSION_NOT_FOUND',
  'SESSION_LIMIT_EXCEEDED',
  'OWNER_MISMATCH',
  'STALE_REF',
  'TARGET_NOT_FOUND',
  'TARGET_NOT_ACTIONABLE',
  'APPROVAL_REJECTED',
  'APPROVAL_CANCELLED',
  'APPROVAL_UNAVAILABLE',
  'NAVIGATION_BLOCKED',
  'NETWORK_POLICY_BLOCKED',
  'ROUTE_NOT_IMAGE_CAPABLE',
  'UNSUPPORTED_ACTION',
  'OUTPUT_LIMIT_EXCEEDED',
  'TIMEOUT',
  'ABORTED',
  'PAGE_CRASHED',
  'BROWSER_CRASHED',
  'UNKNOWN',
] as const

/** One stable error code from {@link BROWSER_ERROR_CODES}. */
export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number]

/** Structured, non-sensitive context attached to an error when useful. */
export interface BrowserErrorContext {
  /** Opaque ids only; never paths, urls, or secrets. */
  readonly sessionId?: string
  readonly observationId?: string
  /** Origin string already reduced to scheme/host; no query, no userinfo. */
  readonly origin?: string
}

/** Error with a stable machine-readable code and retry guidance. */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode
  readonly retryable: boolean
  readonly context: BrowserErrorContext

  constructor(code: BrowserErrorCode, message: string, options?: { readonly retryable?: boolean; readonly context?: BrowserErrorContext }) {
    super(`${code}: ${message}`)
    this.name = 'BrowserError'
    this.code = code
    this.retryable = options?.retryable ?? false
    this.context = options?.context ?? {}
  }

  /** Normalize any thrown value into a stable BrowserError. */
  static from(unknown: unknown): BrowserError {
    if (unknown instanceof BrowserError) return unknown
    if (unknown instanceof Error) return new BrowserError('UNKNOWN', unknown.message)
    return new BrowserError('UNKNOWN', String(unknown))
  }
}

/** Whether a thrown value is a BrowserError with exactly `code`. */
export function isBrowserError(value: unknown, code?: BrowserErrorCode): value is BrowserError {
  return value instanceof BrowserError && (code === undefined || value.code === code)
}
