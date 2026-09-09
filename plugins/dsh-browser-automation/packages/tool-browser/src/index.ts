/**
 * `@dsh-browser-automation/dsh-tool-browser`: registers the ten model-facing
 * browser tools. A function/namespace plugin (no default export). Nine tools
 * register with `browsers`+`tools`; `browser_screenshot` registers through a
 * nested inject of `attachments`+`llm` so a profile without those seams still
 * gets the other nine (and screenshot simply never appears).
 * @module @dsh-browser-automation/dsh-tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TOOL_SPECS } from './manifest.js'
import type { AttachmentView, LlmView, ToolEnv } from './manifest.js'

export { TOOL_NAMES, TOOL_SPECS, approvalOf, rejectUnknownKeys } from './manifest.js'
export type { ApprovalKind, AttachmentView, LlmView, ToolEnv, ToolIdentity, ToolSpec } from './manifest.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-browser'

/** The capability seams this consumer registers into. */
export const inject = ['browsers', 'tools']

/** Plugin config: whether the screenshot tool is registered at all. */
export interface Config {
  /** Register `browser_screenshot` when the profile composes attachments+llm. */
  screenshot?: boolean
}

export const Config: z<Config> = z.object({
  screenshot: z.boolean().default(true),
})

/** Register the manifest's tool set with the tools registry. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as { screenshot: boolean }
  const baseEnv: ToolEnv = {
    tool: { name: '', timeoutMs: 0 },
    browsers: ctx.browsers,
    llm: undefined,
    attachments: undefined,
  }

  for (const spec of TOOL_SPECS) {
    // Screenshot has its own registration scope below (llm gate + attachments).
    if (spec.name === 'browser_screenshot') continue
    const definition = defineTool({
      name: spec.name,
      description: spec.description,
      timeoutMs: spec.timeoutMs,
      parameters: spec.parameters,
      output: {
        schema: spec.outputSchema,
        render: spec.render,
      },
      execute: (args, exec) => spec.execute(args as Record<string, unknown>, exec, {
        ...baseEnv,
        tool: { name: spec.name, timeoutMs: spec.timeoutMs },
      }) as never,
    })
    ctx.effect(() => ctx.tools.register(definition))
  }

  if (resolved.screenshot) {
    // Screenshot additionally needs the llm gate and the attachment store.
    ctx.inject(['attachments', 'llm'], (scope) => {
      const env: ToolEnv = {
        ...baseEnv,
        tool: { name: 'browser_screenshot', timeoutMs: 60_000 },
        browsers: scope.browsers,
        llm: scope.llm as unknown as LlmView,
        attachments: (scope as unknown as { attachments: unknown }).attachments as AttachmentView,
      }
      // The manifest always declares browser_screenshot.
      const spec = TOOL_SPECS.find(candidate => candidate.name === 'browser_screenshot')!
      const definition = defineTool({
        name: spec.name,
        description: spec.description,
        timeoutMs: spec.timeoutMs,
        parameters: spec.parameters,
        output: {
          schema: spec.outputSchema,
          render: spec.render,
        },
        execute: (args, exec) => spec.execute(args as Record<string, unknown>, exec, env) as never,
      })
      scope.effect(() => scope.tools.register(definition))
    })
  }
}
