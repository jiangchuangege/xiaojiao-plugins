/**
 * Egress policy for the browser provider: structural URL validation, IP
 * address classification, and DNS-backed public-target verification. Every
 * request — top-level navigation, redirect hops, subresources, and iframes —
 * passes this policy before it may leave the browser. The policy rejects
 * non-http(s) schemes, userinfo, control characters, private/loopback/
 * link-local/multicast/metadata destinations, and (for navigation targets)
 * query or fragment strings.
 *
 * The classification is resolved at request time from the DNS answer; it
 * reduces but cannot eliminate DNS-rebinding races, and the provider never
 * claims a full connect-IP guarantee on platforms where it cannot prove one.
 * @module @dsh-browser-automation/dsh-browser-playwright/egress
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { BrowserError } from '@dsh-browser-automation/dsh-browser'

/** Classification of one resolved IP address. */
export type IpClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'multicast'
  | 'unspecified'
  | 'ipv4-mapped-private'

/** Classify one IPv4/IPv6 address string against the blocklist vocabulary. */
export function classifyIpAddress(address: string): IpClass {
  const ip = address.trim().toLowerCase()
  if (ip.startsWith('::ffff:')) {
    const embedded = ip.slice('::ffff:'.length)
    const cls = classifyIpAddress(embedded)
    return cls === 'public' ? 'public' : 'ipv4-mapped-private'
  }
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number)
    const [a, b] = parts as [number, number]
    if (a === 0) return 'unspecified'
    if (a === 127) return 'loopback'
    if (a === 10) return 'private'
    if (a === 172 && b >= 16 && b <= 31) return 'private'
    if (a === 192 && b === 168) return 'private'
    if (a === 169 && b === 254) return 'link-local'
    if (a >= 224 && a <= 239) return 'multicast'
    if (a === 100 && b >= 64 && b <= 127) return 'private'
    return 'public'
  }
  if (isIP(ip) === 6) {
    const normalized = ip.replace(/^\[|\]$/g, '')
    if (normalized === '::' || normalized === '::1') return normalized === '::1' ? 'loopback' : 'unspecified'
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return 'private'
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return 'link-local'
    if (normalized.startsWith('ff')) return 'multicast'
    if (normalized.startsWith('2001:db8:')) return 'private'
    return 'public'
  }
  return 'public'
}

/** One classified request target. */
export interface ClassifiedRequest {
  readonly url: string
  readonly origin: string
}

/** Structural validation shared by navigation and subresource checks. */
function parseHttpUrl(raw: string): URL {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new BrowserError('NETWORK_POLICY_BLOCKED', 'URLs with control characters are not permitted', { retryable: false })
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BrowserError('NETWORK_POLICY_BLOCKED', 'request URL is not a parseable http(s) URL', { retryable: false })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError('NETWORK_POLICY_BLOCKED', 'only http and https requests are permitted', { retryable: false })
  }
  if (url.username !== '' || url.password !== '') {
    throw new BrowserError('NETWORK_POLICY_BLOCKED', 'URLs with userinfo are not permitted', { retryable: false })
  }
  // The WHATWG parser yields a non-empty host for every http(s) URL it
  // accepts, so a hostname check would be unreachable.
  return url
}

/**
 * Validate one navigation target: exact http(s), no userinfo, no query or
 * fragment. Public targets must use port 80/443; under the test-only
 * `allowLoopback` policy loopback fixtures may use any port.
 * @returns the normalized url and its reduced origin.
 */
export function validateNavigateTarget(raw: string, allowLoopback = false): ClassifiedRequest {
  const url = parseHttpUrl(raw)
  if (url.search !== '' || url.hash !== '') {
    throw new BrowserError('NETWORK_POLICY_BLOCKED', 'navigation targets must not carry query or fragment strings', { retryable: false })
  }
  if (!allowLoopback && url.port !== '' && url.port !== '80' && url.port !== '443') {
    throw new BrowserError('NETWORK_POLICY_BLOCKED', 'navigation targets must use port 80 or 443', { retryable: false })
  }
  return { url: url.href, origin: `${url.protocol}//${url.host}` }
}

/**
 * Resolve a hostname and require every answer to be a permitted address
 * class. Loopback answers are permitted only under the test-only
 * `allowLoopback` policy.
 */
export async function assertPublicHost(hostname: string, allowLoopback: boolean): Promise<void> {
  let answers: readonly string[]
  try {
    answers = (await lookup(hostname, { all: true, verbatim: true })).map(record => record.address)
  } catch {
    throw new BrowserError('NETWORK_POLICY_BLOCKED', 'DNS resolution failed for the target host', { retryable: false })
  }
  for (const address of answers) {
    const cls = classifyIpAddress(address)
    if (cls === 'public') continue
    if (cls === 'loopback' && allowLoopback) continue
    throw new BrowserError('NETWORK_POLICY_BLOCKED', `target resolves to a non-public address class (${cls})`, { retryable: false })
  }
  if (answers.length === 0) {
    throw new BrowserError('NETWORK_POLICY_BLOCKED', 'DNS resolution returned no addresses', { retryable: false })
  }
}

/** Verify one outgoing request URL: structure plus public DNS answers. */
export async function assertRequestAllowed(rawUrl: string, allowLoopback: boolean): Promise<ClassifiedRequest> {
  const url = parseHttpUrl(rawUrl)
  await assertPublicHost(url.hostname, allowLoopback)
  return { url: url.href, origin: `${url.protocol}//${url.host}` }
}

/** Reduced origin of a URL string without full validation. */
export function originOf(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}
