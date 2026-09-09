/**
 * `/dream` command handling: strict subcommand parsing over the engine's
 * single coordinator and store. Results are UI-only — the harness never sends
 * command output to the model.
 *
 * @module dsh-dream-reflection/commands
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { DreamReflectionService } from './service.ts'
import { redactText } from './safety/redact.ts'
import type { CandidateStatus } from './store/service.ts'
import { eventTextOf, normalizeEventText } from './corpus/build.ts'

const USAGE = 'usage: /dream status | run [--dry-run] | cancel <run-id> | list [quarantined|approved|challenged] | show <candidate-id> | approve <candidate-id> | reject <candidate-id>'

export async function handleDreamCommand(engine: DreamReflectionService, invocation: CommandInvocation): Promise<CommandResult> {
  const tokens = invocation.rawInput.trim().split(/\s+/u).filter(token => token !== '')
  const subcommand = tokens[0] ?? 'status'
  const rest = tokens.slice(1)
  try {
    switch (subcommand) {
      case 'status': return success(await statusText(engine))
      case 'run': return success(await runText(engine, invocation, rest))
      case 'cancel': return success(cancelText(engine, invocation, rest))
      case 'list': return success(listText(engine, rest))
      case 'show': return success(await showText(engine, invocation, rest))
      case 'approve': return success(approveText(engine, rest))
      case 'reject': return success(rejectText(engine, rest))
      default: return { kind: 'error', text: `dream: unknown subcommand "${subcommand}". ${USAGE}` }
    }
  } catch (error) {
    return { kind: 'error', text: `dream: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function success(text: string): CommandResult {
  return { kind: 'success', text }
}

async function statusText(engine: DreamReflectionService): Promise<string> {
  const active = engine.coordinator.activeRun()
  const workspaces = engine.store.listWorkspaces()
  const lines: string[] = [
    `enabled: ${engine.config.enabled}`,
    `scope: ${engine.config.scope.mode}`,
    engine.config.enabled ? `route: ${engine.config.provider}/${engine.config.model} (${engine.isRouteReady() ? 'ready' : 'unavailable'})` : 'route: disabled',
    `active run: ${active === null ? 'none' : `${active.runId} (${active.trigger})`}`,
  ]
  const map = await engine.buildWorkspaceMap()
  for (const workspace of workspaces.slice(0, 10)) {
    const entry = map.get(workspace.workspaceKey)
    const sessions = entry?.sessions.length ?? 0
    lines.push(`ws ${workspace.workspaceKey.slice(0, 12)}… sessions=${sessions} lastSuccess=${workspace.lastSuccessAt === null ? 'never' : new Date(workspace.lastSuccessAt).toISOString()} failures=${workspace.failureCount}`)
  }
  return lines.join('\n')
}

async function runText(engine: DreamReflectionService, invocation: CommandInvocation, rest: string[]): Promise<string> {
  const dryRun = rest.includes('--dry-run')
  const scope = engine.workspaceKeyForCommand(invocation.agent)
  if ('error' in scope) return scope.error
  if (dryRun) {
    const map = await engine.buildWorkspaceMap()
    const entry = map.get(scope.key)
    if (entry === undefined) return `dream: workspace ${scope.key.slice(0, 12)}… has no sessions in scope`
    return `dream dry-run:\n${await engine.dryRun(scope.key, entry)}`
  }
  if (!engine.config.enabled) return 'dream: enabled is false; set enabled + provider + model in the profile patch first'
  const outcome = await engine.coordinator.request({ trigger: 'manual', workspaceKey: scope.key, canonicalCwd: scope.canonicalCwd })
  return `dream run ${outcome.runId}: ${outcome.kind}${outcome.kind === 'skipped' || outcome.kind === 'failed' || outcome.kind === 'cancelled' ? ` (${outcome.errorCode})` : outcome.kind === 'committed' ? (outcome.errorCode === null ? '' : ` (${outcome.errorCode})`) : ''}`
}

function cancelText(engine: DreamReflectionService, invocation: CommandInvocation, rest: string[]): string {
  const runId = rest[0]
  if (runId === undefined) return 'dream: cancel needs a run id'
  const scope = engine.workspaceKeyForCommand(invocation.agent)
  if ('error' in scope) return scope.error
  return engine.coordinator.cancelRun(scope.key, runId)
    ? `dream: cancel requested for ${runId}`
    : `dream: no active run ${runId} in this workspace`
}

function listText(engine: DreamReflectionService, rest: string[]): string {
  const filter = rest[0]
  const statuses: CandidateStatus[] | undefined = filter === 'quarantined' || filter === 'approved' || filter === 'challenged'
    ? [filter]
    : filter === undefined
      ? ['quarantined', 'approved', 'challenged']
      : undefined
  if (statuses === undefined) return 'dream: list filter must be quarantined, approved, or challenged'
  const rows: string[] = []
  for (const workspace of engine.store.listWorkspaces()) {
    for (const candidate of engine.store.listCandidates(workspace.workspaceKey, statuses).slice(0, 20)) {
      rows.push(`${candidate.candidateId.slice(0, 8)} [${candidate.status}/${candidate.confidence}] ws=${workspace.workspaceKey.slice(0, 8)} r${candidate.revision} ${candidate.title}`)
    }
  }
  return rows.length === 0 ? 'dream: no matching candidates' : rows.slice(0, 50).join('\n')
}

async function showText(engine: DreamReflectionService, invocation: CommandInvocation, rest: string[]): Promise<string> {
  const candidateId = rest[0]
  if (candidateId === undefined) return 'dream: show needs a candidate id'
  const candidate = engine.store.getCandidate(candidateId)
  if (candidate === null) return `dream: unknown candidate ${candidateId}`
  const lines = [
    `${candidate.title} [${candidate.status}/${candidate.confidence} r${candidate.revision}]`,
    candidate.summary,
  ]
  for (const claim of candidate.claims) lines.push(`- claim: ${claim.text} (${claim.evidenceRefs.join(', ')})`)
  for (const limitation of candidate.limitations) lines.push(`- limitation: ${limitation}`)
  lines.push(`review question: ${candidate.reviewQuestion}`)
  lines.push(`source refs: ${candidate.sourceRefs.map(ref => `${ref.ref}(${ref.sessionId.slice(0, 8)}:${ref.seq}:${ref.eventType})`).join(' ')}`)
  const context = await sourceContextText(engine, invocation, candidate.sourceRefs.slice(0, 3))
  if (context !== '') lines.push(`context:\n${context}`)
  return lines.join('\n')
}

async function sourceContextText(engine: DreamReflectionService, invocation: CommandInvocation, refs: { sessionId: string; seq: number }[]): Promise<string> {
  const snippets: string[] = []
  for (const ref of refs) {
    try {
      const window = await engine.sessionQuery.readEvent({ sessionId: SessionId(ref.sessionId), seq: ref.seq, before: 0, after: 0 }, invocation.signal)
      const text = eventTextOf(window.target)
      if (text === undefined) continue
      const redacted = redactText(normalizeEventText(text))
      const snippet = redacted.text.slice(0, 300)
      snippets.push(`[${ref.sessionId.slice(0, 8)}:${ref.seq}] ${snippet}`)
    } catch {
      snippets.push(`[${ref.sessionId.slice(0, 8)}:${ref.seq}] session-invalid`)
    }
  }
  return snippets.join('\n')
}

function approveText(engine: DreamReflectionService, rest: string[]): string {
  const candidateId = rest[0]
  if (candidateId === undefined) return 'dream: approve needs a candidate id'
  const candidate = engine.store.getCandidate(candidateId)
  if (candidate === null) return `dream: unknown candidate ${candidateId}`
  if (candidate.status !== 'quarantined') return `dream: candidate ${candidateId} is ${candidate.status}, not quarantined`
  if (candidate.confidence === 'low') return 'dream: low-confidence fragments cannot be approved'
  const result = engine.store.reviewCandidate(candidateId, candidate.revision, ['quarantined'], 'approved', Date.now())
  return result.ok
    ? `dream: approved ${candidateId} (revision ${result.revision})`
    : `dream: candidate ${candidateId} changed (revision ${candidate.revision}); run /dream show again`
}

function rejectText(engine: DreamReflectionService, rest: string[]): string {
  const candidateId = rest[0]
  if (candidateId === undefined) return 'dream: reject needs a candidate id'
  const candidate = engine.store.getCandidate(candidateId)
  if (candidate === null) return `dream: unknown candidate ${candidateId}`
  if (candidate.status !== 'quarantined' && candidate.status !== 'challenged') return `dream: candidate ${candidateId} is ${candidate.status}, not reviewable`
  const result = engine.store.reviewCandidate(candidateId, candidate.revision, ['quarantined', 'challenged'], 'rejected', Date.now())
  return result.ok
    ? `dream: rejected ${candidateId} (revision ${result.revision})`
    : `dream: candidate ${candidateId} changed (revision ${candidate.revision}); run /dream show again`
}
