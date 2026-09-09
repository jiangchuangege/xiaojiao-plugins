/**
 * Plugin configuration: the same-named TypeScript interface and Schemastery
 * schema, plus the cross-field checks run at `apply` time (misconfiguration
 * fails loud, never a silent fallback).
 *
 * @module dsh-dream-reflection/config
 */

import z from '@deepseek-ai/schemastery'

/** Scope mode: only currently live root workspaces, or an explicit cwd allowlist. */
export type ScopeMode = 'live-roots' | 'allowlist'

/** How an automatic run may be triggered. */
export interface ScheduleConfig {
  /** Fixed eligibility-scan interval in milliseconds (floor 60s). */
  scanEveryMs?: number
  /** Minimum foreground-quiet period for one workspace before a run. */
  quietForMs?: number
  /** Normal minimum interval between successful runs of one workspace. */
  minSuccessIntervalMs?: number
  /** Base of the classified-failure exponential backoff. */
  retryBaseMs?: number
}

export interface ScopeConfig {
  mode?: ScopeMode
  /** Absolute cwds; required non-empty in `allowlist` mode, aliases merged after canonicalization. */
  allowedCwds?: string[]
}

export interface CorpusConfig {
  /** Minimum redacted evidence bytes for an automatic run. */
  minNewTextBytes?: number
  /** Redacted evidence bytes that let change pressure bypass the normal cadence. */
  pressureTextBytes?: number
  /** Top-level session cap per run. */
  maxSessions?: number
  /** Semantic event cap per run. */
  maxEvents?: number
  /** Per-event redacted text cap in bytes. */
  maxEventBytes?: number
  /** Total source-evidence cap in bytes shared by every phase. */
  maxInputBytes?: number
}

export interface ReflectionConfig {
  maxThemes?: number
  maxEvidenceRefsPerTheme?: number
  maxCandidates?: number
  /** Cosine similarity that classifies a candidate as a near duplicate. */
  nearDuplicateThreshold?: number
}

export interface LimitsConfig {
  /** Per-phase wall-clock bound. */
  phaseTimeoutMs?: number
  /** Whole-run wall-clock bound. */
  runTimeoutMs?: number
  /** Hard model-call cap per run (including the optional prior revalidation). */
  maxCallsPerRun?: number
  /** `maxTokens` passed on every model call. */
  maxOutputTokensPerCall?: number
  dailyCallLimit?: number
  dailyTokenLimit?: number
}

export interface ContextConfig {
  /** Byte budget of the approved-card dynamic context per assembly. */
  maxInjectedBytes?: number
}

export interface RetentionConfig {
  runLedgerDays?: number
  quarantineDays?: number
}

export interface StoreConfig {
  /** Absolute database path; empty means `$DSH_HOME/dream-reflection/state.sqlite`. */
  path?: string
  busyTimeoutMs?: number
  leaseTtlMs?: number
}

/** Validated plugin configuration; every key has a conservative launch default. */
export interface Config {
  /** Master switch; `true` requires a complete model route. */
  enabled?: boolean
  /** Provider route passed to `ctx.llm.stream`. */
  provider?: string
  /** Model id passed to `ctx.llm.stream`. */
  model?: string
  scope?: ScopeConfig
  schedule?: ScheduleConfig
  corpus?: CorpusConfig
  reflection?: ReflectionConfig
  limits?: LimitsConfig
  context?: ContextConfig
  retention?: RetentionConfig
  store?: StoreConfig
}

