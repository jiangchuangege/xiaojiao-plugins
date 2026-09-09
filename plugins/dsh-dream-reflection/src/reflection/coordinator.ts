/**
 * RunCoordinator: the single owner of every run. Schedulers, commands, and
 * the optional job adapter only submit {@link RunRequest}s; they can never
 * write cursors, candidates, leases, or budgets themselves.
 *
 * One run executes at a time (global single flight). Every path — success,
 * skip, failure, cancel, timeout, lease loss — funnels into one settlement:
 * stop the heartbeat, verify the fences inside the commit transaction, then
 * release leases, reconcile budget reservations, and finish the run promise.
 *
 * @module dsh-dream-reflection/reflection/coordinator
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { buildCorpus } from '../corpus/build.ts'
import { rangeContentHash } from '../corpus/cursor.ts'
import { redactor } from '../safety/redact.ts'
import { logRun } from '../observability.ts'
import type { ResolvedConfig } from '../config.ts'
import type { DreamReflectionStore, CommitRunPayload, RunUsage } from '../store/service.ts'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { CorpusSession } from '../corpus/build.ts'
import { runPipeline } from './pipeline.ts'
import type { ExistingCard } from './pipeline.ts'

export interface RunRequest {
  trigger: 'auto' | 'manual'
  workspaceKey: string
  /** The canonical cwd this key maps to (caller-verified). */
  canonicalCwd: string
}

export type RunOutcome =
  | { kind: 'committed'; runId: string; errorCode: string | null; candidateCount: number }
  | { kind: 'skipped'; runId: string; errorCode: string }
  | { kind: 'failed'; runId: string; errorCode: string }
  | { kind: 'cancelled'; runId: string; errorCode: string }

export interface CoordinatorDeps {
  ctx: Context
  config: ResolvedConfig
  store: DreamReflectionStore
  sessionQuery: SessionQueryEngine
  llm: LlmRuntime
  instanceSalt: string
  /** Resolve the scoped sessions for one workspace (engine-owned mapping). */
  sessionsFor: (workspaceKey: string) => Promise<{ canonicalCwd: string; sessions: CorpusSession[] } | null>
}

interface ActiveRun {
  request: RunRequest
  runId: string
  holderId: string
  fences: { globalFence: number; workspaceFence: number }
  controller: AbortController
  settled: Promise<RunOutcome>
  resolve: (outcome: RunOutcome) => void
  heartbeat: ReturnType<typeof setInterval> | null
  runTimeout: ReturnType<typeof setTimeout> | null
  workspaceKey: string
  settledFlag: boolean
}

export class RunCoordinator {
  private readonly deps: CoordinatorDeps
  private active: ActiveRun | null = null
  private readonly queue: { request: RunRequest; resolve: (outcome: RunOutcome) => void }[] = []
  private disposed = false

  constructor(deps: CoordinatorDeps) {
    this.deps = deps
  }

  /** Submit one run; automatic and manual requests share this exact queue. */
  request(request: RunRequest): Promise<RunOutcome> {
    return new Promise<RunOutcome>(resolve => {
      this.queue.push({ request, resolve })
      this.pump()
    })
  }

  /** Abort the active run when it belongs to the given workspace. */
  abortWorkspace(workspaceKey: string, reason: 'cancelled-by-foreground'): void {
    const active = this.active
    if (active !== null && active.workspaceKey === workspaceKey && !active.controller.signal.aborted) {
      active.controller.abort(new Error(reason))
    }
  }

  /** Cancel the active run by id; only the same workspace may cancel. */
  cancelRun(workspaceKey: string, runId: string): boolean {
    const active = this.active
    if (active === null || active.workspaceKey !== workspaceKey || active.runId !== runId) return false
    active.controller.abort(new Error('user-cancelled'))
    return true
  }

  /** The currently executing run, for status reporting. */
  activeRun(): { runId: string; workspaceKey: string; trigger: 'auto' | 'manual' } | null {
    const active = this.active
    return active === null ? null : { runId: active.runId, workspaceKey: active.workspaceKey, trigger: active.request.trigger }
  }

  /** Stop accepting requests, abort the active run, and await its settlement. */
  async dispose(): Promise<void> {
    this.disposed = true
    const pending = this.active
    if (pending !== null && !pending.controller.signal.aborted) {
      pending.controller.abort(new Error('disposed'))
      await pending.settled
    }
    this.active = null
  }

  private pump(): void {
    if (this.active !== null || this.disposed) return
    const next = this.queue.shift()
    if (next === undefined) return
    void this.execute(next.request).then(next.resolve)
  }

