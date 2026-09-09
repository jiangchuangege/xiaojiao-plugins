/**
 * SQLite provider for {@link DreamReflectionStore}: one database under
 * `$DSH_HOME/dream-reflection/state.sqlite`, WAL + busy timeout, monotonic
 * schema version, transaction-scoped leases with fencing, and the
 * cross-process daily budget.
 *
 * @module dsh-dream-reflection/store/sqlite
 */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
import { DreamReflectionStore } from './service.ts'
import type {
  AcquiredRun,
  CandidateRow,
  CandidateSeed,
  CandidateStatus,
  CommitRunPayload,
  CursorRow,
  RunRow,
  RunStatus,
  RunUsage,
  StoreMeta,
  WorkspaceRow,
} from './service.ts'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts'

export const name = 'dream-reflection-store-sqlite'

export interface Config {
  /** Absolute database path; empty resolves to `$DSH_HOME/dream-reflection/state.sqlite`. */
  path?: string
  busyTimeoutMs?: number
  leaseTtlMs?: number
}

export const Config: z<Config> = z.object({
  path: z.string().default(''),
  busyTimeoutMs: z.number().default(2000),
  leaseTtlMs: z.number().default(180000),
})

const GLOBAL_SCOPE = 'global'

interface CandidateJson {
  title: string
  summary: string
  claims: string
  limitations: string
  reviewQuestion: string
  sourceRefs: string
  nearVector: string
}

/** Structural validation of a staged candidate before it touches the database. */
function assertCandidateSeed(seed: CandidateSeed): void {
  if (seed.title.length === 0 || seed.summary.length === 0) throw new Error('candidate seed needs title and summary')
  if (!Array.isArray(seed.claims) || !Array.isArray(seed.limitations) || !Array.isArray(seed.sourceRefs)) {
    throw new Error('candidate seed claims/limitations/sourceRefs must be arrays')
  }
  if (!Array.isArray(seed.nearVector) || seed.nearVector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('candidate seed nearVector must be a finite number array')
  }
  for (const ref of seed.sourceRefs) {
    if (typeof ref !== 'object' || ref === null || typeof (ref as { ref?: unknown }).ref !== 'string') {
      throw new Error('candidate seed sourceRefs entries must carry a string ref')
    }
  }
}

/**
 * Concrete SQLite owner of `ctx.dreamReflectionStore`. Every multi-statement
 * transition is one `BEGIN IMMEDIATE` transaction inside this class; the
 * database handle is never exposed.
 */
