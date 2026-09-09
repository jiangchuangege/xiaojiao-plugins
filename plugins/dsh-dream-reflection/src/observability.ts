/**
 * Observability contract: one named logger, stable skip/error codes, and a
 * log field budget that never carries cwd, prompt, transcript, or key text.
 *
 * @module dsh-dream-reflection/observability
 */

import type { Context } from '@deepseek-ai/cordis'

export const LOGGER_NAME = 'dream-reflection'

/** Stable skip codes; `/dream status` reads authoritative state, never these strings. */
export const SKIP_CODES = Object.freeze([
  'disabled',
  'workspace-out-of-scope',
  'workspace-unavailable',
  'no-live-root',
  'foreground-active',
  'quiet-period',
  'cooldown',
  'insufficient-new-evidence',
  'no-usable-evidence',
  'budget-exhausted',
  'lease-held',
  'session-invalid',
  'provider-unavailable',
  'model-failed',
  'schema-invalid',
  'output-blocked',
  'cancelled-by-foreground',
  'run-timeout',
  'lease-lost',
  'late-result-ignored',
  'state-incompatible',
] as const)

export type SkipCode = (typeof SKIP_CODES)[number]

/** A run-scoped log record: hashes, ids, counts, codes, durations, usage only. */
export interface RunLogFields {
  runId: string
  workspaceShortHash: string
  trigger: 'auto' | 'manual'
  phase?: string
  sessionCount?: number
  eventCount?: number
  evidenceBytes?: number
  candidateCount?: number
  code?: SkipCode | string
  elapsedMs?: number
  callCount?: number
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  fence?: string
  errorClass?: string
}

/** Build the first characters of a workspace hash without logging the full key. */
export function shortHash(value: string, length = 8): string {
  return value.slice(0, length)
}

/** Emit one bounded run log line through the named logger. */
export function logRun(ctx: Context, level: 'info' | 'warn' | 'error', fields: RunLogFields): void {
  const parts = [
    `run=${fields.runId}`,
    `ws=${fields.workspaceShortHash}`,
    `trigger=${fields.trigger}`,
  ]
  if (fields.phase !== undefined) parts.push(`phase=${fields.phase}`)
  if (fields.sessionCount !== undefined) parts.push(`sessions=${fields.sessionCount}`)
  if (fields.eventCount !== undefined) parts.push(`events=${fields.eventCount}`)
  if (fields.evidenceBytes !== undefined) parts.push(`bytes=${fields.evidenceBytes}`)
  if (fields.candidateCount !== undefined) parts.push(`candidates=${fields.candidateCount}`)
  if (fields.code !== undefined) parts.push(`code=${fields.code}`)
  if (fields.elapsedMs !== undefined) parts.push(`elapsed=${fields.elapsedMs}ms`)
  if (fields.callCount !== undefined) parts.push(`calls=${fields.callCount}`)
  if (fields.tokenUsage !== undefined) {
    const usage = fields.tokenUsage
    parts.push(`tokens=${usage.inputTokens + usage.outputTokens
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)}`)
  }
  if (fields.fence !== undefined) parts.push(`fence=${fields.fence}`)
  if (fields.errorClass !== undefined) parts.push(`error=${fields.errorClass}`)
  ctx.logger(LOGGER_NAME)[level](parts.join(' '))
}