  private async execute(request: RunRequest): Promise<RunOutcome> {
    const { config, store, ctx } = this.deps
    const startedAt = Date.now()
    const runId = randomUUID()
    const holderId = randomUUID()
    const controller = new AbortController()
    const day = utcDayKey(startedAt)
    const workspaces = store.getWorkspace(request.workspaceKey)

    const acquired = store.beginRun(
      { runId, workspaceKey: request.workspaceKey, trigger: request.trigger, phase: 'queued', createdAt: startedAt },
      holderId,
      config.store.leaseTtlMs,
      startedAt,
    )
    if (acquired === null) {
      logRun(ctx, 'info', { runId, workspaceShortHash: short(request.workspaceKey), trigger: request.trigger, code: 'lease-held' })
      return { kind: 'skipped', runId, errorCode: 'lease-held' }
    }

    const settled: { promise: Promise<RunOutcome>; resolve: (outcome: RunOutcome) => void } = Promise.withResolvers<RunOutcome>()
    const active: ActiveRun = {
      request,
      runId,
      holderId,
      fences: acquired,
      controller,
      settled: settled.promise,
      resolve: settled.resolve,
      heartbeat: null,
      runTimeout: null,
      workspaceKey: request.workspaceKey,
      settledFlag: false,
    }
    this.active = active

    const heartbeatMs = Math.max(1000, Math.floor(config.store.leaseTtlMs / 3))
    active.heartbeat = setInterval(() => {
      const alive = store.heartbeatRun(runId, holderId, acquired.globalFence, acquired.workspaceFence, config.store.leaseTtlMs, Date.now())
      if (!alive) {
        clearIntervalSafe(active.heartbeat)
        if (!active.controller.signal.aborted) active.controller.abort(new Error('lease-lost'))
      }
    }, heartbeatMs)
    active.runTimeout = setTimeout(() => {
      if (!active.controller.signal.aborted) active.controller.abort(new Error('run-timeout'))
    }, config.limits.runTimeoutMs)

    const settle = (outcome: RunOutcome): RunOutcome => {
      if (active.settledFlag) return outcome
      active.settledFlag = true
      clearIntervalSafe(active.heartbeat)
      clearTimeoutSafe(active.runTimeout)
      if (this.active === active) this.active = null
      active.resolve(outcome)
      this.pump()
      return outcome
    }

    const usage: { callCount: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } = { callCount: 0, inputTokens: 0, outputTokens: 0 }
    type CommitRest = Omit<CommitRunPayload, 'runId' | 'workspaceKey' | 'holderId' | 'globalFence' | 'workspaceFence' | 'status' | 'errorCode' | 'usage' | 'finishedAt'>
    const commit = (status: 'committed' | 'failed' | 'cancelled', errorCode: string | null, payload: CommitRest): RunOutcome => {
      const ok = store.commitRun({
        runId,
        workspaceKey: request.workspaceKey,
        holderId,
        globalFence: acquired.globalFence,
        workspaceFence: acquired.workspaceFence,
        status,
        errorCode,
        usage: usage.callCount === 0 ? null : usage,
        finishedAt: Date.now(),
        ...payload,
      })
      if (!ok) {
        logRun(ctx, 'error', { runId, workspaceShortHash: short(request.workspaceKey), trigger: request.trigger, code: 'lease-lost', fence: `${acquired.globalFence}/${acquired.workspaceFence}` })
        return settle({ kind: 'failed', runId, errorCode: 'lease-lost' })
      }
      return settle(status === 'committed'
        ? { kind: 'committed', runId, errorCode, candidateCount: payload.candidates.length }
        : status === 'cancelled'
          ? { kind: 'cancelled', runId, errorCode: errorCode ?? 'cancelled-by-foreground' }
          : { kind: 'failed', runId, errorCode: errorCode ?? 'model-failed' })
    }

    try {
      const scope = await this.deps.sessionsFor(request.workspaceKey)
      if (scope === null) {
        return commit('failed', 'workspace-unavailable', { candidates: [], challengeIds: [], cursors: [], workspace: null })
      }
      const cursors = new Map<string, number>()
      for (const session of scope.sessions) {
        const stored = store.getCursor(request.workspaceKey, session.sessionId)
        if (stored !== null) cursors.set(session.sessionId, stored)
      }
      const corpus = await buildCorpus(scope.sessions, {
        sessionQuery: this.deps.sessionQuery,
        redact: redactor,
        maxSessions: config.corpus.maxSessions,
        maxEvents: config.corpus.maxEvents,
        maxEventBytes: config.corpus.maxEventBytes,
        maxInputBytes: config.corpus.maxInputBytes,
        cursors,
      }, controller.signal)

      if (corpus.units.length === 0) {
        const dropped = corpus.dropped.reduce((sum, record) => sum + record.count, 0)
        const code = dropped > 0 ? 'no-usable-evidence' : 'insufficient-new-evidence'
        logRun(ctx, 'info', {
          runId, workspaceShortHash: short(request.workspaceKey), trigger: request.trigger,
          sessionCount: scope.sessions.length, eventCount: 0, evidenceBytes: 0, code,
          elapsedMs: Date.now() - startedAt, callCount: 0,
        })
        if (code === 'insufficient-new-evidence') {
          return commit('committed', code, { candidates: [], challengeIds: [], cursors: [], workspace: null })
        }
        // Safety consumed the whole window: one no-usable-evidence checkpoint
        // advances the examined range so the sensitive backlog is never rescanned.
        const cursorUpdates = corpus.checkedThrough.map(range => ({ sessionId: range.sessionId, seq: range.seq, contentHash: rangeContentHash(range.texts) }))
          .filter(update => update.seq > (cursors.get(update.sessionId) ?? -1))
        return commit('committed', code, {
          candidates: [],
          challengeIds: [],
          cursors: cursorUpdates,
          workspace: { lastSuccessAt: Date.now(), failureCount: 0, nextEligibleAt: Date.now() + config.schedule.minSuccessIntervalMs },
        })
      }

      const unitsByRef = new Map(corpus.units.map(unit => [unit.ref, unit]))
      const existingCards: ExistingCard[] = store.listCandidates(request.workspaceKey, ['approved', 'challenged', 'quarantined'])
        .filter((candidate): candidate is typeof candidate & { status: 'approved' | 'challenged' | 'quarantined' } =>
          candidate.status === 'approved' || candidate.status === 'challenged' || candidate.status === 'quarantined')
        .map(candidate => ({
          candidateId: candidate.candidateId,
          status: candidate.status,
          title: candidate.title,
          summary: candidate.summary,
          claimTexts: candidate.claims.map(claim => claim.text),
          nearVector: candidate.nearVector,
        }))

      const outcome = await runPipeline({
        units: corpus.units,
        unitsByRef,
        existingCards,
      }, {
        llm: this.deps.llm,
        provider: config.provider,
        model: config.model,
        maxOutputTokensPerCall: config.limits.maxOutputTokensPerCall,
        maxCallsPerRun: config.limits.maxCallsPerRun,
        maxThemes: config.reflection.maxThemes,
        maxEvidenceRefsPerTheme: config.reflection.maxEvidenceRefsPerTheme,
        maxCandidates: config.reflection.maxCandidates,
        nearDuplicateThreshold: config.reflection.nearDuplicateThreshold,
        evidenceBytes: corpus.totalBytes,
        phaseSignal: () => AbortSignal.any([controller.signal, AbortSignal.timeout(config.limits.phaseTimeoutMs)]),
        budget: {
          reserve: (calls, tokens) => store.reserveBudget(day, config.provider, calls, tokens, config.limits.dailyCallLimit, config.limits.dailyTokenLimit),
          settle: (reservedCalls, reservedTokens, callUsage) => {
            const actual = callUsage === null
              ? { calls: reservedCalls, tokens: reservedTokens }
              : { calls: 1, tokens: callUsage.inputTokens + callUsage.outputTokens + (callUsage.cacheReadTokens ?? 0) + (callUsage.cacheWriteTokens ?? 0) }
            store.settleBudget(day, config.provider, reservedCalls, reservedTokens, actual.calls, actual.tokens)
            if (callUsage !== null) {
              usage.callCount += 1
              usage.inputTokens += callUsage.inputTokens
              usage.outputTokens += callUsage.outputTokens
              usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (callUsage.cacheReadTokens ?? 0)
              usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (callUsage.cacheWriteTokens ?? 0)
            }
          },
        },
      })

      if (outcome.kind === 'skip') {
        // The evidence passed the host gates but produced nothing: a no-op
        // checkpoint advances the examined range so the same content is not
        // reprocessed on every future scan.
        const cursorUpdates = corpus.checkedThrough.map(range => ({ sessionId: range.sessionId, seq: range.seq, contentHash: rangeContentHash(range.texts) }))
          .filter(update => update.seq > (cursors.get(update.sessionId) ?? -1))
        logRun(ctx, 'info', {
          runId, workspaceShortHash: short(request.workspaceKey), trigger: request.trigger,
          sessionCount: scope.sessions.length, eventCount: corpus.units.length, evidenceBytes: corpus.totalBytes,
          code: outcome.errorCode, elapsedMs: Date.now() - startedAt, callCount: outcome.calls,
        })
        return commit('committed', outcome.errorCode, {
          candidates: [], challengeIds: [], cursors: cursorUpdates,
          workspace: { lastSuccessAt: Date.now(), failureCount: 0, nextEligibleAt: Date.now() + config.schedule.minSuccessIntervalMs },
        })
      }
      if (outcome.kind === 'fail') {
        logRun(ctx, 'warn', {
          runId, workspaceShortHash: short(request.workspaceKey), trigger: request.trigger,
          sessionCount: scope.sessions.length, eventCount: corpus.units.length, evidenceBytes: corpus.totalBytes,
          code: outcome.errorCode, elapsedMs: Date.now() - startedAt, callCount: outcome.calls,
        })
        return commit('failed', outcome.errorCode, {
          candidates: [], challengeIds: [], cursors: [],
          workspace: failureWorkspace(workspaces?.failureCount ?? 0, startedAt, config.schedule.retryBaseMs),
        })
      }

      const seeds = outcome.candidates.map(seed => ({ ...seed, workspaceKey: request.workspaceKey }))
      const cursorUpdates = corpus.checkedThrough.map(range => ({ sessionId: range.sessionId, seq: range.seq, contentHash: rangeContentHash(range.texts) }))
        .filter(update => update.seq > (cursors.get(update.sessionId) ?? -1))
      logRun(ctx, 'info', {
        runId, workspaceShortHash: short(request.workspaceKey), trigger: request.trigger,
        sessionCount: scope.sessions.length, eventCount: corpus.units.length, evidenceBytes: corpus.totalBytes,
        candidateCount: seeds.length, elapsedMs: Date.now() - startedAt, callCount: outcome.calls,
        tokenUsage: usage, fence: `${acquired.globalFence}/${acquired.workspaceFence}`,
      })
      return commit('committed', null, {
        candidates: seeds,
        challengeIds: outcome.challengeIds,
        cursors: cursorUpdates,
        workspace: { lastSuccessAt: Date.now(), failureCount: 0, nextEligibleAt: Date.now() + config.schedule.minSuccessIntervalMs },
      })
    } catch (error) {
      const code = abortCodeOf(error, controller)
      const cancelledCodes = new Set(['cancelled-by-foreground', 'user-cancelled', 'disposed', 'run-timeout'])
      logRun(ctx, 'warn', {
        runId, workspaceShortHash: short(request.workspaceKey), trigger: request.trigger,
        code, elapsedMs: Date.now() - startedAt, errorClass: error instanceof Error ? error.name : String(error),
      })
      return commit(cancelledCodes.has(code) ? 'cancelled' : 'failed', code, {
        candidates: [], challengeIds: [], cursors: [],
        workspace: cancelledCodes.has(code)
          ? null
          : failureWorkspace(workspaces?.failureCount ?? 0, startedAt, config.schedule.retryBaseMs),
      })
    }
  }
}

