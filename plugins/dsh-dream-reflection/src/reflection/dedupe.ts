/**
 * Candidate deduplication: exact SHA-256 over the canonical body, then a
 * deterministic near-duplicate gate over mixed word tokens and CJK character
 * trigrams hashed into a fixed 512-bucket vector.
 *
 * @module dsh-dream-reflection/reflection/dedupe
 */

import { createHash } from 'node:crypto'

export const VECTOR_BUCKETS = 512

export interface NearDuplicateHit {
  candidateId: string
  similarity: number
}

/** Canonical body of one candidate for exact hashing and similarity. */
export function canonicalCandidateBody(title: string, summary: string, claimTexts: readonly string[]): string {
  return `${title}\n${summary}\n${claimTexts.join('\n')}`
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Exact-dedupe digest of a canonical body. */
export function exactDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

/** FNV-1a over one token, folded into the vector bucket space. */
export function tokenBucket(token: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % VECTOR_BUCKETS
}

/** Deterministic feature vector: word unigrams/bigrams/trigrams + CJK char trigrams. */
export function featureVector(text: string): number[] {
  const buckets = new Array<number>(VECTOR_BUCKETS).fill(0)
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const grams: string[] = []
  for (const word of words) grams.push(`w:${word}`)
  for (let index = 0; index + 1 < words.length; index += 1) grams.push(`b:${words[index]}_${words[index + 1]}`)
  for (let index = 0; index + 2 < words.length; index += 1) grams.push(`t:${words[index]}_${words[index + 1]}_${words[index + 2]}`)
  const chars = [...text].filter(char => /[\u3400-\u9FFF]/u.test(char))
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    grams.push(`c:${chars.slice(index, index + 3).join('')}`)
  }
  for (const gram of grams) {
    const bucket = tokenBucket(gram)
    buckets[bucket] = (buckets[bucket] ?? 0) + 1
  }
  const magnitude = Math.sqrt(buckets.reduce((sum, count) => sum + count * count, 0))
  return magnitude === 0 ? buckets : buckets.map(count => count / magnitude)
}

/** Cosine similarity between two unit vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0)
  }
  return dot
}

/**
 * Near-duplicate scan against stored vectors. Returns every hit at or above
 * the threshold, most similar first.
 */
export function findNearDuplicates(vector: readonly number[], stored: readonly { candidateId: string; nearVector: number[] }[], threshold: number): NearDuplicateHit[] {
  const hits: NearDuplicateHit[] = []
  for (const candidate of stored) {
    if (candidate.nearVector.length !== vector.length) continue
    const similarity = cosineSimilarity(vector, candidate.nearVector)
    if (similarity >= threshold) hits.push({ candidateId: candidate.candidateId, similarity })
  }
  return hits.sort((a, b) => b.similarity - a.similarity)
}
