import type { PluginConfig } from "./config"
import { resolveApiKey } from "./config"
import type { DeepSeekClient } from "./deepseek"
import type { Channel, DomainEntry, Outcome, RouteMemory } from "./routing"
import { hostOf, isPrivateUrl, isRawContentUrl, planRoute } from "./routing"

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
  /** Per-domain outcome memory used by the auto strategy (optional, best-effort). */
  readonly memory?: RouteMemory | undefined
}

export const DEFAULT_WEBFETCH_DESCRIPTION =
  "Fetches content from a specified URL and returns it in the requested format. " +
  "Uses direct fetching or the DeepSeek Fetch API depending on the configured strategy, " +
  "with automatic fallback between them."

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

/** Bot-challenge markers: native fetch "succeeded" but returned a challenge page. */
const CHALLENGE_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /verify you are human/i,
  /attention required/i,
  /cf-challenge/i,
  /captcha/i,
]

/** Empty responses and short bot-challenge pages count as poor native results. */
export function isLowQualityContent(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  return trimmed.length < 2000 && CHALLENGE_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/** Native tool results carry text in `output`, plugin results in `content`. */
function resultText(result: unknown): string {
  const record = result as { content?: unknown; output?: unknown }
  if (typeof record.content === "string") return record.content
  if (typeof record.output === "string") return record.output
  return ""
}

function hasAttachments(result: unknown): boolean {
  const attachments = (result as { attachments?: unknown }).attachments
  return Array.isArray(attachments) && attachments.length > 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function label(channel: Channel): string {
  return channel === "native" ? "native webfetch" : "DeepSeek"
}

function combinedError(first: [string, unknown], second: [string, unknown]): Error {
  return new Error(
    `webfetch failed via ${first[0]}: ${messageOf(first[1])}; ` +
      `fallback via ${second[0]} also failed: ${messageOf(second[1])}`,
  )
}

/** Attach routing observability: which channel served, why, and any fallback cause. */
function annotate(
  result: WebfetchResult,
  channel: Channel,
  route: string,
  failure?: { channel: Channel; error: unknown },
): WebfetchResult {
  return {
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      provider: channel,
      route,
      ...(failure
        ? { fallback: `${label(failure.channel)}: ${messageOf(failure.error).slice(0, 160)}` }
        : {}),
    },
  }
}

export function createWebfetchExecutor(deps: WebfetchDeps) {
  const { config, client, original, assertPermission } = deps
  const env = deps.env ?? process.env

  async function executeNative(input: WebfetchInput, context: unknown): Promise<WebfetchResult> {
    if (!original) {
      throw new Error("The built-in webfetch tool is not available to handle this request.")
    }
    return original.execute(input, context)
  }

  async function executeDeepSeek(
    input: WebfetchInput,
    format: WebfetchFormat,
    context: { signal: AbortSignal },
  ): Promise<WebfetchResult> {
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

  async function record(host: string, channel: Channel, outcome: Outcome): Promise<void> {
    if (!deps.memory || !host) return
    try {
      await deps.memory.record(host, channel, outcome)
    } catch {
      // memory is best-effort and must never break fetching
    }
  }

  return async function execute(
    input: WebfetchInput,
    context: { signal: AbortSignal },
  ): Promise<WebfetchResult> {
    const format = input.format ?? "markdown"
    const hasKey = resolveApiKey(config, env) !== undefined

    // Hard routing: html and image attachments are native-only capabilities;
    // a missing key delegates to the original when it exists. Without the
    // original we fall through so the caller gets actionable errors
    // (MissingApiKeyError) instead of a dead end.
    if (format === "html") {
      if (original) return executeNative(input, context)
      throw new Error(
        'format "html" is only supported by the built-in webfetch tool, which is not registered.',
      )
    }
    if (isProbablyImageUrl(input.url) && original) return executeNative(input, context)
    if (!hasKey && original) return executeNative(input, context)

    if (!input.url.startsWith("http://") && !input.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    const host = hostOf(input.url)
    const privateUrl = isPrivateUrl(input.url)
    const rawContent = isRawContentUrl(input.url)

    // Gate 1: intranet URLs never leave the machine. Gate 2: raw byte-oriented
    // resources favor native fidelity. Everything else goes through the planner
    // (strategy + per-domain memory in auto mode).
    let entry: DomainEntry | undefined
    if (!privateUrl && !rawContent && deps.memory && host) {
      try {
        entry = await deps.memory.get(host)
      } catch {
        entry = undefined
      }
    }
    const plan = privateUrl
      ? { order: ["native"] as const, reason: "private-url" }
      : planRoute({
          strategy: rawContent ? "native-first" : config.fetchStrategy,
          hasOriginal: Boolean(original),
          hasKey,
          host,
          nativeOnlyDomains: config.nativeOnlyDomains,
          deepseekOnlyDomains: config.deepseekOnlyDomains,
          entry,
          now: Date.now(),
        })
    const route = privateUrl ? "private-url" : rawContent ? "raw-content" : plan.reason

    let failure: { channel: Channel; error: unknown } | undefined
    for (const [index, channel] of plan.order.entries()) {
      if (context.signal.aborted) throw failure?.error ?? new Error("webfetch aborted")
      const hasFallback = index + 1 < plan.order.length
      try {
        const result =
          channel === "native"
            ? await executeNative(input, context)
            : await executeDeepSeek(input, format, context)

        // A native result that is technically a success but useless (empty or a
        // bot-challenge page) counts as a quality failure when a fallback exists.
        if (
          channel === "native" &&
          hasFallback &&
          !hasAttachments(result) &&
          isLowQualityContent(resultText(result))
        ) {
          await record(host, "native", "quality-fail")
          failure = {
            channel,
            error: new Error("native fetch returned empty or bot-challenge content"),
          }
          continue
        }

        await record(host, channel, "success")
        return annotate(result, channel, route, failure)
      } catch (error) {
        const status = (error as { status?: number }).status
        await record(host, channel, status === 429 ? "rate-limited" : "error")
        if (context.signal.aborted) throw error
        if (!hasFallback) {
          throw failure
            ? combinedError([label(failure.channel), failure.error], [label(channel), error])
            : error
        }
        failure = { channel, error }
      }
    }
    throw failure?.error ?? new Error("webfetch failed")
  }
}
