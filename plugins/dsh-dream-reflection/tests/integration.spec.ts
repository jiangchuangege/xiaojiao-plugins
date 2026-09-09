/**
 * Real-composition integration: harness services booted through the real
 * Cordis plugin path (see boot.ts), asserting the model-visible/durable
 * invariants: quarantine-before-approval, approved dynamic context, no
 * custom session events, and full disposal.
 */

import { describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { KNOWN_SESSION_EVENT_TYPES } from '../../packages/core/session/src/known-event-types.ts'
import { boot, teardown } from './boot.ts'
import type { BootResult } from './boot.ts'

function assembleFor(ctx: BootResult['ctx'], agent: Agent) {
  return ctx.systemPrompt.assemble({ agent, scope: agent as never })
}

const STANDARD_TURNS = [
  { match: 'You extract stable', text: JSON.stringify({ themes: [{ title: 'Lockfile drift', problem: 'builds break', evidenceRefs: ['e0', 'e1'] }] }) },
  { match: 'You turn verified evidence', text: JSON.stringify({ candidates: [{ title: 'Drift breaks builds', summary: 'Lockfile drift breaks the build', claims: [{ text: 'lockfile drift breaks builds', evidenceRefs: ['e0', 'e1'] }], limitations: [], reviewQuestion: 'still true?' }] }) },
  { match: 'You independently verify', text: JSON.stringify({ verdicts: [{ claimIndex: 0, supported: true, evidenceRefs: ['e0', 'e1'], conflict: false }] }) },
]

describe('real composition integration', () => {
  it('runs, quarantines, approves through /dream, and injects approved context only after approval', async () => {
    const booted = await boot()
    const { ctx, adapter, fakeAgent, run } = booted
    try {
      adapter.turns.push(...STANDARD_TURNS)
      const outcome = await run('run')
      expect(outcome.kind).toBe('success')
      if (outcome.kind === 'error') return
      expect(outcome.text).toContain('committed')

      const candidates = [...ctx.dreamReflectionStore.listWorkspaces().flatMap(workspace => ctx.dreamReflectionStore.listCandidates(workspace.workspaceKey, ['quarantined']))]
      expect(candidates).toHaveLength(1)
      const candidate = candidates[0]
      expect(candidate).toBeDefined()
      if (candidate === undefined) return

      const before = await assembleFor(ctx, fakeAgent)
      expect(before.contexts.find(item => item.name === 'dream-reflection-approved')?.text).toBe('')

      const approved = await run(`approve ${candidate.candidateId}`)
      expect(approved.kind).toBe('success')
      if (approved.kind !== 'success') return
      expect(approved.text).toContain('approved')

      const after = await assembleFor(ctx, fakeAgent)
      const afterContext = after.contexts.find(item => item.name === 'dream-reflection-approved')
      expect(afterContext?.text).toContain('Drift breaks builds')
      expect(afterContext?.text).toContain('lockfile drift breaks builds')

      const stored = ctx.dreamReflectionStore.listCandidates(candidate.workspaceKey, ['approved'])
      expect(stored.map(item => item.candidateId)).toContain(candidate.candidateId)
    } finally {
      await teardown(booted)
    }
  })

  it('writes no custom session events, keeps the log intact, and disposes fully', async () => {
    const booted = await boot()
    const { ctx, session, run } = booted
    try {
      await run('list')
      const events = await ctx.sessionQuery.readSession(SessionId(String(session.id)))
      expect(events.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'assistant/message', 'turn/end'])
      for (const event of events.events) {
        expect(KNOWN_SESSION_EVENT_TYPES.has(event.type)).toBe(true)
      }
      const closeSpy = vi.spyOn(ctx.dreamReflectionStore, 'close')
      await ctx.fiber.dispose()
      expect(closeSpy).toHaveBeenCalled()
    } finally {
      rmSync(booted.root, { recursive: true, force: true })
    }
  })
})
