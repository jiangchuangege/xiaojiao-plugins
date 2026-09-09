import { describe, expect, it } from 'vitest'
import { evaluateEligibility, rankWorkspaces } from '../src/scheduler/eligibility.ts'
import type { EligibilityInput } from '../src/scheduler/eligibility.ts'

const base = (overrides: Partial<EligibilityInput> = {}): EligibilityInput => ({
  now: 1_000_000,
  enabled: true,
  providerReady: true,
  liveRootStatuses: ['idle'],
  lastBusyAt: null,
  quietForMs: 600000,
  minSuccessIntervalMs: 64800000,
  workspace: null,
  evidenceBytes: 20000,
  minNewTextBytes: 12288,
  pressureTextBytes: 65536,
  budgetAllows: true,
  leaseFree: true,
  ...overrides,
})

describe('eligibility gates', () => {
  it('is eligible with fresh content and no prior success', () => {
    expect(evaluateEligibility(base()).eligible).toBe(true)
  })

  it('respects every non-bypassable gate', () => {
    expect(evaluateEligibility(base({ enabled: false })).skipCode).toBe('disabled')
    expect(evaluateEligibility(base({ providerReady: false })).skipCode).toBe('provider-unavailable')
    expect(evaluateEligibility(base({ liveRootStatuses: ['running'] })).skipCode).toBe('foreground-active')
    expect(evaluateEligibility(base({ lastBusyAt: 999_000 })).skipCode).toBe('quiet-period')
    expect(evaluateEligibility(base({ evidenceBytes: 10 })).skipCode).toBe('insufficient-new-evidence')
    expect(evaluateEligibility(base({ budgetAllows: false })).skipCode).toBe('budget-exhausted')
    expect(evaluateEligibility(base({ leaseFree: false })).skipCode).toBe('lease-held')
  })

  it('enforces the normal cadence unless pressure is reached', () => {
    const recentSuccess = { workspaceKey: 'w', revision: 1, lastSuccessAt: 990_000, nextEligibleAt: null, failureCount: 0 }
    expect(evaluateEligibility(base({ workspace: recentSuccess })).skipCode).toBe('cooldown')
    expect(evaluateEligibility(base({ workspace: recentSuccess, evidenceBytes: 100_000 })).eligible).toBe(true)
    expect(evaluateEligibility(base({ workspace: recentSuccess, evidenceBytes: 100_000 })).pressure).toBe(true)
  })

  it('respects the failure backoff deadline', () => {
    const backedOff = { workspaceKey: 'w', revision: 1, lastSuccessAt: null, nextEligibleAt: 1_100_000, failureCount: 2 }
    expect(evaluateEligibility(base({ workspace: backedOff })).skipCode).toBe('cooldown')
    expect(evaluateEligibility(base({ workspace: backedOff, evidenceBytes: 100_000 })).eligible).toBe(true)
  })

  it('pressure never bypasses scope-like gates', () => {
    expect(evaluateEligibility(base({ evidenceBytes: 100_000, liveRootStatuses: ['running'] })).skipCode).toBe('foreground-active')
  })
})

describe('workspace ranking', () => {
  it('orders by oldest success then oldest backlog', () => {
    const order = rankWorkspaces([
      { workspaceKey: 'fresh', workspace: { workspaceKey: 'fresh', revision: 0, lastSuccessAt: 900, nextEligibleAt: null, failureCount: 0 }, earliestCursor: 5 },
      { workspaceKey: 'never', workspace: null, earliestCursor: 100 },
      { workspaceKey: 'older', workspace: { workspaceKey: 'older', revision: 0, lastSuccessAt: 100, nextEligibleAt: null, failureCount: 0 }, earliestCursor: 1 },
    ])
    expect(order).toEqual(['never', 'older', 'fresh'])
  })
})
