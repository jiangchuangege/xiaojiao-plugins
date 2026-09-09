import { describe, expect, it, vi } from 'vitest'
import { BrowserError } from '@dsh-browser-automation/dsh-browser'
import {
  assertPublicHost,
  classifyIpAddress,
  validateNavigateTarget,
  originOf,
} from '../src/egress.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname === 'broken.dns.test') {
      const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException
      error.code = 'ENOTFOUND'
      throw error
    }
    return [{ address: '127.0.0.1', family: 4 }]
  }),
}))

describe('classifyIpAddress', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['8.8.8.8', 'public'],
    ['93.184.216.34', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.8.8.8', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['224.0.0.1', 'multicast'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.1', 'private'],
    ['100.127.255.255', 'private'],
    ['100.128.0.1', 'public'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:4860:4860::8888', 'public'],
    ['2001:db8::1', 'private'],
    ['fe90::1', 'link-local'],
    ['fea0::1', 'link-local'],
    ['feb0::1', 'link-local'],
    ['not-an-ip', 'public'],
    ['::ffff:127.0.0.1', 'ipv4-mapped-private'],
    ['::ffff:8.8.8.8', 'public'],
  ]
  it.each(cases)('classifies %s as %s', (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected)
  })
})

describe('validateNavigateTarget', () => {
  it('accepts exact http(s) URLs and reduces the origin', () => {
    expect(validateNavigateTarget('https://example.com/a/b')).toEqual({ url: 'https://example.com/a/b', origin: 'https://example.com' })
    // Default ports are normalized away by URL parsing.
    expect(validateNavigateTarget('http://example.com:80/x')).toEqual({ url: 'http://example.com/x', origin: 'http://example.com' })
  })

  it('rejects query strings, fragments, userinfo, schemes, and odd ports', () => {
    for (const raw of [
      'https://example.com/?q=1',
      'https://example.com/a#frag',
      'https://user:pw@example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://example.com:8443/',
      'https://example.com:0/',
      'not a url',
    ]) {
      expect(() => validateNavigateTarget(raw), raw).toThrowError(BrowserError)
    }
  })

  it('rejects control characters', () => {
    expect(() => validateNavigateTarget('https://example.com/\u0000x')).toThrowError(BrowserError)
  })
})

describe('assertPublicHost', () => {
  it('blocks loopback resolution without the test-only flag', async () => {
    await expect(assertPublicHost('localhost', false)).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' })
  })

  it('permits loopback resolution under the test-only flag', async () => {
    await expect(assertPublicHost('localhost', true)).resolves.toBeUndefined()
  })

  it('fails closed when DNS resolution fails', async () => {
    await expect(assertPublicHost('broken.dns.test', false)).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' })
  })
})

describe('originOf', () => {
  it('reduces http(s) URLs and rejects the rest', () => {
    expect(originOf('https://example.com/a?q=1')).toBe('https://example.com')
    expect(originOf('about:blank')).toBeNull()
    expect(originOf('file:///x')).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })
})
