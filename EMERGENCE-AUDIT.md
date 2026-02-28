# Spectra MCP Server — Open Emergence Audit

**Date:** 2026-02-28
**Scope:** Emergence patterns, observation coverage, competing interpretations, anomaly detection, cross-tool consistency
**Auditor:** Claude (deep audit aligned with AGENT-TESTS.md Tiers 8-10)

---

## Executive Summary

The Open Emergence design is **the strongest architectural feature of this codebase**. The three-layer model (data fetching → structural pattern detection → coverage & boundary communication) is well-implemented and internally consistent across tools. Competing interpretation branches, observation coverage metrics, and statistical insufficiency flags work as designed.

The audit found **5 stale unit tests** (now fixed), **7 emergence pattern gaps** where ambiguity preservation should exist but doesn't, and **3 strengths** worth preserving as the codebase evolves.

### Test Results (this environment)

| Suite | Pass | Fail | Skip | Notes |
|-------|------|------|------|-------|
| **Unit** (165) | **165** | **0** | 0 | All pass after fixes |
| **Integration** (~186) | 139 | 33 | 14 | Failures are network-only (Morpho/Pendle API unreachable, RPC blocked, 120s global timeout) |
| **Agent** (48) | 18 | 13 | 17 | Same network issues; protocol context tests all pass |

No code-level bugs found in this audit. All integration/agent failures trace to external API connectivity in the sandbox environment.

---

## Stale Tests Fixed (5 failures → 0)

The unit tests for `formatCycleAnalysis` and `formatFlowAccounting` were written for the **pre-emergence single-narrative format** but the implementations were rewritten with Open Emergence (competing branches). The tests expected:

| Test | Expected (old) | Actual (new) | Fix |
|------|---------------|--------------|-----|
| `formatCycleAnalysis` ADD→REMOVE→SELL | `"mint→LP→unwind→sell"` (lowercase m) | `"Mint→LP→unwind→sell"` | Case match |
| `formatCycleAnalysis` SELL_PT-only | `"flash-mint"` or `"PT dumping"` | `"Flash-mint"` or `"PT liquidation"` | Case + wording match |
| `formatCycleAnalysis` BUY_PT-only | `"PT accumulation"` or `"flash-redeem"` | `"Fixed-rate accumulation"` or `"Flash-redeem"` | Wording + case match |
| `formatFlowAccounting` YT-only | `"yield-directional"` | `"Position Shape: YT-only"` + `"Competing Hypotheses"` | Updated to verify emergence pattern |
| `formatFlowAccounting` YT/PT ratio | `"YT/PT ratio: 20.0:1"` | `"YT/PT 20.0:1"` + `"Heavily YT-weighted"` | Updated to match current format |

**Root cause:** Tests were not updated when the formatters were refactored from single-narrative to competing-branch output. The intent of the tests (verify interpretive content is present) is preserved in the fixes.

---

## Emergence Pattern Audit

### What's Working Well

#### 1. Competing Interpretation Branches (`formatCycleAnalysis`, `formatFlowAccounting`)
**Location:** `src/formatters.ts:624-689` (cycles), `src/formatters.ts:783-818` (position shapes)

The implementation covers 5 cycle pattern combinations, each generating 2-3 lettered branches (A/B/C) with explicit behavioral predictions. Branches are presented with equal weight and a directive not to collapse without external evidence. This directly addresses AGENT-TESTS.md Q29 (Resist Premature Collapse) and Q30 (Cycle Extrapolation).

**Assessment: Strong.** The branches predict *different future behavior* — this makes them testable by agents rather than decorative.

#### 2. Observation Coverage Metrics (`formatObservationCoverage`)
**Location:** `src/formatters.ts:846-989`

Three orthogonal dimensions (value coverage, temporal coverage, data source coverage) plus an activity-type diversity signal. The horizontal-line boundary marker at line 983 creates a visual/semantic separator between analysis and limitations.

**Assessment: Strong.** Directly addresses Q32 (Confidence Calibration) and Q34 (Tool Sufficiency). The explicit "invisible to this analysis" callout prevents the tool sufficiency illusion failure mode.

#### 3. Statistical Insufficiency Flagging
**Location:** `src/formatters.ts:642-643`

Cycle count ≤5 triggers: `"⚠ N repetitions observed. Insufficient to distinguish systematic strategy from coincidental sequence. Do not extrapolate."`

**Assessment: Strong.** Directly addresses Q30. The "Do not extrapolate" directive is correctly phrased as a constraint, not a suggestion.

