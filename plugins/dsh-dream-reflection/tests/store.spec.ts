import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SqliteDreamReflectionStore } from '../src/store/sqlite.ts'
import type { CandidateSeed } from '../src/store/service.ts'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function openStore(path: string): Promise<SqliteDreamReflectionStore> {
  const ctx = new Context()
  const store = new SqliteDreamReflectionStore(ctx, { path, busyTimeoutMs: 2000, leaseTtlMs: 5000 })
  await store.open()
  return store
}

function seed(workspaceKey: string, title: string, candidateId = `cand-${title}`): CandidateSeed {
  return {
    candidateId,
    workspaceKey,
    status: 'quarantined',
    confidence: 'medium',
    title,
    summary: `summary of ${title}`,
    claims: [{ text: `claim of ${title}`, evidenceRefs: ['e0'] }],
    limitations: ['limited'],
    reviewQuestion: 'is it right?',
    sourceRefs: [{ ref: 'e0', sessionId: 's1', seq: 1, eventType: 'user/message', contentHash: 'h' }],
    contentHash: `hash-${title}`,
    nearVector: [0, 1],
    createdAt: 1000,
  }
}

describe('sqlite store: leases, fencing, and atomic settlement', () => {
  it('acquires global + workspace leases and refuses a second holder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-store-'))
    tempDirs.push(dir)
    const store = await openStore(join(dir, 'state.sqlite'))
    const acquired = store.beginRun({ runId: 'r1', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: 100 }, 'holder-a', 5000, 100)
    expect(acquired).toEqual({ globalFence: 1, workspaceFence: 1 })
    expect(store.beginRun({ runId: 'r2', workspaceKey: 'w2', trigger: 'auto', phase: 'queued', createdAt: 100 }, 'holder-b', 5000, 100)).toBeNull()
    // Same workspace also blocked (covered by the global lease).
    expect(store.beginRun({ runId: 'r3', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: 100 }, 'holder-c', 5000, 100)).toBeNull()
    await store.close()
  })

  it('heartbeats only while holder and fences match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-store-'))
    tempDirs.push(dir)
    const store = await openStore(join(dir, 'state.sqlite'))
    const acquired = store.beginRun({ runId: 'r1', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: 100 }, 'holder-a', 5000, 100)!
    expect(store.heartbeatRun('r1', 'holder-a', acquired.globalFence, acquired.workspaceFence, 5000, 200)).toBe(true)
    expect(store.heartbeatRun('r1', 'holder-b', acquired.globalFence, acquired.workspaceFence, 5000, 200)).toBe(false)
    expect(store.heartbeatRun('r1', 'holder-a', acquired.globalFence + 1, acquired.workspaceFence, 5000, 200)).toBe(false)
    await store.close()
  })

  it('first settlement wins; a stale fence can never commit twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-store-'))
    tempDirs.push(dir)
    const path = join(dir, 'state.sqlite')
    const store = await openStore(path)
    const acquired = store.beginRun({ runId: 'r1', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: 100 }, 'holder-a', 5000, 100)!
    const payload = {
      workspaceKey: 'w1',
      candidates: [seed('w1', 'first')],
      challengeIds: [],
      cursors: [{ sessionId: 's1', seq: 5, contentHash: 'h5' }],
      workspace: { lastSuccessAt: 1000, failureCount: 0, nextEligibleAt: 2000 },
      finishedAt: 1000,
    }
    expect(store.commitRun({ runId: 'r1', holderId: 'holder-a', globalFence: acquired.globalFence, workspaceFence: acquired.workspaceFence, status: 'committed', errorCode: null, usage: { callCount: 1, inputTokens: 10, outputTokens: 5 }, ...payload })).toBe(true)
    // Second commit with the same fences: the run row is no longer running.
    expect(store.commitRun({ runId: 'r1', holderId: 'holder-a', globalFence: acquired.globalFence, workspaceFence: acquired.workspaceFence, status: 'committed', errorCode: null, usage: null, finishedAt: 1100, ...payload, candidates: [] })).toBe(false)
    expect(store.getCandidate('cand-first')?.status).toBe('quarantined')
    expect(store.getCursor('w1', 's1')).toBe(5)
    expect(store.getRun('r1')?.status).toBe('committed')
    expect(store.hasLease('global')).toBe(false)
    expect(store.hasLease('w1')).toBe(false)
    await store.close()
  })

  it('lets a second process take over after lease expiry and marks the run abandoned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-store-'))
    tempDirs.push(dir)
    const path = join(dir, 'state.sqlite')
    const first = await openStore(path)
    first.beginRun({ runId: 'r1', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: 100 }, 'holder-a', 5000, 100)
    const second = await openStore(path)
    // Leases still alive: recovery leaves the run alone.
    expect(second.recover(5000, 500).abandoned).toBe(0)
    // Leases expire: recovery abandons the run and frees the scopes.
    const recovered = second.recover(5000, 10_000)
    expect(recovered.abandoned).toBe(1)
    expect(second.getRun('r1')?.status).toBe('abandoned')
    expect(second.beginRun({ runId: 'r2', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: 10_000 }, 'holder-b', 5000, 10_000)).not.toBeNull()
    await first.close()
    await second.close()
  })

  it('rejects an unsupported schema version at open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-store-'))
    tempDirs.push(dir)
    const path = join(dir, 'state.sqlite')
    const store = await openStore(path)
    store['mustDb']().exec('PRAGMA user_version = 99')
    await store.close()
    const ctx = new Context()
    const reopened = new SqliteDreamReflectionStore(ctx, { path, busyTimeoutMs: 2000, leaseTtlMs: 5000 })
    await expect(reopened.open()).rejects.toThrow(/schema version 99/)
  })
})