/** Fixed security invariants that are intentionally not configurable. */
export const SECURITY_INVARIANTS = Object.freeze({
  noAutoApprove: true,
  noFileReads: true,
  noModelApprovalTool: true,
  noCrossCwdMerge: true,
  noReasoningPersistence: true,
  noLlmTools: true,
  noBodyLogging: true,
})

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().default(''),
  model: z.string().default(''),
  scope: z.object({
    mode: z.union(['live-roots', 'allowlist']).default('live-roots'),
    allowedCwds: z.array(z.string()).default([]),
  }).default({ mode: 'live-roots', allowedCwds: [] }),
  schedule: z.object({
    scanEveryMs: z.number().default(900000),
    quietForMs: z.number().default(600000),
    minSuccessIntervalMs: z.number().default(64800000),
    retryBaseMs: z.number().default(1800000),
  }).default({ scanEveryMs: 900000, quietForMs: 600000, minSuccessIntervalMs: 64800000, retryBaseMs: 1800000 }),
  corpus: z.object({
    minNewTextBytes: z.number().default(12288),
    pressureTextBytes: z.number().default(65536),
    maxSessions: z.number().default(6),
    maxEvents: z.number().default(96),
    maxEventBytes: z.number().default(6144),
    maxInputBytes: z.number().default(98304),
  }).default({ minNewTextBytes: 12288, pressureTextBytes: 65536, maxSessions: 6, maxEvents: 96, maxEventBytes: 6144, maxInputBytes: 98304 }),
  reflection: z.object({
    maxThemes: z.number().default(3),
    maxEvidenceRefsPerTheme: z.number().default(10),
    maxCandidates: z.number().default(3),
    nearDuplicateThreshold: z.number().default(0.9),
  }).default({ maxThemes: 3, maxEvidenceRefsPerTheme: 10, maxCandidates: 3, nearDuplicateThreshold: 0.9 }),
  limits: z.object({
    phaseTimeoutMs: z.number().default(90000),
    runTimeoutMs: z.number().default(720000),
    maxCallsPerRun: z.number().default(4),
    maxOutputTokensPerCall: z.number().default(2048),
    dailyCallLimit: z.number().default(24),
    dailyTokenLimit: z.number().default(250000),
  }).default({ phaseTimeoutMs: 90000, runTimeoutMs: 720000, maxCallsPerRun: 4, maxOutputTokensPerCall: 2048, dailyCallLimit: 24, dailyTokenLimit: 250000 }),
  context: z.object({
    maxInjectedBytes: z.number().default(12288),
  }).default({ maxInjectedBytes: 12288 }),
  retention: z.object({
    runLedgerDays: z.number().default(30),
    quarantineDays: z.number().default(60),
  }).default({ runLedgerDays: 30, quarantineDays: 60 }),
  store: z.object({
    path: z.string().default(''),
    busyTimeoutMs: z.number().default(2000),
    leaseTtlMs: z.number().default(180000),
  }).default({ path: '', busyTimeoutMs: 2000, leaseTtlMs: 180000 }),
})

/** The fully defaulted, cross-field-validated plugin configuration. */
export interface ResolvedConfig {
  enabled: boolean
  provider: string
  model: string
  scope: { mode: ScopeMode; allowedCwds: string[] }
  schedule: Required<ScheduleConfig>
  corpus: Required<CorpusConfig>
  reflection: Required<ReflectionConfig>
  limits: Required<LimitsConfig>
  context: Required<ContextConfig>
  retention: Required<RetentionConfig>
  store: Required<StoreConfig>
}

const MIN_TIMER_MS = 60_000

