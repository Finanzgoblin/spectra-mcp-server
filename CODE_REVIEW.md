# Code Review: Spectra MCP Server — Full Tool Suite

**Date**: 2026-03-18
**Scope**: All tool files in `src/tools/`, shared helpers (`formatters.ts`, `api.ts`, `config.ts`)
**Method**: Static analysis + protocol documentation cross-reference (Pendle V2 AMM whitepaper, Morpho docs, Spectra docs)

---

## Methodology & Corrections

This review was conducted in two passes:
1. **Initial scan** — identified potential issues via static analysis
2. **Verification pass** — cross-referenced findings against protocol source code (Pendle MarketMathCore, Morpho, Spectra) and the actual `estimateLoopingEntryCost()` implementation to verify mathematical claims

Several initial findings were **retracted or downgraded** after verification. Each finding below includes a confidence assessment.

---

## HIGH SEVERITY

### 1. Pendle looping uses naive linear scaling instead of the proper per-loop impact model

**File**: `src/tools/pendle_looping.ts` lines 170–171, 199–200
**Confidence**: HIGH (verified against `estimateLoopingEntryCost` in formatters.ts)

```typescript
const impact0 = estimatePendlePriceImpact(refCapital, poolLiqUsd, totalPt, totalSy, days);
const totalImpactPct = impact0 * 100 * i; // conservative: linear scaling
```

The Spectra equivalent (`looping.ts:213`) correctly uses `estimateLoopingEntryCost()` which models:
- Decreasing trade amounts per loop (`capital * ltv^i`)
- Reduced effective liquidity as prior loops drain the pool
- Dollar-weighted blended impact

The Pendle tool **imports** `estimateLoopingEntryCost` (line 23) but never uses it, falling back to `impact0 * i` instead.

**Is linear scaling conservative?** It depends on pool size:
- **Large pools** (trade << liquidity): linear overestimates because each loop trades less (`ltv^i`), so it IS conservative
- **Small pools** (trade significant vs liquidity): Pendle's logit AMM has increasing convexity for sequential swaps (confirmed by Pendle docs: "larger or sequential trades pushing the pool toward extremes encounter increasing convexity"). Linear scaling can UNDERESTIMATE here

**Impact**: For large pools, the approximation is safe. For small/illiquid pools, the tool may underestimate entry costs and make unprofitable strategies look viable.

**Fix**: Use `estimateLoopingEntryCost()` (already imported) instead of linear scaling, consistent with the Spectra tool.

---

### 2. Break-even borrow rate formula in curator_scan.ts uses wrong base

**File**: `src/tools/curator_scan.ts` lines 496–498
**Confidence**: HIGH (verified against looping.ts and pendle_looping.ts)

```typescript
opp.morpho.breakEvenBorrowRate = bestLev > 1
  ? (opp.effectiveApy * bestLev) / (bestLev - 1)
  : undefined;
```

Uses `effectiveApy` (= `impliedApy - annualizedEntryCost`) instead of `impliedApy`.

**Correct derivation**:
```
net = impliedApy * lev - borrowRate * (lev - 1) - annualizedEntryCost = 0
=> borrowRate = (impliedApy * lev - annualizedEntryCost) / (lev - 1)
```

**What the code computes**:
```
borrowRate = ((impliedApy - annualizedEntryCost) * lev) / (lev - 1)
           = (impliedApy * lev - annualizedEntryCost * lev) / (lev - 1)
```

The difference is `annualizedEntryCost` — the code over-subtracts entry cost by a factor of `lev`. At 3x leverage with 2% annualized entry cost, the break-even is underestimated by ~2 percentage points. This is conservative (shows a tighter threshold), but mathematically wrong and could cause users to skip profitable opportunities.

**The standalone tools** (`looping.ts:316`, `pendle_looping.ts:232`) use `baseApy * lev / (lev - 1)` without entry cost, which is correct for their context.

---

### 3. Unsafe USD value fallback in Pendle quote

**File**: `src/tools/pendle_quote.ts` lines 98–100
**Confidence**: HIGH

```typescript
const tradeValueUsd = amount * (poolLiqUsd > 0 && d.totalTvl > 0
  ? d.totalTvl / (totalPt + totalSy || 1)
  : 1);
```

Falls back to `$1/token` when price data is missing. For non-USD tokens (BTC at ~$60K, ETH at ~$3K, weETH), price impact calculation is wildly incorrect — a 10 ETH trade would be valued at $10 instead of ~$30K.

**Impact**: Price impact percentage is wrong by orders of magnitude for non-stablecoin pools without TVL data.

**Fix**: When TVL data is unavailable, flag the impact estimate as unreliable rather than silently using $1.

---

### 4. MetaVault gross estimate ignores YT protocol fees

**File**: `src/tools/curator_scan.ts` lines 522–525
**Confidence**: HIGH (verified against CLAUDE.md fee documentation)

