/**
 * Tool: merkl_list_campaigns
 *
 * Standalone Merkl campaign discovery — find incentive campaigns by chain.
 * Surfaces subsidized rates, reward tokens, daily rewards, and campaign types
 * across all live Merkl campaigns. Essential for understanding the TRUE cost
 * of borrowing/lending and the TRUE yield of LP positions.
 *
 * Observation boundary: Merkl campaigns can make borrow costs NEGATIVE (borrowers
 * get paid) and dramatically change looping economics. Without this tool, agents
 * see only the base protocol rates and miss the subsidy layer entirely.
 *
 * Dissolution condition: If Merkl campaigns are natively surfaced by all protocol
 * tools (Morpho, Spectra, Pendle) with sufficient granularity, this standalone
 * tool adds no value. Remove it when the integration layer makes it redundant.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, SUPPORTED_CHAINS, resolveNetwork } from "../config.js";
import { fetchMerklCampaigns } from "../api.js";
import type { MerklCampaign } from "../types.js";
import { formatPct, formatUsd } from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "merkl_list_campaigns",
    `Discover live Merkl incentive campaigns on a given chain.

Returns all active Merkl campaigns with APR, reward tokens, daily rewards, TVL,
and campaign type. Essential for understanding subsidized rates:
- Morpho borrow campaigns: Merkl can PAY borrowers, making net borrow cost negative
- LP campaigns: additional yield on top of base pool APR
- HOLD campaigns: rewards for simply holding a token

Use this to verify whether a borrow rate is subsidized, find new incentive
opportunities, or understand the full yield stack of any position.

Campaign types: CLAMM (concentrated LP), ERC20LOGPROCESSOR (Morpho/lending),
MORPHOVAULT, etc. Action types: POOL (LP only), HOLD (token holders), BORROW, LEND.

When an agent says "no subsidy exists" — check here first. The subsidy layer
is invisible to protocol-native tools unless explicitly integrated.`,
    {
      chain: CHAIN_ENUM
        .describe("Chain to search for Merkl campaigns"),
      asset_filter: z
        .string()
        .max(100)
        .optional()
        .describe("Filter campaigns by asset symbol or name (case-insensitive substring match). E.g., 'ynRWAx', 'USDC', 'Morpho'."),
      min_apr: z
        .number()
        .default(0)
        .describe("Minimum campaign APR to include (default 0)"),
      top_n: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Number of campaigns to return (default 20, max 100)"),
    },
    async ({ chain, asset_filter, min_apr, top_n }) => {
      try {
        const network = resolveNetwork(chain);
        const chainConfig = SUPPORTED_CHAINS[network];
        if (!chainConfig) {
          return { content: [{ type: "text" as const, text: `Unknown chain: ${chain}` }], isError: true };
        }

        const { campaigns: campaignMap, available } = await fetchMerklCampaigns(chainConfig.id);

        if (!available) {
          return {
            content: [{
              type: "text" as const,
              text: `Merkl API unavailable for ${chain} (chainId ${chainConfig.id}). Campaigns may exist but cannot be confirmed. Try again later.`,
            }],
          };
        }

        // Flatten all campaigns
        let allCampaigns: MerklCampaign[] = [];
        for (const campaigns of campaignMap.values()) {
          allCampaigns.push(...campaigns);
        }

        // Filter by APR
        if (min_apr > 0) {
          allCampaigns = allCampaigns.filter(c => c.apr >= min_apr);
        }

        // Filter by asset name/symbol
        if (asset_filter) {
          const filterLower = asset_filter.toLowerCase();
          allCampaigns = allCampaigns.filter(c => {
            const nameMatch = c.name.toLowerCase().includes(filterLower);
            const tokenMatch = c.rewardTokens.some(t => t.toLowerCase().includes(filterLower));
            const idMatch = c.identifier.toLowerCase().includes(filterLower);
            return nameMatch || tokenMatch || idMatch;
          });
        }

        // Sort by APR descending
        allCampaigns.sort((a, b) => b.apr - a.apr);

        // Limit results
        const displayed = allCampaigns.slice(0, top_n);

        if (displayed.length === 0) {
          const lines = [
            `No live Merkl campaigns found on ${chain}${asset_filter ? ` matching "${asset_filter}"` : ""}${min_apr > 0 ? ` with APR >= ${min_apr}%` : ""}.`,
            ``,
            `--- Tensions ---`,
            `⚡ No campaigns now doesn't mean no campaigns ever. Merkl campaigns are created`,
            `  by protocols/DAOs and can start/end at any time. This is a snapshot.`,
            `⚡ The asset might have campaigns on other chains. Try other chain values.`,
          ];
          if (asset_filter) {
            lines.push(`• Try without filter: merkl_list_campaigns(chain="${chain}") to see all campaigns`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        // Format output
        const totalDailyRewards = displayed.reduce((sum, c) => sum + c.dailyRewards, 0);
        const headerLines = [
          `Found ${displayed.length} of ${allCampaigns.length} live Merkl campaign(s) on ${chain}${asset_filter ? ` matching "${asset_filter}"` : ""}:`,
          `  Total daily rewards (displayed): ${formatUsd(totalDailyRewards)}`,
          ``,
        ];

        const campaignLines = displayed.map((c, i) => {
          const parts = [
            `${i + 1}. ${c.name || c.identifier}`,
            `   APR: ${formatPct(c.apr)}%  |  Type: ${c.type}  |  Action: ${c.action}`,
            `   Reward tokens: ${c.rewardTokens.length > 0 ? c.rewardTokens.join(", ") : "unknown"}`,
          ];
          if (c.dailyRewards > 0) parts.push(`   Daily rewards: ${formatUsd(c.dailyRewards)}`);
          if (c.tvl > 0) parts.push(`   Campaign TVL: ${formatUsd(c.tvl)}`);
          parts.push(`   Target: ${c.identifier}`);

          // Surface action-specific interpretation
          if (c.action === "POOL") {
            parts.push(`   ℹ LP-only — YT and PT holders are NOT eligible`);
          } else if (c.action === "BORROW" || c.type === "ERC20LOGPROCESSOR") {
            parts.push(`   ⚡ Borrow subsidy — this REDUCES net borrow cost (can make it negative)`);
          }

          return parts.join("\n");
        });

        const footer = [
          ``,
          `--- Interpretation ---`,
          `• Borrow campaigns (action=BORROW or type=ERC20LOGPROCESSOR): subtract APR from borrow rate`,
          `  for net cost. If subsidy > borrow rate, net cost is NEGATIVE (borrowers get paid).`,
          `• POOL campaigns: add to LP base APR. Only for LPs, not PT/YT holders.`,
          `• HOLD campaigns: rewards for holding the token. Check eligibility carefully.`,
          `• Daily rewards and APR can change as TVL shifts. Snapshot only.`,
        ];

        const text = headerLines.join("\n") + campaignLines.join("\n\n") + footer.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error fetching Merkl campaigns: ${e.message}` }],
          isError: true,
        };
      }
    }
  );
}
