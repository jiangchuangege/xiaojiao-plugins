import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolveConfig, Config } from '../src/config.ts'
import { runPipeline } from '../src/reflection/pipeline.ts'
import type { PipelineOptions } from '../src/reflection/pipeline.ts'
import { mountFakeLlm, USAGE } from './helpers.ts'
import type { EvidenceUnit } from '../src/corpus/build.ts'

const contexts: Context[] = []
afterEach(() => {
  for (const ctx of contexts.splice(0)) void ctx.fiber.dispose()
})

function unit(ref: string, sessionId: string, seq: number, text: string): EvidenceUnit {
  return { ref, sessionId, seq, eventType: 'user/message', text, contentHash: `h-${ref}` }
}

const UNITS = [unit('e0', 's1', 0, 'the build breaks when the lockfile drifts'), unit('e1', 's2', 1, 'lockfile drift changes dependency resolution')]

function options(ctx: Context, overrides: Partial<PipelineOptions> = {}): PipelineOptions {
  const config = resolveConfig(Config({ enabled: true, provider: 'mock-provider', model: 'mock-model' }))
  return {
    llm: ctx.llm,
    provider: 'mock-provider',
    model: 'mock-model',
    maxOutputTokensPerCall: config.limits.maxOutputTokensPerCall,
    maxCallsPerRun: config.limits.maxCallsPerRun,
    maxThemes: config.reflection.maxThemes,
    maxEvidenceRefsPerTheme: config.reflection.maxEvidenceRefsPerTheme,
    maxCandidates: config.reflection.maxCandidates,
    nearDuplicateThreshold: config.reflection.nearDuplicateThreshold,
    evidenceBytes: 1000,
    phaseSignal: () => AbortSignal.timeout(5000),
    budget: { reserve: () => true, settle: () => {} },
    ...overrides,
  }
}

const input = {
  units: UNITS,
  unitsByRef: new Map(UNITS.map(u => [u.ref, u])),
  existingCards: [],
}

