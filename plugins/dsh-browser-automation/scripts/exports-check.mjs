/**
 * Plain-Node export verification: builds the three packages and asserts each
 * built entry point's contract from a bare Node consumer —
 * - `dsh-browser` default-exports the service class (service package rule),
 * - `dsh-browser-playwright` / `dsh-tool-browser` named-export their function
 *   plugin slots (`name`/`inject`/`Config`/`apply`) with no default export
 *   (function-plugin rule),
 * - every `./invariant` subpath exports its declared surface.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

function assert(condition, message) {
  if (!condition) throw new Error(`exports-check failed: ${message}`)
}

console.log('[exports-check] build the packages')
run('corepack', ['pnpm@11.7.0', 'run', 'build'])

console.log('[exports-check] plain-node service export contract')
const browser = await import(pathToFileURL(join(workspace, 'packages/browser/lib/index.js')).href)
assert(typeof browser.default === 'function', 'dsh-browser must default-export its service class')
assert(browser.BrowserSessionService === browser.default, 'named service export must equal the default')
assert(Array.isArray(browser.BROWSER_ERROR_CODES), 'error code list must be exported')
assert(typeof browser.BrowserError === 'function', 'BrowserError must be exported')

const browserInvariant = await import(pathToFileURL(join(workspace, 'packages/browser/lib/invariant.js')).href)
assert(typeof browserInvariant.assertServiceMounted === 'function', 'browser invariant must export assertServiceMounted')

console.log('[exports-check] plain-node function-plugin export contracts')
for (const [pkg, expected] of [
  ['browser-playwright', 'browser-playwright'],
  ['tool-browser', 'tool-browser'],
]) {
  const mod = await import(pathToFileURL(join(workspace, 'packages', pkg, 'lib/index.js')).href)
  assert(mod.name === expected, `${pkg} must export name="${expected}"`)
  assert(Array.isArray(mod.inject), `${pkg} must export an inject array`)
  assert(typeof mod.apply === 'function', `${pkg} must export apply`)
  assert(mod.Config !== undefined, `${pkg} must export a Config schema`)
  assert(mod.default === undefined, `${pkg} must not have a default export`)
  const invariant = await import(pathToFileURL(join(workspace, 'packages', pkg, 'lib/invariant.js')).href)
  assert(invariant !== undefined, `${pkg} invariant subpath must load`)
}

console.log('[exports-check] bundle manifest contract')
const bundleManifest = JSON.parse(readFileSync(join(workspace, 'packages/browser-standard/package.json'), 'utf8'))
assert(bundleManifest.dsh?.bundle?.patch === './cordis.patch.yml', 'bundle must declare dsh.bundle.patch')
assert(existsSync(join(workspace, 'packages/browser-standard/cordis.patch.yml')), 'bundle patch file must exist')

console.log('[exports-check] all export contracts hold ✓')
