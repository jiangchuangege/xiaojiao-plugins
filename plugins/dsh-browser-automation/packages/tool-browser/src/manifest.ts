/**
 * Single source of truth for the ten browser tools: name, description,
 * parameter schema, output schema, timeout budget, approval kind, render, and
 * executor. CI asserts the manifest and the actually-registered set agree.
 * @module @dsh-browser-automation/dsh-tool-browser/manifest
 */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BrowserError, ElementRef, type BrowserSessionService, type PressKey,
} from '@dsh-browser-automation/dsh-browser'
import {
  clickParameters, closeParameters, fillParameters, navigateParameters, pressParameters,
  screenshotParameters, snapshotParameters, startParameters, waitParameters, scrollParameters,
} from './schemas.js'
import {
  renderAction, renderClose, renderNavigate, renderScreenshot, renderSnapshot, renderStart, renderWait,
} from './render.js'

/** Structural view of the llm service; only the image gate is consumed. */
export interface LlmView {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ readonly inputModalities?: readonly string[] }>
}

/** Structural view of the attachment store; only image save is consumed. */
export interface AttachmentView {
  readonly imageLimits?: {
    readonly maxImageBytes?: number
    readonly maxImagePixels?: number
  }
  saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: 'image/png'
    readonly name?: string
  }): Promise<{
    readonly attachmentId: string
    readonly mediaType: string
    readonly width: number
    readonly height: number
    readonly bytes: number
  }>
}

/** Identity of the tool being executed; executors never hardcode it. */
export interface ToolIdentity {
  readonly name: string
  readonly timeoutMs: number
}

/** Runtime environment handed to executors. */
export interface ToolEnv {
  readonly tool: ToolIdentity
  readonly browsers: BrowserSessionService
  /** Present when the profile composes the llm service (screenshot gate). */
  readonly llm: LlmView | undefined
  /** Present when the profile composes the attachment store (screenshot). */
  readonly attachments: AttachmentView | undefined
}

export type ApprovalKind = 'auto' | 'once'

/** One tool's complete declarative spec. */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly timeoutMs: number
  readonly approval: ApprovalKind
  /** Executors reject any root parameter outside this exact set. */
  readonly paramKeys: readonly string[]
  readonly parameters: ParameterSchemaSpec
  readonly outputSchema: ValueSchemaSpec
  readonly render: (args: Record<string, unknown>, value: unknown) => ContentBlock[]
  readonly execute: (args: Record<string, unknown>, exec: ToolRunContext, env: ToolEnv) => Promise<unknown>
}

/** Reject root parameters outside the manifest's exact key set. */
export function rejectUnknownKeys(args: Record<string, unknown>, allowed: readonly string[], toolName: string): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new BrowserError('INVALID_ARGUMENT', `${toolName}: unknown parameter "${key}"`, { retryable: false })
    }
  }
}

/** The live agent for one execution; browser tools are agent-scoped. */
function agentOf(exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new BrowserError('INVALID_ARGUMENT', 'browser tools require an agent context', { retryable: false })
  }
  return agent
}

function operationOf(exec: ToolRunContext, tool: ToolIdentity) {
  return {
    callId: exec.callId,
    agent: agentOf(exec),
    signal: exec.signal,
    timeoutMs: tool.timeoutMs,
    toolName: tool.name,
  }
}

/** Allowlist-guarded key conversion; the schema enum already validated it. */
function pressKeyOf(key: string): PressKey {
  const keys: readonly string[] = ['Enter', 'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Escape', 'Home', 'End', 'PageUp', 'PageDown']
  if (!keys.includes(key)) {
    throw new BrowserError('INVALID_ARGUMENT', `browser_press: unsupported key "${key}"`, { retryable: false })
  }
  return key as PressKey
}

interface StartArgs {
  readonly backend?: string
  readonly [key: string]: unknown
}

interface NavigateArgs {
  readonly url: string
  readonly [key: string]: unknown
}

interface RefArgs {
  readonly ref: string
  readonly [key: string]: unknown
}

interface FillArgs extends RefArgs {
  readonly text: string
}

interface PressArgs extends RefArgs {
  readonly key: string
}

interface ScrollArgs {
  readonly target: { readonly page?: unknown; readonly element?: unknown }
  readonly deltaY: number
  readonly [key: string]: unknown
}

interface WaitArgs {
  readonly ms: number
  readonly [key: string]: unknown
}

const stringSchema = { type: 'string' } as const
const requiredStringSchema = { type: 'string', required: true } as const
const integerSchema = { type: 'integer' } as const
const requiredIntegerSchema = { type: 'integer', required: true } as const
const booleanSchema = { type: 'boolean' } as const
const requiredBooleanSchema = { type: 'boolean', required: true } as const
const nullableStringSchema = { oneOf: [{ type: 'string' }, { type: 'null' }], required: true } as const

const elementValueSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: requiredStringSchema,
    role: requiredStringSchema,
    accessibleName: requiredStringSchema,
    text: requiredStringSchema,
    interactive: requiredBooleanSchema,
  },
} as const

const actionResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    generation: requiredIntegerSchema,
    changed: requiredBooleanSchema,
  },
} as const

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'browser_start',
    description: 'Start an isolated browser session for this agent with a single blank page. The session never inherits existing logins, cookies, or profiles, and closes at turn end, idle timeout, or explicit close.',
    timeoutMs: 60_000,
    approval: 'auto',
    paramKeys: ['backend'],
    parameters: startParameters,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { sessionId: requiredStringSchema, pageId: requiredStringSchema, backendType: requiredStringSchema },
    },
    render: renderStart,
    execute: async (args, exec, env) => {
      const a = args as StartArgs
      rejectUnknownKeys(args, ['backend'], env.tool.name)
      return env.browsers.start(agentOf(exec), { ...(a.backend === undefined ? {} : { backend: a.backend }) }, operationOf(exec, env.tool))
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the session page to an exact public http(s) URL (no userinfo, query, or fragment). Every request passes the egress policy; cross-origin redirects are blocked. Requires one-shot user approval.',
    timeoutMs: 60_000,
    approval: 'once',
    paramKeys: ['url'],
    parameters: navigateParameters,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pageId: requiredStringSchema,
        origin: nullableStringSchema,
        displayUrl: requiredStringSchema,
        generation: requiredIntegerSchema,
      },
    },
    render: renderNavigate,
    execute: async (args, exec, env) => {
      const a = args as NavigateArgs
      rejectUnknownKeys(args, ['url'], env.tool.name)
      return env.browsers.navigate(agentOf(exec), { url: a.url }, operationOf(exec, env.tool))
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Capture a bounded semantic snapshot of the current page: title, origin, and a limited list of interactive elements with opaque refs. No HTML, scripts, hidden values, or password fields. All content is untrusted web content.',
    timeoutMs: 30_000,
    approval: 'auto',
    paramKeys: [],
    parameters: snapshotParameters,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schemaVersion: { type: 'integer', const: 1, required: true },
        sessionId: requiredStringSchema,
        pageId: requiredStringSchema,
        observationId: requiredStringSchema,
        generation: requiredIntegerSchema,
        expiresAt: requiredIntegerSchema,
        origin: nullableStringSchema,
        displayUrl: requiredStringSchema,
        title: requiredStringSchema,
        truncated: requiredBooleanSchema,
        nodeCount: requiredIntegerSchema,
        elements: { type: 'array', items: elementValueSchema, required: true },
        trust: { type: 'string', const: 'untrusted-web-content', required: true },
      },
    },
    render: renderSnapshot,
    execute: async (args, exec, env) => {
      rejectUnknownKeys(args, [], env.tool.name)
      return env.browsers.observe(agentOf(exec), {}, operationOf(exec, env.tool))
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the current viewport as a durable image attachment. Only registered when the current model route accepts images; a text-only route rejects this call before capture. Requires one-shot user approval.',
    timeoutMs: 60_000,
    approval: 'once',
    paramKeys: [],
    parameters: screenshotParameters,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: requiredStringSchema,
        mediaType: { type: 'string', const: 'image/png', required: true },
        width: requiredIntegerSchema,
        height: requiredIntegerSchema,
        bytes: requiredIntegerSchema,
      },
    },
    render: renderScreenshot,
    execute: async (args, exec, env) => {
      rejectUnknownKeys(args, [], env.tool.name)
      const agent = agentOf(exec)
      const provider = agent.options.provider
      const model = agent.options.model
      if (env.llm === undefined || provider === undefined || model === undefined) {
        throw new BrowserError('ROUTE_NOT_IMAGE_CAPABLE', 'the current model route is not known to accept images', { retryable: false })
      }
      const info = await env.llm.resolveModelInfo(provider, model, exec.signal)
      if (!info.inputModalities?.includes('image')) {
        throw new BrowserError('ROUTE_NOT_IMAGE_CAPABLE', 'the current model route does not accept images', { retryable: false })
      }
      const shot = await env.browsers.screenshot(agent, {}, operationOf(exec, env.tool))
      if (env.attachments === undefined) {
        throw new BrowserError('UNKNOWN', 'no attachment store is composed in this profile', { retryable: false })
      }
      const limits = env.attachments.imageLimits
      if (limits?.maxImageBytes !== undefined && shot.bytes > limits.maxImageBytes) {
        throw new BrowserError('OUTPUT_LIMIT_EXCEEDED', 'the screenshot exceeds the attachment byte budget', { retryable: false })
      }
      if (limits?.maxImagePixels !== undefined && shot.width * shot.height > limits.maxImagePixels) {
        throw new BrowserError('OUTPUT_LIMIT_EXCEEDED', 'the screenshot exceeds the attachment pixel budget', { retryable: false })
      }
      const ref = await env.attachments.saveImage({ data: shot.image, mediaType: 'image/png', name: 'browser-viewport' })
      return { attachmentId: ref.attachmentId, mediaType: ref.mediaType, width: ref.width, height: ref.height, bytes: ref.bytes }
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element from the latest browser_snapshot by its ref. The target is re-verified at click time (generation, uniqueness, actionability); changed or stale targets fail instead of guessing. Requires one-shot user approval.',
    timeoutMs: 30_000,
    approval: 'once',
    paramKeys: ['ref'],
    parameters: clickParameters,
    outputSchema: actionResultSchema,
    render: renderAction,
    execute: async (args, exec, env) => {
      const a = args as RefArgs
      rejectUnknownKeys(args, ['ref'], env.tool.name)
      return env.browsers.act(agentOf(exec), { action: { kind: 'click', ref: ElementRef(a.ref) } }, operationOf(exec, env.tool))
    },
  },
  {
    name: 'browser_fill',
    description: 'Type plain text into an editable field from the latest browser_snapshot by its ref. Password, file, hidden, and payment fields are never exposed or writable. The typed text is sent to the target site; never enter secrets. Requires one-shot user approval.',
    timeoutMs: 30_000,
    approval: 'once',
    paramKeys: ['ref', 'text'],
    parameters: fillParameters,
    outputSchema: actionResultSchema,
    render: renderAction,
    execute: async (args, exec, env) => {
      const a = args as FillArgs
      rejectUnknownKeys(args, ['ref', 'text'], env.tool.name)
      return env.browsers.act(agentOf(exec), { action: { kind: 'fill', ref: ElementRef(a.ref), text: a.text } }, operationOf(exec, env.tool))
    },
  },
  {
    name: 'browser_press',
    description: 'Focus an element from the latest browser_snapshot and press one allowlisted key (Enter, Space, Tab, arrows, Backspace, Escape, Home, End, PageUp, PageDown). No chords or system shortcuts. Requires one-shot user approval.',
    timeoutMs: 30_000,
    approval: 'once',
    paramKeys: ['ref', 'key'],
    parameters: pressParameters,
    outputSchema: actionResultSchema,
    render: renderAction,
    execute: async (args, exec, env) => {
      const a = args as PressArgs
      rejectUnknownKeys(args, ['ref', 'key'], env.tool.name)
      return env.browsers.act(agentOf(exec), { action: { kind: 'press', ref: ElementRef(a.ref), key: pressKeyOf(a.key) } }, operationOf(exec, env.tool))
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page by a bounded vertical distance, or scroll one observed element into view. Element mode requires a fresh ref from the latest snapshot. Auto-allowed.',
    timeoutMs: 30_000,
    approval: 'auto',
    paramKeys: ['target', 'deltaY'],
    parameters: scrollParameters,
    outputSchema: actionResultSchema,
    render: renderAction,
    execute: async (args, exec, env) => {
      const a = args as ScrollArgs
      rejectUnknownKeys(args, ['target', 'deltaY'], env.tool.name)
      if (!Number.isFinite(a.deltaY)) {
        throw new BrowserError('INVALID_ARGUMENT', 'browser_scroll: deltaY must be a finite number', { retryable: false })
      }
      const hasPage = a.target.page === true
      const hasElement = a.target.element !== undefined
      if (hasPage === hasElement) {
        throw new BrowserError('INVALID_ARGUMENT', 'browser_scroll: target must be exactly one of page or element', { retryable: false })
      }
      const target = hasPage
        ? { page: true as const }
        : { element: ElementRef(String(a.target.element)) }
      return env.browsers.act(agentOf(exec), { action: { kind: 'scroll', target, deltaY: a.deltaY } }, operationOf(exec, env.tool))
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait a bounded time for the page to settle. No JavaScript predicates; the wait is aborted with the turn. Auto-allowed.',
    timeoutMs: 40_000,
    approval: 'auto',
    paramKeys: ['ms'],
    parameters: waitParameters,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { waitedMs: requiredIntegerSchema },
    },
    render: renderWait,
    execute: async (args, exec, env) => {
      const a = args as WaitArgs
      rejectUnknownKeys(args, ['ms'], env.tool.name)
      if (!Number.isInteger(a.ms) || a.ms < 1) {
        throw new BrowserError('INVALID_ARGUMENT', 'browser_wait: ms must be a positive integer', { retryable: false })
      }
      const started = Date.now()
      await env.browsers.wait(agentOf(exec), { ms: a.ms }, operationOf(exec, env.tool))
      return { waitedMs: Date.now() - started }
    },
  },
  {
    name: 'browser_close',
    description: 'Close this agent\'s browser session, its page, process, and private temporary data. Idempotent; never touches other agents\' sessions or the user\'s real browser. Auto-allowed.',
    timeoutMs: 30_000,
    approval: 'auto',
    paramKeys: [],
    parameters: closeParameters,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { closed: requiredBooleanSchema },
    },
    render: renderClose,
    execute: async (args, exec, env) => {
      rejectUnknownKeys(args, [], env.tool.name)
      return env.browsers.close(agentOf(exec), {}, operationOf(exec, env.tool))
    },
  },
]

/** Names in registration order; CI asserts the registered set equals this. */
export const TOOL_NAMES: readonly string[] = TOOL_SPECS.map(spec => spec.name)

/** Whether a tool needs one-shot approval (Consumer-level documentation only). */
export function approvalOf(name: string): ApprovalKind | undefined {
  return TOOL_SPECS.find(spec => spec.name === name)?.approval
}
