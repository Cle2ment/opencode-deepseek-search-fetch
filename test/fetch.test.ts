import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveConfig } from "../src/config"
import type { DeepSeekClient, DeepSeekFetchResult } from "../src/deepseek"
import { createDeepSeekClient, MissingApiKeyError } from "../src/deepseek"
import type { WebfetchInput } from "../src/fetch"
import { createWebfetchExecutor, isProbablyImageUrl, stripMarkdown } from "../src/fetch"
import { createRouteMemory } from "../src/routing"

const config = resolveConfig({})
const signal = new AbortController().signal

const originalKey = process.env.DEEPSEEK_API_KEY
beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = "sk-test"
})
afterEach(() => {
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = originalKey
})

function mockClient(pages?: { calls: { url: string; timeoutMs?: number }[] }): DeepSeekClient {
  return {
    search: async () => [],
    fetchPage: async (url, _signal, timeoutMs): Promise<DeepSeekFetchResult> => {
      pages?.calls.push({ url, timeoutMs })
      return { title: "Example Page", content: "# Hello\n\nSome **bold** text." }
    },
  }
}

const noopPermission = async () => {}

describe("isProbablyImageUrl", () => {
  test("image extensions", () => {
    expect(isProbablyImageUrl("https://a.com/x.png")).toBe(true)
    expect(isProbablyImageUrl("https://a.com/x.JPG")).toBe(true)
    expect(isProbablyImageUrl("https://a.com/x.webp?v=2")).toBe(true)
    expect(isProbablyImageUrl("https://a.com/x.svg#icon")).toBe(true)
  })

  test("non-image urls", () => {
    expect(isProbablyImageUrl("https://a.com/docs")).toBe(false)
    expect(isProbablyImageUrl("https://a.com/x.png.html")).toBe(false)
    expect(isProbablyImageUrl("https://a.com/?file=x.png")).toBe(false)
  })
})

describe("stripMarkdown", () => {
  test("headings, emphasis, inline code", () => {
    expect(stripMarkdown("## Title\n\n**bold** and *italic* and `code`")).toBe(
      "Title\n\nbold and italic and code",
    )
  })

  test("links and images", () => {
    expect(stripMarkdown("[docs](https://a.com)")).toBe("docs (https://a.com)")
    expect(stripMarkdown("[https://a.com](https://a.com)")).toBe("https://a.com")
    expect(stripMarkdown("![alt text](https://a.com/x.png)")).toBe("alt text")
  })

  test("code fences keep code, drop fences", () => {
    expect(stripMarkdown("```ts\nconst x = 1\n```")).toBe("const x = 1")
  })

  test("blockquotes and horizontal rules", () => {
    expect(stripMarkdown("> quoted\n\n---\n\nafter")).toBe("quoted\n\nafter")
  })

  test("snake_case identifiers survive", () => {
    expect(stripMarkdown("use my_variable_name here")).toBe("use my_variable_name here")
  })
})

describe("createWebfetchExecutor", () => {
  test("markdown via DeepSeek with title heading and metadata", async () => {
    const permissionCalls: WebfetchInput[] = []
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      assertPermission: async (input) => {
        permissionCalls.push(input)
      },
    })
    const result = await execute({ url: "https://a.com" }, { signal })
    expect(result.content).toBe("# Example Page\n\n# Hello\n\nSome **bold** text.")
    expect(result.title).toBe("Example Page")
    expect(result.metadata).toEqual({
      url: "https://a.com",
      format: "markdown",
      provider: "deepseek",
      route: "no-native",
    })
    expect(permissionCalls).toHaveLength(1)
    expect(permissionCalls[0]?.url).toBe("https://a.com")
  })

  test("text format strips markdown and uses plain title", async () => {
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      assertPermission: noopPermission,
    })
    const result = await execute({ url: "https://a.com", format: "text" }, { signal })
    expect(result.content).toBe("Example Page\n\nHello\n\nSome bold text.")
  })

  test("page without title has no prefix", async () => {
    const client: DeepSeekClient = {
      search: async () => [],
      fetchPage: async () => ({ title: "", content: "body only" }),
    }
    const execute = createWebfetchExecutor({ config, client, assertPermission: noopPermission })
    const result = await execute({ url: "https://a.com" }, { signal })
    expect(result.content).toBe("body only")
    expect("title" in result).toBe(false)
  })

  test("default timeout 30s, custom clamped to 120s", async () => {
    const calls: { url: string; timeoutMs?: number }[] = []
    const execute = createWebfetchExecutor({
      config,
      client: mockClient({ calls }),
      assertPermission: noopPermission,
    })
    await execute({ url: "https://a.com" }, { signal })
    await execute({ url: "https://a.com", timeout: 500 }, { signal })
    expect(calls[0]?.timeoutMs).toBe(30_000)
    expect(calls[1]?.timeoutMs).toBe(120_000)
  })

  test("html format falls back to original without permission assert or client call", async () => {
    let originalCalled = 0
    let clientCalled = 0
    const client: DeepSeekClient = {
      search: async () => [],
      fetchPage: async () => {
        clientCalled++
        return { title: "", content: "" }
      },
    }
    const execute = createWebfetchExecutor({
      config,
      client,
      original: {
        execute: async (input) => {
          originalCalled++
          return { content: `<html>${input.url}</html>` }
        },
      },
      assertPermission: async () => {
        throw new Error("must not assert on fallback path")
      },
    })
    const result = await execute({ url: "https://a.com", format: "html" }, { signal })
    expect(result.content).toBe("<html>https://a.com</html>")
    expect(originalCalled).toBe(1)
    expect(clientCalled).toBe(0)
  })

  test("image urls fall back to original", async () => {
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      original: { execute: async () => ({ content: "native-image-handling" }) },
      assertPermission: noopPermission,
    })
    const result = await execute({ url: "https://a.com/pic.png" }, { signal })
    expect(result.content).toBe("native-image-handling")
  })

  test("missing api key falls back to original", async () => {
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      original: { execute: async () => ({ content: "native-no-key" }) },
      assertPermission: noopPermission,
      env: {},
    })
    const result = await execute({ url: "https://a.com" }, { signal })
    expect(result.content).toBe("native-no-key")
  })

  test("missing api key without original throws MissingApiKeyError", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const execute = createWebfetchExecutor({
      config,
      client: createDeepSeekClient(config),
      assertPermission: noopPermission,
      env: {},
    })
    await expect(execute({ url: "https://a.com" }, { signal })).rejects.toBeInstanceOf(
      MissingApiKeyError,
    )
  })

  test("invalid url scheme is rejected", async () => {
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      assertPermission: noopPermission,
    })
    await expect(execute({ url: "ftp://a.com" }, { signal })).rejects.toThrow("http")
  })

  test("html without original reports unsupported", async () => {
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      assertPermission: noopPermission,
    })
    await expect(execute({ url: "https://a.com", format: "html" }, { signal })).rejects.toThrow(
      "html",
    )
  })
})

