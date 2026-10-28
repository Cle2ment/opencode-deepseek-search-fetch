import { describe, expect, test } from "bun:test"
import type { PlanInput } from "../src/routing"
import {
  createRouteMemory,
  DEEPSEEK_COOLDOWN_MS,
  DEEPSEEK_PREFER_TTL_MS,
  hostOf,
  isPrivateUrl,
  isRawContentUrl,
  matchesDomain,
  planRoute,
} from "../src/routing"

describe("isPrivateUrl", () => {
  test("loopback and intranet hosts", () => {
    expect(isPrivateUrl("http://localhost:3000/docs")).toBe(true)
    expect(isPrivateUrl("http://foo.localhost/")).toBe(true)
    expect(isPrivateUrl("http://127.0.0.1/")).toBe(true)
    expect(isPrivateUrl("http://[::1]/")).toBe(true)
    expect(isPrivateUrl("http://10.0.0.5/")).toBe(true)
    expect(isPrivateUrl("http://172.16.3.4/")).toBe(true)
    expect(isPrivateUrl("http://172.31.255.255/")).toBe(true)
    expect(isPrivateUrl("http://192.168.1.10/")).toBe(true)
    expect(isPrivateUrl("http://169.254.1.1/")).toBe(true)
    expect(isPrivateUrl("http://intranet/")).toBe(true)
    expect(isPrivateUrl("http://printer.local/")).toBe(true)
    expect(isPrivateUrl("http://git.internal/")).toBe(true)
  })

  test("public hosts are not private", () => {
    expect(isPrivateUrl("https://example.com/")).toBe(false)
    expect(isPrivateUrl("https://172.32.0.1/")).toBe(false)
    expect(isPrivateUrl("https://8.8.8.8/")).toBe(false)
    expect(isPrivateUrl("https://docs.localhost.com/")).toBe(false)
    expect(isPrivateUrl("https://myinternal.com/")).toBe(false)
  })
})

describe("isRawContentUrl", () => {
  test("raw file extensions and raw hosts", () => {
    expect(isRawContentUrl("https://api.example.com/data.json")).toBe(true)
    expect(isRawContentUrl("https://example.com/feed.xml")).toBe(true)
    expect(isRawContentUrl("https://example.com/notes.md")).toBe(true)
    expect(isRawContentUrl("https://example.com/config.yaml")).toBe(true)
    expect(isRawContentUrl("https://raw.githubusercontent.com/a/b/main/README.md")).toBe(true)
  })

  test("normal pages are not raw content", () => {
    expect(isRawContentUrl("https://example.com/docs")).toBe(false)
    expect(isRawContentUrl("https://example.com/data.json.html")).toBe(false)
    expect(isRawContentUrl("https://github.com/a/b/blob/main/README.md")).toBe(true) // .md suffix wins
    expect(isRawContentUrl("https://example.com/?file=data.json")).toBe(false)
  })
})

describe("hostOf / matchesDomain", () => {
  test("host extraction", () => {
    expect(hostOf("https://Docs.Example.COM/path")).toBe("docs.example.com")
    expect(hostOf("not a url")).toBe("")
  })

  test("exact and parent-domain matching", () => {
    expect(matchesDomain("example.com", ["example.com"])).toBe(true)
    expect(matchesDomain("docs.example.com", ["example.com"])).toBe(true)
    expect(matchesDomain("badexample.com", ["example.com"])).toBe(false)
    expect(matchesDomain("example.com", ["other.com"])).toBe(false)
  })
})

const basePlan: PlanInput = {
  strategy: "auto",
  hasOriginal: true,
  hasKey: true,
  host: "example.com",
  nativeOnlyDomains: [],
  deepseekOnlyDomains: [],
  now: 1_000_000,
}