describe('sqlite store: budget, review CAS, retention', () => {
  it('reserves and settles the daily budget across instances; missing usage stays reserved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-store-'))
    tempDirs.push(dir)
    const path = join(dir, 'state.sqlite')
    const store = await openStore(path)
    expect(store.reserveBudget('2026-08-13', 'p', 1, 100, 2, 300)).toBe(true)
    expect(store.reserveBudget('2026-08-13', 'p', 1, 100, 2, 300)).toBe(true)
    expect(store.reserveBudget('2026-08-13', 'p', 1, 100, 2, 300)).toBe(false)
    // Cumulative caps: actual + reserved counts against the daily limit.
    store.settleBudget('2026-08-13', 'p', 1, 100, 1, 80)
    expect(store.budgetAllows('2026-08-13', 'p', 2, 300)).toBe(false)
    store.settleBudget('2026-08-13', 'p', 1, 100, 1, 80)
    expect(store.budgetAllows('2026-08-13', 'p', 2, 300)).toBe(false)
    expect(store.budgetAllows('2026-08-13', 'p', 3, 300)).toBe(true)
    await store.close()
  })

  it('reviews candidates through revision CAS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-store-'))
    tempDirs.push(dir)
    const store = await openStore(join(dir, 'state.sqlite'))
    const fences = store.beginRun({ runId: 'r1', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: 100 }, 'h', 5000, 100)!
    store.commitRun({
      runId: 'r1', workspaceKey: 'w1', holderId: 'h', globalFence: fences.globalFence, workspaceFence: fences.workspaceFence,
      status: 'committed', errorCode: null, usage: null, finishedAt: 100,
      candidates: [seed('w1', 'alpha')], challengeIds: [], cursors: [], workspace: null,
    })
    expect(store.reviewCandidate('cand-alpha', 0, ['quarantined'], 'approved', 200).ok).toBe(true)
    expect(store.getCandidate('cand-alpha')?.status).toBe('approved')
    // Stale revision fails.
    expect(store.reviewCandidate('cand-alpha', 0, ['quarantined'], 'rejected', 300).ok).toBe(false)
    await store.close()
  })

  it('renders approved context within the byte budget, stable order, never other statuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-store-'))
    tempDirs.push(dir)
    const store = await openStore(join(dir, 'state.sqlite'))
    const fences = store.beginRun({ runId: 'r1', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: 100 }, 'h', 5000, 100)!
    store.commitRun({
      runId: 'r1', workspaceKey: 'w1', holderId: 'h', globalFence: fences.globalFence, workspaceFence: fences.workspaceFence,
      status: 'committed', errorCode: null, usage: null, finishedAt: 100,
      candidates: [seed('w1', 'alpha'), seed('w1', 'beta'), seed('w1', 'rejected-one')], challengeIds: [], cursors: [], workspace: null,
    })
    store.reviewCandidate('cand-alpha', 0, ['quarantined'], 'approved', 100)
    store.reviewCandidate('cand-beta', 0, ['quarantined'], 'approved', 200)
    const text = store.readApprovedContext('w1', 10_000)
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).not.toContain('rejected-one')
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('beta'))
    expect(store.readApprovedContext('w1', 10)).not.toContain('beta')
    await store.close()
  })

  it('prunes terminal runs and stale quarantined candidates only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-store-'))
    tempDirs.push(dir)
    const store = await openStore(join(dir, 'state.sqlite'))
    const acquired = store.beginRun({ runId: 'r-old', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: 100 }, 'h', 5000, 100)!
    store.commitRun({ runId: 'r-old', workspaceKey: 'w1', holderId: 'h', globalFence: acquired.globalFence, workspaceFence: acquired.workspaceFence, status: 'committed', errorCode: null, usage: null, finishedAt: 200, candidates: [seed('w1', 'old')], challengeIds: [], cursors: [], workspace: null })
    store.reviewCandidate('cand-old', 0, ['quarantined'], 'approved', 300)
    expect(store.pruneRuns(500)).toBe(1)
    expect(store.pruneQuarantine(500)).toBe(0)
    expect(store.getCandidate('cand-old')?.status).toBe('approved')
    await store.close()
  })
})
