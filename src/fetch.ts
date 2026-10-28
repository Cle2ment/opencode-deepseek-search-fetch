import type { PluginConfig } from "./config"
import { resolveApiKey } from "./config"
import type { DeepSeekClient } from "./deepseek"

export type WebfetchFormat = "text" | "markdown" | "html"

export interface WebfetchInput {
  readonly url: string
  readonly format?: WebfetchFormat
  readonly timeout?: number
}

export interface WebfetchResult {
  readonly content: string
  readonly title?: string
  readonly metadata?: Record<string, unknown>
}

/** Minimal shape of the built-in webfetch tool we delegate fallback calls to. */
export interface OriginalWebfetch {
  execute: (input: WebfetchInput, context: unknown) => Promise<WebfetchResult>
}

export interface WebfetchDeps {
  readonly config: PluginConfig
  readonly client: DeepSeekClient
  /** Built-in webfetch executor captured before overriding, if present. */
  readonly original?: OriginalWebfetch | undefined
  /** Asserts the webfetch permission for DeepSeek-served requests (original handles its own). */
  readonly assertPermission: (input: WebfetchInput, context: unknown) => Promise<void>
  readonly env?: Record<string, string | undefined>
}

export const DEFAULT_WEBFETCH_DESCRIPTION =
  "Fetches content from a specified URL and returns it in the requested format. " +
  "Uses the DeepSeek Fetch API for markdown and text, with automatic fallback to direct fetching."

export const DEFAULT_WEBFETCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch content from" },
    format: {
      type: "string",
      enum: ["text", "markdown", "html"],
      description:
        "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    },
    timeout: { type: "number", description: "Optional timeout in seconds (max 120)" },
  },
  required: ["url"],
  additionalProperties: false,
} as const

const IMAGE_URL_PATTERN = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i

export function isProbablyImageUrl(url: string): boolean {
  try {
    return IMAGE_URL_PATTERN.test(new URL(url).pathname)
  } catch {
    return IMAGE_URL_PATTERN.test(url.split(/[?#]/)[0] ?? "")
  }
}

/** Convert DeepSeek's markdown into approximate plain text for format:"text". */
export function stripMarkdown(markdown: string): string {
  return (
    markdown
      // fenced code blocks: drop the fence lines, keep the code
      .replace(/^```[^\n]*$/gm, "")
      // images keep their alt text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // links keep text plus target
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_match, text: string, url: string) =>
        text === url || text === "" ? url : `${text} (${url})`,
      )
      // headings, blockquotes
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      // horizontal rules
      .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "")
      // emphasis and inline code
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1")
      // collapse excessive blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  )
}

const MAX_TIMEOUT_MS = 120_000
const DEFAULT_TIMEOUT_S = 30

export function createWebfetchExecutor(deps: WebfetchDeps) {
  const { config, client, original, assertPermission } = deps
  const env = deps.env ?? process.env

  return async function execute(
    input: WebfetchInput,
    context: { signal: AbortSignal },
  ): Promise<WebfetchResult> {
    const format = input.format ?? "markdown"
    const hasKey = resolveApiKey(config, env) !== undefined

    // Smart fallback: anything DeepSeek cannot serve goes back to the built-in
    // implementation so overriding never breaks the native tool.
    const canUseDeepSeek = hasKey && format !== "html" && !isProbablyImageUrl(input.url)
    if (!canUseDeepSeek && original) {
      return original.execute(input, context)
    }

    if (!input.url.startsWith("http://") && !input.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    if (format === "html") {
      throw new Error(
        'The DeepSeek Fetch API only returns markdown; format "html" is unavailable because ' +
          "the built-in webfetch tool is not registered to fall back to.",
      )
    }

    await assertPermission(input, context)

    const timeoutMs = Math.min(
      Math.max(input.timeout ?? DEFAULT_TIMEOUT_S, 1) * 1000,
      MAX_TIMEOUT_MS,
    )
    const page = await client.fetchPage(input.url, context.signal, timeoutMs)

    const body = format === "text" ? stripMarkdown(page.content) : page.content
    const content = page.title
      ? format === "text"
        ? `${page.title}\n\n${body}`
        : `# ${page.title}\n\n${body}`
      : body

    return {
      content,
      ...(page.title ? { title: page.title } : {}),
      metadata: { url: input.url, format, provider: "deepseek" },
    }
  }
}
