# hk-bank-mcp

An MCP (Model Context Protocol) server that gives Claude — or any MCP client — live, accurate knowledge of Hong Kong retail banking: where to find an ATM or branch, current HIBOR and HKD reference rates, and (from v0.2) whether a bank or website is a legitimate HKMA-authorised institution or a published scam. Every figure comes from the Hong Kong Monetary Authority's public API with no key, no registration, and no bank credentials — ever.

```
你: 邊度有恒生分行喺沙田?
Claude: 沙田區恒生分行，頭三間：
        • 置富第一城141-143號
        • 沙田橫壆街1-15號好運中心16A、16B、16C及18號舖
        • 新港城中心3樓3221-3223舖
        沙田區總共有 5 間恒生分行。
```

## Why this exists

Ask an LLM today what HIBOR is or where the nearest Bank of China ATM is, and it either refuses or answers from stale training data. HKMA publishes this as open data — free, no key required — but nothing connects it to an AI assistant. This project is that connection, built the way a tool for an AI agent should be built rather than as a thin wrapper: tools are grouped by what a person actually asks, not by which HKMA endpoint happens to hold the answer; every response states how fresh the data is; and the upstream API's very real reliability problems (see [Data sources](#data-sources)) are handled rather than passed through.

## Install

Requires Node.js ≥ 22. No API key, no account, no configuration.

**Claude Code:**

```bash
claude mcp add hk-bank -- npx -y @wkliwk/hk-bank-mcp
```

That's it — no clone, no build, nothing else to install. `npx` fetches the package on first run and caches it.

Then just ask, in Cantonese or English: *"邊度有ATM喺中環?"* or *"3個月HIBOR而家幾多?"* (In a script or CI, non-interactive `claude -p` needs the tools named explicitly: add `--allowedTools mcp__hk-bank__hk_find_bank_location,mcp__hk-bank__hk_get_interest_rates,mcp__hk-bank__hk_server_info`.)

By default this registers the server for the current project directory only. To make it available everywhere, add `--scope user` to the command above.

**Claude Desktop:** add to your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "hk-bank": {
      "command": "npx",
      "args": ["-y", "@wkliwk/hk-bank-mcp"]
    }
  }
}
```

Restart Claude Desktop after editing.

<details>
<summary>Build from source instead</summary>

For contributing, or to run a version newer than the last npm release:

```bash
git clone https://github.com/wkliwk/hk-bank-mcp.git
cd hk-bank-mcp
pnpm install && pnpm build
claude mcp add hk-bank -- node "$(pwd)/packages/mcp-server/dist/index.js"
```

This requires pnpm (`npm i -g pnpm`) in addition to Node ≥ 22.

</details>

## Tools

| Tool | What it does |
|---|---|
| `hk_find_bank_location` | Find ATMs, bank branches and self-service banking points anywhere in Hong Kong. Accepts a district, a neighbourhood or shopping mall by name (旺角, TST, 銅鑼灣 — not just the 18 official district names), a bank in any common form (HSBC / 滙豐 / Hang Seng / 恒生 / BOC / 中銀), a currency, or a distance from a coordinate. |
| `hk_get_interest_rates` | HIBOR (overnight through 12-month) and HKD reference/prime rates. Merges two HKMA sources with a genuine trade-off — one is fresh but narrow, the other complete but ~3 weeks behind — and states which date each figure actually came from. Defaults to the latest value; give a date range for a trend summary. |
| `hk_server_info` | Reports server version and which data sources are configured, with their freshness. Mostly useful for the model to explain itself. |

Every tool call is read-only. None of them can move money, open an account, or touch anything that requires a bank login.

## Data sources

All from the [Hong Kong Monetary Authority Open API](https://apidocs.hkma.gov.hk/) — public, free, no key required.

| Source | Used for | Freshness |
|---|---|---|
| Bank & SVF Information (ATM/branch/self-service locators) | `hk_find_bank_location` | Updated as banks report to HKMA |
| Monthly Statistical Bulletin (interbank rates) | `hk_get_interest_rates` | Full HIBOR tenor curve, but lags roughly 3 weeks |
| Daily Monetary Statistics | `hk_get_interest_rates` | Next business day, but only overnight + 1-month HIBOR |

**The upstream API is intermittently unavailable.** During development it returned HTTP 502 or timed out on a meaningful fraction of calls — an [Alibaba Cloud load balancer](https://apidocs.hkma.gov.hk/) reporting a dead backend, not a rate limit or a block. This server retries with backoff, and serves a cached value (clearly labelled with its age) rather than failing outright when the upstream is down. If no cached value exists, it says so plainly instead of guessing.

## What this deliberately does not do

- **No bank credentials, ever.** Nothing in this project logs into a bank, automates a login form, or asks for a password. All data is either public HKMA open data or (from v0.4) a statement file the user exports and hands over themselves.
- **No scraping.** Every figure traces back to a documented HKMA public endpoint.
- **No transactions.** Read and compare only — no transfers, no payments, no account actions.
- **Not financial advice.** Published rates are reported with their source and date; the server never recommends a product.

See [`PRODUCT.md`](./PRODUCT.md) for the full feature list, acceptance criteria, and out-of-scope statement.

## Architecture

```
packages/
  hkma-client/   Plain TypeScript library — zero MCP dependency, zero framework.
                 HTTP client, retry/backoff, TTL cache with stale fallback,
                 district/bank name normalisation, rate merging & summarisation.
                 Usable standalone; every unit test here runs offline.

  mcp-server/    The MCP protocol layer only. Thin handlers that call into
                 hkma-client and shape the response — no business logic lives here.
