import type { FetchStrategy } from "./config"

export type Channel = "native" | "deepseek"
export type Outcome = "success" | "error" | "quality-fail" | "rate-limited"

export interface DomainEntry {
  /** Consecutive native failures (hard or quality); >=2 arms deepseek preference. */
  readonly nativeFailStreak?: number
  /** While in the future, this domain goes deepseek-first (learned preference). */
  readonly deepseekPreferUntil?: number
  /** While in the future, deepseek is skipped entirely (429 cooldown). */
  readonly deepseekCooldownUntil?: number
  readonly updated: number
}

export interface RoutePlan {
  readonly order: readonly Channel[]
  readonly reason: string
}

export interface RouteMemory {
  get(host: string): Promise<DomainEntry | undefined>
  record(host: string, channel: Channel, outcome: Outcome): Promise<void>
}

export const DEEPSEEK_PREFER_TTL_MS = 6 * 60 * 60 * 1000 // 6h
export const DEEPSEEK_COOLDOWN_MS = 60_000 // 60s after a 429
const MAX_ENTRIES = 500
const STORAGE_KEY = "routing/v1"

const PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".home", ".corp"]

function isPrivateIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** Intranet/loopback URLs must never leave the machine (privacy + they cannot succeed remotely). */
export function isPrivateUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  const bare = host.replace(/^\[|\]$/g, "")
  if (bare === "localhost" || bare === "::1") return true
  if (bare.endsWith(".localhost")) return true
  if (!bare.includes(".")) return true // single-label hostnames are intranet by convention
  if (PRIVATE_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return true
  if (isPrivateIPv4(bare)) return true
  if (bare.startsWith("fe80:") || bare.startsWith("fc") || bare.startsWith("fd")) return true
  return false
}

const RAW_CONTENT_PATTERN = /\.(json|xml|txt|md|csv|log|ya?ml)$/i

/** Raw byte-oriented resources: native fidelity beats DeepSeek's rendering/translation. */
export function isRawContentUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.toLowerCase() === "raw.githubusercontent.com") return true
    return RAW_CONTENT_PATTERN.test(parsed.pathname)
  } catch {
    return false
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

export function matchesDomain(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

export interface PlanInput {
  readonly strategy: FetchStrategy
  readonly hasOriginal: boolean
  readonly hasKey: boolean
  readonly host: string
  readonly nativeOnlyDomains: readonly string[]
  readonly deepseekOnlyDomains: readonly string[]
  readonly entry?: DomainEntry | undefined
  readonly now: number
}

export function planRoute(input: PlanInput): RoutePlan {
  const { strategy, hasOriginal, hasKey, host, entry, now } = input

  if (matchesDomain(host, input.nativeOnlyDomains)) {
    return { order: ["native"], reason: "native-only-domain" }
  }
  if (hasKey && matchesDomain(host, input.deepseekOnlyDomains)) {
    return {
      order: hasOriginal ? ["deepseek", "native"] : ["deepseek"],
      reason: "deepseek-only-domain",
    }
  }
  if (!hasOriginal) return { order: ["deepseek"], reason: "no-native" }
  if (!hasKey) return { order: ["native"], reason: "no-api-key" }

  if (strategy === "native-first") return { order: ["native", "deepseek"], reason: "native-first" }
  if (strategy === "deepseek-first")
    return { order: ["deepseek", "native"], reason: "deepseek-first" }

  // auto: learned preferences and cooldowns take precedence over the default order
  if (entry?.deepseekCooldownUntil !== undefined && entry.deepseekCooldownUntil > now) {
    return { order: ["native"], reason: "deepseek-cooldown" }
  }
  if (entry?.deepseekPreferUntil !== undefined && entry.deepseekPreferUntil > now) {
    return { order: ["deepseek", "native"], reason: "domain-memory" }
  }
  return { order: ["native", "deepseek"], reason: "auto-default" }
}

export interface StorageAdapter {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

/** Per-domain outcome memory, optionally persisted through OpenCode plugin storage. */
export function createRouteMemory(storage?: StorageAdapter): RouteMemory {
  let cache: Map<string, DomainEntry> | undefined

  async function load(): Promise<Map<string, DomainEntry>> {
    if (cache) return cache
    cache = new Map()
    if (storage) {
      try {
        const data = await storage.get(STORAGE_KEY)
        if (data && typeof data === "object") {
          for (const [host, entry] of Object.entries(data as Record<string, DomainEntry>)) {
            cache.set(host, entry)
          }
        }
      } catch {
        // storage unavailable: run with in-memory state only
      }
    }
    return cache
  }

  function persist(): void {
    if (!storage || !cache) return
    void storage.set(STORAGE_KEY, Object.fromEntries(cache)).catch(() => {})
  }

  return {
    async get(host) {
      const entries = await load()
      return entries.get(host)
    },

    async record(host, channel, outcome) {
      if (!host) return
      const entries = await load()
      const now = Date.now()
      const previous = entries.get(host) ?? { updated: 0 }
      let next: DomainEntry = { ...previous, updated: now }

      if (channel === "native") {
        if (outcome === "success") {
          next = { ...next, nativeFailStreak: 0, deepseekPreferUntil: undefined }
        } else {
          const streak = (next.nativeFailStreak ?? 0) + 1
          next = {
            ...next,
            nativeFailStreak: streak,
            ...(streak >= 2 ? { deepseekPreferUntil: now + DEEPSEEK_PREFER_TTL_MS } : {}),
          }
        }
      } else if (outcome === "rate-limited") {
        next = { ...next, deepseekCooldownUntil: now + DEEPSEEK_COOLDOWN_MS }
      }

      entries.set(host, next)
      // LRU-ish cap: drop the oldest entries once the map grows too large
      if (entries.size > MAX_ENTRIES) {
        const oldest = [...entries.entries()].sort((a, b) => a[1].updated - b[1].updated)
        for (const [host] of oldest.slice(0, entries.size - MAX_ENTRIES)) entries.delete(host)
      }
      persist()
    },
  }
}
