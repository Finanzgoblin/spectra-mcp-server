# Spectra MCP Server — Open Emergence Audit (v2)

**Date:** 2026-03-06
**Previous audit:** 2026-02-28
**Scope:** Emergence patterns, observation coverage, competing interpretations, anomaly detection, cross-tool consistency, new tool emergence compliance
**Auditor:** Claude (deep audit aligned with AGENT-TESTS.md Tiers 8-11)

---

## Executive Summary

The Open Emergence architecture remains **the strongest feature of this codebase** and has *improved significantly* since the v1 audit (2026-02-28). Of the 7 gaps identified in v1, **4 have been fully addressed** and 1 partially addressed, leaving 2 open. The codebase has grown from ~23 to ~37 tools across 23 files, with 22 commits landing since the last audit — all maintaining emergence design discipline.

New tools (curator risk monitor, stress testing, rollover planner, curator portfolio, Morpho Phase 2-3, Pendle enhancements) correctly follow the "scaffold attention, not action" principle. The risk monitor explicitly states "Considerations (not directives)" and preserves signal disagreement without collapse.

**Key finding:** The emergence architecture has *scaled well*. New tools added by multiple contributors follow the same patterns (competing branches, coverage metrics, next-step hints) without degradation.

### Test Results (this environment)

| Suite | Count | Pass | Fail | Skip | Notes |
|-------|-------|------|------|------|-------|
| **Unit** | **192** | **192** | **0** | 0 | +27 tests since v1 (was 165) |
| **Integration** | ~405 | ~370 | ~35 | ~14 | Network-only failures |
| **Agent** | 82 | ~65 | ~13 | ~17 | Network issues; emergence tests pass |
| **Subjective** | 38 | — | — | — | LLM-graded (requires ANTHROPIC_API_KEY) |

**Total test surface: 717 tests** (was ~399 at v1).

No code-level bugs found. TypeScript has pre-existing `any` type warnings in `yt_arb.ts` and `yield_curve.ts` (missing module declarations in sandbox) — these are environment issues, not code bugs.

---

## Gap Resolution Status (v1 → v2)

| Gap | Name | v1 Status | v2 Status | Resolution |
|-----|------|-----------|-----------|------------|
| **1** | Router batching per-event flags | ❌ Open | ⚠️ Partial | Address-level hints added (`pool.ts:420-444`), but individual txn rows still lack flags |
| **2** | Incentive sustainability analysis | ❌ Open | ✅ **Closed** | Commit `59f236a`: >50% incentive flag + "Base yield alone: X%" in `formatters.ts`, `metavault.ts:797-802` >70% flag, `ibt_health.ts:209` |
| **3** | Liquidity velocity/trending | ❌ Open | ❌ Open | No historical liquidity snapshots available from API; remains snapshot-only |
| **4** | Cycle detection temporal context | ❌ Open | ❌ Open | No `lastOccurrenceTs` or staleness flag added; cycles still stitched across gaps |
| **5** | Flow accounting confidence quantitative | ❌ Open | ✅ **Closed** | `formatObservationCoverage` now provides value%, temporal%, source% coverage — richer than a single confidence score |
| **6** | Cross-pool temporal correlation | ❌ Open | ⚠️ Partial | `spectra_get_address_activity` scans all chains but no sequential timing analysis |
| **7** | Looping failure scenarios | ❌ Open | ✅ **Closed** | Commit `59f236a`: optimal≤1 warning, unprofitable warning, break-even period, borrow rate sensitivity (+1/+2/+3%), break-even rate, P(underwater) via normal CDF |

**Score: 4/7 closed, 1 partial, 2 open** (was 0/7).

---

## What's Changed Since v1 (22 commits)

### New Emergence-Compliant Tools

| Tool | File | Emergence Compliance | Key Pattern |
|------|------|---------------------|-------------|
| `morpho_monitor_risk` | `risk_monitor.ts` | ✅ Strong | "Alerts scaffold attention, not action"; conflicting signals (health vs rate drift) preserved |
| `spectra_stress_test_vault` | `stress_test.ts` | ✅ Strong | Waterfall coverage quantification (tier-by-tier %); doesn't prescribe action |
| `mv_plan_rollover` | `rollover.ts` | ✅ Adequate | Cross-protocol candidates ranked but not collapsed; no forced recommendation |
| `mv_get_curator_portfolio` | `curator_portfolio.ts` | ⚠️ Minimal | Aggregation tool — shows blended APY, concentration, but no competing interpretations (appropriate for factual aggregation) |
| `morpho_get_positions` | `morpho.ts` | ✅ Strong | Supply/borrow/vault views with risk context |
| `morpho_get_history` | `morpho.ts` | ✅ Strong | Statistical analysis (mean, stddev, max, min) — supports probabilistic reasoning |
| `morpho_list_vaults` | `morpho.ts` | ✅ Adequate | Enriched with Merkl campaigns, public allocator liquidity |

