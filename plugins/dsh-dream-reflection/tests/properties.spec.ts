/**
 * Property tests (fast-check): cursor monotonicity across successive corpus
 * runs, commit idempotency under random payloads, redaction fixpoint, and
 * deterministic workspace keys / feature vectors. All generators are
 * deterministic (seeded), and every property is a replayable assertion.
 */

import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { Context } from '@deepseek-ai/cordis'
import { buildCorpus } from '../src/corpus/build.ts'
import { redactText } from '../src/safety/redact.ts'
import { canonicalizeCwdSync, workspaceKeyFor } from '../src/corpus/workspace.ts'
import { featureVector, cosineSimilarity } from '../src/reflection/dedupe.ts'
import { SqliteDreamReflectionStore } from '../src/store/sqlite.ts'
import type { CandidateSeed } from '../src/store/service.ts'
import { FakeSessionQuery, sessionHeader, turnEndEvent, turnStartEvent, userEvent } from './helpers.ts'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const passthrough = { text: '', dropped: false, ruleId: 'none' }
const redact = (text: string) => ({ ...passthrough, text })

describe('property tests', () => {
  it('corpus cursors are monotonic and never re-consume events', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 24 }),
      fc.integer({ min: 0, max: 16 }),
      async (texts, seedLength) => {
        const ctx = new Context()
        const query = new FakeSessionQuery(ctx)
        const events = [turnStartEvent(0, 0)]
        for (let index = 0; index < texts.length; index += 1) events.push(userEvent(index + 1, texts[index] ?? 'x'))
        events.push(turnEndEvent(texts.length + 1, 0))
        const header = sessionHeader('s1', '/ws', seedLength === 0 ? {} : { seedLength })
        query.set('s1', header, events)
        const seen = new Set<number>()
        let cursor: number | null = null
        for (let round = 0; round < 3; round += 1) {
          const result = await buildCorpus(
            [{ sessionId: 's1', header }],
            { sessionQuery: query, redact, maxSessions: 6, maxEvents: 96, maxEventBytes: 6144, maxInputBytes: 98304, cursors: new Map(cursor === null ? [] : [['s1', cursor]]) },
          )
          for (const unit of result.units) {
            expect(seen.has(unit.seq)).toBe(false)
            seen.add(unit.seq)
          }
          const range = result.checkedThrough[0]
          if (range !== undefined) {
            expect(cursor === null || range.seq > cursor).toBe(true)
            cursor = range.seq
          }
        }
        void ctx.fiber.dispose()
      },
    ), { numRuns: 25, seed: 20260813 })
  })

  it('a settled run can never be committed twice and never changes state', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        title: fc.string({ minLength: 1, maxLength: 12 }),
        summary: fc.string({ minLength: 1, maxLength: 24 }),
      }), { minLength: 0, maxLength: 6 }),
      async (cards) => {
        const dir = mkdtempSync(join(tmpdir(), 'dream-prop-'))
        tempDirs.push(dir)
        const ctx = new Context()
        const store = new SqliteDreamReflectionStore(ctx, { path: join(dir, 'state.sqlite'), busyTimeoutMs: 2000, leaseTtlMs: 5000 })
        await store.open()
        const fences = store.beginRun({ runId: 'r1', workspaceKey: 'w1', trigger: 'auto', phase: 'queued', createdAt: 1 }, 'h', 60_000, 1)!
        const seeds: CandidateSeed[] = cards.map((card, index) => ({
          candidateId: `cand-${index}`,
          workspaceKey: 'w1',
          status: 'quarantined' as const,
          confidence: 'medium' as const,
          title: card.title,
          summary: card.summary,
          claims: [{ text: 'claim', evidenceRefs: ['e0'] }],
          limitations: [],
          reviewQuestion: 'q?',
          sourceRefs: [{ ref: 'e0', sessionId: 's1', seq: 1, eventType: 'user/message', contentHash: 'h' }],
          contentHash: `hash-${index}`,
          nearVector: [0, 1],
          createdAt: 1,
        }))
        const payload = {
          workspaceKey: 'w1',
          candidates: seeds,
          challengeIds: [],
          cursors: [{ sessionId: 's1', seq: 5, contentHash: 'h5' }],
          workspace: { lastSuccessAt: 2, failureCount: 0, nextEligibleAt: 3 },
          finishedAt: 2,
        }
        const base = { runId: 'r1', holderId: 'h', globalFence: fences.globalFence, workspaceFence: fences.workspaceFence, status: 'committed' as const, errorCode: null, usage: null }
        expect(store.commitRun({ ...base, ...payload })).toBe(true)
        const before = store.listCandidates('w1').length
        expect(store.commitRun({ ...base, ...payload, candidates: [], cursors: [] })).toBe(false)
        expect(store.listCandidates('w1')).toHaveLength(before)
        expect(store.getCursor('w1', 's1')).toBe(5)
        await store.close()
        void ctx.fiber.dispose()
      },
    ), { numRuns: 15, seed: 20260813 })
  })

  it('redaction is idempotent and never leaks the original material', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 0, maxLength: 200 }),
      (text) => {
        const first = redactText(text)
        const second = redactText(first.text)
        expect(second.text).toBe(first.text)
        expect(second.dropped).toBe(first.dropped)
        if (!first.dropped) {
          for (const secret of ['sk-abcdefghijklmnopqrstuvwxyz123456', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-abcdefghijklmnop', 'eyJhbGciOiJIUzI1NiJ9', 'PRIVATE KEY', 'password = hunter2secret99']) {
            if (text.includes(secret)) expect(first.text.includes(secret)).toBe(false)
          }
        }
      },
    ), { numRuns: 200, seed: 20260813 })
  })

  it('workspace keys are deterministic hex digests and feature vectors self-similar', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 60 }),
      (path) => {
        const key = workspaceKeyFor('salt', path)
        expect(key).toMatch(/^[0-9a-f]{64}$/)
        expect(workspaceKeyFor('salt', path)).toBe(key)
        const vector = featureVector(path)
        expect(featureVector(path)).toEqual(vector)
        const magnitude = Math.sqrt(vector.reduce((sum, count) => sum + count * count, 0))
        if (magnitude > 0) expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 10)
        const canonical = canonicalizeCwdSync(path)
        expect(canonical).toBeDefined()
        expect(canonical?.startsWith('/') || /^[A-Za-z]:[\\/]/.test(canonical ?? '')).toBe(true)
      },
    ), { numRuns: 100, seed: 20260813 })
  })
})
