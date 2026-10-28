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
        "setDefault": true
      }
    }
  ]
}
```

| Option             | Default                               | Description                                                                                                                                                |
| ------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKeyEnv`        | `"DEEPSEEK_API_KEY"`                  | Environment variable holding the API key. A literal key option is deliberately not offered so keys never end up in config files.                           |
| `baseURL`          | `"https://api.deepseek.com/v1/tools"` | API base including any path prefix, without `/search` or `/fetch`. Useful for proxies or self-hosted deployments.                                          |
| `count`            | `10`                                  | Results requested per search (1–50).                                                                                                                       |
| `overrideWebfetch` | `true`                                | Replace the built-in `webfetch` tool with the DeepSeek Fetch API.                                                                                          |
| `setDefault`       | `true`                                | Select `deepseek` as the default websearch provider **only when** no provider is configured and an API key is present. Never overrides an explicit choice. |

## How webfetch fallback works

The override keeps the native input schema (`url`, `format`, `timeout`) and the `webfetch`
permission flow. Requests are routed as follows:

| Request                        | Served by                                              |
| ------------------------------ | ------------------------------------------------------ |
| `format: "markdown"` (default) | DeepSeek Fetch API (page title prepended as a heading) |
| `format: "text"`               | DeepSeek Fetch API, markdown stripped to plain text    |
| `format: "html"`               | Built-in webfetch (DeepSeek only returns markdown)     |
| Image URLs (`.png`, `.jpg`, …) | Built-in webfetch (native image attachment handling)   |
| No API key configured          | Built-in webfetch — the native tool never breaks       |

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