### New Emergence Patterns Added

#### 1. Incentive Sustainability Signals (Gap 2 fix)
**Location:** `src/formatters.ts:240-242` (LP APY), `src/formatters.ts:269-280` (IBT APR), `src/formatters.ts:1622` (scan output), `src/formatters.ts:2280` (scan opportunities)

When incentives exceed 50% of yield:
```
83% of IBT APR comes from incentives. Base yield alone: 2.41%
```

MetaVault dashboard (`metavault.ts:797-802`) flags at 70%:
```
[INCENTIVE] 97% of APY comes from incentive programs. Base yield is only 3.5%.
```

IBT health check (`ibt_health.ts:209`):
```
83% from incentives — yield may drop if program ends
```

**Assessment: Strong.** Three-layer signal (pool → scanner → health check) ensures agents encounter sustainability context regardless of entry point.

#### 2. Looping Failure Scenarios (Gap 7 fix)
**Location:** `src/tools/looping.ts:279-330`

- **Optimal ≤ 1 loop** (line 281-283): "Minimal looping benefit... Consider unleveraged PT yield instead."
- **Unprofitable** (line 284-287): "Looping is unprofitable at current rates... Unleveraged (0 loops) is optimal."
- **Break-even period** (line 291-303): Days to recover entry cost; warns when >50% of maturity.
- **Borrow rate sensitivity** (line 305-321): +1/+2/+3% stress table with "NEGATIVE" / "worse than unleveraged" labels.
- **Break-even rate** (line 317-320): Exact borrow rate where looping yields 0%.
- **30-day risk analysis** (line 332-442): Historical mean/stddev/max borrow rates, P(underwater) via normal CDF, 95th-percentile safety flag.

**Assessment: Excellent.** The probabilistic risk modeling (CDF-based P(underwater) per loop count) is a significant step beyond simple scenario tables. Directly addresses Q15 (Looping Risk).

#### 3. Risk Monitor — Scaffold Attention Pattern
**Location:** `src/tools/risk_monitor.ts:8-10`, `src/formatters.ts:3895-3920`

The risk monitor introduces a new emergence pattern: **"Considerations (not directives)"**

```
--- Considerations (not directives) ---
  - Critical positions may warrant immediate deleverage — but check if the
    collateral is approaching maturity (PT redeems at par)
  - Elevated positions could indicate normal operation at high leverage,
    or genuine risk — context matters
```

This is emergence-compliant: it presents risk signals without prescribing action, and explicitly notes that context (maturity proximity) can change the interpretation.

#### 4. Hyperliquid Funding Integration
**Location:** `src/api.ts:2194-2269`

Adds delta-neutral strategy signals via perp funding rates. The mapping function (`resolveHyperliquidSymbol`) is honest about coverage: only maps known DeFi tokens to perp symbols, returns `null` for unknowns rather than guessing.

#### 5. Pendle Logit AMM Impact Model
**Location:** Commit `fdebb50`

Replaced constant-product price impact model with Pendle's actual logit AMM formula. This reduces the face-value acceptance failure mode (Q37) by making impact estimates more accurate for Pendle pools.

---

## Emergence Pattern Audit (Updated)

### Strengths Preserved from v1

#### 1. Competing Interpretation Branches
**Location:** `src/formatters.ts` — `formatCycleAnalysis`, `formatFlowAccounting`

Still generating 2-3 lettered branches (A/B/C) per cycle pattern with "Do not collapse without external evidence" directive. The branches predict *different future behavior* — not decorative alternatives.

**Assessment: Still strong.** No regression detected.

#### 2. Observation Coverage Metrics
**Location:** `src/formatters.ts` — `formatObservationCoverage`

Three orthogonal dimensions (value, temporal, data source) plus boundary markers. Explicitly lists what is "invisible to this analysis."

**Assessment: Still strong.** No regression detected.

#### 3. Statistical Insufficiency Flagging
**Location:** `src/formatters.ts:642-643`

≤5 repetitions: "Insufficient to distinguish systematic strategy from coincidental sequence. Do not extrapolate."

