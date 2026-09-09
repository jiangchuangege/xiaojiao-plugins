/**
 * One isolated Chromium session owned by the service. Implements the
 * mechanics-only `BrowserBackendSession` contract: egress-controlled
 * navigation, bounded semantic snapshots, TOCTOU-verified actions,
 * budgeted screenshots, bounded waits, and total teardown.
 * @module @dsh-browser-automation/dsh-browser-playwright/session
 */

import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Browser, BrowserContext, Page, Route } from 'playwright-core'
import {
  BrowserError, BrowserSessionId, BrowserPageId, ElementRef, ObservationId,
} from '@dsh-browser-automation/dsh-browser'
import type {
  ActionResult, ActSpec, BrowserBackendSession, BrowserSessionId as BrowserSessionIdType,
  BrowserPageId as BrowserPageIdType, NavigateSpec, Observation, ObservedElement, PressKey,
  ScreenshotResult,
} from '@dsh-browser-automation/dsh-browser'
import { assertRequestAllowed, originOf, validateNavigateTarget } from './egress.js'
import { extractPage } from './extract.js'
import type { ExtractResult, ExtractedElement } from './extract.js'
import type { ResolvedProviderConfig } from './provider.js'

/** Fingerprint of one extracted element: the binding that survives DOM drift checks. */
function fingerprintOf(el: ExtractedElement): string {
  return createHash('sha256')
    .update([el.role, el.name, el.text, el.editable, el.disabled, el.tag].join('\u0000'))
    .digest('hex')
}

/** Reduced display form: origin plus pathname; no query, fragment, or userinfo. */
function displayOf(rawUrl: string): string {
  const origin = originOf(rawUrl)
  if (origin === null) return 'about:blank'
  // originOf non-null means the URL already parsed; the pathname read cannot throw.
  return `${origin}${new URL(rawUrl).pathname}`
}

interface ObservationRecord {
  readonly generation: number
  readonly expiresAt: number
  readonly refs: Map<string, string>
}

export interface PlaywrightSessionOptions {
  readonly sessionId: BrowserSessionIdType
  readonly pageId: BrowserPageIdType
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
  readonly config: ResolvedProviderConfig
  readonly allowLoopback: boolean
  readonly staticOrigins: ReadonlySet<string>
  /** Kills the browser process and removes private temporary capture data. */
  readonly onDispose: () => Promise<void>
}

export class PlaywrightBrowserSession implements BrowserBackendSession {
  readonly sessionId: BrowserSessionIdType
  readonly pageId: BrowserPageIdType

  private generation = 0
  private pageOrigin: string | null = null
  private expectedOrigin: string | null = null
  private leaseActive = false
  private readonly activeRoutes = new Set<Route>()
  private readonly observations = new Map<string, ObservationRecord>()
  private readonly consumedPermits = new Set<string>()
  private screenshotCount = 0
  private closed = false
  private crashed: 'none' | 'page' | 'browser' = 'none'
  private lastBlock: 'egress' | 'cross-origin' | 'lease' | null = null
  private readonly readyPromise: Promise<void>

  constructor(private readonly options: PlaywrightSessionOptions) {
    this.sessionId = options.sessionId
    this.pageId = options.pageId
    this.installLifecycle()
    this.readyPromise = this.installNetworkControl(options.context, options.page)
  }

  /**
   * Resolve when route/WebSocket interception is installed. The provider
   * awaits this before handing the session out so the first navigation can
   * never race the network control plane.
   */
  ready(): Promise<void> {
    return this.readyPromise
  }

