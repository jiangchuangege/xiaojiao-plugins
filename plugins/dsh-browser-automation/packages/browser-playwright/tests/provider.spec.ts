/**
 * Real-browser integration suite: launches the local Chrome/Chromium through
 * the provider (pipe transport) against a loopback fixture server under the
 * test-only `allowLoopback` policy. Self-skips when no browser executable is
 * installed, mirroring the harness keyless-e2e self-skip convention.
 */

import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BrowserError } from '@dsh-browser-automation/dsh-browser'
import { PlaywrightBrowserBackend, discoverChromeExecutable } from '../src/index.js'
import type { SandboxPolicyView, SandboxProviderView } from '../src/index.js'

const chromePath = discoverChromeExecutable()
const haveChrome = chromePath !== undefined

function fakeSandbox(mode: 'read-only' | 'workspace-write' | 'danger-full-access', enforcement: 'full' | 'partial' = 'full'): { policy: SandboxPolicyView; provider: SandboxProviderView } {
  return {
    policy: { resolve: () => ({ mode, workspaceRoot: process.cwd() }) },
    provider: {
      confine: vi.fn((argv: readonly string[]) => ({ argv: [...argv], enforcement })),
    },
  }
}

function makeBackend(overrides: Partial<ConstructorParameters<typeof PlaywrightBrowserBackend>[0]> = {}) {
  return new PlaywrightBrowserBackend({
    executablePath: chromePath,
    allowLoopback: true,
    navigationTimeoutMs: 15_000,
    actionTimeoutMs: 5_000,
    snapshotMaxNodes: 100,
    ...overrides,
  }, fakeSandbox('danger-full-access'))
}

interface Fixture {
  readonly portA: number
  readonly portB: number
  readonly urlA: string
  readonly urlB: string
  readonly serverA: Server
  readonly serverB: Server
  hitsB: () => number
  probeHits: () => number
}

function startFixture(): Promise<Fixture> {
  let hitsB = 0
  let probeHits = 0
  const serverB = createServer((_req, res) => {
    hitsB += 1
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body><h1>Server B</h1></body></html>')
  })
  const page = `<!doctype html><html><head><title>Fixture Page</title></head><body>
<h1>Fixture Heading</h1>
<a href="/other">Other link</a>
<button id="go" onclick="this.textContent = document.getElementById('name').value">Go</button>
<input id="name" type="text" aria-label="Name field" placeholder="type here">
<input id="secret" type="password" name="pw">
<img src="/img-cross.png" onerror="this.alt='img-failed'">
</body></html>`
  let serverA: Server = createServer()
  const start = (server: Server): Promise<number> => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  return Promise.all([start(serverA), start(serverB)]).then(([portA, portB]) => {
    // Recreate serverA with its port known so pages can embed cross-origin URLs.
    serverA.close()
    serverA = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${portA}`)
      switch (url.pathname) {
        case '/probe': {
          probeHits += 1
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('probe')
          return
        }
        case '/redirect': {
          res.writeHead(302, { location: `http://127.0.0.1:${portB}/` })
          res.end()
          return
        }
        case '/img-cross.png': {
          // The page's <img> src stays same-origin; embed the cross-origin probe here.
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(`<img src="http://127.0.0.1:${portB}/pixel.png">`)
          return
        }
        case '/xhr': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(`<html><body><script>fetch('http://127.0.0.1:${portB}/')</script></body></html>`)
          return
        }
        case '/auto-fetch': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html><body><h1>Auto</h1><script>setTimeout(() => fetch(\'/probe\'), 250)</script></body></html>')
          return
        }
        case '/press': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html><body><input id="t" type="text" aria-label="Key field"><button id="b" onclick="this.textContent=\'clicked\'">Press</button><script>document.getElementById(\'t\').addEventListener(\'keydown\', e => { document.getElementById(\'b\').textContent = \'key:\' + e.key })</script></body></html>')
          return
        }
        case '/twins': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html><body><button>Same</button><button>Same</button></body></html>')
          return
        }
        case '/disabled': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html><body><button disabled>Off</button></body></html>')
          return
        }
        case '/other': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html><body><h1>Other Page</h1></body></html>')
          return
        }
        case '/morph': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html><body><button id="m">Before</button><script>let n = 0; setInterval(() => { document.getElementById(\'m\').textContent = \'Morph\' + (++n) }, 300)</script></body></html>')
          return
        }
        case '/link-cross': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(`<html><body><a id="away" href="http://127.0.0.1:${portB}/">Away</a></body></html>`)
          return
        }
        case '/ws': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(`<html><body><script>new WebSocket('ws://127.0.0.1:${portB}/socket')</script></body></html>`)
          return
        }
        case '/loop': {
          res.writeHead(302, { location: '/loop' })
          res.end()
          return
        }
        case '/popup': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html><body><script>window.open(\'/other\')</script></body></html>')
          return
        }
        case '/covered': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html><body><div style="position:absolute;top:0;left:0;width:200px;height:50px;background:white;z-index:9"></div><button id="under">Under</button></body></html>')
          return
        }
        case '/slow': {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end('<html><body><h1>Slow</h1></body></html>')
          }, 4_000)
          return
        }
        case '/data-img': {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html><body><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></body></html>')
          return
        }
        default: {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(page)
          return
        }
      }
    })
    return new Promise<Fixture>((resolve, reject) => {
      serverA.once('error', reject)
      serverA.listen(portA, '127.0.0.1', () => {
        resolve({ portA, portB, urlA: `http://127.0.0.1:${portA}/page`, urlB: `http://127.0.0.1:${portB}/`, serverA, serverB, hitsB: () => hitsB, probeHits: () => probeHits })
      })
    })
  })
}