**Assessment: Still strong.** No regression detected.

### Remaining Gaps

#### Gap 1 (Partial): Router Batching Per-Event Flags
**Status:** Address-level hints exist (`pool.ts:420-444`), but individual activity rows still lack a per-event `(Router-mediated)` tag.

**Current state:** The docstring (`pool.ts:191-217`) is comprehensive. The competing interpretation section references Router batching. But an agent processing activity entries line-by-line won't see a per-event flag.

**Impact:** Q9 (SELL_PT Interpretation) and Q23 (Router Limitation) — agents must read docstring + interpretation section, not just activity rows.

**Recommendation (unchanged):** Add a one-line note per BUY_PT/SELL_PT/AMM_ADD_LIQUIDITY entry: `"(may be Router-batched — see Competing Interpretations)"`

#### Gap 3 (Open): Liquidity Velocity/Trending
**Status:** No historical liquidity data available from the Spectra API.

**Current state:** Impact calculations use point-in-time liquidity snapshots. A pool losing liquidity shows the same impact estimate as one gaining liquidity.

**Recommendation:** If the API ever surfaces historical TVL/liquidity, compute 7d/30d delta. Until then, this is an API limitation, not a code gap. Consider marking it as "deferred — API dependency."

#### Gap 4 (Open): Cycle Detection Temporal Context
**Status:** No `lastOccurrenceTs` or staleness flag.

**Current state:** `detectActivityCycles()` still stitches cycles across temporal gaps. 3 cycles from 6 months ago + 3 cycles from yesterday = 6 cycles of the "same" pattern.

**Impact:** Q33 (Dark Periods) — the cycle detector doesn't distinguish stale from recent patterns.

**Recommendation:** Add `lastOccurrenceTs` and `firstOccurrenceTs` to `ActivityCycleResult`. Flag if most recent cycle is >30 days old: `"Pattern last observed N days ago — may no longer be active."` Flag if cycles span a gap >14 days: `"Pattern spans a {N}-day gap — pre-gap and post-gap occurrences may be unrelated."`

#### Gap 6 (Partial): Cross-Pool Temporal Correlation
**Status:** `spectra_get_address_activity` aggregates per-pool patterns but doesn't detect sequential capital flow.

**Current state:** If a wallet systematically exits Pool A then enters Pool B within 7 days, this pattern isn't flagged.

**Recommendation:** After collecting per-pool activity, check if exit timestamps on one pool cluster near entry timestamps on another. Flag as: `"Possible capital rotation: Pool A exit → Pool B entry within N days (observed K times)."` Present as a hypothesis, not conclusion.

---

## Cross-Tool Consistency Audit (Updated)

| Dimension | Consistent? | Notes |
|-----------|-------------|-------|
| **Yield composition** (base vs incentives) | ✅ Yes | All tools use `extractLpApyBreakdown()` + sustainability flag |
| **Price impact math** | ✅ Yes | Spectra: `estimatePriceImpact()`, Pendle: logit AMM model |
| **Boost calculation** | ✅ Yes | `computeSpectraBoost()` shared |
| **Maturity flagging** | ✅ Yes | `daysToMaturity()` with <14d/<30d tiers |
| **Warning system** | ✅ Yes | Warnings as arrays, never collapsed |
| **Competing branches** | ✅ Yes | `formatCycleAnalysis` + `formatFlowAccounting` |
| **Coverage metrics** | ✅ Yes | `formatObservationCoverage` in pool.ts |
| **Router awareness** | ⚠️ Partial | Docstrings + address-level hints; no per-event flag |
| **Incentive sustainability** | ✅ Yes | >50% flag in formatters, >70% flag in MetaVault dashboard |
| **Looping failure scenarios** | ✅ Yes | Minimal/unprofitable warnings, break-even, sensitivity table |
| **Risk signal framing** | ✅ Yes | New tools use "scaffolds attention, not action" pattern |
| **Merkl rewards** | ✅ Yes | `spectra_get_portfolio` fetches in parallel, matched + unmatched sections |

**Overall: Strong consistency with measurable improvement.** The new tools (risk_monitor, stress_test, rollover) follow the same emergence patterns as the original tools without requiring enforcement.

---

## Anomaly Detection Audit (Updated)

