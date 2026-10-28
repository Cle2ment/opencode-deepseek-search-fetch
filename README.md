# deepseek-search-fetch

Use the [DeepSeek Search & Fetch APIs](https://api-docs.deepseek.com/guides/search) in
[OpenCode](https://opencode.ai) V2, wired the same way as OpenCode's built-in web tooling:

- **Search** registers a native `deepseek` websearch provider (alongside Exa, Tavily, …), so the
  built-in websearch tool, provider selection, and permissions keep working unchanged.
- **Fetch** overrides the built-in `webfetch` tool to retrieve pages as markdown through DeepSeek,
  with **smart fallback** to the original implementation whenever DeepSeek cannot serve a request.

No extra tools for the model to learn, no configuration required beyond your API key.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["deepseek-search-fetch@latest"]
}
```

Set your [DeepSeek API key](https://platform.deepseek.com/api_keys) before starting OpenCode:

```sh
export DEEPSEEK_API_KEY=sk-...
```

That is it. Searches go through DeepSeek and `webfetch` returns DeepSeek-rendered markdown.

If you prefer to select the provider explicitly (or combine it with other providers):

```jsonc
{
  "websearch": { "provider": "deepseek" }
}
```

## Options

Pass options with the object form in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "deepseek-search-fetch@latest",
      "options": {
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "baseURL": "https://api.deepseek.com/v1/tools",
        "count": 10,
        "overrideWebfetch": true,
        "setDefault": true
      }
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `apiKeyEnv` | `"DEEPSEEK_API_KEY"` | Environment variable holding the API key. A literal key option is deliberately not offered so keys never end up in config files. |
| `baseURL` | `"https://api.deepseek.com/v1/tools"` | API base including any path prefix, without `/search` or `/fetch`. Useful for proxies or self-hosted deployments. |
| `count` | `10` | Results requested per search (1–50). |
| `overrideWebfetch` | `true` | Replace the built-in `webfetch` tool with the DeepSeek Fetch API. |
| `setDefault` | `true` | Select `deepseek` as the default websearch provider **only when** no provider is configured and an API key is present. Never overrides an explicit choice. |

## How webfetch fallback works

The override keeps the native input schema (`url`, `format`, `timeout`) and the `webfetch`
permission flow. Requests are routed as follows:

| Request | Served by |
| --- | --- |
| `format: "markdown"` (default) | DeepSeek Fetch API (page title prepended as a heading) |
| `format: "text"` | DeepSeek Fetch API, markdown stripped to plain text |
| `format: "html"` | Built-in webfetch (DeepSeek only returns markdown) |
| Image URLs (`.png`, `.jpg`, …) | Built-in webfetch (native image attachment handling) |
| No API key configured | Built-in webfetch — the native tool never breaks |

Errors mirror DeepSeek's semantics: `401/403` produce credential guidance, `429` is surfaced as a
rate limit (Search 100 QPS / Fetch 25 QPS per account), and Fetch API failures are reported as
retrieval failures, not target-page statuses. The plugin does not retry on its own.

## Billing note

DeepSeek bills Search and Fetch per successful call (empty results and failures are free). See the
[official guide](https://api-docs.deepseek.com/guides/search) for current pricing and rate limits.

## Development

```sh
bun install
bun run check   # typecheck + lint + unit tests
```

The package ships TypeScript source directly; OpenCode loads it with Bun, so there is no build step.

## Release

1. Bump `version` in `package.json` and commit.
2. Tag the release: `git tag v1.0.1 && git push origin main --tags`.
3. The release workflow verifies the tag matches the package version, runs all checks, and
   publishes to npm with provenance.

Repository secrets: `NPM_TOKEN` (npm automation token). Optional: set the repository variable
`DEEPSEEK_SMOKE_TEST=true` and secret `DEEPSEEK_API_KEY` to run a real-API smoke test after publish.

## License

MIT