### Emergence Gaps

#### Gap 1: Router Batching Awareness Is Implicit, Not Explicit
**Location:** `src/tools/pool.ts:189-217` (docstring), `src/tools/pool.ts:428-445` (inline hints)

Router batching is explained in natural language scattered across docstrings and hints, but there is no structured flag in the activity output distinguishing "direct pool event" from "possible side-effect of Router batch." An agent parsing activity entries gets BUY_PT/SELL_PT without a `router_batched: "possible"` signal.

**Impact on AGENT-TESTS.md:** Q9 (SELL_PT Interpretation) and Q23 (Router Limitation) require agents to infer Router involvement from context. Agents that read activity line-by-line without the docstring may miss this.

**Recommendation:** Add a one-line note per activity entry when the event type is commonly Router-mediated (SELL_PT, BUY_PT, AMM_ADD_LIQUIDITY): `"(Note: may be one step of a Router-batched operation — see Competing Interpretations above)"`

#### Gap 2: No Incentive Sustainability Analysis
**Location:** All yield tools decompose APR into base + incentives, but none assess incentive *durability*.

The tools correctly flag when incentives > 70% of MetaVault APY (metavault.ts line ~296-301). But there's no check for:
- Incentive program expiration dates
- Reward pool depletion velocity
- Historical incentive rate trending

**Impact on AGENT-TESTS.md:** Q26 (Yield Composition Reasoning) asks "Is it sustainable?" The tools surface the *what* (97% from KAT incentives) but not the *how long*.

**Recommendation:** If the API surfaces reward program metadata (duration, remaining allocation), include it. If not, add a standard caveat: `"Incentive programs can end without notice. Base APY alone would be X%."`

#### Gap 3: No Liquidity Velocity/Trending
**Location:** `estimatePriceImpact()` uses current liquidity snapshot only.

A pool showing $500K liquidity could have grown from $100K (positive) or declined from $5M (negative). Both produce identical impact calculations.

**Impact on AGENT-TESTS.md:** Q14 (Extreme APY Skepticism) benefits from liquidity context. A pool with declining liquidity + extreme APY is a stronger anomaly signal.

**Recommendation:** If historical liquidity snapshots are available, show 7d/30d trend alongside current value.

#### Gap 4: Cycle Detection Lacks Temporal Context
**Location:** `detectActivityCycles()` at `src/formatters.ts:564-614`

Cycles are detected purely by action-type sequence, without considering *when* they occurred. 3 cycles from 6 months ago are treated identically to 3 cycles from yesterday. There's no stability or recency weighting.

**Impact on AGENT-TESTS.md:** Q33 (Dark Periods) tests whether agents treat temporal gaps as meaningful boundaries. The cycle detector will stitch pre-gap and post-gap cycles into one pattern if the sequence matches.

**Recommendation:** Add a `lastOccurrenceTs` field to `ActivityCycleResult` and flag if the most recent cycle is older than 30 days: `"Pattern last observed N days ago — may no longer be active."`

#### Gap 5: Flow Accounting Confidence Is Binary, Not Quantitative
**Location:** `src/formatters.ts:747-752`

Confidence is either "moderate" (no BUY_PT) or "low" (BUY_PT present). No numeric score or gradient.

**Impact:** Agents that size conviction to evidence quality (Q32) have only two settings: moderate/low. A "40% confidence" signal would be more actionable than "low."

**Recommendation:** Not critical — the binary signal is honest about what it knows. A numeric score might imply false precision.

#### Gap 6: No Cross-Pool Temporal Correlation in Address Activity
**Location:** `src/tools/pool.ts:717-953` (`get_address_activity`)

The function scans all chains for an address but doesn't analyze *temporal sequencing* between pools. If an address systematically moves capital Pool A → Pool B → Pool C in sequence, this pattern isn't detected.

**Impact on AGENT-TESTS.md:** Q31 (Multi-Pool Strategy) asks whether agents force a single narrative. The tool correctly shows per-pool patterns separately, but doesn't flag sequential capital movement.

**Recommendation:** If timestamps show clear sequential flow (Pool A activity ends → Pool B activity starts within 7 days), note it as a possible capital rotation.

#### Gap 7: No Looping Failure Scenarios
**Location:** `src/tools/strategy.ts` (scan_opportunities), `src/tools/looping.ts`

Looping calculates optimal loop count and net APY, but doesn't model:
- Liquidation risk if PT price drops
- What happens when optimal loops = 1 (looping provides no benefit, only complexity)
- Break-even period for cumulative entry costs

