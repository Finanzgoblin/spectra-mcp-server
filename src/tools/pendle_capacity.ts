/**
 * Tool: pendle_get_market_capacity
 *
 * Multi-size impact curve for a Pendle market.
 * The Pendle equivalent of spectra_get_pool_capacity.
 * Uses the Pendle logit AMM model to show how price impact and effective APY
 * degrade at increasing capital sizes.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES, EVM_ADDRESS } from "../config.js";
import { fetchPendleMarketDetail } from "../api.js";
import {
  formatUsd,
  formatPct,
  pendleDaysToMaturity,
  estimatePendlePriceImpact,
} from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

export function register(server: McpServer): void {
  server.tool(
    "pendle_get_market_capacity",
    `Analyze a Pendle market's capacity by computing price impact at increasing capital sizes.

Shows how price impact and effective APY degrade as capital grows, helping curators
find the sweet spot (max capital with acceptable impact) and the exhaustion point
(where APY collapses).

Uses Pendle's logit AMM model (conservative scalarRoot=50) which accounts for
time-decay pricing. Near maturity, the AMM becomes more capital-efficient,
so impact is lower than constant-product estimates.

This is the Pendle equivalent of spectra_get_pool_capacity.

Use pendle_get_market_details for full market information.
Use pendle_scan_opportunities for capital-aware ranking across all markets.`,
    {
      chain: PENDLE_CHAIN_ENUM.describe("The blockchain network"),
      market_address: EVM_ADDRESS.describe("The Pendle market/pool contract address"),
      steps: z
        .number()
        .int()
        .min(1)
        .max(12)
        .default(8)
        .describe("Number of capital tiers in the ladder (default 8, max 12)"),
      max_capital_usd: z
        .number()
        .positive()
        .default(1_000_000)
        .describe("Upper bound of the capital ladder in USD (default $1,000,000)"),
    },
    async ({ chain, market_address, steps, max_capital_usd }) => {
      try {
        const market = await fetchPendleMarketDetail(chain, market_address);

        if (!market) {
          return {
            content: [{
              type: "text" as const,
              text: `Pendle market ${market_address} not found on ${PENDLE_CHAIN_NAMES[chain] || chain}.\nUse pendle_list_markets(chain="${chain}") to discover markets.`,
            }],
            isError: true,
          };
        }

        const d = market.details;
        const days = pendleDaysToMaturity(market.expiry);
        const impliedApy = (d.impliedApy || 0) * 100;
        const poolLiqUsd = d.liquidity || 0;
        const totalPt = d.totalPt || 0;
        const totalSy = d.totalSy || 0;

        if (poolLiqUsd <= 0) {
          return {
            content: [{
              type: "text" as const,
              text: `Market ${market.name} has zero liquidity — cannot build capacity curve.`,
            }],
            isError: true,
          };
        }

        // Generate log-spaced capital tiers (deduplicate after rounding)
        const MIN_TIER_USD = 1_000;
        const minLog = Math.log10(MIN_TIER_USD);
        const maxLog = Math.log10(max_capital_usd);
        let tiers: number[] = [];
        for (let i = 0; i < steps; i++) {
          const log = steps === 1 ? maxLog : minLog + (maxLog - minLog) * i / (steps - 1);
          tiers.push(Math.round(10 ** log));
        }
        tiers = [...new Set(tiers)];

        // Compute impact at each tier
        interface TierResult {
          capitalUsd: number;
          impactPct: number;
          effectiveApy: number;
        }
        const results: TierResult[] = [];

        for (const capitalUsd of tiers) {
          const impactFrac = estimatePendlePriceImpact(capitalUsd, poolLiqUsd, totalPt, totalSy, days);
          const impactPct = impactFrac * 100;

          const annualizedImpact = days > 0
            ? impactFrac * (365 / days) * 100
            : impactFrac * 100;
          const effectiveApy = impliedApy - annualizedImpact;

          results.push({ capitalUsd, impactPct, effectiveApy });
        }

        // Find sweet spot (largest capital where impact < 1%)
        let sweetSpot: TierResult | null = null;
        for (const r of results) {
          if (r.impactPct < 1) sweetSpot = r;
        }

        // Find exhaustion point (first capital where impact > 5% or APY goes negative)
        let exhaustion: TierResult | null = null;
        for (const r of results) {
          if (r.impactPct > 5 || r.effectiveApy < 0) {
            exhaustion = r;
            break;
          }
        }

        // Format output
        const expiryDate = market.expiry.split("T")[0];
        const lines: string[] = [];
        lines.push(`Market Capacity Curve: ${market.name} (${PENDLE_CHAIN_NAMES[chain] || chain})`);
        lines.push(`Maturity: ${expiryDate} (${days}d) | Implied APY: ${formatPct(impliedApy)} | Pool Liquidity: ${formatUsd(poolLiqUsd)}`);
        lines.push(`Reserves: ${totalPt.toLocaleString("en-US", { maximumFractionDigits: 0 })} PT / ${totalSy.toLocaleString("en-US", { maximumFractionDigits: 0 })} SY`);
        lines.push("");

        const hdr = "Capital (USD)  | Impact (%) | Eff. APY (%)";
        lines.push(hdr);
        lines.push("─".repeat(hdr.length));

        for (const r of results) {
          const capStr = formatUsd(r.capitalUsd).padStart(13);
          const impStr = formatPct(r.impactPct).padStart(10);
          const apyStr = formatPct(r.effectiveApy).padStart(12);
          const warn = r.impactPct > 5 ? " !!" : r.impactPct > 1 ? " !" : "";
          lines.push(`${capStr}  | ${impStr} | ${apyStr}${warn}`);
        }

        lines.push("");

        if (sweetSpot) {
          lines.push(`Sweet spot: ~${formatUsd(sweetSpot.capitalUsd)} (impact ${formatPct(sweetSpot.impactPct)}, effective APY ~${formatPct(sweetSpot.effectiveApy)})`);
        } else {
          lines.push("Sweet spot: Even $1K exceeds 1% impact — market is very thin.");
        }

        if (exhaustion) {
          lines.push(`Exhaustion: ~${formatUsd(exhaustion.capitalUsd)} (impact ${formatPct(exhaustion.impactPct)}, APY drops to ${formatPct(exhaustion.effectiveApy)})`);
        } else {
          lines.push(`No exhaustion within ${formatUsd(max_capital_usd)} range — market has deep liquidity.`);
        }

        lines.push("");
        lines.push("Note: Uses Pendle logit AMM model with conservative scalarRoot=50.");
        lines.push("Real impact is typically lower (stablecoin pools use scalarRoot 50-200).");
        lines.push("Each tier is quoted independently (not cumulative).");

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error building capacity curve: ${err?.message || String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
