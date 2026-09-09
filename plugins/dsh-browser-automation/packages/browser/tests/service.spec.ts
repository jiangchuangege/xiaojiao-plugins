import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BrowserError, BrowserSessionService, BROWSER_SERVICE_NAME } from '../src/index.js'
import type { ActSpec, BrowserBackend, BrowserBackendSession, BrowserOperation, NavigateSpec, Observation, ScreenshotResult } from '../src/index.js'
import { reduceTargetUrl } from '../src/url.js'

const agentA = { id: 'agent-a' } as unknown as Agent
const agentB = { id: 'agent-b' } as unknown as Agent

interface FakeApproval {
  request: ReturnType<typeof vi.fn>
}

function makeApproval(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once'): FakeApproval {
  return { request: vi.fn(async () => outcome) }
}

function makeOperation(overrides: Partial<BrowserOperation> = {}): BrowserOperation {
  return {
    callId: 'call-1',
    agent: agentA,
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    toolName: 'browser_navigate',
    ...overrides,
  }
}

interface BackendCall {
  readonly kind: 'spawn' | 'navigate' | 'observe' | 'act' | 'screenshot' | 'close'
  readonly spec?: NavigateSpec | ActSpec
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    schemaVersion: 1,
    sessionId: 's1' as never,
    pageId: 'p1' as never,
    observationId: 'o1' as never,
    generation: 1,
    expiresAt: Date.now() + 60_000,
    origin: 'https://example.com',
    displayUrl: 'https://example.com/',
    title: 'Example',
    truncated: false,
    nodeCount: 1,
    elements: [{ ref: 'r1' as never, role: 'button', accessibleName: 'Go', text: 'Go', interactive: true }],
    trust: 'untrusted-web-content',
    ...overrides,
  }
}

class FakeBackendSession implements BrowserBackendSession {
  closed = false
  readonly calls: BackendCall[] = []
  navigateImpl: ((spec: NavigateSpec, signal: AbortSignal) => Promise<{ origin: string | null; displayUrl: string; generation: number }>) = async spec => ({ origin: spec.expectedOrigin, displayUrl: new URL(spec.url).pathname, generation: 2 })

  navigate(spec: NavigateSpec, signal: AbortSignal): Promise<{ origin: string | null; displayUrl: string; generation: number }> {
    this.calls.push({ kind: 'navigate', spec })
    return this.navigateImpl(spec, signal)
  }

  observe(signal: AbortSignal): Promise<Observation> {
    void signal
    this.calls.push({ kind: 'observe' })
    return Promise.resolve(makeObservation())
  }

  act(spec: ActSpec, signal: AbortSignal): Promise<{ generation: number; changed: boolean }> {
    void signal
    this.calls.push({ kind: 'act', spec })
    return Promise.resolve({ generation: 3, changed: true })
  }

  screenshot(signal: AbortSignal): Promise<ScreenshotResult> {
    void signal
    this.calls.push({ kind: 'screenshot' })
    return Promise.resolve({ image: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 100, height: 100, bytes: 3 })
  }

  close(): Promise<void> {
    this.calls.push({ kind: 'close' })
    this.closed = true
    return Promise.resolve()
  }
}

class FakeBackend implements BrowserBackend {
  readonly type: string
  readonly sessions: FakeBackendSession[] = []
  spawnCalls = 0
  constructor(type = 'fake-isolated') {
    this.type = type
  }

  spawn(): Promise<BrowserBackendSession> {
    this.spawnCalls += 1
    const session = new FakeBackendSession()
    this.sessions.push(session)
    return Promise.resolve(session)
  }
}

