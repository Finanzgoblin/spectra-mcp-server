# DeFi Curator Strategy Review — Spectra MCP Server

**Date:** 2026-03-06
**Scope:** Full codebase review of all 18 tool modules, core infrastructure, types, formatters, config, and test coverage.

---

## Executive Summary

The codebase is **production-quality and well-architected**. Clear phase-separated pipelines, resilient parallel fetching (`Promise.allSettled` everywhere), and thoughtful graceful degradation for optional data sources (Merkl, veSPECTRA, Hyperliquid, Morpho). Zero heavy dependencies (no ethers/viem — raw RPC calls). 4-tier test pyramid (191 unit + 405 integration + 82 agent reasoning + 38 LLM-graded subjective). No critical bugs found. 27 findings organized by severity below.

---

## HIGH Priority (5 findings)

### H1. Entry cost not factored into optimal loop selection
**Files:** `looping.ts`, `strategy.ts`, `curator_scan.ts`

The `bestLoop` selection uses pure net APY (`baseApy * leverage - borrowRate * (leverage - 1)`) without subtracting annualized entry drag. Since net APY is monotonically increasing in loop count when spread is positive, the optimizer **always picks max loops** (or zero). A user with large capital relative to pool liquidity could see a recommended loop count whose cumulative entry cost exceeds the incremental benefit.

**Impact:** Misleading "optimal" loop recommendations for capital-heavy users in shallow pools.
**Fix:** Incorporate `estimateLoopingEntryCost` into the optimization objective, or add a prominent warning when annualized entry cost exceeds 50% of the incremental APY from the last loop.

### H2. No guard against PT trading at premium in `looping.ts`
**File:** `looping.ts`

`yt_arb.ts` correctly filters `ptPriceUnderlying >= 1`, but `looping.ts` does not. If PT trades at a premium (possible near/post maturity), `ptDiscount = 1 - ptPrice` goes negative and all downstream math (leveraged APY, break-even) becomes misleading.

**Fix:** Add `if (ptPriceUnderlying >= 1)` early return with explanation.

### H3. Per-opportunity error handling absent in Phase 2 loops
**Files:** `curator_scan.ts`, `strategy.ts`

The Phase 2 processing loops (iterating over raw pools to compute metrics) have no per-item try/catch. A single malformed API entry (null field, unexpected type) could crash the entire scan. The outer try/catch catches it, but returns a generic error instead of gracefully skipping the bad entry.

**Fix:** Wrap per-pool processing in try/catch, log warning, continue.

### H4. `Number(dyRaw)` precision loss in `tryOnChainQuote`
**File:** `quote.ts` line 50

For tokens with 18 decimals and large outputs, `Number(dyRaw)` could lose precision since `dyRaw` is a BigInt that might exceed `Number.MAX_SAFE_INTEGER` (2^53). For instance, 1M tokens with 18 decimals = 1e24, well beyond safe integer range.

**Fix:** Use the same BigInt division pattern as `amountToBigInt` / `fetchIbtConversionRate`.

### H5. Version mismatch
**Files:** `index.ts`, `package.json`

`index.ts` registers the McpServer as `"1.0.0"` while `package.json` says `"1.1.0"`.

**Fix:** Sync versions.

---

## MEDIUM Priority (11 findings)

### M1. Hardcoded hypothetical borrow rate inconsistency
**File:** `curator_scan.ts` lines 369-370

Hypothetical looping projections use 3% borrow rate, but `PROTOCOL_CONSTANTS.loopingDefaults` uses 5%. Curators comparing outputs from `scan_curator_opportunities` vs `get_looping_strategy` will see different numbers for the same hypothetical scenario.

**Fix:** Use `PROTOCOL_CONSTANTS.loopingDefaults.borrowRatePct` consistently.

### M2. Looping `sortApy` can decrease vs base effective APY
**File:** `strategy.ts`

