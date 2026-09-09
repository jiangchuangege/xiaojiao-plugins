/**
 * Bounded natural-language evidence builder over `ctx.sessionQuery` snapshots.
 *
 * Only completed-turn, real user/assistant text enters the corpus; injected
 * plugin context, tools, chunks, commands, reasoning, and fork seeds never do.
 * Every event is redacted before it is measured, and the result stays inside
 * the session / event / per-event / total-byte caps.
 *
 * @module dsh-dream-reflection/corpus/build
 */

import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { Redactor } from '../safety/redact.ts'

export interface EvidenceUnit {
  /** Run-local opaque reference; models may only cite these. */
  ref: string
  sessionId: string
  seq: number
  eventType: 'user/message' | 'assistant/message'
  /** Redacted event text. */
  text: string
  /** SHA-256 of the redacted text. */
  contentHash: string
}

export interface CheckedRange {
  sessionId: string
  /** Last examined seq of the contiguous window (inclusive). */
  seq: number
  /** Redacted texts of the examined range, for the cursor content hash. */
  texts: string[]
}

export interface DropRecord {
  ruleId: string
  count: number
  hashes: string[]
}

export interface SessionError {
  sessionId: string
  code: 'session-invalid'
}

export interface CorpusResult {
  units: EvidenceUnit[]
  checkedThrough: CheckedRange[]
  dropped: DropRecord[]
  sessionErrors: SessionError[]
  totalBytes: number
}

export interface CorpusBuildOptions {
  sessionQuery: SessionQueryEngine
  redact: Redactor
  maxSessions: number
  maxEvents: number
  maxEventBytes: number
  maxInputBytes: number
  /** Probe mode: stop collecting once this many redacted bytes accumulated. */
  stopAtBytes?: number
  /** Per-session stored cursor; sessions absent here start at their seed floor. */
  cursors: ReadonlyMap<string, number>
}

/** Hash one redacted text for ref verification and duplicate skipping. */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Normalize one raw event text: line endings, trimming, control characters. */
export function normalizeEventText(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .split('\n').map(line => line.trimEnd()).join('\n')
    .trim()
}

/** One session record scoped to a workspace by the caller. */
export interface CorpusSession {
  sessionId: string
  header: SessionHeader
}

/**
 * Build the bounded evidence set for one workspace. Sessions are read oldest
 * backlog first (smallest cursor wins), so a high-activity session cannot
 * starve older ones; within a session, events advance in ascending seq.
 * @param sessions - pre-filtered top-level sessions of one exact workspace.
 * @param options - bounds, cursor state, redaction, and the query engine.
 * @param signal - run cancellation; `readSession` cannot take it, so it is
 *   checked immediately before and after every read.
 * @returns the evidence units, the contiguous checked ranges per session, and
 *   the safety-drop records — never raw dropped text.
 */
export async function buildCorpus(sessions: readonly CorpusSession[], options: CorpusBuildOptions, signal?: AbortSignal): Promise<CorpusResult> {
  const result: CorpusResult = { units: [], checkedThrough: [], dropped: [], sessionErrors: [], totalBytes: 0 }
  const ordered = [...sessions].sort((a, b) => {
    const floorA = options.cursors.get(a.sessionId) ?? -1
    const floorB = options.cursors.get(b.sessionId) ?? -1
    return floorA - floorB || a.sessionId.localeCompare(b.sessionId)
  })
  const seenInWindow = new Set<string>()
  const drops = new Map<string, DropRecord>()

  for (const session of ordered.slice(0, options.maxSessions)) {
    signal?.throwIfAborted()
    let snapshot: Awaited<ReturnType<SessionQueryEngine['readSession']>>
    try {
      snapshot = await options.sessionQuery.readSession(SessionId(session.sessionId))
    } catch {
      result.sessionErrors.push({ sessionId: session.sessionId, code: 'session-invalid' })
      continue
    }
    signal?.throwIfAborted()
    const floor = Math.max(options.cursors.get(session.sessionId) ?? 0, session.header.seedLength ?? 0)
    const events = snapshot.events
    const boundary = lastCompletedTurnSeq(events, floor)
    if (boundary === null) continue
    const rangeTexts: string[] = []
    let lastExamined: number | null = null
    for (const event of events) {
      if (event.seq <= floor || event.seq > boundary) continue
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      const text = eventTextOf(event)
      if (text === undefined) continue
      const normalized = normalizeEventText(text)
      if (normalized === '') continue
      const hash = hashText(normalized)
      if (seenInWindow.has(hash)) continue
      seenInWindow.add(hash)
      const redacted = options.redact(normalized)
      if (redacted.dropped) {
        // Fully consumed by safety: counts toward the checked range.
        lastExamined = event.seq
        rangeTexts.push(redacted.text)
        const rule = drops.get(redacted.ruleId) ?? { ruleId: redacted.ruleId, count: 0, hashes: [] }
        rule.count += 1
        if (rule.hashes.length < 16) rule.hashes.push(hash)
        drops.set(redacted.ruleId, rule)
        continue
      }
      if (Buffer.byteLength(redacted.text, 'utf8') > options.maxEventBytes) {
        lastExamined = event.seq
        rangeTexts.push(redacted.text)
        const rule = drops.get('event-too-long') ?? { ruleId: 'event-too-long', count: 0, hashes: [] }
        rule.count += 1
        if (rule.hashes.length < 16) rule.hashes.push(hash)
        drops.set('event-too-long', rule)
        continue
      }
      const size = Buffer.byteLength(redacted.text, 'utf8')
      // Budget-excluded events stay unconsumed: the cursor must stop here so
      // the next run picks them up (never silently lose backlog).
      if (result.totalBytes + size > options.maxInputBytes || result.units.length >= options.maxEvents) {
        break
      }
      lastExamined = event.seq
      rangeTexts.push(redacted.text)
      result.units.push({
        ref: `e${result.units.length}`,
        sessionId: session.sessionId,
        seq: event.seq,
        eventType: event.type,
        text: redacted.text,
        contentHash: hash,
      })
      result.totalBytes += size
      if (options.stopAtBytes !== undefined && result.totalBytes >= options.stopAtBytes) break
    }
    if (lastExamined !== null && lastExamined >= floor) {
      result.checkedThrough.push({ sessionId: session.sessionId, seq: lastExamined, texts: rangeTexts })
    }
  }
  result.dropped = [...drops.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId))
  return result
}

/** The seq of the last completed-turn boundary at or after `floor`. */
export function lastCompletedTurnSeq(events: readonly SessionEvent[], floor: number): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && event.type === 'turn/end' && event.seq > floor) return event.seq
  }
  return null
}

/** Extract the text of one eligible event, or undefined when it is not eligible. */
export function eventTextOf(event: SessionEvent): string | undefined {
  switch (event.type) {
    case 'user/message': {
      const data = event.data as { source?: { kind?: string }; content?: readonly { type?: string; text?: unknown }[] }
      if (data.source?.kind !== 'user' || data.content === undefined) return undefined
      return textBlocks(data.content)
    }
    case 'assistant/message': {
      const data = event.data as { message?: { source?: { kind?: string }; content?: readonly { type?: string; text?: unknown }[] } }
      if (data.message?.source?.kind !== 'model' || data.message.content === undefined) return undefined
      return textBlocks(data.message.content)
    }
    default:
      return undefined
  }
}

function textBlocks(content: readonly { type?: string; text?: unknown }[]): string | undefined {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}
