import { Plugin } from "@opencode/plugin"
import { resolveApiKey, resolveConfig } from "./config"
import { createDeepSeekClient } from "./deepseek"
import {
  createWebfetchExecutor,
  DEFAULT_WEBFETCH_DESCRIPTION,
  DEFAULT_WEBFETCH_INPUT_SCHEMA,
  type OriginalWebfetch,
} from "./fetch"
import { createSearchProvider } from "./search"

interface ToolExecuteContext {
  readonly sessionID: string
  readonly agent?: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

export default Plugin.define({
  id: "deepseek-search-fetch",
  async setup(ctx) {
    const config = resolveConfig(ctx.options as Record<string, unknown>)
    const client = createDeepSeekClient(config)

    if (!resolveApiKey(config, process.env)) {
      console.warn(
        `[deepseek-search-fetch] ${config.apiKeyEnv} is not set. ` +
          `The deepseek websearch provider is registered but searches will fail until it is configured; ` +
          `webfetch keeps using the built-in implementation.`,
      )
    }

    await ctx.websearch.transform((editor) => {
      editor.add(createSearchProvider(client))
      // Only auto-select when the user has not chosen a provider and searches
      // can actually succeed; never override an explicit configuration.
      if (
        config.setDefault &&
        editor.default.get() === undefined &&
        resolveApiKey(config, process.env)
      ) {
        editor.default.set("deepseek")
      }
    })

    if (!config.overrideWebfetch) return

    await ctx.tool.transform((editor) => {
      const original = editor.get("webfetch")
      const execute = createWebfetchExecutor({
        config,
        client,
        original: original ? (original as unknown as OriginalWebfetch) : undefined,
        assertPermission: async (input, rawContext) => {
          const context = rawContext as ToolExecuteContext
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "webfetch",
            resources: [input.url],
            save: ["*"],
            metadata: {
              url: input.url,
              format: input.format ?? "markdown",
              timeout: input.timeout,
            },
          })
        },
      })

      editor.add({
        name: "webfetch",
        description: original?.description ?? DEFAULT_WEBFETCH_DESCRIPTION,
        input: (original?.input ?? DEFAULT_WEBFETCH_INPUT_SCHEMA) as never,
        ...(original?.options ? { options: original.options } : {}),
        execute: execute as never,
      })
    })
  },
})
