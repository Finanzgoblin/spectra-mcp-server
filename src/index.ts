#!/usr/bin/env node

/**
 * MetaVault MCP Server
 *
 * Multi-protocol yield intelligence for AI agents (Spectra, Morpho, Pendle).
 *
 * Tools (prefix convention: spectra_, morpho_, pendle_, mv_ for cross-protocol):
 *
 *   Spectra:
 *   - spectra_get_pt_details          -> Full details on a specific Principal Token
 *   - spectra_list_pools              -> List all pools on a given chain
 *   - spectra_get_best_fixed_yields   -> Find the best fixed-rate opportunities across chains
 *   - spectra_get_looping_strategy    -> Calculate leveraged yield via PT + Morpho looping
 *   - spectra_compare_yield           -> Compare Spectra fixed rates vs underlying variable rates
 *   - spectra_get_protocol_stats      -> Protocol-wide stats (TVL, supply, emissions)
 *   - spectra_list_chains             -> List all supported blockchain networks
 *   - spectra_get_portfolio           -> Wallet positions (PT, YT, LP balances & claimable yield)
 *   - spectra_get_pool_volume         -> Historical trading volume for a specific pool
 *   - spectra_get_pool_activity       -> Recent trade and liquidity activity for a pool
 *   - spectra_get_address_activity    -> Cross-pool activity scan for a specific address
 *   - spectra_quote_trade             -> Estimate expected output, price impact, and minOut for a PT swap
 *   - spectra_simulate_trade          -> Preview portfolio state after a hypothetical PT trade
 *   - spectra_scan_opportunities      -> Capital-aware opportunity scanner for autonomous agents
 *   - spectra_scan_yt_arbitrage       -> YT rate vs IBT rate arbitrage scanner
 *   - spectra_get_ve_info             -> Live veSPECTRA data + boost calculator
 *   - spectra_list_metavaults         -> List live MetaVaults across chains
 *   - spectra_model_metavault         -> MetaVault double-loop strategy modeler for curators
 *   - spectra_get_curator_dashboard   -> Operational dashboard for MetaVault curators
 *   - spectra_get_onchain_activity    -> Historical pool activity via eth_getLogs
 *   - spectra_get_pool_capacity       -> Multi-size capacity curve for pool depth assessment
 *   - spectra_get_yield_curve         -> Term structure / yield curve for a given underlying
 *   - spectra_list_expiring_pools     -> Scan all chains for pools approaching maturity
 *   - spectra_stress_test_vault       -> Withdrawal stress test for MetaVaults
 *
 *   Morpho:
 *   - morpho_list_markets             -> Find Morpho markets by collateral (PT or any asset)
 *   - morpho_get_rate                 -> Get live borrow rate for a specific Morpho market
 *   - morpho_get_market_suppliers     -> Who supplies lending liquidity to a Morpho market
 *   - morpho_list_vaults              -> List Morpho vaults on a chain
 *   - morpho_get_positions            -> Query user Morpho positions
 *   - morpho_get_history              -> Historical rates for a Morpho market
 *   - morpho_monitor_risk             -> Liquidation risk monitor for curator Morpho positions
 *
 *   Pendle:
 *   - pendle_list_markets             -> List active Pendle markets
 *   - pendle_get_market_details       -> Detailed view of a single Pendle market
 *   - pendle_get_best_fixed_yields    -> Best fixed-rate opportunities across Pendle chains
 *   - pendle_get_portfolio            -> Wallet positions on Pendle (PT, YT, LP)
 *   - pendle_scan_opportunities       -> Capital-aware Pendle opportunity scanner
 *   - pendle_get_market_capacity      -> Multi-size impact curve for pool depth
 *   - pendle_get_yield_curve          -> Term structure across Pendle maturities
 *   - pendle_list_expiring_markets    -> Markets approaching maturity
 *   - pendle_scan_yt_arbitrage        -> YT mispricing scanner
 *   - pendle_get_protocol_stats       -> Protocol-wide aggregate stats
 *   - pendle_get_looping_strategy    -> Leveraged PT + Morpho looping calculator
 *   - pendle_quote_trade             -> PT trade quote with impact estimation
 *   - pendle_simulate_trade          -> Portfolio impact simulation for PT trades
 *
 *   Merkl:
 *   - merkl_list_campaigns            -> Discover live Merkl incentive campaigns by chain
 *
 *   Cross-protocol (mv_):
 *   - mv_compare_yield                -> Side-by-side Pendle vs Spectra yield comparison
 *   - mv_scan_curator_opportunities   -> Cross-protocol capital-aware scanner for curators
 *   - mv_get_protocol_context         -> Essential protocol mechanics (all protocols)
 *   - mv_check_ibt_health             -> Multi-signal IBT health assessment
 *   - mv_plan_rollover                -> Position rollover planner for expiring positions
 *   - mv_get_curator_portfolio        -> Multi-vault curator portfolio aggregation
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { API_NETWORKS, SUPPORTED_CHAINS, checkConfigStaleness, validateChainConfig } from "./config.js";
import { discoverAndRegisterTools } from "./tool_loader.js";

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new McpServer({
  name: "metavault-mcp",
  version: "2.0.0",
});

// Auto-discover and register all tools from src/tools/*.ts
// Each tool module must export: register(server: McpServer)
// New tools are picked up automatically — no manual imports needed.
await discoverAndRegisterTools(server);

// =============================================================================
// Resources: Protocol context for agents
// =============================================================================

server.resource(
  "metavault-overview",
  "metavault://overview",
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/plain",
      text: `MetaVault MCP — Multi-Protocol Yield Intelligence
===================================================
This server covers THREE protocols with 50 tools. Always consider all three:

  Spectra (24 tools, spectra_* prefix): Interest rate derivatives — PT/YT splitting,
    Curve StableSwap-NG pools, MetaVaults, veSPECTRA governance.
    Chains: ${API_NETWORKS.map((k) => SUPPORTED_CHAINS[k].name).join(", ")}

  Pendle (13 tools, pendle_* prefix): Interest rate derivatives — PT/YT splitting,
    time-decay logit AMM, vePENDLE governance. Full feature parity with Spectra tools.
    Includes Pendle-only chains: Mantle, Berachain, HyperEVM, Corn.

  Morpho (7 tools, morpho_* prefix): Lending markets — PT or any asset as collateral
    for leveraged looping strategies. Supply-side analysis, vault allocations, risk monitoring.
    Now enriched with Merkl campaign data (subsidized borrow/supply rates).

  Merkl (1 tool, merkl_* prefix): Incentive campaign discovery — find subsidized rates,
    borrow rewards, LP incentives across chains.

  Cross-protocol (6 tools, mv_* prefix): Unified analysis across protocols.
    mv_scan_curator_opportunities — scans BOTH Spectra + Pendle with capital-aware metrics.
    mv_compare_yield — side-by-side Spectra vs Pendle with maturity-aware matching.
    mv_check_ibt_health — ERC-4626 health checks (works for both Spectra IBTs and Pendle SY).
    mv_get_protocol_context — protocol mechanics reference (all protocols).
    mv_plan_rollover — cross-protocol rollover planning.
    mv_get_curator_portfolio — multi-vault portfolio aggregation.

IMPORTANT FOR AGENTS: When asked to find yields, scan opportunities, or compare rates,
query BOTH Spectra and Pendle — not just one. Use mv_scan_curator_opportunities for the
broadest view, or run spectra_scan_opportunities AND pendle_scan_opportunities in parallel.

---

Spectra Protocol Mechanics
==========================
Spectra is a permissionless interest rate derivatives protocol for DeFi.

Core Mechanism:
- Users deposit ERC-4626 interest-bearing tokens (IBTs) like Yearn V3 vaults, Aave aTokens, etc.
- The deposit is split into Principal Tokens (PT) and Yield Tokens (YT)
- PT = fixed-rate position (bought at discount, redeems for 1 IBT at maturity)
  Note: 1 IBT may convert to < 1 underlying (e.g., 0.85). This is NOT a loss — it's the
  IBT conversion rate. Your profit is (maturityValue - ptPrice), not (1 - ptPrice).
- YT = variable yield exposure (leveraged bet on future yield)
- Fundamental identity: PT + YT = 1 underlying at maturity. YT price = 1 - PT price.

Yield Calculation:
- Implied APY: The fixed rate from buying PT at discount. Annualized: (1 - ptPrice) × (365 / daysToMaturity).
- Effective APY: Implied APY minus annualized entry cost (price impact from AMM trade).
  Scanner estimates use a conservative constant-product model. Real Curve StableSwap-NG pools
  are significantly more capital-efficient — effective APY shown is a lower bound.
  Use spectra_quote_trade() for exact on-chain quotes before acting on scanner output.

Trading Mechanics (how PT and YT move on-chain):
- PT trades on Curve StableSwap-NG pools (IBT/PT pairs). Pool activity shows BUY_PT and SELL_PT.
- YT does NOT trade on the Curve pool. There is no BUY_YT or SELL_YT activity type.
- Selling YT: The Spectra Router flash-redeems — it borrows IBT, swaps for PT on the pool,
  burns the PT+YT pair to redeem IBT, repays the loan, sends profit to seller. This appears
  as BUY_PT in pool activity even though the user's intent was to sell YT.
- Minting: Depositing IBT into Spectra creates equal amounts of PT and YT.

The Spectra Router (execute()):
The Router is the key to understanding on-chain activity. It batches multiple operations
into single atomic transactions. A pool event only shows the pool's view — not the user's
full intent. Common Router patterns:
- Flash-mint: flash-borrow IBT → mint PT+YT → sell PT on pool → user covers shortfall →
  user receives YT. Pool sees: SELL_PT. User's intent: acquire YT.
- Flash-redeem (YT sell): borrow IBT → buy PT from pool → burn PT+YT → repay → profit.
  Pool sees: BUY_PT. User's intent: sell YT.
- Mint + LP: mint PT+YT from IBT → deposit PT+IBT as LP. Pool sees: AMM_ADD_LIQUIDITY.
  User also received YT (invisible to pool). User's intent: acquire YT + LP position.
- Any SELL_PT, BUY_PT, or AMM_ADD_LIQUIDITY event might be one step of these larger
  operations. Always check portfolio holdings to see the resulting position.

Known Limitation — Mint Visibility:
- Standalone mints (deposit IBT → PT+YT) do NOT appear in pool activity data at all.
  Pool activity only captures Curve AMM events (swaps and LP adds/removes).
- This means the critical first step of most strategies — the mint — is invisible.
- You can INFER mints from the pattern (e.g., a wallet with 18K YT and 0 PT must have
  minted and then sold the PT), but you cannot OBSERVE them directly.
- If your analysis depends on confirming mints, this is a known data gap.
  Cross-reference portfolio holdings (the "what") with activity patterns (the "how")
  to build the most complete picture possible within available data.

Reading a wallet's strategy from its holdings:
These patterns have MULTIPLE valid interpretations — do not collapse to one without evidence:
- YT but no PT: COULD be yield bull (sold PT), OR LPed the PT, OR PT in Morpho collateral.
  Cross-reference with spectra_get_portfolio and spectra_get_pool_activity to distinguish.
- PT but no YT: COULD be fixed-rate lock (sold YT), OR bought PT on market, OR partial redeem.
- Balanced PT + YT: COULD be recently minted (no position yet), OR accumulated separately.
- High LP + high YT: COULD be mint+LP loop (minted PT+YT, LPed PT+IBT, kept YT).
Always cross-reference portfolio (WHAT they hold) with activity (HOW they got there).

MetaVaults (ERC-7540 curated vaults):
- Auto-rolling liquidity vaults managed by curators
- YT→LP compounding loop (curator converts YT yield to more LP)
- MetaVault shares can be used as Morpho collateral for leverage ("double loop")
- Live data via API: /v1/{network}/metavaults — use spectra_list_metavaults to discover
- Use spectra_get_curator_dashboard for operational health monitoring
- Use spectra_model_metavault for double-loop strategy modeling

Key Integrations:
- AMM: Curve Finance (PT/IBT pools)
- Lending: Morpho (PT as collateral -- enables looping for leveraged fixed yield)
- Vaults: Yearn V3, Aave, and other ERC-4626 compatible
- Governance: ve(3,3) model on Base (veSPECTRA)

Looping Strategy (most capital-efficient yield in DeFi):
1. Deposit USDC into Yearn V3 vault -> get yvUSDC (ERC-4626)
2. Mint PT on Spectra -> get PT-yvUSDC at discount
3. Use PT as collateral on Morpho
4. Borrow USDC against PT collateral
5. Repeat steps 1-4 for leveraged fixed yield
6. At maturity, PT redeems for IBT (at maturity value), repay Morpho, keep profit

---

Pendle Protocol Mechanics
=========================
Pendle is an interest rate derivatives protocol similar to Spectra but with key differences.

Core similarities with Spectra:
- Same PT/YT splitting concept — deposit yield-bearing token, get PT (fixed) + YT (variable)
- PT trades at a discount; the discount is the fixed yield
- Morpho looping works the same way (PT as collateral → borrow → buy more PT)

Key differences from Spectra:
- AMM model: Pendle uses a time-decay logit AMM (not Curve StableSwap). Quotes use logit model.
- YT trading: Pendle YT trades DIRECTLY on the AMM (SY↔YT). Spectra YT trades indirectly
  via Router flash-mint/redeem. This makes Pendle YT arbitrage simpler to execute.
- Token wrapping: Pendle uses SY (Standardized Yield) tokens, not IBT. For health checks,
  use mv_check_ibt_health(chain, ibt_address=SY_ADDRESS) — use the SY address, not underlyingAsset.
- Incentives: PENDLE token emissions + vePENDLE boosting (separate from SPECTRA/veSPECTRA).
- Chains: Pendle covers Mantle, Berachain, HyperEVM, Corn — chains Spectra doesn't support.

Pendle tools mirror every Spectra tool: pendle_list_markets, pendle_scan_opportunities,
pendle_get_best_fixed_yields, pendle_quote_trade, pendle_simulate_trade, etc.

---

Morpho Protocol Mechanics
=========================
Morpho is a lending protocol used for leveraged yield strategies on both Spectra and Pendle PTs.

Tools: morpho_list_markets, morpho_get_rate, morpho_get_market_suppliers, morpho_list_vaults,
morpho_get_positions, morpho_get_history, morpho_monitor_risk.

How it connects: Both Spectra and Pendle PTs can be used as Morpho collateral to borrow
underlying assets and loop for leveraged fixed yield. Use spectra_get_looping_strategy or
pendle_get_looping_strategy to model this. morpho_monitor_risk tracks liquidation distance.

Oracle: Custom Curve oracle built by Spectra team, used by Morpho for PT pricing.

API: https://api.spectra.finance/v1/{network}/pools (list) | /pt/{address} (detail)
Networks: ${API_NETWORKS.map((k) => `${SUPPORTED_CHAINS[k].name} (${k})`).join(", ")}
`,
    }],
  })
);

server.resource(
  "curator-strategy-guide",
  "metavault://curator-strategy-guide",
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/plain",
      text: `Spectra Curator Strategy Guide — Making a Market with MetaVaults
===================================================================

This guide walks through the optimal strategy for curators launching a new
interest-bearing token (IBT) market on Spectra with Morpho integration.

1. OVERVIEW: TWO MORPHO MARKETS, TWO LAYERS OF LEVERAGE
========================================================

As a curator, you should create TWO separate Morpho markets to maximize the
flywheel effect. They serve different audiences and reinforce each other.

  Market A — PT / Underlying (e.g. PT-ibUSDC / USDC)
  ---------------------------------------------------
  WHO: External users (yield farmers, degens, protocols)
  WHAT: Users buy PT on Spectra, deposit as Morpho collateral, borrow
        underlying, buy more PT, repeat (looping).
  WHY: Drives massive PT buying demand, which creates trading volume,
       deepens the Curve pool, and generates LP fees.
  YOUR ROLE: You can also supply the lending side of this market, earning
             the borrow rate on idle capital.
  EFFECT: This is your GROWTH ENGINE. It creates the user-facing flywheel.

  Market B — MetaVault Shares / Underlying (e.g. MV-ibUSDC / USDC)
  -----------------------------------------------------------------
  WHO: You (the curator) and sophisticated depositors.
  WHAT: MetaVault shares are deposited as Morpho collateral, borrow
        underlying, deposit back into the vault, repeat.
  WHY: Multiplies your own capital efficiency. Your $2M seed can create
       $8-10M of effective TVL via leverage.
  YOUR ROLE: You are the primary user of this market — looping your own
             vault shares.
  EFFECT: This is your CAPITAL EFFICIENCY play. It amplifies your yield
          and your fee revenue.

2. THE FLYWHEEL: HOW THE TWO MARKETS REINFORCE EACH OTHER
==========================================================

  1. Market A drives PT buying demand → more pool volume → more LP fees
  2. Higher LP fees boost the MetaVault's base APY
  3. You loop MV shares via Market B → your looped capital deepens the pool
  4. Deeper liquidity → lower slippage → attracts more PT loopers to Market A
  5. More external deposits into your vault → more fee revenue you EARN

  The key insight: Market A creates demand, Market B amplifies your capital.
  Together they form a self-reinforcing liquidity loop.

3. CURATOR FEE MODEL
=====================

  As curator, you EARN the performance fee on vault yield generated for
  external depositors. This is your revenue stream for:
    - Rolling LP positions across maturity cycles
    - Compounding YT yield back into LP
    - Maintaining proper allocations
    - Managing the vault's Morpho leverage

  Example: 10% curator fee on a vault with 9% gross APY and $10M external:
    Fee revenue = 10% × 9% × $10M = $90,000/yr earned by you

  Net Vault APY shown to depositors = gross APY × (1 - curator fee).
  Depositors see what they receive AFTER your fee.

4. THE "DOUBLE LOOP" PREMIUM
=============================

  Raw PT looping only leverages the fixed yield (implied APY).

  MetaVault looping leverages a HIGHER base because:
    - YT compounding adds yield on top of the LP base APY
    - Curator fee is deducted from depositor returns, but the curator's
      own capital earns at the full vault rate

  When YT compounding adds even 2-3% on top of base APY, the double-loop
  premium compounds with leverage — at 4-5x, this can mean 4-5% higher
  net APY than raw PT looping.

5. LAUNCH SEQUENCING
====================

  Step 1: Deploy Spectra Pool
    - Create PT/YT market for your IBT with a suitable maturity (60-180 days)
    - Seed the Curve pool with your available liquidity as LP

  Step 2: Morpho Market A (PT Collateral) — launch ASAP
    - Get your PT accepted as Morpho collateral (86% LLTV is standard for
      stablecoin PTs)
    - This drives external user demand immediately
    - Consider supplying USDC to the lending side yourself

  Step 3: Launch MetaVault
    - Wrap your LP position into a MetaVault
    - Configure YT compounding + auto-rollover
    - Set your curator performance fee (typically 5-15%)

  Step 4: Morpho Market B (MV Share Collateral)
    - Once the vault has track record, get MV shares accepted as collateral
    - Loop your own vault shares to maximize capital efficiency
    - This is your long-term capital multiplication strategy

6. RISK MANAGEMENT
==================

  Borrow Rate Sensitivity:
    Your spread = base yield - borrow rate. At 7% yield vs 4% borrow, you
    have 3% margin. Monitor borrow rates closely — if they spike above your
    base yield, deleverage quickly. Consider keeping 1-2 loops below maximum
    for safety buffer.

  Safety Margin by Leverage:
    2x leverage: ~50% margin (very safe, conservative returns)
    3x leverage: ~28% margin (balanced risk/reward)
    4x leverage: ~15% margin (aggressive, monitor closely)
    5x leverage: ~7% margin (maximum risk, high monitoring required)

  Liquidity Risk:
    - Pool depth must support the looping volume you're enabling
    - Monitor price impact — if large PT buys move the price >2%, the pool
      needs more liquidity
    - Your looped MV capital helps here — it deepens the pool indirectly

  Rollover Risk:
    - MetaVault auto-rollover eliminates ~5 idle days per maturity cycle
    - Manual LP loses ~20 days/yr of yield to rollover gaps
    - This is a key selling point for attracting external depositors

7. REVENUE STACK SUMMARY
=========================

  A curator's total revenue comes from multiple sources:

    +-- Own yield (looped MV position)         <-- largest component
    +-- Curator fee revenue on external deposits
    +-- USDC lending income (Market A supply side)  <-- optional
    +-- SPECTRA gauge emissions on LP position  <-- if veSPECTRA holder
    = Total curator ROI on seed capital

  Use the spectra_model_metavault tool to model specific scenarios with
  your actual parameters (base APY, borrow rate, capital, expected deposits).
`,
    }],
  })
);

// =============================================================================
// Connect and run
// =============================================================================

async function main() {
  // Startup health checks — emit warnings, never throw
  checkConfigStaleness();
  validateChainConfig();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MetaVault MCP Server running on stdio");
}

// Graceful shutdown on SIGTERM/SIGINT
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    console.error(`Received ${sig}, shutting down`);
    try {
      await server.close();
    } catch {
      // Best-effort close
    }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
