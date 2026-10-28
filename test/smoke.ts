/**
 * Real-API smoke test: one Search and one Fetch call against DeepSeek.
 * Runs in the release workflow only when DEEPSEEK_API_KEY is configured.
 * Each successful call is billed by DeepSeek (fractions of a cent).
 */
import { resolveConfig } from "../src/config"
import { createDeepSeekClient } from "../src/deepseek"

const client = createDeepSeekClient(resolveConfig({}))
const signal = AbortSignal.timeout(60_000)

const results = await client.search("OpenCode AI coding agent", signal)
if (results.length === 0) throw new Error("Smoke test failed: search returned no results")
console.log(`search ok: ${results.length} results, first: ${results[0]?.url}`)

const page = await client.fetchPage("https://example.com", signal)
if (!page.content.includes("Example Domain")) {
  throw new Error("Smoke test failed: fetch did not return the expected page content")
}
console.log(`fetch ok: "${page.title}" (${page.content.length} chars)`)
