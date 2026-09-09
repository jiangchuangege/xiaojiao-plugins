/**
 * Service Definition for the plugin's durable state: runs, candidates,
 * cursors, leases with fencing, and the cross-process daily budget.
 *
 * The contract is backend-neutral; the bundled SQLite provider owns every
 * multi-statement transaction (engine code never opens a transaction itself).
 * Reads and small writes are synchronous so the system-prompt context
 * provider can render approved cards on every assembly without a cache.
 *
 * @module dsh-dream-reflection/store/service
 */

import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dreamReflectionStore: DreamReflectionStore
  }
}

export type RunTrigger = 'auto' | 'manual'
export type RunStatus = 'running' | 'committed' | 'failed' | 'abandoned' | 'cancelled'
export type CandidateStatus = 'quarantined' | 'approved' | 'rejected' | 'challenged'
export type CandidateConfidence = 'low' | 'medium' | 'high'

export interface RunUsage {
  callCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface RunRow {
  runId: string
  workspaceKey: string
  trigger: RunTrigger
  status: RunStatus
  phase: string | null
  sourceDigest: string | null
  usage: RunUsage | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}

export interface WorkspaceRow {
  workspaceKey: string
  revision: number
  lastSuccessAt: number | null
  nextEligibleAt: number | null
  failureCount: number
}

export interface CursorRow {
  workspaceKey: string
  sessionId: string
  lastSettledSeq: number
  contentHash: string
}

export interface SourceRef {
  ref: string
  sessionId: string
  seq: number
  eventType: string
  contentHash: string
}

export interface CandidateClaim {
  text: string
  evidenceRefs: string[]
}

export interface CandidateRow {
  candidateId: string
  workspaceKey: string
  status: CandidateStatus
  confidence: CandidateConfidence
  title: string
  summary: string
  claims: CandidateClaim[]
  limitations: string[]
  reviewQuestion: string
  sourceRefs: SourceRef[]
  contentHash: string
  nearVector: number[]
  revision: number
  createdAt: number
  updatedAt: number
  decidedAt: number | null
}

export interface CandidateSeed extends Omit<CandidateRow, 'revision' | 'updatedAt' | 'decidedAt' | 'status'> {
  status: 'quarantined'
}

export interface CommitCursor { sessionId: string; seq: number; contentHash: string }

export interface CommitWorkspace {
  lastSuccessAt: number | null
  failureCount: number
  nextEligibleAt: number | null
}

export interface CommitRunPayload {
  runId: string
  workspaceKey: string
  holderId: string
  globalFence: number
  workspaceFence: number
  status: 'committed' | 'failed' | 'cancelled'
  errorCode: string | null
  usage: RunUsage | null
  candidates: CandidateSeed[]
  challengeIds: string[]
  cursors: CommitCursor[]
  workspace: CommitWorkspace | null
  finishedAt: number
}

export interface AcquiredRun {
  globalFence: number
  workspaceFence: number
}

export interface StoreMeta {
  schemaVersion: number
  instanceSalt: string
  promptVersions: Record<string, number>
}

/**
 * Durable-state contract owned by the SQLite provider in V1. All multi-row
 * consistency work happens inside the provider's transaction methods; engine
 * code only ever calls one method per state transition.
 */
export abstract class DreamReflectionStore extends Service {
  constructor(ctx: Context, name: string = 'dreamReflectionStore') {
    super(ctx, name)
  }

  abstract open(): Promise<void>
  abstract close(): Promise<void>

  abstract readMeta(): StoreMeta
  abstract writePromptVersion(id: string, version: number): void

  abstract getWorkspace(workspaceKey: string): WorkspaceRow | null
  abstract upsertWorkspace(workspaceKey: string, patch: { lastSuccessAt?: number | null; nextEligibleAt?: number | null; failureCount?: number }): void
  abstract listWorkspaces(): WorkspaceRow[]

  abstract getCursor(workspaceKey: string, sessionId: string): number | null
  abstract listCursors(workspaceKey: string): CursorRow[]

  /** Acquire global + workspace leases and open the run row in one transaction. */
  abstract beginRun(seed: { runId: string; workspaceKey: string; trigger: RunTrigger; phase: string; createdAt: number }, holderId: string, ttlMs: number, now: number): AcquiredRun | null
  /** Refresh both leases only while holder and fences still match. */
  abstract heartbeatRun(runId: string, holderId: string, globalFence: number, workspaceFence: number, ttlMs: number, now: number): boolean
  /**
   * The single authoritative settlement: verify running status and both
   * fences, then write candidates, challenges, cursors, workspace state, run
   * outcome, and release both leases — atomically.
   * @returns false when the run was already settled or the fences no longer match.
   */
  abstract commitRun(payload: CommitRunPayload): boolean

  abstract getRun(runId: string): RunRow | null
  abstract listRuns(workspaceKey: string, limit: number): RunRow[]

  /** Cheap read-only eligibility pre-checks (the authoritative gates are transactional). */
  abstract hasLease(scopeKey: string): boolean
  abstract budgetAllows(day: string, provider: string, limitCalls: number, limitTokens: number): boolean

  abstract getCandidate(candidateId: string): CandidateRow | null
  abstract listCandidates(workspaceKey: string, statuses?: readonly CandidateStatus[]): CandidateRow[]
  /** CAS review: moves the candidate when its revision still matches. */
  abstract reviewCandidate(candidateId: string, revision: number, fromStatuses: readonly CandidateStatus[], toStatus: CandidateStatus, decidedAt: number): { ok: boolean; revision: number }

  abstract reserveBudget(day: string, provider: string, calls: number, tokens: number, limitCalls: number, limitTokens: number): boolean
  abstract settleBudget(day: string, provider: string, reservedCalls: number, reservedTokens: number, actualCalls: number, actualTokens: number): void

  /** Synchronous approved-card rendering for the system-prompt context provider. */
  abstract readApprovedContext(workspaceKey: string, maxBytes: number): string

  /** Startup recovery: abandon runs whose leases are gone, delete stale leases. */
  abstract recover(ttlMs: number, now: number): { abandoned: number }
  abstract pruneRuns(beforeMs: number): number
  abstract pruneQuarantine(beforeMs: number): number
}

export default DreamReflectionStore