When looping is attached, `sortApy` is overridden to `effectiveNetApy` (looping net minus cumulative entry cost). But the check only verifies `net > impliedApy` (steady-state), not that `effectiveNetApy > effectiveApy`. If cumulative entry costs dominate, the sort key actually **decreases**, demoting an opportunity that would rank higher without looping.

**Fix:** Only override `sortApy` when `effectiveNetApy > effectiveApy`.

### M3. `failedChains` is dead code in `scanAllMetavaults`
**File:** `metavault.ts`

`fetchMetavaults` catches all errors and returns `[]`, so `Promise.allSettled` never sees rejections. `failedChains` is always empty.

**Fix:** Either make `fetchMetavaults` throw on failure, or detect empty-result chains as "failed".

### M4. Lifetime yield calculation inconsistency in dashboard
**File:** `metavault.ts` lines 604-609

`lifetimeYieldUsd` is recomputed from `firstAssets * (lastRate - firstRate) / firstRate`, but per-epoch yield accruals correctly use `prevAssets`. These diverge when deposits/withdrawals occur between epochs.

**Fix:** Set `lifetimeYieldUsd = sum of per-epoch yieldAccrual`.

### M5. Fee revenue estimate overstates by including incentive APY
**File:** `metavault.ts` line 697

`estimatedAnnualFeeRevenueUsd` uses `liveApyTotal` which includes Merkl/gauge incentives. Curator performance fees typically apply only to organic vault yield.

**Fix:** Use organic APY only, or clearly label as "gross estimate including incentives".

### M6. Morpho liquidity sufficiency not checked
**File:** `strategy.ts`

Morpho market effective liquidity is fetched and stored but never compared against the capital required for the recommended loops. A user could see "optimal 4 loops at 3.5x leverage" when the Morpho market has insufficient borrow liquidity.

**Fix:** Add warning when `capital_usd * (leverage - 1) > morphoLiqUsd`.

### M7. Katana RPC documentation inconsistency
**Files:** `CLAUDE.md`, `config.ts`

`CLAUDE.md` says "No default RPC in the server" for Katana, but `config.ts` has `"https://rpc.katana.network"` hardcoded.

**Fix:** Update CLAUDE.md.

### M8. Limited RPC fallbacks
**File:** `config.ts`

Only mainnet/base/arbitrum have fallback RPCs. Chains like sonic, bsc, avalanche, flare have single points of failure.

### M9. Capacity tool only analyzes buy-side
**File:** `capacity.ts`

The tool generates a capital ladder for buying PT but doesn't analyze sell-side (exit capacity). A large deployer also needs to know how much they can unwind without excessive impact.

### M10. Pool balance ratio thresholds lack graduated severity
**File:** `ibt_health.ts` line 257

4:1 and 1:4 ratios trigger caution, but there's no "warning" tier for extremely imbalanced pools (50:1, 100:1). A pool with a 50:1 ratio gets the same signal as a 5:1 ratio.

### M11. Reserve ratio display inconsistency
**Files:** `quote.ts`, `ibt_health.ts`

Reserve ratio is computed as `ptReserve / ibtReserve` in quote.ts but as `ibtReserve / ptReserve` in ibt_health.ts. Both are labeled, but could confuse an agent comparing outputs.

---

## LOW Priority (11 findings)

### L1. Hardcoded $10K reference capital in `looping.ts`
Entry cost estimates use `refCapital = 10_000` for all users. The comment claims "annualized drag % is capital-independent" but this is incorrect — `estimatePriceImpact(capital, poolLiq) = capital / (2 * poolLiq)` is proportional to capital.

### L2. Pendle LP APY used for ranking excludes vePENDLE boost
**File:** `curator_scan.ts`

Spectra LP APY includes veSPECTRA boost for ranking, but Pendle LP APY uses base `aggregatedApy` without vePENDLE boost, creating a slight ranking disadvantage for Pendle LP strategies.

### L3. Break-even borrow rate uses different bases
**File:** `curator_scan.ts`

