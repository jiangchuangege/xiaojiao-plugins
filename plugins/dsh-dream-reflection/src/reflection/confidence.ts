/**
 * Host-deterministic confidence. The model never reports its own confidence;
 * these discrete rules fold verified evidence coverage, source-session
 * spread, and the critic's structured verdicts into one label. `blocked`
 * candidates are never persisted.
 *
 * @module dsh-dream-reflection/reflection/confidence
 */

import type { CandidateOutput, CriticOutput } from './schemas.ts'
import type { EvidenceUnit } from '../corpus/build.ts'

export type Confidence = 'blocked' | 'high' | 'medium' | 'low'

export interface ConfidenceInput {
  candidate: CandidateOutput
  /** The run's authoritative ref map: ref -> unit. */
  unitsByRef: ReadonlyMap<string, EvidenceUnit>
  critic: CriticOutput | null
  /** Whether the critic structure was valid for every claim. */
  criticValid: boolean
  /** Whether any claim had an output-safety hit. */
  outputSafe: boolean
}

export interface ConfidenceResult {
  confidence: Confidence
  reason: string
}

/**
 * Classify one candidate by discrete rules:
 * - blocked: invalid ref, safety hit, empty claim, unresolved direct
 *   contradiction, or an invalid critic structure.
 * - high: every claim has >= 2 distinct event refs, overall coverage spans
 *   >= 2 top-level sessions, critic supports every claim with valid refs, no
 *   conflicts.
 * - medium: every claim has >= 1 valid ref, host and critic pass, no conflicts.
 * - low: minimal valid evidence but insufficient coverage; quarantined
 *   fragment only.
 */
export function classifyConfidence(input: ConfidenceInput): ConfidenceResult {
  const { candidate, unitsByRef, critic, criticValid, outputSafe } = input
  if (!outputSafe) return { confidence: 'blocked', reason: 'output-safety-hit' }
  for (const claim of candidate.claims) {
    if (claim.evidenceRefs.length === 0) return { confidence: 'blocked', reason: 'claim-without-evidence' }
    for (const ref of claim.evidenceRefs) {
      if (!unitsByRef.has(ref)) return { confidence: 'blocked', reason: `invalid-ref:${ref}` }
    }
  }
  if (!criticValid || critic === null) return { confidence: 'blocked', reason: 'critic-structure-invalid' }
  for (const verdict of critic.verdicts) {
    for (const ref of verdict.evidenceRefs) {
      if (!unitsByRef.has(ref)) return { confidence: 'blocked', reason: `critic-invalid-ref:${ref}` }
    }
  }
  const contradictions = critic.verdicts.filter(verdict => verdict.conflict).length
  if (contradictions > 0) return { confidence: 'blocked', reason: `unresolved-contradiction:${contradictions}` }
  const distinctSessions = new Set<string>()
  const distinctEvents = new Set<string>()
  for (const claim of candidate.claims) {
    for (const ref of claim.evidenceRefs) {
      const unit = unitsByRef.get(ref)
      if (unit !== undefined) {
        distinctSessions.add(unit.sessionId)
        distinctEvents.add(`${unit.sessionId}:${unit.seq}`)
      }
    }
  }
  const everyClaimTwoEvents = candidate.claims.every(claim => new Set(claim.evidenceRefs.map(ref => unitsByRef.get(ref)).filter((unit): unit is EvidenceUnit => unit !== undefined).map(unit => `${unit.sessionId}:${unit.seq}`)).size >= 2)
  const allSupported = critic.verdicts.every(verdict => verdict.supported && verdict.evidenceRefs.length > 0)
  if (everyClaimTwoEvents && distinctSessions.size >= 2 && allSupported) {
    return { confidence: 'high', reason: 'multi-event-multi-session-critic-supported' }
  }
  if (distinctEvents.size >= candidate.claims.length && allSupported) {
    return { confidence: 'medium', reason: 'per-claim-verified' }
  }
  return { confidence: 'low', reason: `minimal-coverage:sessions=${distinctSessions.size}:events=${distinctEvents.size}` }
}
