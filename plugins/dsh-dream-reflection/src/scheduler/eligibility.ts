/**
 * Pure gate decision for one workspace at one scan. The order implements the
 * eligibility formula: enabled → foreground idle → quiet period → content →
 * cadence (pressure bypasses only this) → budget → lease. Scope and live-root
 * presence are decided by the caller before this function runs.
 *
 * @module dsh-dream-reflection/scheduler/eligibility
 */

import type { WorkspaceRow } from '../store/service.ts'

export interface EligibilityInput {
  now: number
  enabled: boolean
  providerReady: boolean
  /** Status of every live root in this workspace. */
  liveRootStatuses: readonly ('idle' | 'running')[]
  /** Last foreground activity timestamp in this workspace, when known. */
  lastBusyAt: number | null
  quietForMs: number
  minSuccessIntervalMs: number
  workspace: WorkspaceRow | null
  /** Redacted evidence bytes probed for this workspace. */
  evidenceBytes: number
  minNewTextBytes: number
  pressureTextBytes: number
  budgetAllows: boolean
  leaseFree: boolean
}

export interface EligibilityResult {
  eligible: boolean
  skipCode: string
  /** Change pressure reached: the normal cadence may be bypassed. */
  pressure: boolean
}

/**
 * Evaluate one workspace. Change pressure only bypasses the cadence clause —
 * never scope, idle, safety, budget, non-empty corpus, or lease gates.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { now, workspace } = input
  if (!input.enabled) return { eligible: false, skipCode: 'disabled', pressure: false }
  if (!input.providerReady) return { eligible: false, skipCode: 'provider-unavailable', pressure: false }
  if (input.liveRootStatuses.includes('running')) return { eligible: false, skipCode: 'foreground-active', pressure: false }
  if (input.lastBusyAt !== null && now - input.lastBusyAt < input.quietForMs) {
    return { eligible: false, skipCode: 'quiet-period', pressure: false }
  }
  const pressure = input.evidenceBytes >= input.pressureTextBytes
  if (input.evidenceBytes < input.minNewTextBytes) {
    return { eligible: false, skipCode: 'insufficient-new-evidence', pressure }
  }
  if (!pressure) {
    if (workspace?.nextEligibleAt !== null && workspace?.nextEligibleAt !== undefined && workspace.nextEligibleAt > now) {
      return { eligible: false, skipCode: 'cooldown', pressure: false }
    }
    if (workspace?.lastSuccessAt !== null && workspace?.lastSuccessAt !== undefined && now - workspace.lastSuccessAt < input.minSuccessIntervalMs) {
      return { eligible: false, skipCode: 'cooldown', pressure: false }
    }
  }
  if (!input.budgetAllows) return { eligible: false, skipCode: 'budget-exhausted', pressure }
  if (!input.leaseFree) return { eligible: false, skipCode: 'lease-held', pressure }
  return { eligible: true, skipCode: '', pressure }
}

/** Rank candidate workspaces: longest since success first, then smallest cursor (oldest backlog). */
export function rankWorkspaces(entries: readonly { workspaceKey: string; workspace: WorkspaceRow | null; earliestCursor: number | null }[]): string[] {
  return [...entries]
    .sort((a, b) => {
      const lastA = a.workspace?.lastSuccessAt ?? 0
      const lastB = b.workspace?.lastSuccessAt ?? 0
      if (lastA !== lastB) return lastA - lastB
      return (a.earliestCursor ?? Number.MAX_SAFE_INTEGER) - (b.earliestCursor ?? Number.MAX_SAFE_INTEGER)
    })
    .map(entry => entry.workspaceKey)
}
