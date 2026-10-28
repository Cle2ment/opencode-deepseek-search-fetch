import { describe, expect, test } from "bun:test"
import type { DeepSeekClient } from "../src/deepseek"
import { createSearchProvider, mapSearchItem, mapSearchResults } from "../src/search"

describe("mapSearchItem", () => {
  test("full item", () => {
    const result = mapSearchItem({
      title: "DeepSeek V4 released",
      url: "https://example.com/v4",
      snippet: "short display text",
      summary: "longer model-facing summary",
      date: "2026-06-01T00:00:00+00:00",
    })
    expect(result).toEqual({
      url: "https://example.com/v4",
      title: "DeepSeek V4 released",
      content: "longer model-facing summary",
      time: { published: Date.parse("2026-06-01T00:00:00+00:00") },
    })
  })

  test("falls back to snippet when summary is empty or blank", () => {
    expect(mapSearchItem({ url: "https://a.com", snippet: "snip", summary: "" })?.content).toBe(
      "snip",
    )
    expect(mapSearchItem({ url: "https://a.com", snippet: "snip", summary: "  " })?.content).toBe(
      "snip",
    )
  })

  test("invalid or null date yields empty time", () => {
    expect(mapSearchItem({ url: "https://a.com", date: "not-a-date" })?.time).toEqual({})
    expect(mapSearchItem({ url: "https://a.com", date: null })?.time).toEqual({})
    expect(mapSearchItem({ url: "https://a.com" })?.time).toEqual({})
  })

  test("missing url drops the item", () => {
    expect(mapSearchItem({ title: "no url" })).toBeUndefined()
    expect(mapSearchItem({ url: "" })).toBeUndefined()
  })

  test("optional fields omitted when absent", () => {
    const result = mapSearchItem({ url: "https://a.com" })
    expect(result).toEqual({ url: "https://a.com", time: {} })
    expect("title" in (result ?? {})).toBe(false)
    expect("content" in (result ?? {})).toBe(false)
  })
})

describe("mapSearchResults", () => {
  test("empty array is a successful empty result", () => {
    expect(mapSearchResults([])).toEqual([])
  })

  test("items without url are filtered out", () => {
    const results = mapSearchResults([
      { url: "https://a.com", title: "a" },
      { title: "dropped" },
      { url: "https://b.com", title: "b" },
    ])
    expect(results.map((r) => r.url)).toEqual(["https://a.com", "https://b.com"])
  })
})

describe("createSearchProvider", () => {
  test("provider identity and execute wiring", async () => {
    let seenQuery = ""
    const client: DeepSeekClient = {
      search: async (query) => {
        seenQuery = query
        return [{ url: "https://a.com", summary: "s" }]
      },
      fetchPage: async () => ({ title: "", content: "" }),
    }
    const provider = createSearchProvider(client)
    expect(provider.id).toBe("deepseek")
    expect(provider.name).toBe("DeepSeek")

    const results = await provider.execute(
      { query: "hello" },
      { signal: new AbortController().signal },
    )
    expect(seenQuery).toBe("hello")
    expect(results).toEqual([{ url: "https://a.com", content: "s", time: {} }])
  })

  test("empty upstream results pass through", async () => {
    const client: DeepSeekClient = {
      search: async () => [],
      fetchPage: async () => ({ title: "", content: "" }),
    }
    const provider = createSearchProvider(client)
    const results = await provider.execute({ query: "q" }, { signal: new AbortController().signal })
    expect(results).toEqual([])
  })
})
