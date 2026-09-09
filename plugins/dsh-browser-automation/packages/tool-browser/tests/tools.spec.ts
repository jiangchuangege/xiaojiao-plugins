import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRegistry, validateArgs } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BrowserSessionService, BrowserError, BrowserSessionId, BrowserPageId, ObservationId,
  ElementRef,
} from '@dsh-browser-automation/dsh-browser'
import type { BrowserBackend, BrowserBackendSession, Observation, ScreenshotResult, ActSpec, NavigateSpec } from '@dsh-browser-automation/dsh-browser'
import { TOOL_NAMES, TOOL_SPECS, rejectUnknownKeys } from '../src/manifest.js'
import { assertToolSet } from '../src/invariant.js'
import { apply as applyToolBrowser, Config as ToolBrowserConfig, name as pluginName, inject as pluginInject } from '../src/index.js'

const agent = {
  id: 'agent-a',
  options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
} as unknown as Agent

function makeApproval(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once') {
  return { request: vi.fn(async () => outcome) }
}

/** Provide an untyped service key (tests only; production code uses declared injections). */
function provide(ctx: Context, key: string, value: unknown): void {
  (ctx as unknown as { provide: (name: string, value: unknown) => void }).provide(key, value)
}

function makeOperation(signal?: AbortSignal): Partial<ToolRunContext> {
  return {
    callId: 'call-1' as never,
    agent,
    signal: signal ?? new AbortController().signal,
    arguments: {},
    name: 'browser_start',
  }
}

interface BackendCall {
  readonly kind: 'spawn' | 'navigate' | 'observe' | 'act' | 'screenshot' | 'close'
  readonly spec?: NavigateSpec | ActSpec
}

function makeObservation(): Observation {
  return {
    schemaVersion: 1,
    sessionId: BrowserSessionId('s1'),
    pageId: BrowserPageId('p1'),
    observationId: ObservationId('o1'),
    generation: 1,
    expiresAt: Date.now() + 60_000,
    origin: 'https://example.com',
    displayUrl: 'https://example.com/',
    title: 'Example',
    truncated: false,
    nodeCount: 1,
    elements: [{ ref: ElementRef('o1.r1'), role: 'button', accessibleName: 'Go', text: 'Go', interactive: true }],
    trust: 'untrusted-web-content',
  }
}

class FakeBackendSession implements BrowserBackendSession {
  readonly calls: BackendCall[] = []
  closed = false
  navigateImpl: ((spec: NavigateSpec, signal: AbortSignal) => Promise<{ origin: string | null; displayUrl: string; generation: number }>) =
    async spec => ({ origin: spec.expectedOrigin, displayUrl: new URL(spec.url).pathname, generation: 2 })

  navigate(spec: NavigateSpec, signal: AbortSignal): Promise<{ origin: string | null; displayUrl: string; generation: number }> {
    this.calls.push({ kind: 'navigate', spec })
    return this.navigateImpl(spec, signal)
  }

  observe(_signal: AbortSignal): Promise<Observation> {
    this.calls.push({ kind: 'observe' })
    return Promise.resolve(makeObservation())
  }

  act(spec: ActSpec, _signal: AbortSignal): Promise<{ generation: number; changed: boolean }> {
    this.calls.push({ kind: 'act', spec })
    return Promise.resolve({ generation: 3, changed: true })
  }

  screenshot(_signal: AbortSignal): Promise<ScreenshotResult> {
    this.calls.push({ kind: 'screenshot' })
    return Promise.resolve({ image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png', width: 100, height: 100, bytes: 4 })
  }

  wait(ms: number, signal: AbortSignal): Promise<void> {
    this.calls.push({ kind: 'observe' })
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      const onAbort = (): void => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, Math.min(Math.max(ms, 0), 50))
    })
  }

  close(): Promise<void> {
    this.calls.push({ kind: 'close' })
    this.closed = true
    return Promise.resolve()
  }
}

class FakeBackend implements BrowserBackend {
  readonly type = 'fake-isolated'
  readonly sessions: FakeBackendSession[] = []

  spawn(): Promise<BrowserBackendSession> {
    const session = new FakeBackendSession()
    this.sessions.push(session)
    return Promise.resolve(session)
  }
}

interface Mounted {
  readonly ctx: Context
  readonly service: BrowserSessionService
  readonly backend: FakeBackend
  readonly approval: ReturnType<typeof makeApproval>
}

