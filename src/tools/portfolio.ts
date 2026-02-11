/**
 * Tool: get_portfolio
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CHAIN_ENUM, EVM_ADDRESS, API_NETWORKS, resolveNetwork } from "../config.js";
import type { SpectraPt } from "../types.js";
import { fetchSpectra } from "../api.js";
import { formatUsd, formatPositionSummary, slimPt } from "../formatters.js";
import { dual } from "./dual.js";

export function register(server: McpServer): void {
  server.tool(
    "get_portfolio",
    `Get wallet positions on Spectra for a specific address.
Returns PT, YT, and LP balances with USD values, claimable yield,
and current rates. Queries a single chain or all chains.
Use this to understand what a wallet currently holds on Spectra.

Protocol context:
- Depositing IBT always mints BOTH PT and YT in equal amounts. If a wallet holds
  YT but no PT, it sold or LPed its PT. If it holds PT but no YT, it sold its YT.
- PT + YT = 1 underlying at maturity. This identity is fundamental to all strategies.
- The balance ratios reveal the strategy:
    * High YT, low PT → leveraged yield bull (mint + sell PT loop)
    * High PT, low YT → fixed-rate lock (sold YT or never minted)
    * High LP, low PT/YT → pure liquidity provider
    * Balanced PT + YT → recently minted, hasn't taken a directional position yet
- When investigating a strategy, ALWAYS cross-reference portfolio with
  get_pool_activity. Activity shows the HOW (transaction patterns), portfolio
  shows the WHAT (resulting position). Neither alone tells the full story.
- Strategies often span multiple wallets. If get_pool_activity shows concentrated
  activity from several addresses, check each one to build the full picture.`,
    {
      address: EVM_ADDRESS.describe("The wallet address (0x...)"),
      chain: CHAIN_ENUM
        .optional()
        .describe("Specific chain to query. Omit to scan all chains."),
    },
    async ({ address, chain }) => {
      try {
        const networks = chain
          ? [resolveNetwork(chain)]
          : API_NETWORKS;

        type Position = { pos: SpectraPt; chain: string };
        const failedChains: string[] = [];

        const portfolioResults = await Promise.allSettled(
          networks.map(async (net): Promise<Position[]> => {
            const raw = await fetchSpectra(`/${net}/portfolio/${address}`) as any;
            const items = Array.isArray(raw) ? raw : raw?.data || [];
            return items.map((pos: SpectraPt) => ({ pos, chain: net }));
          })
        );

        // Collect results and track which chains failed
        const allPositions: Position[] = [];
        portfolioResults.forEach((result, i) => {
          if (result.status === "fulfilled") {
            allPositions.push(...result.value);
          } else {
            failedChains.push(networks[i]);
          }
        });

        const chainWarning = failedChains.length > 0
          ? `\nNote: ${failedChains.length} chain(s) failed to respond (${failedChains.join(", ")}). Results may be partial.\n`
          : "";

        // Format only positions with non-zero balances, collecting totalValue from each
        let totalPortfolioValue = 0;
        const summaries: string[] = [];

        for (const { pos, chain: c } of allPositions) {
          const result = formatPositionSummary(pos, c);
          if (result) {
            summaries.push(result.text);
            totalPortfolioValue += result.totalValue;
          }
        }

        if (summaries.length === 0) {
          const scope = chain || "any chain";
          const text = `No active Spectra positions found for ${address} on ${scope}.${chainWarning}`;
          return dual(text, {
            tool: "get_portfolio",
            ts: Math.floor(Date.now() / 1000),
            params: { address, chain },
            data: { positions: [], totalPortfolioValue: 0, failedChains },
          });
        }

        const scope = chain || "all chains";
        const header = `Spectra Portfolio for ${address} (${scope}):\n` +
          `Total Positions: ${summaries.length} | Estimated Value: ${formatUsd(totalPortfolioValue)}\n`;
        const text = header + chainWarning + "\n" + summaries.join("\n\n");

        return dual(text, {
          tool: "get_portfolio",
          ts: Math.floor(Date.now() / 1000),
          params: { address, chain },
          data: { positions: allPositions.map(p => ({ pt: slimPt(p.pos), chain: p.chain })), totalPortfolioValue, failedChains },
        });
      } catch (e: any) {
        return dual(`Error fetching portfolio: ${e.message}`, { tool: "get_portfolio", ts: Math.floor(Date.now() / 1000), params: { address, chain }, data: { error: e.message } }, { isError: true });
      }
    }
  );
}
