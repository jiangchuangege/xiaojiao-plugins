/**
 * Workspace identity: platform canonicalization and the salted HMAC key used
 * as the stable, non-reversible database identifier.
 *
 * The raw absolute cwd is never persisted or logged; only the HMAC key is.
 *
 * @module dsh-dream-reflection/corpus/workspace
 */

import { realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createHmac } from 'node:crypto'

/** Bounded cache of canonical forms; keys are raw cwd strings. */
const canonicalCache = new Map<string, string>()
const CANONICAL_CACHE_MAX = 512

/**
 * Canonicalize a cwd: absolute resolution plus the deepest existing ancestor
 * resolved through `realpath` (symlink aliases collapse), with the missing
 * suffix restored. Synchronous so the system-prompt context provider can call
 * it on every assembly.
 * @param cwd - raw working directory string.
 * @returns the canonical platform path, or `undefined` when the input is empty.
 */
export function canonicalizeCwdSync(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const cached = canonicalCache.get(cwd)
  if (cached !== undefined) return cached
  let current = resolve(cwd)
  const missing: string[] = []
  while (true) {
    try {
      const real = realpathSync(current)
      const canonical = missing.length === 0 ? real : join(real, ...missing.reverse())
      canonicalCache.set(cwd, canonical)
      if (canonicalCache.size > CANONICAL_CACHE_MAX) {
        const oldest = canonicalCache.keys().next().value as string | undefined
        if (oldest !== undefined) canonicalCache.delete(oldest)
      }
      return canonical
    } catch {
      const parent = dirname(current)
      if (parent === current) return current
      const leaf = current.slice(parent.length).replace(/^[\\/]+/, '')
      missing.push(leaf)
      current = parent
    }
  }
}

/** Test whether one cwd canonicalizes into another exact canonical cwd. */
export function sameWorkspace(a: string | undefined, canonical: string): boolean {
  return canonicalizeCwdSync(a) === canonical
}

/**
 * Stable non-reversible workspace key: HMAC-SHA256 of the canonical cwd under
 * the per-installation random salt. Deterministic across processes sharing
 * one `$DSH_HOME`.
 * @param instanceSalt - the database `instanceSalt`.
 * @param canonicalCwd - the canonical workspace path.
 * @returns lowercase hex digest.
 */
export function workspaceKeyFor(instanceSalt: string, canonicalCwd: string): string {
  return createHmac('sha256', instanceSalt).update(`${canonicalCwd}\n`).digest('hex')
}

/** The platform directory separator, kept out of the HMAC input on purpose. */
export const PATH_SEP = sep