**Impact on AGENT-TESTS.md:** Q15 (Looping Risk) asks about borrow rate spikes. The tool shows the math but doesn't model the downside scenario.

**Recommendation:** When optimal_loops = 1, add: `"Looping does not improve yield at current rates. Consider unlevered PT instead."` When net APY < 2%, add borrow rate sensitivity note.

---

## Cross-Tool Consistency Audit

| Dimension | Consistent? | Notes |
|-----------|-------------|-------|
| **Yield composition** (base vs incentives) | ✅ Yes | All tools use `extractLpApyBreakdown()` |
| **Price impact math** | ✅ Yes | All tools use `estimatePriceImpact()` |
| **Boost calculation** | ✅ Yes | All tools use `computeSpectraBoost()` |
| **Maturity flagging** | ✅ Yes | All tools use `daysToMaturity()` with <14d/<30d tiers |
| **Warning system** | ✅ Yes | Warnings collected as arrays, never collapsed |
| **Competing branches** | ✅ Yes | `formatCycleAnalysis` + `formatFlowAccounting` use same A/B/C pattern |
| **Coverage metrics** | ✅ Yes | `formatObservationCoverage` consistently applied in pool.ts |
| **Router awareness** | ⚠️ Partial | Docstrings explain; inline hints use "could be" language; but no per-event flag |

**Overall: Strong consistency.** The shared utility functions ensure that the same pool shows identical numbers whether accessed via `scan_opportunities`, `compare_yield`, or `get_pt_details`.

---

## Anomaly Detection Audit

| Category | Implementation | Coverage |
|----------|---------------|----------|
| **Extreme APY** | Tiered warnings in scan tools | ✅ Strong |
| **Tiny liquidity** | <$50K threshold flag | ✅ Strong |
| **Near maturity** | <14d (critical), <30d (caution) | ✅ Strong |
| **Negative effective APY** | Flagged when entry cost > yield | ✅ Strong |
| **IBT APR = 0** | Flagged as "possibly stale data" | ✅ Strong |
| **Break-even > maturity** | Flagged in YT arb scanner | ✅ Strong |
| **High price impact** | >5% "HIGH", 1-5% "Moderate" | ✅ Strong |
| **Incentive dominance** | >70% flagged in MetaVaults | ✅ Strong |
| **No aggregate anomaly score** | Individual flags only | ⚠️ Gap |
| **No incentive expiration** | Not tracked | ⚠️ Gap |
| **No liquidity trending** | Snapshot only | ⚠️ Gap |

---

## Alignment with AGENT-TESTS.md

The emergence patterns directly address the hardest test tiers:

| Tier | Tests | Alignment |
|------|-------|-----------|
| **Tier 8: Open Emergence** (Q29-Q31) | Competing branches, resist premature collapse, multi-pool narrative resistance | ✅ Competing Interpretations (A/B/C) in formatCycleAnalysis + formatFlowAccounting |
| **Tier 9: Observation Coverage** (Q32-Q34) | Value coverage, temporal gaps, data source coverage, tool sufficiency | ✅ formatObservationCoverage with 3 orthogonal dimensions + boundary markers |
| **Tier 10: Reward Completeness** (Q35) | Merkl rewards in PnL analysis | ✅ get_portfolio fetches Merkl in parallel, matched + unmatched sections |

The server's output is well-designed to produce **A+ grades** on the AGENT-TESTS.md rubrics — *if the consuming agent reads the structured output faithfully*. The primary failure mode is agent-side: seeing competing branches and collapsing to one.

---

## Recommendations (Priority Order)

1. **Keep the test suite aligned with output format** — the 5 stale tests fixed in this audit show that formatter refactors can silently break test assertions. Consider adding a meta-test that verifies key strings in competing branch output haven't changed.

2. **Add per-event Router awareness notes** — a one-line `(Router-mediated)` tag on SELL_PT/BUY_PT/ADD_LIQUIDITY events would reduce the cognitive load for agents that process activity entry-by-entry.

3. **Surface incentive sustainability context** — even a simple "Base APY alone: X%" line next to incentive-dominated yields would help agents answer sustainability questions.

4. **Add temporal context to cycle detection** — `lastOccurrenceTs` + staleness flag would prevent agents from treating old patterns as current.

5. **Model looping downsides** — when optimal_loops = 1 or net APY is thin, say so explicitly.

---

## Files Modified

- `src/formatters.test.ts` — Fixed 5 stale unit tests to match Open Emergence output format
