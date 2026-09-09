/**
 * Owner-scoped isolated browser session service (`ctx.browsers`). The service
 * owns the provider registry, public ids, authorization, approval
 * orchestration, per-session serialization, idle deadlines, and awaited
 * cleanup; providers own only browser mechanics. This mirrors the Terminal
 * seam: ids and grants are service-minted, providers hold private handles.
 * @module @dsh-browser-automation/dsh-browser/service
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import { BrowserPageId, BrowserSessionId } from './brand.js'
import { BrowserError } from './errors.js'
import { reduceTargetUrl } from './url.js'
import type {
  ActionPermit, ActRequest, ActSpec, ActionResult, BrowserAction, BrowserBackend,
  BrowserBackendSession, BrowserOperation, CloseRequest, CloseResult, NavigateRequest,
  NavigateResult, NavigateSpec, Observation, ObserveRequest, ScreenshotRequest,
  ScreenshotResult, SessionView, StartRequest, WaitRequest,
} from './types.js'

/** Service key under which the Context augmentation exposes this service. */
export const BROWSER_SERVICE_NAME = 'browsers'

/** How long a service-minted action permit stays valid (TOCTOU window). */
const PERMIT_TTL_MS = 30_000
/** Default time a session may sit idle before the service closes it. */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000

/** Deployment-tunable service configuration; all fields validated at load. */
export interface BrowserServiceConfig {
  /** Close an idle session after this many milliseconds. */
  idleTimeoutMs?: number
  /** Maximum live sessions per owner agent (default 1). */
  maxSessionsPerAgent?: number
}

interface LiveSession {
  readonly backendType: string
  readonly owner: Agent
  readonly backend: BrowserBackendSession
  readonly pageId: BrowserPageId
  origin: string | null
  lastGeneration: number
  lastObservation: Observation | null
  closed: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Tail of the per-session serialization chain. */
  queue: Promise<unknown>
}

