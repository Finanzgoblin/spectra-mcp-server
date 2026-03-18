/**
 * Tool: pendle_get_best_fixed_yields
 *
 * Multi-chain scan for the best Pendle fixed-rate opportunities.
 * The Pendle equivalent of spectra_get_best_fixed_yields.
 * Ranks by implied APY (the fixed rate a PT buyer locks in at purchase).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES } from "../config.js";
import { scanAllPendleMarkets } from "../api.js";
import {
  formatPct,
  formatUsd,
  pendleDaysToMaturity,
  formatPendleMarketCompact,
} from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

export function register(server: McpServer): void {
  server.tool(
    "pendle_get_best_fixed_yields",
    `Find the best fixed-rate (implied APY) opportunities across all Pendle chains.

Scans all Pendle-supported chains and ranks markets by their implied APY — the fixed
rate you lock in when buying PT at a discount. This is the Pendle equivalent of
spectra_get_best_fixed_yields.

Unlike pendle_list_markets (which shows a single chain), this scans all chains at once
and focuses on the PT buyer's perspective: which markets offer the highest fixed rate?

Unlike pendle_scan_opportunities (capital-aware), this is a quick raw-APY ranking
without price impact analysis. Use it for initial screening, then drill into
specific markets with pendle_get_market_details or size with pendle_scan_opportunities.

Pendle chains: ${PENDLE_CHAIN_KEYS.map((k) => PENDLE_CHAIN_NAMES[k]).join(", ")}`,
    {
      chain: PENDLE_CHAIN_ENUM.optional().describe(
        "Limit to a specific chain. Omit to scan all Pendle chains."
      ),
      asset_filter: z.string().max(100).optional().describe(
        "Filter by underlying asset (e.g., 'USDC', 'ETH', 'stETH'). Matches market name."
      ),
      min_tvl_usd: z.number().default(10000).describe("Minimum TVL in USD"),
      min_liquidity_usd: z.number().default(5000).describe("Minimum pool liquidity in USD"),
      min_days_to_maturity: z.number().min(0).default(7).describe(
        "Minimum days to maturity (default 7 — skip very short pools)"
      ),
      top_n: z.number().min(1).max(50).default(15).describe("Number of results (default 15)"),
    },
    async ({ chain, asset_filter, min_tvl_usd, min_liquidity_usd, min_days_to_maturity, top_n }) => {
      try {
        const scan = await scanAllPendleMarkets({
          min_tvl_usd,
          min_liquidity_usd,
          asset_filter,
        });

        // Filter by maturity and optionally by chain
        let markets = scan.markets.filter(({ market, chain: c }) => {
          if (chain && c !== chain) return false;
          const days = pendleDaysToMaturity(market.expiry);
          return days >= min_days_to_maturity;
        });

        // Sort by implied APY descending
        markets.sort((a, b) =>
          (b.market.details.impliedApy || 0) - (a.market.details.impliedApy || 0)
        );

        const capped = markets.slice(0, top_n);

        if (capped.length === 0) {
          const scope = chain ? `on ${PENDLE_CHAIN_NAMES[chain] || chain}` : "across all Pendle chains";
          const text = [
            `No Pendle fixed-yield opportunities found ${scope}.`,
            `Filters: min TVL ${formatUsd(min_tvl_usd)}, min liquidity ${formatUsd(min_liquidity_usd)}, min maturity ${min_days_to_maturity}d`,
            asset_filter ? `Asset filter: ${asset_filter}` : "",
            ``,
            `Try lowering min_tvl_usd or min_liquidity_usd.`,
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        const lines: string[] = [];
        const scope = chain ? PENDLE_CHAIN_NAMES[chain] || chain : "All Chains";
        lines.push(`== Pendle Best Fixed Yields: ${scope} ==`);
        lines.push(`  Found: ${capped.length} market(s)${markets.length > top_n ? ` (showing top ${top_n} of ${markets.length})` : ""}`);
        if (asset_filter) lines.push(`  Asset filter: ${asset_filter}`);
        lines.push(``);

        // Compact ranked output
        for (let i = 0; i < capped.length; i++) {
          const { market, chain: c } = capped[i];
          const d = market.details;
          const days = pendleDaysToMaturity(market.expiry);
          const impliedPct = formatPct(d.impliedApy * 100);
          const varPct = formatPct(d.underlyingApy * 100);
          const lpPct = formatPct(d.aggregatedApy * 100);
          const tvl = formatUsd(d.totalTvl);
          const liq = formatUsd(d.liquidity);

          lines.push(`  #${i + 1} ${market.name} (${PENDLE_CHAIN_NAMES[c] || c})`);
          lines.push(`     Fixed: ${impliedPct}  |  Variable: ${varPct}  |  LP: ${lpPct}`);
          lines.push(`     TVL: ${tvl}  |  Liquidity: ${liq}  |  Maturity: ${days}d`);
          lines.push(`     Market: ${market.address}`);
          lines.push(``);
        }

        // Flag when top result's liquidity is much lower than others (headline APY trap)
        if (capped.length >= 3) {
          const topLiq = capped[0].market.details.liquidity || 0;
          const otherLiqs = capped.slice(1).map(c => c.market.details.liquidity || 0).filter(l => l > 0);
          const medianOtherLiq = otherLiqs.length > 0
            ? [...otherLiqs].sort((a, b) => a - b)[Math.floor(otherLiqs.length / 2)]
            : 0;
          if (topLiq > 0 && medianOtherLiq > 0 && topLiq < medianOtherLiq * 0.25) {
            lines.push(`  Note: #1 result has ${formatUsd(topLiq)} liquidity vs ${formatUsd(medianOtherLiq)} median.`);
            lines.push(`  High headline APY in thin pools often inverts once real capital enters.`);
            lines.push(`  Use pendle_scan_opportunities(capital_usd=AMOUNT) to see effective APY at your size.`);
            lines.push(``);
          }
        }

        if (scan.failedChains.length > 0) {
          lines.push(`  Failed chains: ${scan.failedChains.join(", ")}`);
        }

        lines.push(`--- Next Steps ---`);
        lines.push(`  • Market detail: pendle_get_market_details(chain=CHAIN, market_address=ADDR)`);
        lines.push(`  • Capital-aware sizing: pendle_scan_opportunities(capital_usd=AMOUNT)`);
        lines.push(`  • Compare with Spectra: mv_compare_yield(chain=CHAIN, asset_filter="ASSET")`);
        lines.push(`  • Cross-protocol scan: mv_scan_curator_opportunities(capital_usd=AMOUNT)`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
