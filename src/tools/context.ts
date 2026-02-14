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
import { API_NETWORKS, SUPPORTED_CHAINS } from "../config.js";

const TOPICS: Record<string, string> = {

  "pt_yt_mechanics": `PT/YT Mechanics
- Depositing an ERC-4626 IBT into Spectra splits it into PT (Principal Token) + YT (Yield Token).
- PT + YT = 1 underlying at maturity. YT price = 1 - PT price (in underlying terms).
- PT trades at a discount; the discount IS the fixed yield. At maturity, PT redeems 1:1.
- YT gives leveraged variable yield exposure. YT leverage = 1 / YT price in underlying.
- PT trades on Curve StableSwap-NG pools (IBT/PT pairs). YT does NOT trade on the pool directly.`,

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
- Key ratios to reason about:
    YT >> PT: the holder sold or LPed PT after minting
    PT >> YT: the holder sold YT, or bought PT without minting
    LP present with low PT/YT: tokens were absorbed into the pool
    Balanced PT + YT: recently minted, no directional trade yet
- Large activity volume with small current holdings → capital recycled through the position
- Strategies often span multiple wallets — check all concentrated addresses.`,

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

  "workflow_routing": `Workflow Routing — How tools compose for common goals

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
  Start with: model_metavault_strategy(...) with your parameters
  Compare against: get_looping_strategy for raw PT looping baseline
  The double-loop premium shows when MetaVault leverage beats raw PT looping.

Three discovery tools and when to use each:
  get_best_fixed_yields — headline rates across all chains (no capital adjustment)
  scan_opportunities — capital-aware effective APY with Morpho looping analysis
  scan_yt_arbitrage — YT spread opportunities (rate conviction bets)
  These three intentionally produce different rankings. The disagreement is a feature.`,
};

const ALL_TOPIC_NAMES = Object.keys(TOPICS);

export function register(server: McpServer): void {
  server.tool(
    "get_protocol_context",
    `Get essential Spectra protocol mechanics needed for correct reasoning.
Returns concise explanations of how PT/YT work, how Router batching affects
pool activity interpretation, how to read wallet strategies from holdings,
how looping works, and how tools compose into workflows.

Covers mechanics that are easy to misinterpret without context — for example,
SELL_PT in pool activity could be a flash-mint to acquire YT, not a PT sale.

Use topic "workflow_routing" to learn which tools to call for a given goal
(yield optimization, wallet analysis, YT arbitrage, etc.) and how they feed
into each other. Recommended starting point for agents new to the tool set.

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
