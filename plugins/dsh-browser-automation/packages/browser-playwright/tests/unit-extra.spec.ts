/**
 * Unit coverage for the provider's non-browser surfaces: platform args,
 * executable discovery, env allowlist, the pipe transport, launch failure
 * cleanup, and egress edge cases (control characters, userinfo, empty DNS
 * answers, per-request DNS re-validation, IDN hosts).
 */

import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'
import { BrowserError } from '@dsh-browser-automation/dsh-browser'
import {
  assertPublicHost, assertRequestAllowed, browserEnv, chromeArgs, classifyIpAddress,
  discoverChromeExecutable, launchChrome, pipeTransport,
} from '../src/index.js'
import { assertBackendType } from '../src/invariant.js'

const dnsState = vi.hoisted(() => ({
  sequence: [] as ReadonlyArray<{ readonly kind: 'ok'; readonly addresses: readonly string[] } | { readonly kind: 'error' }>,
}))

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const step = dnsState.sequence.shift()
    if (step === undefined) return [{ address: '93.184.216.34', family: 4 }]
    if (step.kind === 'error') {
      const error = new Error('getaddrinfo ENOTFOUND') as NodeJS.ErrnoException
      error.code = 'ENOTFOUND'
      throw error
    }
    return step.addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }),
}))

afterEach(() => {
  vi.clearAllMocks()
  dnsState.sequence = []
})

describe('chromeArgs', () => {
  it('includes the mock keychain flag only on darwin and headless only when asked', () => {
    const darwin = chromeArgs('/tmp/ud', true, 'darwin')
    expect(darwin).toContain('--use-mock-keychain')
    expect(darwin).toContain('--headless')
    expect(darwin).toContain('--remote-debugging-pipe')
    expect(darwin).toContain('--no-startup-window')

    const linux = chromeArgs('/tmp/ud', false, 'linux')
    expect(linux).not.toContain('--use-mock-keychain')
    expect(linux).not.toContain('--headless')

    const win = chromeArgs('/tmp/ud', true, 'win32')
    expect(win).not.toContain('--use-mock-keychain')
  })
})

describe('browserEnv', () => {
  it('uses the inherited PATH and falls back without one', () => {
    const withPath = browserEnv('/h', '/t', { PATH: '/usr/bin' })
    expect(withPath).toEqual({ HOME: '/h', TMPDIR: '/t', LANG: 'en_US.UTF-8', PATH: '/usr/bin' })
    const withoutPath = browserEnv('/h', '/t', {})
    expect(withoutPath.PATH).toBe('/usr/bin:/bin:/usr/local/bin')
  })
})

describe('discoverChromeExecutable', () => {
  it('probes platform-specific candidates through the injected exists function', () => {
    const exists = (path: string): boolean => path.toLowerCase().includes('chromium')
    expect(discoverChromeExecutable('linux', exists)).toBe('/usr/bin/chromium')
    expect(discoverChromeExecutable('darwin', exists)).toBe('/Applications/Chromium.app/Contents/MacOS/Chromium')
    expect(discoverChromeExecutable('win32', () => true)).toContain('chrome.exe')
  })

  it('returns undefined for unsupported platforms and when nothing exists', () => {
    expect(discoverChromeExecutable('aix', () => true)).toBeUndefined()
    expect(discoverChromeExecutable('linux', () => false)).toBeUndefined()
  })

  it('survives a throwing exists probe', () => {
    expect(discoverChromeExecutable('linux', () => {
      throw new Error('permission denied')
    })).toBeUndefined()
  })
})

