# Roaming Audit Spec — Five Archetypes, Ten Findings

*April 6, 2026. Five agents called the live tools, not read the code. This is what they found.*

## Tier 1: FORGE NOW (safety)

### 1. Maturity gate on looping tools
**Found by:** Breaker (38.8% APY on 2-day position, zero warning)
**Files:** `src/tools/looping.ts`, `src/tools/pendle_looping.ts`
**Fix:** When days-to-maturity < 14, emit a hard warning at TOP of output. Compute absolute return over remaining life (not just annualized). "12.95% annualized over 2 days = 0.07% actual return. Gas will consume this."

### 2. Clip utilization ceiling to 100%
**Found by:** Hunter (calibration shows 104.29% utilization anomaly threshold)
**Files:** `src/tools/calibration.ts` — the `buildMetric()` function
**Fix:** In anomaly threshold computation, clip `high` to domain max (100% for utilization, 0% floor for rates). One line: `Math.min(highThreshold, domainMax)`.

### 3. Health check: skipped = UNKNOWN, not OK
**Found by:** Inverter (conversion rate skipped but marked OK)
**Files:** `src/tools/ibt_health.ts`
**Fix:** When on-chain read fails/skips, the check verdict should be "UNKNOWN" not "OK". The overall verdict should reflect uncertainty, not safety.

## Tier 2: FORGE SOON (integrity)

### 4. Scanner: suppress negative effective APY
**Found by:** Hunter (-1080% effective APY ranked), Inverter (#1 rank loses money)
**Files:** `src/tools/strategy.ts`, `src/formatters.ts`
**Fix:** When effective APY is negative, either exclude from ranking or add bold inline warning: "⚠ NEGATIVE effective APY — entry cost exceeds yield at this capital size."

### 5. Gas rationality floor
**Found by:** Breaker ($1 scan on mainnet, no warning)
**Files:** `src/tools/strategy.ts`, `src/tools/pendle_scanner.ts`
**Fix:** When capital_usd < estimated gas cost for the chain (~$50 mainnet, ~$1 L2), warn: "Position size below estimated gas cost on this chain."

### 6. Calibration subsidy context
**Found by:** Connector (0.74% "NORMAL" borrow rate is actually -9.26% with Merkl)
**Files:** `src/tools/calibration.ts`
**Fix:** After computing baselines, check for active Merkl campaigns on the target. If found, add: "Active Merkl campaigns affect this market. Baselines reflect subsidized conditions."

## Tier 3: FORGE LATER (depth)

### 7. Workflow routing update
**Found by:** Connector (5 newest tools missing from workflow_routing topic)
**Files:** `src/tools/context.ts`
**Fix:** Add mv_get_calibration, mv_get_position_map, spectra_get_gauge_votes, pendle_get_market_history, merkl_list_campaigns to workflow routing.

### 8. Gauge zombie filtering
**Found by:** Connector (expired pools dominate gauge rankings), Sentinel (Dec 2024 snapshot)
**Files:** `src/tools/gauge_votes.ts`
**Fix:** Cross-reference gauge pool addresses against active pools. Filter or demote expired gauges.

### 9. Calibration maturity awareness
**Found by:** Connector (13-day pool gets same treatment as 180-day)
**Files:** `src/tools/calibration.ts`
**Fix:** Detect days-to-maturity for Spectra/Pendle targets. Near maturity: compress percentile bands, note convergence behavior.

### 10. Supplier cascade modeling
**Found by:** Inverter (51% EOA concentration, no withdrawal scenario)
**Files:** `src/tools/morpho.ts` (market_suppliers section)
**Fix:** When top supplier > 40%, compute: "If this supplier exits, available liquidity drops to $X, utilization spikes to Y%, borrow rate projects to Z%."

---

*The tools tell the truth. They just don't tell the story. These fixes add the story.*
