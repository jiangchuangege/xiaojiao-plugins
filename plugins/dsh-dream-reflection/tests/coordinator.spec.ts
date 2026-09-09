import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from '../src/config.ts'
import { SqliteDreamReflectionStore } from '../src/store/sqlite.ts'
import { RunCoordinator } from '../src/reflection/coordinator.ts'
import { FakeSessionQuery, mountFakeLlm, assistantEvent, sessionHeader, turnEndEvent, turnStartEvent, userEvent } from './helpers.ts'

const tempDirs: string[] = []
const contexts: Context[] = []
afterEach(() => {
  for (const ctx of contexts.splice(0)) void ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeConfig(overrides: Record<string, unknown> = {}) {
  return resolveConfig(Config({ enabled: true, provider: 'mock-provider', model: 'mock-model', ...overrides }))
}

function standardTurns(adapter: { turns: { match: string; text: string }[] }): void {
  adapter.turns.push(
    { match: 'You extract stable', text: JSON.stringify({ themes: [{ title: 't', problem: 'p', evidenceRefs: ['e0', 'e1'] }] }) },
    { match: 'You turn verified evidence', text: JSON.stringify({ candidates: [{ title: 'Card', summary: 'S', claims: [{ text: 'c', evidenceRefs: ['e0', 'e1'] }], limitations: [], reviewQuestion: 'q?' }] }) },
    { match: 'You independently verify', text: JSON.stringify({ verdicts: [{ claimIndex: 0, supported: true, evidenceRefs: ['e0', 'e1'], conflict: false }] }) },
  )
}

async function setup(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-coord-'))
  tempDirs.push(dir)
  const ctx = new Context()
  const store = new SqliteDreamReflectionStore(ctx, { path: join(dir, 'state.sqlite'), busyTimeoutMs: 2000, leaseTtlMs: 5000 })
  await store.open()
  const query = new FakeSessionQuery(ctx)
  const adapter = await mountFakeLlm(ctx)
  const config = makeConfig(overrides)
  const coordinator = new RunCoordinator({
    ctx,
    config,
    store,
    sessionQuery: query,
    llm: ctx.llm,
    instanceSalt: 'salt',
    sessionsFor: async workspaceKey => {
      const entry = [...query.logs.entries()].filter(([, stored]) => stored.header.cwd === '/ws')[0]
      return workspaceKey === 'key-ws' && entry !== undefined
        ? { canonicalCwd: '/ws', sessions: query.logs.size === 0 ? [] : [...query.logs.entries()].map(([id, stored]) => ({ sessionId: id, header: stored.header })) }
        : null
    },
  })
  return { dir, ctx, store, query, adapter, coordinator, config }
}

function seedLog(query: FakeSessionQuery, id: string, events: Parameters<FakeSessionQuery['set']>[2]): void {
  query.set(id, sessionHeader(id, '/ws'), events)
}

describe('run coordinator', () => {
  it('commits a full manual run: candidate quarantined, cursors advanced, leases released', async () => {
    const { ctx, store, query, adapter, coordinator } = await setup()
    contexts.push(ctx)
    standardTurns(adapter)
    seedLog(query, 's1', [turnStartEvent(0, 0), userEvent(1, 'first evidence text'), assistantEvent(2, 'assistant reply'), turnEndEvent(3, 0)])
    const outcome = await coordinator.request({ trigger: 'manual', workspaceKey: 'key-ws', canonicalCwd: '/ws' })
    expect(outcome.kind).toBe('committed')
    expect(store.getCursor('key-ws', 's1')).toBe(2)
    const candidates = store.listCandidates('key-ws', ['quarantined'])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.sourceRefs.map(ref => ref.ref)).toEqual(['e0', 'e1'])
    expect(store.getRun(outcome.runId)?.status).toBe('committed')
    expect(store.hasLease('global')).toBe(false)
    expect(store.hasLease('key-ws')).toBe(false)
    expect(store.getWorkspace('key-ws')?.failureCount).toBe(0)
    await coordinator.dispose()
    await store.close()
  })

  it('reports insufficient-new-evidence without advancing any cursor', async () => {
    const { ctx, store, query, coordinator } = await setup()
    contexts.push(ctx)
    seedLog(query, 's1', [turnStartEvent(0, 0), userEvent(1, 'already consumed'), assistantEvent(2, 'reply'), turnEndEvent(3, 0)])
    const fences = store.beginRun({ runId: 'seed', workspaceKey: 'key-ws', trigger: 'auto', phase: 'queued', createdAt: 1 }, 'h', 5000, 1)!
    store.commitRun({
      runId: 'seed', workspaceKey: 'key-ws', holderId: 'h', globalFence: fences.globalFence, workspaceFence: fences.workspaceFence,
      status: 'committed', errorCode: null, usage: null, finishedAt: 1,
      candidates: [], challengeIds: [], cursors: [{ sessionId: 's1', seq: 3, contentHash: 'h' }], workspace: null,
    })
    const outcome = await coordinator.request({ trigger: 'auto', workspaceKey: 'key-ws', canonicalCwd: '/ws' })
    expect(outcome.kind).toBe('committed')
    if (outcome.kind === 'committed') expect(outcome.errorCode).toBe('insufficient-new-evidence')
    expect(store.getCursor('key-ws', 's1')).toBe(3)
    await coordinator.dispose()
    await store.close()
  })

  it('checkpoints a fully-dropped sensitive window without rescanning it', async () => {
    const { ctx, store, query, adapter, coordinator } = await setup()
    contexts.push(ctx)
    seedLog(query, 's1', [turnStartEvent(0, 0), userEvent(1, '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----'), assistantEvent(2, '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA5678\n-----END RSA PRIVATE KEY-----'), turnEndEvent(3, 0)])
    const outcome = await coordinator.request({ trigger: 'auto', workspaceKey: 'key-ws', canonicalCwd: '/ws' })
    expect(outcome.kind).toBe('committed')
    if (outcome.kind === 'committed') expect(outcome.errorCode).toBe('no-usable-evidence')
    expect(store.getCursor('key-ws', 's1')).toBe(2)
    expect(store.listCandidates('key-ws')).toHaveLength(0)
    expect(adapter.calls).toHaveLength(0)
    await coordinator.dispose()
    await store.close()
  })

  it('never advances cursors on model failure', async () => {
    const { ctx, store, query, adapter, coordinator } = await setup()
    contexts.push(ctx)
    adapter.turns.push({ match: 'You extract stable', text: 'not json at all' })
    seedLog(query, 's1', [turnStartEvent(0, 0), userEvent(1, 'some fresh content here'), assistantEvent(2, 'reply'), turnEndEvent(3, 0)])
    const outcome = await coordinator.request({ trigger: 'auto', workspaceKey: 'key-ws', canonicalCwd: '/ws' })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.errorCode).toBe('schema-invalid')
    expect(store.getCursor('key-ws', 's1')).toBeNull()
    expect(store.getWorkspace('key-ws')?.failureCount).toBe(1)
    expect(store.hasLease('global')).toBe(false)
    await coordinator.dispose()
    await store.close()
  })

  it('aborts a running workspace with cancelled-by-foreground and leaves no residue', async () => {
    const { ctx, store, query, adapter, coordinator } = await setup()
    contexts.push(ctx)
    standardTurns(adapter)
    let releaseGate: () => void = () => {}
    adapter.gate = new Promise<void>(resolve => { releaseGate = resolve })
    seedLog(query, 's1', [turnStartEvent(0, 0), userEvent(1, 'content enough to run'), assistantEvent(2, 'reply'), turnEndEvent(3, 0)])
    const pending = coordinator.request({ trigger: 'auto', workspaceKey: 'key-ws', canonicalCwd: '/ws' })
    await new Promise(resolve => setTimeout(resolve, 20))
    coordinator.abortWorkspace('key-ws', 'cancelled-by-foreground')
    releaseGate()
    const outcome = await pending
    expect(outcome.kind).toBe('cancelled')
    if (outcome.kind === 'cancelled') expect(outcome.errorCode).toBe('cancelled-by-foreground')
    expect(store.getCursor('key-ws', 's1')).toBeNull()
    expect(store.listCandidates('key-ws')).toHaveLength(0)
    expect(store.hasLease('global')).toBe(false)
    expect(store.getRun(outcome.runId)?.status).toBe('cancelled')
    await coordinator.dispose()
    await store.close()
  })

  it('skips with lease-held when another holder owns the scopes', async () => {
    const { ctx, store, coordinator } = await setup()
    contexts.push(ctx)
    store.beginRun({ runId: 'other', workspaceKey: 'key-ws', trigger: 'auto', phase: 'queued', createdAt: Date.now() }, 'other-holder', 60_000, Date.now())
    const outcome = await coordinator.request({ trigger: 'auto', workspaceKey: 'key-ws', canonicalCwd: '/ws' })
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind === 'skipped') expect(outcome.errorCode).toBe('lease-held')
    await coordinator.dispose()
    await store.close()
  })

  it('fails budget-exhausted without advancing cursors when the daily cap rejects the first call', async () => {
    const { ctx, store, query, adapter, coordinator } = await setup({ limits: { dailyCallLimit: 1 } })
    contexts.push(ctx)
    standardTurns(adapter)
    seedLog(query, 's1', [turnStartEvent(0, 0), userEvent(1, 'fresh content'), assistantEvent(2, 'reply'), turnEndEvent(3, 0)])
    const outcome = await coordinator.request({ trigger: 'auto', workspaceKey: 'key-ws', canonicalCwd: '/ws' })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.errorCode).toBe('budget-exhausted')
    expect(store.getCursor('key-ws', 's1')).toBeNull()
    await coordinator.dispose()
    await store.close()
  })

  it('serializes queued requests through one active run', async () => {
    const { ctx, store, query, adapter, coordinator } = await setup()
    contexts.push(ctx)
    standardTurns(adapter)
    seedLog(query, 's1', [turnStartEvent(0, 0), userEvent(1, 'first run content'), assistantEvent(2, 'reply'), turnEndEvent(3, 0)])
    const first = coordinator.request({ trigger: 'manual', workspaceKey: 'key-ws', canonicalCwd: '/ws' })
    const second = coordinator.request({ trigger: 'manual', workspaceKey: 'key-ws', canonicalCwd: '/ws' })
    const [a, b] = await Promise.all([first, second])
    expect(a.kind).toBe('committed')
    expect(b.kind).toBe('committed')
    if (b.kind === 'committed') expect(b.errorCode).toBe('insufficient-new-evidence')
    expect(store.getCursor('key-ws', 's1')).toBe(2)
    await coordinator.dispose()
    await store.close()
  })
})
