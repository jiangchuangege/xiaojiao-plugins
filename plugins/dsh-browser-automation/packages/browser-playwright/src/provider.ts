/**
 * The isolated Playwright/Chromium backend. It owns process creation,
 * page/network mechanics, and cleanup; the service owns ids, ownership, and
 * approval. The backend consumes the harness `ctx.sandbox` seam for file
 * confinement: under a `workspace-write` policy Chrome runs confined with
 * full-enforcement required; under `danger-full-access` it runs unconfined
 * (explicit operator choice); under `read-only` it fails closed because a
 * browser needs writable temporary storage.
 * @module @dsh-browser-automation/dsh-browser-playwright/provider
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BrowserError, BrowserSessionId, BrowserPageId,
} from '@dsh-browser-automation/dsh-browser'
import type {
  BrowserBackend, BrowserBackendSession,
} from '@dsh-browser-automation/dsh-browser'
import { browserEnv, chromeArgs, discoverChromeExecutable, launchChrome } from './launcher.js'
import { PlaywrightBrowserSession } from './session.js'

/** Backend type registered with the browser service. */
export const PROVIDER_TYPE = 'playwright-isolated'

/** Structural view of the sandbox seam; runtime casts stay local. */
export interface SandboxPolicyView {
  resolve(): {
    readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
    readonly workspaceRoot: string
    readonly sessionId?: unknown
  }
}

/** Structural view of the sandbox provider; runtime casts stay local. */
export interface SandboxProviderView {
  confine(argv: readonly string[], policy: {
    readonly mode: 'workspace-write'
    readonly workspaceRoot: string
    readonly sessionId?: unknown
  }): { readonly argv: string[]; readonly enforcement: 'full' | 'partial' }
}

/** Deployment-tunable provider configuration, validated at load. */
export interface ProviderConfig {
  /** Explicit Chrome/Chromium executable; discovered per platform when absent. */
  executablePath?: string
  /** Headless by default; headed runs need an explicit opt-in. */
  headless?: boolean
  navigationTimeoutMs?: number
  actionTimeoutMs?: number
  waitMaxMs?: number
  maxScrollDelta?: number
  snapshotMaxNodes?: number
  snapshotMaxTextBytes?: number
  snapshotMaxNameChars?: number
  snapshotMaxDepth?: number
  observationTtlMs?: number
  screenshotMaxBytes?: number
  screenshotsPerSession?: number
  viewportWidth?: number
  viewportHeight?: number
  /** Test-only: permit loopback destinations (fixture servers). Never set in production profiles. */
  allowLoopback?: boolean
  /** Operator-allowlisted subresource origins beyond the page origin. */
  staticResourceOrigins?: string[]
}

/** Single source of truth for defaults: loader validation and direct construction share it. */
export const PROVIDER_DEFAULTS: Required<Omit<ProviderConfig, 'executablePath'>> = {
  headless: true,
  navigationTimeoutMs: 30_000,
  actionTimeoutMs: 10_000,
  waitMaxMs: 30_000,
  maxScrollDelta: 2_000,
  snapshotMaxNodes: 200,
  snapshotMaxTextBytes: 20_000,
  snapshotMaxNameChars: 200,
  snapshotMaxDepth: 24,
  observationTtlMs: 300_000,
  screenshotMaxBytes: 5_000_000,
  screenshotsPerSession: 10,
  viewportWidth: 1_280,
  viewportHeight: 800,
  allowLoopback: false,
  staticResourceOrigins: [],
}

export const Config: z<ProviderConfig> = z.object({
  executablePath: z.string(),
  headless: z.boolean().default(PROVIDER_DEFAULTS.headless),
  navigationTimeoutMs: z.number().default(PROVIDER_DEFAULTS.navigationTimeoutMs),
  actionTimeoutMs: z.number().default(PROVIDER_DEFAULTS.actionTimeoutMs),
  waitMaxMs: z.number().default(PROVIDER_DEFAULTS.waitMaxMs),
  maxScrollDelta: z.number().default(PROVIDER_DEFAULTS.maxScrollDelta),
  snapshotMaxNodes: z.number().default(PROVIDER_DEFAULTS.snapshotMaxNodes),
  snapshotMaxTextBytes: z.number().default(PROVIDER_DEFAULTS.snapshotMaxTextBytes),
  snapshotMaxNameChars: z.number().default(PROVIDER_DEFAULTS.snapshotMaxNameChars),
  snapshotMaxDepth: z.number().default(PROVIDER_DEFAULTS.snapshotMaxDepth),
  observationTtlMs: z.number().default(PROVIDER_DEFAULTS.observationTtlMs),
  screenshotMaxBytes: z.number().default(PROVIDER_DEFAULTS.screenshotMaxBytes),
  screenshotsPerSession: z.number().default(PROVIDER_DEFAULTS.screenshotsPerSession),
  viewportWidth: z.number().default(PROVIDER_DEFAULTS.viewportWidth),
  viewportHeight: z.number().default(PROVIDER_DEFAULTS.viewportHeight),
  allowLoopback: z.boolean().default(false),
  staticResourceOrigins: z.array(z.string()).default([]),
})

