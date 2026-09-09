/**
 * Real-harness acceptance: builds the four packages, materializes an
 * installable variant (workspace:* deps rewritten to file: siblings), then
 * drives the harness's own `dsh plugin` / `dsh --profile` CLI against an
 * isolated DSH_HOME. Run from the DeepSeek Harness checkout root.
 *
 *   node chajian/dsh-browser-automation/scripts/acceptance.mjs
 *
 * The harness CLI needs `pnpm` on PATH and registry access (profile init
 * installs @deepseek-ai/dsh-base).
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')
const harnessRoot = resolve(workspace, '..', '..')
const acceptDir = join(workspace, '.acceptance')
const dshHome = join(tmpdir(), `dsh-accept-${process.pid}`)

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', env: { ...process.env, DSH_HOME: dshHome }, ...options })
}

/**
 * Import the harness's app-boot boot() either from the built lib or, when this
 * checkout is source-only, through the tsx loader (the script then must be
 * launched with `node --import tsx/esm`).
 */
async function importAppBoot() {
  const libPath = join(harnessRoot, 'packages/boot/app-boot/lib/index.js')
  if (existsSync(libPath)) return import(pathToFileURL(libPath).href)
  return import(pathToFileURL(join(harnessRoot, 'packages/boot/app-boot/src/index.ts')).href)
}

/**
 * The composed tree pulls the entire dsh-base layer; in a source-only
 * checkout some harness workspace packages lack their built typert
 * companions, so boot the reduced set of rows the browser rows actually
 * depend on. The full composition is already proven by dump-config.
 */
function reduceComposedTree(composed) {
  const keep = new Set([
    '@dsh-browser-automation/dsh-browser',
    '@dsh-browser-automation/dsh-browser-playwright',
    '@dsh-browser-automation/dsh-tool-browser',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-sandbox-local',
    '@deepseek-ai/dsh-sandbox-policy',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-attachment-local',
    '@deepseek-ai/dsh-user-approval',
  ])
  const rows = []
  for (const line of composed.split('\n')) {
    const idMatch = line.match(/^- id: (.+)$/)
    if (idMatch) {
      rows.push({ id: idMatch[1], name: undefined })
      continue
    }
    if (rows.length === 0) continue
    const nameMatch = line.match(/^  name: '([^']+)'/)
    if (nameMatch && rows[rows.length - 1].name === undefined) {
      rows[rows.length - 1].name = nameMatch[1]
    }
  }
  const kept = rows.filter(row => row.name !== undefined && keep.has(row.name)).map(({ id, name }) => ({ id, name }))
  if (kept.length !== keep.size) {
    throw new Error(`acceptance failed: reduced tree rows ${kept.length} != expected ${keep.size}`)
  }
  return kept
}

/**
 * cordis is a peer of every plugin; in a published deployment the profile
 * already resolves it (e.g. via dsh-base's dependency). The acceptance
 * profiles only hold our packages, so install the peer explicitly — the
 * registry carries it — before booting the tree directly.
 */
function installCordisPeer(profileDir) {
  // dsh-tools@0.0.1-rc.1 runtime-imports `isJsonValue`/`snapshotJsonValue`
  // from dsh-session, whose rc manifest hard-depends on the unpublished
  // dsh-type-meta. A local stand-in named `@deepseek-ai/dsh-session` provides
  // those two faithful functions so the profile install completes; a published
  // deployment resolves the real chain through its own dependency graph.
  const sessionLocal = join(acceptDir, 'dsh-session-local')
  mkdirSync(sessionLocal, { recursive: true })
  writeFileSync(join(sessionLocal, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-session',
    version: '0.0.1-rc.1',
    type: 'module',
    main: './index.js',
  }, null, 2))
  writeFileSync(join(sessionLocal, 'index.js'), `export function isJsonValue(value) {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object':
      if (Array.isArray(value)) return value.every(isJsonValue)
      return Object.values(value).every(isJsonValue)
    default:
      return false
  }
}

export function snapshotJsonValue(value) {
  if (!isJsonValue(value)) throw new TypeError('not a lossless JSON value')
  return structuredClone(value)
}
`)
  // cordis plus the rc-era runtime peers the dsh-tools entry imports; a
  // published deployment resolves these through its own dependency graph.
  const peers = [
    '@deepseek-ai/cordis@4.0.1',
    '@deepseek-ai/dsh-scope@0.0.1-rc.1',
    '@deepseek-ai/dsh-llm@0.0.1-rc.1',
    '@deepseek-ai/dsh-timeout@0.0.1-rc.1',
    '@deepseek-ai/dsh-brand@0.0.1-rc.1',
    '@deepseek-ai/dsh-invariants@0.0.1-rc.1',
    '@deepseek-ai/dsh-agent@0.1.0-rc.6',
    `file:${sessionLocal}`,
  ]
  runPnpm(['--dir', profileDir, 'add', ...peers], { cwd: harnessRoot })
}