async function mountConsumer(options: { llm?: unknown; attachments?: unknown } = {}): Promise<Mounted> {
  const ctx = new Context()
  const approval = makeApproval()
  provide(ctx, 'approval', approval)
  // Constructing the service registers it under 'browsers'.
  const service = new BrowserSessionService(ctx, { idleTimeoutMs: 60_000 })
  const backend = new FakeBackend()
  service.registerBackend(backend)
  if (options.llm !== undefined) provide(ctx, 'llm', options.llm)
  if (options.attachments !== undefined) provide(ctx, 'attachments', options.attachments)
  // ToolRegistry injects systemPrompt; a stub satisfies it in tests.
  provide(ctx, 'systemPrompt', {
    context: () => undefined,
    variable: () => undefined,
    section: () => undefined,
    tools: () => undefined,
  })
  await ctx.plugin(ToolRegistry, {})
  await ctx.plugin({ name: pluginName, inject: pluginInject, Config: ToolBrowserConfig, apply: applyToolBrowser }, { screenshot: true })
  return { ctx, service, backend, approval }
}

function tool(ctx: Context, name: string) {
  return ctx.tools.get(name)
}

describe('manifest invariants', () => {
  it('declares ten uniquely named tools with consistent key sets', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length)
    expect(TOOL_NAMES).toHaveLength(10)
    for (const spec of TOOL_SPECS) {
      expect(spec.paramKeys).toEqual(Object.keys(spec.parameters))
      expect(spec.timeoutMs).toBeGreaterThan(0)
      expect(spec.description.length).toBeGreaterThan(0)
    }
  })

  it('closes every nested output object', () => {
    const walk = (node: unknown): void => {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return
      const record = node as Record<string, unknown>
      if (record.type === 'object') {
        expect(record.additionalProperties).toBe(false)
      }
      for (const value of Object.values(record)) walk(value)
    }
    for (const spec of TOOL_SPECS) walk(spec.outputSchema)
  })

  it('validates the press key allowlist through the compiled schema', () => {
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_press')!
    expect(validateArgs(spec.parameters, { ref: 'o1.r1', key: 'Enter' })).toEqual([])
    expect(validateArgs(spec.parameters, { ref: 'o1.r1', key: 'F5' }).length).toBeGreaterThan(0)
    expect(validateArgs(spec.parameters, { ref: 'o1.r1' }).length).toBeGreaterThan(0)
  })

  it('rejects unknown root parameters in executors', () => {
    expect(() => rejectUnknownKeys({ url: 'https://example.com', extra: 1 }, ['url'], 'browser_navigate')).toThrowError(BrowserError)
    expect(() => rejectUnknownKeys({ url: 'https://example.com' }, ['url'], 'browser_navigate')).not.toThrow()
  })
})

describe('registration', () => {
  it('registers nine tools without llm/attachments and all ten with them', async () => {
    const bare = await mountConsumer()
    const bareNames = bare.ctx.tools.schemas().map(schema => schema.name)
    expect(bareNames).not.toContain('browser_screenshot')
    expect(bareNames).toHaveLength(9)

    const full = await mountConsumer({
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
      attachments: {
        saveImage: async () => ({ attachmentId: 'att-1', mediaType: 'image/png', width: 1, height: 1, bytes: 1 }),
      },
    })
    const fullNames = full.ctx.tools.schemas().map(schema => schema.name)
    expect(fullNames).toHaveLength(10)
    expect(() => assertToolSet(fullNames)).not.toThrow()
  })
})

