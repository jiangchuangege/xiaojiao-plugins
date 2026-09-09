/**
 * Output-side checks for model text: the same redaction rules as input, plus
 * a verbatim-copy gate against the run's evidence texts.
 *
 * @module dsh-dream-reflection/safety/output
 */

import { containsSensitiveMaterial } from './redact.ts'

/** Word tokens used by the overlap gate; CJK text is measured by character n-grams. */
const WORD_TOKEN = /[a-z0-9]+/g
const CJK_TRIGRAM_CHARS = 3

/** Rolling-hash word 6-grams of one text, lowercased. */
function wordGrams(text: string): Set<string> {
  const words = (text.toLowerCase().match(WORD_TOKEN) ?? []).filter(word => word.length > 2)
  const grams = new Set<string>()
  for (let index = 0; index + 5 < words.length; index += 1) {
    const gram = words.slice(index, index + 6).join(' ')
    grams.add(gram)
  }
  return grams
}

/** CJK character trigrams of one text. */
function cjkGrams(text: string): Set<string> {
  const chars = [...text].filter(char => /[\u3400-\u9FFF]/u.test(char))
  const grams = new Set<string>()
  for (let index = 0; index + CJK_TRIGRAM_CHARS <= chars.length; index += 1) {
    grams.add(chars.slice(index, index + CJK_TRIGRAM_CHARS).join(''))
  }
  return grams
}

/**
 * Verbatim-copy gate: fraction of one evidence text's word/CJK grams that the
 * model text reproduces. Above {@link VERBATIM_OVERLAP_THRESHOLD} the output
 * is blocked as a long literal copy.
 * @param outputText - the model-produced text.
 * @param evidenceTexts - the redacted evidence texts of this run.
 * @returns the blocking decision.
 */
export function checkVerbatimOverlap(outputText: string, evidenceTexts: readonly string[]): { blocked: boolean; overlap: number } {
  const outputWords = wordGrams(outputText)
  const outputCjk = cjkGrams(outputText)
  let worst = 0
  for (const source of evidenceTexts) {
    const sourceWords = wordGrams(source)
    if (sourceWords.size === 0) continue
    let shared = 0
    for (const gram of outputWords) if (sourceWords.has(gram)) shared += 1
    const ratio = shared / sourceWords.size
    if (ratio > worst) worst = ratio
    const sourceCjk = cjkGrams(source)
    if (sourceCjk.size === 0) continue
    let sharedCjk = 0
    for (const gram of outputCjk) if (sourceCjk.has(gram)) sharedCjk += 1
    const cjkRatio = sharedCjk / sourceCjk.size
    if (cjkRatio > worst) worst = cjkRatio
  }
  return { blocked: worst > VERBATIM_OVERLAP_THRESHOLD, overlap: worst }
}

export const VERBATIM_OVERLAP_THRESHOLD = 0.8

/** Combined output gate: redaction material + verbatim copy. */
export function checkModelOutput(outputText: string, evidenceTexts: readonly string[]): { blocked: boolean; reason?: string } {
  const sensitive = containsSensitiveMaterial(outputText)
  if (sensitive.blocked) return sensitive
  const overlap = checkVerbatimOverlap(outputText, evidenceTexts)
  if (overlap.blocked) return { blocked: true, reason: `verbatim-copy:${overlap.overlap.toFixed(2)}` }
  return { blocked: false }
}
