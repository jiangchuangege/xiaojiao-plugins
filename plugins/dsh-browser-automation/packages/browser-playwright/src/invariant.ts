/**
 * Runtime invariant companion for the browser-playwright provider: the
 * backend type it registers under, plus a self-check for composition tests.
 * @module @dsh-browser-automation/dsh-browser-playwright/invariant
 */

import { PROVIDER_TYPE } from './provider.js'

/** The exact backend type this package registers with the browser service. */
export const backendType = PROVIDER_TYPE

/** Verify a candidate backend type string equals this package's registration. */
export function assertBackendType(type: string): void {
  if (type !== backendType) {
    throw new Error(`browser-playwright invariant: expected backend type "${backendType}", got "${type}"`)
  }
}
