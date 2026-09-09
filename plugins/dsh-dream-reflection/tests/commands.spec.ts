/**
 * `/dream` command coverage through the real engine: status, list, show,
 * approve (revision CAS + low-confidence refusal), reject, cancel, dry-run,
 * disabled refusal, and scope errors.
 */

import { describe, expect, it } from 'vitest'
import { boot, teardown } from './boot.ts'
import type { BootResult } from './boot.ts'

const STANDARD_TURNS = [
  { match: 'You extract stable', text: JSON.stringify({ themes: [{ title: 'Lockfile drift', problem: 'builds break', evidenceRefs: ['e0', 'e1'] }] }) },
  { match: 'You turn verified evidence', text: JSON.stringify({ candidates: [{ title: 'Drift breaks builds', summary: 'Lockfile drift breaks the build', claims: [{ text: 'lockfile drift breaks builds', evidenceRefs: ['e0', 'e1'] }], limitations: [], reviewQuestion: 'still true?' }] }) },
  { match: 'You independently verify', text: JSON.stringify({ verdicts: [{ claimIndex: 0, supported: true, evidenceRefs: ['e0', 'e1'], conflict: false }] }) },
]

async function runToCandidate(booted: BootResult): Promise<string> {
  booted.adapter.turns.push(...STANDARD_TURNS)
  const outcome = await booted.run('run')
  expect(outcome.kind).toBe('success')
  const candidates = [...booted.ctx.dreamReflectionStore.listWorkspaces().flatMap(workspace => booted.ctx.dreamReflectionStore.listCandidates(workspace.workspaceKey, ['quarantined']))]
  expect(candidates).toHaveLength(1)
  const candidate = candidates[0]
  expect(candidate).toBeDefined()
  return candidate!.candidateId
}

describe('/dream commands', () => {
  it('reports status, list empty, and unknown subcommands with usage', async () => {
    const booted = await boot()
    try {
      const status = await booted.run('status')
      expect(status.kind).toBe('success')
      expect(status.text).toContain('enabled: true')
      expect(status.text).toContain('scope: allowlist')
      expect(status.text).toContain('route: mock-provider/mock-model (ready)')

      const list = await booted.run('list')
      expect(list.kind).toBe('success')
      expect(list.text).toContain('no matching candidates')

      const unknown = await booted.run('frobnicate')
      expect(unknown.kind).toBe('error')
      expect(unknown.text).toContain('usage')
    } finally {
      await teardown(booted)
    }
  })

  it('runs, lists, shows with redacted context, approves with CAS, and re-approval fails', async () => {
    const booted = await boot()
    try {
      const candidateId = await runToCandidate(booted)
      const list = await booted.run('list quarantined')
      expect(list.text).toContain('Drift breaks builds')

      const show = await booted.run(`show ${candidateId}`)
      expect(show.kind).toBe('success')
      expect(show.text).toContain('Drift breaks builds')
      expect(show.text).toContain('context:')
      expect(show.text).toContain('the build breaks when the lockfile drifts')

      const approve = await booted.run(`approve ${candidateId}`)
      expect(approve.kind).toBe('success')
      expect(approve.text).toContain('approved')

      const reApprove = await booted.run(`approve ${candidateId}`)
      expect(reApprove.kind).toBe('success')
      expect(reApprove.text).toContain('not quarantined')

      const approved = await booted.run('list approved')
      expect(approved.text).toContain('Drift breaks builds')
    } finally {
      await teardown(booted)
    }
  })

  it('refuses to approve low-confidence fragments', async () => {
    const booted = await boot()
    try {
      booted.adapter.turns.push(
        { match: 'You extract stable', text: JSON.stringify({ themes: [{ title: 'Single', problem: 'p', evidenceRefs: ['e0'] }] }) },
        { match: 'You turn verified evidence', text: JSON.stringify({ candidates: [{ title: 'Low card', summary: 's', claims: [{ text: 'c', evidenceRefs: ['e0'] }], limitations: [], reviewQuestion: 'q?' }] }) },
        { match: 'You independently verify', text: JSON.stringify({ verdicts: [{ claimIndex: 0, supported: false, evidenceRefs: ['e0'], conflict: false }] }) },
      )
      const outcome = await booted.run('run')
      expect(outcome.kind).toBe('success')
      const candidates = [...booted.ctx.dreamReflectionStore.listWorkspaces().flatMap(workspace => booted.ctx.dreamReflectionStore.listCandidates(workspace.workspaceKey, ['quarantined']))]
      expect(candidates).toHaveLength(1)
      expect(candidates[0]?.confidence).toBe('low')
      const approve = await booted.run(`approve ${candidates[0]!.candidateId}`)
      expect(approve.kind).toBe('success')
      expect(approve.text).toContain('low-confidence')
    } finally {
      await teardown(booted)
    }
  })

  it('rejects quarantined candidates and cancels only a live run', async () => {
    const booted = await boot()
    try {
      const candidateId = await runToCandidate(booted)
      const reject = await booted.run(`reject ${candidateId}`)
      expect(reject.kind).toBe('success')
      expect(reject.text).toContain('rejected')
      expect(booted.ctx.dreamReflectionStore.getCandidate(candidateId)?.status).toBe('rejected')

      const cancel = await booted.run('cancel not-a-run')
      expect(cancel.kind).toBe('success')
      expect(cancel.text).toContain('no active run')
    } finally {
      await teardown(booted)
    }
  })

  it('estimates dry-run without calling the model and refuses run when disabled', async () => {
    const booted = await boot()
    try {
      const dryRun = await booted.run('run --dry-run')
      expect(dryRun.kind).toBe('success')
      expect(dryRun.text).toContain('dry-run')
      expect(dryRun.text).toContain('evidence:')
      expect(dryRun.text).toContain('eligibility:')
      expect(booted.adapter.calls).toHaveLength(0)
    } finally {
      await teardown(booted)
    }

    const disabled = await boot({ enabled: false })
    try {
      const run = await disabled.run('run')
      expect(run.kind).toBe('success')
      expect(run.text).toContain('enabled is false')
    } finally {
      await teardown(disabled)
    }
  })

  it('refuses commands from non-root agents', async () => {
    const booted = await boot({ root: false })
    try {
      const run = await booted.run('run')
      expect(run.kind).toBe('success')
      expect(run.text).toContain('top-level agents')
    } finally {
      await teardown(booted)
    }
  })
})
