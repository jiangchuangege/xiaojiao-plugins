import { describe, expect, it } from 'vitest'
import { containsSensitiveMaterial, redactText, tokenEntropy } from '../src/safety/redact.ts'
import { checkVerbatimOverlap } from '../src/safety/output.ts'

describe('redaction rules', () => {
  it('replaces known secret formats irreversibly', () => {
    const result = redactText('key sk-abcdefghijklmnopqrstuvwxyz123456 end')
    expect(result.text).toContain('<REDACTED:openai-key>')
    expect(result.text).not.toContain('sk-abc')
    expect(result.dropped).toBe(false)
  })

  it('replaces credential assignments and JWT material', () => {
    const result = redactText('password = hunter2secret99 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
    expect(result.text).toContain('<REDACTED:secret-assignment>')
    expect(result.text).toContain('<REDACTED:jwt>')
  })

  it('replaces emails, CN phone numbers, and CN id numbers', () => {
    const result = redactText('mail me@example.com or call 13800138000, id 11010519491231002X')
    expect(result.text).toContain('<REDACTED:email>')
    expect(result.text).toContain('<REDACTED:phone>')
    expect(result.text).toContain('<REDACTED:cn-id>')
  })

  it('replaces private and credential-bearing URLs', () => {
    const result = redactText('see http://10.0.0.5:8080/admin and https://user:pass@example.com/x')
    expect(result.text).toContain('<REDACTED:private-url>')
    expect(result.text).toContain('<REDACTED:credential-url>')
  })

  it('drops whole events that carry private key blocks', () => {
    const result = redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----')
    expect(result.dropped).toBe(true)
    expect(result.ruleId).toBe('private-key')
  })

  it('drops events that are mostly redacted', () => {
    const dense = 'token sk-abcdefghijklmnopqrstuvwxyz123456 AKIAABCDEFGHIJKLMNOP xoxb-abcdefghijklmnop Kf8x2Qw9ZrLmNp4Vt6YsBc1Dh3Gj5Tk7Xq0Wv8Rn2'
    const result = redactText(dense)
    expect(result.dropped).toBe(true)
    expect(result.ruleId).toBe('mostly-secret')
  })

  it('flags high-entropy tokens but leaves ordinary long words alone', () => {
    const ordinary = 'a'.repeat(40)
    const randomish = 'Kf8x2Qw9ZrLmNp4Vt6YsBc1Dh3Gj5Tk7Xq0Wv8Rn2'
    expect(redactText(ordinary).text).toBe(ordinary)
    expect(redactText(randomish).text).toContain('<REDACTED:high-entropy>')
    expect(tokenEntropy('aaaa')).toBe(0)
    expect(tokenEntropy('ab')).toBe(1)
  })

  it('scans model output with the same rules', () => {
    expect(containsSensitiveMaterial('clean summary text').blocked).toBe(false)
    expect(containsSensitiveMaterial('key is sk-abcdefghijklmnopqrstuvwxyz123456').blocked).toBe(true)
  })
})

describe('verbatim overlap gate', () => {
  it('blocks long literal copies of one evidence text', () => {
    const source = 'the build fails because the lockfile drift changed every resolution across the whole workspace'
    const copy = `memorized: ${source}`
    const result = checkVerbatimOverlap(copy, [source])
    expect(result.blocked).toBe(true)
    expect(result.overlap).toBeGreaterThan(0.8)
  })

  it('allows an independent summary', () => {
    const source = 'the build fails because the lockfile drift changed every resolution across the whole workspace'
    const result = checkVerbatimOverlap('lockfile changes break builds in this workspace', [source])
    expect(result.blocked).toBe(false)
  })
})
