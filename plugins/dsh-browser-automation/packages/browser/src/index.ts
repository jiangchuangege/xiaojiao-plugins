/**
 * Browser automation capability seam — Service Definition package.
 * Service packages default-export their service class; the Context
 * augmentation exposes it as `ctx.browsers`.
 * @module @dsh-browser-automation/dsh-browser
 */

import { BrowserSessionService, BROWSER_SERVICE_NAME } from './service.js'

export { BrowserSessionService, BROWSER_SERVICE_NAME } from './service.js'
export type { BrowserServiceConfig } from './service.js'
export { BrowserError, BROWSER_ERROR_CODES, isBrowserError } from './errors.js'
export type { BrowserErrorCode, BrowserErrorContext } from './errors.js'
export { BrowserSessionId, BrowserPageId, ObservationId, ElementRef } from './brand.js'
export type { BrowserSessionId as BrowserSessionIdType, BrowserPageId as BrowserPageIdType, ObservationId as ObservationIdType, ElementRef as ElementRefType } from './brand.js'
export { reduceTargetUrl } from './url.js'
export type {
  ActionPermit, ActRequest, ActSpec, ActionResult, BrowserAction, BrowserBackend,
  BrowserBackendSession, BrowserOperation, CloseRequest, CloseResult, NavigateRequest,
  NavigateResult, NavigateSpec, Observation, ObservedElement, ObserveRequest, PressKey,
  ScreenshotRequest, ScreenshotResult, SessionView, StartRequest, WaitRequest,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browsers: BrowserSessionService
  }
}

export default BrowserSessionService
