import type { PluginConfig } from "./config"
import { resolveApiKey } from "./config"

export interface DeepSeekSearchItem {
  readonly title?: string
  readonly url?: string
  readonly snippet?: string
  readonly summary?: string
  readonly date?: string | null
}

export interface DeepSeekFetchResult {
  readonly title: string
  readonly content: string
}

export class DeepSeekApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "DeepSeekApiError"
  }
}

export class MissingApiKeyError extends Error {
  constructor(apiKeyEnv: string) {
    super(
      `DeepSeek API key is not configured. Set the ${apiKeyEnv} environment variable ` +
        `to your DeepSeek API key (https://platform.deepseek.com/api_keys) and restart OpenCode.`,
    )
    this.name = "MissingApiKeyError"
  }
}

export interface DeepSeekClient {
  search(query: string, signal: AbortSignal): Promise<readonly DeepSeekSearchItem[]>
  fetchPage(url: string, signal: AbortSignal, timeoutMs?: number): Promise<DeepSeekFetchResult>
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BODY_EXCERPT = 500

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function errorFromResponse(
  operation: string,
  response: Response,
  apiKeyEnv: string,
): Promise<DeepSeekApiError> {
  const status = response.status
  if (status === 401 || status === 403) {
    return new DeepSeekApiError(
      `DeepSeek ${operation} API authentication failed (HTTP ${status}). ` +
        `Check that ${apiKeyEnv} contains a valid DeepSeek API key.`,
      status,
    )
  }
  if (status === 429) {
    return new DeepSeekApiError(
      `DeepSeek ${operation} API rate limit exceeded (HTTP 429). ` +
        `Limits are per account (Search 100 QPS, Fetch 25 QPS); wait and retry.`,
      status,
    )
  }
  const body = await response.text().catch(() => "")
  const excerpt = body.slice(0, MAX_BODY_EXCERPT)
  return new DeepSeekApiError(
    `DeepSeek ${operation} API request failed (HTTP ${status})${excerpt ? `: ${excerpt}` : ""}`,
    status,
  )
}

export function createDeepSeekClient(config: PluginConfig): DeepSeekClient {
  async function post<T>(
    operation: "Search" | "Fetch",
    path: string,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    parse: (data: unknown) => T,
  ): Promise<T> {
    const apiKey = resolveApiKey(config, process.env)
    if (!apiKey) throw new MissingApiKeyError(config.apiKeyEnv)

    const endpoint = `${config.baseURL}${path}`
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: withTimeout(signal, timeoutMs),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new DeepSeekApiError(
        `DeepSeek ${operation} API request to ${endpoint} failed: ${message}. ` +
          `Check network connectivity and the baseURL plugin option (current: ${config.baseURL}).`,
      )
    }

    if (!response.ok) throw await errorFromResponse(operation, response, config.apiKeyEnv)

    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw new DeepSeekApiError(
        `DeepSeek ${operation} API returned a malformed (non-JSON) response.`,
      )
    }
    return parse(data)
  }

  return {
    async search(query, signal) {
      return post(
        "Search",
        "/search",
        { query, count: config.count, need_content: false },
        signal,
        DEFAULT_TIMEOUT_MS,
        (data) => {
          const results = (data as { results?: unknown }).results
          if (!Array.isArray(results)) {
            throw new DeepSeekApiError("DeepSeek Search API response is missing the results array.")
          }
          return results as readonly DeepSeekSearchItem[]
        },
      )
    },

    async fetchPage(url, signal) {
      return post("Fetch", "/fetch", { url }, signal, DEFAULT_TIMEOUT_MS, (data) => {
        const result = data as { title?: unknown; content?: unknown }
        if (typeof result.content !== "string") {
          throw new DeepSeekApiError("DeepSeek Fetch API response is missing the page content.")
        }
        return {
          title: typeof result.title === "string" ? result.title : "",
          content: result.content,
        }
      })
    },
  }
}
