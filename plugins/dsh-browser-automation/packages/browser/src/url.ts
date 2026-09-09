/**
 * URL reduction shared by the service (approval reasons) and validated again
 * by providers (egress policy). Only structural reduction lives here:
 * exact `http:`/`https:` URLs without userinfo; origin and a redacted display
 * form. Network reachability classification belongs to the provider.
 * @module @dsh-browser-automation/dsh-browser/url
 */

import { BrowserError } from './errors.js'

/** Reduce a candidate target URL to `{ origin, displayUrl }` or throw INVALID_ARGUMENT. */
export function reduceTargetUrl(raw: string): { readonly origin: string | null; readonly displayUrl: string } {
  if (raw === 'about:blank') return { origin: null, displayUrl: 'about:blank' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BrowserError('INVALID_ARGUMENT', 'target must be an exact http or https URL', { retryable: false })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError('INVALID_ARGUMENT', 'target must be an exact http or https URL', { retryable: false })
  }
  if (url.username !== '' || url.password !== '') {
    throw new BrowserError('INVALID_ARGUMENT', 'target URLs must not carry userinfo', { retryable: false })
  }
  // The WHATWG parser yields a non-empty host for every http(s) URL it
  // accepts (hostless forms are rejected or re-hosted), so a hostname check
  // would be unreachable; the provider's egress layer re-validates anyway.
  const origin = `${url.protocol}//${url.host}`
  return { origin, displayUrl: `${url.protocol}//${url.host}${url.pathname}` }
}
