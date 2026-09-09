/**
 * The approved-card dynamic-context provider. Synchronous by contract:
 * every prompt assembly evaluates it, so it only does bounded, cached
 * canonicalization plus one SQLite read — never I/O beyond the store.
 *
 * Only `approved` cards render; challenged, quarantined, rejected, and
 * blocked material never enters model context.
 *
 * @module dsh-dream-reflection/context
 */

import type { DreamReflectionService } from './service.ts'

export const CONTEXT_NAME = 'dream-reflection-approved'
/** Render before tool guidance (100–199) so cards inform tool use. */
export const CONTEXT_ORDER = 80

/**
 * Register the global dynamic-context provider on the engine's context.
 * @param engine - the owning engine.
 * @returns the exact Cordis effect disposer.
 */
export function registerApprovedContext(engine: DreamReflectionService): () => void {
  return engine.ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: context => engine.renderApprovedContext(context.agent),
  })
}
