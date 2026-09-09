import { describe, expect, it } from 'vitest'
import { canonicalCandidateBody, cosineSimilarity, exactDigest, featureVector, findNearDuplicates } from '../src/reflection/dedupe.ts'

describe('dedupe', () => {
  it('canonicalizes bodies and digests deterministically', () => {
    const body = canonicalCandidateBody('Title', 'Summary\nline', ['claim one', 'claim two'])
    expect(exactDigest(body)).toMatch(/^[0-9a-f]{64}$/)
    expect(exactDigest(canonicalCandidateBody('Title', 'Summary line', ['claim one', 'claim two']))).toBe(exactDigest(body))
  })

  it('measures near-similarity above the launch threshold for near-identical text', () => {
    const a = featureVector('the build breaks when the lockfile drifts and dependencies resolve differently across the whole workspace after every update')
    const b = featureVector('the build breaks when the lockfile drifts and dependencies resolve wrong across the whole workspace after every update')
    const c = featureVector('totally unrelated text about dinner plans and weekend trips with friends in the mountains')
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.9)
    expect(cosineSimilarity(a, c)).toBeLessThan(0.4)
  })

  it('captures CJK similarity through character trigrams', () => {
    const a = featureVector('构建在锁文件漂移时失败，依赖解析方式改变，整个工作区在每次更新后都会受影响')
    const b = featureVector('构建在锁文件漂移时失败，依赖解析方式变了，整个工作区在每次更新后都会受影响')
    const c = featureVector('今晚吃什么和周末去哪里旅行完全无关，只是随口问问明天的天气如何')
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.85)
    expect(cosineSimilarity(a, c)).toBeLessThan(0.3)
  })

  it('reports near-duplicate hits against stored vectors, best first', () => {
    const vector = featureVector('the build breaks when the lockfile drifts and dependencies resolve wrong across the whole workspace after every update')
    const hits = findNearDuplicates(vector, [
      { candidateId: 'other', nearVector: featureVector('unrelated words about the weather forecast today') },
      { candidateId: 'close', nearVector: featureVector('the build breaks when the lockfile drifts and dependencies resolve wrong across the whole workspace after every update') },
    ], 0.9)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.candidateId).toBe('close')
  })

  it('yields a unit vector', () => {
    const vector = featureVector('a b c')
    const magnitude = Math.sqrt(vector.reduce((sum, count) => sum + count * count, 0))
    expect(magnitude).toBeCloseTo(1, 10)
  })
})
