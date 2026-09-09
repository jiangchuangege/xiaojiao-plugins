/**
 * Types-only protocol of the browser capability seam: the request/result
 * contracts between the tool Consumer, {@link BrowserSessionService}, and
 * browser backends. This file contains no runtime code.
 * @module @dsh-browser-automation/dsh-browser/types
 */

import type { BrowserSessionId, BrowserPageId, ObservationId, ElementRef } from './brand.js'

/** Capture of one live tool execution; never constructible from model schema. */
export interface BrowserOperation {
  /** Exact tool call identity, used for approval audit linkage. */
  readonly callId: string
  /** The live agent on whose behalf the call runs; owner checks compare identity. */
  readonly agent: unknown
  /** Caller-owned cancellation for this invocation. */
  readonly signal: AbortSignal
  /** Operation budget in milliseconds; the service derives the deadline. */
  readonly timeoutMs: number
  /** Tool name shown in approval audit events. */
  readonly toolName: string
}

/** One-shot, module-private grant minted by the service after `allowed-once`. */
export interface ActionPermit {
  readonly nonce: string
  readonly expiresAt: number
}

/** Backend selection for a new session. */
export interface StartRequest {
  /** Required when more than one backend is registered; selects by `type`. */
  readonly backend?: string
}

/** Navigation request with an exact, service-validated target URL. */
export interface NavigateRequest {
  readonly url: string
}

/** No user-visible knobs in V1; observation budgets live in provider Config. */
export interface ObserveRequest {}

/** Closed union of every V1 mutation action. */
export type BrowserAction =
  | { readonly kind: 'click'; readonly ref: ElementRef }
  | { readonly kind: 'fill'; readonly ref: ElementRef; readonly text: string }
  | { readonly kind: 'press'; readonly ref: ElementRef; readonly key: PressKey }
  | { readonly kind: 'scroll'; readonly target: { readonly page: true } | { readonly element: ElementRef }; readonly deltaY: number }

/** Fixed allowlist of single keys; no chords, no system shortcuts. */
export type PressKey =
  | 'Enter' | 'Space' | 'Tab'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Backspace' | 'Escape' | 'Home' | 'End' | 'PageUp' | 'PageDown'

/** Request for one mutation action against the live page. */
export interface ActRequest {
  readonly action: BrowserAction
}

/** Screenshot capture request; budgets live in provider Config. */
export interface ScreenshotRequest {}

/** Bounded wait request; no JS predicates in V1. */
export interface WaitRequest {
  readonly ms: number
}

/** Close request; idempotent. */
export interface CloseRequest {}

/** Public view of a started session. */
export interface SessionView {
  readonly sessionId: BrowserSessionId
  readonly pageId: BrowserPageId
  /** Backend type that owns the mechanics. */
  readonly backendType: string
}

/** Result of a successful navigation. */
export interface NavigateResult {
  readonly pageId: BrowserPageId
  /** Reduced origin (scheme//host[:port]) of the final page, or null on about:blank. */
  readonly origin: string | null
  /** Redacted display URL: no query, no fragment, no userinfo. */
  readonly displayUrl: string
  /** Document generation after the navigation; refs from earlier generations are stale. */
  readonly generation: number
}

/** One bounded semantic element of an observation; never a selector. */
export interface ObservedElement {
  /** Opaque ref; resolves only within its own observation and generation. */
  readonly ref: ElementRef
  /** ARIA role when known, else the element tag name. */
  readonly role: string
  /** Accessible name, truncated to the provider budget. */
  readonly accessibleName: string
  /** Bounded visible text, truncated to the provider budget. */
  readonly text: string
  /** Whether the element accepted interaction at observation time. */
  readonly interactive: boolean
}

/** Bounded snapshot of the live page. All fields come from untrusted web content. */
export interface Observation {
  readonly schemaVersion: 1
  readonly sessionId: BrowserSessionId
  readonly pageId: BrowserPageId
  readonly observationId: ObservationId
  /** Document generation this observation belongs to. */
  readonly generation: number
  /** Epoch ms after which element refs from this observation are stale. */
  readonly expiresAt: number
  /** Reduced origin of the observed page, or null on about:blank. */
  readonly origin: string | null
  /** Redacted display URL: no query, no fragment, no userinfo. */
  readonly displayUrl: string
  readonly title: string
  /** True when node or byte budgets truncated this snapshot. */
  readonly truncated: boolean
  /** Number of actionable nodes discovered before truncation. */
  readonly nodeCount: number
  readonly elements: readonly ObservedElement[]
  /** Always untrusted web content; never a trust statement from the page. */
  readonly trust: 'untrusted-web-content'
}

/** Result of one mutation action. */
export interface ActionResult {
  readonly generation: number
  /** Whether the action mutated document state. */
  readonly changed: boolean
}

/** Encoded screenshot captured in memory, before attachment persistence. */
export interface ScreenshotResult {
  readonly image: Uint8Array
  readonly mediaType: 'image/png'
  readonly width: number
  readonly height: number
  readonly bytes: number
}

/** Idempotent close result. */
export interface CloseResult {
  readonly closed: boolean
}

/** Backend-facing specs; service-minted ids and permits are validated again at the action site. */
export interface NavigateSpec {
  readonly url: string
  /** Origin the approval was granted for; cross-origin redirects must be blocked. */
  readonly expectedOrigin: string | null
  readonly permit: ActionPermit | null
}

export interface ActSpec {
  readonly action: BrowserAction
  /** Permit for the exact action; the backend verifies it is unconsumed and unexpired. */
  readonly permit: ActionPermit | null
}

/** Mechanics-only contract implemented by each provider. */
export interface BrowserBackendSession {
  /** Navigate the single page to `spec.url` under the egress policy. */
  navigate(spec: NavigateSpec, signal: AbortSignal): Promise<{ readonly origin: string | null; readonly displayUrl: string; readonly generation: number }>
  /** Capture a bounded semantic observation of the current page. */
  observe(signal: AbortSignal): Promise<Observation>
  /** Perform one mutation action after re-verifying the target. */
  act(spec: ActSpec, signal: AbortSignal): Promise<ActionResult>
  /** Capture the current viewport as encoded PNG bytes (budgets enforced here). */
  screenshot(signal: AbortSignal): Promise<ScreenshotResult>
  /** Wait a bounded time for the page to settle; no JS predicates. */
  wait(ms: number, signal: AbortSignal): Promise<void>
  /** Close page, context, browser process, and private temporary capture data. */
  close(): Promise<void>
}

/** One registered browser backend (a Provider registers into the service). */
export interface BrowserBackend {
  /** Stable unique backend type, e.g. `playwright-isolated`. */
  readonly type: string
  /** Create one owner-exclusive isolated session; honor `signal` for launch work. */
  spawn(signal: AbortSignal): Promise<BrowserBackendSession>
}