function makeService(config: ConstructorParameters<typeof BrowserSessionService>[1] = {}, ctx = new Context()): { ctx: Context; service: BrowserSessionService } {
  const service = new BrowserSessionService(ctx, config)
  return { ctx, service }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('backend registry', () => {
  it('registers a backend and rejects duplicates', () => {
    const { service } = makeService()
    const backend = new FakeBackend()
    const dispose = service.registerBackend(backend)
    expect(() => service.registerBackend(new FakeBackend())).toThrow(/already registered/)
    dispose()
    // after dispose, the type is free again
    expect(() => service.registerBackend(new FakeBackend())).not.toThrow()
  })

  it('fails with PROVIDER_UNAVAILABLE when no backend is registered', async () => {
    const { service } = makeService()
    await expect(service.start(agentA, {}, makeOperation())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  })

  it('requires explicit backend selection when multiple are registered', async () => {
    const { service } = makeService()
    service.registerBackend(new FakeBackend('one'))
    service.registerBackend(new FakeBackend('two'))
    await expect(service.start(agentA, {}, makeOperation())).rejects.toMatchObject({ code: 'PROVIDER_AMBIGUOUS' })
    await expect(service.start(agentA, {}, makeOperation())).rejects.toMatchObject({ code: 'PROVIDER_AMBIGUOUS' })
    const view = await service.start(agentA, { backend: 'two' }, makeOperation())
    expect(view.backendType).toBe('two')
  })

  it('fails with PROVIDER_UNAVAILABLE when the requested backend type is absent', async () => {
    const { service } = makeService()
    service.registerBackend(new FakeBackend('one'))
    await expect(service.start(agentA, { backend: 'missing' }, makeOperation())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  })
})

describe('session lifecycle', () => {
  it('starts one owner-exclusive session with a blank page and enforces the limit', async () => {
    const { service } = makeService()
    const backend = new FakeBackend()
    service.registerBackend(backend)
    const view = await service.start(agentA, {}, makeOperation())
    expect(view.sessionId).toBeTypeOf('string')
    expect(view.pageId).toBeTypeOf('string')
    await expect(service.start(agentA, {}, makeOperation())).rejects.toMatchObject({ code: 'SESSION_LIMIT_EXCEEDED' })
    await service.close(agentA, {}, makeOperation())
    await expect(service.start(agentA, {}, makeOperation())).resolves.toBeDefined()
    expect(backend.spawnCalls).toBe(2)
  })

  it('returns SESSION_NOT_FOUND for operations without a live session', async () => {
    const { service } = makeService()
    service.registerBackend(new FakeBackend())
    await expect(service.observe(agentA, {}, makeOperation())).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('treats another agent as having no session (owner identity, not string ids)', async () => {
    const { service } = makeService()
    service.registerBackend(new FakeBackend())
    await service.start(agentA, {}, makeOperation())
    await expect(service.observe(agentB, {}, makeOperation({ agent: agentB }))).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('closes idempotently and waits for quiescence', async () => {
    const { service } = makeService()
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    const first = await service.close(agentA, {}, makeOperation())
    expect(first.closed).toBe(true)
    const second = await service.close(agentA, {}, makeOperation())
    expect(second.closed).toBe(false)
    expect(backend.sessions[0]!.calls.filter(call => call.kind === 'close')).toHaveLength(1)
  })

  it('closes only the target owner with closeAllFor', async () => {
    const { service } = makeService()
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    await service.start(agentB, {}, makeOperation({ agent: agentB }))
    await service.closeAllFor(agentA)
    expect(service.liveSessionCount()).toBe(1)
    await service.closeAllFor(agentB)
    expect(service.liveSessionCount()).toBe(0)
    expect(backend.sessions.every(session => session.closed)).toBe(true)
  })

  it('closes sessions owned by a backend when its registration is disposed', async () => {
    const { service } = makeService()
    const backend = new FakeBackend('one')
    const dispose = service.registerBackend(backend)
    service.registerBackend(new FakeBackend('two'))
    await service.start(agentA, { backend: 'one' }, makeOperation())
    await dispose()
    expect(service.liveSessionCount()).toBe(0)
    expect(backend.sessions[0]!.closed).toBe(true)
  })

  it('closes idle sessions after the configured deadline', async () => {
    vi.useFakeTimers()
    const { service } = makeService({ idleTimeoutMs: 100 })
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    expect(service.liveSessionCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(service.liveSessionCount()).toBe(0)
    expect(backend.sessions[0]!.closed).toBe(true)
  })

  it('closes every live session on context dispose', async () => {
    const { ctx, service } = makeService()
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    await ctx.fiber.dispose()
    expect(service.liveSessionCount()).toBe(0)
    expect(backend.sessions[0]!.closed).toBe(true)
  })
})

describe('approval orchestration', () => {
  it('asks once with a non-sensitive reason and forwards the permit on navigate', async () => {
    const { ctx, service } = makeService()
    const approval = makeApproval()
    ctx.provide('approval', approval)
    service.registerBackend(new FakeBackend())
    await service.start(agentA, {}, makeOperation())
    const result = await service.navigate(agentA, { url: 'https://example.com/path?q=1#frag' }, makeOperation({ toolName: 'browser_navigate' }))
    expect(approval.request).toHaveBeenCalledTimes(1)
    const asked = approval.request.mock.calls[0]![0]
    expect(asked.reason).toContain('action=navigate')
    expect(asked.reason).toContain('origin=https://example.com')
    expect(asked.reason).not.toContain('q=1')
    expect(asked.toolName).toBe('browser_navigate')
    expect(asked.callId).toBe('call-1')
    expect(result.origin).toBe('https://example.com')
  })

  it('fails closed for rejected, cancelled, unavailable, and absent approval', async () => {
    for (const [outcome, code] of [['rejected', 'APPROVAL_REJECTED'], ['cancelled', 'APPROVAL_CANCELLED'], ['unavailable', 'APPROVAL_UNAVAILABLE']] as const) {
      const { ctx, service } = makeService()
      const approval = makeApproval(outcome)
      ctx.provide('approval', approval)
      service.registerBackend(new FakeBackend())
      await service.start(agentA, {}, makeOperation())
      await expect(service.navigate(agentA, { url: 'https://example.com/' }, makeOperation())).rejects.toMatchObject({ code })
    }
    const { service } = makeService()
    service.registerBackend(new FakeBackend())
    await service.start(agentA, {}, makeOperation())
    await expect(service.navigate(agentA, { url: 'https://example.com/' }, makeOperation())).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' })
  })

  it('observes without approval and reuses the observation for action targets', async () => {
    const { ctx, service } = makeService()
    const approval = makeApproval()
    ctx.provide('approval', approval)
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    await service.observe(agentA, {}, makeOperation({ toolName: 'browser_snapshot' }))
    expect(approval.request).not.toHaveBeenCalled()
    const ref = 'r1' as never
    await service.act(agentA, { action: { kind: 'click', ref } }, makeOperation({ toolName: 'browser_click' }))
    const asked = approval.request.mock.calls[0]![0]
    expect(asked.reason).toContain('target=Go')
    const actSpec = backend.sessions[0]!.calls.find(call => call.kind === 'act')!.spec as ActSpec
    expect(actSpec.permit).not.toBeNull()
    expect(actSpec.permit!.nonce).toBeTypeOf('string')
    expect(actSpec.permit!.expiresAt).toBeGreaterThan(Date.now())
  })

  it('scrolls without approval and passes a null permit', async () => {
    const { ctx, service } = makeService()
    const approval = makeApproval()
    ctx.provide('approval', approval)
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    await service.act(agentA, { action: { kind: 'scroll', target: { page: true }, deltaY: 100 } }, makeOperation({ toolName: 'browser_scroll' }))
    expect(approval.request).not.toHaveBeenCalled()
    const actSpec = backend.sessions[0]!.calls.find(call => call.kind === 'act')!.spec as ActSpec
    expect(actSpec.permit).toBeNull()
  })

  it('asks before screenshot and returns in-memory bytes', async () => {
    const { ctx, service } = makeService()
    const approval = makeApproval()
    ctx.provide('approval', approval)
    service.registerBackend(new FakeBackend())
    await service.start(agentA, {}, makeOperation())
    const shot = await service.screenshot(agentA, {}, makeOperation({ toolName: 'browser_screenshot' }))
    expect(approval.request).toHaveBeenCalledTimes(1)
    expect(shot.bytes).toBe(3)
    expect(shot.mediaType).toBe('image/png')
  })
})

describe('budgets and error mapping', () => {
  it('maps an exceeded operation budget to TIMEOUT', async () => {
    const { ctx, service } = makeService()
    ctx.provide('approval', makeApproval())
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    backend.sessions[0]!.navigateImpl = (_spec, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason))
    })
    await expect(service.navigate(agentA, { url: 'https://example.com/' }, makeOperation({ timeoutMs: 30 }))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('maps caller aborts to ABORTED', async () => {
    const { ctx, service } = makeService()
    ctx.provide('approval', makeApproval())
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    backend.sessions[0]!.navigateImpl = (_spec, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason))
    })
    const controller = new AbortController()
    const pending = service.navigate(agentA, { url: 'https://example.com/' }, makeOperation({ signal: controller.signal }))
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('normalizes unknown backend failures to UNKNOWN', async () => {
    const { ctx, service } = makeService()
    ctx.provide('approval', makeApproval())
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    backend.sessions[0]!.navigateImpl = () => Promise.reject(new Error('boom'))
    await expect(service.navigate(agentA, { url: 'https://example.com/' }, makeOperation())).rejects.toMatchObject({ code: 'UNKNOWN' })
  })

  it('passes BrowserError through unchanged', async () => {
    const { ctx, service } = makeService()
    ctx.provide('approval', makeApproval())
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    backend.sessions[0]!.navigateImpl = () => Promise.reject(new BrowserError('NAVIGATION_BLOCKED', 'cross-origin redirect blocked'))
    await expect(service.navigate(agentA, { url: 'https://example.com/' }, makeOperation())).rejects.toMatchObject({ code: 'NAVIGATION_BLOCKED' })
  })

  it('serializes operations per session in submission order', async () => {
    const { service } = makeService()
    const backend = new FakeBackend()
    service.registerBackend(backend)
    await service.start(agentA, {}, makeOperation())
    const order: string[] = []
    backend.sessions[0]!.observe = async () => {
      order.push('first-start')
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push('first-end')
      return makeObservation()
    }
    const second = service.observe(agentA, {}, makeOperation()).then(() => {
      order.push('second')
    })
    await second
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })
})

describe('url reduction', () => {
  it('accepts exact http/https URLs and strips query/fragment from display form', () => {
    expect(reduceTargetUrl('https://example.com/a?q=1#f')).toEqual({ origin: 'https://example.com', displayUrl: 'https://example.com/a' })
    expect(reduceTargetUrl('about:blank')).toEqual({ origin: null, displayUrl: 'about:blank' })
  })

  it('rejects userinfo, foreign schemes, and hostless URLs', () => {
    expect(() => reduceTargetUrl('https://user:pw@example.com/')).toThrowError(BrowserError)
    expect(() => reduceTargetUrl('file:///etc/passwd')).toThrowError(BrowserError)
    expect(() => reduceTargetUrl('javascript:alert(1)')).toThrowError(BrowserError)
    expect(() => reduceTargetUrl('https://')).toThrowError(BrowserError)
  })
})

describe('invariant companion', () => {
  it('mounts the service under its own name', async () => {
    const { ctx } = makeService()
    const { assertServiceMounted } = await import('../src/invariant.js')
    expect(() => assertServiceMounted(ctx)).not.toThrow()
    expect(BROWSER_SERVICE_NAME).toBe('browsers')
  })
})
