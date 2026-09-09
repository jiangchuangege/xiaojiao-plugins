/**
 * Shared real-composition boot: real SessionStore + JSONL persistence +
 * session-query-sqlite + systemPrompt + timer + LlmRuntime, the SQLite store
 * provider, and the engine, loaded through the real Cordis plugin path.
 * Fake-only boundaries: agents registry, commands registry (captures the
 * definition), and the LLM adapter (scripted responses).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import * as dreamPlugin from '../src/index.ts'
import { SqliteDreamReflectionStore } from '../src/store/sqlite.ts'
import { FakeLlmAdapter } from './helpers.ts'
import { assistantEvent, turnEndEvent, turnStartEvent, userEvent } from './helpers.ts'

export interface BootOptions {
  enabled?: boolean
  /** Allowlist cwd; when undefined, a fresh temp workspace is created. */
  workspace?: string
  /** Whether the fake agent is a registry root (default true). */
  root?: boolean
  /** Seed the session with one evidence turn (default true). */
  seedEvidence?: boolean
  /** Extra profile config overlay. */
  config?: Record<string, unknown>
}

export interface BootResult {
  root: string
  workspace: string
  ctx: Context
  adapter: FakeLlmAdapter
  session: Session
  fakeAgent: Agent
  run: (rawInput: string) => Promise<{ kind: 'success' | 'error'; text?: string }>
}

export async function boot(options: BootOptions = {}): Promise<BootResult> {
  const root = mkdtempSync(join(tmpdir(), 'dream-integration-'))
  const workspace = options.workspace ?? mkdtempSync(join(tmpdir(), 'dream-workspace-'))
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceJsonl, { root: join(root, 'sessions') })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'query.sqlite'), openAt: 'never' })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  const adapter = new FakeLlmAdapter()
  ctx.llm.registerAdapter(['mock-provider'], adapter)
  await ctx.plugin(SqliteDreamReflectionStore, { path: join(root, 'state.sqlite'), busyTimeoutMs: 2000, leaseTtlMs: 5000 })

  let commandDefinition: CommandDefinition | undefined
  const session = ctx.sessions.create(undefined, { meta: { cwd: workspace } })
  const fakeAgent = { id: session.id, session: session as never, status: 'idle' as const }
  ctx.provide('agents', {
    roots: () => options.root === false ? [] : [fakeAgent as Agent],
    list: () => options.root === false ? [] : [fakeAgent as Agent],
  })
  ctx.provide('commands', {
    register: (definition: CommandDefinition) => {
      commandDefinition = definition
      return () => { commandDefinition = undefined }
    },
  })

  await ctx.plugin(dreamPlugin, {
    enabled: options.enabled !== false,
    provider: 'mock-provider',
    model: 'mock-model',
    scope: { mode: 'allowlist', allowedCwds: [workspace] },
    schedule: { scanEveryMs: 60_000, quietForMs: 60_000, minSuccessIntervalMs: 60_000, retryBaseMs: 60_000 },
    ...options.config,
  })

  await vi.waitFor(() => {
    try {
      return ctx.dreamReflectionStore.readMeta().schemaVersion === 1
    } catch {
      return false
    }
  })

  if (options.seedEvidence !== false) {
    session.append('turn/start', { turn: 0 })
    const user = userEvent(0, 'the build breaks when the lockfile drifts')
    session.append('user/message', user.data, { surfaceOp: 'append' })
    const assistant = assistantEvent(0, 'the lockfile changed dependency resolution')
    session.append('assistant/message', assistant.data, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
  }

  const run = async (rawInput: string) => {
    const definition = commandDefinition
    if (definition === undefined) throw new Error('dream command was never registered')
    return definition.handler({ commandId: CommandId('c1'), agent: fakeAgent as Agent, rawInput, signal: new AbortController().signal })
  }

  return { root, workspace, ctx, adapter, session, fakeAgent: fakeAgent as Agent, run }
}

export async function teardown(result: BootResult): Promise<void> {
  await result.ctx.fiber.dispose()
  rmSync(result.root, { recursive: true, force: true })
}
