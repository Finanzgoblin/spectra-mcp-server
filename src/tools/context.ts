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
};

const ALL_TOPIC_NAMES = Object.keys(TOPICS);

export function register(server: McpServer): void {
  server.tool(
    "get_protocol_context",
    `Get essential Spectra protocol mechanics needed for correct reasoning.
Returns concise explanations of how PT/YT work, how Router batching affects
pool activity interpretation, how to read wallet strategies from holdings,
and how looping works.

Covers mechanics that are easy to misinterpret without context — for example,
SELL_PT in pool activity could be a flash-mint to acquire YT, not a PT sale.

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
