/**
 * Strict per-phase JSON validators. Hand-rolled on purpose: every bound is a
 * named check with a stable failure code, unknown keys are rejected, and the
 * depth guard runs before any traversal. Model output that does not validate
 * fails the phase with `schema-invalid` — nothing partial is persisted.
 *
 * @module dsh-dream-reflection/reflection/schemas
 */

export interface ThemeOutput {
  title: string
  problem: string
  evidenceRefs: string[]
}

export interface CandidateClaimOutput {
  text: string
  evidenceRefs: string[]
}

export interface CandidateOutput {
  title: string
  summary: string
  claims: CandidateClaimOutput[]
  limitations: string[]
  reviewQuestion: string
}

export interface CriticVerdictOutput {
  claimIndex: number
  supported: boolean
  evidenceRefs: string[]
  conflict: boolean
}

export interface CriticOutput {
  verdicts: CriticVerdictOutput[]
}

export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string }

const MAX_DEPTH = 24

/** Parse strict JSON: object root and a bounded nesting depth. Key allowlists
 *  are enforced by the per-phase validators, which own their schemas. */
export function parseStrictJson(text: string): Validation<Record<string, unknown>> {
  const trimmed = stripFences(text.trim())
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'json-root-not-object' }
  }
  const depthError = checkDepth(parsed, 0)
  if (depthError !== undefined) return { ok: false, reason: depthError }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** Strip one optional ```json / ``` fence pair; otherwise the text must be pure JSON. */
export function stripFences(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text)
  return match === null ? text : match[1] ?? text
}

function checkDepth(node: unknown, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return `depth-limit:${depth}`
  if (typeof node !== 'object' || node === null) return undefined
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const error = checkDepth(value, depth + 1)
    if (error !== undefined) return error
  }
  return undefined
}

function readString(record: Record<string, unknown>, key: string): Validation<string> {
  const value = record[key]
  return typeof value === 'string' ? { ok: true, value } : { ok: false, reason: `field-not-string:${key}` }
}

function readStringArray(record: Record<string, unknown>, key: string): Validation<string[]> {
  const value = record[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return { ok: false, reason: `field-not-string-array:${key}` }
  return { ok: true, value: value as string[] }
}

/** Bounds shared by every validated text field. */
export const STRING_LIMITS = Object.freeze({
  themeTitle: 120,
  themeProblem: 800,
  candidateTitle: 200,
  candidateSummary: 2000,
  claimText: 800,
  limitationText: 400,
  reviewQuestion: 400,
})

function checkLength(value: string, max: number, field: string): Validation<string> {
  return value.length <= max ? { ok: true, value } : { ok: false, reason: `string-too-long:${field}:${value.length}>${max}` }
}

const THEME_KEYS = Object.freeze({ '*': ['title', 'problem', 'evidenceRefs'] })

/** Validate one theme: short title, short problem, bounded non-empty refs. */
export function validateTheme(value: unknown, maxRefs: number): Validation<ThemeOutput> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'theme-not-object' }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!THEME_KEYS['*'].includes(key)) return { ok: false, reason: `unknown-key:${key}` }
  }
  const title = readString(record, 'title')
  if (!title.ok) return title
  const problem = readString(record, 'problem')
  if (!problem.ok) return problem
  const refs = readStringArray(record, 'evidenceRefs')
  if (!refs.ok) return refs
  if (refs.value.length === 0 || refs.value.length > maxRefs) return { ok: false, reason: `ref-count-out-of-range:${refs.value.length}` }
  const titleLength = checkLength(title.value, STRING_LIMITS.themeTitle, 'title')
  if (!titleLength.ok) return titleLength
  const problemLength = checkLength(problem.value, STRING_LIMITS.themeProblem, 'problem')
  if (!problemLength.ok) return problemLength
  if (new Set(refs.value).size !== refs.value.length) return { ok: false, reason: 'duplicate-refs' }
  return { ok: true, value: { title: title.value, problem: problem.value, evidenceRefs: refs.value } }
}

const CANDIDATE_KEYS = Object.freeze({ '*': ['title', 'summary', 'claims', 'limitations', 'reviewQuestion'] })
const CLAIM_KEYS = Object.freeze(['text', 'evidenceRefs'])

