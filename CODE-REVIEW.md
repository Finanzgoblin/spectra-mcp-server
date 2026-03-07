# MetaVault MCP Server — Full Codebase Review

**Date:** 2026-02-27
**Scope:** All source files, tools, tests, and configuration
**Reviewer:** Claude (automated deep review)

---

## Executive Summary

This is a well-architected, well-documented MetaVault MCP server with 37 tools across 10 blockchain networks. The codebase demonstrates strong domain knowledge and thoughtful agentic design (competing interpretations, observation coverage, cross-tool references). The test suite is multi-layered and meaningfully rigorous.

That said, the review surfaced **6 likely bugs**, **2 security concerns**, **8 code quality issues**, and **several test coverage gaps**. The most impactful are the hardcoded 18-decimal assumption in onchain.ts (wrong values for USDC), floating-point precision loss in BigInt conversions, and the response body double-consumption bug in api.ts.

---

## Bugs (Likely to Produce Incorrect Output)

### ~~1. Hardcoded 18 decimals for all on-chain token amounts~~ (FIXED 2026-02-28)
~~**File:** `src/tools/onchain.ts:642`~~
~~All token amounts are formatted assuming 18 decimals.~~
- Fixed: Added `token_decimals` parameter (default 18) so agents can pass correct decimals from `spectra_get_pt_details`. Dynamic note in output warns when using default 18 decimals.

### ~~2. Floating-point precision loss in BigInt conversion~~ (FIXED 2026-02-28)
~~**Files:** `src/tools/quote.ts:41`, `src/tools/simulate.ts:112`~~
~~`BigInt(Math.round(amount * 10 ** inputDecimals))` overflows for 18-decimal tokens.~~
- Fixed: Added `amountToBigInt()` in `api.ts` using string arithmetic. Verified: old method was off by ~16.8 trillion wei for 1M tokens at 18 decimals.

### ~~3. Response body double-consumption in fetch error paths~~ (FIXED 2026-02-28)
~~**File:** `src/api.ts:82-84`, `src/api.ts:673-678`~~
~~`res.json()` consumed the stream, making `res.text()` in catch always return empty.~~
- Fixed: Both `fetchSpectra()` and `fetchPendle()` now read body as text first, then `JSON.parse()`.

### ~~4. Pool context fetch uses wrong address variable~~ (FIXED 2026-02-28)
~~**File:** `src/tools/pool.ts:462`~~
~~Used `pool_address` instead of `effectivePoolAddr` after PT→pool resolution.~~
- Fixed: Now uses `effectivePoolAddr` for the PT context fetch.

### 5. Next-step hints pass pool address as PT address
**File:** `src/tools/pool.ts:168-169`

```ts
spectra_quote_trade(chain="${chain}", pt_address="${pool_address}", ...)
spectra_get_pt_details(chain="${chain}", pt_address="${pool_address}")
```

If the user passed a pool address, these hints give the agent an incorrect `pt_address`.

**Impact:** Low-medium — agent follows bad hints and gets errors on the next tool call.

### 6. No from_block < to_block validation
**File:** `src/tools/onchain.ts:363-374`

Both accept `min(0)` but there's no check that `from_block < to_block`. A reversed range produces negative block counts that could cause RPC errors or silent empty results.

**Impact:** Low — only triggers on invalid user input.

---

## Security Concerns

### 1. SSRF via user-supplied RPC URLs
**File:** `src/config.ts:257`

```ts
export function resolveRpcUrl(chain: string, overrideRpcUrl?: string): string | null {
  if (overrideRpcUrl) return overrideRpcUrl;
```

Agent-provided URLs are used directly in `fetch()` calls. A malicious agent could point to internal network addresses. For a locally-running MCP server this is low risk, but for any networked deployment it's an SSRF vector.

**Recommendation:** Validate URLs (HTTPS only, no private IP ranges) if the server will ever run in a shared environment.

### 2. GraphQL injection surface (mitigated but fragile)
**Files:** `src/api.ts:161-163`, `src/tools/morpho.ts:84-98`

The `sanitizeGraphQL` function strips dangerous characters but doesn't handle backticks, dollar signs, or unicode escapes. The current inputs (EVM addresses) make exploitation unlikely, but any new string parameter added to GraphQL queries without sanitization would be vulnerable.

**Recommendation:** Migrate to parameterized GraphQL variables (`variables: { ... }` in POST body).

---

## Code Quality Issues

### 1. Pervasive `as any` casts on API responses
**All tool files** — Every `fetchSpectra()` call is cast to `any`, defeating TypeScript's type system. If the API response shape changes, errors won't be caught at compile time.

### 2. Duplicated BigInt-to-float conversion
The same BigInt → float pattern appears in 4+ places: `formatBalance`, `parseWei`, `formatMorphoLltv`, `fetchVeTotalSupply`. Should be a single shared utility.

### ~~3. Duplicated on-chain quoting logic~~ (FIXED 2026-02-28)
~~`quote.ts` has `tryOnChainQuote` but `simulate.ts` duplicates the same logic inline (lines 103-124) instead of importing it.~~
- Fixed: `tryOnChainQuote` exported from `quote.ts`, imported in `simulate.ts`. Also inherits the `amountToBigInt` fix.

### 4. Unbounded address type cache
**File:** `src/api.ts:820-821` — `_addressTypeCache` has no TTL and no size limit. Every unique address queried is cached permanently.