describe('pipeTransport', () => {
  function fakeChild(): { child: ChildProcess; written: string[] } {
    const written: string[] = []
    const emitter = new EventEmitter()
    const readSide = new EventEmitter()
    const writeSide = new EventEmitter()
    const child = {
      stdio: [undefined, undefined, undefined, {
        write: (chunk: string): void => {
          written.push(String(chunk))
          return true
        },
        end: (): void => undefined,
        on: (event: string, cb: () => void) => writeSide.on(event, cb),
      } as unknown as Writable, readSide],
      on: (event: string, cb: (...args: unknown[]) => void) => emitter.on(event, cb),
      emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    } as unknown as ChildProcess
    return { child, written }
  }

  it('buffers frames until onmessage is assigned, then dispatches', () => {
    const { child } = fakeChild()
    const transport = pipeTransport(child)
    ;(child.stdio![4] as unknown as EventEmitter).emit('data', Buffer.from('{"id":1}\u0000'))
    let received: object | undefined
    transport.onmessage = message => {
      received = message
    }
    expect(received).toEqual({ id: 1 })
  })

  it('skips empty frames in the stream', () => {
    const { child } = fakeChild()
    const transport = pipeTransport(child)
    let received: object | undefined
    transport.onmessage = message => {
      received = message
    }
    ;(child.stdio![4] as unknown as EventEmitter).emit('data', Buffer.from('\u0000\u0000{"id":2}\u0000'))
    expect(received).toEqual({ id: 2 })
  })

  it('writes null-terminated JSON and ends the stream on close', () => {
    const { child, written } = fakeChild()
    const transport = pipeTransport(child)
    transport.send({ method: 'Browser.getVersion', params: {} })
    expect(written).toEqual(['{"method":"Browser.getVersion","params":{}}\u0000'])
    transport.close()
  })

  it('closes the transport on malformed frames', () => {
    const { child } = fakeChild()
    const transport = pipeTransport(child)
    let closed = false
    transport.onclose = () => {
      closed = true
    }
    ;(child.stdio![4] as unknown as EventEmitter).emit('data', Buffer.from('not json\u0000'))
    expect(closed).toBe(true)
  })

  it('closes the transport when the child exits', () => {
    const { child } = fakeChild()
    const transport = pipeTransport(child)
    let closed = false
    transport.onclose = () => {
      closed = true
    }
    child.emit('exit', 0, null)
    expect(closed).toBe(true)
  })

  it('drops sends after close', () => {
    const { child, written } = fakeChild()
    const transport = pipeTransport(child)
    transport.close()
    transport.send({ id: 1 })
    expect(written).toHaveLength(0)
  })

  it('survives throwing write and end streams', () => {
    const emitter = new EventEmitter()
    const throwingWrite = { write: () => { throw new Error('EPIPE') }, end: () => { throw new Error('closed') }, on: () => undefined }
    const child = {
      stdio: [undefined, undefined, undefined, throwingWrite, new EventEmitter()],
      on: (event: string, cb: (...args: unknown[]) => void) => emitter.on(event, cb),
    } as unknown as ChildProcess
    const transport = pipeTransport(child)
    expect(() => transport.send({ id: 1 })).not.toThrow()
    expect(() => transport.close()).not.toThrow()
  })

  it('reads the assigned onmessage back through the getter', () => {
    const { child } = fakeChild()
    const transport = pipeTransport(child)
    const listener = (): void => undefined
    transport.onmessage = listener
    expect(transport.onmessage).toBe(listener)
  })
})

describe('launchChrome failure cleanup', () => {
  it('rejects a dead process within the handshake bound and removes the temp dirs', async () => {
    const dirs = [await mkdtemp(join(tmpdir(), 'launch-test-')), await mkdtemp(join(tmpdir(), 'launch-test-'))]
    const logPath = join(dirs[0]!, 'chrome.log')
    const marker = join(dirs[1]!, 'marker.txt')
    await writeFile(marker, 'x')
    await expect(launchChrome({
      argv: [process.execPath, '-e', 'process.exit(0)'],
      env: {},
      logPath,
      disposeDirs: dirs,
    })).rejects.toThrow()
    for (const dir of dirs) {
      await expect(readdir(dir)).rejects.toThrow()
    }
  }, 30_000)

  it('cleans up when the executable does not exist', async () => {
    const dirs = [await mkdtemp(join(tmpdir(), 'launch-test-'))]
    await expect(launchChrome({
      argv: ['/nonexistent/binary-xyz'],
      env: {},
      logPath: join(dirs[0]!, 'chrome.log'),
      disposeDirs: dirs,
    })).rejects.toThrow()
    await expect(readdir(dirs[0]!)).rejects.toThrow()
  }, 30_000)
})

describe('egress edge cases', () => {
  it('rejects control characters and userinfo in raw request URLs', async () => {
    await expect(assertRequestAllowed('https://example.com/\u0000x', false)).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' })
    dnsState.sequence = []
    await expect(assertRequestAllowed('https://user:pw@example.com/', false)).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' })
  })

  it('fails closed on empty DNS answers', async () => {
    dnsState.sequence = [{ kind: 'ok', addresses: [] }]
    await expect(assertPublicHost('empty.example', false)).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' })
  })

  it('re-validates DNS per request and blocks a rebinding second answer', async () => {
    dnsState.sequence = [{ kind: 'ok', addresses: ['93.184.216.34'] }, { kind: 'ok', addresses: ['10.0.0.5'] }]
    await expect(assertRequestAllowed('https://rebind.example/', false)).resolves.toBeDefined()
    await expect(assertRequestAllowed('https://rebind.example/', false)).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' })
  })

  it('classifies IDN hosts through their punycode resolution', async () => {
    dnsState.sequence = [{ kind: 'ok', addresses: ['93.184.216.34'] }]
    await expect(assertPublicHost('例子.测试', false)).resolves.toBeUndefined()
    dnsState.sequence = [{ kind: 'ok', addresses: ['127.0.0.1'] }]
    await expect(assertPublicHost('例子.测试', false)).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' })
  })

  it('maps ipv4-mapped private addresses into the private class', () => {
    expect(classifyIpAddress('::ffff:10.0.0.1')).toBe('ipv4-mapped-private')
  })
})

describe('provider invariant', () => {
  it('accepts its own backend type and rejects others', () => {
    expect(() => assertBackendType('playwright-isolated')).not.toThrow()
    expect(() => assertBackendType('other')).toThrow(/expected backend type/)
  })
})