```typescript
opp.mvGrossEstimatePct = opp.lpApy + opp.variableApr * 0.3;
```

This auto-calculates a MetaVault gross estimate using 30% of variable APR as YT compounding yield, but does NOT deduct the protocol's YT fee (3% for Spectra, 5% for Pendle).

**Note**: The CLAUDE.md states "agents must multiply by (1 - fee_rate) manually" — but this applies to AI agents consuming tool outputs. When the tool itself generates an internal estimate, the fee should be applied within the calculation.

**Fix**:
```typescript
const ytFee = opp.protocol === 'pendle' ? 0.05 : 0.03;
opp.mvGrossEstimatePct = opp.lpApy + opp.variableApr * 0.3 * (1 - ytFee);
```

---

## MEDIUM SEVERITY

### 5. Loose underlying matching in Pendle yield curves

**File**: `src/tools/pendle_yield_curve.ts` lines 85–87
**Confidence**: HIGH

```typescript
return norm.includes(targetNorm) || targetNorm.includes(norm);
```

Substring matching: searching for "ETH" matches "stETH", "rETH", "weETH" simultaneously. These are different assets with different risk profiles and yield characteristics.

**Impact**: Yield curve data mixes fundamentally different underlyings, making the output misleading.

**Fix**: Prefer exact match after normalization, with explicit alias groups for known related assets.

---

### 6. Pendle looping: unused import of estimateLoopingEntryCost

**File**: `src/tools/pendle_looping.ts` line 23
**Confidence**: HIGH (grep confirms single reference is the import)

`estimateLoopingEntryCost` is imported but never called. The tool uses `impact0 * i` instead. This appears to be an oversight — the function was likely intended to be used (as it is in the Spectra equivalent).

---

### 7. MetaVault drawdown calculation: unguarded division by peak

**File**: `src/tools/metavault.ts` line 122
**Confidence**: MEDIUM

```typescript
const drawdown = (rates[i] - peak) / peak * 100;
```

`peak` is initialized to `rates[0]`. If `rates[0]` is 0 (e.g., a vault with no share rate data), division by zero occurs. Other division operations in this file are properly guarded.

---

### 8. Silent negative-APY filtering in scanners

**File**: `src/tools/pendle_scanner.ts` line 336; `src/tools/strategy.ts` similar
**Confidence**: HIGH

```typescript
const filtered = opportunities.filter((o) => o.sortApy >= 0);
```

Opportunities with negative effective APY (after entry cost) are silently dropped. Users see fewer results with no explanation. A 2% implied APY pool with 3% entry cost disappears without trace.

**Fix**: Add a summary line: `"Filtered N opportunities with negative effective APY (entry cost exceeds yield)"`.

---

### 9. Capacity curve log-spacing can produce duplicate tiers

**File**: `src/tools/pendle_capacity.ts` lines 88–96
**Confidence**: HIGH

```typescript
tiers.push(Math.round(10 ** log));
```

At tight spacing, `Math.round()` can produce identical tier values (e.g., $1000 and $1001 both round to $1000). No deduplication is performed.

**Fix**: Add `tiers = [...new Set(tiers)]` after generation.

---

## LOW SEVERITY

### 10. Type safety: fetchSpectra returns `unknown` but callers cast to `any`

**Files**: Multiple tools via `fetchSpectra(...) as Promise<any>`
**Confidence**: HIGH

No runtime validation that API responses match expected shapes. Missing/malformed fields pass silently and may cause undefined behavior downstream.

---

### 11. Error fallbacks swallow context

**Files**: Multiple tools
**Confidence**: HIGH

Pattern throughout:
```typescript
.catch(() => ({ campaigns: new Map(), available: false }));
```

Real API errors (rate limits, auth failures, malformed responses) are silently swallowed. Adding `console.warn` with the error message would aid debugging without changing behavior.

---

### 12. Hardcoded scalarRoot = 50 across multiple files

**Files**: `pendle_scanner.ts`, `pendle_looping.ts`, `pendle_quote.ts`, `pendle_capacity.ts` (all via `estimatePendlePriceImpact`)
**Confidence**: HIGH

Centralized in `formatters.ts:1786` as `CONSERVATIVE_SCALAR_ROOT = 50`. Actual per-pool scalarRoot varies (50–200 for stablecoins, higher for volatile assets). The conservative choice is intentional and documented, but could be fetched from the Pendle API per-market for better accuracy.

---

### 13. Duplicate daysToMaturity implementations

**Files**: `formatters.ts` lines 25–35, 3384–3390
**Confidence**: HIGH

Three implementations: `daysToMaturity()` (integer), `fractionalDaysToMaturity()` (fractional, Unix timestamp), `pendleDaysToMaturity()` (fractional, string input). All are safe and fit-for-purpose, but `pendleDaysToMaturity` could delegate to `fractionalDaysToMaturity` after parsing the string.

