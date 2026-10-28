import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveConfig } from "../src/config"
import { createDeepSeekClient, DeepSeekApiError, MissingApiKeyError } from "../src/deepseek"

const originalFetch = globalThis.fetch
const originalKey = process.env.DEEPSEEK_API_KEY

type FetchCall = { url: string; init: RequestInit }
let calls: FetchCall[]

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const request = init ?? {}
    calls.push({ url, init: request })
    return handler(url, request)
  }) as typeof fetch
}

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = "sk-test"
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = originalKey
})

const config = resolveConfig({})
const client = createDeepSeekClient(config)
const signal = new AbortController().signal

describe("search", () => {
  test("sends authenticated request with expected payload", async () => {
    stubFetch(() => Response.json({ results: [] }))
    const results = await client.search("opencode plugins", signal)

    expect(results).toEqual([])
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe("https://api.deepseek.com/v1/tools/search")
    expect(call.init.method).toBe("POST")
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer sk-test")
    expect(JSON.parse(call.init.body as string)).toEqual({
      query: "opencode plugins",
      count: 10,
      need_content: false,
    })
  })

  test("missing key throws MissingApiKeyError without any request", async () => {
    delete process.env.DEEPSEEK_API_KEY
    stubFetch(() => Response.json({ results: [] }))
    await expect(client.search("q", signal)).rejects.toBeInstanceOf(MissingApiKeyError)
    expect(calls).toHaveLength(0)
  })

  test("401 maps to credential guidance", async () => {
    stubFetch(() => new Response("unauthorized", { status: 401 }))
    const error = await client.search("q", signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeepSeekApiError)
    expect((error as DeepSeekApiError).status).toBe(401)
    expect((error as Error).message).toContain("DEEPSEEK_API_KEY")
  })

  test("429 maps to rate limit error", async () => {
    stubFetch(() => new Response("slow down", { status: 429 }))
    const error = await client.search("q", signal).catch((e: unknown) => e)
    expect((error as DeepSeekApiError).status).toBe(429)
    expect((error as Error).message).toContain("rate limit")
  })

  test("500 includes body excerpt", async () => {
    stubFetch(() => new Response("upstream exploded", { status: 500 }))
    const error = await client.search("q", signal).catch((e: unknown) => e)
    expect((error as DeepSeekApiError).status).toBe(500)
    expect((error as Error).message).toContain("upstream exploded")
  })

  test("network failure mentions endpoint and baseURL", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed")
    })
    const error = await client.search("q", signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeepSeekApiError)
    expect((error as Error).message).toContain("api.deepseek.com")
    expect((error as Error).message).toContain("baseURL")
  })

  test("malformed JSON is reported", async () => {
    stubFetch(() => new Response("not json", { status: 200 }))
    await expect(client.search("q", signal)).rejects.toThrow("malformed")
  })

  test("missing results array is reported", async () => {
    stubFetch(() => Response.json({ unexpected: true }))
    await expect(client.search("q", signal)).rejects.toThrow("results")
  })
})

describe("fetchPage", () => {
  test("returns title and markdown content", async () => {
    stubFetch((url, init) => {
      expect(url).toBe("https://api.deepseek.com/v1/tools/fetch")
      expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com/docs" })
      return Response.json({ title: "Example", content: "# Hello" })
    })
    const page = await client.fetchPage("https://example.com/docs", signal)
    expect(page).toEqual({ title: "Example", content: "# Hello" })
  })

  test("missing title defaults to empty string", async () => {
    stubFetch(() => Response.json({ content: "body" }))
    const page = await client.fetchPage("https://example.com", signal)
    expect(page.title).toBe("")
  })

  test("missing content is reported", async () => {
    stubFetch(() => Response.json({ title: "x" }))
    await expect(client.fetchPage("https://example.com", signal)).rejects.toThrow("content")
  })
})

describe("cancellation", () => {
  test("aborted signal propagates", async () => {
    const controller = new AbortController()
    stubFetch((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        )
        controller.abort()
      })
    })
    await expect(client.search("q", controller.signal)).rejects.toThrow()
  })
})
