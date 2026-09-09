/**
 * Chrome process launch paths for the provider.
 *
 * Two launch modes exist, both with the same env allowlist and private
 * temporary dirs:
 * - confined: the caller supplies a sandbox-confined argv (from the harness
 *   `ctx.sandbox` seam); Chrome is spawned over `--remote-debugging-pipe` and
 *   Playwright attaches through a length-prefixed JSON transport. The pipe is
 *   provider-internal transport only; no CDP surface is exposed anywhere.
 * - unconfined: `playwright-core` launches the configured executable itself;
 *   used only under an explicit `danger-full-access` sandbox policy.
 *
 * The plugin never writes `--no-sandbox`, never inherits ambient secrets, and
 * never points a user-data-dir at an existing profile.
 * @module @dsh-browser-automation/dsh-browser-playwright/launcher
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { chromium, type Browser, type ConnectOverCDPTransport } from 'playwright-core'

/** Chrome args shared by both launch modes; single source of truth. */
export function chromeArgs(userDataDir: string, headless: boolean, platform: NodeJS.Platform = process.platform): string[] {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-default-apps',
    // Crashpad must not touch the real profile or the system keychain.
    '--disable-breakpad',
    '--disable-background-networking',
    '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-pages',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    // Page timers must keep running between tool calls (the plan's liveness
    // model); background throttling would also make lease tests flaky.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,AutofillServerCommunication,AutofillEnableAccountWalletStorage',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--password-store=basic',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-pipe',
    '--no-startup-window',
  ]
  if (platform === 'darwin') {
    // Never touch the macOS keychain: prompts and secrets must not leak into a test/session profile.
    args.push('--use-mock-keychain')
  }
  if (headless) args.push('--headless')
  return args
}

/** Environment handed to the browser process: an explicit allowlist. */
export function browserEnv(homeDir: string, tmpDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    HOME: homeDir,
    TMPDIR: tmpDir,
    LANG: 'en_US.UTF-8',
    PATH: env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
  }
}

export interface LaunchChromeOptions {
  /** Complete argv to spawn; already sandbox-wrapped when the caller confined it. */
  readonly argv: readonly string[]
  /** Explicit environment allowlist for the browser process. */
  readonly env: Record<string, string>
  /** Session-private file for Chrome's stderr; never a parent pipe. */
  readonly logPath: string
  /** Private directories removed by the disposer. */
  readonly disposeDirs: readonly string[]
  readonly signal?: AbortSignal
}

export interface LaunchHandle {
  readonly browser: Browser
  /** Closes the browser and guarantees the process and temp dirs are gone. */
  readonly dispose: () => Promise<void>
}

/** Null-terminated JSON pipe transport to a `--remote-debugging-pipe` Chrome. */
export function pipeTransport(child: ChildProcess): ConnectOverCDPTransport {
  // Chrome speaks the pipe protocol over fds 3 (write) and 4 (read), framed
  // as null-terminated JSON (the exact framing and direction Playwright's
  // own PipeTransport uses). Early frames are buffered until Playwright
  // assigns `onmessage`, mirroring Playwright's pending-buffer behavior.
  const writeStream = child.stdio?.[3] as Writable | undefined
  const readStream = child.stdio?.[4] as Readable | undefined
  // EPIPE/ECONNRESET during teardown races are expected; swallow their events.
  writeStream?.on('error', () => undefined)
  readStream?.on('error', () => undefined)
  let pending = ''
  let buffered: object[] = []
  let onmessage: ((message: object) => void) | undefined
  let ended = false
  const transport: ConnectOverCDPTransport = {
    send(message) {
      if (ended) return
      try {
        writeStream?.write(`${JSON.stringify(message)}\u0000`)
      } catch {
        // The pipe may already be gone; teardown never depends on this write.
      }
    },
    close() {
      ended = true
      try {
        writeStream?.end()
      } catch {
        // Already closed.
      }
    },
  }
  Object.defineProperty(transport, 'onmessage', {
    get() {
      return onmessage
    },
    set(callback) {
      onmessage = callback
      if (callback !== undefined) {
        const queued = buffered
        buffered = []
        for (const message of queued) callback(message)
      }
    },
  })
  readStream?.on('data', chunk => {
    pending += (chunk as Buffer).toString('utf8')
    let separator = pending.indexOf('\u0000')
    while (separator !== -1) {
      const frame = pending.slice(0, separator)
      pending = pending.slice(separator + 1)
      separator = pending.indexOf('\u0000')
      if (frame === '') continue
      try {
        const message = JSON.parse(frame) as object
        if (onmessage !== undefined) onmessage(message)
        else buffered.push(message)
      } catch {
        transport.onclose?.()
        return
      }
    }
  })
  child.on('exit', () => {
    ended = true
    transport.onclose?.()
  })
  return transport
}

/** Common default Chrome locations, probed in order per platform. */
export function discoverChromeExecutable(platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string | undefined {
  const candidates: string[] = []
  switch (platform) {
    case 'darwin':
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      )
      break
    case 'linux':
      candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium')
      break
    case 'win32':
      candidates.push(
        join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
      )
      break
    default:
      return undefined
  }
  return candidates.find(path => {
    try {
      return exists(path)
    } catch {
      return false
    }
  })
}

/** Launch Chrome and return the browser plus a total-teardown disposer. */
export async function launchChrome(options: LaunchChromeOptions): Promise<LaunchHandle> {
  // fds 3 (write) and 4 (read) carry the pipe protocol; Chrome's own stderr
  // goes to a session-private log file so it never keeps a parent pipe open.
  const logFd = openSync(options.logPath, 'w')
  const child = spawn(options.argv[0]!, options.argv.slice(1), { stdio: ['ignore', 'ignore', logFd, 'pipe', 'pipe'], env: options.env })
  // A spawn failure surfaces through the connectOverCDP timeout below.
  child.on('error', () => undefined)

  let closed = false
  const dispose = async (): Promise<void> => {
    if (closed) return
    closed = true
    // Cooperative exit first, but never block teardown on CDP round-trips:
    // Browser.close over the pipe may never receive a response because the
    // process dies mid-close. The process-level kill chain is authoritative.
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, 2_000)),
    ])
    if (child.exitCode === null && child.signalCode === null) {
      let exited = false
      child.once('exit', () => {
        exited = true
      })
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 5_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    for (const dir of options.disposeDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const transport = pipeTransport(child)
  let browser: Browser
  try {
    // The handshake must fail fast for a dead process instead of hanging
    // teardown; a 10s bound also converts spawn failures into clean errors.
    browser = await chromium.connectOverCDP(transport, { timeout: 10_000 })
  } catch (error) {
    // Never leak the child when the handshake fails.
    child.kill('SIGKILL')
    for (const dir of options.disposeDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }
  return { browser, dispose }
}