```

**Why two packages.** `hkma-client` knows nothing about MCP. The reasoning behind that split is that the hard problems here — matching "MK" and "旺角" to Mong Kok, merging two rate sources with different freshness, surviving an upstream that returns HTML where JSON is expected — have nothing to do with the Model Context Protocol, and testing them shouldn't require standing up a server. Every test in `hkma-client/test` runs against fixtures with zero network calls.

**Why tools are consolidated, not mirrored.** HKMA's "Bank & SVF Information" category alone has 15 endpoints, organised by which HKMA department publishes them — a register here, a hotline list there, a scam-alert feed somewhere else. None of those 15 corresponds to a question a person actually asks. `hk_find_bank_location` covers three of them (ATM, branch, self-service) behind one `type` parameter, because "where's the nearest ATM" and "where's the nearest branch" are the same question with a different filter, not three questions. The alternative — one tool per endpoint — is how a naive integration gets built, and it means the model has to know your API's internal shape to use it at all.

**Why places and banks resolve the way they do.** Hong Kong place names have no single canonical form: the same ATM dataset spells "Sha Tin" four different ways, including a straight typo. Rather than hand-maintaining an ever-growing alias table (measured: it tops out around a quarter of real place names people use, including old names and slang), district resolution asks the calling model to map free text onto one of the 18 official district IDs — something it turns out to do close to perfectly — and this codebase's job is narrowed to the part code is actually good at: normalising HKMA's inconsistent spellings onto those same 18 IDs. Full reasoning in [`PRODUCT.md`](./PRODUCT.md#design-decisions).

## Development

```bash
pnpm install
pnpm build       # tsc --build across both packages
pnpm lint        # biome check
pnpm typecheck   # tsc --build --force
pnpm test        # vitest — fully offline, reads fixtures/hkma/*.json
pnpm verify      # all of the above, what CI runs
```

Fixtures under `fixtures/hkma/` are real HKMA API responses captured during development, including a genuine 502 error body used to test the retry path offline. No test in this repo touches the network.

To add a new HKMA endpoint, see `packages/hkma-client/src/endpoints.ts` — each entry declares its own `maxPageSize`, since the ceiling is undocumented and differs per endpoint (exceeding it returns `err_code: 9999` rather than a clear error).

Contributions welcome via the usual fork → branch → PR flow. Please run `pnpm verify` before opening a PR.

### Releasing to npm

Pushing a `v*.*.*` tag triggers [`.github/workflows/publish-npm.yml`](.github/workflows/publish-npm.yml), which runs the full verify suite, bundles the server with esbuild into a single dependency-free file (`packages/mcp-server/scripts/bundle.mjs`), and publishes with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) so the package on the registry is cryptographically tied to this repo and commit. `@hk-bank-mcp/hkma-client`'s `workspace:*` reference is stripped before publish, since npm does not understand pnpm's workspace protocol and everything it exports is already inlined into the bundle. Nothing is published by hand.

## Roadmap

| Version | Theme |
|---|---|
| **v0.1** (this release) | HKMA core — location search, interest rates |
| v0.2 | Bank legitimacy / scam checker, contact hotlines, an eval harness |
| v0.3 | Cross-bank comparison — deposit rates, credit cards, mortgages |
| v0.4 | Local statement analysis (CSV/PDF you export yourself — never uploaded) |

## License

MIT — see [`LICENSE`](./LICENSE).
