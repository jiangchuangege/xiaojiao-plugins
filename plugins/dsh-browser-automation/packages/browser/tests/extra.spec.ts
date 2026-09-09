import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BrowserError, BrowserSessionService, BROWSER_SERVICE_NAME, isBrowserError, BrowserSessionId, BrowserPageId, ObservationId, ElementRef } from '../src/index.js'
import type { BrowserBackend, BrowserBackendSession, Observation, ScreenshotResult, ActSpec, NavigateSpec } from '../src/index.js'
import { assertServiceMounted } from '../src/invariant.js'
import { reduceTargetUrl } from '../src/url.js'

const agent = { id: 'agent-a' } as unknown as Agent

function makeOperation(overrides: { timeoutMs?: number } = {}) {
  return {
    callId: 'call-1',
    agent,
    signal: new AbortController().signal,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    toolName: 'browser_start',
  }
}

class ThrowingCloseBackend implements BrowserBackend {
  readonly type = 'throwing-close'

  spawn(): Promise<BrowserBackendSession> {
    return Promise.resolve({
      navigate: () => Promise.reject(new Error('unused')),
      observe: () => Promise.reject(new Error('unused')),
      act: () => Promise.reject(new Error('unused')),
      screenshot: () => Promise.reject(new Error('unused')),
      wait: () => Promise.resolve(),
      close: () => Promise.reject(new BrowserError('BROWSER_CRASHED', 'close failed')),
    })
  }
}

describe('service configuration validation', () => {
  it('rejects non-positive or non-finite idleTimeoutMs', () => {
    expect(() => new BrowserSessionService(new Context(), { idleTimeoutMs: 0 })).toThrow(/idleTimeoutMs must be a positive finite/)
    expect(() => new BrowserSessionService(new Context(), { idleTimeoutMs: Number.NaN })).toThrow(/idleTimeoutMs/)
  })

  it('rejects non-positive or non-integer maxSessionsPerAgent', () => {
    expect(() => new BrowserSessionService(new Context(), { maxSessionsPerAgent: 0 })).toThrow(/maxSessionsPerAgent/)
    expect(() => new BrowserSessionService(new Context(), { maxSessionsPerAgent: 1.5 })).toThrow(/maxSessionsPerAgent/)
  })
})

describe('backend registry disposal', () => {
  it('makes a second dispose of the same registration a no-op', async () => {
    const ctx = new Context()
    const service = new BrowserSessionService(ctx)
    const backend = new ThrowingCloseBackend()
    const dispose = service.registerBackend(backend)
    await dispose()
    // Second call: backend already removed, must not throw or double-close.
    expect(() => dispose()).not.toThrow()
    expect(service.liveSessionCount()).toBe(0)
  })

  it('explicitly selects a registered backend by type', async () => {
    const service = new BrowserSessionService(new Context())
    const backend = new ThrowingCloseBackend()
    service.registerBackend(backend)
    const view = await service.start(agent, { backend: 'throwing-close' }, makeOperation())
    expect(view.backendType).toBe('throwing-close')
  })
})

describe('close error containment', () => {
  it('contains backend close failures and still clears the session', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const service = new BrowserSessionService(new Context())
      const backend = new ThrowingCloseBackend()
      service.registerBackend(backend)
      await service.start(agent, {}, makeOperation())
      await service.close(agent, {}, makeOperation())
      expect(service.liveSessionCount()).toBe(0)
      expect(consoleSpy).toHaveBeenCalledTimes(1)
      expect(String(consoleSpy.mock.calls[0]![0])).toContain('backend close failed')
    } finally {
      consoleSpy.mockRestore()
    }
  })
})