describe('reflection pipeline', () => {
  it('runs map → synthesize → critic and quarantines one verified candidate', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = await await mountFakeLlm(ctx)
    adapter.turns.push(
      { match: 'You extract stable', text: JSON.stringify({ themes: [{ title: 'Lockfile drift', problem: 'build breaks', evidenceRefs: ['e0', 'e1'] }] }), usage: USAGE },
      { match: 'You turn verified evidence', text: JSON.stringify({ candidates: [{ title: 'Stable title', summary: 'Drift breaks builds', claims: [{ text: 'lockfile drift breaks the build', evidenceRefs: ['e0', 'e1'] }], limitations: ['only two events'], reviewQuestion: 'still true?' }] }), usage: USAGE },
      { match: 'You independently verify', text: JSON.stringify({ verdicts: [{ claimIndex: 0, supported: true, evidenceRefs: ['e0', 'e1'], conflict: false }] }), usage: USAGE },
    )
    const outcome = await runPipeline(input, options(ctx))
    expect(outcome.kind).toBe('success')
    if (outcome.kind !== 'success') return
    expect(outcome.candidates).toHaveLength(1)
    expect(outcome.candidates[0]?.status).toBe('quarantined')
    expect(outcome.candidates[0]?.confidence).toBe('high')
    expect(outcome.calls).toBe(3)
    expect(adapter.calls.every(call => call.options.tools === undefined)).toBe(true)
    expect(adapter.calls.every(call => call.options.maxTokens === 2048)).toBe(true)
    expect(adapter.calls.every(call => call.options.provider === 'mock-provider')).toBe(true)
  })

  it('rejects fabricated evidence refs with schema-invalid', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = await await mountFakeLlm(ctx)
    adapter.turns.push({ match: 'You extract stable', text: JSON.stringify({ themes: [{ title: 't', problem: 'p', evidenceRefs: ['e404'] }] }) })
    const outcome = await runPipeline(input, options(ctx))
    expect(outcome.kind).toBe('fail')
    if (outcome.kind === 'fail') expect(outcome.errorCode).toBe('schema-invalid')
  })

  it('fails a tool-call output and a max-tokens finish', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = await await mountFakeLlm(ctx)
    adapter.turns.push({
      match: 'You extract stable',
      text: '',
      chunks: () => [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const toolOutcome = await runPipeline(input, options(ctx))
    expect(toolOutcome.kind).toBe('fail')
    if (toolOutcome.kind === 'fail') expect(toolOutcome.errorCode).toBe('schema-invalid')

    const ctx2 = new Context()
    contexts.push(ctx2)
    const adapter2 = await mountFakeLlm(ctx2)
    adapter2.turns.push({
      match: 'You extract stable',
      text: 'partial',
      chunks: () => [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'partial' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    })
    const maxTokensOutcome = await runPipeline(input, options(ctx2))
    expect(maxTokensOutcome.kind).toBe('fail')
    if (maxTokensOutcome.kind === 'fail') expect(maxTokensOutcome.errorCode).toBe('model-failed')
  })

  it('skips with no-verified-evidence when themes come back empty', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = await await mountFakeLlm(ctx)
    adapter.turns.push({ match: 'You extract stable', text: JSON.stringify({ themes: [] }) })
    const outcome = await runPipeline(input, options(ctx))
    expect(outcome.kind).toBe('skip')
    if (outcome.kind === 'skip') expect(outcome.errorCode).toBe('no-verified-evidence')
  })

  it('blocks candidates carrying secrets in their output', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = await await mountFakeLlm(ctx)
    adapter.turns.push(
      { match: 'You extract stable', text: JSON.stringify({ themes: [{ title: 't', problem: 'p', evidenceRefs: ['e0', 'e1'] }] }) },
      { match: 'You turn verified evidence', text: JSON.stringify({ candidates: [{ title: 't', summary: 'key sk-abcdefghijklmnopqrstuvwxyz123456 leaked', claims: [{ text: 'c', evidenceRefs: ['e0'] }], limitations: [], reviewQuestion: 'q?' }] }) },
    )
    const outcome = await runPipeline(input, options(ctx))
    expect(outcome.kind).toBe('fail')
    if (outcome.kind === 'fail') expect(outcome.errorCode).toBe('output-blocked')
  })

  it('collapses an exact duplicate into the duplicates ledger', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = await await mountFakeLlm(ctx)
    adapter.turns.push(
      { match: 'You extract stable', text: JSON.stringify({ themes: [{ title: 't', problem: 'p', evidenceRefs: ['e0', 'e1'] }] }) },
      { match: 'You turn verified evidence', text: JSON.stringify({ candidates: [{ title: 'Existing title', summary: 'Existing summary', claims: [{ text: 'existing claim', evidenceRefs: ['e0'] }], limitations: [], reviewQuestion: 'q?' }] }) },
      { match: 'You independently verify', text: JSON.stringify({ verdicts: [{ claimIndex: 0, supported: true, evidenceRefs: ['e0'], conflict: false }] }) },
    )
    adapter.turns.unshift({ match: 'You re-check previously stored', text: JSON.stringify({ reviews: [] }) })
    const outcome = await runPipeline({
      units: UNITS,
      unitsByRef: new Map(UNITS.map(u => [u.ref, u])),
      existingCards: [{ candidateId: 'c1', status: 'approved', title: 'Existing title', summary: 'Existing summary', claimTexts: ['existing claim'], nearVector: [0] }],
    }, options(ctx))
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.candidates).toHaveLength(0)
      expect(outcome.duplicates.length).toBeGreaterThan(0)
    }
  })

  it('fails fast when the daily budget rejects a reservation', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = await await mountFakeLlm(ctx)
    adapter.turns.push({ match: 'You extract stable', text: JSON.stringify({ themes: [] }) })
    const outcome = await runPipeline(input, options(ctx, { budget: { reserve: () => false, settle: () => {} } }))
    expect(outcome.kind).toBe('fail')
    if (outcome.kind === 'fail') expect(outcome.errorCode).toBe('budget-exhausted')
    expect(adapter.calls).toHaveLength(0)
  })

  it('propagates an abort from the phase signal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = await await mountFakeLlm(ctx)
    adapter.turns.push({ match: 'You extract stable', text: '{"themes":[]}' })
    const controller = new AbortController()
    const promise = runPipeline(input, options(ctx, { phaseSignal: () => controller.signal }))
    controller.abort(new Error('test-abort'))
    await expect(promise).rejects.toThrow()
  })

  it('skips with no-usable-evidence when the corpus is empty', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountFakeLlm(ctx)
    const outcome = await runPipeline({ units: [], unitsByRef: new Map(), existingCards: [] }, options(ctx))
    expect(outcome.kind).toBe('skip')
    if (outcome.kind === 'skip') expect(outcome.errorCode).toBe('no-usable-evidence')
  })
})
