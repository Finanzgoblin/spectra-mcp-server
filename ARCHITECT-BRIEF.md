# Architect Brief: MetaVault Curator Risk Management Layer

**Date:** 2026-03-06
**From:** Strategy Review
**To:** Engineering Architect
**Context:** Building a curator-as-a-service business on Spectra MetaVaults. The MCP server tooling handles deal origination and modeling well. This document specifies the **post-deployment risk management layer** that needs to be built.

---

## Current Architecture (What Exists)

The Spectra MCP server is a TypeScript MCP (Model Context Protocol) server exposing ~25 tools to an LLM agent. Tools are registered in `src/tools/*.ts`, share helpers via `src/api.ts` (API calls), `src/formatters.ts` (output formatting), `src/config.ts` (chain config), and `src/types.ts` (type definitions).

### Existing Curator-Specific Tools

| Tool | File | Purpose |
|------|------|---------|
| `get_metavaults` | `src/tools/metavault.ts` | Discovery: list live MetaVaults across chains with APY, TVL, positions |
| `model_metavault_strategy` | `src/tools/metavault.ts` | Modeling: double-loop economics (MV share looping + dual Morpho markets) |
| `get_curator_dashboard` | `src/tools/metavault.ts` | Monitoring: vault health, position maturity, epoch flows, action items |
| `scan_curator_opportunities` | `src/tools/curator_scan.ts` | Sourcing: cross-protocol Spectra + Pendle scanner with Morpho looping |

### Supporting Tools (Curator-Relevant)

| Tool | File | Purpose |
|------|------|---------|
| `check_ibt_health` | `src/tools/ibt_health.ts` | Pre-deployment IBT due diligence (conversion rate, APR composition) |
| `get_pool_capacity` | `src/tools/capacity.ts` | Quote ladder: impact at increasing capital sizes |
| `get_looping_strategy` | `src/tools/looping.ts` | PT + Morpho leverage table with sensitivity analysis |
| `get_morpho_positions` | `src/tools/morpho.ts` | User's Morpho positions with health factor |
| `get_morpho_rate` | `src/tools/morpho.ts` | Live borrow rate + supplier analysis for a specific market |
| `get_morpho_history` | `src/tools/morpho.ts` | Historical rate/utilization time series |
| `get_morpho_market_suppliers` | `src/tools/morpho.ts` | Lending side concentration analysis |
| `get_ve_info` | `src/tools/ve.ts` | veSPECTRA boost computation |

### Data Flow Architecture

```
Spectra API (app.spectra.finance/api/v1/)
    ├─ Pool data, PT data, MetaVault data, portfolio
    └─ fetchSpectra() in src/api.ts

Morpho GraphQL API
    ├─ Markets, positions, vaults, history
    └─ findMorphoMarketsForPts(), etc. in src/api.ts

Pendle API
    ├─ Markets across chains
    └─ scanAllPendleMarkets() in src/api.ts

On-chain RPC
    ├─ Curve get_dy() quotes, ERC-4626 convertToAssets(), veSPECTRA totalSupply
    └─ Various fetch* functions in src/api.ts

Merkl API
    ├─ External incentive campaigns
    └─ fetchMerklCampaigns() in src/api.ts

Hyperliquid API
    ├─ Funding rates for delta-neutral signals
    └─ fetchHyperliquidFunding() in src/api.ts
```

### Key Patterns in Existing Code

1. **Best-effort parallel fetching** — Multiple API calls via `Promise.allSettled`, failures don't block the response
2. **Formatter separation** — Business logic in tool files, all output formatting in `src/formatters.ts`
3. **Network resolution** — `resolveNetwork()` maps user-facing names to API network names
4. **Capital-aware metrics** — Price impact, effective APY, capacity all scaled to user's capital
5. **Type-safe tool registration** — Zod schemas for parameters, TypeScript interfaces in `src/types.ts`

---

## What Needs to Be Built

Seven new capabilities, ordered by priority. P0 items should block scaling external deposits.

---

### P0-A: Liquidation Distance Monitor