describe('service approval target labels', () => {
  it('derives the approval target from text when the accessible name is empty', async () => {
    const ctx = new Context()
    const approval = { request: vi.fn(async () => 'allowed-once') }
    ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('approval', approval)
    const service = new BrowserSessionService(ctx)
    const backend: BrowserBackend = {
      type: 'labeling',
      spawn: () => Promise.resolve({
        navigate: async () => ({ origin: 'https://example.com', displayUrl: '/', generation: 1 }),
        observe: async () => ({
          schemaVersion: 1 as const,
          sessionId: 's' as never,
          pageId: 'p' as never,
          observationId: 'o' as never,
          generation: 1,
          expiresAt: Date.now() + 60_000,
          origin: 'https://example.com',
          displayUrl: 'https://example.com/',
          title: 'T',
          truncated: false,
          nodeCount: 1,
          elements: [{ ref: 'r1' as never, role: 'button', accessibleName: '', text: 'PushMe', interactive: true }],
          trust: 'untrusted-web-content' as const,
        }),
        act: () => Promise.resolve({ generation: 2, changed: true }),
        screenshot: () => Promise.reject(new Error('unused')),
        wait: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    }
    service.registerBackend(backend)
    await service.start(agent, {}, makeOperation())
    await service.observe(agent, {}, makeOperation())
    await service.act(agent, { action: { kind: 'click', ref: 'r1' as never } }, makeOperation())
    expect(approval.request.mock.calls[0]![0].reason).toContain('target=PushMe')
  })

  it('omits the target from the approval reason when the ref is unknown', async () => {
    const ctx = new Context()
    const approval = { request: vi.fn(async () => 'allowed-once') }
    ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('approval', approval)
    const service = new BrowserSessionService(ctx)
    service.registerBackend(new ThrowingCloseBackend())
    await service.start(agent, {}, makeOperation())
    // The fake backend rejects the action; only the approval wiring matters.
    await service.act(agent, { action: { kind: 'click', ref: 'unknown-ref' as never } }, makeOperation()).catch(() => undefined)
    const asked = approval.request.mock.calls[0]![0]
    expect(asked.reason).not.toContain('target=')
  })

  it('derives the approval target from the role when name and text are empty', async () => {
    const ctx = new Context()
    const approval = { request: vi.fn(async () => 'allowed-once') }
    ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('approval', approval)
    const service = new BrowserSessionService(ctx)
    const backend: BrowserBackend = {
      type: 'role-label',
      spawn: () => Promise.resolve({
        navigate: async () => ({ origin: 'https://example.com', displayUrl: '/', generation: 1 }),
        observe: async () => ({
          schemaVersion: 1 as const,
          sessionId: 's' as never,
          pageId: 'p' as never,
          observationId: 'o' as never,
          generation: 1,
          expiresAt: Date.now() + 60_000,
          origin: 'https://example.com',
          displayUrl: 'https://example.com/',
          title: 'T',
          truncated: false,
          nodeCount: 1,
          elements: [{ ref: 'r1' as never, role: 'button', accessibleName: '', text: '', interactive: true }],
          trust: 'untrusted-web-content' as const,
        }),
        act: () => Promise.reject(new Error('unused')),
        screenshot: () => Promise.reject(new Error('unused')),
        wait: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    }
    service.registerBackend(backend)
    await service.start(agent, {}, makeOperation())
    await service.observe(agent, {}, makeOperation())
    await service.act(agent, { action: { kind: 'click', ref: 'r1' as never } }, makeOperation()).catch(() => undefined)
    expect(approval.request.mock.calls[0]![0].reason).toContain('target=button')
  })

  it('omits the target when the observation has no matching ref', async () => {
    const ctx = new Context()
    const approval = { request: vi.fn(async () => 'allowed-once') }
    ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('approval', approval)
    const service = new BrowserSessionService(ctx)
    await service.start(agent, {}, makeOperation()).catch(() => undefined)
    const backend: BrowserBackend = {
      type: 'labeled',
      spawn: () => Promise.resolve({
        navigate: async () => ({ origin: 'https://example.com', displayUrl: '/', generation: 1 }),
        observe: async () => ({
          schemaVersion: 1 as const,
          sessionId: 's' as never,
          pageId: 'p' as never,
          observationId: 'o' as never,
          generation: 1,
          expiresAt: Date.now() + 60_000,
          origin: 'https://example.com',
          displayUrl: 'https://example.com/',
          title: 'T',
          truncated: false,
          nodeCount: 1,
          elements: [{ ref: 'r1' as never, role: 'button', accessibleName: 'Go', text: '', interactive: true }],
          trust: 'untrusted-web-content' as const,
        }),
        act: () => Promise.reject(new Error('unused')),
        screenshot: () => Promise.reject(new Error('unused')),
        wait: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    }
    service.registerBackend(backend)
    await service.start(agent, {}, makeOperation())
    await service.observe(agent, {}, makeOperation())
    await service.act(agent, { action: { kind: 'click', ref: 'missing-ref' as never } }, makeOperation()).catch(() => undefined)
    expect(approval.request.mock.calls[0]![0].reason).not.toContain('target=')
  })

  it('closes already-closed sessions through the backend disposer without error', async () => {
    const service = new BrowserSessionService(new Context())
    const backend = new ThrowingCloseBackend()
    const dispose = service.registerBackend(backend)
    await service.start(agent, {}, makeOperation())
    await service.close(agent, {}, makeOperation())
    // The disposer walks owned sessions including closed ones; closeSession
    // must no-op for them.
    await dispose()
    expect(service.liveSessionCount()).toBe(0)
  })
})

describe('errors', () => {
  it('normalizes non-Error thrown values', () => {
    expect(BrowserError.from('boom').code).toBe('UNKNOWN')
    expect(BrowserError.from(42).message).toContain('42')
  })

  it('matches isBrowserError by optional code', () => {
    const err = new BrowserError('ABORTED', 'aborted')
    expect(isBrowserError(err)).toBe(true)
    expect(isBrowserError(err, 'ABORTED')).toBe(true)
    expect(isBrowserError(err, 'TIMEOUT')).toBe(false)
    expect(isBrowserError(new Error('x'))).toBe(false)
  })
})

describe('invariant', () => {
  it('fails when the mounted service is not this package\'s', () => {
    const ctx = new Context()
    ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide(BROWSER_SERVICE_NAME, {})
    expect(() => assertServiceMounted(ctx)).toThrow(/is not the dsh-browser service/)
  })
})

describe('url reduction extras', () => {
  it('rejects malformed and foreign-scheme inputs', () => {
    expect(() => reduceTargetUrl('https://')).toThrowError(BrowserError)
    expect(() => reduceTargetUrl('ftp://example.com/')).toThrowError(BrowserError)
  })

  it('strips nothing from a clean path', () => {
    expect(reduceTargetUrl('https://example.com/clean/path')).toEqual({ origin: 'https://example.com', displayUrl: 'https://example.com/clean/path' })
  })
})

describe('brand factories and service extras', () => {
  it('mints every branded id family', () => {
    expect(typeof BrowserSessionId('s')).toBe('string')
    expect(typeof BrowserPageId('p')).toBe('string')
    expect(typeof ObservationId('o')).toBe('string')
    expect(typeof ElementRef('r')).toBe('string')
  })

  it('maps backend spawn failures to UNKNOWN', async () => {
    const service = new BrowserSessionService(new Context())
    const backend: BrowserBackend = {
      type: 'broken',
      spawn: () => Promise.reject(new Error('spawn boom')),
    }
    service.registerBackend(backend)
    await expect(service.start(agent, {}, makeOperation())).rejects.toMatchObject({ code: 'UNKNOWN' })
  })

  it('waits through the service', async () => {
    const service = new BrowserSessionService(new Context())
    const calls: string[] = []
    const backend: BrowserBackend = {
      type: 'waiting',
      spawn: () => Promise.resolve({
        navigate: () => Promise.reject(new Error('unused')),
        observe: () => Promise.reject(new Error('unused')),
        act: () => Promise.reject(new Error('unused')),
        screenshot: () => Promise.reject(new Error('unused')),
        wait: async (ms: number) => {
          calls.push(`wait:${ms}`)
        },
        close: () => Promise.resolve(),
      }),
    }
    service.registerBackend(backend)
    await service.start(agent, {}, makeOperation())
    await service.wait(agent, { ms: 25 }, makeOperation())
    expect(calls).toEqual(['wait:25'])
  })

  it('rejects invalid operation budgets before executing', async () => {
    const ctx = new Context()
    ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('approval', { request: async () => 'allowed-once' })
    const service = new BrowserSessionService(ctx)
    const backend = new ThrowingCloseBackend()
    service.registerBackend(backend)
    await service.start(agent, {}, makeOperation())
    await expect(service.navigate(agent, { url: 'https://example.com/' }, makeOperation({ timeoutMs: 0 }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})
