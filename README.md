# opencode-deepseek-search-fetch

Use the [DeepSeek Search & Fetch APIs](https://api-docs.deepseek.com/guides/search) in
[OpenCode](https://opencode.ai) V2, wired the same way as OpenCode's built-in web tooling:

- **Search** registers a native `deepseek` websearch provider (alongside Exa, Tavily, …), so the
  built-in websearch tool, provider selection, and permissions keep working unchanged.
- **Fetch** overrides the built-in `webfetch` tool to retrieve pages as markdown through DeepSeek,
  with **smart fallback** to the original implementation whenever DeepSeek cannot serve a request.

No extra tools for the model to learn, no configuration required beyond your API key.

The npm package is named `opencode-deepseek-search-fetch`; the plugin id shown in OpenCode's
plugin menu is `deepseek-search-fetch`.

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["opencode-deepseek-search-fetch@latest"]
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
      "package": "opencode-deepseek-search-fetch@latest",
      "options": {
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "baseURL": "https://api.deepseek.com/v1/tools",
        "count": 10,
        "overrideWebfetch": true,
        "fetchStrategy": "native-first",
        "setDefault": true
      }
    }
  ]
}
```

| Option             | Default                               | Description                                                                                                                                                       |
| ------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKeyEnv`        | `"DEEPSEEK_API_KEY"`                  | Environment variable holding the API key. A literal key option is deliberately not offered so keys never end up in config files.                                  |
| `baseURL`          | `"https://api.deepseek.com/v1/tools"` | API base including any path prefix, without `/search` or `/fetch`. Useful for proxies or self-hosted deployments.                                                 |
| `count`            | `10`                                  | Results requested per search (1–50).                                                                                                                              |
| `overrideWebfetch` | `true`                                | Replace the built-in `webfetch` tool with strategy-based routing.                                                                                                 |
| `fetchStrategy`    | `"native-first"`                      | `"native-first"`: direct fetch first, DeepSeek rescues failures and bot-challenge/empty pages. `"deepseek-first"`: DeepSeek first, native fetch rescues failures. |
| `setDefault`       | `true`                                | Select `deepseek` as the default websearch provider **only when** no provider is configured and an API key is present. Never overrides an explicit choice.        |

## How webfetch routing works

The override keeps the native input schema (`url`, `format`, `timeout`) and the `webfetch`
permission flow. Two hard rules always apply: `format: "html"` and image URLs use the built-in
implementation (DeepSeek only returns markdown), and without an API key everything uses the
built-in implementation — the native tool never breaks.

For markdown/text requests the configured strategy decides:

**`native-first` (default)** — free direct fetching wins; DeepSeek is only called (and billed)
when it is actually needed:

1. Try the built-in fetch. A good result is returned as-is, without any DeepSeek call.
2. On hard failures (403, timeouts, network errors) **or poor content** (empty body, short
   bot-challenge pages such as "Just a moment…" / "Checking your browser…"), fall back to the
   DeepSeek Fetch API.
3. If both fail, the error reports both causes.

**`deepseek-first`** — the previous behavior, plus a safety net:

1. Try the DeepSeek Fetch API (page title prepended as a heading; `text` strips markdown).
2. On DeepSeek errors (429, 5xx, network), fall back to the built-in fetch.
3. If both fail, the error reports both causes.

In both strategies, an aborted session stops immediately instead of trying the fallback.

Errors mirror DeepSeek's semantics: `401/403` produce credential guidance, `429` is surfaced as a
rate limit (Search 100 QPS / Fetch 25 QPS per account), and Fetch API failures are reported as
retrieval failures, not target-page statuses. The plugin never retries the same API request on its
own; the only fallback is the strategy-based switch between native fetch and DeepSeek.

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

Releases use [npm trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) from
GitHub Actions — no long-lived npm tokens, provenance generated automatically.

**One-time setup:**

1. Publish the first version locally so the package exists (trusted publishers are configured on
   an existing package): `npm login` (with 2FA), then `npm publish --access public`.
2. On npmjs.com, open the package **Settings → Trusted Publisher**, choose **GitHub Actions**, and set:
   - Organization or user: `Cle2ment`
   - Repository: `opencode-deepseek-search-fetch`
   - Workflow filename: `release.yml`
   - Allowed actions: **check `npm publish`** so tagged releases go live automatically without
     manual approval (leave it unchecked instead if you prefer 2FA-approved staged publishing).
3. Complete the first OIDC publish **within 2 days** of creating the configuration, or it expires.

**Cutting a release (fully automatic):**

1. Bump `version` in `package.json` and commit.
2. Tag the release: `git tag v1.0.1 && git push origin master --tags`.
3. The release workflow verifies the tag matches the package version, runs all checks, and
   publishes to npm. No approval step. (Provenance attestation is temporarily disabled due to a
   sigstore transparency-log error; see the note in `release.yml`.)

Optional hardening: after the first trusted publish succeeds, set the package's
**Settings → Publishing access → "Require two-factor authentication and disallow tokens"** so only
the trusted workflow (or an interactive 2FA session) can publish.

Optional smoke test: set the repository variable `DEEPSEEK_SMOKE_TEST=true` and secret
`DEEPSEEK_API_KEY` to run a real-API smoke test after each publish.

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). Modified versions offered
as a network service must also make their source available.
