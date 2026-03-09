/**
 * Tool: mv_get_protocol_context
 *
 * Makes protocol knowledge available as a callable tool instead of only
 * as an MCP resource (which many clients don't auto-load into context).
 * Returns the essential mechanics an agent needs for correct reasoning
 * about Spectra positions, activity, and strategies.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { API_NETWORKS, SUPPORTED_CHAINS, PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES } from "../config.js";

const TOPICS: Record<string, string> = {

  "pt_yt_mechanics": `PT/YT Mechanics
- Depositing an ERC-4626 IBT into Spectra splits it into PT (Principal Token) + YT (Yield Token).
- PT + YT = 1 underlying at maturity. YT price = 1 - PT price (in underlying terms).
- PT trades at a discount; the discount IS the fixed yield. At maturity, PT redeems 1:1.
- YT gives leveraged variable yield exposure. YT leverage = 1 / YT price in underlying.
- PT trades on Curve StableSwap-NG pools (IBT/PT pairs). YT does NOT trade on the pool directly.
- Maturity Value context: Tools often show maturityValue < 1.0 (e.g., 0.852). This is the IBT
  rate (how much underlying 1 IBT is worth). It is NOT a loss — you bought PT at a discount
  to this value. The spread (maturityValue - ptPrice) is your yield.
  Example: PT price 0.82, maturity value 0.852 → 3.2 underlying profit per 100 PT.`,

  "router_batching": `Router Batching (critical for interpreting pool activity)
- The Spectra Router's execute() batches multiple operations into one atomic tx.
- Pool activity only shows the Curve pool's perspective — not the user's full intent.
- SELL_PT in pool activity could be: (a) selling PT, or (b) flash-mint to acquire YT.
  Flash-mint: flash-borrow IBT → mint PT+YT → sell PT on pool → user keeps YT.
- BUY_PT in pool activity could be: (a) buying PT, or (b) flash-redeem to sell YT.
  Flash-redeem: borrow IBT → buy PT → burn PT+YT → repay → profit.
- AMM_ADD_LIQUIDITY could be: (a) adding liquidity, or (b) mint + LP in one tx.
  The minted YT goes to the user's wallet (invisible in pool data).
- Key principle: any pool event type can be one step of a multi-step Router operation.
  Always cross-reference with spectra_get_portfolio to see resulting holdings.`,

  "position_analysis": `Reading Wallet Strategy from Holdings
- Minting always produces equal PT and YT. Any imbalance means tokens were traded.
- spectra_get_portfolio shows Position Shape as a balance ratio (e.g., "YT/PT 4:1" or "PT only").
- IMPORTANT: Each observable position shape has MULTIPLE valid explanations.
  spectra_get_pool_activity now presents these as competing interpretation branches (A/B/C).
  Do not collapse to one interpretation without cross-referencing portfolio + activity.
- Observable ratios (what you see) vs interpretations (what it could mean):
    YT >> PT: EITHER sold PT after minting (YT accumulation) OR intermediate state before next move OR partial unwind in progress
    PT >> YT: EITHER sold YT via flash-redeem (fixed-rate preference) OR bought PT without minting OR preparing LP deposit
    LP present with low PT/YT: EITHER tokens absorbed into pool OR LP-centric strategy OR residual from mint loop
    Balanced PT + YT: EITHER recently minted (no trade yet) OR deliberate balanced position OR about to split
    Fully exited (0 PT, 0 YT): EITHER completed round-trip OR capital moved elsewhere OR temporary exit
- Large activity volume with small current holdings: EITHER capital recycled (looping) OR completed round-trip OR funds moved to another venue. Cannot distinguish without cross-referencing.
- Multi-pool wallets may show DIFFERENT strategies per pool. Do not force a unified narrative.
  The absence of a single consistent strategy IS a signal — it may indicate adaptive behavior.
- Strategies often span multiple wallets — check all concentrated addresses.
- OBSERVATION COVERAGE: spectra_get_pool_activity now quantifies its own blind spots:
  (1) Value coverage — % of position explained by observable activity. Low coverage
      means most behavior is invisible to the tool (direct mints, transfers, cross-chain).
  (2) Temporal gaps — dark periods with no observable events.
  (3) Data source coverage — which of 5 available sources were actually consulted.
  Coverage metrics bound the domain of validity for ALL interpretations. If value
  coverage is <50%, the interpretation branches are based on a MINORITY of behavior.
  Always check coverage before sizing confidence or positions.`,

  "looping": `Looping Strategy (leveraged fixed yield via Morpho)
1. Deposit underlying into ERC-4626 vault → get IBT
2. Mint PT on Spectra → get PT at discount
3. Use PT as collateral on Morpho → borrow underlying
4. Repeat steps 1-3 for leveraged fixed yield
5. At maturity, PT redeems 1:1, repay Morpho loan, keep spread as profit.
- Net APY = baseAPY × leverage - borrowRate × (leverage - 1)
- Requires a Morpho market that accepts the specific PT as collateral.
- Borrow rates are variable — spread can turn negative if rates spike.
- Entry cost (price impact) compounds across loops.
- Use spectra_scan_opportunities for capital-aware looping analysis across all chains.`,

  "networks": `Supported Networks
${API_NETWORKS.map((k) => `- ${SUPPORTED_CHAINS[k].name} (use "${k}" in queries, chain ID ${SUPPORTED_CHAINS[k].id})`).join("\n")}
- "ethereum" is accepted as an alias for "mainnet".
- Morpho PT markets exist on: mainnet, base, arbitrum, katana.
- veSPECTRA governance lives on Base.`,

  "deposit_path": `How to Enter Spectra Positions (Deposit Paths)
- To buy PT (lock in fixed rate): Send underlying (e.g., USDC) to the Spectra Router.
  The Router atomically: wraps to IBT (ERC-4626 vault share) → swaps IBT for PT on Curve pool.
  You receive PT. At maturity, PT redeems for 1 IBT → unwrap → underlying + accrued yield.
- To mint PT+YT (get both tokens): Send underlying → Router wraps to IBT → Spectra mint → PT+YT.
  This does NOT go through the pool. No price impact. You get equal amounts of PT and YT.
- To get YT only (leveraged variable yield): Flash-mint strategy via the Router.
  Router: flash-borrow IBT → mint PT+YT → sell PT on Curve pool → you keep YT, repay flash.
  Appears as SELL_PT in pool activity. Entry cost = PT selling slippage.
- To LP (earn trading fees + SPECTRA gauge): Add IBT + PT to the Curve pool.
  Often combined with mint: deposit → mint PT+YT → add IBT+PT to pool → keep YT.
  Appears as AMM_ADD_LIQUIDITY. The minted YT goes to your wallet (invisible in pool data).
- To loop PT (leveraged fixed yield via Morpho): Buy PT → deposit as Morpho collateral →
  borrow underlying → buy more PT → repeat. Requires a Morpho market for this PT.
  Use spectra_get_looping_strategy() to model leverage levels and break-even borrow rates.
- Prerequisites: You need the underlying asset (USDC, ETH, etc.) on the right chain.
  Everything else is handled atomically by the Spectra Router. No manual multi-step process.`,

  "glossary": `Glossary — Key Terms for Newcomers
- IBT (Interest-Bearing Token): An ERC-4626 vault share that accrues yield over time.
  Examples: yvUSDC (Yearn vault), aUSDC (Aave), stETH (Lido). The "sw-" prefix (e.g.,
  sw-yvUSDC) means Spectra-wrapped — Spectra creates its own ERC-4626 wrapper around the
  yield source.
- PT (Principal Token): Your claim on the principal. Trades at a discount to underlying.
  The discount IS the fixed yield. At maturity, 1 PT redeems for 1 IBT.
- YT (Yield Token): Your claim on the variable yield. Gives leveraged yield exposure.
  YT price = 1 - PT price (in underlying terms). Does NOT trade on the Curve pool directly.
- Implied APY: The fixed rate you lock in by buying PT at its current discount.
  Formula: annualized discount = (1 - ptPrice) * (365 / daysToMaturity).
- Effective APY: Implied APY minus annualized entry cost (price impact from the AMM trade).
  IMPORTANT: Scanner estimates use a conservative constant-product model. Real Curve
  StableSwap-NG pools are significantly more capital-efficient — actual effective APY
  is higher than shown. Use spectra_quote_trade() for exact on-chain quotes before acting.
- LLTV (Liquidation Loan-to-Value): Morpho's liquidation threshold. NOT the safe operating
  level — loop at 90-95% of LLTV for a safety buffer.
- Gauge: A SPECTRA emission distributor. veSPECTRA voters direct SPECTRA rewards to specific
  pools. LP APY includes gauge emissions on top of trading fees.
- Maturity Value: How much underlying 1 PT ultimately converts to at maturity. The path is
  1 PT → 1 IBT → maturityValue underlying (e.g., 0.85). Values < 1.0 are NOT a loss — this
  is the IBT-to-underlying conversion rate. Your profit is (maturityValue - ptPrice). If you
  bought PT at 0.82 and maturity value is 0.85, you earned the 0.03 spread.
- veSPECTRA: Vote-escrowed SPECTRA token. Locked on Base chain. Boosts LP gauge rewards
  up to 2.5x and directs emissions to specific pools.
- Flash-mint: Atomic operation via the Router: borrow IBT → mint PT+YT → sell PT on pool →
  keep YT. Used to buy YT without the pool trading it directly.
- Flash-redeem: Atomic operation via the Router: borrow IBT → buy PT on pool → burn PT+YT →
  repay → profit. Used to sell YT without the pool trading it directly.
- APR vs APY: APR = simple annual rate (no compounding). APY = compound annual yield.
  IBT rates are shown as APR (continuously accruing). Scanner implied yields are APY
  (annualized from PT discount). A 5% APR ≈ 5.13% APY. The distinction matters most
  when comparing IBT variable rates (APR) against fixed rates (APY) in spectra_compare_yield.
- Underlying: The base asset before any wrapping. USDC, ETH, GHO, etc. The chain of
  conversions: underlying → IBT (yield-bearing wrapper) → PT + YT (Spectra split).
  When tools say "in underlying terms," they mean denominated in this base asset.
- LP (Liquidity Providing): Depositing paired assets (IBT + PT) into a Curve pool to
  earn trading fees + SPECTRA gauge emissions. LP APY = fee APY + gauge APY. LPs take
  on IL (impermanent loss) risk as the PT/IBT ratio shifts, but Curve StableSwap-NG
  minimizes this for assets that converge at maturity.
- ERC-4626: The standard interface for tokenized yield vaults. Any vault that implements
  ERC-4626 can be plugged into Spectra. The key method: convertToAssets() tells you how
  many underlying tokens one vault share is worth (this is the IBT conversion rate).
- Curve StableSwap-NG: The AMM design used for Spectra's PT/IBT pools. Optimized for
  assets that trade near 1:1 — much more capital-efficient than constant-product (x*y=k)
  AMMs. This is why scanner estimates (which use constant-product math) significantly
  understate real pool efficiency. The "NG" (next-generation) variant supports dynamic fees.
- Boost: The veSPECTRA multiplier on LP gauge rewards. Formula:
  B = min(2.5, 1.5 × (v/V) × (D/d) + 1), where v = your veSPECTRA, V = total supply,
  D = pool TVL, d = your deposit. Full 2.5x when your vote share ≥ your pool share.
  Without any veSPECTRA, boost = 1x (base rate). Use spectra_get_ve_info to compute scenarios.`,

  "pendle_morpho": `Pendle & Morpho — Multi-Protocol Context

This server covers THREE protocols, not just Spectra. Always consider all three when
analyzing yields, scanning opportunities, or comparing rates.

PENDLE (13 tools, pendle_* prefix):
- Interest rate derivatives protocol similar to Spectra — same PT/YT concept.
- AMM: Time-decay logit AMM (not Curve StableSwap). Use pendle_quote_trade for quotes.
- YT trades DIRECTLY on the AMM (SY↔YT). Spectra YT trades indirectly via Router.
- Token wrapping: Uses SY (Standardized Yield) tokens, not IBT.
  For health checks: mv_check_ibt_health(chain, ibt_address=SY_ADDRESS).
  Do NOT use underlyingAsset — that's the base token with no conversion rate.
- Chains: Includes Mantle, Berachain, HyperEVM, Corn (not on Spectra).
  Overlapping chains: Ethereum, Base, Arbitrum, Optimism, Sonic, BSC.
- Incentives: PENDLE token emissions + vePENDLE boosting (separate from veSPECTRA).
- Tools mirror Spectra: pendle_list_markets, pendle_scan_opportunities,
  pendle_get_best_fixed_yields, pendle_quote_trade, pendle_simulate_trade,
  pendle_get_looping_strategy, pendle_scan_yt_arbitrage, etc.

MORPHO (7 tools, morpho_* prefix):
- Lending protocol for leveraged yield strategies on both Spectra and Pendle PTs.
- morpho_list_markets: Find markets accepting PTs as collateral (filter by chain/symbol).
- morpho_get_rate: Live borrow rates with supply-side context.
- morpho_get_market_suppliers: Who supplies lending liquidity (vault/EOA/looper breakdown).
- morpho_list_vaults: Vault allocations with Spectra PT tagging.
- morpho_get_positions: User positions across markets/vaults with health factors.
- morpho_get_history: Historical rate trends with stability signals.
- morpho_monitor_risk: Liquidation risk monitoring (health factor, distance-to-liquidation).
- Looping works the same on both protocols: PT → Morpho collateral → borrow → buy more PT.
  Use spectra_get_looping_strategy or pendle_get_looping_strategy to model.

CROSS-PROTOCOL (6 tools, mv_* prefix):
- mv_scan_curator_opportunities: Scans BOTH Spectra + Pendle with capital-aware metrics.
  This is the broadest discovery tool — use it when comparing across protocols.
- mv_compare_yield: Side-by-side Spectra vs Pendle with maturity-aware matching.
- mv_check_ibt_health: Works for both Spectra IBTs and Pendle SY tokens.
- mv_get_protocol_context: This tool — protocol mechanics for all protocols.
- mv_plan_rollover: Cross-protocol rollover planning for expiring positions.
- mv_get_curator_portfolio: Multi-vault aggregation across protocols.

METAVAULTS (Spectra-specific, spectra_* prefix):
- ERC-7540 curated vaults that automate LP rollover and compound YT yield.
- spectra_list_metavaults: Discover live MetaVaults across all chains.
- spectra_model_metavault: "Double loop" strategy modeling (vault + Morpho leverage).
- spectra_get_curator_dashboard: Operational health monitoring for curators.
- spectra_stress_test_vault: Withdrawal stress testing with liquidity waterfall.

IMPORTANT: When asked to find the best yield, ALWAYS query both protocols.
Run spectra_scan_opportunities AND pendle_scan_opportunities, or use
mv_scan_curator_opportunities for a unified cross-protocol scan.`,

  "workflow_routing": `Workflow Routing — How tools compose for common goals

If you're new to Spectra or unsure which tool to start with:
  Use mv_scan_curator_opportunities(capital_usd=YOUR_AMOUNT) — broadest view.
  It scans BOTH Spectra and Pendle across all chains with capital-aware metrics.
  spectra_scan_opportunities is Spectra-only and may return far fewer results at smaller capital sizes.
  IMPORTANT: Effective APY in scan results is a conservative lower bound (constant-product
  impact model). Real Curve StableSwap-NG pools are significantly more capital-efficient —
  actual effective APY is higher than shown. Always verify top picks with spectra_quote_trade().

Goal: "Find the best yield for my capital"
  Start with: spectra_scan_opportunities(capital_usd=YOUR_AMOUNT)
  This computes price impact at your size, effective APY, and Morpho looping.
  Different from spectra_get_best_fixed_yields which ranks by raw APY without capital awareness.
  The two tools intentionally disagree on "best" — raw APY vs effective APY are different
  questions. Both are valid depending on your assumptions about capital size and slippage.

Goal: "Analyze a wallet's strategy"
  Start with: spectra_get_portfolio(address) to see position shapes and balances
  Then: spectra_get_pool_activity(chain, pool_address, address) on pools where they hold positions
  Then: spectra_get_address_activity(address) for cross-pool pattern discovery
  Portfolio shows WHAT they hold; activity shows HOW they got there. Neither alone tells
  the full story — always cross-reference both.
  CHECK OBSERVATION COVERAGE in spectra_get_pool_activity output. If value coverage is low,
  most of the address's behavior is invisible. Do not present high-confidence strategy
  assessments when coverage is below 50%. Size conviction to coverage, not to the
  coherence of the interpretation.

Goal: "Evaluate a specific opportunity in depth"
  Start with: spectra_get_pt_details(chain, pt_address) for base data
  Then: mv_check_ibt_health(chain, pt_address) to verify the underlying IBT is sound
  Then: spectra_compare_yield(chain, pt_address) for fixed vs variable spread
  Then: spectra_get_pool_capacity(chain, pt_address) to see depth at your capital size
  Then: spectra_get_looping_strategy(chain, pt_address) if Morpho market exists
  Then: spectra_quote_trade(chain, pt_address, amount, side) for exact entry cost
  Then: spectra_simulate_trade(...) to preview the result
  For Pendle markets: use mv_check_ibt_health(chain, ibt_address=SY_ADDRESS) — direct mode
  tries ERC-4626, then falls back to Pendle SY exchangeRate(). Use the SY address, not
  underlyingAsset (which is the base token with no conversion rate).

Goal: "Find YT mispricing"
  Start with: spectra_scan_yt_arbitrage(capital_usd) for spread-sorted opportunities
  YT arbitrage is a different axis than PT yield optimization. Large spreads could mean
  real mispricing, IBT APR about to drop, or a liquidity event. The tool surfaces the
  spread; distinguishing the cause requires agent judgment.

Goal: "Optimize governance position / veSPECTRA"
  Start with: spectra_get_ve_info(ve_balance, capital) for boost scenarios
  Then: spectra_scan_opportunities(capital, ve_spectra_balance) for boosted rankings
  veSPECTRA boost only affects gauge-enabled LP positions, not PT or YT directly.

Goal: "Model a curator / MetaVault strategy"
  Start with: spectra_get_curator_dashboard(chain, metavault_address) for operational overview
  Then: spectra_model_metavault(...) for leverage modeling
  Compare against: spectra_get_looping_strategy for raw PT looping baseline
  The double-loop premium shows when MetaVault leverage beats raw PT looping.

Goal: "Find the best yield across Spectra AND Pendle for a MetaVault"
  Start with: mv_scan_curator_opportunities(capital_usd=YOUR_AMOUNT)
  This scans BOTH protocols with capital-aware metrics and maturity-aware matching.
  Then: mv_compare_yield(chain=CHAIN, asset_filter="ASSET") for detailed head-to-head
  Then: spectra_get_curator_dashboard(chain, metavault_address) to check current allocations
  Then: spectra_model_metavault(chain, metavault_address) to model blended allocation
  Key difference from spectra_scan_opportunities: spectra_scan_opportunities is Spectra-only.
  mv_scan_curator_opportunities includes Pendle markets. The two tools CAN disagree on
  "best" because they cover different opportunity sets. Both are valid.

Goal: "Compare Spectra vs Pendle on a specific chain"
  Start with: mv_compare_yield(chain=CHAIN) for maturity-aware head-to-head
  Then: pendle_list_markets(chain=CHAIN) for full Pendle data
  Then: spectra_list_pools(chain=CHAIN) for Spectra data
  Matching is by underlying asset + maturity proximity (exact ≤7d, close ≤30d, loose ≤90d).
  Pendle-only chains (${Object.keys(PENDLE_CHAIN_IDS).filter((k) => !SUPPORTED_CHAINS[k]).map((k) => PENDLE_CHAIN_NAMES[k]).join(", ")}) represent Spectra expansion opportunities.

Goal: "Evaluate a Pendle market for MetaVault allocation"
  Start with: pendle_list_markets(chain=CHAIN) — find market, note SY address
  Then: mv_check_ibt_health(chain, ibt_address=SY_ADDRESS) — verify SY→underlying rate on-chain
  Note: use the SY address (not underlyingAsset) for health checks. SY is the yield-bearing
  wrapper; underlyingAsset is the base token (e.g., USDC) which has no conversion rate.
  Pendle LP APY breakdown: swap fees + PENDLE incentives + underlying variable yield.
  vePENDLE holders get boosted LP APY (shown as "Max Boosted LP APY" in market output).
  Key differences from Spectra: Pendle uses time-decay AMM pricing (not Curve StableSwap),
  Pendle positions require manual rollover (no auto-rolling like Spectra MetaVaults),
  and Pendle LP has different risk profile (impermanent loss from AMM time decay).

Goal: "Assess pool depth and IBT safety before deploying"
  Start with: mv_check_ibt_health(chain, pt_address) — multi-signal IBT verdict
  Then: spectra_get_pool_capacity(chain, pt_address) — capacity curve across capital tiers
  mv_check_ibt_health verifies: conversion rate, APR sustainability, pool balance, liquidity.
  mv_check_ibt_health direct mode tries ERC-4626 convertToAssets(), then Pendle SY exchangeRate().
  For Pendle: use mv_check_ibt_health(chain, ibt_address=SY_ADDRESS) where SY is the
  Standardized Yield token. The SY address is shown in pendle_list_markets output.
  Do NOT use underlyingAsset — that's the base token (USDC, ETH) with no conversion rate.
  spectra_get_pool_capacity shows: impact & effective APY at geometric capital tiers, sweet spot, exhaustion.

Goal: "Compare maturities for a single underlying (term structure)"
  Start with: spectra_get_yield_curve(underlying="USDC") — all maturities across all chains
  Shows implied APY at each maturity point, sorted chronologically.
  Identifies curve shape (normal/inverted/flat), steepest segment, cross-chain pairs.
  Then: spectra_get_pt_details or mv_check_ibt_health on specific maturities to drill deeper.

Four discovery tools and when to use each:
  spectra_get_best_fixed_yields — headline rates across all chains (no capital adjustment)
  spectra_scan_opportunities — capital-aware effective APY with Morpho looping (Spectra-only)
  mv_scan_curator_opportunities — cross-protocol (Spectra + Pendle) capital-aware scanner
  spectra_scan_yt_arbitrage — YT spread opportunities (rate conviction bets)
  These four intentionally produce different rankings. The disagreement is a feature.

Two due-diligence tools for before-you-deploy checks:
  mv_check_ibt_health — IBT conversion rate, APR composition, protocol recognition, liquidity
  spectra_get_pool_capacity — multi-size quote ladder showing impact degradation at scale

---

Maximizing analysis depth — what user context unlocks which tools:

  Capital size (e.g., "$200K")
    → spectra_scan_opportunities / mv_scan_curator_opportunities compute price impact at YOUR size
    → spectra_get_pool_capacity shows where your capital exhausts the pool
    → spectra_get_looping_strategy sizes leverage to your capital
    → Without this: tools default to $10K, which may wildly misrepresent your real options

  Wallet address (e.g., "0xABC...")
    → spectra_get_portfolio shows existing positions, claimable yield, Merkl rewards
    → spectra_simulate_trade previews how a new trade changes your holdings
    → spectra_get_pool_activity with address isolation reveals your own trading patterns
    → Without this: analysis is generic, can't account for existing exposure

  veSPECTRA balance (e.g., "50,000 veSPECTRA")
    → spectra_scan_opportunities / spectra_compare_yield / spectra_get_ve_info compute real per-pool boost
    → LP APY shown as your boosted rate, not the min/max range
    → Without this: tools show unboosted ranges, understating LP yield for veHolders

  Asset preference (e.g., "USDC", "ETH", "stables")
    → Filters yield curve, opportunity scans, and cross-protocol comparison
    → spectra_get_yield_curve shows term structure for that specific asset
    → Without this: scans return everything, requiring manual filtering

  Strategy type (e.g., "fixed yield", "LP", "looping", "MetaVault curation")
    → Determines which tool chain to prioritize:
      Fixed yield: scan → spectra_compare_yield → spectra_quote_trade → simulate
      LP: scan → spectra_compare_yield (LP APY) → spectra_get_ve_info (boost) → quote
      Looping: scan → spectra_get_looping_strategy → morpho_get_rate → capacity
      Curation: mv_scan_curator_opportunities → spectra_get_curator_dashboard → spectra_model_metavault
    → Without this: analysis covers all strategies broadly instead of going deep on one

  Maturity preference (e.g., "60-180 days", "short term only")
    → spectra_get_yield_curve filtered to relevant horizon
    → Rollover timing becomes part of the analysis
    → Without this: all maturities shown equally, no time-horizon reasoning

The ideal prompt provides ALL of these: capital + wallet + veSPECTRA + asset + strategy + maturity.
This lets the agent chain 8-10 tools into a single end-to-end analysis with cross-referencing
at every step. Each missing input collapses one dimension of the analysis.

Example high-context prompts that trigger deep multi-tool workflows:

  Yield hunter:
  "I have $50K USDC and 10,000 veSPECTRA. Find the best risk-adjusted fixed yield for
  60-180 days. Check IBT health, quote my exact entry, and show who else is in the pool."

  Curator:
  "I'm building a USDC MetaVault on Base with $500K own capital, expecting $2M external.
  Model the double-loop economics and compare Spectra vs Pendle LP allocation."

  Investigator:
  "Wallet 0xABC... is active on Spectra mainnet. Show me everything — portfolio, activity
  across all pools, sequence analysis, and what strategy they're running."

  Term structure:
  "Show me the ETH yield curve across all chains. Where are the term premium anomalies?
  Quote pool capacity at $200K for the top 3 mispricings."`,
};

const ALL_TOPIC_NAMES = Object.keys(TOPICS);

export function register(server: McpServer): void {
  server.tool(
    "mv_get_protocol_context",
    `Get essential protocol mechanics for Spectra, Pendle, and Morpho — needed for correct reasoning.
This server covers 3 protocols with 50 tools. This context tool teaches how they all work.

Use topic "pendle_morpho" first if you're unfamiliar with the multi-protocol scope — it
explains all three protocols, their tools (spectra_*, pendle_*, morpho_*, mv_*), and
when to use cross-protocol tools vs protocol-specific ones. IMPORTANT: MetaVaults
(spectra_list_metavaults, spectra_model_metavault, spectra_get_curator_dashboard,
spectra_stress_test_vault) are Spectra-specific curated vaults — don't miss them.

Use topic "workflow_routing" to learn which tools to call for a given goal
(yield optimization, wallet analysis, YT arbitrage, curator strategies, etc.)
and how they feed into each other. Recommended starting point for agents new to the tool set.

Use topic "pt_yt_mechanics" for how PT/YT splitting works on Spectra.
Use topic "router_batching" for how Spectra Router affects pool activity interpretation.
Use topic "deposit_path" for step-by-step entry mechanics (how to buy PT, mint YT, LP, loop).
Use topic "glossary" for key term definitions (IBT, sw-prefix, LLTV, gauge, maturity value, APR vs APY, underlying, LP, ERC-4626, Curve StableSwap-NG, boost formula).

Available topics: ${ALL_TOPIC_NAMES.join(", ")}
Omit the topic parameter to get all topics at once.`,
    {
      topic: z
        .enum(ALL_TOPIC_NAMES as [string, ...string[]])
        .optional()
        .describe(`Specific topic to retrieve. Options: ${ALL_TOPIC_NAMES.join(", ")}. Omit for all.`),
    },
    async ({ topic }) => {
      if (topic) {
        const text = TOPICS[topic];
        return { content: [{ type: "text" as const, text }] };
      }

      // Return all topics
      const text = Object.entries(TOPICS).map(([, v]) => v).join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