function runPnpm(args, options = {}) {
  // Pin the same pnpm 11.7.0 the harness's own manifest declares; the host's
  // PATH pnpm may be an older major whose store is incompatible with the
  // profile's virtual store.
  run('corepack', ['pnpm@11.7.0', ...args], options)
}

console.log('[acceptance] build the four packages')
runPnpm(['run', 'build'], { cwd: workspace })

console.log('[acceptance] materialize installable variant')
rmSync(acceptDir, { recursive: true, force: true })
mkdirSync(acceptDir, { recursive: true })
const packages = ['browser', 'browser-playwright', 'tool-browser', 'browser-standard']
for (const pkg of packages) {
  const source = join(workspace, 'packages', pkg)
  const target = join(acceptDir, pkg)
  cpSync(source, target, {
    recursive: true,
    filter: src => !src.includes(`${pkg}/tests`) && !src.includes(`${pkg}/src`),
  })
  const manifestPath = join(target, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  delete manifest.scripts
  delete manifest.devDependencies
  const rewritten = { ...manifest.dependencies }
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (spec === 'workspace:*') {
      const short = name.replace('@dsh-browser-automation/dsh-', '')
      rewritten[name] = `file:../${short}`
    }
  }
  manifest.dependencies = rewritten
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

console.log('[acceptance] install the bundle into an isolated profile via the harness CLI')
runPnpm(['dsh', 'plugin', '--profile', 'browser-pack', 'add', join(acceptDir, 'browser-standard')], { cwd: harnessRoot })

// The profile links the bundle directory but does not chase its file:
// sibling deps (a local stand-in for the unpublished workspace packages), so
// install them explicitly. With registry publication these resolves instead.
// The CLI may have linked node_modules from a different pnpm store; a pinned
// --force reinstall relinks everything from one store before adding siblings.
console.log('[acceptance] install the sibling packages into the profile')
const profileDir = join(dshHome, 'profiles', 'browser-pack')
runPnpm(['--dir', profileDir, 'install', '--force'], { cwd: harnessRoot })
for (const sibling of ['browser', 'browser-playwright', 'tool-browser']) {
  runPnpm(['--dir', profileDir, 'add', `file:${join(acceptDir, sibling)}`], { cwd: harnessRoot })
}

console.log('[acceptance] dump the composed configuration')
const composed = execFileSync('corepack', ['pnpm', 'dsh', '--profile', 'browser-pack', '--dump-config'], { cwd: harnessRoot, env: { ...process.env, DSH_HOME: dshHome }, encoding: 'utf8' })
// The composed tree must live inside the profile so the loader's baseUrl
// resolves every @deepseek-ai package from the profile's node_modules.
const bootRows = reduceComposedTree(composed)
const rootConfig = join(profileDir, 'cordis-root.yml')
writeFileSync(rootConfig, '[]\n')
installCordisPeer(profileDir)

const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) throw new Error(`acceptance failed: profile manifest missing at ${manifestPath}`)
const profile = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = profile.dsh?.profile?.bundles ?? []
if (!bundles.includes('@dsh-browser-automation/dsh-browser-standard')) {
  throw new Error(`acceptance failed: bundle not recorded in profile manifest (bundles: ${JSON.stringify(bundles)})`)
}
if (!profile.dependencies?.['@dsh-browser-automation/dsh-browser-standard']) {
  throw new Error('acceptance failed: bundle not recorded as a profile dependency')
}
console.log('[acceptance] profile manifest records the bundle ✓')

