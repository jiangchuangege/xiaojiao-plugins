/**
 * Runtime invariant companion for the browser service: the registered
 * service name and a self-check usable from Loader composition tests.
 * @module @dsh-browser-automation/dsh-browser/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import { BrowserSessionService, BROWSER_SERVICE_NAME } from './service.js'

/** The exact name this package registers its service under. */
export const serviceName = BROWSER_SERVICE_NAME

/** Verify the live context exposes this package's service under its own name. */
export function assertServiceMounted(ctx: Context): void {
  if (!(ctx.get(serviceName) instanceof BrowserSessionService)) {
    throw new Error(`browser service invariant: ctx.get("${serviceName}") is not the dsh-browser service`)
  }
}