/** UTC day key used by the cross-process budget rows. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** Classified exponential backoff: base * 2^failures, capped at six doublings. */
export function backoffAt(baseMs: number, failureCount: number, now: number): number {
  const exponent = Math.min(Math.max(0, failureCount), 6)
  return now + baseMs * 2 ** exponent
}

function failureWorkspace(failureCount: number, startedAt: number, retryBaseMs: number): { lastSuccessAt: number | null; failureCount: number; nextEligibleAt: number } {
  return {
    lastSuccessAt: null,
    failureCount: failureCount + 1,
    nextEligibleAt: backoffAt(retryBaseMs, failureCount, startedAt),
  }
}

function abortCodeOf(error: unknown, controller: AbortController): string {
  if (controller.signal.aborted) {
    const reason = controller.signal.reason
    if (reason instanceof Error) {
      if (reason.message === 'run-timeout') return 'run-timeout'
      if (reason.message === 'lease-lost') return 'lease-lost'
      if (reason.message === 'cancelled-by-foreground') return 'cancelled-by-foreground'
      if (reason.message === 'user-cancelled') return 'user-cancelled'
      if (reason.message === 'disposed') return 'disposed'
    }
    return 'cancelled-by-foreground'
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'run-timeout'
  return error instanceof Error && error.name === 'DreamReflectionPhaseError'
    ? String((error as { code?: unknown }).code ?? 'model-failed')
    : 'model-failed'
}

function short(workspaceKey: string): string {
  return workspaceKey.slice(0, 8)
}

function clearIntervalSafe(timer: ReturnType<typeof setInterval> | null): void {
  if (timer !== null) clearInterval(timer)
}

function clearTimeoutSafe(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer !== null) clearTimeout(timer)
}

export type { RunUsage }