describe("native-first strategy", () => {
  function nativeReturning(result: unknown) {
    return { execute: async () => result as never }
  }

  test("good native result short-circuits without DeepSeek or permission assert", async () => {
    let deepseekCalled = 0
    const client: DeepSeekClient = {
      search: async () => [],
      fetchPage: async () => {
        deepseekCalled++
        return { title: "", content: "" }
      },
    }
    const execute = createWebfetchExecutor({
      config,
      client,
      original: nativeReturning({ output: "full page content, long enough to be useful" }),
      assertPermission: async () => {
        throw new Error("must not assert on native path")
      },
    })
    const result = await execute({ url: "https://a.com" }, { signal })
    expect(resultTextOf(result)).toBe("full page content, long enough to be useful")
    expect(deepseekCalled).toBe(0)
  })

  test("native hard failure falls back to DeepSeek", async () => {
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      original: {
        execute: async () => {
          throw new Error("403 Cloudflare")
        },
      },
      assertPermission: noopPermission,
    })
    const result = await execute({ url: "https://a.com" }, { signal })
    expect(result.metadata?.provider).toBe("deepseek")
    expect(result.content).toContain("Example Page")
  })

  test("bot-challenge page falls back to DeepSeek", async () => {
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      original: nativeReturning({
        output: "Just a moment... Checking your browser before accessing the site.",
      }),
      assertPermission: noopPermission,
    })
    const result = await execute({ url: "https://a.com" }, { signal })
    expect(result.metadata?.provider).toBe("deepseek")
  })

  test("empty native content falls back to DeepSeek", async () => {
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      original: nativeReturning({ output: "   " }),
      assertPermission: noopPermission,
    })
    const result = await execute({ url: "https://a.com" }, { signal })
    expect(result.metadata?.provider).toBe("deepseek")
  })

  test("native attachments bypass the quality check", async () => {
    const nativeResult = {
      output: "Image fetched successfully",
      attachments: [{ type: "file", mime: "image/png" }],
    }
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      original: nativeReturning(nativeResult),
      assertPermission: noopPermission,
    })
    const result = await execute({ url: "https://a.com" }, { signal })
    expect(resultTextOf(result)).toBe("Image fetched successfully")
    expect((result as { attachments?: unknown }).attachments).toEqual(nativeResult.attachments)
    expect(result.metadata).toMatchObject({ provider: "native" })
  })

  test("both failures produce a combined error", async () => {
    const client: DeepSeekClient = {
      search: async () => [],
      fetchPage: async () => {
        throw new Error("deepseek 429")
      },
    }
    const execute = createWebfetchExecutor({
      config,
      client,
      original: {
        execute: async () => {
          throw new Error("native timeout")
        },
      },
      assertPermission: noopPermission,
    })
    const error = await execute({ url: "https://a.com" }, { signal }).catch((e: unknown) => e)
    expect((error as Error).message).toContain("native timeout")
    expect((error as Error).message).toContain("deepseek 429")
  })
})