export class SqliteDreamReflectionStore extends DreamReflectionStore {
  private db: DatabaseSync | null = null
  private readonly path: string
  private readonly busyTimeoutMs: number

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const path = config.path === undefined || config.path === ''
      ? join(resolveDshHome(), 'dream-reflection', 'state.sqlite')
      : config.path
    this.path = path
    this.busyTimeoutMs = config.busyTimeoutMs ?? 2000
  }

  override async open(): Promise<void> {
    if (this.db !== null) return
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.path, { timeout: this.busyTimeoutMs })
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.max(1, this.busyTimeoutMs)}`)
      db.exec('PRAGMA journal_mode = WAL')
      const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number }
      const version = versionRow.user_version
      if (version === 0) {
        db.exec(SCHEMA_SQL)
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('instanceSalt', randomBytes(32).toString('hex'))
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('promptVersions', '{}')
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(`dream-reflection store schema version ${version} is not supported (expected ${SCHEMA_VERSION})`)
      }
    } catch (error) {
      db.close()
      throw error
    }
    this.db = db
    if (process.platform !== 'win32') chmodSync(this.path, 0o600)
  }

  override async close(): Promise<void> {
    this.db?.close()
    this.db = null
  }

  private mustDb(): DatabaseSync {
    if (this.db === null) throw new Error('dream-reflection store is not open')
    return this.db
  }

  private transaction<T>(fn: () => T): T {
    const db = this.mustDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  override readMeta(): StoreMeta {
    const db = this.mustDb()
    const rows = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]
    const byKey = new Map(rows.map(row => [row.key, row.value]))
    return {
      schemaVersion: SCHEMA_VERSION,
      instanceSalt: byKey.get('instanceSalt') ?? '',
      promptVersions: JSON.parse(byKey.get('promptVersions') ?? '{}') as Record<string, number>,
    }
  }

  override writePromptVersion(id: string, version: number): void {
    const db = this.mustDb()
    const meta = this.readMeta()
    meta.promptVersions[id] = version
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('promptVersions', JSON.stringify(meta.promptVersions))
  }

  override getWorkspace(workspaceKey: string): WorkspaceRow | null {
    return this.mapWorkspace(this.mustDb().prepare('SELECT * FROM workspaces WHERE workspaceKey = ?').get(workspaceKey))
  }

  override upsertWorkspace(workspaceKey: string, patch: { lastSuccessAt?: number | null; nextEligibleAt?: number | null; failureCount?: number }): void {
    const db = this.mustDb()
    const current = this.getWorkspace(workspaceKey)
    const next: WorkspaceRow = current ?? { workspaceKey, revision: 0, lastSuccessAt: null, nextEligibleAt: null, failureCount: 0 }
    if (patch.lastSuccessAt !== undefined) next.lastSuccessAt = patch.lastSuccessAt
    if (patch.nextEligibleAt !== undefined) next.nextEligibleAt = patch.nextEligibleAt
    if (patch.failureCount !== undefined) next.failureCount = patch.failureCount
    next.revision = current === null ? 0 : current.revision + 1
    db.prepare(`INSERT INTO workspaces (workspaceKey, revision, lastSuccessAt, nextEligibleAt, failureCount)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspaceKey) DO UPDATE SET revision = excluded.revision, lastSuccessAt = excluded.lastSuccessAt,
        nextEligibleAt = excluded.nextEligibleAt, failureCount = excluded.failureCount`)
      .run(next.workspaceKey, next.revision, next.lastSuccessAt, next.nextEligibleAt, next.failureCount)
  }

  override listWorkspaces(): WorkspaceRow[] {
    return (this.mustDb().prepare('SELECT * FROM workspaces ORDER BY workspaceKey').all() as unknown[])
      .map(row => this.mapWorkspace(row))
      .filter((row): row is WorkspaceRow => row !== null)
  }

  private mapWorkspace(row: unknown): WorkspaceRow | null {
    const value = row as Record<string, unknown> | undefined
    if (value === undefined || typeof value.workspaceKey !== 'string') return null
    return {
      workspaceKey: value.workspaceKey,
      revision: Number(value.revision),
      lastSuccessAt: value.lastSuccessAt === null ? null : Number(value.lastSuccessAt),
      nextEligibleAt: value.nextEligibleAt === null ? null : Number(value.nextEligibleAt),
      failureCount: Number(value.failureCount),
    }
  }

  override getCursor(workspaceKey: string, sessionId: string): number | null {
    const row = this.mustDb().prepare('SELECT lastSettledSeq FROM cursors WHERE workspaceKey = ? AND sessionId = ?')
      .get(workspaceKey, sessionId) as { lastSettledSeq?: number } | undefined
    return row?.lastSettledSeq === undefined ? null : row.lastSettledSeq
  }

  override listCursors(workspaceKey: string): CursorRow[] {
    return this.mustDb().prepare('SELECT * FROM cursors WHERE workspaceKey = ?').all(workspaceKey) as unknown as CursorRow[]
  }

  override beginRun(seed: { runId: string; workspaceKey: string; trigger: 'auto' | 'manual'; phase: string; createdAt: number }, holderId: string, ttlMs: number, now: number): AcquiredRun | null {
    return this.transaction((): AcquiredRun | null => {
      const db = this.mustDb()
      db.prepare('DELETE FROM leases WHERE expiresAt <= ?').run(now)
      const global = db.prepare('SELECT 1 AS taken FROM leases WHERE scopeKey = ?').get(GLOBAL_SCOPE)
      if (global !== undefined) return null
      const workspace = db.prepare('SELECT 1 AS taken FROM leases WHERE scopeKey = ?').get(seed.workspaceKey)
      if (workspace !== undefined) return null
      const expiresAt = now + ttlMs
      const globalFence = this.nextFence(GLOBAL_SCOPE)
      const workspaceFence = this.nextFence(seed.workspaceKey)
      db.prepare('INSERT INTO leases (scopeKey, holderId, fence, expiresAt, heartbeatAt) VALUES (?, ?, ?, ?, ?)')
        .run(GLOBAL_SCOPE, holderId, globalFence, expiresAt, now)
      db.prepare('INSERT INTO leases (scopeKey, holderId, fence, expiresAt, heartbeatAt) VALUES (?, ?, ?, ?, ?)')
        .run(seed.workspaceKey, holderId, workspaceFence, expiresAt, now)
      db.prepare('INSERT INTO runs (runId, workspaceKey, trigger, status, phase, sourceDigest, usage, errorCode, createdAt, updatedAt, finishedAt) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)')
        .run(seed.runId, seed.workspaceKey, seed.trigger, 'running', seed.phase, seed.createdAt, seed.createdAt)
      return { globalFence, workspaceFence }
    })
  }

  private nextFence(scopeKey: string): number {
    const row = this.mustDb().prepare('SELECT COALESCE(MAX(fence), 0) AS fence FROM leases WHERE scopeKey = ?').get(scopeKey) as { fence: number }
    return row.fence + 1
  }

  override heartbeatRun(runId: string, holderId: string, globalFence: number, workspaceFence: number, ttlMs: number, now: number): boolean {
    return this.transaction((): boolean => {
      const db = this.mustDb()
      const run = db.prepare("SELECT workspaceKey FROM runs WHERE runId = ? AND status = 'running'").get(runId) as { workspaceKey: string } | undefined
      if (run === undefined) return false
      const expiresAt = now + ttlMs
      const global = db.prepare('UPDATE leases SET heartbeatAt = ?, expiresAt = ? WHERE scopeKey = ? AND holderId = ? AND fence = ?')
        .run(now, expiresAt, GLOBAL_SCOPE, holderId, globalFence)
      const workspace = db.prepare('UPDATE leases SET heartbeatAt = ?, expiresAt = ? WHERE scopeKey = ? AND holderId = ? AND fence = ?')
        .run(now, expiresAt, run.workspaceKey, holderId, workspaceFence)
      return Number(global.changes) === 1 && Number(workspace.changes) === 1
    })
  }

  override commitRun(payload: CommitRunPayload): boolean {
    return this.transaction((): boolean => {
      const db = this.mustDb()
      const running = db.prepare("SELECT 1 AS running FROM runs WHERE runId = ? AND status = 'running'").get(payload.runId)
      if (running === undefined) return false
      const releasedGlobal = db.prepare('DELETE FROM leases WHERE scopeKey = ? AND holderId = ? AND fence = ?')
        .run(GLOBAL_SCOPE, payload.holderId, payload.globalFence)
      if (Number(releasedGlobal.changes) !== 1) return false
      const releasedWorkspace = db.prepare('DELETE FROM leases WHERE scopeKey = ? AND holderId = ? AND fence = ?')
        .run(payload.workspaceKey, payload.holderId, payload.workspaceFence)
      if (Number(releasedWorkspace.changes) !== 1) return false
      for (const candidate of payload.candidates) {
        assertCandidateSeed(candidate)
        const json = candidateJson(candidate)
        db.prepare(`INSERT INTO candidates (candidateId, workspaceKey, status, confidence, title, summary, claims, limitations, reviewQuestion, sourceRefs, contentHash, nearVector, revision, createdAt, updatedAt, decidedAt)
          VALUES (?, ?, 'quarantined', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`)
          .run(candidate.candidateId, payload.workspaceKey, candidate.confidence, candidate.title, candidate.summary,
            json.claims, json.limitations, candidate.reviewQuestion, json.sourceRefs, candidate.contentHash, json.nearVector,
            candidate.createdAt, candidate.createdAt)
      }
      for (const candidateId of payload.challengeIds) {
        db.prepare("UPDATE candidates SET status = 'challenged', revision = revision + 1, decidedAt = ?, updatedAt = ? WHERE candidateId = ? AND status IN ('approved', 'quarantined')")
          .run(payload.finishedAt, payload.finishedAt, candidateId)
      }
      for (const cursor of payload.cursors) {
        db.prepare(`INSERT INTO cursors (workspaceKey, sessionId, lastSettledSeq, contentHash) VALUES (?, ?, ?, ?)
          ON CONFLICT(workspaceKey, sessionId) DO UPDATE SET lastSettledSeq = excluded.lastSettledSeq, contentHash = excluded.contentHash`)
          .run(payload.workspaceKey, cursor.sessionId, cursor.seq, cursor.contentHash)
      }
      if (payload.workspace !== null) {
        db.prepare(`INSERT INTO workspaces (workspaceKey, revision, lastSuccessAt, nextEligibleAt, failureCount) VALUES (?, 1, ?, ?, ?)
          ON CONFLICT(workspaceKey) DO UPDATE SET revision = workspaces.revision + 1,
            lastSuccessAt = excluded.lastSuccessAt, nextEligibleAt = excluded.nextEligibleAt, failureCount = excluded.failureCount`)
          .run(payload.workspaceKey, payload.workspace.lastSuccessAt, payload.workspace.nextEligibleAt, payload.workspace.failureCount)
      }
      db.prepare(`UPDATE runs SET status = ?, phase = NULL, usage = ?, errorCode = ?, updatedAt = ?, finishedAt = ? WHERE runId = ?`)
        .run(payload.status, payload.usage === null ? null : JSON.stringify(payload.usage), payload.errorCode, payload.finishedAt, payload.finishedAt, payload.runId)
      return true
    })
  }

  override getRun(runId: string): RunRow | null {
    return this.mapRun(this.mustDb().prepare('SELECT * FROM runs WHERE runId = ?').get(runId))
  }

  override listRuns(workspaceKey: string, limit: number): RunRow[] {
    return (this.mustDb().prepare('SELECT * FROM runs WHERE workspaceKey = ? ORDER BY createdAt DESC LIMIT ?').all(workspaceKey, limit) as unknown[])
      .map(row => this.mapRun(row))
      .filter((row): row is RunRow => row !== null)
  }

  private mapRun(row: unknown): RunRow | null {
    const value = row as Record<string, unknown> | undefined
    if (value === undefined || typeof value.runId !== 'string' || typeof value.workspaceKey !== 'string') return null
    return {
      runId: value.runId,
      workspaceKey: value.workspaceKey,
      trigger: value.trigger === 'manual' ? 'manual' : 'auto',
      status: String(value.status) as RunStatus,
      phase: value.phase === null ? null : String(value.phase),
      sourceDigest: value.sourceDigest === null ? null : String(value.sourceDigest),
      usage: value.usage === null ? null : JSON.parse(String(value.usage)) as RunUsage,
      errorCode: value.errorCode === null ? null : String(value.errorCode),
      createdAt: Number(value.createdAt),
      updatedAt: Number(value.updatedAt),
      finishedAt: value.finishedAt === null ? null : Number(value.finishedAt),
    }
  }

  override getCandidate(candidateId: string): CandidateRow | null {
    return this.mapCandidate(this.mustDb().prepare('SELECT * FROM candidates WHERE candidateId = ?').get(candidateId))
  }

  override listCandidates(workspaceKey: string, statuses?: readonly CandidateStatus[]): CandidateRow[] {
    const base = 'SELECT * FROM candidates WHERE workspaceKey = ?'
    const rows = statuses === undefined || statuses.length === 0
      ? this.mustDb().prepare(`${base} ORDER BY createdAt ASC`).all(workspaceKey)
      : this.mustDb().prepare(`${base} AND status IN (${statuses.map(() => '?').join(', ')}) ORDER BY createdAt ASC`).all(workspaceKey, ...statuses)
    return (rows as unknown[]).map(row => this.mapCandidate(row)).filter((row): row is CandidateRow => row !== null)
  }

  private mapCandidate(row: unknown): CandidateRow | null {
    const value = row as Record<string, unknown> | undefined
    if (value === undefined || typeof value.candidateId !== 'string' || typeof value.workspaceKey !== 'string') return null
    return {
      candidateId: value.candidateId,
      workspaceKey: value.workspaceKey,
      status: String(value.status) as CandidateStatus,
      confidence: String(value.confidence) as CandidateRow['confidence'],
      title: String(value.title),
      summary: String(value.summary),
      claims: JSON.parse(String(value.claims)) as CandidateRow['claims'],
      limitations: JSON.parse(String(value.limitations)) as string[],
      reviewQuestion: String(value.reviewQuestion),
      sourceRefs: JSON.parse(String(value.sourceRefs)) as CandidateRow['sourceRefs'],
      contentHash: String(value.contentHash),
      nearVector: JSON.parse(String(value.nearVector)) as number[],
      revision: Number(value.revision),
      createdAt: Number(value.createdAt),
      updatedAt: Number(value.updatedAt),
      decidedAt: value.decidedAt === null ? null : Number(value.decidedAt),
    }
  }

  override reviewCandidate(candidateId: string, revision: number, fromStatuses: readonly CandidateStatus[], toStatus: CandidateStatus, decidedAt: number): { ok: boolean; revision: number } {
    return this.transaction((): { ok: boolean; revision: number } => {
      const db = this.mustDb()
      const placeholders = fromStatuses.map(() => '?').join(', ')
      const result = db.prepare(`UPDATE candidates SET status = ?, decidedAt = ?, updatedAt = ?, revision = revision + 1
        WHERE candidateId = ? AND revision = ? AND status IN (${placeholders})`)
        .run(toStatus, decidedAt, decidedAt, candidateId, revision, ...fromStatuses)
      if (Number(result.changes) !== 1) return { ok: false, revision }
      const row = db.prepare('SELECT revision FROM candidates WHERE candidateId = ?').get(candidateId) as { revision: number }
      return { ok: true, revision: row.revision }
    })
  }

  override hasLease(scopeKey: string): boolean {
    return this.mustDb().prepare('SELECT 1 AS taken FROM leases WHERE scopeKey = ?').get(scopeKey) !== undefined
  }

  override budgetAllows(day: string, provider: string, limitCalls: number, limitTokens: number): boolean {
    const row = this.mustDb().prepare('SELECT actualCalls, reservedCalls, actualTokens, reservedTokens FROM budget WHERE day = ? AND provider = ?')
      .get(day, provider) as { actualCalls: number; reservedCalls: number; actualTokens: number; reservedTokens: number } | undefined
    return (row?.actualCalls ?? 0) + (row?.reservedCalls ?? 0) < limitCalls
      && (row?.actualTokens ?? 0) + (row?.reservedTokens ?? 0) < limitTokens
  }

  override reserveBudget(day: string, provider: string, calls: number, tokens: number, limitCalls: number, limitTokens: number): boolean {
    return this.transaction((): boolean => {
      const db = this.mustDb()
      const row = db.prepare('SELECT actualCalls, reservedCalls, actualTokens, reservedTokens FROM budget WHERE day = ? AND provider = ?').get(day, provider) as { actualCalls: number; reservedCalls: number; actualTokens: number; reservedTokens: number } | undefined
      const reservedCalls = row?.reservedCalls ?? 0
      const reservedTokens = row?.reservedTokens ?? 0
      // Daily caps are cumulative: reserved (in-flight) plus settled actuals.
      if ((row?.actualCalls ?? 0) + reservedCalls + calls > limitCalls || (row?.actualTokens ?? 0) + reservedTokens + tokens > limitTokens) return false
      db.prepare(`INSERT INTO budget (day, provider, reservedCalls, actualCalls, reservedTokens, actualTokens) VALUES (?, ?, ?, 0, ?, 0)
        ON CONFLICT(day, provider) DO UPDATE SET reservedCalls = reservedCalls + excluded.reservedCalls, reservedTokens = reservedTokens + excluded.reservedTokens`)
        .run(day, provider, calls, tokens)
      return true
    })
  }

  override settleBudget(day: string, provider: string, reservedCalls: number, reservedTokens: number, actualCalls: number, actualTokens: number): void {
    this.transaction((): void => {
      this.mustDb().prepare(`UPDATE budget SET
        reservedCalls = MAX(0, reservedCalls - ?), reservedTokens = MAX(0, reservedTokens - ?),
        actualCalls = actualCalls + ?, actualTokens = actualTokens + ?
        WHERE day = ? AND provider = ?`)
        .run(reservedCalls, reservedTokens, actualCalls, actualTokens, day, provider)
    })
  }

  override readApprovedContext(workspaceKey: string, maxBytes: number): string {
    const rows = this.mustDb().prepare(`SELECT title, summary, claims, limitations FROM candidates
      WHERE workspaceKey = ? AND status = 'approved' ORDER BY decidedAt ASC, createdAt ASC`).all(workspaceKey) as unknown as { title: string; summary: string; claims: string; limitations: string }[]
    const sections: string[] = []
    let budget = 0
    for (const row of rows) {
      const claims = JSON.parse(row.claims) as unknown
      const claimTexts = Array.isArray(claims)
        ? (claims as { text?: unknown }[]).map(claim => typeof claim?.text === 'string' ? claim.text : '').filter(text => text !== '')
        : []
      const limitations = JSON.parse(row.limitations) as unknown
      const limitationTexts = Array.isArray(limitations)
        ? limitations.filter((value): value is string => typeof value === 'string')
        : []
      const block = [
        `- ${row.title}`,
        `  ${row.summary}`,
        ...claimTexts.map(text => `  claim: ${text}`),
        ...limitationTexts.map(text => `  limitation: ${text}`),
      ].join('\n')
      const size = Buffer.byteLength(block, 'utf8') + 1
      if (budget + size > maxBytes) break
      sections.push(block)
      budget += size
    }
    return sections.join('\n')
  }

  override recover(ttlMs: number, now: number): { abandoned: number } {
    return this.transaction((): { abandoned: number } => {
      const db = this.mustDb()
      db.prepare('DELETE FROM leases WHERE expiresAt <= ?').run(now)
      const running = db.prepare("SELECT runId, workspaceKey FROM runs WHERE status = 'running'").all() as { runId: string; workspaceKey: string }[]
      let abandoned = 0
      for (const run of running) {
        const global = db.prepare('SELECT 1 AS alive FROM leases WHERE scopeKey = ?').get(GLOBAL_SCOPE)
        const workspace = db.prepare('SELECT 1 AS alive FROM leases WHERE scopeKey = ?').get(run.workspaceKey)
        if (global === undefined || workspace === undefined) {
          db.prepare("UPDATE runs SET status = 'abandoned', errorCode = 'lease-lost', updatedAt = ?, finishedAt = ? WHERE runId = ?")
            .run(now, now, run.runId)
          abandoned += 1
        }
      }
      void ttlMs
      return { abandoned }
    })
  }

  override pruneRuns(beforeMs: number): number {
    return Number(this.mustDb().prepare('DELETE FROM runs WHERE finishedAt IS NOT NULL AND finishedAt < ?').run(beforeMs).changes)
  }

  override pruneQuarantine(beforeMs: number): number {
    return Number(this.mustDb().prepare("DELETE FROM candidates WHERE status = 'quarantined' AND createdAt < ?").run(beforeMs).changes)
  }
}

/** Serialize the JSON columns of one staged candidate. */
function candidateJson(candidate: CandidateSeed): CandidateJson {
  return {
    title: candidate.title,
    summary: candidate.summary,
    claims: JSON.stringify(candidate.claims),
    limitations: JSON.stringify(candidate.limitations),
    reviewQuestion: candidate.reviewQuestion,
    sourceRefs: JSON.stringify(candidate.sourceRefs),
    nearVector: JSON.stringify(candidate.nearVector),
  }
}

export default SqliteDreamReflectionStore
