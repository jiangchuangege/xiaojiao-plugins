/**
 * Runtime invariant companion for the tool consumer: the registered tool set
 * must equal the manifest's declared set, one registration each.
 * @module @dsh-browser-automation/dsh-tool-browser/invariant
 */

import { TOOL_NAMES } from './manifest.js'

/** The exact ordered tool names this package declares. */
export const toolNames: readonly string[] = TOOL_NAMES

/** Verify a registry's callable set matches the manifest exactly. */
export function assertToolSet(registered: readonly string[]): void {
  const sorted = [...registered].sort()
  const expected = [...TOOL_NAMES].sort()
  const missing = expected.filter(name => !sorted.includes(name))
  const extra = sorted.filter(name => !expected.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`tool-browser invariant: registered set drifted (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`)
  }
}
