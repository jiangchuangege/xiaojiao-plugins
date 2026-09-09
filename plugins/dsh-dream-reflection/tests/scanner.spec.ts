/**
 * Scanner behavior: startup recovery + retention prune, wall-clock regression
 * guard, overlapping-tick merge, one workspace per scan, and the
 * provider/disabled gates — driven with a fake clock and a scriptable map.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from '../src/config.ts'
import { SqliteDreamReflectionStore } from '../src/store/sqlite.ts'
import { Scanner } from '../src/scheduler/scanner.ts'
import type { ScanDeps, WorkspaceEntry } from '../src/scheduler/scanner.ts'
import { FakeSessionQuery } from './helpers.ts'
import { sessionHeader, turnEndEvent, turnStartEvent, userEvent } from './helpers.ts'

const tempDirs: string[] = []
const contexts: Context[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) void ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Setup {
  store: SqliteDreamReflectionStore
  scanner: Scanner
  query: FakeSessionQuery
  requests: Array<{ trigger: string; workspaceKey: string }>
  mapGate: { promise: Promise<void>; release: () => void }
  setMap: (entries: Record<string, WorkspaceEntry>) => void
  providerReady: (ready: boolean) => void
}

async function setup(configOverrides: Record<string, unknown> = {}): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'dream-scanner-'))
  tempDirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  const store = new SqliteDreamReflectionStore(ctx, { path: join(dir, 'state.sqlite'), busyTimeoutMs: 2000, leaseTtlMs: 5000 })
  await store.open()
  const query = new FakeSessionQuery(ctx)
  const config = resolveConfig(Config({ enabled: true, provider: 'mock-provider', model: 'mock-model', ...configOverrides }))
  const requests: Array<{ trigger: string; workspaceKey: string }> = []
  let mapEntries: Record<string, WorkspaceEntry> = {}
  let gate: { promise: Promise<void>; release: () => void } = { promise: Promise.resolve(), release: () => {} }
  let ready = true
  const coordinator = {
    request: async (request: { trigger: 'auto' | 'manual'; workspaceKey: string }) => {
      requests.push({ trigger: request.trigger, workspaceKey: request.workspaceKey })
      return { kind: 'skipped' as const, runId: 'scan-request', errorCode: 'lease-held' }
    },
    abortWorkspace: () => {},
    cancelRun: () => false,
    activeRun: () => null,
    dispose: async () => {},
  }
  const deps: ScanDeps = {
    ctx,
    config,
    store,
    coordinator: coordinator as unknown as ScanDeps['coordinator'],
    buildWorkspaceMap: async () => {
      await gate.promise
      return new Map(Object.entries(mapEntries))
    },
    foreground: () => new Map(),
    providerReady: () => ready,
    sessionQuery: query,
  }
  const scanner = new Scanner(deps)
  return {
    store,
    scanner,
    query,
    requests,
    mapGate: gate,
    setMap: entries => { mapEntries = entries },
    providerReady: value => { ready = value },
  }
}

function evidenceEvents(): ReturnType<typeof userEvent>[] {
  // Each event stays under maxEventBytes; the window clears minNewTextBytes.
  return [userEvent(1, 'a'.repeat(5000)), userEvent(2, 'b'.repeat(5000)), userEvent(3, 'c'.repeat(5000))]
}

function evidenceEntry(workspaceKey: string, sessionId: string): [string, WorkspaceEntry] {
  return [workspaceKey, {
    canonicalCwd: '/ws',
    sessions: [{ sessionId, header: sessionHeader(sessionId, '/ws') }],
  }]
}

describe('scanner', () => {
  it('runs recovery and retention prune on start', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const env = await setup({ retention: { runLedgerDays: 1, quarantineDays: 1 } })
    const { store } = env
    const twoDays = 2 * 86_400_000
    // An old committed run → pruned by the retention gate.
    const fences = store.beginRun({ runId: 'old', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: now - twoDays }, 'h', 5000, now - twoDays)!
    store.commitRun({
      runId: 'old', workspaceKey: 'w1', holderId: 'h', globalFence: fences.globalFence, workspaceFence: fences.workspaceFence,
      status: 'committed', errorCode: null, usage: null, finishedAt: now - twoDays + 1000,
      candidates: [], challengeIds: [], cursors: [], workspace: null,
    })
    // A still-running run whose lease expired long ago → abandoned on start.
    store.beginRun({ runId: 'stale', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: now - twoDays + 2000 }, 'h', 5000, now - twoDays + 2000)
    await env.scanner.start()
    expect(store.getRun('stale')?.status).toBe('abandoned')
    expect(store.getRun('old')).toBeNull()
  })

  it('never replays history when the wall clock regresses', async () => {
    vi.useFakeTimers()
    const env = await setup()
    env.setMap({ k1: evidenceEntry('k1', 's1')[1] })
    env.query.set('s1', sessionHeader('s1', '/ws'), [turnStartEvent(0, 0), ...evidenceEvents(), turnEndEvent(4, 0)])
    await env.scanner.start()
    expect(env.requests).toHaveLength(1)
    vi.setSystemTime(Date.now() - 60_000)
    await env.scanner.scan('timer')
    // Clock went backwards: no second run, even though evidence exists.
    expect(env.requests).toHaveLength(1)
  })

  it('merges overlapping ticks into one pending rescan', async () => {
    const env = await setup()
    env.setMap({ k1: evidenceEntry('k1', 's1')[1] })
    env.query.set('s1', sessionHeader('s1', '/ws'), [turnStartEvent(0, 0), ...evidenceEvents(), turnEndEvent(4, 0)])
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    env.mapGate.promise = gate
    env.mapGate.release = release
    const first = env.scanner.scan('timer')
    const second = env.scanner.scan('timer') // collapses into pending
    await Promise.resolve()
    release()
    await first
    await second
    await vi.waitFor(() => expect(env.requests).toHaveLength(2))
  })

  it('starts at most one workspace run per scan', async () => {
    const env = await setup()
    env.setMap({ k1: evidenceEntry('k1', 's1')[1], k2: evidenceEntry('k2', 's2')[1] })
    for (const id of ['s1', 's2']) {
      env.query.set(id, sessionHeader(id, '/ws'), [turnStartEvent(0, 0), ...evidenceEvents(), turnEndEvent(4, 0)])
    }
    await env.scanner.start()
    expect(env.requests).toHaveLength(1)
  })

  it('skips scanning when the model route is unavailable or the plugin is disabled', async () => {
    const env = await setup()
    env.setMap({ k1: evidenceEntry('k1', 's1')[1] })
    env.query.set('s1', sessionHeader('s1', '/ws'), [turnStartEvent(0, 0), ...evidenceEvents(), turnEndEvent(4, 0)])
    env.providerReady(false)
    await env.scanner.start()
    expect(env.requests).toHaveLength(0)
    const disabled = await setup({ enabled: false })
    disabled.setMap({ k1: evidenceEntry('k1', 's1')[1] })
    disabled.query.set('s1', sessionHeader('s1', '/ws'), [turnStartEvent(0, 0), ...evidenceEvents(), turnEndEvent(4, 0)])
    await disabled.scanner.start()
    expect(disabled.requests).toHaveLength(0)
  })
})
