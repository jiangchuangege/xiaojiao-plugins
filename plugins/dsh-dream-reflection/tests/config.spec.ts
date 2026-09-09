import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

describe('dream-reflection config', () => {
  it('fills the conservative launch defaults', () => {
    const resolved = resolveConfig(Config({}))
    expect(resolved.enabled).toBe(false)
    expect(resolved.schedule.scanEveryMs).toBe(900000)
    expect(resolved.limits.maxOutputTokensPerCall).toBe(2048)
    expect(resolved.reflection.nearDuplicateThreshold).toBe(0.9)
    expect(resolved.store.leaseTtlMs).toBe(180000)
  })

  it('requires a complete route when enabled', () => {
    expect(() => resolveConfig(Config({ enabled: true }))).toThrow(/provider/)
    expect(() => resolveConfig(Config({ enabled: true, provider: 'p' }))).toThrow(/model/)
    expect(() => resolveConfig(Config({ enabled: true, provider: 'p', model: 'm' }))).not.toThrow()
  })

  it('requires absolute allowlist paths', () => {
    expect(() => resolveConfig(Config({ scope: { mode: 'allowlist', allowedCwds: ['relative/path'] } }))).toThrow(/absolute/)
    expect(() => resolveConfig(Config({ scope: { mode: 'allowlist', allowedCwds: [] } }))).toThrow(/non-empty/)
    expect(() => resolveConfig(Config({ scope: { mode: 'allowlist', allowedCwds: ['/abs'] } }))).not.toThrow()
  })

  it('rejects degenerate timer intervals (Node timer clamp guard)', () => {
    expect(() => resolveConfig(Config({ schedule: { scanEveryMs: 1000 } }))).toThrow(/scanEveryMs/)
    expect(() => resolveConfig(Config({ schedule: { quietForMs: 0 } }))).toThrow(/quietForMs/)
  })

  it('rejects degenerate limits and threshold ranges', () => {
    expect(() => resolveConfig(Config({ reflection: { nearDuplicateThreshold: 0 } }))).toThrow(/nearDuplicateThreshold/)
    expect(() => resolveConfig(Config({ reflection: { nearDuplicateThreshold: 1 } }))).toThrow(/nearDuplicateThreshold/)
    expect(() => resolveConfig(Config({ limits: { maxCallsPerRun: 1 } }))).toThrow(/maxCallsPerRun/)
    expect(() => resolveConfig(Config({ limits: { runTimeoutMs: 1000, phaseTimeoutMs: 2000 } }))).toThrow(/runTimeoutMs/)
  })

  it('keeps corpus pressure above the minimum', () => {
    expect(() => resolveConfig(Config({ corpus: { minNewTextBytes: 500, pressureTextBytes: 100 } }))).toThrow(/pressureTextBytes/)
  })

  it('rejects a degenerate store lease TTL', () => {
    expect(() => resolveConfig(Config({ store: { leaseTtlMs: 100 } }))).toThrow(/leaseTtlMs/)
  })
})
