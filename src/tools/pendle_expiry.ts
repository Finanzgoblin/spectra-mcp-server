/**
 * Tool: pendle_list_expiring_markets
 *
 * Scans all Pendle chains for markets approaching maturity.
 * The Pendle equivalent of spectra_list_expiring_pools.
 * Groups results by urgency: CRITICAL (≤7d), WARNING (≤14d), ALERT (≤threshold).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES } from "../config.js";
import { scanAllPendleMarkets, fetchPendleMarkets } from "../api.js";
import type { PendleMarket } from "../types.js";
import { formatPct, formatUsd, pendleDaysToMaturity } from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

interface ExpiringMarket {
  name: string;
  chain: string;
  daysLeft: number;
  expiryDate: string;
  marketAddress: string;
  ptAddress: string;
  impliedApy: number;
  lpApy: number;
  tvlUsd: number;
  liquidityUsd: number;
}

export function register(server: McpServer): void {
  server.tool(
    "pendle_list_expiring_markets",
    `Scan Pendle chains for markets approaching maturity.

Groups results by urgency:
- CRITICAL (≤7d): Immediate action required — redeem or rollover
- WARNING (≤14d): Plan rollover within days
- ALERT (≤threshold): Monitor and prepare

This is the Pendle equivalent of spectra_list_expiring_pools. Useful for:
- Portfolio managers who need to plan rollovers
- Curators monitoring MetaVault positions that include Pendle PTs
- Traders looking for near-maturity convergence plays

Use pendle_get_market_details for full market info on an expiring market.
Use mv_plan_rollover to plan rollovers for MetaVault positions.
Use pendle_get_yield_curve to find replacement maturities.`,
    {
      threshold_days: z
        .number()
        .min(1)
        .max(365)
        .default(21)
        .describe("Show markets expiring within this many days (default 21)"),
      chain: PENDLE_CHAIN_ENUM
        .optional()
        .describe("Limit to a specific chain. Omit to scan all Pendle chains."),
      min_tvl_usd: z
        .number()
        .default(0)
        .describe("Minimum TVL to include (default 0 — show all)"),
      compact: z
        .boolean()
        .default(false)
        .describe("One-line-per-market output"),
    },
    async ({ threshold_days, chain, min_tvl_usd, compact }) => {
      try {
        let allMarkets: Array<{ market: PendleMarket; chain: string }>;
        let failedChains: string[] = [];

        if (chain) {
          const result = await fetchPendleMarkets(chain);
          if (!result.ok) failedChains.push(chain);
          allMarkets = result.markets.map((m) => ({ market: m, chain }));
        } else {
          // Scan with no filters to catch low-TVL expiring markets
          const scan = await scanAllPendleMarkets({ min_tvl_usd: 0, min_liquidity_usd: 0 });
          allMarkets = scan.markets;
          failedChains = scan.failedChains;
        }

        // Filter to expiring markets within threshold
        const now = Date.now();
        const expiring: ExpiringMarket[] = [];

        for (const { market, chain: c } of allMarkets) {
          const expiryMs = new Date(market.expiry).getTime();
          if (expiryMs <= now) continue; // already expired
          const days = pendleDaysToMaturity(market.expiry);
          if (days > threshold_days) continue;

          const d = market.details;
          if ((d.totalTvl || 0) < min_tvl_usd) continue;

          expiring.push({
            name: market.name,
            chain: c,
            daysLeft: days,
            expiryDate: market.expiry.split("T")[0],
            marketAddress: market.address,
            ptAddress: market.pt,
            impliedApy: (d.impliedApy || 0) * 100,
            lpApy: (d.aggregatedApy || 0) * 100,
            tvlUsd: d.totalTvl || 0,
            liquidityUsd: d.liquidity || 0,
          });
        }

        // Sort by days left ascending (most urgent first)
        expiring.sort((a, b) => a.daysLeft - b.daysLeft);

        // Group by urgency
        const critical = expiring.filter((e) => e.daysLeft <= 7);
        const warning = expiring.filter((e) => e.daysLeft > 7 && e.daysLeft <= 14);
        const alert = expiring.filter((e) => e.daysLeft > 14);

        const scope = chain ? PENDLE_CHAIN_NAMES[chain] || chain : "All Pendle Chains";
        const lines: string[] = [];
        lines.push(`== Pendle Expiring Markets: ${scope} ==`);
        lines.push(`  Threshold: ${threshold_days} days | Found: ${expiring.length} market(s)`);
        if (failedChains.length > 0) lines.push(`  Failed chains: ${failedChains.join(", ")}`);
        lines.push("");

        if (expiring.length === 0) {
          lines.push(`No Pendle markets expiring within ${threshold_days} days.`);
          lines.push(`Try increasing threshold_days or removing chain filter.`);
          const text = lines.join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        const formatEntry = (e: ExpiringMarket, rank: number): string => {
          if (compact) {
            return `  #${rank} ${e.name} (${PENDLE_CHAIN_NAMES[e.chain] || e.chain}) | ${e.daysLeft}d | Impl ${formatPct(e.impliedApy)} | LP ${formatPct(e.lpApy)} | TVL ${formatUsd(e.tvlUsd)} | ${e.marketAddress.slice(0, 10)}...`;
          }
          const entryLines: string[] = [];
          entryLines.push(`  #${rank} ${e.name} (${PENDLE_CHAIN_NAMES[e.chain] || e.chain})`);
          entryLines.push(`    Expiry: ${e.expiryDate} (${e.daysLeft} days)`);
          entryLines.push(`    Implied APY: ${formatPct(e.impliedApy)} | LP APY: ${formatPct(e.lpApy)}`);
          entryLines.push(`    TVL: ${formatUsd(e.tvlUsd)} | Liquidity: ${formatUsd(e.liquidityUsd)}`);
          entryLines.push(`    Market: ${e.marketAddress}`);
          return entryLines.join("\n");
        };

        let rank = 1;

        if (critical.length > 0) {
          lines.push(`--- CRITICAL (≤7 days) — ${critical.length} market(s) ---`);
          for (const e of critical) {
            lines.push(formatEntry(e, rank++));
            if (!compact) lines.push("");
          }
        }

        if (warning.length > 0) {
          lines.push(`--- WARNING (8-14 days) — ${warning.length} market(s) ---`);
          for (const e of warning) {
            lines.push(formatEntry(e, rank++));
            if (!compact) lines.push("");
          }
        }

        if (alert.length > 0) {
          lines.push(`--- ALERT (15-${threshold_days} days) — ${alert.length} market(s) ---`);
          for (const e of alert) {
            lines.push(formatEntry(e, rank++));
            if (!compact) lines.push("");
          }
        }

        lines.push(`--- Next Steps ---`);
        lines.push(`  • Market detail: pendle_get_market_details(chain=CHAIN, market_address=ADDR)`);
        lines.push(`  • Find replacements: pendle_get_yield_curve(underlying="ASSET") for available maturities`);
        lines.push(`  • Rollover planning: mv_plan_rollover(chain=CHAIN, metavault_address=ADDR)`);
        lines.push(`  • Spectra expiring: spectra_list_expiring_pools() for Spectra-side monitoring`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error scanning expiring markets: ${err?.message || String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