describe("deepseek-first strategy", () => {
  const deepseekFirst = resolveConfig({ fetchStrategy: "deepseek-first" })

  test("DeepSeek failure falls back to native", async () => {
    const client: DeepSeekClient = {
      search: async () => [],
      fetchPage: async () => {
        throw new Error("deepseek 429")
      },
    }
    const execute = createWebfetchExecutor({
      config: deepseekFirst,
      client,
      original: { execute: async () => ({ content: "native-rescue" }) },
      assertPermission: noopPermission,
    })
    const result = await execute({ url: "https://a.com" }, { signal })
    expect(result.content).toBe("native-rescue")
  })

  test("DeepSeek success does not touch native", async () => {
    let nativeCalled = 0
    const execute = createWebfetchExecutor({
      config: deepseekFirst,
      client: mockClient(),
      original: {
        execute: async () => {
          nativeCalled++
          return { content: "native" }
        },
      },
      assertPermission: noopPermission,
    })
    const result = await execute({ url: "https://a.com" }, { signal })
    expect(result.metadata?.provider).toBe("deepseek")
    expect(nativeCalled).toBe(0)
  })
})

function resultTextOf(result: unknown): string {
  const record = result as { content?: unknown; output?: unknown }
  if (typeof record.content === "string") return record.content
  if (typeof record.output === "string") return record.output
  return ""
}

describe("auto strategy with gates and memory", () => {
  test("private urls always use native and never leak to DeepSeek", async () => {
    let deepseekCalled = 0
    const client: DeepSeekClient = {
      search: async () => [],
      fetchPage: async () => {
        deepseekCalled++
        return { title: "", content: "" }
      },
    }
    const execute = createWebfetchExecutor({
      config,
      client,
      original: { execute: async () => ({ content: "intranet page", metadata: {} }) },
      assertPermission: noopPermission,
      memory: createRouteMemory(),
    })
    const result = await execute({ url: "http://192.168.1.10/docs" }, { signal })
    expect(result.metadata).toMatchObject({ provider: "native", route: "private-url" })
    expect(deepseekCalled).toBe(0)
  })

  test("raw content urls prefer native fidelity", async () => {
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      original: { execute: async () => ({ content: '{"ok":true}', metadata: {} }) },
      assertPermission: noopPermission,
      memory: createRouteMemory(),
    })
    const result = await execute({ url: "https://a.com/data.json" }, { signal })
    expect(result.metadata).toMatchObject({ provider: "native", route: "raw-content" })
  })

  test("two native failures teach auto to go deepseek-first on the domain", async () => {
    let nativeCalls = 0
    const memory = createRouteMemory()
    const original = {
      execute: async () => {
        nativeCalls++
        throw new Error("native blocked")
      },
    }
    const execute = createWebfetchExecutor({
      config,
      client: mockClient(),
      original,
      assertPermission: noopPermission,
      memory,
    })
    const first = await execute({ url: "https://a.com/1" }, { signal })
    expect(first.metadata).toMatchObject({ provider: "deepseek", route: "auto-default" })
    expect(first.metadata?.fallback).toContain("native webfetch")
    await execute({ url: "https://a.com/2" }, { signal })
    expect(nativeCalls).toBe(2)

    const third = await execute({ url: "https://a.com/3" }, { signal })
    expect(third.metadata).toMatchObject({ provider: "deepseek", route: "domain-memory" })
    expect(nativeCalls).toBe(2) // native skipped entirely on the learned domain
  })

  test("deepseek 429 arms a cooldown that forces native", async () => {
    let deepseekCalls = 0
    const client: DeepSeekClient = {
      search: async () => [],
      fetchPage: async () => {
        deepseekCalls++
        throw Object.assign(new Error("rate limited"), { status: 429 })
      },
    }
    const memory = createRouteMemory()
    const execute = createWebfetchExecutor({
      config,
      client,
      original: {
        execute: async () => {
          throw new Error("native down")
        },
      },
      assertPermission: noopPermission,
      memory,
    })
    await expect(execute({ url: "https://a.com" }, { signal })).rejects.toThrow("rate limited")
    expect(deepseekCalls).toBe(1)

    const healthy = createWebfetchExecutor({
      config,
      client,
      original: { execute: async () => ({ content: "native ok", metadata: {} }) },
      assertPermission: noopPermission,
      memory,
    })
    const result = await healthy({ url: "https://a.com" }, { signal })
    expect(result.metadata).toMatchObject({ provider: "native", route: "deepseek-cooldown" })
    expect(deepseekCalls).toBe(1)
  })

  test("native-only domains never fall back to DeepSeek", async () => {
    let deepseekCalled = 0
    const client: DeepSeekClient = {
      search: async () => [],
      fetchPage: async () => {
        deepseekCalled++
        return { title: "", content: "" }
      },
    }
    const execute = createWebfetchExecutor({
      config: resolveConfig({ nativeOnlyDomains: ["a.com"] }),
      client,
      original: {
        execute: async () => {
          throw new Error("native down")
        },
      },
      assertPermission: noopPermission,
      memory: createRouteMemory(),
    })
    await expect(execute({ url: "https://a.com" }, { signal })).rejects.toThrow("native down")
    expect(deepseekCalled).toBe(0)
  })
})
