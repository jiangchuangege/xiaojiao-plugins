import { describe, expect, it } from 'vitest'
import { parseStrictJson, stripFences, validateCandidateOutput, validateCriticOutput, validateTheme } from '../src/reflection/schemas.ts'

describe('strict JSON parsing', () => {
  it('accepts pure JSON and one optional fence pair', () => {
    expect(parseStrictJson('{"a":1}').ok).toBe(true)
    expect(parseStrictJson('```json\n{"a":1}\n```').ok).toBe(true)
    expect(parseStrictJson('prefix {"a":1}').ok).toBe(false)
    expect(parseStrictJson('[1]').ok).toBe(false)
    expect(parseStrictJson('null').ok).toBe(false)
  })

  it('rejects depth bombs before traversal', () => {
    const bomb = `{"a":${'['.repeat(60)}0${']'.repeat(60)}}`
    const result = parseStrictJson(bomb)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('depth')
  })
})

describe('theme validation', () => {
  it('accepts a bounded theme and rejects unknown keys', () => {
    expect(validateTheme({ title: 't', problem: 'p', evidenceRefs: ['e0', 'e1'] }, 10).ok).toBe(true)
    expect(validateTheme({ title: 't', problem: 'p', evidenceRefs: ['e0'], extra: 1 }, 10).ok).toBe(false)
    expect(validateTheme({ title: 't', problem: 'p', evidenceRefs: [] }, 10).ok).toBe(false)
    expect(validateTheme({ title: 't', problem: 'p', evidenceRefs: ['e0', 'e0'] }, 10).ok).toBe(false)
    expect(validateTheme({ title: 'x'.repeat(200), problem: 'p', evidenceRefs: ['e0'] }, 10).ok).toBe(false)
  })
})

describe('candidate validation', () => {
  const valid = {
    title: 'title',
    summary: 'summary',
    claims: [{ text: 'claim', evidenceRefs: ['e0'] }],
    limitations: ['limited'],
    reviewQuestion: 'is it right?',
  }

  it('accepts a valid candidate', () => {
    expect(validateCandidateOutput(valid, 10, 4, 10).ok).toBe(true)
  })

  it('rejects unknown keys at both levels, empty claims, and bad refs', () => {
    expect(validateCandidateOutput({ ...valid, extra: true }, 10, 4, 10).ok).toBe(false)
    expect(validateCandidateOutput({ ...valid, claims: [{ text: 'c', evidenceRefs: ['e0'], extra: 1 }] }, 10, 4, 10).ok).toBe(false)
    expect(validateCandidateOutput({ ...valid, claims: [] }, 10, 4, 10).ok).toBe(false)
    expect(validateCandidateOutput({ ...valid, claims: [{ text: 'c', evidenceRefs: [] }] }, 10, 4, 10).ok).toBe(false)
    expect(validateCandidateOutput({ ...valid, limitations: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] }, 10, 4, 10).ok).toBe(false)
    expect(validateCandidateOutput({ ...valid, title: 'x'.repeat(500) }, 10, 4, 10).ok).toBe(false)
  })
})

describe('critic validation', () => {
  it('requires exactly one typed verdict per claim', () => {
    const good = { verdicts: [{ claimIndex: 0, supported: true, evidenceRefs: ['e0'], conflict: false }] }
    expect(validateCriticOutput(good, 1, 10).ok).toBe(true)
    expect(validateCriticOutput({ verdicts: [] }, 1, 10).ok).toBe(false)
    expect(validateCriticOutput({ verdicts: [{ claimIndex: 0, supported: true, evidenceRefs: ['e0'], conflict: false }, { claimIndex: 0, supported: false, evidenceRefs: [], conflict: false }] }, 2, 10).ok).toBe(false)
    expect(validateCriticOutput({ verdicts: [{ claimIndex: 5, supported: true, evidenceRefs: [], conflict: false }] }, 1, 10).ok).toBe(false)
    expect(validateCriticOutput({ verdicts: [{ claimIndex: 0, supported: 'yes', evidenceRefs: [], conflict: false }] }, 1, 10).ok).toBe(false)
  })
})

describe('fence stripping', () => {
  it('strips only a complete fence pair', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripFences('{"a":1}')).toBe('{"a":1}')
  })
})