/**
 * Apply the cross-field invariants. Throws with a precise message so a broken
 * deployment fails at plugin load instead of degrading silently.
 * @param config - schema-defaulted configuration.
 * @returns the same values, narrowed to the resolved shape.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const errors: string[] = []
  const enabled = config.enabled === true
  if (enabled && (config.provider === undefined || config.provider === '')) {
    errors.push('provider must be a non-empty route when enabled is true')
  }
  if (enabled && (config.model === undefined || config.model === '')) {
    errors.push('model must be a non-empty id when enabled is true')
  }
  const mode = config.scope?.mode ?? 'live-roots'
  const allowedCwds = config.scope?.allowedCwds ?? []
  if (mode === 'allowlist') {
    if (allowedCwds.length === 0) errors.push('scope.allowedCwds must be non-empty in allowlist mode')
    for (const cwd of allowedCwds) {
      if (cwd === '' || !isAbsolutePath(cwd)) errors.push(`scope.allowedCwds entry "${cwd}" is not an absolute path`)
    }
  }
  const schedule = config.schedule ?? {}
  for (const [name, value] of [
    ['schedule.scanEveryMs', schedule.scanEveryMs],
    ['schedule.quietForMs', schedule.quietForMs],
    ['schedule.minSuccessIntervalMs', schedule.minSuccessIntervalMs],
    ['schedule.retryBaseMs', schedule.retryBaseMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < MIN_TIMER_MS)) {
      errors.push(`${name} must be a safe integer >= ${MIN_TIMER_MS}`)
    }
  }
  const corpus = config.corpus ?? {}
  for (const [name, value] of [
    ['corpus.minNewTextBytes', corpus.minNewTextBytes],
    ['corpus.pressureTextBytes', corpus.pressureTextBytes],
    ['corpus.maxSessions', corpus.maxSessions],
    ['corpus.maxEvents', corpus.maxEvents],
    ['corpus.maxEventBytes', corpus.maxEventBytes],
    ['corpus.maxInputBytes', corpus.maxInputBytes],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      errors.push(`${name} must be a positive safe integer`)
    }
  }
  if (corpus.minNewTextBytes !== undefined && corpus.pressureTextBytes !== undefined
    && corpus.minNewTextBytes > corpus.pressureTextBytes) {
    errors.push('corpus.minNewTextBytes must not exceed corpus.pressureTextBytes')
  }
  const reflection = config.reflection ?? {}
  for (const [name, value] of [
    ['reflection.maxThemes', reflection.maxThemes],
    ['reflection.maxEvidenceRefsPerTheme', reflection.maxEvidenceRefsPerTheme],
    ['reflection.maxCandidates', reflection.maxCandidates],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      errors.push(`${name} must be a positive safe integer`)
    }
  }
  if (reflection.nearDuplicateThreshold !== undefined
    && (typeof reflection.nearDuplicateThreshold !== 'number' || !Number.isFinite(reflection.nearDuplicateThreshold)
      || reflection.nearDuplicateThreshold <= 0 || reflection.nearDuplicateThreshold >= 1)) {
    errors.push('reflection.nearDuplicateThreshold must be a finite number in (0, 1)')
  }
  const limits = config.limits ?? {}
  for (const [name, value] of [
    ['limits.phaseTimeoutMs', limits.phaseTimeoutMs],
    ['limits.runTimeoutMs', limits.runTimeoutMs],
    ['limits.maxCallsPerRun', limits.maxCallsPerRun],
    ['limits.maxOutputTokensPerCall', limits.maxOutputTokensPerCall],
    ['limits.dailyCallLimit', limits.dailyCallLimit],
    ['limits.dailyTokenLimit', limits.dailyTokenLimit],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      errors.push(`${name} must be a positive safe integer`)
    }
  }
  if (limits.maxCallsPerRun !== undefined && limits.maxCallsPerRun < 2) {
    errors.push('limits.maxCallsPerRun must be >= 2 (map + synthesis phases)')
  }
  if (limits.runTimeoutMs !== undefined && limits.phaseTimeoutMs !== undefined
    && limits.runTimeoutMs < limits.phaseTimeoutMs) {
    errors.push('limits.runTimeoutMs must not be shorter than limits.phaseTimeoutMs')
  }
  const context = config.context ?? {}
  if (context.maxInjectedBytes !== undefined
    && (!Number.isSafeInteger(context.maxInjectedBytes) || context.maxInjectedBytes < 1)) {
    errors.push('context.maxInjectedBytes must be a positive safe integer')
  }
  const retention = config.retention ?? {}
  for (const [name, value] of [['retention.runLedgerDays', retention.runLedgerDays], ['retention.quarantineDays', retention.quarantineDays]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      errors.push(`${name} must be a positive safe integer`)
    }
  }
  const store = config.store ?? {}
  if (store.busyTimeoutMs !== undefined && (!Number.isSafeInteger(store.busyTimeoutMs) || store.busyTimeoutMs < 0)) {
    errors.push('store.busyTimeoutMs must be a non-negative safe integer')
  }
  if (store.leaseTtlMs !== undefined && (!Number.isSafeInteger(store.leaseTtlMs) || store.leaseTtlMs < 1000)) {
    errors.push('store.leaseTtlMs must be a safe integer >= 1000')
  }
  if (errors.length > 0) {
    throw new Error(`dream-reflection: invalid configuration: ${errors.join('; ')}`)
  }
  return {
    enabled,
    provider: config.provider ?? '',
    model: config.model ?? '',
    scope: { mode, allowedCwds },
    schedule: schedule as Required<ScheduleConfig>,
    corpus: corpus as Required<CorpusConfig>,
    reflection: reflection as Required<ReflectionConfig>,
    limits: limits as Required<LimitsConfig>,
    context: context as Required<ContextConfig>,
    retention: retention as Required<RetentionConfig>,
    store: store as Required<StoreConfig>,
  }
}

/** Cross-platform absolute-path test used by config validation and scope guards. */
export function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/)/.test(value)
}