/** Complete config after defaults are filled; the executable may stay undiscovered. */
export interface ResolvedProviderConfig {
  readonly executablePath?: string
  readonly headless: boolean
  readonly navigationTimeoutMs: number
  readonly actionTimeoutMs: number
  readonly waitMaxMs: number
  readonly maxScrollDelta: number
  readonly snapshotMaxNodes: number
  readonly snapshotMaxTextBytes: number
  readonly snapshotMaxNameChars: number
  readonly snapshotMaxDepth: number
  readonly observationTtlMs: number
  readonly screenshotMaxBytes: number
  readonly screenshotsPerSession: number
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly allowLoopback: boolean
  readonly staticResourceOrigins: string[]
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`browser-playwright: ${name} must be a positive finite number`)
  }
}

function assertInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`browser-playwright: ${name} must be a non-negative integer`)
  }
}

/** Validate cross-field relations and fill defaults. */
export function resolveConfig(config: ProviderConfig): ResolvedProviderConfig {
  const resolved: ResolvedProviderConfig = {
    ...(config.executablePath === undefined ? {} : { executablePath: config.executablePath }),
    ...PROVIDER_DEFAULTS,
    ...(config.headless === undefined ? {} : { headless: config.headless }),
    ...(config.navigationTimeoutMs === undefined ? {} : { navigationTimeoutMs: config.navigationTimeoutMs }),
    ...(config.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: config.actionTimeoutMs }),
    ...(config.waitMaxMs === undefined ? {} : { waitMaxMs: config.waitMaxMs }),
    ...(config.maxScrollDelta === undefined ? {} : { maxScrollDelta: config.maxScrollDelta }),
    ...(config.snapshotMaxNodes === undefined ? {} : { snapshotMaxNodes: config.snapshotMaxNodes }),
    ...(config.snapshotMaxTextBytes === undefined ? {} : { snapshotMaxTextBytes: config.snapshotMaxTextBytes }),
    ...(config.snapshotMaxNameChars === undefined ? {} : { snapshotMaxNameChars: config.snapshotMaxNameChars }),
    ...(config.snapshotMaxDepth === undefined ? {} : { snapshotMaxDepth: config.snapshotMaxDepth }),
    ...(config.observationTtlMs === undefined ? {} : { observationTtlMs: config.observationTtlMs }),
    ...(config.screenshotMaxBytes === undefined ? {} : { screenshotMaxBytes: config.screenshotMaxBytes }),
    ...(config.screenshotsPerSession === undefined ? {} : { screenshotsPerSession: config.screenshotsPerSession }),
    ...(config.viewportWidth === undefined ? {} : { viewportWidth: config.viewportWidth }),
    ...(config.viewportHeight === undefined ? {} : { viewportHeight: config.viewportHeight }),
    ...(config.allowLoopback === undefined ? {} : { allowLoopback: config.allowLoopback }),
    ...(config.staticResourceOrigins === undefined ? {} : { staticResourceOrigins: config.staticResourceOrigins }),
  }
  for (const name of ['navigationTimeoutMs', 'actionTimeoutMs', 'waitMaxMs', 'maxScrollDelta', 'snapshotMaxNodes', 'snapshotMaxTextBytes', 'snapshotMaxNameChars', 'snapshotMaxDepth', 'observationTtlMs', 'screenshotMaxBytes', 'viewportWidth', 'viewportHeight'] as const) {
    assertPositive(name, resolved[name])
  }
  assertInteger('screenshotsPerSession', resolved.screenshotsPerSession)
  for (const origin of resolved.staticResourceOrigins) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new Error(`browser-playwright: staticResourceOrigins entry "${origin}" is not a valid URL`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`browser-playwright: staticResourceOrigins entry "${origin}" is not http(s)`)
    }
  }
  return resolved
}

