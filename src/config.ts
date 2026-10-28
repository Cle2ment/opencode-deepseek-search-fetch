export interface PluginConfig {
  /** Environment variable holding the DeepSeek API key. */
  readonly apiKeyEnv: string
  /** API base including any path prefix, without the operation name. */
  readonly baseURL: string
  /** Results requested per search (1-50). */
  readonly count: number
  /** Replace the built-in webfetch tool with the DeepSeek Fetch API. */
  readonly overrideWebfetch: boolean
  /** Select deepseek as the default websearch provider when nothing else is configured. */
  readonly setDefault: boolean
  /**
   * Routing strategy for webfetch:
   * - native-first: try the built-in fetch, fall back to DeepSeek on failure or poor content.
   * - deepseek-first: try DeepSeek, fall back to the built-in fetch on failure.
   */
  readonly fetchStrategy: FetchStrategy
}

export type FetchStrategy = "native-first" | "deepseek-first"

export const DEFAULT_BASE_URL = "https://api.deepseek.com/v1/tools"
export const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY"

function stringOption(options: Record<string, unknown>, key: string, fallback: string): string {
  const value = options[key]
  if (typeof value === "string" && value.trim() !== "") return value.trim()
  return fallback
}

function booleanOption(options: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = options[key]
  return typeof value === "boolean" ? value : fallback
}

export function resolveConfig(options: Record<string, unknown>): PluginConfig {
  const baseURL = stringOption(options, "baseURL", DEFAULT_BASE_URL).replace(/\/+$/, "")
  if (!/^https?:\/\//.test(baseURL)) {
    console.warn(`[deepseek-search-fetch] invalid baseURL "${baseURL}", using ${DEFAULT_BASE_URL}`)
  }

  const rawCount = options.count
  let count = 10
  if (typeof rawCount === "number" && Number.isInteger(rawCount)) {
    if (rawCount >= 1 && rawCount <= 50) {
      count = rawCount
    } else {
      console.warn(`[deepseek-search-fetch] count must be 1-50, got ${rawCount}; using 10`)
    }
  }

  const rawStrategy = options.fetchStrategy
  const fetchStrategy: FetchStrategy =
    rawStrategy === "deepseek-first" || rawStrategy === "native-first"
      ? rawStrategy
      : "native-first"

  return {
    apiKeyEnv: stringOption(options, "apiKeyEnv", DEFAULT_API_KEY_ENV),
    baseURL: /^https?:\/\//.test(baseURL) ? baseURL : DEFAULT_BASE_URL,
    count,
    overrideWebfetch: booleanOption(options, "overrideWebfetch", true),
    setDefault: booleanOption(options, "setDefault", true),
    fetchStrategy,
  }
}

/** Resolve the API key lazily so a key exported after startup still works. */
export function resolveApiKey(
  config: PluginConfig,
  env: Record<string, string | undefined>,
): string | undefined {
  const key = env[config.apiKeyEnv]
  return key && key.trim() !== "" ? key.trim() : undefined
}