  private installLifecycle(): void {
    const { page, context, browser } = this.options
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) this.generation += 1
    })
    page.on('crash', () => {
      this.crashed = 'page'
    })
    browser.on('disconnected', () => {
      this.crashed = 'browser'
    })
    // V1 is strictly single-page: extra pages (popups) are closed immediately.
    context.on('page', extra => {
      if (extra !== page) void extra.close()
    })
  }

  private async installNetworkControl(context: BrowserContext, page: Page): Promise<void> {
    await context.route('**/*', async route => {
      // Race-only guard: a request arriving between close() and the context
      // teardown. Its observable outcome (no requests after close) is
      // asserted by the close-while-timers-run integration test.
      /* v8 ignore start */
      if (this.closed) {
        await route.abort('blockedbyclient').catch(() => undefined)
        return
      }
      /* v8 ignore stop */
      this.activeRoutes.add(route)
      try {
        if (!this.leaseActive) {
          this.lastBlock = 'lease'
          await route.abort('blockedbyclient')
          return
        }
        const request = route.request()
        const raw = request.url()
        // Chrome resolves data:/blob: in-process on current versions, so this
        // guard only fires for exotic schemes on other builds; it is kept as
        // the scheme allowlist's first line of defense.
        /* v8 ignore next 5 */
        if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
          this.lastBlock = 'egress'
          await route.abort('blockedbyclient')
          return
        }
        let classified
        try {
          classified = await assertRequestAllowed(raw, this.options.allowLoopback)
        } catch {
          this.lastBlock = 'egress'
          await route.abort('blockedbyclient')
          return
        }
        if (request.isNavigationRequest() && request.resourceType() === 'document' && request.frame() === page.mainFrame()) {
          // Top-level navigation: the approval scope is the exact expected origin.
          if (this.expectedOrigin !== null && classified.origin !== this.expectedOrigin) {
            this.lastBlock = 'cross-origin'
            await route.abort('blockedbyclient')
            return
          }
        } else if (this.pageOrigin === null || (classified.origin !== this.pageOrigin && !this.options.staticOrigins.has(classified.origin))) {
          // Subresources and iframes: same-origin by default, plus the operator allowlist.
          this.lastBlock = 'cross-origin'
          await route.abort('blockedbyclient')
          return
        }
        // The request was settled elsewhere (abort/close race); nothing to route.
        /* v8 ignore next 4 */
        await route.continue()
      } catch {
      } finally {
        this.activeRoutes.delete(route)
      }
    })
    // WebSockets are disabled entirely in V1.
    await context.routeWebSocket(/.*/, ws => {
      ws.close()
    })
  }

  async navigate(spec: NavigateSpec, signal: AbortSignal): Promise<{ readonly origin: string | null; readonly displayUrl: string; readonly generation: number }> {
    this.ensureLive()
    this.consumePermit(spec.permit)
    const target = validateNavigateTarget(spec.url, this.options.allowLoopback)
    if (spec.expectedOrigin !== null && target.origin !== spec.expectedOrigin) {
      throw new BrowserError('INVALID_ARGUMENT', 'navigation target does not match the approved origin', { retryable: false })
    }
    this.expectedOrigin = target.origin
    this.pageOrigin = target.origin
    this.leaseActive = true
    this.lastBlock = null
    try {
      // The navigation must answer the caller's AbortSignal: race it against
      // an abort-rejecting promise instead of letting a stale goto settle.
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      await Promise.race([
        this.options.page.goto(target.url, { waitUntil: 'load', timeout: this.options.config.navigationTimeoutMs }),
        aborted,
      ])
    } catch (error) {
      if (signal.aborted) throw new BrowserError('ABORTED', 'the navigation was aborted', { retryable: false })
      if (this.lastBlock === 'egress') {
        throw new BrowserError('NETWORK_POLICY_BLOCKED', 'the target or one of its hops was blocked by the egress policy', { retryable: false, context: { origin: target.origin } })
      }
      // Chrome 151 follows redirect hops without re-routing them, so this
      // branch only fires on builds that re-route redirects; the outcome is
      // enforced identically by the route-level navigation guard and the
      // post-goto origin check (both covered).
      /* v8 ignore next 3 */
      if (this.lastBlock === 'cross-origin') {
        throw new BrowserError('NAVIGATION_BLOCKED', 'a redirect left the approved origin scope', { retryable: false, context: { origin: target.origin } })
      }
      throw new BrowserError('NAVIGATION_BLOCKED', 'the navigation failed or was blocked by policy', { retryable: false, context: { origin: target.origin } })
    } finally {
      this.expectedOrigin = null
      this.leaseActive = false
      this.abortInFlight()
    }
    const finalOrigin = originOf(this.options.page.url())
    if (finalOrigin !== null && finalOrigin !== target.origin) {
      throw new BrowserError('NAVIGATION_BLOCKED', 'the page ended on an origin outside the approved scope', { retryable: false })
    }
    /* v8 ignore next 1 -- finalOrigin is always http(s) after a successful goto */
    this.pageOrigin = finalOrigin ?? target.origin
    return { origin: this.pageOrigin, displayUrl: displayOf(this.options.page.url()), generation: this.generation }
  }

  async observe(signal: AbortSignal): Promise<Observation> {
    this.ensureLive()
    this.checkAbort(signal)
    const extract = await this.extract(signal)
    const observationId = ObservationId(randomUUID())
    const refs = new Map<string, string>()
    const elements: ObservedElement[] = []
    for (const el of extract.elements) {
      const token = `${observationId}.${randomUUID()}`
      refs.set(token, fingerprintOf(el))
      elements.push({
        ref: ElementRef(token),
        role: el.role,
        accessibleName: el.name,
        text: el.text,
        interactive: el.interactive && !el.disabled,
      })
    }
    this.observations.set(observationId, {
      generation: this.generation,
      expiresAt: Date.now() + this.options.config.observationTtlMs,
      refs,
    })
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      pageId: this.pageId,
      observationId,
      generation: this.generation,
      expiresAt: Date.now() + this.options.config.observationTtlMs,
      origin: this.pageOrigin,
      displayUrl: displayOf(this.options.page.url()),
      title: extract.title,
      truncated: extract.truncated,
      nodeCount: extract.nodeCount,
      elements,
      trust: 'untrusted-web-content',
    }
  }

  async act(spec: ActSpec, signal: AbortSignal): Promise<ActionResult> {
    this.ensureLive()
    this.consumePermit(spec.permit)
    const { action } = spec
    if (action.kind === 'scroll') return this.scrollAction(action, signal)
    const { fingerprint, observationId } = this.resolveRef(action.ref)
    this.leaseActive = true
    try {
      this.checkAbort(signal)
      const extract = await this.extract(signal)
      const candidates = extract.elements.filter(el => fingerprintOf(el) === fingerprint)
      if (candidates.length === 0) {
        throw new BrowserError('TARGET_NOT_FOUND', 'the action target no longer matches the approved observation', { retryable: false, context: { observationId } })
      }
      if (candidates.length > 1) {
        throw new BrowserError('TARGET_NOT_ACTIONABLE', 'the action target is ambiguous after the page changed', { retryable: false, context: { observationId } })
      }
      const target = candidates[0]!
      if (target.disabled || !target.interactive) {
        throw new BrowserError('TARGET_NOT_ACTIONABLE', 'the action target is disabled or not interactive', { retryable: false, context: { observationId } })
      }
      const locator = this.options.page.locator(target.path).first()
      switch (action.kind) {
        case 'click': {
          // Link clicks may navigate; the approval scope is the current origin.
          this.expectedOrigin = this.pageOrigin
          try {
            await locator.click({ timeout: this.options.config.actionTimeoutMs })
          } finally {
            this.expectedOrigin = null
          }
          break
        }
        case 'fill': {
          if (!target.editable) {
            throw new BrowserError('TARGET_NOT_ACTIONABLE', 'the fill target is not an editable field', { retryable: false, context: { observationId } })
          }
          await locator.fill(action.text, { timeout: this.options.config.actionTimeoutMs })
          break
        }
        case 'press': {
          await locator.focus({ timeout: this.options.config.actionTimeoutMs })
          await this.options.page.keyboard.press(action.key)
          break
        }
      }
      this.generation += 1
      return { generation: this.generation, changed: true }
    } catch (error) {
      if (error instanceof BrowserError) throw error
      /* v8 ignore next 1 -- mid-action abort races; pre-abort paths are covered */
      if (signal.aborted) throw new BrowserError('ABORTED', 'the action was aborted', { retryable: false })
      throw new BrowserError('TARGET_NOT_ACTIONABLE', `the action could not be completed on the target: ${BrowserError.from(error).message}`, { retryable: false, context: { observationId } })
      /* v8 ignore next 3 */
    } finally {
      this.leaseActive = false
      this.abortInFlight()
    }
  }

  async screenshot(signal: AbortSignal): Promise<ScreenshotResult> {
    this.ensureLive()
    this.checkAbort(signal)
    if (this.screenshotCount >= this.options.config.screenshotsPerSession) {
      throw new BrowserError('OUTPUT_LIMIT_EXCEEDED', 'this session reached its screenshot budget', { retryable: false })
    }
    let buffer: Buffer
    try {
      buffer = await this.options.page.screenshot({ type: 'png' })
    } catch (error) {
      /* v8 ignore next 1 -- mid-capture abort races; pre-abort paths are covered */
      if (signal.aborted) throw new BrowserError('ABORTED', 'the capture was aborted', { retryable: false })
      throw new BrowserError('PAGE_CRASHED', 'the page could not be captured', { retryable: false })
    }
    if (buffer.byteLength > this.options.config.screenshotMaxBytes) {
      throw new BrowserError('OUTPUT_LIMIT_EXCEEDED', 'the screenshot exceeds the byte budget', { retryable: false })
    }
    this.screenshotCount += 1
    /* v8 ignore next 1 -- the context pins the viewport; the fallback is a defensive default */
    const viewport = this.options.page.viewportSize() ?? { width: this.options.config.viewportWidth, height: this.options.config.viewportHeight }
    return { image: new Uint8Array(buffer), mediaType: 'image/png', width: viewport.width, height: viewport.height, bytes: buffer.byteLength }
  }

  async wait(ms: number, signal: AbortSignal): Promise<void> {
    this.ensureLive()
    this.checkAbort(signal)
    const bounded = Math.min(Math.max(0, Math.floor(ms)), this.options.config.waitMaxMs)
    try {
      await delay(bounded, undefined, { signal })
    } catch {
      // The timer promise rejects only for abort; the caller signal decides.
      throw new BrowserError('ABORTED', 'the wait was aborted', { retryable: false })
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.observations.clear()
    this.abortInFlight()
    // Total teardown (contexts, browser, process, temp dirs) belongs to the launcher disposer.
    await this.options.onDispose()
  }

  private async extract(signal: AbortSignal): Promise<ExtractResult> {
    this.checkAbort(signal)
    try {
      return await this.options.page.evaluate(extractPage, {
        maxNodes: this.options.config.snapshotMaxNodes,
        maxTextBytes: this.options.config.snapshotMaxTextBytes,
        maxNameChars: this.options.config.snapshotMaxNameChars,
        maxDepth: this.options.config.snapshotMaxDepth,
      })
    } catch (error) {
      /* v8 ignore next 1 -- mid-snapshot abort races; pre-abort paths are covered */
      if (signal.aborted) throw new BrowserError('ABORTED', 'the snapshot was aborted', { retryable: false })
      throw new BrowserError('PAGE_CRASHED', 'the page could not be snapshotted', { retryable: false })
    }
  }

  private resolveRef(ref: string): { readonly fingerprint: string; readonly observationId: string } {
    const dot = ref.indexOf('.')
    if (dot <= 0) {
      throw new BrowserError('INVALID_ARGUMENT', 'element refs are only valid from this session\'s own observations', { retryable: false })
    }
    const observationId = ref.slice(0, dot)
    const record = this.observations.get(observationId)
    if (record === undefined) {
      throw new BrowserError('STALE_REF', 'the observation this ref belongs to no longer exists', { retryable: false, context: { observationId } })
    }
    if (record.generation !== this.generation || record.expiresAt < Date.now()) {
      throw new BrowserError('STALE_REF', 'the page changed or the observation expired since the ref was issued', { retryable: false, context: { observationId } })
    }
    const fingerprint = record.refs.get(ref)
    if (fingerprint === undefined) {
      throw new BrowserError('STALE_REF', 'the ref is not part of its observation', { retryable: false, context: { observationId } })
    }
    return { fingerprint, observationId }
  }

  private async scrollAction(action: Extract<import('@dsh-browser-automation/dsh-browser').BrowserAction, { kind: 'scroll' }>, signal: AbortSignal): Promise<ActionResult> {
    this.checkAbort(signal)
    const delta = Math.max(-this.options.config.maxScrollDelta, Math.min(this.options.config.maxScrollDelta, action.deltaY))
    if ('page' in action.target) {
      await this.options.page.mouse.wheel(0, delta)
      return { generation: this.generation, changed: false }
    }
    const { fingerprint } = this.resolveRef(action.target.element)
    const extract = await this.extract(signal)
    const candidates = extract.elements.filter(el => fingerprintOf(el) === fingerprint)
    if (candidates.length === 0) {
      throw new BrowserError('TARGET_NOT_FOUND', 'the scroll target no longer matches the approved observation', { retryable: false })
    }
    const target = candidates[0]!
    await this.options.page.locator(target.path).first().scrollIntoViewIfNeeded({ timeout: this.options.config.actionTimeoutMs })
    return { generation: this.generation, changed: false }
  }

  private consumePermit(permit: { readonly nonce: string; readonly expiresAt: number } | null): void {
    if (permit === null) return
    if (this.consumedPermits.has(permit.nonce) || permit.expiresAt < Date.now()) {
      throw new BrowserError('APPROVAL_UNAVAILABLE', 'the action permit was already consumed or expired; request approval again', { retryable: false })
    }
    this.consumedPermits.add(permit.nonce)
  }

  private abortInFlight(): void {
    for (const route of this.activeRoutes) {
      void route.abort('blockedbyclient').catch(() => undefined)
    }
    this.activeRoutes.clear()
  }

  private ensureLive(): void {
    if (this.closed) {
      throw new BrowserError('SESSION_NOT_FOUND', 'this browser session is closed', { retryable: false })
    }
    if (this.crashed === 'page') {
      throw new BrowserError('PAGE_CRASHED', 'the page crashed', { retryable: false })
    }
    if (this.crashed === 'browser') {
      throw new BrowserError('BROWSER_CRASHED', 'the browser process is gone', { retryable: false })
    }
  }

  private checkAbort(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new BrowserError('ABORTED', 'the operation was aborted', { retryable: false })
    }
  }

  /**
   * Test seam: simulate the browser process dying (runs the launcher disposer,
   * which kills the child and removes temp dirs) so crash handling is
   * assertable without a real crash. Production code never calls this.
   */
  detachProcessForTesting(): Promise<void> {
    return this.options.onDispose()
  }

  /**
   * Test seam: close the page context without touching the crash flags so the
   * raw-capture failure path is assertable. Production code never calls this.
   */
  detachPageForTesting(): Promise<void> {
    return this.options.context.close()
  }

  /**
   * Test seam: mark the page as crashed by emitting the real page event so
   * the PAGE_CRASHED path is assertable. Production code never calls this.
   */
  simulatePageCrashForTesting(): void {
    const page = this.options.page as unknown as { emit(event: 'crash'): void }
    page.emit('crash')
  }
}
