/**
 * dsh-dream-reflection: the scheduled dream-reflection plugin for DeepSeek
 * Harness. A function plugin with named exports only (`name` / `inject` /
 * `Config` / `apply`) — the Loader drops namespaces that also default-export.
 *
 * @module dsh-dream-reflection
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import type { Config as PluginConfig } from './config.ts'
import { Config as PluginConfigSchema } from './config.ts'
import { DreamReflectionService } from './service.ts'

export const name = 'dream-reflection'

/** The engine needs every capability it contributes through. */
export const inject = ['timer', 'agents', 'sessionQuery', 'llm', 'commands', 'systemPrompt', 'dreamReflectionStore']

export type Config = PluginConfig
export const Config = PluginConfigSchema

/**
 * Instantiate the engine. Cross-field configuration is validated here and
 * misconfiguration throws at plugin load; the engine registers its own
 * commands, listeners, and dynamic context as reversible Cordis effects.
 * @param ctx - the loading context.
 * @param config - schema-defaulted plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  new DreamReflectionService(ctx, resolved)
}