describe.skipIf(!haveChrome)('playwright provider (real Chrome)', () => {
  let fixture: Fixture

  beforeAll(async () => {
    fixture = await startFixture()
  })

  afterAll(async () => {
    await new Promise<void>(resolve => fixture.serverA.close(() => resolve()))
    await new Promise<void>(resolve => fixture.serverB.close(() => resolve()))
  })

  it('spawns an isolated session on about:blank', async () => {
    const backend = makeBackend()
    const session = await backend.spawn(new AbortController().signal)
    try {
      const observation = await session.observe(new AbortController().signal)
      expect(observation.origin).toBeNull()
      expect(observation.displayUrl).toBe('about:blank')
      expect(observation.elements).toEqual([])
    } finally {
      await session.close()
    }
  }, 60_000)

  it('navigates, observes, fills, clicks, and reflects real page state', async () => {
    const backend = makeBackend()
    const session = await backend.spawn(new AbortController().signal)
    try {
      await session.navigate({ url: `${fixture.urlA}`, expectedOrigin: `http://127.0.0.1:${fixture.portA}`, permit: null }, new AbortController().signal)
      const first = await session.observe(new AbortController().signal)
      expect(first.origin).toBe(`http://127.0.0.1:${fixture.portA}`)
      expect(first.title).toBe('Fixture Page')
      const roles = first.elements.map(el => el.role)
      expect(roles).toContain('button')
      expect(roles).toContain('link')
      // The password field must never surface: exactly one textbox (the name field).
      expect(first.elements.filter(el => el.role === 'textbox')).toHaveLength(1)
      expect(first.elements.some(el => el.accessibleName === 'pw')).toBe(false)

      const input = first.elements.find(el => el.role === 'textbox' && el.accessibleName === 'Name field')
      expect(input).toBeDefined()
      await session.act({ action: { kind: 'fill', ref: input!.ref, text: 'hello-browser' }, permit: null }, new AbortController().signal)

      const second = await session.observe(new AbortController().signal)
      const button = second.elements.find(el => el.role === 'button' && el.accessibleName === 'Go')
      expect(button).toBeDefined()
      await session.act({ action: { kind: 'click', ref: button!.ref }, permit: null }, new AbortController().signal)

      const third = await session.observe(new AbortController().signal)
      const clicked = third.elements.find(el => el.role === 'button' && el.accessibleName === 'hello-browser')
      expect(clicked).toBeDefined()
    } finally {
      await session.close()
    }
  }, 60_000)

  it('rejects refs from a previous generation after a mutation (STALE_REF)', async () => {
    const backend = makeBackend()
    const session = await backend.spawn(new AbortController().signal)
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: `http://127.0.0.1:${fixture.portA}`, permit: null }, new AbortController().signal)
      const before = await session.observe(new AbortController().signal)
      const button = before.elements.find(el => el.role === 'button')!
      await session.act({ action: { kind: 'click', ref: button.ref }, permit: null }, new AbortController().signal)
      await expect(session.act({ action: { kind: 'click', ref: button.ref }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_REF' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('blocks cross-origin subresources before they reach the network', async () => {
    const backend = makeBackend()
    const session = await backend.spawn(new AbortController().signal)
    try {
      const before = fixture.hitsB()
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/img-cross.png`, expectedOrigin: `http://127.0.0.1:${fixture.portA}`, permit: null }, new AbortController().signal)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(fixture.hitsB()).toBe(before)
    } finally {
      await session.close()
    }
  }, 60_000)

  it('blocks cross-origin redirects with NAVIGATION_BLOCKED', async () => {
    const backend = makeBackend()
    const session = await backend.spawn(new AbortController().signal)
    try {
      await expect(session.navigate({ url: `http://127.0.0.1:${fixture.portA}/redirect`, expectedOrigin: `http://127.0.0.1:${fixture.portA}`, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'NAVIGATION_BLOCKED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('blocks private-IP targets with NETWORK_POLICY_BLOCKED', async () => {
    const backend = makeBackend()
    const session = await backend.spawn(new AbortController().signal)
    try {
      await expect(session.navigate({ url: 'http://10.0.0.1/', expectedOrigin: 'http://10.0.0.1', permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('rejects navigation targets with query strings', async () => {
    const backend = makeBackend()
    const session = await backend.spawn(new AbortController().signal)
    try {
      await expect(session.navigate({ url: `${fixture.urlA}?q=1`, expectedOrigin: `http://127.0.0.1:${fixture.portA}`, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('captures budgeted PNG screenshots', async () => {
    const backend = makeBackend({ screenshotMaxBytes: 10_000_000 })
    const session = await backend.spawn(new AbortController().signal)
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: `http://127.0.0.1:${fixture.portA}`, permit: null }, new AbortController().signal)
      const shot = await session.screenshot(new AbortController().signal)
      expect(shot.mediaType).toBe('image/png')
      expect(shot.bytes).toBeGreaterThan(0)
      expect(shot.bytes).toBeLessThanOrEqual(10_000_000)
      // PNG magic bytes.
      expect([...shot.image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
      expect(shot.width).toBeGreaterThan(0)
      expect(shot.height).toBeGreaterThan(0)
    } finally {
      await session.close()
    }
  }, 60_000)

  it('enforces the per-session screenshot budget', async () => {
    const backend = makeBackend({ screenshotsPerSession: 1 })
    const session = await backend.spawn(new AbortController().signal)
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: `http://127.0.0.1:${fixture.portA}`, permit: null }, new AbortController().signal)
      await session.screenshot(new AbortController().signal)
      await expect(session.screenshot(new AbortController().signal)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT_EXCEEDED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('waits a bounded time and aborts on signal', async () => {
    const backend = makeBackend()
    const session = await backend.spawn(new AbortController().signal)
    try {
      const started = Date.now()
      await session.wait(120, new AbortController().signal)
      expect(Date.now() - started).toBeGreaterThanOrEqual(100)
      const controller = new AbortController()
      const pending = session.wait(5_000, controller.signal)
      await new Promise(resolve => setTimeout(resolve, 20))
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('closes totally and refuses further operations', async () => {
    const backend = makeBackend()
    const session = await backend.spawn(new AbortController().signal)
    await session.close()
    await expect(session.observe(new AbortController().signal)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    await session.close()
  }, 60_000)

  it('fails closed under a read-only sandbox policy', async () => {
    const backend = new PlaywrightBrowserBackend({ executablePath: chromePath, allowLoopback: true }, fakeSandbox('read-only'))
    await expect(backend.spawn(new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_MISSING' })
  }, 60_000)

  it('fails closed under partial sandbox enforcement', async () => {
    const backend = new PlaywrightBrowserBackend({ executablePath: chromePath, allowLoopback: true }, fakeSandbox('workspace-write', 'partial'))
    await expect(backend.spawn(new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_MISSING' })
  }, 60_000)

  it('runs under a full-enforcement confined argv', async () => {
    const sandbox = fakeSandbox('workspace-write', 'full')
    const backend = new PlaywrightBrowserBackend({ executablePath: chromePath, allowLoopback: true }, sandbox)
    const session = await backend.spawn(new AbortController().signal)
    try {
      expect(sandbox.provider.confine).toHaveBeenCalledTimes(1)
      const observation = await session.observe(new AbortController().signal)
      expect(observation.origin).toBeNull()
    } finally {
      await session.close()
    }
  }, 120_000)
})

describe('provider without a browser', () => {
  it('fails with RUNTIME_MISSING when no executable is configured or discovered', async () => {
    const backend = new PlaywrightBrowserBackend({ executablePath: '/nonexistent/chrome-xyz' }, fakeSandbox('danger-full-access'))
    await expect(backend.spawn(new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_MISSING' })
  })

  it('rejects malformed static origin allowlist entries', () => {
    expect(() => new PlaywrightBrowserBackend({ staticResourceOrigins: ['not a url'] }, fakeSandbox('danger-full-access'))).toThrow(/not a valid URL/)
    expect(() => new PlaywrightBrowserBackend({ staticResourceOrigins: ['ftp://x/'] }, fakeSandbox('danger-full-access'))).toThrow(/not http/)
  })

  it('rejects malformed budget configs', () => {
    expect(() => new PlaywrightBrowserBackend({ snapshotMaxNodes: 0 }, fakeSandbox('danger-full-access'))).toThrow(/positive finite/)
    expect(() => new PlaywrightBrowserBackend({ screenshotsPerSession: -1 }, fakeSandbox('danger-full-access'))).toThrow(/non-negative integer/)
  })
})

describe.skipIf(!haveChrome)('playwright provider hardened paths (real Chrome)', () => {
  let fixture: Fixture

  beforeAll(async () => {
    fixture = await startFixture()
  })

  afterAll(async () => {
    await new Promise<void>(resolve => fixture.serverA.close(() => resolve()))
    await new Promise<void>(resolve => fixture.serverB.close(() => resolve()))
  })

  function makeSession(overrides: Partial<ConstructorParameters<typeof PlaywrightBrowserBackend>[0]> = {}) {
    return makeBackend(overrides).spawn(new AbortController().signal)
  }

  const originOf = () => `http://127.0.0.1:${fixture.portA}`

  it('keeps the network cut outside operation leases (auto-fetch aborted)', async () => {
    const session = await makeSession()
    try {
      const before = fixture.probeHits()
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/auto-fetch`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      await new Promise(resolve => setTimeout(resolve, 700))
      expect(fixture.probeHits()).toBe(before)
    } finally {
      await session.close()
    }
  }, 60_000)

  it('blocks cross-origin XHR before it reaches the network', async () => {
    const session = await makeSession()
    try {
      const before = fixture.hitsB()
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/xhr`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(fixture.hitsB()).toBe(before)
    } finally {
      await session.close()
    }
  }, 60_000)

  it('presses allowlisted keys after focusing the target', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/press`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      const input = observation.elements.find(el => el.role === 'textbox')!
      await session.act({ action: { kind: 'press', ref: input.ref, key: 'Enter' }, permit: null }, new AbortController().signal)
      const after = await session.observe(new AbortController().signal)
      expect(after.elements.some(el => el.accessibleName === 'key:Enter')).toBe(true)
    } finally {
      await session.close()
    }
  }, 60_000)

  it('rejects ambiguous targets after a page change', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/twins`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      const twin = observation.elements.find(el => el.role === 'button')!
      await expect(session.act({ action: { kind: 'click', ref: twin.ref }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'TARGET_NOT_ACTIONABLE' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('rejects disabled targets', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/disabled`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      const button = observation.elements.find(el => el.role === 'button')!
      expect(button.interactive).toBe(false)
      await expect(session.act({ action: { kind: 'click', ref: button.ref }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'TARGET_NOT_ACTIONABLE' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('rejects fills on non-editable targets', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      const button = observation.elements.find(el => el.role === 'button')!
      await expect(session.act({ action: { kind: 'fill', ref: button.ref, text: 'x' }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'TARGET_NOT_ACTIONABLE' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('scrolls one observed element into view', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      const button = observation.elements.find(el => el.role === 'button')!
      const result = await session.act({ action: { kind: 'scroll', target: { element: button.ref }, deltaY: 0 }, permit: null }, new AbortController().signal)
      expect(result.changed).toBe(false)
    } finally {
      await session.close()
    }
  }, 60_000)

  it('rejects refs with malformed or unknown observation ids', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      await expect(session.act({ action: { kind: 'click', ref: 'no-dot' as never }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(session.act({ action: { kind: 'click', ref: 'missing.1' as never }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_REF' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('rejects refs that do not belong to their observation', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      const obsId = observation.elements[0]!.ref.split('.')[0]
      await expect(session.act({ action: { kind: 'click', ref: `${obsId}.not-there` as never }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_REF' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('expires observations after their ttl', async () => {
    const session = await makeSession({ observationTtlMs: 30 })
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      await new Promise(resolve => setTimeout(resolve, 60))
      await expect(session.act({ action: { kind: 'click', ref: observation.elements[0]!.ref }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_REF' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('rejects reused and expired action permits', async () => {
    const session = await makeSession()
    try {
      const permit = { nonce: 'n1', expiresAt: Date.now() + 60_000 }
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit }, new AbortController().signal)
      await expect(session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit }, new AbortController().signal)).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' })
      const stale = { nonce: 'n2', expiresAt: Date.now() - 1_000 }
      await expect(session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: stale }, new AbortController().signal)).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('aborts a screenshot on a pre-aborted signal', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const controller = new AbortController()
      controller.abort()
      await expect(session.screenshot(controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('reports PAGE_CRASHED when the capture target vanishes', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      // Close the context without touching crash flags: the raw capture
      // failure must map to PAGE_CRASHED.
      await session.detachPageForTesting()
      await expect(session.screenshot(new AbortController().signal)).rejects.toMatchObject({ code: 'PAGE_CRASHED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('reports BROWSER_CRASHED after the process dies', async () => {
    const session = await makeSession()
    await session.detachProcessForTesting()
    await new Promise(resolve => setTimeout(resolve, 200))
    await expect(session.observe(new AbortController().signal)).rejects.toMatchObject({ code: 'BROWSER_CRASHED' })
    await session.close()
  }, 60_000)

  it('reports PAGE_CRASHED through the crash seam', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      session.simulatePageCrashForTesting()
      await expect(session.observe(new AbortController().signal)).rejects.toMatchObject({ code: 'PAGE_CRASHED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('passes the sandbox session id into the confined policy', async () => {
    const sandbox = fakeSandbox('workspace-write', 'full')
    ;(sandbox.policy.resolve as ReturnType<typeof vi.fn>) = () => ({ mode: 'workspace-write', workspaceRoot: process.cwd(), sessionId: 'sess-7' })
    const backend = new PlaywrightBrowserBackend({ executablePath: chromePath, allowLoopback: true }, sandbox)
    const session = await backend.spawn(new AbortController().signal)
    try {
      expect(sandbox.provider.confine).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ sessionId: 'sess-7' }))
    } finally {
      await session.close()
    }
  }, 60_000)

  it('aborts a launch on an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const backend = makeBackend()
    await expect(backend.spawn(controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('registers through the plugin apply and unregisters on dispose', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const plugin = await import('../src/index.js')
    const { apply, inject, name, Config } = plugin
    const ctx = new Context()
    let unregistered = false
    const register = vi.fn(() => () => {
      unregistered = true
    })
    ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('browsers', { registerBackend: register })
    ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('sandbox', { confine: () => ({ argv: ['x'], enforcement: 'full' }) })
    ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/' }) })
    expect(name).toBe('browser-playwright')
    expect(inject).toEqual(['browsers', 'sandbox', 'sandboxPolicy'])
    await ctx.plugin({ name, inject, Config, apply }, {})
    expect(register).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
    // The plugin's effect disposer must call the registry disposer (HMR safety).
    expect(unregistered).toBe(true)
  })
})

describe.skipIf(!haveChrome)('playwright provider policy matrix (real Chrome)', () => {
  let fixture: Fixture

  beforeAll(async () => {
    fixture = await startFixture()
  })

  afterAll(async () => {
    await new Promise<void>(resolve => fixture.serverA.close(() => resolve()))
    await new Promise<void>(resolve => fixture.serverB.close(() => resolve()))
  })

  function makeSession(overrides: Partial<ConstructorParameters<typeof PlaywrightBrowserBackend>[0]> = {}) {
    return makeBackend(overrides).spawn(new AbortController().signal)
  }

  const originOf = () => `http://127.0.0.1:${fixture.portA}`

  it('rejects navigation targets whose origin mismatches the approval scope', async () => {
    const session = await makeSession()
    try {
      await expect(session.navigate({ url: fixture.urlA, expectedOrigin: 'http://example.com', permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('maps redirect loops to the generic NAVIGATION_BLOCKED', async () => {
    const session = await makeSession()
    try {
      await expect(session.navigate({ url: `http://127.0.0.1:${fixture.portA}/loop`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'NAVIGATION_BLOCKED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('scrolls the page with a bounded wheel delta', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const result = await session.act({ action: { kind: 'scroll', target: { page: true }, deltaY: 120 }, permit: null }, new AbortController().signal)
      expect(result.changed).toBe(false)
    } finally {
      await session.close()
    }
  }, 60_000)

  it('reports TARGET_NOT_FOUND when the page morphs the target without navigation', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/morph`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      const button = observation.elements.find(el => el.role === 'button')!
      expect(button.accessibleName).toBe('Before')
      await new Promise(resolve => setTimeout(resolve, 500))
      await expect(session.act({ action: { kind: 'click', ref: button.ref }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
      const observation2 = await session.observe(new AbortController().signal)
      const morph2 = observation2.elements.find(el => el.role === 'button')!
      await expect(session.act({ action: { kind: 'scroll', target: { element: morph2.ref }, deltaY: 0 }, permit: null }, new AbortController().signal)).resolves.toBeDefined()
      await new Promise(resolve => setTimeout(resolve, 400))
      await expect(session.act({ action: { kind: 'scroll', target: { element: morph2.ref }, deltaY: 0 }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('blocks a cross-origin link click at the network layer', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/link-cross`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      const link = observation.elements.find(el => el.role === 'link')!
      await session.act({ action: { kind: 'click', ref: link.ref }, permit: null }, new AbortController().signal)
      const after = await session.observe(new AbortController().signal)
      expect(after.origin).toBe(originOf())
    } finally {
      await session.close()
    }
  }, 60_000)

  it('closes WebSocket attempts at the network layer', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/ws`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      expect(observation.origin).toBe(originOf())
    } finally {
      await session.close()
    }
  }, 60_000)

  it('closes popup pages immediately (single-page invariant)', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/popup`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      await new Promise(resolve => setTimeout(resolve, 400))
      const observation = await session.observe(new AbortController().signal)
      expect(observation.elements).toHaveLength(0)
    } finally {
      await session.close()
    }
  }, 60_000)

  it('reports TARGET_NOT_ACTIONABLE for covered targets', async () => {
    const session = await makeSession({ actionTimeoutMs: 3_000 })
    try {
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/covered`, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      const button = observation.elements.find(el => el.role === 'button')!
      await expect(session.act({ action: { kind: 'click', ref: button.ref }, permit: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'TARGET_NOT_ACTIONABLE' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('rejects screenshots over the byte budget', async () => {
    const session = await makeSession({ screenshotMaxBytes: 16 })
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      await expect(session.screenshot(new AbortController().signal)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT_EXCEEDED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('reports PAGE_CRASHED when observation extraction hits a dead page', async () => {
    const session = await makeSession()
    try {
      await session.navigate({ url: fixture.urlA, expectedOrigin: originOf(), permit: null }, new AbortController().signal)
      await session.detachPageForTesting()
      await expect(session.observe(new AbortController().signal)).rejects.toMatchObject({ code: 'PAGE_CRASHED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('fails with RUNTIME_MISSING when discovery finds no executable', async () => {
    const backend = new PlaywrightBrowserBackend({ allowLoopback: true }, fakeSandbox('danger-full-access'), () => undefined)
    await expect(backend.spawn(new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_MISSING' })
  }, 60_000)
})

describe.skipIf(!haveChrome)('playwright provider abort paths (real Chrome)', () => {
  let fixture: Fixture

  beforeAll(async () => {
    fixture = await startFixture()
  })

  afterAll(async () => {
    await new Promise<void>(resolve => fixture.serverA.close(() => resolve()))
    await new Promise<void>(resolve => fixture.serverB.close(() => resolve()))
  })

  it('aborts an in-flight navigation and maps it to ABORTED', async () => {
    const session = await makeBackend().spawn(new AbortController().signal)
    try {
      const controller = new AbortController()
      const pending = session.navigate({ url: `http://127.0.0.1:${fixture.portA}/slow`, expectedOrigin: `http://127.0.0.1:${fixture.portA}`, permit: null }, controller.signal)
      await new Promise(resolve => setTimeout(resolve, 400))
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('rejects a pre-aborted navigation immediately', async () => {
    const session = await makeBackend().spawn(new AbortController().signal)
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(session.navigate({ url: `http://127.0.0.1:${fixture.portA}/slow`, expectedOrigin: `http://127.0.0.1:${fixture.portA}`, permit: null }, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    } finally {
      await session.close()
    }
  }, 60_000)

  it('routes data: scheme requests through the non-http guard', async () => {
    const session = await makeBackend().spawn(new AbortController().signal)
    try {
      await session.navigate({ url: `http://127.0.0.1:${fixture.portA}/data-img`, expectedOrigin: `http://127.0.0.1:${fixture.portA}`, permit: null }, new AbortController().signal)
      const observation = await session.observe(new AbortController().signal)
      expect(observation.origin).toBe(`http://127.0.0.1:${fixture.portA}`)
    } finally {
      await session.close()
    }
  }, 60_000)
})