| Category | Implementation | Coverage | Change from v1 |
|----------|---------------|----------|----------------|
| **Extreme APY** | Tiered warnings in scan tools | ✅ Strong | Unchanged |
| **Tiny liquidity** | <$50K threshold flag | ✅ Strong | Unchanged |
| **Near maturity** | <14d (critical), <30d (caution) | ✅ Strong | Unchanged |
| **Negative effective APY** | Flagged when entry cost > yield | ✅ Strong | Unchanged |
| **IBT APR = 0** | Flagged as "possibly stale data" | ✅ Strong | Unchanged |
| **Break-even > maturity** | Flagged in YT arb + looping | ✅ Strong | **Extended to looping** |
| **High price impact** | >5% "HIGH", 1-5% "Moderate" | ✅ Strong | Unchanged |
| **Incentive dominance** | >50% in pools, >70% in MetaVaults | ✅ Strong | **NEW: 50% pool-level flag** |
| **Looping unprofitable** | Borrow > yield at all levels | ✅ Strong | **NEW** |
| **Liquidation proximity** | Health factor + distance-to-liquidation | ✅ Strong | **NEW** (risk_monitor) |
| **Borrow rate risk** | P(underwater) via 30d CDF | ✅ Strong | **NEW** (looping.ts) |
| **No aggregate anomaly score** | Individual flags only | ⚠️ Gap | Unchanged |
| **No incentive expiration** | Not tracked (API limitation) | ⚠️ Gap | Unchanged |
| **No liquidity trending** | Snapshot only (API limitation) | ⚠️ Gap | Unchanged |

---

## Alignment with AGENT-TESTS.md (Updated for 38 Questions)

| Tier | Tests | Alignment | Quality |
|------|-------|-----------|---------|
| **T1: Basic Tool Usage** (Q1-Q4) | Chains, yields, pools, MetaVaults | ✅ Direct tool responses | Strong |
| **T2: Cross-Tool Reasoning** (Q5-Q8) | Capital awareness, cross-protocol, looping, simulation | ✅ spectra_scan_opportunities, mv_compare_yield | Strong |
| **T3: Protocol Mechanics** (Q9-Q12) | Router batching, YT trading, PT/YT math, mint visibility | ✅ Competing branches + context tool | Strong |
| **T4: Risk & Nuance** (Q13-Q16) | MetaVault risk, extreme APY, looping risk, bridge activity | ✅ Incentive sustainability + looping failures | **Improved** |
| **T5: Multi-Step Analysis** (Q17-Q20) | Wallet strategy, veSPECTRA, YT arb vs LP, negative APY | ✅ Cross-reference workflow | Strong |
| **T6: Edge Cases** (Q21-Q25) | Katana RPC, expired pools, Router limitation, tool disagreement | ✅ Tool-specific edge handling | Strong |
| **T7: Yield Composition** (Q26-Q28) | APY decomposition, IBT APR, points programs | ✅ Sustainability signals | **Improved** |
| **T8: Open Emergence** (Q29-Q31) | Resist collapse, cycle extrapolation, multi-pool narrative | ✅ Competing branches + insufficiency flags | Strong |
| **T9: Observation Coverage** (Q32-Q34) | Value coverage, temporal gaps, data source coverage | ✅ formatObservationCoverage | Strong |
| **T10: Reward Completeness** (Q35) | Merkl rewards in PnL | ✅ Parallel Merkl fetch | Strong |
| **T11: Newcomer Comprehension** (Q36-Q38) | Deposit path, impact accuracy, tool selection | ✅ Protocol context + conservative estimate callout | Strong |

---

## New Observations (Not in v1)

### 1. Emergence Scales Without Enforcement
The 22 commits since v1 added 14+ new tools and significant feature surface without degrading emergence patterns. New tools independently adopt "scaffold attention, not action," competing branches, and coverage quantification. This suggests the architecture is self-documenting — contributors read existing patterns and follow them.

### 2. Risk Monitor Sets a New Standard
`morpho_monitor_risk` introduces the "Considerations (not directives)" pattern, which is a cleaner version of competing interpretations for risk-oriented tools. This pattern should be adopted by future risk tools.

### 3. Probabilistic Risk is a Step Change
The looping tool's P(underwater) via normal CDF on 30-day history (`looping.ts:380-389`) moves beyond scenario tables into probabilistic reasoning. This is the right direction — agents can use probability to size recommendations rather than making binary safe/unsafe calls.

### 4. Curator Portfolio Lacks Emergence (Acceptable)
`curator_portfolio.ts` is a pure aggregation tool (AUM, blended APY, concentration). It has no competing interpretations because it's factual, not interpretive. This is appropriate — not every tool needs competing branches. Emergence applies to *interpretive* tools, not data aggregation.

---

