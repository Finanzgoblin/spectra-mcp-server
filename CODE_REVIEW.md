# Code Review: Spectra MCP Server — Full Tool Suite

**Date**: 2026-03-18
**Scope**: All tool files in `src/tools/`, shared helpers (`formatters.ts`, `api.ts`, `config.ts`)
**Method**: Static analysis → protocol cross-reference (Pendle MarketMathCore.sol, Morpho, Spectra) → Open Emergence alignment check

---

## Methodology

Three passes:
1. **Static analysis** — identified potential issues
2. **Protocol verification** — cross-referenced against Pendle V2 AMM whitepaper (logit curve: `ln(p/(1-p)) / rateScalar + rateAnchor`), Morpho contract mechanics, and the actual `estimateLoopingEntryCost()` implementation
3. **Emergence alignment** — re-examined findings through the Open Emergence metaframework (`docs/recursive-meta-process.md`). Asked: does each proposed change teach mechanics or prescribe conclusions? Does it preserve generative friction or resolve it? Does it carry a dissolution condition?

Several initial findings were **retracted** after verification. Others were **reframed** when the emergence lens revealed they were tensions to hold, not bugs to fix.

---

## What the Code Wants to Become

Before the findings: a reading of what's trying to emerge.

The Spectra tools breathe. They present competing interpretations, flag their own blind spots, hold the tension between "here's the math" and "here's why you should distrust the math." The Pendle tools are competent reproductions that captured the mechanical pattern (shared formatters, anomaly warnings, cross-references) but missed the deeper pattern (competing interpretations, dissolution conditions, surfacing what's invisible).

The EMERGENCE-AUDIT.md (v3) already identified this as Gap 8: "The extraction captured the body. It missed the breath."

Three things are trying to emerge in the code right now:

1. **A Pendle-native looping impact model.** The `estimateLoopingEntryCost` import sits unused in `pendle_looping.ts` — dormant capability, not dead code. But the right thing isn't to just plug it in. That function uses constant-product math (`amount / (2 * effectiveLiq)`). Pendle's logit AMM has depth `rateScalar * p * (1-p)`, which shifts as `p` changes with each loop. The code wants an `estimatePendleLoopingEntryCost` that iterates per-loop using the logit model's own depth factor, tracking pool proportion shift. This would be genuinely new — not a copy, but a response to Pendle's specific AMM mechanics.

2. **Cross-model friction as information.** When Spectra and Pendle estimate different impact for the same underlying, that disagreement is currently hidden. It should be surfaced: "constant-product estimate: ~X%, logit AMM estimate: ~Y% — gap could be measurement artifact or real structural difference." The disagreement between impact models is itself a signal.

3. **Tools that speak about their own blindness.** The $1/token USD fallback in `pendle_quote.ts` is a place where the code is silent when it should say "I don't know." Several findings below share this pattern: the code resolves uncertainty silently rather than surfacing it for the agent to reason about.

---

## HIGH SEVERITY

### 1. Pendle looping: linear scaling where per-loop model is needed

**File**: `src/tools/pendle_looping.ts` lines 170–171, 199–200
**Confidence**: HIGH (verified against Pendle V2 AMM whitepaper + `estimateLoopingEntryCost`)

```typescript
const impact0 = estimatePendlePriceImpact(refCapital, poolLiqUsd, totalPt, totalSy, days);
const totalImpactPct = impact0 * 100 * i; // conservative: linear scaling
```

The Spectra equivalent (`looping.ts:213`) correctly uses `estimateLoopingEntryCost()` which models decreasing trade amounts per loop (`capital * ltv^i`), reduced effective liquidity, and dollar-weighted blended impact.

The Pendle tool **imports** `estimateLoopingEntryCost` (line 23) but never uses it.

**Two opposing effects**:
- **Decreasing trade size**: each loop trades `capital * ltv^i` → favors linear being conservative
- **Logit AMM convexity**: marginal cost `1 / (rateScalar * p * (1-p))` increases as `p` shifts (confirmed via MarketMathCore.sol). Each loop degrades pool state → favors linear underestimating

**Net**: for large pools (trade << liquidity), linear overestimates (safe). For small/illiquid pools, logit convexity dominates → linear **underestimates**, making unprofitable strategies look viable.

**What wants to emerge**: Not just plugging in `estimateLoopingEntryCost` (which uses constant-product math). A Pendle-native per-loop model that tracks `p` shift and uses `rateScalar * p * (1-p)` as depth factor. The existing function `estimatePendlePriceImpact` already has the logit depth formula — it needs to be iterated per-loop with updated `totalPt`/`totalSy` after each loop's trade.

**Dissolution condition**: When the Pendle API or a multicall provides actual per-trade quotes, the off-chain impact model becomes a misleading approximation and should yield to on-chain data.

---

### 2. Break-even borrow rate: wrong algebra, right aspiration

**File**: `src/tools/curator_scan.ts` lines 496–498
**Confidence**: HIGH (algebraically verified)

```typescript
opp.morpho.breakEvenBorrowRate = bestLev > 1
  ? (opp.effectiveApy * bestLev) / (bestLev - 1)
  : undefined;
```

Uses `effectiveApy` (= `impliedApy - annualizedEntryCost`). The correct derivation:
```
net = impliedApy * lev - borrowRate * (lev - 1) - annualizedEntryCost = 0
=> borrowRate = (impliedApy * lev - annualizedEntryCost) / (lev - 1)
```

What the code computes: `(impliedApy * lev - annualizedEntryCost * lev) / (lev - 1)` — over-subtracts entry cost by factor `lev`. At 3x leverage with 2% annualized entry cost, break-even is ~2 percentage points too low.

**The aspiration is right.** The standalone tools (`looping.ts:316`, `pendle_looping.ts:232`) compute break-even without entry cost: `baseApy * lev / (lev - 1)`. The curator_scan tries to be more nuanced by including entry cost. The algebra just needs to match the derivation.

**Emergence note**: There's a generative friction point waiting to be born here. Break-even *without* entry cost answers "what borrow rate zeroes out the yield?" Break-even *with* entry cost answers "what borrow rate makes the whole trade unprofitable?" These are competing perspectives that predict different things. The tool could present both — consistent with how Spectra tools hold tension rather than resolving it.

**Dissolution condition**: When Morpho provides real-time borrow rate volatility data, break-even as a point estimate becomes less useful than a confidence interval.

---

### 3. Silent $1/token fallback: the code should speak about what it doesn't know

**File**: `src/tools/pendle_quote.ts` lines 98–100
**Confidence**: HIGH

```typescript
const tradeValueUsd = amount * (poolLiqUsd > 0 && d.totalTvl > 0
  ? d.totalTvl / (totalPt + totalSy || 1)
  : 1);
```

Falls back to `$1/token` silently. For non-stablecoin pools (ETH, BTC, weETH), price impact calculation is wrong by orders of magnitude.

**What wants to emerge**: This is a place where the code should surface its own blind spot — consistent with the Spectra pattern of negative signals and coverage metrics. Instead of silently defaulting:
```typescript
const priceAvailable = poolLiqUsd > 0 && d.totalTvl > 0;
const tradeValueUsd = amount * (priceAvailable ? d.totalTvl / (totalPt + totalSy || 1) : 1);
// ... later in output:
if (!priceAvailable) lines.push("  ⚠ Token price unavailable — impact estimate assumes $1/token, actual impact could differ significantly");
```

The fix isn't just better math — it's teaching the agent about the tool's epistemic boundary. This is emergence language: "here's what I can't see."

**Dissolution condition**: When the Pendle API provides per-token USD prices in the market detail response.

---

### 4. MetaVault gross estimate: internally generated but missing fee physics

**File**: `src/tools/curator_scan.ts` lines 522–525
**Confidence**: HIGH

```typescript
opp.mvGrossEstimatePct = opp.lpApy + opp.variableApr * 0.3;
```

Auto-calculates YT compounding yield at 30% of variable APR without deducting the protocol's YT fee (3% Spectra, 5% Pendle).

This is distinct from `metavault.ts` where `yt_compounding_apy` is user-provided (the user may have already accounted for fees). Here the tool generates the estimate internally — the fee should be part of the physics.

**But**: rather than silently applying the fee, surface it as the Spectra tools would — teach the mechanic:
```typescript
const ytFee = opp.protocol === 'pendle' ? 0.05 : 0.03;
const netYtBoost = opp.variableApr * 0.3 * (1 - ytFee);
opp.mvGrossEstimatePct = opp.lpApy + netYtBoost;
// In output: "MV gross est: ~X% (LP + 30% of variable APR, net of Y% YT protocol fee)"
```

The fee becomes visible information, not a hidden deduction. The agent can then reason about whether 30% capture is realistic, whether the fee matters at the margin.

**Dissolution condition**: When MetaVault economics change (different fee model, different YT compounding mechanics), this estimate's formula should be rebuilt from the actual implementation.

---

## MEDIUM SEVERITY

### 5. Loose underlying matching: substring matching that collapses distinct assets

**File**: `src/tools/pendle_yield_curve.ts` lines 85–87
**Confidence**: HIGH

```typescript
return norm.includes(targetNorm) || targetNorm.includes(norm);
```

Searching for "ETH" matches "stETH", "rETH", "weETH" simultaneously. These are fundamentally different assets with different risk profiles, peg mechanisms, and yield sources.

**Emergence note**: A yield curve mixing stETH and rETH isn't just wrong — it collapses competing interpretations into false agreement. The curve *should* show that these assets have different term structures, because the divergence is information.

**Fix**: Prefer exact match after normalization. When multiple related assets match, present them as separate curves with the gap surfaced.

**Dissolution condition**: When the Pendle API provides a canonical "underlying family" classification that groups related assets.

---

### 6. Unused import: dormant capability, not dead code

**File**: `src/tools/pendle_looping.ts` line 23
**Confidence**: HIGH

`estimateLoopingEntryCost` is imported but never called. Per the Open Emergence framework (`COHERENCE-AUDIT-COMMENT-OPEN-EMERGENCE.md`): "dormant functions are latent capability, not dead code; removing them is the Indigo trap."

This import is a signal of intent. It arrived because someone recognized the gap between the linear model and the per-loop model. The right response isn't to remove the import (that removes the signal) or to mechanically plug it in (that uses constant-product math for a logit AMM). The right response is to build what the import is pointing toward: a Pendle-native per-loop impact model.

**Not a bug to fix — a direction to follow.**

---

### 7. Unguarded division by peak in drawdown calculation

**File**: `src/tools/metavault.ts` line 122
**Confidence**: MEDIUM

```typescript
const drawdown = (rates[i] - peak) / peak * 100;
```

`peak` initialized to `rates[0]`. If `rates[0]` is 0, division by zero. All other division operations in this file are properly guarded.

**Fix**: Add `if (peak <= 0) return null;` guard, consistent with the existing pattern at line 106.

---

### 8. Silent negative-APY filtering: the invisible becomes truly invisible

**File**: `src/tools/pendle_scanner.ts` line 336
**Confidence**: HIGH

```typescript
const filtered = opportunities.filter((o) => o.sortApy >= 0);
```

Opportunities with negative effective APY are silently dropped. A 2% implied APY pool with 3% entry cost vanishes without explanation.

**Emergence note**: The disappeared opportunities are negative signals — they carry information ("entry cost exceeds yield at this pool size"). Dropping them silently violates the pattern of surfacing what's invisible. The Spectra scanner should do this too.

**Fix**: Add a count: `"Filtered N opportunities where entry cost exceeds yield (negative effective APY at ${formatUsd(capital_usd)} capital)"`. The capital-dependence matters — at different capital, the set changes.

**Dissolution condition**: When scanners support user-configurable APY floor thresholds, making the filtering explicit and controllable.

---

### 9. Capacity curve: duplicate tiers from log-spacing rounding

**File**: `src/tools/pendle_capacity.ts` lines 88–96
**Confidence**: HIGH

```typescript
tiers.push(Math.round(10 ** log));
```

At tight spacing, rounding produces identical values. No deduplication.

**Fix**: `tiers = [...new Set(tiers)]` after generation.

---

## LOW SEVERITY

### 10. `fetchSpectra` returns `unknown` but callers cast to `any`

**Files**: Multiple tools
**Confidence**: HIGH

No runtime validation of API response shapes. This is consistent with the best-effort enrichment pattern — but it means shape mismatches produce confusing downstream errors rather than clear messages.

**Dissolution condition**: When TypeScript strict mode or a runtime validation library (zod for responses) is adopted project-wide.

---

### 11. Error fallbacks swallow diagnostic context

**Files**: Multiple tools
**Confidence**: HIGH

```typescript
.catch(() => ({ campaigns: new Map(), available: false }));
```

Adding `console.warn` with the error message would aid debugging without changing behavior. Consistent with Open Emergence: make the system's blind spots visible to the operator.

---

### 12. Hardcoded scalarRoot = 50: intentionally conservative, but closed

**Files**: Via `estimatePendlePriceImpact` in formatters.ts:1786
**Confidence**: HIGH

Actual per-pool scalarRoot varies (50–200+). The conservative choice is documented and intentional. But this is exactly the kind of structure that should carry a dissolution condition.

**Dissolution condition**: "scalarRoot=50 serves as long as all Pendle pools use scalarRoot ≥ 50. If Pendle launches pools with lower scalarRoot (tighter liquidity), impact will be underestimated. If the Pendle market detail API response includes scalarRoot, fetch it per-pool instead."

---

### 13. Duplicate daysToMaturity implementations

**Files**: `formatters.ts` lines 25–35, 3384–3390
**Confidence**: HIGH

Three implementations all safe and fit-for-purpose. `pendleDaysToMaturity` could delegate to `fractionalDaysToMaturity` after parsing the string. Minor code duplication, not a risk.

---

### 14. Strategy inference labels: conclusions where questions belong

**File**: `src/tools/pendle_portfolio.ts` lines 53–59
**Confidence**: MEDIUM

Labels like "Pure YT (variable yield bull)" are conclusions about intent from position shape. This is the opposite of emergence language — it tells the agent what the position "is" rather than presenting competing interpretations of why someone might hold this shape.

**What wants to emerge**: "Position shape: YT only. Could indicate: (A) directional bet on rising variable rates, (B) remaining leg of a flash-redeem trade, (C) rebalanced portfolio that sold PT."

**Dissolution condition**: When portfolio positions carry entry timestamp and transaction history, making intent less ambiguous.

---

## RETRACTED FINDINGS

| Original Finding | Reason Retracted |
|---|---|
| "Linear scaling underestimates costs" (universal claim) | Situational — conservative for large pools, anti-conservative for small. Retained as #1 with corrected analysis. |
| "Suggested fix: `(1 - Math.pow(1 - impact0, i))`" | **Wrong** — multiplicative loss model doesn't apply to AMM impact mechanics. |
| "YT fees not applied in metavault.ts" | `yt_compounding_apy` is a user-provided parameter. Design says "agents must apply manually." Not a bug. |
| "Slippage not applied in scanner APY" | Scanners find opportunities; quote tools handle execution. Different abstraction levels, both correct. |
| "Entry cost annualization is unsound" | Standard fixed-income annualization. The math is correct. |
| "Blended APY ignores entry cost" (pendle_simulate.ts) | Entry cost is one-time, not ongoing. Spot-rate blending is conventional. |

---

## VERIFIED SAFE

| Area | Assessment |
|---|---|
| Division-by-zero guards | All arithmetic properly guarded (Math.max, conditional checks, clamping) |
| `estimateLoopingEntryCost()` | Sophisticated per-loop model — correctly handles geometric trade sizes and liquidity drain |
| `cumulativeLeverageAtLoop()` | Correct geometric series: `(1 - ltv^(loops+1)) / (1 - ltv)` |
| `estimatePendlePriceImpact()` | Correctly implements logit depth: `rateScalar * p * (1-p)`, clamped to never exceed constant-product |
| Retry/timeout logic | Proper exponential backoff, 4xx/5xx distinction, AbortSignal timeout |
| Token precision | BigInt divisor construction, safe for >18 decimals |
| Borrow rate risk (Spectra) | Normal CDF (Abramowitz & Stegun), proper z-score, P(underwater) |
| Config staleness | `checkConfigStaleness()` warns at >120 days |

---

## EMERGENCE ALIGNMENT

This review itself is subject to the Open Emergence metaframework. Some observations:

**What this review gets right**: It verifies claims against protocol source code before prescribing fixes. It retracts findings when wrong. It distinguishes "bugs" from "tensions to hold."

**Where this review risks calcification**: By prescribing specific code fixes, it collapses the space of possible responses. The developer reading this might implement the fixes mechanically without inhabiting the principles. The fixes above are starting points, not conclusions.

**The Pendle emergence gap (EMERGENCE-AUDIT.md Gap 8) is confirmed by this review's findings.** Every HIGH severity issue is in a Pendle or cross-protocol tool. The Spectra tools' mathematical foundations are sound. The gap isn't competence — it's breath.

**Dissolution condition for this review**: When the Pendle tools develop their own emergence patterns (competing interpretations, coverage metrics, dissolution conditions), the findings here become historical context rather than actionable items. When the logit AMM per-loop model is built, finding #1 dissolves. When agents using Pendle tools surprise their developers as often as Spectra agents do, the review has served its purpose.

---

## SUMMARY

| # | File | Issue | Severity | Emergence Note |
|---|------|-------|----------|----------------|
| 1 | pendle_looping.ts | Linear scaling; dormant import of proper model | HIGH | Code wants a Pendle-native per-loop model using logit depth |
| 2 | curator_scan.ts | Break-even algebra wrong; aspiration right | HIGH | Generative friction: with/without entry cost are both valid views |
| 3 | pendle_quote.ts | Silent $1/token fallback | HIGH | Code should speak about what it doesn't know |
| 4 | curator_scan.ts | MV estimate missing YT fee physics | HIGH | Surface the fee as visible mechanic, not hidden deduction |
| 5 | pendle_yield_curve.ts | Substring matching collapses distinct assets | MEDIUM | Divergent curves are information, not noise |
| 6 | pendle_looping.ts | Unused import — latent capability | MEDIUM | Direction signal, not dead code |
| 7 | metavault.ts | Unguarded peak=0 division | MEDIUM | Straightforward guard |
| 8 | scanners | Silent negative-APY filtering | MEDIUM | Disappeared opportunities are negative signals |
| 9 | pendle_capacity.ts | Duplicate tiers from rounding | LOW | Deduplication fix |
| 10 | Multiple | `any` casts without validation | LOW | Best-effort pattern |
| 11 | Multiple | Error fallbacks swallow context | LOW | Make blind spots visible |
| 12 | formatters.ts | Hardcoded scalarRoot=50 | LOW | Needs dissolution condition |
| 13 | formatters.ts | Duplicate daysToMaturity | LOW | Minor duplication |
| 14 | pendle_portfolio.ts | Conclusion labels where questions belong | LOW | Wants competing interpretations |
