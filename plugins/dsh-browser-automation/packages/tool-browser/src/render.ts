/**
 * Pure render functions for the browser tools: the same canonical value maps
 * to text or image content blocks without adding facts the value does not
 * carry. Never emits secrets, paths, or undisclosed URLs.
 * @module @dsh-browser-automation/dsh-tool-browser/render
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Observation } from '@dsh-browser-automation/dsh-browser'

interface SnapshotValue extends Observation {}

function asObservation(value: unknown): SnapshotValue | undefined {
  return typeof value === 'object' && value !== null ? value as SnapshotValue : undefined
}

/** Render the session-start canonical value as a single text line. */
export function renderStart(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = value as { readonly sessionId?: string; readonly backendType?: string }
  return [{ type: 'text', text: `Started browser session (backend: ${v.backendType ?? 'unknown'})` }]
}

/** Render the navigation canonical value as a single text line. */
export function renderNavigate(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = value as { readonly displayUrl?: string }
  return [{ type: 'text', text: `Navigated to ${v.displayUrl ?? 'the target'}` }]
}

/** Render one snapshot as untrusted web content with a bounded element list. */
const SNAPSHOT_UNAVAILABLE: ContentBlock[] = [{ type: 'text', text: 'Browser snapshot unavailable.' }]

export function renderSnapshot(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const snapshot = asObservation(value)
  if (snapshot === undefined) return SNAPSHOT_UNAVAILABLE
  const originLabel = snapshot.origin ?? 'about:blank'
  const lines = [
    `Untrusted web content from ${originLabel} — "${snapshot.title}"`,
    `Observation ${snapshot.observationId} (generation ${snapshot.generation})`,
  ]
  for (const element of snapshot.elements) {
    const label = element.accessibleName || element.text || ''
    lines.push(`[${element.ref}] ${element.role}${label === '' ? '' : ` "${label}"`}`)
  }
  if (snapshot.truncated) lines.push(`Truncated: ${snapshot.nodeCount}+ nodes beyond the budget.`)
  if (snapshot.elements.length === 0) lines.push('No interactive elements.')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Render a screenshot canonical value as the durable image block. */
export function renderScreenshot(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = value as {
    readonly attachmentId: string
    readonly mediaType: string
    readonly width: number
    readonly height: number
    readonly bytes: number
  }
  return [{
    type: 'image',
    attachment: {
      attachmentId: v.attachmentId as never,
      mediaType: v.mediaType as never,
      width: v.width,
      height: v.height,
      bytes: v.bytes,
    },
  }]
}

/** Render a mutation result as a single text line. */
export function renderAction(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = value as { readonly generation?: number; readonly changed?: boolean }
  const actionText = v.changed === true ? 'completed' : 'finished without document changes'
  const generationLabel = v.generation ?? '?'
  return [{ type: 'text', text: `Browser action ${actionText} (generation ${generationLabel})` }]
}

/** Render the wait result as a single text line. */
export function renderWait(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = value as { readonly waitedMs?: number }
  const waited = v.waitedMs ?? 0
  return [{ type: 'text', text: 'Waited ' + waited + 'ms' }]
}

/** Render the close result as a single text line. */
export function renderClose(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = value as { readonly closed?: boolean }
  return [{ type: 'text', text: v.closed === true ? 'Browser session closed.' : 'No live browser session.' }]
}