**Problem:** The curator runs leveraged Morpho positions (PT collateral + MV share collateral). Current tools show health factor as a snapshot but don't compute liquidation price, distance-to-liquidation, or rate-driven margin erosion.

**Why it matters:** In November 2025, multiple curated vaults hit 100% utilization with no withdrawal liquidity due to cascading liquidations from collateral de-pegs and oracle failures ([source](https://www.cryptopolitan.com/risk-curators-took-off-in-2025-but-led-to-recent-defi-lending-vault-troubles/)). Morpho Blue has no close factor — when health factor reaches 1.0, the **entire position can be liquidated in one transaction** ([Morpho Docs: Liquidation](https://docs.morpho.org/learn/concepts/liquidation/)). The liquidator receives a ~5% bonus at 86% LLTV.

**Approach:** New tool `curator_risk_monitor` in `src/tools/risk_monitor.ts`.

**Inputs:**
- `address` (required) — curator wallet address
- `chain` (optional) — omit to scan all Morpho-capable chains
- `alert_threshold_pct` (default 15) — warn when distance-to-liquidation drops below this %

**Logic:**

1. Fetch all Morpho positions for the address via the existing Morpho GraphQL API (same endpoint as `get_morpho_positions`)
2. For each borrowing position:
   - Extract: collateral amount, collateral price (from oracle), debt amount, LLTV
   - Compute `health_factor = (collateral_value * LLTV) / debt_value`
   - Compute `liquidation_price = (debt_value / (collateral_amount * LLTV))`
   - Compute `distance_to_liquidation_pct = (1 - (current_price / liquidation_price)) * 100` (for PT collateral, this is PT price drop tolerance)
   - If position has variable borrow rate: compute `margin_erosion_rate` = how fast the borrow cost is eating into the yield buffer
3. Cross-reference with MetaVault data: tag positions that belong to MetaVault operations (match collateral asset to known PT addresses or MV share addresses)
4. Fetch current borrow rates via `get_morpho_rate` logic and compare to the rate at optimal loop entry (from `model_metavault_strategy` assumptions)
5. Generate alerts for positions where:
   - Health factor < 1.3 (standard Morpho warning threshold)
   - Distance-to-liquidation < `alert_threshold_pct`
   - Borrow rate has increased >2% since entry assumption
   - Position is in the Morpho pre-liquidation zone (if preLLTV is set — see [Morpho Pre-Liquidation](https://docs.morpho.org/build/borrow/concepts/preliquidation))

**Output format:**
```
--- Curator Risk Monitor: 0x...curator ---
  Chain: base
  Active Morpho positions: 4

  Position 1: PT-ibUSDC / USDC (Market A — external looping)
    Collateral: 150,000 PT-ibUSDC ($142,500)
    Debt: $105,000 USDC
    LLTV: 86%  |  Health Factor: 1.17
    Liquidation PT Price: $0.812 (current: $0.950)
    Distance to Liquidation: 14.5% ⚠️ [BELOW THRESHOLD]
    Borrow Rate: 4.2% (entry assumption: 2.8%, +1.4% drift)
    Pre-Liquidation: Not opted in

  Position 2: MV-ibUSDC / USDC (Market B — curator leverage)
    ...

  ALERTS:
    [⚠️ MARGIN] Position 1 distance-to-liquidation (14.5%) below 15% threshold
    [📈 RATE DRIFT] Position 1 borrow rate +1.4% above entry assumption
    [💡 ACTION] Consider: reduce leverage by 1 loop, or opt into Morpho Pre-Liquidation
```

**Dependencies:** Existing Morpho GraphQL queries in `src/api.ts`. May need a new query to fetch oracle price data for the collateral asset (check if `market.oracle.price` is available in the current Morpho API response).

**Morpho Pre-Liquidation context:** Morpho now offers an opt-in [Auto-Deleverage mechanism](https://morpho.org/blog/introducing-pre-liquidations-enhanced-loan-management-on-morpho/) where partial liquidations happen at a lower threshold (preLLTV) before the full LLTV is hit. The tool should detect if the curator has opted in and show the pre-liquidation zone boundaries. This is relevant because it reduces the "cliff risk" of full liquidation. Contract source: [github.com/morpho-org/pre-liquidation](https://github.com/morpho-org/pre-liquidation).

**Estimation:** ~2-3 days. Most data is already queryable; the main work is the liquidation math and alert logic.

---

### P0-B: Withdrawal Stress Test

**Problem:** MetaVaults use [ERC-7540](https://eips.ethereum.org/EIPS/eip-7540) async redemptions. Depositors request redemption in one epoch; the curator must fulfill it by the next. If the vault can't generate liquidity fast enough, redemptions fail and depositors are trapped. This is the exact scenario that [killed Stream Finance in 2025](https://www.cryptopolitan.com/risk-curators-took-off-in-2025-but-led-to-recent-defi-lending-vault-troubles/) and caused [Gauntlet to pause withdrawals on a Compound vault](https://chorus.one/reports-research/defi-curators-in-2025-navigating-chaos-building-resilience).

**ERC-7540 key constraint:** The standard explicitly does not include a `cancelRequest` mechanism — once a depositor requests redemption, the vault must fulfill it. There is no "sorry, try again later." See [ERC-7540 spec](https://eips.ethereum.org/EIPS/eip-7540) and [audit considerations](https://www.quillaudits.com/research/rwa-development/relevant-standards/erc-7540-async-erc-4626-tokenized).

**Approach:** New tool `stress_test_vault` in `src/tools/stress_test.ts`.

**Inputs:**
- `chain` (required)
- `metavault_address` (required)
- `redemption_pct` (default 30) — % of TVL redeemed in one epoch
- `market_stress` (default false) — if true, assume 2x normal price impact on LP exits

**Logic:**

1. Fetch MetaVault data (same as `get_curator_dashboard`)
2. Build the **liquidity waterfall** — sources of cash to meet redemptions, ordered by cost:
   - **Tier 1: Idle capital** — undeployed cash in the vault (no cost)
   - **Tier 2: Naturally maturing positions** — positions expiring within the current epoch window (no cost, but time-dependent)
   - **Tier 3: LP removal** — remove liquidity from Spectra Curve pools. Cost = price impact from `get_pool_capacity` logic at the redemption amount. Use `buildQuoteFromPt` or on-chain `get_dy()` to estimate exit impact.
   - **Tier 4: PT sale** — sell PT tokens on the Curve pool. Higher impact than LP removal. Quote using existing `tryOnChainQuote` from `src/tools/quote.ts`.
   - **Tier 5: Morpho deleverage** — unwind Morpho loops. Cost = borrow repayment + any slippage on collateral liquidation.
3. For each tier, compute:
   - Available liquidity (USD)
   - Expected cost/loss to remaining depositors (% of remaining TVL)
   - Cumulative coverage (does the waterfall reach the redemption amount?)
4. If `market_stress=true`: apply 2x multiplier to all price impact estimates (simulates correlated sell pressure)
5. Compute the **maximum safe redemption** — largest single-epoch redemption the vault can meet with <1% loss to remaining depositors

**Output format:**
```
--- Withdrawal Stress Test ---
  MetaVault: MV-ibUSDC (base)
  TVL: $2,100,000  |  Scenario: 30% redemption ($630,000)

  Liquidity Waterfall:
    Tier 1 — Idle Capital:        $180,000 (covers 28.6%)  |  Cost: $0
    Tier 2 — Maturing Positions:  $0 (no positions maturing within epoch)
    Tier 3 — LP Removal:          $400,000 available  |  Est. impact: 0.8% ($3,200)
    Tier 4 — PT Sale:             $200,000 available  |  Est. impact: 2.1% ($4,200)
    Tier 5 — Morpho Deleverage:   Not applicable (no active loops)

  Coverage: $780,000 available vs $630,000 needed ✅ COVERED
  Total cost to remaining depositors: $7,400 (0.50% of remaining TVL)

  Maximum Safe Redemption (< 1% loss): 38% of TVL ($798,000)

  Under market stress (2x impact):
    Coverage: $780,000 available vs $630,000 needed ✅ COVERED
    Total cost to remaining depositors: $14,800 (1.01% of remaining TVL) ⚠️ BORDERLINE
    Maximum Safe Redemption (< 1% loss): 32% of TVL ($672,000)
```

**Key design decisions:**
- LP removal impact should use the **same constant-product model** as `scan_opportunities` for consistency, with optional on-chain quotes for precision
- Pendle position exits need a different model (no Curve pool) — use Pendle AMM impact estimate from `estimatePendlePriceImpact` in `src/formatters.ts`
- Cross-chain positions (e.g., Base vault → Avalanche pool) add bridge latency — flag these as unavailable within a single epoch

**Dependencies:** `fetchMetavaults`, `buildQuoteFromPt`, `tryOnChainQuote`, `estimatePriceImpact`, `estimatePendlePriceImpact` — all existing.

**Estimation:** ~3-4 days. The waterfall logic is the novel part; individual tier computations reuse existing primitives.

---

### P1-A: Position Rollover Planner

**Problem:** When a MetaVault position approaches maturity, the curator must: (1) identify the next pool, (2) estimate transition costs, (3) time the entry, (4) execute the rollover. The dashboard warns about expiry but doesn't help with steps 1-3.

**Approach:** New tool `plan_rollover` in `src/tools/rollover.ts`.

**Inputs:**
- `chain` (required)
- `metavault_address` (required)
- `pt_address` (optional) — specific position to roll. If omitted, plans for all positions expiring within 30 days.
- `target_underlying` (optional) — override underlying asset filter
- `capital_usd` (optional) — override position size for impact calculation

**Logic:**

1. Fetch MetaVault data, identify expiring positions
2. For each expiring position:
   - Determine current allocation size (from dashboard logic)
   - Run `scan_curator_opportunities` filtered to the same underlying asset
   - For each candidate:
     - Compute entry impact at the position's capital size
     - Check maturity overlap: can the new position be entered *before* the old one matures?
     - Compute yield gap: days between old maturity and new position entry
     - If Morpho looping is available: include looping economics
3. Rank candidates by: effective APY (accounting for entry cost + yield gap)
4. For maturity overlap candidates: compute the cost of running both positions simultaneously (double capital requirement for overlap period)

**Output:** Per expiring position: ranked list of rollover candidates with entry impact, yield gap, overlap window, and net effective APY after transition costs.

**Dependencies:** Reuses `scan_curator_opportunities` logic internally. The main new code is the overlap/gap calculation and the integration with dashboard position data.

**Estimation:** ~2-3 days.

---

### P1-B: Borrow Rate Risk Analyzer

**Problem:** `get_looping_strategy` shows sensitivity at fixed rate deltas (+1/+2/+3%). `get_morpho_history` shows historical trends. Neither combines them into a probabilistic risk assessment.

**Approach:** Extend `get_morpho_history` output OR add a section to `model_metavault_strategy`.

**Logic:**

1. Fetch historical borrow rate data (existing `get_morpho_history` logic)
2. Compute:
   - Mean and standard deviation of borrow rate over the period
   - Maximum observed rate
   - Rate volatility (annualized std dev)
3. For a given loop strategy (leverage + base APY):
   - Compute break-even borrow rate (existing formula: `baseApy * leverage / (leverage - 1)`)
   - Compute Z-score: `(breakEvenRate - meanRate) / stdDev`
   - Estimate probability of break-even being hit: `1 - normalCDF(zScore)` (simple normal approximation)
   - Compute "safe loop count": highest loop where break-even rate > mean + 2*stdDev (95th percentile survival)
4. Output a risk table:
   ```
   Loop  Leverage  Break-Even  P(underwater)  95th-pct Safe?
   1     1.86x     18.2%       <0.1%          ✅
   2     2.60x     10.4%       0.3%           ✅
   3     3.24x      8.1%       1.2%           ✅
   4     3.78x      7.0%       3.5%           ⚠️
   5     4.25x      6.4%       7.8%           ❌
   ```

**Dependencies:** `get_morpho_history` data. Normal CDF can be approximated with a simple formula (no external lib needed).

**Estimation:** ~1-2 days. Mostly math on top of existing data.

---

### P2-A: Multi-Vault Curator Portfolio

**Problem:** A curator-as-a-service manages multiple MetaVaults. No aggregate view exists.

**Approach:** New tool `curator_portfolio` in `src/tools/curator_portfolio.ts`.

**Inputs:**
- `curator_address` (optional) — discover all MetaVaults by curator
- `metavault_addresses` (optional) — explicit list of `{chain, address}` pairs
- `curator_fee_pct` (default 10)

**Logic:**

1. If `curator_address` provided: scan all chains via `scanAllMetavaults()`, filter by curator address match
2. For each vault: run condensed dashboard logic (TVL, APY, position count, action items)
3. Aggregate:
   - Total AUM across all vaults
   - Blended APY (TVL-weighted)
   - Total projected fee revenue
   - Concentration by underlying asset (e.g., "72% USDC, 18% ETH, 10% other")
   - Concentration by chain
   - Concentration by protocol (Spectra vs Pendle)
   - Cross-vault action items (merged and deduplicated)

**Estimation:** ~2 days. Mostly composition of existing dashboard logic.

---

### P2-B: Historical Performance Metrics

**Problem:** Need a track record to attract depositors.

**Approach:** Add `include_performance=true` parameter to `get_curator_dashboard`.

**Logic:**

1. From existing epoch data (share rate snapshots):
   - Compute time-weighted return: `(finalRate / initialRate - 1) * (365 / daysBetween) * 100` annualized
   - Build share price series from rate snapshots
   - Max drawdown: largest peak-to-trough decline in the series
   - Volatility: annualized std dev of epoch-over-epoch returns
   - Sharpe-like ratio: `(annualizedReturn - riskFreeRate) / volatility` (use Morpho USDC supply APY as risk-free proxy)
2. Benchmark comparison: fetch Morpho USDC supply APY from `get_morpho_history` for the same period

**Output:**
```
--- Performance (since inception) ---
  Time-Weighted Return: 14.2% annualized
  Max Drawdown: -0.8% (epoch 2025-11-03 to 2025-11-10)
  Volatility: 2.1% annualized
  Sharpe Ratio: 4.3 (vs Morpho USDC supply as risk-free)
  Benchmark: Morpho USDC supply = 5.1% → outperformance: +9.1%
```

**Estimation:** ~1 day. All data is already in the epoch history; this is pure computation.

---

### P3: Gas Cost Estimation

**Problem:** Looping strategies have meaningful gas costs on mainnet.

**Approach:** Add `gas_estimate` section to `get_looping_strategy` and `model_metavault_strategy` output.

**Logic:**

1. Estimate gas per loop iteration:
   - Spectra PT mint via Router: ~200K-300K gas
   - Morpho deposit collateral: ~150K gas
   - Morpho borrow: ~150K gas
   - Total per loop: ~500K-600K gas (conservative: 600K)
2. Fetch current gas price via `eth_gasPrice` RPC call
3. Convert to USD using ETH price (from existing PT data which includes USD prices)
4. For each loop count: `totalGasCost = loops * gasPerLoop * gasPrice * ethPriceUsd`
5. Express as % of annual yield: `gasCostPct = totalGasCost / (capitalUsd * netApy / 100) * 100`

**Estimation:** ~0.5 days. Simple RPC call + arithmetic.

---

## Architecture Recommendations

### 1. Keep Everything in One MCP Server

The tools share `src/api.ts`, `src/formatters.ts`, `src/config.ts`, and `src/types.ts` extensively. Splitting into multiple servers would require duplicating the data layer or building inter-server communication. The LLM agent also reasons better with a single unified tool list.

### 2. Follow Existing Patterns

All new tools should:
- Register via `export function register(server: McpServer): void` in their respective files
- Use Zod schemas for parameter validation
- Use `fetchSpectra()` / Morpho GraphQL / RPC calls from `src/api.ts`
- Format output in `src/formatters.ts` (keep logic and presentation separate)
- Use `Promise.allSettled` for parallel fetches with best-effort semantics
- Add TypeScript interfaces to `src/types.ts`

### 3. New Files to Create

```
src/tools/risk_monitor.ts    — P0-A: curator_risk_monitor
src/tools/stress_test.ts     — P0-B: stress_test_vault
src/tools/rollover.ts        — P1-A: plan_rollover
src/tools/curator_portfolio.ts — P2-A: curator_portfolio
```

P1-B (borrow rate risk) and P2-B (performance metrics) extend existing tools rather than creating new files.

P3 (gas cost) adds a section to existing `looping.ts` and `metavault.ts` output.

### 4. New API Functions Needed in `src/api.ts`

| Function | Purpose | Used By |
|----------|---------|---------|
| `fetchMorphoPositionDetails(address, chain)` | Enriched position data with oracle prices | P0-A |
| `fetchGasPrice(chain)` | Current gas price via RPC | P3 |
| `fetchEthPrice(chain)` | ETH price for gas cost conversion | P3 |

Most other data needs are already served by existing API functions.

### 5. New Types Needed in `src/types.ts`

```typescript
interface LiquidationAlert {
  positionId: string;
  chain: string;
  collateralAsset: string;
  debtAsset: string;
  healthFactor: number;
  liquidationPrice: number;
  currentPrice: number;
  distanceToLiquidationPct: number;
  borrowRateDrift: number;  // current rate - entry assumption
  inPreLiquidationZone: boolean;
  alertLevel: "ok" | "watch" | "warning" | "critical";
}

interface WithdrawalWaterfallTier {
  name: string;
  availableUsd: number;
  coveragePct: number;  // % of redemption this tier covers
  estimatedCostUsd: number;
  estimatedCostPct: number;  // cost as % of remaining TVL
  cumulativeCoverageUsd: number;
}

interface StressTestResult {
  redemptionAmountUsd: number;
  waterfall: WithdrawalWaterfallTier[];
  totalCovered: boolean;
  totalCostToRemainingPct: number;
  maxSafeRedemptionPct: number;
  maxSafeRedemptionUsd: number;
}

interface RolloverCandidate {
  protocol: "spectra" | "pendle";
  chain: string;
  name: string;
  impliedApy: number;
  effectiveApy: number;
  entryImpactPct: number;
  daysToMaturity: number;
  yieldGapDays: number;        // days of zero yield during transition
  overlapWindow: number | null; // days of overlap if entering before old matures
  loopingAvailable: boolean;
  loopingNetApy: number | null;
}

interface BorrowRateRisk {
  loop: number;
  leverage: number;
  breakEvenRate: number;
  probabilityUnderwater: number;  // P(rate > breakEven) based on historical vol
  safe95thPercentile: boolean;
}

interface CuratorPortfolioSummary {
  totalAumUsd: number;
  blendedApyPct: number;
  projectedAnnualFeeRevenueUsd: number;
  concentrationByUnderlying: Record<string, number>;  // symbol -> % of AUM
  concentrationByChain: Record<string, number>;
  concentrationByProtocol: Record<string, number>;
  vaultCount: number;
  totalPositions: number;
  actionItems: string[];
}
```

### 6. Testing Strategy

Follow existing patterns:
- **Unit tests** (`npm run test:unit`): Test liquidation math, waterfall logic, rate risk calculations in isolation
- **Integration tests** (`npm test`): Test full tool execution with mocked API responses
- **Agent tests** (`npm run test:agent`): Add cross-tool workflow assertions (e.g., "risk monitor detects position that model_metavault_strategy flagged as safe at entry")
- **Subjective tests** (`npm run test:subjective`): Add rubric questions to `AGENT-TESTS.md` (e.g., "A curator has a 4-loop position and borrow rate has increased 2%. What should they do?")

---

## Risk Framework References (For Context)

The design of these tools is informed by industry-standard curator risk frameworks:

### How Leading Curators Manage Risk

**Gauntlet** ([$1.29B AUM](https://vaultbook.gauntlet.xyz/)) uses agent-based simulations to model market stress, targets <10bps insolvent debt under extreme scenarios, and categorizes vaults into Prime/Core/Frontier risk tiers. Their [VaultBook](https://vaultbook.gauntlet.xyz/morpho-vaults/curation-methodology-and-risk-factor-overview) documents the full methodology. Key insight: they constrain position sizes by DEX liquidity of the collateral token — our P0-B stress test follows the same principle.

**Steakhouse Financial** ([$1.53B AUM](https://blog.summer.fi/meet-the-yield-sources-steakhouse-defis-powerhouse-risk-curator/)) evaluates across five dimensions: credit, operational, governance, technical, and quantitative liquidity risk. They use 7-day timelocks + Aragon DAO guardian for vault allocation changes. Key insight: the timelock gives depositors time to exit before risky changes take effect.

### What Went Wrong in 2025

The November 2025 crisis ([detailed analysis](https://chorus.one/reports-research/defi-curators-in-2025-navigating-chaos-building-resilience)) exposed three failure modes:
1. **Collateral de-peg** → cascading liquidations with no liquidity to absorb them
2. **100% utilization** → withdrawal queues frozen, depositors trapped
3. **Oracle failure** (Binance USDe flash crash) → incorrect liquidation triggers

Our P0-A (liquidation monitoring) addresses failure mode 1. Our P0-B (withdrawal stress test) addresses failure mode 2. Oracle risk is partially covered by `check_ibt_health` (conversion rate divergence check) but could be extended.

### Morpho-Specific Mechanics

- **No close factor**: a position at health factor 1.0 can be [fully liquidated in one tx](https://docs.morpho.org/learn/concepts/liquidation/) — this is why distance-to-liquidation is critical
- **Pre-liquidation**: opt-in [Auto-Deleverage](https://docs.morpho.org/build/borrow/concepts/preliquidation) with smaller penalties — the risk monitor should recommend this for curator positions
- **Bad debt socialization**: losses shared [pro-rata among all lenders](https://docs.morpho.org/learn/resources/risks) — relevant for Market A (PT lending) supplier analysis
- **Market isolation**: each Morpho market's risk is [isolated from others](https://docs.morpho.org/learn/resources/risks) — good for containing failures

---

## Estimated Timeline

| Phase | Items | Effort | Dependency |
|-------|-------|--------|------------|
| Phase 1 (P0) | Liquidation monitor + Stress test | ~5-7 days | None — can start immediately |
| Phase 2 (P1) | Rollover planner + Rate risk | ~3-5 days | Benefits from P0 patterns |
| Phase 3 (P2) | Portfolio view + Performance metrics | ~3 days | Dashboard logic stable |
| Phase 4 (P3) | Gas cost estimation | ~0.5 days | Trivial add-on |

**Total: ~12-16 days of engineering work**, mostly additive (new files, new tool registrations) with minimal changes to existing code.

---

## Questions for Architect Review

1. **Morpho oracle data availability** — Does the current Morpho GraphQL schema expose the oracle price used for health factor calculation, or do we need a separate on-chain call? This affects P0-A complexity.

2. **ERC-7540 epoch timing** — What's the actual epoch duration for Spectra MetaVaults? The stress test assumes "one epoch" but needs to know if that's 24h, 7d, or variable. Check [Spectra curator docs](https://curator.docs.spectra.finance/technical/whitelisted-actions).

3. **Cross-chain position exit timing** — For MetaVaults with positions on a different chain (Base vault → Avalanche pool via CCTP), what's the bridge settlement time? This affects stress test Tier 3/4 availability.

4. **Pre-liquidation contract deployment** — Is the Morpho pre-liquidation contract deployed on all chains where Spectra PT markets exist? The risk monitor should only recommend opt-in where available.

5. **Historical epoch data depth** — How far back do MetaVault epoch snapshots go? Performance metrics (P2-B) need sufficient history to be meaningful. If <3 months, consider supplementing with on-chain share price queries.