Real Morpho markets use `effectiveApy` (after entry cost), hypothetical markets use `impliedApy` (before entry cost). The numbers aren't directly comparable.

### L4. LP balance precision at 18 decimals
**File:** `metavault.ts`

`Number(10n ** 18n)` = 1e18 exceeds `Number.MAX_SAFE_INTEGER`. Theoretical precision loss of a few wei — negligible for USD display but technically unsafe.

### L5. Merkl campaign chain key mismatch risk
**File:** `curator_scan.ts`

Spectra uses `resolveNetwork(chain)` as Merkl map key; Pendle uses raw `chain`. Works because `PENDLE_CHAIN_IDS` keys match resolved format, but fragile if Pendle data ever uses "ethereum" instead of "mainnet".

### L6. Epoch rate divisor hardcoded to 1e6
**File:** `metavault.ts` line 579

Rate precision assumption `/ 1e6` is undocumented. If the API changes precision, this silently breaks.

### L7. Funding rates don't influence ranking
**File:** `curator_scan.ts`

Hyperliquid funding rates are attached as metadata but don't affect `sortApy`. A high positive funding rate (shorting cost for delta-neutral) could make an opportunity uneconomical without being demoted.

### L8. `formatters.ts` is 3,818 lines
The largest file in the codebase handles primitive formatting, domain formatting, strategy modeling, cross-protocol matching, and pattern detection all in one file. Maintenance concern.

### L9. `veTotalSupply` fetch failure silently degrades
**File:** `strategy.ts`

If `fetchVeTotalSupply()` throws, `veTotalSupply` stays `null`, and the boost computation is entirely skipped. The user gets no indication that their `ve_spectra_balance` parameter was effectively ignored.

### L10. Yield curve shape analysis is endpoint-only
**File:** `yield_curve.ts` lines 157-165

A curve that rises then falls (humped) would be classified as either normal or inverted based on first-vs-last point only.

### L11. Hyperliquid funding fetch doesn't use `fetchWithRetry`
**File:** `api.ts` line 2076

Uses raw `fetch` instead of `fetchWithRetry`. Transient network errors won't be retried. Likely intentional since it's supplementary data.

---

## Architecture Strengths

1. **Phase-separated pipeline design** across all scanner tools — clean, debuggable, extensible
2. **`Promise.allSettled` everywhere** — one chain failure never blocks others
3. **Graceful degradation** for optional data (Merkl, veSPECTRA, Hyperliquid, Morpho)
4. **Conservative impact model** (constant-product upper bound for StableSwap) — safely overstates rather than understates risk
5. **Capital-aware sorting** as the core differentiator — entry cost amortization over maturity is smart design
6. **Cross-protocol matching** (Spectra vs Pendle within 90-day maturity window) adds genuine curator value
7. **MetaVault workflow** (discover -> dashboard -> model) is well-composed
8. **Zero heavy dependencies** — no ethers/viem; raw RPC calls keep server lightweight
9. **Inflight request deduplication** prevents thundering-herd problems on concurrent tool calls
10. **Boundary validation** at every API intake point prevents malformed data from propagating
11. **4-tier test pyramid** — 191 unit + 405 integration + 82 agent reasoning + 38 LLM-graded subjective tests
12. **Safe BigInt arithmetic** via `amountToBigInt` string manipulation avoids float precision traps
13. **18 tool modules** with clean `register(server)` plugin pattern

---

## Recommended Priority Order

1. **Fix H1-H3** — these affect recommendation accuracy and resilience
2. **Fix M1-M2** — inconsistency bugs that produce wrong sort order
3. **Fix H4-H5** — precision and version sync (quick wins)
4. **Address M6** — Morpho liquidity check (cheap to add, prevents user confusion)
5. **Address M4-M5** — curator dashboard accuracy
6. **Consider M9** — sell-side capacity analysis for completeness

The codebase is in strong shape overall. The main theme: **entry cost accounting should be more tightly integrated into optimization objectives** rather than computed alongside but separate from ranking logic.
