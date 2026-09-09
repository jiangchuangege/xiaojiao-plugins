/**
 * Coverage for the consumer's fallback renders, manifest executor branches,
 * config-driven screenshot registration, disposal (HMR safety), the invariant,
 * and a keyless schema snapshot of the model-visible tool contract.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BrowserError, BrowserSessionService, ElementRef } from '@dsh-browser-automation/dsh-browser'
import type { BrowserBackend, BrowserBackendSession, Observation, ScreenshotResult, ActSpec, NavigateSpec } from '@dsh-browser-automation/dsh-browser'
import { TOOL_SPECS, approvalOf } from '../src/manifest.js'
import { assertToolSet } from '../src/invariant.js'
import { apply, Config, inject, name } from '../src/index.js'
import {
  renderAction, renderClose, renderNavigate, renderScreenshot, renderSnapshot, renderStart, renderWait,
} from '../src/render.js'

function provide(ctx: Context, key: string, value: unknown): void {
  (ctx as unknown as { provide: (name: string, value: unknown) => void }).provide(key, value)
}

const agent = {
  id: 'agent-a',
  options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
} as unknown as Agent

function makeExec(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    callId: 'call-1' as never,
    agent,
    signal: new AbortController().signal,
    arguments: {},
    name: 'browser_start',
    ...overrides,
  } as ToolRunContext
}

function makeObservation(): Observation {
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
    elements: [{ ref: ElementRef('o1.r1'), role: 'button', accessibleName: '', text: '', interactive: true }],
    trust: 'untrusted-web-content',
  }
}

class FakeBackendSession implements BrowserBackendSession {
  navigate(spec: NavigateSpec, _signal: AbortSignal): Promise<{ origin: string | null; displayUrl: string; generation: number }> {
    return Promise.resolve({ origin: spec.expectedOrigin, displayUrl: new URL(spec.url).pathname, generation: 2 })
  }

  observe(_signal: AbortSignal): Promise<Observation> {
    return Promise.resolve(makeObservation())
  }

  act(_spec: ActSpec, _signal: AbortSignal): Promise<{ generation: number; changed: boolean }> {
    return Promise.resolve({ generation: 3, changed: true })
  }

  screenshot(_signal: AbortSignal): Promise<ScreenshotResult> {
    return Promise.resolve({ image: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1, bytes: 1 })
  }

  wait(_ms: number, _signal: AbortSignal): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

class FakeBackend implements BrowserBackend {
  readonly type = 'fake-isolated'

  spawn(): Promise<BrowserBackendSession> {
    return Promise.resolve(new FakeBackendSession())
  }
}

interface Mounted {
  readonly ctx: Context
  readonly service: BrowserSessionService
}

async function mount(overrides: { llm?: unknown; attachments?: unknown; screenshot?: boolean } = {}): Promise<Mounted> {
  const ctx = new Context()
  provide(ctx, 'approval', { request: vi.fn(async () => 'allowed-once') })
  const service = new BrowserSessionService(ctx, { idleTimeoutMs: 60_000 })
  service.registerBackend(new FakeBackend())
  if (overrides.llm !== undefined) provide(ctx, 'llm', overrides.llm)
  if (overrides.attachments !== undefined) provide(ctx, 'attachments', overrides.attachments)
  provide(ctx, 'systemPrompt', { context: () => undefined, variable: () => undefined, section: () => undefined, tools: () => undefined })
  await ctx.plugin(ToolRegistry, {})
  await ctx.plugin({ name, inject, Config, apply }, { screenshot: overrides.screenshot ?? true })
  return { ctx, service }
}

function envFor(name: string) {
  return {
    tool: { name, timeoutMs: 60_000 },
    browsers: undefined as unknown as BrowserSessionService,
    llm: undefined,
    attachments: undefined,
  }
}

describe('fallback renders', () => {
  it('covers every fallback branch', () => {
    const snapshot = makeObservation()
    expect((renderSnapshot({}, snapshot)[0] as { text: string }).text).toContain('[o1.r1] button')
    const blank = makeObservation()
    blank.origin = null
    expect((renderSnapshot({}, blank)[0] as { text: string }).text).toContain('from about:blank')
    const named = makeObservation()
    named.elements = [{ ref: ElementRef('o1.r2'), role: 'link', accessibleName: 'Named', text: '', interactive: true }]
    expect((renderSnapshot({}, named)[0] as { text: string }).text).toContain('link "Named"')
    const textNamed = makeObservation()
    textNamed.elements = [{ ref: ElementRef('o1.r3'), role: 'button', accessibleName: '', text: 'BodyText', interactive: true }]
    expect((renderSnapshot({}, textNamed)[0] as { text: string }).text).toContain('button "BodyText"')
    expect(renderWait({}, { waitedMs: 5 })).toEqual([{ type: 'text', text: 'Waited 5ms' }])
    expect(renderClose({}, { closed: true })).toEqual([{ type: 'text', text: 'Browser session closed.' }])

    expect(renderStart({}, {})).toEqual([{ type: 'text', text: 'Started browser session (backend: unknown)' }])
    expect(renderNavigate({}, {})).toEqual([{ type: 'text', text: 'Navigated to the target' }])
    expect(renderSnapshot({}, undefined)).toEqual([{ type: 'text', text: 'Browser snapshot unavailable.' }])
    const empty = makeObservation()
    empty.elements = []
    expect((renderSnapshot({}, empty)[0] as { text: string }).text).toContain('No interactive elements.')
    empty.truncated = true
    expect((renderSnapshot({}, empty)[0] as { text: string }).text).toContain('Truncated')
    expect(renderAction({}, {})).toEqual([{ type: 'text', text: 'Browser action finished without document changes (generation ?)' }])
    expect(renderAction({}, { generation: 2, changed: true })).toEqual([{ type: 'text', text: 'Browser action completed (generation 2)' }])
    expect(renderWait({}, {})).toEqual([{ type: 'text', text: 'Waited 0ms' }])
    expect(renderClose({}, {})).toEqual([{ type: 'text', text: 'No live browser session.' }])
    expect(renderScreenshot({}, { attachmentId: 'a', mediaType: 'image/png', width: 1, height: 1, bytes: 1 })).toHaveLength(1)
  })
})

describe('invariant', () => {
  it('fails on a drifted registered set', () => {
    expect(() => assertToolSet(['browser_click'])).toThrow(/registered set drifted/)
    expect(() => assertToolSet([...TOOL_SPECS.map(spec => spec.name), 'browser_extra'])).toThrow(/extra/)
  })
})

describe('manifest executor branches', () => {
  it('rejects unknown keys in executors', () => {
    const click = TOOL_SPECS.find(spec => spec.name === 'browser_click')!
    return expect(click.execute({ ref: 'o1.r1', surprise: 1 }, makeExec({ name: 'browser_click' }), { ...envFor('browser_click'), browsers: new BrowserSessionService(new Context()) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('starts with an explicit backend selection', async () => {
    const { ctx } = await mount()
    const service = ctx.browsers
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_start')!
    const value = await spec.execute({ backend: 'fake-isolated' }, makeExec({ name: 'browser_start' }), { ...envFor('browser_start'), browsers: service })
    expect((value as { backendType: string }).backendType).toBe('fake-isolated')
  })

  it('press rejects keys outside the allowlist at the executor level', async () => {
    const { ctx } = await mount()
    await ctx.browsers.start(agent, {}, { callId: 'c' as never, agent, signal: new AbortController().signal, timeoutMs: 5_000, toolName: 'browser_start' })
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_press')!
    await expect(spec.execute({ ref: 'o1.r1', key: 'F5' }, makeExec({ name: 'browser_press' }), { ...envFor('browser_press'), browsers: ctx.browsers })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('scroll rejects non-finite deltas', async () => {
    const { ctx } = await mount()
    await ctx.browsers.start(agent, {}, { callId: 'c' as never, agent, signal: new AbortController().signal, timeoutMs: 5_000, toolName: 'browser_start' })
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_scroll')!
    await expect(spec.execute({ target: { page: true }, deltaY: Number.NaN }, makeExec({ name: 'browser_scroll' }), { ...envFor('browser_scroll'), browsers: ctx.browsers })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('wait rejects non-positive durations', async () => {
    const { ctx } = await mount()
    await ctx.browsers.start(agent, {}, { callId: 'c' as never, agent, signal: new AbortController().signal, timeoutMs: 5_000, toolName: 'browser_start' })
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_wait')!
    await expect(spec.execute({ ms: 0 }, makeExec({ name: 'browser_wait' }), { ...envFor('browser_wait'), browsers: ctx.browsers })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const waited = await spec.execute({ ms: 1 }, makeExec({ name: 'browser_wait' }), { ...envFor('browser_wait'), browsers: ctx.browsers })
    expect((waited as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(0)
  })

  it('close reports a closed session', async () => {
    const { ctx } = await mount()
    await ctx.browsers.start(agent, {}, { callId: 'c' as never, agent, signal: new AbortController().signal, timeoutMs: 5_000, toolName: 'browser_start' })
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_close')!
    await expect(spec.execute({}, makeExec({ name: 'browser_close' }), { ...envFor('browser_close'), browsers: ctx.browsers })).resolves.toEqual({ closed: true })
  })

  it('gates screenshot on unknown routes and missing seams', async () => {
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_screenshot')!
    const { ctx } = await mount()
    await ctx.browsers.start(agent, {}, { callId: 'c' as never, agent, signal: new AbortController().signal, timeoutMs: 5_000, toolName: 'browser_start' })
    // No llm seam.
    await expect(spec.execute({}, makeExec({ name: 'browser_screenshot' }), { ...envFor('browser_screenshot'), browsers: ctx.browsers })).rejects.toMatchObject({ code: 'ROUTE_NOT_IMAGE_CAPABLE' })
    // Agent without a route.
    await expect(spec.execute({}, makeExec({ name: 'browser_screenshot', agent: { id: 'x', options: {} } as unknown as Agent }), {
      ...envFor('browser_screenshot'), browsers: ctx.browsers, llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }, attachments: {},
    })).rejects.toMatchObject({ code: 'ROUTE_NOT_IMAGE_CAPABLE' })
    // Text-only route.
    await expect(spec.execute({}, makeExec({ name: 'browser_screenshot' }), {
      ...envFor('browser_screenshot'), browsers: ctx.browsers, llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }, attachments: {},
    })).rejects.toMatchObject({ code: 'ROUTE_NOT_IMAGE_CAPABLE' })
    // Image route but no attachment store.
    await expect(spec.execute({}, makeExec({ name: 'browser_screenshot' }), {
      ...envFor('browser_screenshot'), browsers: ctx.browsers, llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    })).rejects.toMatchObject({ code: 'UNKNOWN' })
  })

  it('enforces attachment byte and pixel budgets', async () => {
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_screenshot')!
    const { ctx } = await mount()
    await ctx.browsers.start(agent, {}, { callId: 'c' as never, agent, signal: new AbortController().signal, timeoutMs: 5_000, toolName: 'browser_start' })
    const gate = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
    await expect(spec.execute({}, makeExec({ name: 'browser_screenshot' }), {
      ...envFor('browser_screenshot'), browsers: ctx.browsers, llm: gate,
      attachments: { imageLimits: { maxImageBytes: 0 }, saveImage: async () => ({ attachmentId: 'a', mediaType: 'image/png', width: 1, height: 1, bytes: 1 }) },
    })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT_EXCEEDED' })
    await expect(spec.execute({}, makeExec({ name: 'browser_screenshot' }), {
      ...envFor('browser_screenshot'), browsers: ctx.browsers, llm: gate,
      attachments: { imageLimits: { maxImagePixels: 0 }, saveImage: async () => ({ attachmentId: 'a', mediaType: 'image/png', width: 1, height: 1, bytes: 1 }) },
    })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT_EXCEEDED' })
  })

  it('exposes approval kinds through approvalOf', () => {
    expect(approvalOf('browser_click')).toBe('once')
    expect(approvalOf('browser_snapshot')).toBe('auto')
    expect(approvalOf('missing')).toBeUndefined()
  })
})

describe('manifest executor completeness', () => {
  it('rejects executions without an agent', () => {
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_start')!
    return expect(spec.execute({}, { callId: 'c' as never, signal: new AbortController().signal, arguments: {}, name: 'browser_start' } as ToolRunContext, { ...envFor('browser_start'), browsers: new BrowserSessionService(new Context()) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('fills through the source executor', async () => {
    const { ctx } = await mount()
    await ctx.browsers.start(agent, {}, { callId: 'c' as never, agent, signal: new AbortController().signal, timeoutMs: 5_000, toolName: 'browser_start' })
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_fill')!
    await expect(spec.execute({ ref: 'o1.r1', text: 'hello' }, makeExec({ name: 'browser_fill' }), { ...envFor('browser_fill'), browsers: ctx.browsers })).resolves.toEqual({ generation: 3, changed: true })
  })

  it('presses a valid key through the source executor', async () => {
    const { ctx } = await mount()
    await ctx.browsers.start(agent, {}, { callId: 'c' as never, agent, signal: new AbortController().signal, timeoutMs: 5_000, toolName: 'browser_start' })
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_press')!
    await expect(spec.execute({ ref: 'o1.r1', key: 'Enter' }, makeExec({ name: 'browser_press' }), { ...envFor('browser_press'), browsers: ctx.browsers })).resolves.toEqual({ generation: 3, changed: true })
  })

  it('scrolls an element through the source executor', async () => {
    const { ctx } = await mount()
    await ctx.browsers.start(agent, {}, { callId: 'c' as never, agent, signal: new AbortController().signal, timeoutMs: 5_000, toolName: 'browser_start' })
    const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_scroll')!
    await expect(spec.execute({ target: { element: 'o1.r1' }, deltaY: 0 }, makeExec({ name: 'browser_scroll' }), { ...envFor('browser_scroll'), browsers: ctx.browsers })).resolves.toEqual({ generation: 3, changed: true })
  })
})

describe('config-driven screenshot registration', () => {
  it('never registers the screenshot tool when screenshot is false', async () => {
    const mounted = await mount({
      screenshot: false,
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
      attachments: { saveImage: vi.fn() },
    })
    const names = mounted.ctx.tools.schemas().map(schema => schema.name)
    expect(names).not.toContain('browser_screenshot')
    expect(names).toHaveLength(9)
  })
})

describe('disposal (HMR safety)', () => {
  it('unregisters every tool when the consumer plugin disposes', async () => {
    const ctx = new Context()
    provide(ctx, 'approval', { request: vi.fn(async () => 'allowed-once') })
    new BrowserSessionService(ctx, { idleTimeoutMs: 60_000 })
    provide(ctx, 'systemPrompt', { context: () => undefined, variable: () => undefined, section: () => undefined, tools: () => undefined })
    const registryRoot = ctx
    await ctx.plugin(ToolRegistry, {})
    const fiber = await ctx.plugin({ name, inject, Config, apply }, { screenshot: false })
    expect(registryRoot.tools.schemas().map(schema => schema.name)).toHaveLength(9)
    await fiber.dispose()
    expect(registryRoot.tools.schemas().map(schema => schema.name)).toHaveLength(0)
  })
})

describe('keyless model-visible schema snapshot', () => {
  it('pins the ten browser tool schemas exactly', async () => {
    const { ctx } = await mount({ screenshot: false })
    const browserSchemas = ctx.tools.schemas().filter(schema => schema.name.startsWith('browser_'))
    const snapshot = browserSchemas.map(schema => ({ name: schema.name, description: schema.description, parameters: schema.parameters }))
    expect(JSON.stringify(snapshot, null, 2)).toMatchSnapshot('browser-tool-schemas')
  })
})