### ~~5. Inconsistent `isError` flag usage across tools~~ (FIXED 2026-02-28)
~~Some tools return `isError: true` on "not found" conditions, others return successful responses with error text.~~
- Fixed: All resource-not-found returns now use `isError: true` consistently across `pt.ts`, `quote.ts`, `simulate.ts`, `morpho.ts`, and `looping.ts`. Empty scan results (valid responses) remain without `isError`.

### 6. `spectra_list_pools` sort description says "descending" but maturity sorts ascending
**File:** `src/tools/pt.ts:113,159` — Tool description says "Sort results by this metric (descending)" but maturity sort is ascending (nearest first).

### 7. Hardcoded server version
**File:** `src/index.ts:63` — `version: "1.0.0"` is hardcoded instead of reading from `package.json`.

### 8. ~~Stale CLAUDE.md documentation~~ (FIXED 2026-02-28)
- ~~References `src/tools/trade.ts` which doesn't exist (split into `quote.ts` and `simulate.ts`)~~
- ~~References `src/tools/yield.ts` which doesn't exist (`spectra_compare_yield` is in `pt.ts`, `spectra_scan_opportunities` in `strategy.ts`, `spectra_scan_yt_arbitrage` in `yt_arb.ts`)~~
- Fixed in emergence audit: CLAUDE.md now maps all 15 tool files correctly, including `context.ts`, `ve.ts`, `strategy.ts`, `yt_arb.ts`, `looping.ts`, `quote.ts`, `simulate.ts`

---

## Performance Concerns

### 1. N+1 API query pattern in `spectra_get_address_activity`
**File:** `src/tools/pool.ts:798-844` — For each discovered pool, activity is fetched individually. A wallet active across 50 pools on 10 chains generates 500+ sequential API calls with no timeout budget.

### 2. Sequential chunk fetching in `fetchLogs`
**File:** `src/api.ts:988-1026` — Large block ranges are fetched one chunk at a time. A small concurrency factor (2-3 parallel chunks) would improve throughput without hitting rate limits.

### 3. Fetches all metavaults to find one
**Files:** `src/tools/metavault.ts:458` — Both `spectra_get_curator_dashboard` and `spectra_model_metavault` fetch ALL metavaults on the chain, then filter client-side. Mitigated by the 30s cache.

### 4. No rate limiting for multi-chain scans
**Files:** `portfolio.ts`, `pool.ts` — Parallel requests across all 10 chains with no rate limiting. Each chain request triggers multiple sub-requests (pools + portfolio + Merkl + Morpho).

---

## Test Coverage Analysis

### Strengths
- **Multi-layer test approach:** Unit (165) + Integration (371) + Agent reasoning (88) + Subjective (35 questions)
- **Dynamic test data discovery:** Tests discover pool addresses at runtime instead of hardcoding expirable data
- **Meaningful assertions:** Tests verify specific behavioral properties, not just non-emptiness
- **AGENT-TESTS.md is genuinely innovative** — includes trap questions and narrative-collapse detection

### Coverage Gaps

| Gap | Severity |
|-----|----------|
| `pendle_list_markets` has zero functional testing anywhere | Medium |
| `mv_get_protocol_context` has no integration test in main suite | Low |
| ~30 formatting/rendering functions in `formatters.ts` have no unit tests | Low-Medium |
| `resolveRpcUrl` in config.ts is untested | Low |
| No mock layer — all integration tests require live network | Medium |
| `--offline` mode only tests schema registration, zero logic | Medium |

### ~~Test Count Discrepancy~~ (FIXED 2026-02-28)
~~CLAUDE.md claims "371 integration tests" and "88 agent reasoning assertions" but actual `assert()` counts are ~331 and ~55 respectively. The difference comes from counting `pass()`/`skip()` calls as assertions.~~
- CLAUDE.md updated to 388 integration tests and 48 agent reasoning assertions (matching actual counts)

---

## Positive Observations

This isn't just a bug report — the codebase has notable strengths worth calling out:

1. **Agentic design is excellent.** Competing interpretations, observation coverage metrics, cross-tool references, and "hidden mechanic" callouts are genuinely thoughtful design patterns that most MCP servers lack.

2. **Zero external runtime dependencies** (only `@modelcontextprotocol/sdk` and `zod`). The entire server is self-contained with no supply chain risk beyond the essentials.

3. **Domain knowledge is deep and accurate.** The Router-mediated transaction documentation, YT flash-mint/redeem mechanics, and expired pool handling show genuine protocol understanding.

4. **Error handling is generally robust.** Most tools have try/catch with meaningful error messages. The `fetchWithRetry` pattern with exponential backoff is well-implemented.

5. **The formatting layer is comprehensive.** 3500+ lines of output formatting that teaches protocol mechanics to agents, not just dumps data.

---

## Recommended Priority

| Priority | Items | Status |
|----------|-------|--------|
| **P0 — Fix now** | #1 (18-decimal bug), #4 (wrong address variable) | ✅ Fixed 2026-02-28 |
| **P1 — Fix soon** | #2 (BigInt precision), #3 (double body consumption), #5 (isError consistency) | ✅ Fixed 2026-02-28 |
| **P2 — Improve** | Security concerns, ~~duplicated code~~, test coverage gaps | Partially done (dedup fixed) |
| **P3 — Nice to have** | Performance optimizations, `as any` cleanup, documentation fixes | Open |
