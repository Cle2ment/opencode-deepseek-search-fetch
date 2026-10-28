import type { DeepSeekClient, DeepSeekSearchItem } from "./deepseek"

/** Shape of a result accepted by OpenCode's websearch provider registry. */
export interface WebSearchResult {
  readonly url: string
  readonly title?: string
  readonly content?: string
  readonly time: { published?: number }
}

export interface WebSearchProviderDefinition {
  readonly id: string
  readonly name: string
  readonly execute: (
    input: { query: string },
    context: { signal: AbortSignal },
  ) => Promise<readonly WebSearchResult[]>
}

export function mapSearchItem(item: DeepSeekSearchItem): WebSearchResult | undefined {
  if (typeof item.url !== "string" || item.url === "") return undefined

  // DeepSeek returns a model-friendly `summary` and a display-oriented `snippet`;
  // OpenCode has a single content field, so prefer the summary.
  const content = item.summary?.trim() ? item.summary : item.snippet
  const published = typeof item.date === "string" ? Date.parse(item.date) : Number.NaN

  return {
    url: item.url,
    ...(typeof item.title === "string" && item.title !== "" ? { title: item.title } : {}),
    ...(typeof content === "string" && content !== "" ? { content } : {}),
    time: Number.isFinite(published) ? { published } : {},
  }
}

export function mapSearchResults(items: readonly DeepSeekSearchItem[]): WebSearchResult[] {
  return items.map(mapSearchItem).filter((item): item is WebSearchResult => item !== undefined)
}

export function createSearchProvider(client: DeepSeekClient): WebSearchProviderDefinition {
  return {
    id: "deepseek",
    name: "DeepSeek",
    execute: async ({ query }, { signal }) => {
      const items = await client.search(query, signal)
      return mapSearchResults(items)
    },
  }
}