---

### 14. Strategy inference labels are simplistic

**File**: `src/tools/pendle_portfolio.ts` lines 53–59
**Confidence**: MEDIUM

Labels like "Pure YT (variable yield bull)" don't distinguish between intentional YT holds, positions from flash-redeems, or rebalanced portfolios. Display-only, but could confuse users.

---

## RETRACTED / DOWNGRADED FINDINGS

The following initial findings were **retracted** after verification:

| Original Finding | Reason Retracted |
|---|---|
| "Linear scaling underestimates costs" (claimed HIGH) | Downgraded to situational — linear scaling is conservative for large pools (overestimates). Only problematic for small/illiquid pools. Retained as issue #1 with corrected analysis. |
| "Suggested fix: `(1 - Math.pow(1 - impact0, i))`" | **WRONG** — multiplicative loss model doesn't apply to AMM impact. The correct fix is to use `estimateLoopingEntryCost()` which properly models per-loop liquidity drain. |
| "YT fees not applied in metavault.ts" | `yt_compounding_apy` is a user-provided parameter — users may provide it pre- or post-fee. The CLAUDE.md design says "agents must apply manually." NOT a bug. |
| "Slippage not applied in scanner effective APY" | Scanners are opportunity-finders, not execution tools. Slippage is correctly handled in quote tools (`pendle_quote.ts:107`). Scanner APY represents pre-slippage opportunity, which is the right abstraction level. |
| "Entry cost annualization is unsound" | The annualization formula `impactFrac * (365/days)` is mathematically correct for comparing positions on a common annualized basis. It's the standard approach in fixed-income analysis. |
| "Blended APY ignores entry cost" (pendle_simulate.ts) | Blended APY uses spot rates for portfolio-level view, which is the conventional approach. Entry cost is a one-time event, not an ongoing drag on portfolio APY. |

---

## VERIFIED SAFE

The following areas were audited and found to be well-implemented:

| Area | Assessment |
|---|---|
| Division-by-zero guards | All arithmetic in formatters.ts, api.ts, looping.ts is properly guarded with Math.max, conditional checks, or clamping |
| `estimateLoopingEntryCost()` | Sophisticated per-loop model with diminishing liquidity — correctly handles geometric sum of trade sizes and effective liquidity drain |
| `cumulativeLeverageAtLoop()` | Correct geometric series: `(1 - ltv^(loops+1)) / (1 - ltv)` with degenerate case handling |
| `estimatePendlePriceImpact()` | Correctly implements logit AMM depth: `rateScalar * p * (1-p)` with conservative scalarRoot, clamped to never exceed constant-product impact |
| Retry/timeout logic | Proper exponential backoff, 4xx vs 5xx distinction, AbortSignal timeout |
| Token precision handling | BigInt divisor construction throughout, safe for >18 decimal tokens |
| Borrow rate risk analysis | Normal CDF approximation (Abramowitz & Stegun), proper z-score and probability calculations |
| Config staleness tracking | `checkConfigStaleness()` warns when constants are >120 days old |

---

## SUMMARY TABLE

| # | File | Issue | Severity | Verified |
|---|------|-------|----------|----------|
| 1 | pendle_looping.ts | Linear scaling instead of per-loop impact model | HIGH | Yes — imports fix but doesn't use it |
| 2 | curator_scan.ts | Break-even formula uses wrong base (effectiveApy vs impliedApy) | HIGH | Yes — algebraically confirmed |
| 3 | pendle_quote.ts | $1/token USD fallback for non-stablecoins | HIGH | Yes |
| 4 | curator_scan.ts | MetaVault estimate ignores YT protocol fees | HIGH | Yes — auto-calculated, not user-provided |
| 5 | pendle_yield_curve.ts | Substring matching mixes different underlyings | MEDIUM | Yes |
| 6 | pendle_looping.ts | Unused import of estimateLoopingEntryCost | MEDIUM | Yes — grep confirms |
| 7 | metavault.ts | Unguarded peak=0 in drawdown calculation | MEDIUM | Yes |
| 8 | scanners | Silent negative-APY filtering | MEDIUM | Yes |
| 9 | pendle_capacity.ts | Duplicate tiers from log-spacing rounding | LOW | Yes |
| 10 | Multiple | fetchSpectra `any` casts, no schema validation | LOW | Yes |
| 11 | Multiple | Error fallbacks swallow context | LOW | Yes |
| 12 | formatters.ts | Hardcoded scalarRoot (intentionally conservative) | LOW | Yes — design choice |
| 13 | formatters.ts | Duplicate daysToMaturity implementations | LOW | Yes |
| 14 | pendle_portfolio.ts | Simplistic strategy labels | LOW | Yes |

**Priority fixes**: #1, #2, #3, #4 (HIGH severity, verified)
