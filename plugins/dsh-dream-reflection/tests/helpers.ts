/**
 * Shared test fixtures: session log builders, a scriptable session query, and
 * a scriptable LLM adapter over the real `LlmRuntime` registration path.
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

export function sessionHeader(id: string, cwd?: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, ...cwd === undefined ? {} : { cwd }, ...extra }
}

export function turnStartEvent(seq: number, turn: number): SessionEvent {
  return { type: 'turn/start', seq, time: seq * 10, data: { turn } }
}

export function turnEndEvent(seq: number, turn: number): SessionEvent {
  return { type: 'turn/end', seq, time: seq * 10, data: { turn, reason: { kind: 'completed' } } }
}

export function userEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq * 10,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }
}

export function pluginInjectedEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq * 10,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'test' } }),
    surfaceOp: 'append',
  }
}

export function assistantEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: seq * 10,
    data: { turn: 0, step: 0, message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } }) },
    surfaceOp: 'append',
  }
}

export function toolCallEvent(seq: number): SessionEvent {
  return { type: 'tool/call', seq, time: seq * 10, data: { turn: 0, step: 0, callId: 'call-1' as never, name: 'read', arguments: '{}' } }
}

/** One stored session log for the scriptable query engine. */
export interface StoredSession {
  header: SessionHeader
  events: SessionEvent[]
}

/** A scriptable live-preferred query engine for coordinator and engine tests. */
export class FakeSessionQuery extends SessionQueryEngine {
  readonly logs = new Map<string, StoredSession>()
  readFailures = new Set<string>()

  constructor(ctx: Context) {
    super(ctx)
  }

  set(id: string, header: SessionHeader, events: SessionEvent[]): void {
    this.logs.set(id, { header, events: events.map(event => structuredClone(event)) })
  }

  override async searchSessions(): Promise<never> {
    throw new Error('search disabled in fake')
  }

  override async searchEvents(): Promise<never> {
    throw new Error('search disabled in fake')
  }

  override async readSession(sessionId: Parameters<SessionQueryEngine['readSession']>[0]): Promise<Awaited<ReturnType<SessionQueryEngine['readSession']>>> {
    if (this.readFailures.has(String(sessionId))) throw new Error('corrupt session')
    const entry = this.logs.get(String(sessionId))
    if (entry === undefined) throw new Error(`no session ${String(sessionId)}`)
    return { session: structuredClone(entry.header), events: entry.events.map(event => structuredClone(event)) }
  }

  override async listSessions(): Promise<Awaited<ReturnType<SessionQueryEngine['listSessions']>>> {
    return [...this.logs.entries()].map(([id, entry]) => ({ header: structuredClone(entry.header), live: false, persisted: true })).sort((a, b) => String(a.header.id).localeCompare(String(b.header.id)))
  }

  override async listEvents(sessionId: Parameters<SessionQueryEngine['listEvents']>[0]): Promise<Awaited<ReturnType<SessionQueryEngine['listEvents']>>> {
    const entry = this.logs.get(String(sessionId))
    if (entry === undefined) throw new Error(`no session ${String(sessionId)}`)
    return entry.events.map(event => ({ sessionId, seq: event.seq, type: event.type, time: event.time, surface: 'visible' as never }))
  }

  override async readEvent(request: Parameters<SessionQueryEngine['readEvent']>[0], _signal?: AbortSignal): Promise<Awaited<ReturnType<SessionQueryEngine['readEvent']>>> {
    const entry = this.logs.get(String(request.sessionId))
    if (entry === undefined) throw new Error(`no session ${String(request.sessionId)}`)
    const target = entry.events[request.seq]
    if (target === undefined) throw new Error(`no event ${request.seq}`)
    return { session: structuredClone(entry.header), target: structuredClone(target), events: [], startSeq: request.seq, endSeq: request.seq }
  }
}

/** Scripted responses keyed by a phrase matched inside the user payload. */
export interface ScriptedTurn {
  /** When this phrase appears in the payload, return this text. */
  match: string
  text: string
  usage?: TokenUsage
  /** Extra chunk behaviors for failure injection. */
  chunks?: (chunks: StreamChunk[]) => StreamChunk[]
}

/** One scriptable adapter over the real LlmRuntime registration path. */
export class FakeLlmAdapter extends LlmAdapter {
  readonly calls: { options: GenerateOptions }[] = []
  readonly turns: ScriptedTurn[] = []
  defaultText = '{"unexpected":true}'
  signalListener: ((signal: AbortSignal) => void) | undefined
  /** Optional gate awaited before the first chunk yields (abort timing tests). */
  gate: Promise<void> = Promise.resolve()

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push({ options })
    options.signal?.addEventListener('abort', () => this.signalListener?.(options.signal!), { once: true })
    const payload = options.messages.map(message => message.content.map(block => 'text' in block && typeof block.text === 'string' ? block.text : '').join('')).join('\n')
    const turn = this.turns.find(script => payload.includes(script.match))
    const text = turn?.text ?? this.defaultText
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    if (turn?.usage !== undefined) chunks.push({ type: 'usage', usage: turn.usage })
    const final = turn?.chunks === undefined ? chunks : turn.chunks(chunks)
    await this.gate
    for (const chunk of final) {
      yield chunk
      await Promise.resolve()
    }
  }
}

/** Boot a real LlmRuntime with one scriptable adapter. */
export async function mountFakeLlm(ctx: Context): Promise<FakeLlmAdapter> {
  await ctx.plugin(LlmRuntime)
  const adapter = new FakeLlmAdapter()
  ctx.llm.registerAdapter(['mock-provider'], adapter)
  return adapter
}

/** Standard successful chunks for one JSON text. */
export function okChunks(text: string, usage?: TokenUsage): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
    ...usage === undefined ? [] : [{ type: 'usage', usage } as StreamChunk],
  ]
}

/** The default usage payload for budget tests. */
export const USAGE: TokenUsage = { inputTokens: 100, outputTokens: 50 }
