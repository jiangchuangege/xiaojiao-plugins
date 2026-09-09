/**
 * The fixed-interval eligibility scanner: one process-local pump guard merges
 * overlapping ticks (at most one pending scan survives), each scan starts at
 * most one workspace run, and wall-clock regressions never replay history.
 *
 * @module dsh-dream-reflection/scheduler/scanner
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../config.ts'
import type { DreamReflectionStore, WorkspaceRow } from '../store/service.ts'
import type { RunCoordinator } from '../reflection/coordinator.ts'
import type { CorpusSession } from '../corpus/build.ts'
import { buildCorpus } from '../corpus/build.ts'
import { redactor } from '../safety/redact.ts'
import { evaluateEligibility, rankWorkspaces } from './eligibility.ts'
import { logRun } from '../observability.ts'
import type { SkipCode } from '../observability.ts'

export interface WorkspaceEntry {
  canonicalCwd: string
  sessions: CorpusSession[]
}

export interface ScanDeps {
  ctx: Context
  config: ResolvedConfig
  store: DreamReflectionStore
  coordinator: RunCoordinator
  /** Engine-owned workspace mapping; only in-scope workspaces appear. */
  buildWorkspaceMap: () => Promise<ReadonlyMap<string, WorkspaceEntry>>
  /** Engine-owned foreground state keyed by workspaceKey. */
  foreground: () => ReadonlyMap<string, { statuses: readonly ('idle' | 'running')[]; lastBusyAt: number | null }>
  providerReady: () => boolean
  /** SessionQuery for the content probe. */
  sessionQuery: import('@deepseek-ai/dsh-session-query').SessionQueryEngine
}

export class Scanner {
  private readonly deps: ScanDeps
  private scanning = false
  private pending = false
  private lastScanAt = 0
  private disposed = false

  constructor(deps: ScanDeps) {
    this.deps = deps
  }

  /** Recovery plus one startup scan; call once after the store opens. */
  async start(): Promise<void> {
    const { store, config, ctx } = this.deps
    const now = Date.now()
    const recovered = store.recover(config.store.leaseTtlMs, now)
    if (recovered.abandoned > 0) {
      ctx.logger('dream-reflection').warn(`recovery: ${recovered.abandoned} run(s) marked abandoned`)
    }
    const prunedRuns = store.pruneRuns(now - config.retention.runLedgerDays * 24 * 3600 * 1000)
    const prunedCandidates = store.pruneQuarantine(now - config.retention.quarantineDays * 24 * 3600 * 1000)
    if (prunedRuns > 0 || prunedCandidates > 0) {
      ctx.logger('dream-reflection').info(`retention: runs=${prunedRuns} candidates=${prunedCandidates}`)
    }
    this.lastScanAt = now
    await this.scan('startup')
  }

  /** One eligibility pass; overlapping calls collapse into one pending rescan. */
  async scan(reason: 'startup' | 'timer' | 'manual'): Promise<void> {
    if (this.disposed) return
    if (this.scanning) {
      this.pending = true
      return
    }
    this.scanning = true
    try {
      await this.scanOnce(reason)
    } finally {
      this.scanning = false
      if (this.pending && !this.disposed) {
        this.pending = false
        void this.scan('timer')
      }
    }
  }

  private async scanOnce(reason: 'startup' | 'timer' | 'manual'): Promise<void> {
    const { ctx, config, store, coordinator } = this.deps
    if (!config.enabled) return
    const now = Date.now()
    if (now < this.lastScanAt) {
      // Wall clock moved backwards: wait for a monotonic boundary, never replay.
      ctx.logger('dream-reflection').warn(`clock-regressed: last=${this.lastScanAt} now=${now}`)
      this.lastScanAt = now
      return
    }
    this.lastScanAt = now
    if (!this.deps.providerReady()) {
      ctx.logger('dream-reflection').warn('scan skipped: provider-unavailable')
      return
    }
    const day = new Date(now).toISOString().slice(0, 10)
    const workspaceMap = await this.deps.buildWorkspaceMap()
    const foreground = this.deps.foreground()

    const candidates: { workspaceKey: string; entry: WorkspaceEntry; workspace: WorkspaceRow | null; earliestCursor: number | null }[] = []
    const skipped: { workspaceKey: string; code: string }[] = []
    for (const [workspaceKey, entry] of workspaceMap) {
      const workspace = store.getWorkspace(workspaceKey)
      const fg = foreground.get(workspaceKey)
      const statuses = fg?.statuses ?? []
      const probe = await this.probe(workspaceKey, entry)
      const decision = evaluateEligibility({
        now,
        enabled: config.enabled,
        providerReady: true,
        liveRootStatuses: statuses,
        lastBusyAt: fg?.lastBusyAt ?? null,
        quietForMs: config.schedule.quietForMs,
        minSuccessIntervalMs: config.schedule.minSuccessIntervalMs,
        workspace,
        evidenceBytes: probe.bytes,
        minNewTextBytes: config.corpus.minNewTextBytes,
        pressureTextBytes: config.corpus.pressureTextBytes,
        budgetAllows: store.budgetAllows(day, config.provider, config.limits.dailyCallLimit, config.limits.dailyTokenLimit),
        leaseFree: !store.hasLease('global') && !store.hasLease(workspaceKey),
      })
      if (decision.eligible) {
        candidates.push({ workspaceKey, entry, workspace, earliestCursor: probe.earliestCursor })
      } else {
        skipped.push({ workspaceKey, code: decision.skipCode })
      }
    }
    for (const skip of skipped) {
      logRun(ctx, 'info', { runId: 'scan', workspaceShortHash: skip.workspaceKey.slice(0, 8), trigger: 'auto', code: skip.code as SkipCode })
    }
    if (candidates.length === 0) return
    const ordered = rankWorkspaces(candidates.map(candidate => ({ workspaceKey: candidate.workspaceKey, workspace: candidate.workspace, earliestCursor: candidate.earliestCursor })))
    const chosen = candidates.find(candidate => candidate.workspaceKey === ordered[0])
    if (chosen === undefined) return
    // One workspace per scan; the coordinator queues the rest across ticks.
    void coordinator.request({ trigger: 'auto', workspaceKey: chosen.workspaceKey, canonicalCwd: chosen.entry.canonicalCwd })
    void reason
  }

  /** Cheap content probe: bounded corpus bytes and the earliest backlog cursor. */
  private async probe(workspaceKey: string, entry: WorkspaceEntry): Promise<{ bytes: number; earliestCursor: number | null }> {
    const { store, config } = this.deps
    const cursors = new Map<string, number>()
    let earliestCursor: number | null = null
    for (const session of entry.sessions) {
      const stored = store.getCursor(workspaceKey, session.sessionId)
      if (stored !== null) cursors.set(session.sessionId, stored)
      const floor = Math.max(stored ?? 0, session.header.seedLength ?? 0)
      if (earliestCursor === null || floor < earliestCursor) earliestCursor = floor
    }
    try {
      const result = await buildCorpus(entry.sessions, {
        sessionQuery: this.deps.sessionQuery,
        redact: redactor,
        maxSessions: config.corpus.maxSessions,
        maxEvents: config.corpus.maxEvents,
        maxEventBytes: config.corpus.maxEventBytes,
        maxInputBytes: config.corpus.maxInputBytes,
        cursors,
        stopAtBytes: config.corpus.pressureTextBytes,
      })
      return { bytes: result.totalBytes, earliestCursor }
    } catch {
      return { bytes: 0, earliestCursor }
    }
  }

  dispose(): void {
    this.disposed = true
  }
}