describe('executors', () => {
  it('starts one session per agent and enforces the limit', async () => {
    const { ctx, backend } = await mountConsumer()
    const start = tool(ctx, 'browser_start')!
    await start.execute({}, makeOperation() as ToolRunContext)
    expect(backend.sessions).toHaveLength(1)
    await expect(start.execute({}, makeOperation() as ToolRunContext)).rejects.toMatchObject({ code: 'SESSION_LIMIT_EXCEEDED' })
  })

  it('navigates with a one-shot approval and forwards the permit', async () => {
    const { ctx, backend, approval } = await mountConsumer()
    const navigate = tool(ctx, 'browser_navigate')!
    await tool(ctx, 'browser_start')!.execute({}, makeOperation() as ToolRunContext)
    await navigate.execute({ url: 'https://example.com/path' }, makeOperation() as ToolRunContext)
    expect(approval.request).toHaveBeenCalledTimes(1)
    const asked = approval.request.mock.calls[0]![0]
    expect(asked.reason).toContain('action=navigate')
    expect(asked.reason).toContain('origin=https://example.com')
    const call = backend.sessions[0]!.calls.find(c => c.kind === 'navigate')!
    expect((call.spec as NavigateSpec).permit).not.toBeNull()
  })

  it('snapshots without approval and returns the observation', async () => {
    const { ctx, approval } = await mountConsumer()
    const snapshot = tool(ctx, 'browser_snapshot')!
    await tool(ctx, 'browser_start')!.execute({}, makeOperation() as ToolRunContext)
    const value = await snapshot.execute({}, makeOperation() as ToolRunContext)
    expect(approval.request).not.toHaveBeenCalled()
    expect((value as Observation).trust).toBe('untrusted-web-content')
    expect((value as Observation).elements).toHaveLength(1)
  })

  it('clicks with an approved permit bound to the ref', async () => {
    const { ctx, backend, approval } = await mountConsumer()
    const snapshot = tool(ctx, 'browser_snapshot')!
    const click = tool(ctx, 'browser_click')!
    await tool(ctx, 'browser_start')!.execute({}, makeOperation() as ToolRunContext)
    const observation = await snapshot.execute({}, makeOperation() as ToolRunContext) as Observation
    await click.execute({ ref: observation.elements[0]!.ref }, makeOperation() as ToolRunContext)
    expect(approval.request).toHaveBeenCalledTimes(1)
    const act = backend.sessions[0]!.calls.find(c => c.kind === 'act')!
    expect((act.spec as ActSpec).permit).not.toBeNull()
  })

  it('rejects scroll targets that are neither/both page and element', async () => {
    const { ctx } = await mountConsumer()
    const scroll = tool(ctx, 'browser_scroll')!
    await tool(ctx, 'browser_start')!.execute({}, makeOperation() as ToolRunContext)
    await expect(scroll.execute({ target: {}, deltaY: 10 }, makeOperation() as ToolRunContext)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(scroll.execute({ target: { page: true, element: 'o1.r1' }, deltaY: 10 }, makeOperation() as ToolRunContext)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(scroll.execute({ target: { page: true }, deltaY: 10 }, makeOperation() as ToolRunContext)).resolves.toBeDefined()
  })

  it('gates screenshots on the model route and commits through the attachment store', async () => {
    const textOnly = await mountConsumer({
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
      attachments: { saveImage: vi.fn() },
    })
    await tool(textOnly.ctx, 'browser_start')!.execute({}, makeOperation() as ToolRunContext)
    await expect(tool(textOnly.ctx, 'browser_screenshot')!.execute({}, makeOperation() as ToolRunContext)).rejects.toMatchObject({ code: 'ROUTE_NOT_IMAGE_CAPABLE' })
    expect(textOnly.ctx.get('attachments') as { saveImage: unknown }).toBeDefined()

    const saveImage = vi.fn(async (input: { data: Uint8Array }) => ({ attachmentId: 'att-1', mediaType: 'image/png', width: 100, height: 100, bytes: input.data.byteLength }))
    const imageCapable = await mountConsumer({
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
      attachments: { saveImage, imageLimits: { maxImageBytes: 10_000 } },
    })
    await tool(imageCapable.ctx, 'browser_start')!.execute({}, makeOperation() as ToolRunContext)
    const value = await tool(imageCapable.ctx, 'browser_screenshot')!.execute({}, makeOperation() as ToolRunContext)
    expect(saveImage).toHaveBeenCalledTimes(1)
    expect((value as { attachmentId: string }).attachmentId).toBe('att-1')
  })

  it('closes idempotently', async () => {
    const { ctx, backend } = await mountConsumer()
    const close = tool(ctx, 'browser_close')!
    await tool(ctx, 'browser_start')!.execute({}, makeOperation() as ToolRunContext)
    await expect(close.execute({}, makeOperation() as ToolRunContext)).resolves.toEqual({ closed: true })
    await expect(close.execute({}, makeOperation() as ToolRunContext)).resolves.toEqual({ closed: false })
    expect(backend.sessions[0]!.closed).toBe(true)
  })

  it('aborts waits through the caller signal', async () => {
    const { ctx } = await mountConsumer()
    const wait = tool(ctx, 'browser_wait')!
    await tool(ctx, 'browser_start')!.execute({}, makeOperation() as ToolRunContext)
    const controller = new AbortController()
    const pending = wait.execute({ ms: 1_000 }, makeOperation(controller.signal) as ToolRunContext)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('renders', () => {
  it('renders snapshots as untrusted content without inventing facts', () => {
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_snapshot')!
    const blocks = spec.render({}, makeObservation())
    expect(blocks).toHaveLength(1)
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('Untrusted web content')
    expect(text).toContain('Example')
    expect(text).toContain('[o1.r1] button "Go"')
  })

  it('renders screenshots as the durable image block', () => {
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_screenshot')!
    const blocks = spec.render({}, { attachmentId: 'att-1', mediaType: 'image/png', width: 100, height: 100, bytes: 4 })
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as { type: string }).type).toBe('image')
    expect((blocks[0] as { attachment: { attachmentId: string } }).attachment.attachmentId).toBe('att-1')
  })
})