export class PlaywrightBrowserBackend implements BrowserBackend {
  readonly type = PROVIDER_TYPE

  private readonly executablePath: string | undefined
  private readonly resolved: ResolvedProviderConfig
  private readonly staticOrigins: Set<string>

  constructor(
    config: ProviderConfig,
    private readonly sandbox: { readonly policy: SandboxPolicyView; readonly provider: SandboxProviderView },
    discover: (platform?: NodeJS.Platform) => string | undefined = discoverChromeExecutable,
  ) {
    this.resolved = resolveConfig(config)
    this.executablePath = config.executablePath ?? discover()
    this.staticOrigins = new Set(this.resolved.staticResourceOrigins)
  }

  async spawn(signal: AbortSignal): Promise<BrowserBackendSession> {
    if (signal.aborted) {
      throw new BrowserError('ABORTED', 'the browser launch was aborted', { retryable: false })
    }
    if (this.executablePath === undefined) {
      throw new BrowserError('RUNTIME_MISSING', 'no Chrome/Chromium executable was found; set executablePath explicitly', { retryable: false })
    }
    if (!existsSync(this.executablePath)) {
      throw new BrowserError('RUNTIME_MISSING', 'the configured Chrome/Chromium executable does not exist', { retryable: false })
    }
    const policy = this.sandbox.policy.resolve()
    let argv: readonly string[]
    if (policy.mode === 'read-only') {
      throw new BrowserError('RUNTIME_MISSING', 'a browser cannot run under a read-only sandbox policy; the session failed closed', { retryable: false })
    }
    const tmpDir = await mkdtemp(join(tmpdir(), 'dsh-browser-'))
    const homeDir = await mkdtemp(join(tmpdir(), 'dsh-browser-home-'))
    const userDataDir = join(tmpDir, 'user-data')
    const baseArgv = [this.executablePath, ...chromeArgs(userDataDir, this.resolved.headless)]
    if (policy.mode === 'workspace-write') {
      const confined = this.sandbox.provider.confine(baseArgv, {
        mode: 'workspace-write',
        workspaceRoot: policy.workspaceRoot,
        ...(policy.sessionId === undefined ? {} : { sessionId: policy.sessionId }),
      })
      if (confined.enforcement !== 'full') {
        throw new BrowserError('RUNTIME_MISSING', 'the sandbox backend cannot enforce the browser file boundary fully; the session failed closed', { retryable: false })
      }
      argv = confined.argv
    } else {
      // danger-full-access: explicit operator choice to run unconfined.
      argv = baseArgv
    }
    const { browser, dispose } = await launchChrome({
      argv,
      env: browserEnv(homeDir, tmpDir),
      logPath: join(tmpDir, 'chrome.log'),
      disposeDirs: [tmpDir, homeDir],
      signal,
    })
    const context = await browser.newContext({
      viewport: { width: this.resolved.viewportWidth, height: this.resolved.viewportHeight },
      serviceWorkers: 'block',
      acceptDownloads: false,
      locale: 'en-US',
      javaScriptEnabled: true,
      bypassCSP: false,
      ignoreHTTPSErrors: false,
      permissions: [],
    })
    const page = await context.newPage()
    const sessionId = BrowserSessionId(randomUUID())
    const pageId = BrowserPageId(randomUUID())
    const session = new PlaywrightBrowserSession({
      sessionId,
      pageId,
      browser,
      context,
      page,
      config: this.resolved,
      allowLoopback: this.resolved.allowLoopback,
      staticOrigins: this.staticOrigins,
      onDispose: dispose,
    })
    // Network interception must be in place before the first operation.
    /* v8 ignore start -- bootstrap-failure cleanup; the intercept install only
       fails when the freshly created context is unusable, and dispose plus
       rethrow are individually covered elsewhere. */
    try {
      await session.ready()
    } catch (error) {
      await dispose()
      throw error
    }
    /* v8 ignore stop */
    return session
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-playwright'

/** The capability seams this provider registers into and consumes. */
export const inject = ['browsers', 'sandbox', 'sandboxPolicy']

/** Register the isolated Playwright backend with the browser service. */
export function apply(ctx: Context, config: ProviderConfig): void {
  const resolved = resolveConfig(config)
  const backend = new PlaywrightBrowserBackend(resolved, {
    policy: ctx.get('sandboxPolicy') as SandboxPolicyView,
    provider: ctx.get('sandbox') as SandboxProviderView,
  })
  ctx.effect(() => ctx.browsers.registerBackend(backend))
}
