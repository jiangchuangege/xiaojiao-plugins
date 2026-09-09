/**
 * The plugin engine: one Cordis service that owns the store lifecycle, the
 * foreground map, the scanner, the coordinator, the `/dream` commands, and
 * the approved-card dynamic context. Disposal unwinds in one order: stop the
 * timer, abort the active run and await its settlement, then close the store.
 *
 * @module dsh-dream-reflection/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { ResolvedConfig } from './config.ts'
import { DreamReflectionStore } from './store/service.ts'
import { canonicalizeCwdSync, workspaceKeyFor } from './corpus/workspace.ts'
import type { CorpusSession } from './corpus/build.ts'
import { buildCorpus } from './corpus/build.ts'
import { redactor } from './safety/redact.ts'
import { RunCoordinator } from './reflection/coordinator.ts'
import { Scanner } from './scheduler/scanner.ts'
import type { WorkspaceEntry } from './scheduler/scanner.ts'
import { evaluateEligibility } from './scheduler/eligibility.ts'
import { registerApprovedContext } from './context.ts'
import { handleDreamCommand } from './commands.ts'

export const SERVICE_NAME = 'dream-reflection-engine'

export class DreamReflectionService extends Service {
  static inject = ['timer', 'agents', 'sessionQuery', 'llm', 'commands', 'systemPrompt', 'dreamReflectionStore']

  readonly config: ResolvedConfig
  override readonly ctx: Context
  readonly store: DreamReflectionStore
  readonly sessionQuery: SessionQueryEngine
  readonly llm: LlmRuntime
  readonly coordinator: RunCoordinator
  private readonly scanner: Scanner
  private readonly foregroundState = new Map<string, { statuses: readonly ('idle' | 'running')[]; lastBusyAt: number | null }>()
  private instanceSalt = ''
  private routeReady = false
  private readonly disposers: Array<() => void> = []
  private disposed = false

  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx, SERVICE_NAME)
    this.ctx = ctx
    this.config = config
    this.store = ctx.dreamReflectionStore
    this.sessionQuery = ctx.sessionQuery
    this.llm = ctx.llm
    this.coordinator = new RunCoordinator({
      ctx,
      config,
      store: this.store,
      sessionQuery: this.sessionQuery,
      llm: this.llm,
      instanceSalt: '',
      sessionsFor: workspaceKey => this.sessionsFor(workspaceKey),
    })
    this.scanner = new Scanner({
      ctx,
      config,
      store: this.store,
      coordinator: this.coordinator,
      sessionQuery: this.sessionQuery,
      buildWorkspaceMap: () => this.buildWorkspaceMap(),
      foreground: () => this.foregroundState,
      providerReady: () => this.routeReady,
    })
    this.disposers.push(
      ctx.on('agent/created', payload => this.onAgentCreated(payload.agent)),
      ctx.on('agent/status', payload => this.onAgentStatus(payload.agent, payload.status)),
      ctx.on('agent/disposed', payload => this.onAgentDisposed(payload.agent)),
    )
    this.disposers.push(
      ctx.commands.register({
        name: 'dream',
        description: 'Inspect, run, and review dream-reflection memory cards',
        input: { hint: 'status | run [--dry-run] | cancel <id> | list [filter] | show <id> | approve <id> | reject <id>' },
        recordInput: true,
        handler: invocation => handleDreamCommand(this, invocation),
      }),
    )
    this.disposers.push(registerApprovedContext(this))
    ctx.effect(() => () => this.dispose(), 'dream-reflection.dispose')
    void this.bootstrap()
  }

  /** Open the store, recover, validate the model route, and start scheduling. */
  private async bootstrap(): Promise<void> {
    try {
      await this.store.open()
      this.instanceSalt = this.store.readMeta().instanceSalt
      if (this.config.enabled) {
        try {
          await this.llm.resolveModelInfo(this.config.provider, this.config.model)
          this.routeReady = true
        } catch (error) {
          this.routeReady = false
          this.ctx.logger('dream-reflection').error(`provider-unavailable: ${error instanceof Error ? error.name : String(error)}`)
        }
      }
      if (this.config.enabled && this.routeReady) {
        this.disposers.push(this.ctx.interval(() => { void this.scanner.scan('timer') }, this.config.schedule.scanEveryMs))
      }
      await this.scanner.start()
    } catch (error) {
      this.ctx.logger('dream-reflection').error(`bootstrap-failed: ${error instanceof Error ? `${error.name}:${error.message}` : String(error)}`)
    }
  }

  /** Ordered teardown: timer/scan stop, run abort + settle, store close. */
  private async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.scanner.dispose()
    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer()
      } catch {
        // Listener removal must not block the remaining teardown order.
      }
    }
    await this.coordinator.dispose()
    await this.store.close()
  }

  /** Current foreground state keyed by workspaceKey (engine-owned). */
  foreground(): ReadonlyMap<string, { statuses: readonly ('idle' | 'running')[]; lastBusyAt: number | null }> {
    return this.foregroundState
  }

  /** Whether the configured provider/model route resolved at startup. */
  isRouteReady(): boolean {
    return this.routeReady
  }

  private workspaceKeyOfAgent(agent: Agent): string | undefined {
    if (this.instanceSalt === '') return undefined
    const canonical = canonicalizeCwdSync(agent.session.header.cwd)
    if (canonical === undefined) return undefined
    return workspaceKeyFor(this.instanceSalt, canonical)
  }

  private onAgentCreated(agent: Agent): void {
    if (!this.isRoot(agent)) return
    const key = this.workspaceKeyOfAgent(agent)
    if (key === undefined) return
    const state = this.foregroundState.get(key) ?? { statuses: [], lastBusyAt: null }
    if (!state.statuses.includes(agent.status)) this.foregroundState.set(key, { ...state, statuses: [...state.statuses, agent.status] })
  }

  private onAgentStatus(agent: Agent, status: 'idle' | 'running'): void {
    if (!this.isRoot(agent)) return
    const key = this.workspaceKeyOfAgent(agent)
    if (key === undefined) return
    const previous = this.foregroundState.get(key) ?? { statuses: [], lastBusyAt: null }
    const statuses = [...previous.statuses.filter(item => item !== agent.status), status]
    const busy = status === 'running'
    const next = { statuses, lastBusyAt: busy ? Date.now() : previous.lastBusyAt }
    this.foregroundState.set(key, next)
    if (busy) this.coordinator.abortWorkspace(key, 'cancelled-by-foreground')
  }

  private onAgentDisposed(agent: Agent): void {
    const key = this.workspaceKeyOfAgent(agent)
    if (key === undefined) return
    const previous = this.foregroundState.get(key)
    if (previous === undefined) return
    this.foregroundState.set(key, { statuses: previous.statuses.filter(item => item !== agent.status), lastBusyAt: previous.lastBusyAt })
  }

  private isRoot(agent: Agent): boolean {
    return this.ctx.agents.roots().some(root => root.id === agent.id)
  }

  /** Build the in-scope workspace map from the live-preferred session corpus. */
  async buildWorkspaceMap(): Promise<ReadonlyMap<string, WorkspaceEntry>> {
    const records = await this.sessionQuery.listSessions()
    const liveRootIds = new Set(this.ctx.agents.roots().map(agent => agent.id))
    const allowed = new Set(this.config.scope.mode === 'allowlist'
      ? this.config.scope.allowedCwds.map(cwd => canonicalizeCwdSync(cwd)).filter((cwd): cwd is string => cwd !== undefined)
      : [])
    const liveRootCanonical = new Set(this.ctx.agents.roots().map(agent => canonicalizeCwdSync(agent.session.header.cwd)).filter((cwd): cwd is string => cwd !== undefined))
    const map = new Map<string, WorkspaceEntry>()
    const inScope = (canonical: string | undefined): canonical is string => {
      if (canonical === undefined) return false
      if (this.config.scope.mode === 'allowlist') return allowed.has(canonical)
      return liveRootCanonical.has(canonical)
    }
    for (const record of records) {
      const header = record.header
      if (header.origin === 'subagent') continue
      if ((header.delegationDepth ?? 0) > 0) continue
      const canonical = canonicalizeCwdSync(header.cwd)
      if (!inScope(canonical)) continue
      if (record.live && !liveRootIds.has(header.id)) continue
      const key = workspaceKeyFor(this.instanceSalt, canonical)
      let entry = map.get(key)
      if (entry === undefined) {
        entry = { canonicalCwd: canonical, sessions: [] }
        map.set(key, entry)
      }
      entry.sessions.push({ sessionId: header.id, header })
    }
    if (this.config.scope.mode === 'allowlist') {
      for (const canonical of allowed) {
        const key = workspaceKeyFor(this.instanceSalt, canonical)
        if (!map.has(key)) map.set(key, { canonicalCwd: canonical, sessions: [] })
      }
    }
    return map
  }

  /** Sessions for one workspace, rebuilt from the corpus on demand. */
  async sessionsFor(workspaceKey: string): Promise<{ canonicalCwd: string; sessions: CorpusSession[] } | null> {
    const map = await this.buildWorkspaceMap()
    const entry = map.get(workspaceKey)
    return entry === undefined ? null : { canonicalCwd: entry.canonicalCwd, sessions: entry.sessions }
  }

  /** Workspace key of a command's receiving agent, with scope validation. */
  workspaceKeyForCommand(agent: Agent): { key: string; canonicalCwd: string } | { error: string } {
    if (!this.isRoot(agent)) return { error: 'dream: only top-level agents can run reflection commands' }
    const canonical = canonicalizeCwdSync(agent.session.header.cwd)
    if (canonical === undefined) return { error: 'dream: this agent has no working directory' }
    if (this.config.scope.mode === 'allowlist') {
      const allowed = this.config.scope.allowedCwds.map(cwd => canonicalizeCwdSync(cwd))
      if (!allowed.includes(canonical)) return { error: 'dream: this workspace is outside scope.allowedCwds' }
    }
    return { key: workspaceKeyFor(this.instanceSalt, canonical), canonicalCwd: canonical }
  }

  /** Dry-run scope/corpus/budget estimate for one workspace. */
  async dryRun(workspaceKey: string, entry: WorkspaceEntry): Promise<string> {
    const now = Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    const cursors = new Map<string, number>()
    for (const session of entry.sessions) {
      const stored = this.store.getCursor(workspaceKey, session.sessionId)
      if (stored !== null) cursors.set(session.sessionId, stored)
    }
    const probe = await buildCorpus(entry.sessions, {
      sessionQuery: this.sessionQuery,
      redact: redactor,
      maxSessions: this.config.corpus.maxSessions,
      maxEvents: this.config.corpus.maxEvents,
      maxEventBytes: this.config.corpus.maxEventBytes,
      maxInputBytes: this.config.corpus.maxInputBytes,
      cursors,
      stopAtBytes: this.config.corpus.pressureTextBytes,
    })
    const workspace = this.store.getWorkspace(workspaceKey)
    const fg = this.foregroundState.get(workspaceKey)
    const decision = evaluateEligibility({
      now,
      enabled: this.config.enabled,
      providerReady: this.routeReady,
      liveRootStatuses: fg?.statuses ?? [],
      lastBusyAt: fg?.lastBusyAt ?? null,
      quietForMs: this.config.schedule.quietForMs,
      minSuccessIntervalMs: this.config.schedule.minSuccessIntervalMs,
      workspace,
      evidenceBytes: probe.totalBytes,
      minNewTextBytes: this.config.corpus.minNewTextBytes,
      pressureTextBytes: this.config.corpus.pressureTextBytes,
      budgetAllows: this.store.budgetAllows(day, this.config.provider, this.config.limits.dailyCallLimit, this.config.limits.dailyTokenLimit),
      leaseFree: !this.store.hasLease('global') && !this.store.hasLease(workspaceKey),
    })
    const lines = [
      `workspace: ${workspaceKey.slice(0, 12)}… (${entry.sessions.length} session(s))`,
      `evidence: ${probe.totalBytes} redacted bytes (min ${this.config.corpus.minNewTextBytes}, pressure ${this.config.corpus.pressureTextBytes})`,
      `events: ${probe.units.length}, dropped: ${probe.dropped.reduce((sum, record) => sum + record.count, 0)}`,
      `eligibility: ${decision.eligible ? 'eligible' : `skipped (${decision.skipCode})`}${decision.pressure ? ' [pressure]' : ''}`,
      `estimated calls: <= ${this.config.limits.maxCallsPerRun}, tokens/call: <= ${this.config.limits.maxOutputTokensPerCall} output`,
      `active run: ${this.coordinator.activeRun()?.runId ?? 'none'}`,
    ]
    return lines.join('\n')
  }

  /** Approved-card dynamic context for one prompt assembly (synchronous). */
  renderApprovedContext(agent: Agent | undefined): string {
    if (agent === undefined || this.instanceSalt === '') return ''
    const canonical = canonicalizeCwdSync(agent.session.header.cwd)
    if (canonical === undefined) return ''
    const key = workspaceKeyFor(this.instanceSalt, canonical)
    const cards = this.store.readApprovedContext(key, this.config.context.maxInjectedBytes)
    return cards === '' ? '' : `Approved dream-reflection cards:\n${cards}`
  }
}

/** The command handler result text type, kept narrow for command rendering. */
export type DreamCommandResult = CommandResult
