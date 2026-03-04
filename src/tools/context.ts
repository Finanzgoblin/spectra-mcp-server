/**
 * Tool: get_protocol_context
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
  Always cross-reference with get_portfolio to see resulting holdings.`,

  "position_analysis": `Reading Wallet Strategy from Holdings
- Minting always produces equal PT and YT. Any imbalance means tokens were traded.
- get_portfolio shows Position Shape as a balance ratio (e.g., "YT/PT 4:1" or "PT only").
- IMPORTANT: Each observable position shape has MULTIPLE valid explanations.
  get_pool_activity now presents these as competing interpretation branches (A/B/C).
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
- OBSERVATION COVERAGE: get_pool_activity now quantifies its own blind spots:
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
- Use scan_opportunities for capital-aware looping analysis across all chains.`,

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
  Use get_looping_strategy() to model leverage levels and break-even borrow rates.
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
  is higher than shown. Use quote_trade() for exact on-chain quotes before acting.
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
  when comparing IBT variable rates (APR) against fixed rates (APY) in compare_yield.
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
  Without any veSPECTRA, boost = 1x (base rate). Use get_ve_info to compute scenarios.`,

  "workflow_routing": `Workflow Routing — How tools compose for common goals

If you're new to Spectra or unsure which tool to start with:
  Use scan_curator_opportunities(capital_usd=YOUR_AMOUNT) — broadest view.
  It scans BOTH Spectra and Pendle across all chains with capital-aware metrics.
  scan_opportunities is Spectra-only and may return far fewer results at smaller capital sizes.
  IMPORTANT: Effective APY in scan results is a conservative lower bound (constant-product
  impact model). Real Curve StableSwap-NG pools are significantly more capital-efficient —
  actual effective APY is higher than shown. Always verify top picks with quote_trade().

Goal: "Find the best yield for my capital"
  Start with: scan_opportunities(capital_usd=YOUR_AMOUNT)
  This computes price impact at your size, effective APY, and Morpho looping.
  Different from get_best_fixed_yields which ranks by raw APY without capital awareness.
  The two tools intentionally disagree on "best" — raw APY vs effective APY are different
  questions. Both are valid depending on your assumptions about capital size and slippage.

Goal: "Analyze a wallet's strategy"
  Start with: get_portfolio(address) to see position shapes and balances
  Then: get_pool_activity(chain, pool_address, address) on pools where they hold positions
  Then: get_address_activity(address) for cross-pool pattern discovery
  Portfolio shows WHAT they hold; activity shows HOW they got there. Neither alone tells
  the full story — always cross-reference both.
  CHECK OBSERVATION COVERAGE in get_pool_activity output. If value coverage is low,
  most of the address's behavior is invisible. Do not present high-confidence strategy
  assessments when coverage is below 50%. Size conviction to coverage, not to the
  coherence of the interpretation.

Goal: "Evaluate a specific opportunity in depth"
  Start with: get_pt_details(chain, pt_address) for base data
  Then: compare_yield(chain, pt_address) for fixed vs variable spread
  Then: get_looping_strategy(chain, pt_address) if Morpho market exists
  Then: quote_trade(chain, pt_address, amount, side) for entry cost
  Then: simulate_portfolio_after_trade(...) to preview the result

Goal: "Find YT mispricing"
  Start with: scan_yt_arbitrage(capital_usd) for spread-sorted opportunities
  YT arbitrage is a different axis than PT yield optimization. Large spreads could mean
  real mispricing, IBT APR about to drop, or a liquidity event. The tool surfaces the
  spread; distinguishing the cause requires agent judgment.

Goal: "Optimize governance position / veSPECTRA"
  Start with: get_ve_info(ve_balance, capital) for boost scenarios
  Then: scan_opportunities(capital, ve_spectra_balance) for boosted rankings
  veSPECTRA boost only affects gauge-enabled LP positions, not PT or YT directly.

Goal: "Model a curator / MetaVault strategy"
  Start with: get_curator_dashboard(chain, metavault_address) for operational overview
  Then: model_metavault_strategy(...) for leverage modeling
  Compare against: get_looping_strategy for raw PT looping baseline
  The double-loop premium shows when MetaVault leverage beats raw PT looping.

Goal: "Find the best yield across Spectra AND Pendle for a MetaVault"
  Start with: scan_curator_opportunities(capital_usd=YOUR_AMOUNT)
  This scans BOTH protocols with capital-aware metrics and maturity-aware matching.
  Then: compare_pendle_spectra(chain=CHAIN, asset_filter="ASSET") for detailed head-to-head
  Then: get_curator_dashboard(chain, metavault_address) to check current allocations
  Then: model_metavault_strategy(chain, metavault_address) to model blended allocation
  Key difference from scan_opportunities: scan_opportunities is Spectra-only.
  scan_curator_opportunities includes Pendle markets. The two tools CAN disagree on
  "best" because they cover different opportunity sets. Both are valid.

Goal: "Compare Spectra vs Pendle on a specific chain"
  Start with: compare_pendle_spectra(chain=CHAIN) for maturity-aware head-to-head
  Then: list_pendle_markets(chain=CHAIN) for full Pendle data
  Then: list_pools(chain=CHAIN) for Spectra data
  Matching is by underlying asset + maturity proximity (exact ≤7d, close ≤30d, loose ≤90d).
  Pendle-only chains (${Object.keys(PENDLE_CHAIN_IDS).filter((k) => !SUPPORTED_CHAINS[k]).map((k) => PENDLE_CHAIN_NAMES[k]).join(", ")}) represent Spectra expansion opportunities.

Four discovery tools and when to use each:
  get_best_fixed_yields — headline rates across all chains (no capital adjustment)
  scan_opportunities — capital-aware effective APY with Morpho looping (Spectra-only)
  scan_curator_opportunities — cross-protocol (Spectra + Pendle) capital-aware scanner
  scan_yt_arbitrage — YT spread opportunities (rate conviction bets)
  These four intentionally produce different rankings. The disagreement is a feature.`,
};

const ALL_TOPIC_NAMES = Object.keys(TOPICS);

export function register(server: McpServer): void {
  server.tool(
    "get_protocol_context",
    `Get essential Spectra protocol mechanics needed for correct reasoning.
Returns concise explanations of how PT/YT work, how Router batching affects
pool activity interpretation, how to read wallet strategies from holdings,
how looping works, how to enter positions, and how tools compose into workflows.

Covers mechanics that are easy to misinterpret without context — for example,
SELL_PT in pool activity could be a flash-mint to acquire YT, not a PT sale.

Use topic "workflow_routing" to learn which tools to call for a given goal
(yield optimization, wallet analysis, YT arbitrage, etc.) and how they feed
into each other. Recommended starting point for agents new to the tool set.

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
