/**
 * Deterministic two-way redaction rules for transcript input and model
 * output. Versioned: rule changes bump {@link REDACTION_RULES_VERSION} and the
 * stored prompt-version row so canonical-request reconstruction stays honest.
 *
 * Local hits are irreversibly placeholder-replaced; events that cannot be
 * safely repaired locally (private key material, mostly-secret text) are
 * dropped whole. Dropped bodies are never persisted — only the rule id, count,
 * and content hash travel with the run ledger.
 *
 * @module dsh-dream-reflection/safety/redact
 */

export const REDACTION_RULES_VERSION = 1

export interface RedactionResult {
  text: string
  dropped: boolean
  ruleId: string
}

export type Redactor = (text: string) => RedactionResult

/** A matched span replacement. */
interface Rule {
  pattern: RegExp
  placeholder: string
  drop?: boolean
}

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g

const SECRET_ASSIGNMENT = /(api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9._\-+/]{12,}['"]?/gi

/** Rules applied to every transcript and every model output. */
export const REDACTION_RULES: readonly Rule[] = [
  { pattern: PRIVATE_KEY_BLOCK, placeholder: '<REDACTED:private-key>', drop: true },
  { pattern: SECRET_ASSIGNMENT, placeholder: '<REDACTED:secret-assignment>' },
  { pattern: /AKIA[0-9A-Z]{16}/g, placeholder: '<REDACTED:aws-access-key>' },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, placeholder: '<REDACTED:github-token>' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, placeholder: '<REDACTED:openai-key>' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, placeholder: '<REDACTED:google-key>' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, placeholder: '<REDACTED:slack-token>' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, placeholder: '<REDACTED:jwt>' },

  { pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, placeholder: '<REDACTED:phone>' },
  { pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g, placeholder: '<REDACTED:cn-id>' },
  { pattern: /https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/gi, placeholder: '<REDACTED:credential-url>' },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, placeholder: '<REDACTED:email>' },
  { pattern: /https?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|\[::1\]|[a-z0-9-]+\.(?:internal|local|lan|corp|intranet))[^\s]*/gi, placeholder: '<REDACTED:private-url>' },
]

/** Fraction of redacted text above which the whole event is dropped. */
export const MOSTLY_SECRET_FRACTION = 0.5

/** Minimum length for the high-entropy token sweep. */
export const HIGH_ENTROPY_MIN_LENGTH = 32
/** Shannon entropy (bits per char) above which a long token is replaced. */
export const HIGH_ENTROPY_THRESHOLD = 3.5

/**
 * Shannon entropy per character of an ASCII token. Deterministic, cheap, and
 * deliberately conservative: only clearly random-looking tokens qualify.
 * @param token - the candidate token.
 * @returns entropy in bits per character.
 */
export function tokenEntropy(token: string): number {
  const counts = new Map<string, number>()
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  const length = token.length
  for (const count of counts.values()) {
    const probability = count / length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

/** Extract the rule name from a `<REDACTED:name>` placeholder. */
function ruleName(placeholder: string): string {
  return placeholder.slice(placeholder.indexOf(':') + 1, -1)
}

/** The core rule: redact a single text with the deterministic rule set. */
export function redactText(text: string): RedactionResult {
  let output = text
  let dropped = false
  let ruleId = 'none'
  for (const rule of REDACTION_RULES) {
    if (rule.pattern.test(output)) {
      rule.pattern.lastIndex = 0
      output = output.replace(rule.pattern, rule.placeholder)
      if (rule.drop === true) {
        dropped = true
        ruleId = ruleName(rule.placeholder)
      } else if (ruleId === 'none') {
        ruleId = ruleName(rule.placeholder)
      }
    }
  }
  if (!dropped) {
    output = output.replace(new RegExp(`[A-Za-z0-9_-]{${HIGH_ENTROPY_MIN_LENGTH},}`, 'g'), token => {
      const trimmed = token.replace(/^-+|-+$/g, '')
      if (trimmed.length < HIGH_ENTROPY_MIN_LENGTH) return token
      if (tokenEntropy(trimmed) < HIGH_ENTROPY_THRESHOLD) return token
      return '<REDACTED:high-entropy>'
    })
  }
  if (!dropped) {
    const originalLength = text.length
    const replacedLength = [...output.matchAll(/<REDACTED:[^>]+>/g)].reduce((sum, match) => sum + match[0].length, 0)
    if (originalLength > 0 && replacedLength / originalLength > MOSTLY_SECRET_FRACTION) {
      dropped = true
      ruleId = 'mostly-secret'
    }
  }
  return { text: output, dropped, ruleId }
}

/** The default redactor used by the corpus builder and the pipeline. */
export const redactor: Redactor = redactText

/** True when a model-produced text still contains redaction-rule material. */
export function containsSensitiveMaterial(text: string): { blocked: boolean; reason?: string } {
  const result = redactText(text)
  if (result.dropped) return { blocked: true, reason: result.ruleId }
  if (result.text !== text) return { blocked: true, reason: 'redaction-hit' }
  return { blocked: false }
}