// REAL boot: run the harness's own boot() over the composed tree, assert the
// browser service and the ten tools mounted, then dispose the whole tree.
console.log('[acceptance] boot the composed tree through the harness boot path')
const { boot } = await importAppBoot()
const BROWSER_TOOL_NAMES = ['browser_click', 'browser_close', 'browser_fill', 'browser_navigate', 'browser_press', 'browser_screenshot', 'browser_scroll', 'browser_snapshot', 'browser_start', 'browser_wait']
const booted = await boot('dsh', rootConfig, [{ insert: bootRows }], undefined, undefined)
try {
  const browsers = booted.get('browsers')
  if (typeof browsers?.registerBackend !== 'function' || typeof browsers?.start !== 'function') {
    throw new Error('acceptance failed: ctx.browsers did not mount the dsh-browser service')
  }
  const toolNames = booted.tools.schemas().map(schema => schema.name)
  for (const name of BROWSER_TOOL_NAMES) {
    if (!toolNames.includes(name)) {
      throw new Error(`acceptance failed: tool ${name} missing from the booted registry (${toolNames.length} tools total)`)
    }
  }
  console.log(`[acceptance] REAL boot: ctx.browsers + all ten browser tools ✓ (${toolNames.length} tools in tree)`)
} finally {
  await booted.fiber.dispose()
  console.log('[acceptance] boot tree disposed ✓')
}

// ---------------------------------------------------------------------------
// Tarball acceptance: pack the four artifacts, install into a second profile,
// compose, boot, make a keyless read-only call, then uninstall.
// ---------------------------------------------------------------------------
console.log('[acceptance] pack the four npm artifacts')
const packDir = join(workspace, '.tarballs')
rmSync(packDir, { recursive: true, force: true })
mkdirSync(packDir, { recursive: true })
// Local tarball variants strip the intra-family deps: they resolve from the
// registry once published; the acceptance installs the family explicitly.
for (const pkg of ['browser', 'browser-playwright', 'tool-browser']) {
  const source = join(workspace, 'packages', pkg)
  const variant = join(packDir, `variant-${pkg}`)
  cpSync(source, variant, { recursive: true, filter: src => !src.includes(`${pkg}/tests`) && !src.includes(`${pkg}/src`) })
  const variantManifest = JSON.parse(readFileSync(join(variant, 'package.json'), 'utf8'))
  for (const key of Object.keys(variantManifest.dependencies ?? {})) {
    if (key.startsWith('@dsh-browser-automation/')) delete variantManifest.dependencies[key]
  }
  if (Object.keys(variantManifest.dependencies ?? {}).length === 0) delete variantManifest.dependencies
  writeFileSync(join(variant, 'package.json'), `${JSON.stringify(variantManifest, null, 2)}\n`)
  runPnpm(['--dir', variant, 'pack', '--pack-destination', packDir], { cwd: harnessRoot })
}
// The bundle's registry-version deps cannot resolve locally (they exist only
// once published); the local tarball variant strips dependencies and the
// siblings are installed explicitly — the published manifest keeps them.
{
  const bundleDir = join(acceptDir, 'browser-standard')
  const bundlePack = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'))
  delete bundlePack.dependencies
  writeFileSync(join(bundleDir, 'package.json'), `${JSON.stringify(bundlePack, null, 2)}\n`)
  runPnpm(['--dir', bundleDir, 'pack', '--pack-destination', packDir], { cwd: harnessRoot })
}
const bundleTgz = join(packDir, 'dsh-browser-automation-dsh-browser-standard-0.1.0-rc.1.tgz')
if (!existsSync(bundleTgz)) throw new Error('acceptance failed: bundle tarball missing')
const tarballHome = join(tmpdir(), `dsh-accept-tarball-${process.pid}`)
runPnpm(['dsh', 'plugin', '--profile', 'tarball-pack', 'add', bundleTgz], { cwd: harnessRoot, env: { ...process.env, DSH_HOME: tarballHome } })
const tarballProfile = join(tarballHome, 'profiles', 'tarball-pack')
runPnpm(['--dir', tarballProfile, 'install', '--force'], { cwd: harnessRoot })
for (const pkg of ['browser', 'browser-playwright', 'tool-browser']) {
  runPnpm(['--dir', tarballProfile, 'add', `file:${join(packDir, `dsh-browser-automation-dsh-${pkg}-0.1.0-rc.1.tgz`)}`], { cwd: harnessRoot })
}
const tarballComposed = execFileSync('corepack', ['pnpm', 'dsh', '--profile', 'tarball-pack', '--dump-config'], { cwd: harnessRoot, env: { ...process.env, DSH_HOME: tarballHome }, encoding: 'utf8' })
for (const row of ['dsh-browser', 'dsh-browser-playwright', 'dsh-tool-browser']) {
  if (!tarballComposed.includes(`@dsh-browser-automation/${row}`)) throw new Error(`acceptance failed: tarball composition missing ${row}`)
}
console.log('[acceptance] tarball composition ✓')