/** Structural view of the approval service; runtime import stays erased. */
interface ApprovalRequester {
  request(req: {
    readonly agent: Agent
    readonly toolName: string
    readonly callId?: unknown
    readonly reason?: string
    readonly signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** Build a non-sensitive approval reason from live data only. */
function buildApprovalReason(action: string, origin: string | null, target: string | null, nonce: string): string {
  const parts = [`action=${action}`]
  if (origin !== null) parts.push(`origin=${origin}`)
  if (target !== null) parts.push(`target=${target}`)
  parts.push(`nonce=${nonce}`)
  return parts.join(' ')
}

/** Reduce the caller's URL to a redacted display form and its origin. */
function targetOf(url: string): { readonly origin: string | null; readonly displayUrl: string } {
  return reduceTargetUrl(url)
}

export class BrowserSessionService extends Service {
  static Config: z<BrowserServiceConfig> = z.object({
    idleTimeoutMs: z.number().default(DEFAULT_IDLE_TIMEOUT_MS),
    maxSessionsPerAgent: z.number().default(1),
  })

  private readonly backends = new Map<string, BrowserBackend>()
  private readonly sessions = new Map<string, LiveSession>()

  constructor(ctx: Context, public config: BrowserServiceConfig = {}) {
    super(ctx, BROWSER_SERVICE_NAME)
    if (!Number.isFinite(config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) || (config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) <= 0) {
      throw new Error('browsers: idleTimeoutMs must be a positive finite number')
    }
    if (!Number.isInteger(config.maxSessionsPerAgent ?? 1) || (config.maxSessionsPerAgent ?? 1) < 1) {
      throw new Error('browsers: maxSessionsPerAgent must be a positive integer')
    }
    ctx.effect(() => () => this.disposeAll())
  }

  /** Register one backend; returns the exact disposer (unregister + close its sessions). */
  registerBackend(backend: BrowserBackend): () => void {
    if (this.backends.has(backend.type)) {
      throw new Error(`browsers: a backend of type "${backend.type}" is already registered`)
    }
    this.backends.set(backend.type, backend)
    return () => {
      if (this.backends.get(backend.type) !== backend) return
      this.backends.delete(backend.type)
      const owned = [...this.sessions.values()].filter(session => session.backendType === backend.type)
      return Promise.all(owned.map(session => this.closeSession(session)))
    }
  }

  /** Create one owner-exclusive isolated session with a single blank page. */
  async start(owner: Agent, request: StartRequest, operation: BrowserOperation): Promise<SessionView> {
    const backend = this.selectBackend(request.backend)
    const live = [...this.sessions.values()].filter(session => session.owner === owner && !session.closed)
    if (live.length >= (this.config.maxSessionsPerAgent ?? 1)) {
      throw new BrowserError('SESSION_LIMIT_EXCEEDED', 'this agent already owns the maximum number of browser sessions', { retryable: false })
    }
    const deadline = this.deadlineOf(operation)
    let backendSession: BrowserBackendSession
    try {
      backendSession = await backend.spawn(deadline.signal)
    } catch (error) {
      throw this.mapError(error, operation)
    }
    const sessionId = BrowserSessionId(randomUUID())
    const session: LiveSession = {
      backendType: backend.type,
      owner,
      backend: backendSession,
      pageId: BrowserPageId(randomUUID()),
      origin: null,
      lastGeneration: 0,
      lastObservation: null,
      closed: false,
      idleTimer: null,
      queue: Promise.resolve(),
    }
    this.sessions.set(sessionId, session)
    this.armIdle(session)
    return { sessionId, pageId: session.pageId, backendType: backend.type }
  }

  /** Navigate the session's page to an exact URL after a one-shot approval. */
  navigate(owner: Agent, request: NavigateRequest, operation: BrowserOperation): Promise<NavigateResult> {
    return this.queueFor(owner, operation, session => this.run(operation, async () => {
      const target = targetOf(request.url)
      const permit = await this.requireApproval(session, operation, 'navigate', target.origin, target.displayUrl)
      const deadline = this.deadlineOf(operation)
      const spec: NavigateSpec = { url: request.url, expectedOrigin: target.origin, permit }
      const result = await session.backend.navigate(spec, deadline.signal)
      session.origin = result.origin
      session.lastGeneration = result.generation
      session.lastObservation = null
      this.armIdle(session)
      return { pageId: session.pageId, ...result }
    }))
  }

  /** Capture a bounded semantic observation; read-only, no approval. */
  observe(owner: Agent, _request: ObserveRequest, operation: BrowserOperation): Promise<Observation> {
    return this.queueFor(owner, operation, session => this.run(operation, async () => {
      const deadline = this.deadlineOf(operation)
      const observation = await session.backend.observe(deadline.signal)
      session.origin = observation.origin
      session.lastGeneration = observation.generation
      session.lastObservation = observation
      this.armIdle(session)
      return observation
    }))
  }

  /** Perform one mutation action after a one-shot approval and TOCTOU re-check. */
  act(owner: Agent, request: ActRequest, operation: BrowserOperation): Promise<ActionResult> {
    return this.queueFor(owner, operation, session => this.run(operation, async () => {
      const action = request.action
      const permit = action.kind === 'scroll'
        ? null
        : await this.requireApproval(session, operation, action.kind, session.origin, this.targetLabel(session, action as Extract<BrowserAction, { readonly kind: 'click' | 'fill' | 'press' }>))
      const deadline = this.deadlineOf(operation)
      const spec: ActSpec = { action, permit }
      const result = await session.backend.act(spec, deadline.signal)
      session.lastGeneration = result.generation
      session.lastObservation = null
      this.armIdle(session)
      return result
    }))
  }

  /** Capture the current viewport after a one-shot approval; bytes stay in memory. */
  screenshot(owner: Agent, _request: ScreenshotRequest, operation: BrowserOperation): Promise<ScreenshotResult> {
    return this.queueFor(owner, operation, session => this.run(operation, async () => {
      await this.requireApproval(session, operation, 'screenshot', session.origin, null)
      const deadline = this.deadlineOf(operation)
      const result = await session.backend.screenshot(deadline.signal)
      this.armIdle(session)
      return result
    }))
  }

  /** Wait a bounded time for the page to settle; read-only, auto-allowed. */
  wait(owner: Agent, request: WaitRequest, operation: BrowserOperation): Promise<void> {
    return this.queueFor(owner, operation, session => this.run(operation, async () => {
      const deadline = this.deadlineOf(operation)
      await session.backend.wait(request.ms, deadline.signal)
      this.armIdle(session)
    }))
  }

  /** Close this owner's session; idempotent, waits for quiescence. */
  async close(owner: Agent, _request: CloseRequest, operation: BrowserOperation): Promise<CloseResult> {
    const session = this.findSession(owner)
    if (session === undefined || session.closed) return { closed: false }
    await this.closeSession(session)
    this.touch(operation.signal)
    return { closed: true }
  }

  /** Close every live session belonging to one owner agent. */
  async closeAllFor(owner: Agent): Promise<void> {
    const owned = [...this.sessions.values()].filter(session => session.owner === owner && !session.closed)
    await Promise.all(owned.map(session => this.closeSession(session)))
  }

  /** Number of live sessions (diagnostics only). */
  liveSessionCount(): number {
    return [...this.sessions.values()].filter(session => !session.closed).length
  }

  private selectBackend(requested: string | undefined): BrowserBackend {
    if (this.backends.size === 0) {
      throw new BrowserError('PROVIDER_UNAVAILABLE', 'no browser backend is registered in this profile', { retryable: false })
    }
    if (requested !== undefined) {
      const backend = this.backends.get(requested)
      if (backend === undefined) {
        throw new BrowserError('PROVIDER_UNAVAILABLE', `no browser backend of type "${requested}" is registered`, { retryable: false })
      }
      return backend
    }
    if (this.backends.size > 1) {
      throw new BrowserError('PROVIDER_AMBIGUOUS', 'multiple browser backends are registered; select one explicitly', { retryable: false })
    }
    return [...this.backends.values()][0]!
  }

  private sessionFor(owner: Agent, operation: BrowserOperation): LiveSession {
    const session = this.findSession(owner)
    if (session === undefined || session.closed) {
      throw new BrowserError('SESSION_NOT_FOUND', 'this agent has no live browser session', { retryable: false })
    }
    this.touch(operation.signal)
    return session
  }

  private findSession(owner: Agent): LiveSession | undefined {
    return [...this.sessions.values()].find(session => session.owner === owner && !session.closed)
  }

  /** Resolve the session and queue work so lookup failures reject as promises. */
  private queueFor<T>(owner: Agent, operation: BrowserOperation, fn: (session: LiveSession) => Promise<T>): Promise<T> {
    return Promise.resolve().then(() => {
      const session = this.sessionFor(owner, operation)
      return this.enqueue(session, () => fn(session))
    })
  }

  /** Serialize all operations on one session; mutations and reads share the fence. */
  private enqueue<T>(session: LiveSession, run: () => Promise<T>): Promise<T> {
    const prev = session.queue
    const next = prev.catch(() => undefined).then(run)
    session.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** Map any operation failure onto the stable error contract. */
  private run<T>(operation: BrowserOperation, fn: () => Promise<T>): Promise<T> {
    return fn().catch((error: unknown) => {
      throw this.mapError(error, operation)
    })
  }

  private requireApproval(session: LiveSession, operation: BrowserOperation, action: string, origin: string | null, target: string | null): Promise<ActionPermit> {
    const approval = this.approvalService()
    if (approval === undefined) {
      return Promise.reject(new BrowserError('APPROVAL_UNAVAILABLE', 'no approval service is composed in this profile; write actions fail closed', { retryable: false }))
    }
    const nonce = randomUUID()
    const reason = buildApprovalReason(action, origin, target, nonce)
    return approval.request({
      agent: session.owner,
      toolName: operation.toolName,
      callId: operation.callId,
      reason,
      signal: operation.signal,
    }).then(outcome => {
      switch (outcome) {
        case 'allowed-once':
          return { nonce, expiresAt: Date.now() + PERMIT_TTL_MS } satisfies ActionPermit
        case 'rejected':
          throw new BrowserError('APPROVAL_REJECTED', 'the user rejected this browser action', { retryable: false })
        case 'cancelled':
          throw new BrowserError('APPROVAL_CANCELLED', 'the approval request was withdrawn', { retryable: false })
        default:
          throw new BrowserError('APPROVAL_UNAVAILABLE', 'no answerer decided the browser action in time', { retryable: false })
      }
    })
  }

  /** The approval service when composed; undefined means fail closed. */
  private approvalService(): ApprovalRequester | undefined {
    // Cordis returns undefined for a never-provided service, so no try/catch
    // is needed; absence fails closed in requireApproval.
    return this.ctx.get('approval') as ApprovalRequester | undefined
  }

  /** Reduced accessible label of one action target from the last observation. */
  private targetLabel(session: LiveSession, action: Extract<BrowserAction, { readonly kind: 'click' | 'fill' | 'press' }>): string | null {
    // Only click/fill/press reach here (scroll bypasses approval), so no kind
    // guard is needed; the union is closed by the caller.
    const element = session.lastObservation?.elements.find(candidate => candidate.ref === action.ref)
    return element === undefined ? null : (element.accessibleName || element.text || element.role)
  }

  /** Combined deadline: caller signal fused with the operation budget. */
  private deadlineOf(operation: BrowserOperation): { readonly signal: AbortSignal } {
    if (!Number.isFinite(operation.timeoutMs) || operation.timeoutMs <= 0) {
      throw new BrowserError('INVALID_ARGUMENT', 'operation timeoutMs must be a positive finite number', { retryable: false })
    }
    return { signal: AbortSignal.any([operation.signal, AbortSignal.timeout(operation.timeoutMs)]) }
  }

  private mapError(error: unknown, operation: BrowserOperation): BrowserError {
    if (error instanceof BrowserError) return error
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new BrowserError('TIMEOUT', 'the browser operation exceeded its budget', { retryable: false })
    }
    if (operation.signal.aborted) {
      return new BrowserError('ABORTED', 'the browser operation was aborted', { retryable: false })
    }
    return BrowserError.from(error)
  }

  /** No-op signal read so the caller-owned cancellation stays observable. */
  private touch(signal: AbortSignal): void {
    void signal.aborted
  }

  private armIdle(session: LiveSession): void {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer)
    const idleTimeoutMs = this.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    const timer = setTimeout(() => {
      session.idleTimer = null
      void this.closeSession(session)
    }, idleTimeoutMs)
    // An idle deadline must never hold the process open.
    timer.unref?.()
    session.idleTimer = timer
  }

  private async closeSession(session: LiveSession): Promise<void> {
    if (session.closed) return
    session.closed = true
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    // Drain the serialization chain, then close the backend exactly once.
    try {
      await session.queue
    } finally {
      try {
        await session.backend.close()
      } catch (error) {
        // Close failures must not resurrect the session; surfaces own their diagnostics.
        console.error(`browsers: backend close failed for session: ${BrowserError.from(error).message}`)
      }
    }
  }

  private async disposeAll(): Promise<void> {
    const owned = [...this.sessions.values()].filter(session => !session.closed)
    await Promise.all(owned.map(session => this.closeSession(session)))
    this.sessions.clear()
  }
}
