/**
 * `@dsh-browser-automation/dsh-browser-playwright`: registers the isolated
 * Playwright/Chromium backend with `ctx.browsers`. A function/namespace
 * plugin (no default export): it registers INTO the seam's backend registry.
 * @module @dsh-browser-automation/dsh-browser-playwright
 */

export {
  Config,
  PlaywrightBrowserBackend,
  PROVIDER_TYPE,
  apply,
  inject,
  name,
  resolveConfig,
} from './provider.js'
export type {
  ProviderConfig,
  ResolvedProviderConfig,
  SandboxPolicyView,
  SandboxProviderView,
} from './provider.js'
export {
  chromeArgs,
  browserEnv,
  discoverChromeExecutable,
  launchChrome,
  pipeTransport,
} from './launcher.js'
export type { LaunchChromeOptions, LaunchHandle } from './launcher.js'
export { PlaywrightBrowserSession } from './session.js'
export type { PlaywrightSessionOptions } from './session.js'
export {
  assertPublicHost,
  assertRequestAllowed,
  classifyIpAddress,
  originOf,
  validateNavigateTarget,
} from './egress.js'
export type { ClassifiedRequest, IpClass } from './egress.js'
export { extractPage } from './extract.js'
export type { ExtractBounds, ExtractedElement, ExtractResult } from './extract.js'
