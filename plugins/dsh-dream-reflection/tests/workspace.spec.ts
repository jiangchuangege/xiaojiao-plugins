import { describe, expect, it } from 'vitest'
import { mkdtempSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalizeCwdSync, sameWorkspace, workspaceKeyFor } from '../src/corpus/workspace.ts'
import { cursorFloorFor, isCursorAdvance, rangeContentHash } from '../src/corpus/cursor.ts'

describe('workspace identity', () => {
  it('canonicalizes an existing directory through realpath', () => {
    const root = mkdtempSync(join(tmpdir(), 'dream-ws-'))
    const real = join(root, 'real')
    const link = join(root, 'link')
    mkdirSync(real)
    symlinkSync(real, link)
    expect(canonicalizeCwdSync(link)).toBe(realpathSync(real))
    expect(canonicalizeCwdSync(real)).toBe(realpathSync(real))
  })

  it('resolves the deepest existing ancestor of a missing suffix', () => {
    const root = mkdtempSync(join(tmpdir(), 'dream-ws-'))
    const missing = join(root, 'does', 'not', 'exist')
    expect(canonicalizeCwdSync(missing)).toBe(join(realpathSync(root), 'does', 'not', 'exist'))
  })

  it('returns undefined for empty input', () => {
    expect(canonicalizeCwdSync('')).toBeUndefined()
    expect(canonicalizeCwdSync(undefined)).toBeUndefined()
  })

  it('is exact and case-sensitive after canonicalization', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dream-ws-')))
    expect(sameWorkspace(root, root)).toBe(true)
    expect(sameWorkspace(join(root, 'other'), root)).toBe(false)
    expect(sameWorkspace(undefined, root)).toBe(false)
  })

  it('derives a stable HMAC key that hides the path and depends on the salt', () => {
    const key = workspaceKeyFor('salt-a', '/home/user/project')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(workspaceKeyFor('salt-a', '/home/user/project')).toBe(key)
    expect(workspaceKeyFor('salt-b', '/home/user/project')).not.toBe(key)
    expect(key).not.toContain('project')
  })
})

describe('cursor helpers', () => {
  it('uses the fork seed boundary as the read floor', () => {
    expect(cursorFloorFor(undefined)).toBe(0)
    expect(cursorFloorFor(0)).toBe(0)
    expect(cursorFloorFor(17)).toBe(17)
  })

  it('hashes the checked range and enforces monotonic advance', () => {
    const hash = rangeContentHash(['a', 'b'])
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rangeContentHash(['a', 'b'])).toBe(hash)
    expect(rangeContentHash(['b', 'a'])).not.toBe(hash)
    expect(isCursorAdvance(null, 0)).toBe(true)
    expect(isCursorAdvance(5, 6)).toBe(true)
    expect(isCursorAdvance(5, 5)).toBe(false)
    expect(isCursorAdvance(5, 4)).toBe(false)
  })
})
