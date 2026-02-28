# Spectra MCP Server — Full Codebase Review

**Date:** 2026-02-27
**Scope:** All source files, tools, tests, and configuration
**Reviewer:** Claude (automated deep review)

---

## Executive Summary

This is a well-architected, well-documented MCP server with 25 tools across 10 blockchain networks. The codebase demonstrates strong domain knowledge and thoughtful agentic design (competing interpretations, observation coverage, cross-tool references). The test suite is multi-layered and meaningfully rigorous.

That said, the review surfaced **6 likely bugs**, **2 security concerns**, **8 code quality issues**, and **several test coverage gaps**. The most impactful are the hardcoded 18-decimal assumption in onchain.ts (wrong values for USDC), floating-point precision loss in BigInt conversions, and the response body double-consumption bug in api.ts.

---

## Bugs (Likely to Produce Incorrect Output)

### 1. Hardcoded 18 decimals for all on-chain token amounts
**File:** `src/tools/onchain.ts:642`

All token amounts are formatted assuming 18 decimals. USDC (6 decimals), WBTC (8 decimals), and other non-18-decimal tokens will display values off by factors of 10^10 to 10^12.

```ts
formatTokenAmount(e.amount0, 18)  // Always 18, regardless of actual token decimals
```

**Impact:** High — display values are wildly wrong for non-18-decimal tokens.
**Fix:** Resolve token decimals from pool/PT metadata or accept as parameter.

### 2. Floating-point precision loss in BigInt conversion
**Files:** `src/tools/quote.ts:41`, `src/tools/simulate.ts:112`

```ts
const dx = BigInt(Math.round(amount * 10 ** inputDecimals));
```

When `inputDecimals >= 16`, `10 ** inputDecimals` exceeds `Number.MAX_SAFE_INTEGER`. The multiplication silently loses precision. For 18-decimal tokens (the majority), every trade quote has potential rounding errors.

**Impact:** Medium — quotes may be slightly off for large amounts.
**Fix:** Use BigInt arithmetic throughout, e.g. split the amount at the decimal point.

### 3. Response body double-consumption in fetch error paths
**File:** `src/api.ts:82-84`, `src/api.ts:673-678`

```ts
try {
    return await res.json();
} catch {
    const text = await res.text().catch(() => "(unreadable body)");
```

After `res.json()` fails, the response body stream is already consumed. `res.text()` will always fail, so the error message always says "(unreadable body)" instead of showing the actual response. Same pattern in `fetchPendle`.

**Impact:** Low — only affects error diagnostics, not correctness.
**Fix:** Read body as text first, then `JSON.parse()`.

### 4. Pool context fetch uses wrong address variable
**File:** `src/tools/pool.ts:462`

```ts
fetchSpectra(`/${network}/pt/${pool_address}`)
```

Uses the original `pool_address` parameter instead of `effectivePoolAddr`. If the user passed a pool address (not PT), this fetches the wrong data. Same issue at line 518-532 where `pool_address` is used for portfolio matching instead of `effectivePoolAddr`.

**Impact:** Medium — pool context section shows wrong or empty data when pool address != PT address.

### 5. Next-step hints pass pool address as PT address
**File:** `src/tools/pool.ts:168-169`

```ts
quote_trade(chain="${chain}", pt_address="${pool_address}", ...)
get_pt_details(chain="${chain}", pt_address="${pool_address}")
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

### 3. Duplicated on-chain quoting logic
`quote.ts` has `tryOnChainQuote` but `simulate.ts` duplicates the same logic inline (lines 103-124) instead of importing it.

### 4. Unbounded address type cache
**File:** `src/api.ts:820-821` — `_addressTypeCache` has no TTL and no size limit. Every unique address queried is cached permanently.

### 5. Inconsistent `isError` flag usage across tools
Some tools return `isError: true` on "not found" conditions, others return successful responses with error text. Agents can't reliably detect errors:
- **Has `isError`:** `morpho.ts:69`, `onchain.ts:404,427`
- **Missing `isError`:** `pt.ts:59`, `pool.ts:69,314`, `morpho.ts:189`, `quote.ts:119,125,133`, `simulate.ts:87,93,100`

### 6. `list_pools` sort description says "descending" but maturity sorts ascending
**File:** `src/tools/pt.ts:113,159` — Tool description says "Sort results by this metric (descending)" but maturity sort is ascending (nearest first).

### 7. Hardcoded server version
**File:** `src/index.ts:63` — `version: "1.0.0"` is hardcoded instead of reading from `package.json`.

### 8. Stale CLAUDE.md documentation
- References `src/tools/trade.ts` which doesn't exist (split into `quote.ts` and `simulate.ts`)
- References `src/tools/yield.ts` which doesn't exist (`compare_yield` is in `pt.ts`, `scan_opportunities` in `strategy.ts`, `scan_yt_arbitrage` in `yt_arb.ts`)

---

## Performance Concerns

### 1. N+1 API query pattern in `get_address_activity`
**File:** `src/tools/pool.ts:798-844` — For each discovered pool, activity is fetched individually. A wallet active across 50 pools on 10 chains generates 500+ sequential API calls with no timeout budget.

### 2. Sequential chunk fetching in `fetchLogs`
**File:** `src/api.ts:988-1026` — Large block ranges are fetched one chunk at a time. A small concurrency factor (2-3 parallel chunks) would improve throughput without hitting rate limits.

### 3. Fetches all metavaults to find one
**Files:** `src/tools/metavault.ts:458` — Both `get_curator_dashboard` and `model_metavault_strategy` fetch ALL metavaults on the chain, then filter client-side. Mitigated by the 30s cache.

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
| `list_pendle_markets` has zero functional testing anywhere | Medium |
| `get_protocol_context` has no integration test in main suite | Low |
| ~30 formatting/rendering functions in `formatters.ts` have no unit tests | Low-Medium |
| `resolveRpcUrl` in config.ts is untested | Low |
| No mock layer — all integration tests require live network | Medium |
| `--offline` mode only tests schema registration, zero logic | Medium |

### Test Count Discrepancy
CLAUDE.md claims "371 integration tests" and "88 agent reasoning assertions" but actual `assert()` counts are ~331 and ~55 respectively. The difference comes from counting `pass()`/`skip()` calls as assertions.

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

| Priority | Items |
|----------|-------|
| **P0 — Fix now** | #1 (18-decimal bug), #4 (wrong address variable) |
| **P1 — Fix soon** | #2 (BigInt precision), #3 (double body consumption), #5 (isError consistency) |
| **P2 — Improve** | Security concerns, duplicated code, test coverage gaps |
| **P3 — Nice to have** | Performance optimizations, `as any` cleanup, documentation fixes |