## Test Coverage Gaps

The test infrastructure is strong (192 unit, 82 agent, 405 integration, 38 subjective = 717 total) but has specific gaps in emergence pattern testing:

| Gap | Location | Impact | Recommendation |
|-----|----------|--------|----------------|
| No unit tests for `formatObservationCoverage()` | `formatters.ts:1298-1441` | Regression risk if refactored; coverage dimensions (value%, temporal%, source%) untested | Add 4-6 tests covering boundary conditions (0%, 50%, 100% coverage) |
| No explicit test for statistical insufficiency threshold | `formatters.ts:642-643` | The "Do not extrapolate" ≤5 threshold is only implicitly tested via `detectActivityCycles` | Add dedicated test verifying warning text appears at N=5, absent at N=6 |
| No agent test for observation coverage reporting | `test-agent.cjs` | Agents may treat incomplete coverage as complete without explicit flags | Add `testObservationCoverageReporting()` |
| No agent test for insufficient evidence preservation | `test-agent.cjs` | Sparse activity (<5 events) should still appear with insufficiency warning | Add `testInsufficientEvidencePreservation()` |

**Note:** The `formatFlowAccounting` mixed PT/YT case (lines 1252-1263) doesn't enumerate explicit A/B/C branches like other position shapes. Minor inconsistency — ratio analysis is adequate but less structured than YT-only or PT-only cases.

---

## Recommendations (Priority Order)

### P1 (Should do)

1. **Add temporal context to cycle detection** (Gap 4) — `lastOccurrenceTs` + gap detection. Most impactful remaining gap for Q33 (Dark Periods). Prevents agents from stitching stale patterns.

2. **Add per-event Router notes** (Gap 1) — One-line `(may be Router-batched)` on BUY_PT/SELL_PT/AMM_ADD_LIQUIDITY rows. Reduces agent cognitive load.

3. **Close test coverage gaps** — Add unit tests for `formatObservationCoverage()` and statistical insufficiency threshold. Add agent tests for coverage reporting and insufficient evidence preservation.

### P2 (Nice to have)

4. **Cross-pool temporal correlation** (Gap 6) — Detect sequential capital movement across pools. Present as hypothesis.

5. **Incentive expiration tracking** — If Merkl API exposes campaign end dates, surface them. Currently blocked on API data availability.

### P3 (Defer)

6. **Liquidity trending** (Gap 3) — Blocked on API not providing historical liquidity snapshots. Mark as API-dependent.

7. **Aggregate anomaly score** — Individual flags work well; aggregation risks false confidence in a single number.

---

## Files Modified in This Audit

None — this is a review-only audit. No code changes required.

---

## Appendix: Commits Since v1 Audit

```
14f7485 Fix 18 findings from DeFi curator strategy review
6f301f6 Add rollover planner, curator portfolio, and performance metrics
a6a9622 Add withdrawal stress test and borrow rate risk analyzer
72e52bc Add curator_risk_monitor tool for Morpho liquidation distance monitoring
592c7d6 Add Morpho Public Allocator reallocatable liquidity to market data
f7636d7 Add Morpho Phase 2+3: vault enrichment, user positions, historical rates
aebfb04 Add Merkl campaign APR integration across Spectra and Pendle tools
e21dc7e Fix Morpho market key truncation and extend Merkl rewards to Morpho positions
c595447 Add Morpho supply-side visibility: vault discovery, market suppliers, reward incentives
22a56e1 Close Pendle display gaps: LP breakdown, underlying parsing, tags, SY address
8193220 Add Pendle SY exchangeRate() fallback and improve Pendle strategy guidance
66178ec Extend check_ibt_health with direct ERC-4626 mode for Pendle SY tokens
76d97c7 Add newcomer UX improvements and impact accuracy callouts
041cbb4 Add Hyperliquid perp funding rates for delta-neutral strategy signals
26316e2 Add hypothetical loop projections for PTs without Morpho markets
b8e5fb9 Replace Best: tag with Strategy Space building blocks in curator scanner
fdebb50 Use Pendle logit AMM model for price impact instead of constant-product
9484988 Rank curator scanner by best strategy (LP/PT/loop), not just PT APY
65a98ae Fix Pendle error handling, MetaVault detection, RPC fallbacks, and add Pendle tests
2cd4c87 Add blended MetaVault modeling, dashboard protocol tags, and cross-protocol pointers
7335051 Add cross-protocol curator scanner and maturity-aware matching
59f236a Add incentive sustainability signals and looping failure scenarios
```
