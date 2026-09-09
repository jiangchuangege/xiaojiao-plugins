import { describe, expect, it } from 'vitest'
import { classifyConfidence } from '../src/reflection/confidence.ts'
import type { EvidenceUnit } from '../src/corpus/build.ts'
import type { CandidateOutput, CriticOutput } from '../src/reflection/schemas.ts'

function unit(ref: string, sessionId: string, seq: number): EvidenceUnit {
  return { ref, sessionId, seq, eventType: 'user/message', text: `evidence ${ref}`, contentHash: 'h' }
}

function candidate(claims: { text: string; evidenceRefs: string[] }[]): CandidateOutput {
  return { title: 't', summary: 's', claims, limitations: [], reviewQuestion: 'q?' }
}

const base = (overrides: Partial<Parameters<typeof classifyConfidence>[0]> = {}): Parameters<typeof classifyConfidence>[0] => ({
  candidate: candidate([{ text: 'c', evidenceRefs: ['e0'] }]),
  unitsByRef: new Map([['e0', unit('e0', 's1', 0)]]),
  critic: { verdicts: [{ claimIndex: 0, supported: true, evidenceRefs: ['e0'], conflict: false }] },
  criticValid: true,
  outputSafe: true,
  ...overrides,
})

describe('deterministic confidence', () => {
  it('blocks fabricated refs and output-safety hits', () => {
    expect(classifyConfidence(base({ candidate: candidate([{ text: 'c', evidenceRefs: ['e9'] }]) })).confidence).toBe('blocked')
    expect(classifyConfidence(base({ outputSafe: false })).confidence).toBe('blocked')
    expect(classifyConfidence(base({ criticValid: false })).confidence).toBe('blocked')
  })

  it('blocks unresolved direct contradictions', () => {
    const critic: CriticOutput = { verdicts: [{ claimIndex: 0, supported: true, evidenceRefs: ['e0'], conflict: true }] }
    expect(classifyConfidence(base({ critic })).confidence).toBe('blocked')
  })

  it('is high with two event refs per claim across two sessions and full critic support', () => {
    const input = base({
      candidate: candidate([{ text: 'c', evidenceRefs: ['e0', 'e1'] }]),
      unitsByRef: new Map([
        ['e0', unit('e0', 's1', 0)],
        ['e1', unit('e1', 's2', 1)],
      ]),
      critic: { verdicts: [{ claimIndex: 0, supported: true, evidenceRefs: ['e0', 'e1'], conflict: false }] },
    })
    expect(classifyConfidence(input).confidence).toBe('high')
  })

  it('is medium with one verified ref per claim', () => {
    expect(classifyConfidence(base()).confidence).toBe('medium')
  })

  it('is low when coverage is minimal but valid', () => {
    const critic: CriticOutput = { verdicts: [{ claimIndex: 0, supported: false, evidenceRefs: ['e0'], conflict: false }] }
    expect(classifyConfidence(base({ critic })).confidence).toBe('low')
  })
})
