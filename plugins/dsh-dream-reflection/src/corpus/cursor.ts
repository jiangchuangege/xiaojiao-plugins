/**
 * Per-session consumption watermarks and the content hash of one checked
 * range. Pure helpers; the authoritative cursor rows live in the store.
 *
 * @module dsh-dream-reflection/corpus/cursor
 */

import { createHash } from 'node:crypto'

/**
 * The first seq a corpus reader may consume for one session: forked sessions
 * skip their inherited seed so parent history is never recounted.
 * @param seedLength - the durable fork boundary, when present.
 * @returns the floor seq (inclusive lower bound of the unread range).
 */
export function cursorFloorFor(seedLength: number | undefined): number {
  return Math.max(0, seedLength ?? 0)
}

/**
 * Hash the redacted texts of the contiguous range a run actually checked.
 * Stored beside the advanced cursor; it is a digest, never the text.
 * @param texts - redacted event texts in ascending seq order.
 * @returns lowercase hex SHA-256.
 */
export function rangeContentHash(texts: readonly string[]): string {
  return createHash('sha256').update(texts.join('\n')).digest('hex')
}

/** Whether a proposed next cursor is a monotonic advance over the stored one. */
export function isCursorAdvance(stored: number | null, next: number): boolean {
  return next > (stored ?? -1)
}