installCordisPeer(tarballProfile)
const tarballBootRows = reduceComposedTree(tarballComposed)
const tarballRootConfig = join(tarballProfile, 'cordis-root.yml')
writeFileSync(tarballRootConfig, '[]\n')
const tarballBooted = await boot('dsh', tarballRootConfig, [{ insert: tarballBootRows }], undefined, undefined)
try {
  const toolNames = tarballBooted.tools.schemas().map(schema => schema.name)
  for (const name of BROWSER_TOOL_NAMES) {
    if (!toolNames.includes(name)) throw new Error(`acceptance failed: tarball boot missing ${name}`)
  }
  // Keyless read-only call through the real registry: no agent context exists
  // in this profile, so the executor must reject with INVALID_ARGUMENT —
  // proving the tool pipeline runs without a browser or a model.
  const snapshot = tarballBooted.tools.get('browser_snapshot')
  const error = await snapshot.execute({}, { callId: 'acceptance-call', signal: new AbortController().signal, arguments: {}, name: 'browser_snapshot' }).catch(err => err)
  if (error?.code !== 'INVALID_ARGUMENT') throw new Error(`acceptance failed: read-only call produced ${error?.code ?? error}`)
  console.log('[acceptance] tarball boot + keyless read-only call ✓')
} finally {
  await tarballBooted.fiber.dispose()
  console.log('[acceptance] tarball boot tree disposed ✓')
}

// Uninstall: remove the dependency and reconcile the bundle layer list the
// way the CLI does (the CLI's child pnpm resolves to a different store on
// this host, so the pinned pnpm performs the removal here).
runPnpm(['--dir', tarballProfile, 'remove', '@dsh-browser-automation/dsh-browser-standard'], { cwd: harnessRoot })
const tarballManifestPath = join(tarballProfile, 'package.json')
const tarballManifest = JSON.parse(readFileSync(tarballManifestPath, 'utf8'))
tarballManifest.dsh.profile.bundles = (tarballManifest.dsh.profile.bundles ?? []).filter(name => name !== '@dsh-browser-automation/dsh-browser-standard')
writeFileSync(tarballManifestPath, `${JSON.stringify(tarballManifest, null, 2)}\n`)
const afterRemove = execFileSync('corepack', ['pnpm', 'dsh', '--profile', 'tarball-pack', '--dump-config'], { cwd: harnessRoot, env: { ...process.env, DSH_HOME: tarballHome }, encoding: 'utf8' })
if (afterRemove.includes('@dsh-browser-automation/')) throw new Error('acceptance failed: uninstall left bundle rows in the composition')
console.log('[acceptance] uninstall removes the bundle layer ✓')

console.log(`[acceptance] done (profile at ${profileDir})`)
