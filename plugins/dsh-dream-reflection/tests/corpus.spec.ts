import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildCorpus, hashText, lastCompletedTurnSeq, normalizeEventText } from '../src/corpus/build.ts'
import { FakeSessionQuery, assistantEvent, pluginInjectedEvent, sessionHeader, toolCallEvent, turnEndEvent, turnStartEvent, userEvent } from './helpers.ts'

const contexts: Context[] = []
afterEach(() => {
  for (const ctx of contexts.splice(0)) void ctx.fiber.dispose()
})

const passthrough = { text: '', dropped: false, ruleId: 'none' }
const redact = (text: string) => ({ ...passthrough, text })

describe('corpus builder', () => {
  it('includes only real user/assistant text up to the last completed turn', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const query = new FakeSessionQuery(ctx)
    query.set('s1', sessionHeader('s1', '/ws'), [
      turnStartEvent(0, 0),
      userEvent(1, 'user words'),
      pluginInjectedEvent(2, 'injected context must never enter'),
      toolCallEvent(3),
      assistantEvent(4, 'assistant words'),
      turnEndEvent(5, 0),
      // The next turn is open: its events must not be consumed.
      turnStartEvent(6, 1),
      userEvent(7, 'half turn'),
    ])
    const result = await buildCorpus(
      [{ sessionId: 's1', header: sessionHeader('s1', '/ws') }],
      { sessionQuery: query, redact, maxSessions: 6, maxEvents: 96, maxEventBytes: 6144, maxInputBytes: 98304, cursors: new Map() },
    )
    expect(result.units.map(unit => unit.text)).toEqual(['user words', 'assistant words'])
    expect(result.units.map(unit => unit.eventType)).toEqual(['user/message', 'assistant/message'])
    expect(result.checkedThrough).toEqual([{ sessionId: 's1', seq: 4, texts: ['user words', 'assistant words'] }])
    expect(result.sessionErrors).toHaveLength(0)
  })

  it('skips fork seed history and starts after the stored cursor', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const query = new FakeSessionQuery(ctx)
    query.set('s1', sessionHeader('s1', '/ws', { seedLength: 2 }), [
      turnStartEvent(0, 0),
      userEvent(1, 'parent history'),
      userEvent(2, 'own content'),
      assistantEvent(3, 'own reply'),
      turnEndEvent(4, 0),
    ])
    const result = await buildCorpus(
      [{ sessionId: 's1', header: sessionHeader('s1', '/ws', { seedLength: 2 }) }],
      { sessionQuery: query, redact, maxSessions: 6, maxEvents: 96, maxEventBytes: 6144, maxInputBytes: 98304, cursors: new Map([['s1', 2]]) },
    )
    expect(result.units.map(unit => unit.seq)).toEqual([3])
  })

  it('isolates a corrupt session without blocking other workspaces', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const query = new FakeSessionQuery(ctx)
    query.readFailures.add('broken')
    query.set('broken', sessionHeader('broken', '/ws'), [turnStartEvent(0, 0), userEvent(1, 'x'), turnEndEvent(2, 0)])
    query.set('good', sessionHeader('good', '/ws'), [turnStartEvent(0, 0), userEvent(1, 'good content'), turnEndEvent(2, 0)])
    const result = await buildCorpus(
      [{ sessionId: 'broken', header: sessionHeader('broken', '/ws') }, { sessionId: 'good', header: sessionHeader('good', '/ws') }],
      { sessionQuery: query, redact, maxSessions: 6, maxEvents: 96, maxEventBytes: 6144, maxInputBytes: 98304, cursors: new Map() },
    )
    expect(result.sessionErrors.map(error => error.sessionId)).toEqual(['broken'])
    expect(result.units.map(unit => unit.text)).toEqual(['good content'])
  })

  it('bounds events and total bytes, and stops the pressure probe early', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const query = new FakeSessionQuery(ctx)
    const events = [turnStartEvent(0, 0)]
    for (let index = 1; index <= 20; index += 1) events.push(userEvent(index, `event number ${index} with some text`))
    events.push(turnEndEvent(21, 0))
    query.set('s1', sessionHeader('s1', '/ws'), events)
    const bounded = await buildCorpus(
      [{ sessionId: 's1', header: sessionHeader('s1', '/ws') }],
      { sessionQuery: query, redact, maxSessions: 6, maxEvents: 5, maxEventBytes: 6144, maxInputBytes: 98304, cursors: new Map() },
    )
    expect(bounded.units).toHaveLength(5)
    expect(bounded.checkedThrough[0]?.seq).toBe(5)

    const probe = await buildCorpus(
      [{ sessionId: 's1', header: sessionHeader('s1', '/ws') }],
      { sessionQuery: query, redact, maxSessions: 6, maxEvents: 96, maxEventBytes: 6144, maxInputBytes: 98304, cursors: new Map(), stopAtBytes: 30 },
    )
    expect(probe.totalBytes).toBeGreaterThanOrEqual(30)
    expect(probe.totalBytes).toBeLessThan(90)
  })

  it('drops over-long events and records the rule, never the body', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const query = new FakeSessionQuery(ctx)
    query.set('s1', sessionHeader('s1', '/ws'), [
      turnStartEvent(0, 0),
      userEvent(1, 'x'.repeat(10_000)),
      userEvent(2, 'small enough'),
      turnEndEvent(3, 0),
    ])
    const result = await buildCorpus(
      [{ sessionId: 's1', header: sessionHeader('s1', '/ws') }],
      { sessionQuery: query, redact, maxSessions: 6, maxEvents: 96, maxEventBytes: 6144, maxInputBytes: 98304, cursors: new Map() },
    )
    expect(result.units.map(unit => unit.seq)).toEqual([2])
    expect(result.dropped).toEqual([{ ruleId: 'event-too-long', count: 1, hashes: [hashText('x'.repeat(10_000))] }])
  })

  it('normalizes line endings and control characters', () => {
    expect(normalizeEventText('  a\r\nb\tc\u0007  ')).toBe('a\nb\tc')
    expect(lastCompletedTurnSeq([turnStartEvent(0, 0), turnEndEvent(1, 0)], 0)).toBe(1)
    expect(lastCompletedTurnSeq([turnStartEvent(0, 0)], 0)).toBeNull()
  })
})
