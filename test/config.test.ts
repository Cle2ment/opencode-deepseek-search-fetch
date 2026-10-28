import { describe, expect, test } from "bun:test"
import { DEFAULT_BASE_URL, resolveApiKey, resolveConfig } from "../src/config"

describe("resolveConfig", () => {
  test("defaults", () => {
    const config = resolveConfig({})
    expect(config).toEqual({
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseURL: DEFAULT_BASE_URL,
      count: 10,
      overrideWebfetch: true,
      setDefault: true,
      fetchStrategy: "native-first",
    })
  })

  test("custom options", () => {
    const config = resolveConfig({
      apiKeyEnv: "MY_KEY",
      baseURL: "https://proxy.example.com/api/v1/tools/",
      count: 25,
      overrideWebfetch: false,
      setDefault: false,
    })
    expect(config.apiKeyEnv).toBe("MY_KEY")
    expect(config.baseURL).toBe("https://proxy.example.com/api/v1/tools")
    expect(config.count).toBe(25)
    expect(config.overrideWebfetch).toBe(false)
    expect(config.setDefault).toBe(false)
  })

  test("invalid baseURL falls back to default", () => {
    expect(resolveConfig({ baseURL: "not-a-url" }).baseURL).toBe(DEFAULT_BASE_URL)
    expect(resolveConfig({ baseURL: "" }).baseURL).toBe(DEFAULT_BASE_URL)
  })

  test("count boundaries", () => {
    expect(resolveConfig({ count: 1 }).count).toBe(1)
    expect(resolveConfig({ count: 50 }).count).toBe(50)
    expect(resolveConfig({ count: 0 }).count).toBe(10)
    expect(resolveConfig({ count: 51 }).count).toBe(10)
    expect(resolveConfig({ count: 2.5 }).count).toBe(10)
    expect(resolveConfig({ count: "20" }).count).toBe(10)
  })

  test("non-boolean flags use defaults", () => {
    const config = resolveConfig({ overrideWebfetch: "yes", setDefault: 1 })
    expect(config.overrideWebfetch).toBe(true)
    expect(config.setDefault).toBe(true)
  })

  test("fetchStrategy accepts known values and rejects others", () => {
    expect(resolveConfig({}).fetchStrategy).toBe("native-first")
    expect(resolveConfig({ fetchStrategy: "deepseek-first" }).fetchStrategy).toBe("deepseek-first")
    expect(resolveConfig({ fetchStrategy: "native-first" }).fetchStrategy).toBe("native-first")
    expect(resolveConfig({ fetchStrategy: "auto" }).fetchStrategy).toBe("native-first")
    expect(resolveConfig({ fetchStrategy: 42 }).fetchStrategy).toBe("native-first")
  })
})

describe("resolveApiKey", () => {
  const config = resolveConfig({})

  test("returns trimmed key", () => {
    expect(resolveApiKey(config, { DEEPSEEK_API_KEY: " sk-abc " })).toBe("sk-abc")
  })

  test("missing or blank key is undefined", () => {
    expect(resolveApiKey(config, {})).toBeUndefined()
    expect(resolveApiKey(config, { DEEPSEEK_API_KEY: "" })).toBeUndefined()
    expect(resolveApiKey(config, { DEEPSEEK_API_KEY: "   " })).toBeUndefined()
  })

  test("honors apiKeyEnv", () => {
    const custom = resolveConfig({ apiKeyEnv: "OTHER" })
    expect(resolveApiKey(custom, { OTHER: "sk-x" })).toBe("sk-x")
    expect(resolveApiKey(custom, { DEEPSEEK_API_KEY: "sk-y" })).toBeUndefined()
  })
})
