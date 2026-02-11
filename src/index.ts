#!/usr/bin/env node

/**
 * Spectra Finance MCP Server
 *
 * Makes Spectra's yield protocol discoverable and usable by AI agents.
 * Wraps the Spectra API (api.spectra.finance) and subgraph to expose
 * yield opportunities, pool data, and strategy calculations.
 *
 * Tools:
 *   - get_pt_details        -> Full details on a specific Principal Token
 *   - list_pools             -> List all pools on a given chain
 *   - get_best_fixed_yields  -> Find the best fixed-rate opportunities across chains
 *   - get_looping_strategy   -> Calculate leveraged yield via PT + Morpho looping (auto-fetches rates)
 *   - compare_yield          -> Compare Spectra fixed rates vs underlying variable rates
 *   - get_protocol_stats     -> Protocol-wide stats (TVL, supply, emissions)
 *   - get_supported_chains   -> List all supported blockchain networks
 *   - get_portfolio           -> Wallet positions (PT, YT, LP balances & claimable yield)
 *   - get_pool_volume         -> Historical trading volume for a specific pool
 *   - get_pool_activity       -> Recent trade and liquidity activity for a pool
 *   - get_morpho_markets      -> Find Morpho markets that accept Spectra PTs as collateral
 *   - get_morpho_rate         -> Get live borrow rate for a specific Morpho market
 *   - quote_trade             -> Estimate expected output, price impact, and minOut for a PT swap
 *   - simulate_portfolio_after_trade -> Preview portfolio state after a hypothetical PT trade
 *   - scan_opportunities       -> Capital-aware opportunity scanner for autonomous agents
 *   - scan_yt_arbitrage        -> YT rate vs IBT rate arbitrage scanner
 *   - get_ve_info              -> Live veSPECTRA data + boost calculator
 *   - model_metavault_strategy  -> MetaVault double-loop strategy modeler for curators
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { API_NETWORKS, SUPPORTED_CHAINS } from "./config.js";

// Tool registrations — each module exports register(server)
import { register as registerPt } from "./tools/pt.js";
import { register as registerLooping } from "./tools/looping.js";
import { register as registerPortfolio } from "./tools/portfolio.js";
import { register as registerPool } from "./tools/pool.js";
import { register as registerMorpho } from "./tools/morpho.js";
import { register as registerProtocol } from "./tools/protocol.js";
import { register as registerQuote } from "./tools/quote.js";
import { register as registerSimulate } from "./tools/simulate.js";
import { register as registerStrategy } from "./tools/strategy.js";
import { register as registerYtArb } from "./tools/yt_arb.js";
import { register as registerVe } from "./tools/ve.js";
import { register as registerMetavault } from "./tools/metavault.js";
import { register as registerContext } from "./tools/context.js";

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new McpServer({
  name: "spectra-finance",
  version: "1.0.0",
});

// Register all tools
registerPt(server);
registerLooping(server);
registerPortfolio(server);
registerPool(server);
registerMorpho(server);
registerProtocol(server);
registerQuote(server);
registerSimulate(server);
registerStrategy(server);
registerYtArb(server);
registerVe(server);
registerMetavault(server);
registerContext(server);

// =============================================================================
// Resources: Protocol context for agents
// =============================================================================

server.resource(
  "spectra-overview",
  "spectra://overview",
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/plain",
      text: `Spectra Finance Overview
========================
Spectra is a permissionless interest rate derivatives protocol for DeFi.

Core Mechanism:
- Users deposit ERC-4626 interest-bearing tokens (IBTs) like Yearn V3 vaults, Aave aTokens, etc.
- The deposit is split into Principal Tokens (PT) and Yield Tokens (YT)
- PT = fixed-rate position (bought at discount, redeems 1:1 at maturity)
- YT = variable yield exposure (leveraged bet on future yield)
- Fundamental identity: PT + YT = 1 underlying at maturity. YT price = 1 - PT price.

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

Reading a wallet's strategy from its holdings:
- A wallet holding YT but no PT has sold/LPed its PT (yield bull, leveraged long variable rate).
- A wallet holding PT but no YT has sold its YT (fixed rate lock).
- Balanced PT + YT = recently minted, no directional position yet.
- High LP = liquidity provider (but check if YT balance is also high — could be mint+LP loop).

Key Integrations:
- AMM: Curve Finance (PT/IBT pools)
- Lending: Morpho (PT as collateral -- enables looping for leveraged fixed yield)
- Vaults: Yearn V3, Aave, and other ERC-4626 compatible
- MetaVaults: Auto-rolling liquidity vaults managed by curators (ERC-7540)
  - YT→LP compounding loop (curator converts YT yield to more LP)
  - MetaVault shares can be used as Morpho collateral for leverage ("double loop")
- Governance: ve(3,3) model on Base (veSPECTRA)

Looping Strategy (most capital-efficient yield in DeFi):
1. Deposit USDC into Yearn V3 vault -> get yvUSDC (ERC-4626)
2. Mint PT on Spectra -> get PT-yvUSDC at discount
3. Use PT as collateral on Morpho
4. Borrow USDC against PT collateral
5. Repeat steps 1-4 for leveraged fixed yield
6. At maturity, PT redeems 1:1, repay Morpho, keep profit

Oracle: Custom Curve oracle built by Spectra team, used by Morpho for PT pricing.

API: https://api.spectra.finance/v1/{network}/pools (list) | /pt/{address} (detail)
Networks: ${API_NETWORKS.map((k) => `${SUPPORTED_CHAINS[k].name} (${k})`).join(", ")}
`,
    }],
  })
);

server.resource(
  "curator-strategy-guide",
  "spectra://curator-strategy-guide",
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

  Use the model_metavault_strategy tool to model specific scenarios with
  your actual parameters (base APY, borrow rate, capital, expected deposits).
`,
    }],
  })
);

// =============================================================================
// Connect and run
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Spectra Finance MCP Server running on stdio");
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