describe("planRoute", () => {
  test("auto default is native-first with fallback", () => {
    expect(planRoute(basePlan)).toEqual({ order: ["native", "deepseek"], reason: "auto-default" })
  })

  test("explicit strategies ignore memory", () => {
    const entry = { deepseekPreferUntil: basePlan.now + 1000, updated: 0 }
    expect(planRoute({ ...basePlan, strategy: "native-first", entry }).order).toEqual([
      "native",
      "deepseek",
    ])
    expect(planRoute({ ...basePlan, strategy: "deepseek-first", entry }).order).toEqual([
      "deepseek",
      "native",
    ])
  })

  test("domain lists force channels", () => {
    expect(planRoute({ ...basePlan, nativeOnlyDomains: ["example.com"] })).toEqual({
      order: ["native"],
      reason: "native-only-domain",
    })
    expect(planRoute({ ...basePlan, deepseekOnlyDomains: ["example.com"] })).toEqual({
      order: ["deepseek", "native"],
      reason: "deepseek-only-domain",
    })
  })

  test("missing key or missing original short-circuits", () => {
    expect(planRoute({ ...basePlan, hasKey: false }).reason).toBe("no-api-key")
    expect(planRoute({ ...basePlan, hasOriginal: false })).toEqual({
      order: ["deepseek"],
      reason: "no-native",
    })
  })

  test("learned deepseek preference applies within ttl", () => {
    const entry = { deepseekPreferUntil: basePlan.now + 1000, updated: 0 }
    expect(planRoute({ ...basePlan, entry })).toEqual({
      order: ["deepseek", "native"],
      reason: "domain-memory",
    })
    const expired = { deepseekPreferUntil: basePlan.now - 1, updated: 0 }
    expect(planRoute({ ...basePlan, entry: expired }).reason).toBe("auto-default")
  })

  test("deepseek cooldown forces native only", () => {
    const entry = { deepseekCooldownUntil: basePlan.now + 1000, updated: 0 }
    expect(planRoute({ ...basePlan, entry })).toEqual({
      order: ["native"],
      reason: "deepseek-cooldown",
    })
  })
})

describe("createRouteMemory", () => {
  test("two native failures arm deepseek preference; native success resets", async () => {
    const memory = createRouteMemory()
    await memory.record("example.com", "native", "error")
    let entry = await memory.get("example.com")
    expect(entry?.nativeFailStreak).toBe(1)
    expect(entry?.deepseekPreferUntil).toBeUndefined()

    await memory.record("example.com", "native", "quality-fail")
    entry = await memory.get("example.com")
    expect(entry?.nativeFailStreak).toBe(2)
    expect(entry?.deepseekPreferUntil).toBeGreaterThan(Date.now())

    await memory.record("example.com", "native", "success")
    entry = await memory.get("example.com")
    expect(entry?.nativeFailStreak).toBe(0)
    expect(entry?.deepseekPreferUntil).toBeUndefined()
  })

  test("rate limit arms cooldown", async () => {
    const memory = createRouteMemory()
    await memory.record("example.com", "deepseek", "rate-limited")
    const entry = await memory.get("example.com")
    expect(entry?.deepseekCooldownUntil).toBeGreaterThan(Date.now())
    expect((entry?.deepseekCooldownUntil ?? 0) - Date.now()).toBeLessThanOrEqual(
      DEEPSEEK_COOLDOWN_MS,
    )
  })

  test("persists through the storage adapter", async () => {
    const data = new Map<string, unknown>()
    const storage = {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: unknown) => {
        data.set(key, value)
      },
    }
    const first = createRouteMemory(storage)
    await first.record("example.com", "native", "error")
    await first.record("example.com", "native", "error")
    await new Promise((resolve) => setTimeout(resolve, 0)) // let fire-and-forget persist land

    const second = createRouteMemory(storage)
    const entry = await second.get("example.com")
    expect(entry?.nativeFailStreak).toBe(2)
    expect(entry?.deepseekPreferUntil).toBeGreaterThan(Date.now())
    expect((entry?.deepseekPreferUntil ?? 0) - Date.now()).toBeLessThanOrEqual(
      DEEPSEEK_PREFER_TTL_MS,
    )
  })
})