/** Validate one synthesized candidate with every host-side bound. */
export function validateCandidateOutput(value: unknown, maxRefs: number, maxClaims: number, maxLimitations: number): Validation<CandidateOutput> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'candidate-not-object' }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!CANDIDATE_KEYS['*'].includes(key)) return { ok: false, reason: `unknown-key:${key}` }
  }
  const title = readString(record, 'title')
  if (!title.ok) return title
  const summary = readString(record, 'summary')
  if (!summary.ok) return summary
  const reviewQuestion = readString(record, 'reviewQuestion')
  if (!reviewQuestion.ok) return reviewQuestion
  const limitationsRaw = record['limitations']
  if (!Array.isArray(limitationsRaw) || limitationsRaw.some(item => typeof item !== 'string')) return { ok: false, reason: 'limitations-not-string-array' }
  if (limitationsRaw.length > maxLimitations) return { ok: false, reason: `limitations-too-many:${limitationsRaw.length}` }
  const limitations = limitationsRaw as string[]
  const claimsRaw = record['claims']
  if (!Array.isArray(claimsRaw) || claimsRaw.length === 0 || claimsRaw.length > maxClaims) return { ok: false, reason: `claims-out-of-range:${Array.isArray(claimsRaw) ? claimsRaw.length : 'not-array'}` }
  const claims: CandidateClaimOutput[] = []
  for (const claimRaw of claimsRaw as unknown[]) {
    if (typeof claimRaw !== 'object' || claimRaw === null || Array.isArray(claimRaw)) return { ok: false, reason: 'claim-not-object' }
    const claim = claimRaw as Record<string, unknown>
    for (const key of Object.keys(claim)) {
      if (!CLAIM_KEYS.includes(key)) return { ok: false, reason: `unknown-key:claims.${key}` }
    }
    const text = readString(claim, 'text')
    if (!text.ok) return text
    const refs = readStringArray(claim, 'evidenceRefs')
    if (!refs.ok) return refs
    if (refs.value.length === 0 || refs.value.length > maxRefs) return { ok: false, reason: `claim-ref-count-out-of-range:${refs.value.length}` }
    const textLength = checkLength(text.value, STRING_LIMITS.claimText, 'claims.text')
    if (!textLength.ok) return textLength
    if (new Set(refs.value).size !== refs.value.length) return { ok: false, reason: 'claim-duplicate-refs' }
    claims.push({ text: text.value, evidenceRefs: refs.value })
  }
  const titleLength = checkLength(title.value, STRING_LIMITS.candidateTitle, 'title')
  if (!titleLength.ok) return titleLength
  const summaryLength = checkLength(summary.value, STRING_LIMITS.candidateSummary, 'summary')
  if (!summaryLength.ok) return summaryLength
  const questionLength = checkLength(reviewQuestion.value, STRING_LIMITS.reviewQuestion, 'reviewQuestion')
  if (!questionLength.ok) return questionLength
  for (let index = 0; index < limitations.length; index += 1) {
    const limitation = limitations[index]
    if (limitation !== undefined) {
      const limited = checkLength(limitation, STRING_LIMITS.limitationText, 'limitations')
      if (!limited.ok) return limited
    }
  }
  return { ok: true, value: { title: title.value, summary: summary.value, claims, limitations, reviewQuestion: reviewQuestion.value } }
}

const CRITIC_KEYS = Object.freeze({ '*': ['verdicts'] })
const VERDICT_KEYS = Object.freeze(['claimIndex', 'supported', 'evidenceRefs', 'conflict'])

/** Validate the critic batch: one verdict per claim, bounded refs, typed flags. */
export function validateCriticOutput(value: unknown, claimCount: number, maxRefs: number): Validation<CriticOutput> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'critic-not-object' }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!CRITIC_KEYS['*'].includes(key)) return { ok: false, reason: `unknown-key:${key}` }
  }
  const verdictsRaw = record['verdicts']
  if (!Array.isArray(verdictsRaw) || verdictsRaw.length !== claimCount) return { ok: false, reason: `verdict-count-mismatch:${Array.isArray(verdictsRaw) ? verdictsRaw.length : 'not-array'}` }
  const verdicts: CriticVerdictOutput[] = []
  const seen = new Set<number>()
  for (const verdictRaw of verdictsRaw as unknown[]) {
    if (typeof verdictRaw !== 'object' || verdictRaw === null || Array.isArray(verdictRaw)) return { ok: false, reason: 'verdict-not-object' }
    const verdict = verdictRaw as Record<string, unknown>
    for (const key of Object.keys(verdict)) {
      if (!VERDICT_KEYS.includes(key)) return { ok: false, reason: `unknown-key:verdicts.${key}` }
    }
    const claimIndex = verdict['claimIndex']
    if (!Number.isSafeInteger(claimIndex) || (claimIndex as number) < 0 || (claimIndex as number) >= claimCount) return { ok: false, reason: `claim-index-out-of-range:${String(claimIndex)}` }
    if (seen.has(claimIndex as number)) return { ok: false, reason: `duplicate-claim-index:${String(claimIndex)}` }
    seen.add(claimIndex as number)
    if (typeof verdict['supported'] !== 'boolean' || typeof verdict['conflict'] !== 'boolean') return { ok: false, reason: 'verdict-flags-not-boolean' }
    const refs = readStringArray(verdict, 'evidenceRefs')
    if (!refs.ok) return refs
    if (refs.value.length > maxRefs) return { ok: false, reason: `verdict-ref-count-out-of-range:${refs.value.length}` }
    verdicts.push({
      claimIndex: claimIndex as number,
      supported: verdict['supported'] as boolean,
      evidenceRefs: refs.value,
      conflict: verdict['conflict'] as boolean,
    })
  }
  return { ok: true, value: { verdicts } }
}
