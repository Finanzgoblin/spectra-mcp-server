/**
 * Tool: pendle_scan_yt_arbitrage
 *
 * Scans Pendle markets for YT (Yield Token) mispricing opportunities.
 * The Pendle equivalent of spectra_scan_yt_arbitrage.
 *
 * Compares the underlying's variable APY against the rate implied by the
 * YT's market price. When these diverge, an arbitrage opportunity may exist.
 *
 * Unlike Spectra YT (which trades indirectly via Router flash-mint/redeem),
 * Pendle YT trades directly on the Pendle AMM, making execution simpler.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES } from "../config.js";
import { scanAllPendleMarkets, fetchPendleMarkets } from "../api.js";
import type { PendleMarket } from "../types.js";
import {
  formatPct,
  formatUsd,
  pendleDaysToMaturity,
  estimatePendlePriceImpact,
} from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

interface PendleYtArb {
  name: string;
  chain: string;
  marketAddress: string;
  ptAddress: string;
  ytAddress: string;
  daysToMaturity: number;
  expiryDate: string;
  underlyingApy: number;   // % — what the underlying is actually earning
  impliedApy: number;      // % — what the PT price implies (= YT implied rate)
  spreadPct: number;       // % — underlyingApy - impliedApy (positive = YT underpriced)
  tvlUsd: number;
  liquidityUsd: number;
  entryImpactPct: number;
  breakEvenDays: number;
  lpApy: number;           // %
  warnings: string[];
}

function formatYtArb(arb: PendleYtArb, rank: number, compact: boolean): string {
  const direction = arb.spreadPct > 0 ? "YT underpriced" : "YT overpriced";
  const absSpread = Math.abs(arb.spreadPct);

  if (compact) {
    return `  #${rank} ${arb.name} (${PENDLE_CHAIN_NAMES[arb.chain] || arb.chain}) | ${direction} | Spread ${formatPct(absSpread)} | Underlying ${formatPct(arb.underlyingApy)} vs Implied ${formatPct(arb.impliedApy)} | Impact ${formatPct(arb.entryImpactPct)} | ${arb.daysToMaturity}d`;
  }

  const lines: string[] = [];
  lines.push(`  #${rank} ${arb.name} (${PENDLE_CHAIN_NAMES[arb.chain] || arb.chain})`);
  lines.push(`    Direction: ${direction} (spread ${formatPct(absSpread)})`);
  lines.push(`    Underlying APY: ${formatPct(arb.underlyingApy)} | Implied APY: ${formatPct(arb.impliedApy)}`);
  lines.push(`    Maturity: ${arb.expiryDate} (${arb.daysToMaturity}d)`);
  lines.push(`    Entry Impact: ${formatPct(arb.entryImpactPct)} | LP APY: ${formatPct(arb.lpApy)}`);
  lines.push(`    TVL: ${formatUsd(arb.tvlUsd)} | Liquidity: ${formatUsd(arb.liquidityUsd)}`);

  if (arb.breakEvenDays < Infinity) {
    lines.push(`    Break-even: ${Math.ceil(arb.breakEvenDays)}d (if spread persists)`);
    if (arb.breakEvenDays > arb.daysToMaturity) {
      lines.push(`    ⚠ Break-even exceeds maturity`);
    }
  }

  lines.push(`    Market: ${arb.marketAddress}`);
  lines.push(`    YT: ${arb.ytAddress}`);

  if (arb.spreadPct > 0) {
    lines.push(`    Action: Buy YT — underlying earns more than market price implies`);
  } else {
    lines.push(`    Action: Sell YT — underlying earns less than market price implies`);
  }

  for (const w of arb.warnings) {
    lines.push(`    ⚠ ${w}`);
  }

  return lines.join("\n");
}

export function register(server: McpServer): void {
  server.tool(
    "pendle_scan_yt_arbitrage",
    `Scan Pendle markets for YT (Yield Token) mispricing opportunities.

Compares the underlying's variable APY against the implied rate from the PT/YT market price.
When these diverge, a spread exists:

  - Positive spread (Underlying APY > Implied): YT is underpriced — buy YT
  - Negative spread (Underlying APY < Implied): YT is overpriced — sell YT

Unlike Spectra (where YT trades indirectly via Router flash-mint/redeem), Pendle YT
trades directly on the Pendle AMM, making execution simpler:
  - Buy YT: swap SY → YT on Pendle AMM
  - Sell YT: swap YT → SY on Pendle AMM

This is the Pendle equivalent of spectra_scan_yt_arbitrage.

Use pendle_get_market_details for detailed info on a specific opportunity.
Use mv_compare_yield for cross-protocol comparison on the same underlying.`,
    {
      capital_usd: z.number().positive().describe("Capital to deploy (USD)"),
      min_spread_pct: z.number().min(0).default(1.0).describe(
        "Minimum absolute spread (%) to surface (default 1.0)"
      ),
      chain: PENDLE_CHAIN_ENUM.optional().describe(
        "Limit to a specific chain. Omit to scan all."
      ),
      asset_filter: z.string().max(100).optional().describe(
        "Filter by underlying (e.g., 'USDC', 'ETH')"
      ),
      min_tvl_usd: z.number().default(10000).describe("Minimum TVL (default $10K)"),
      min_liquidity_usd: z.number().default(5000).describe("Minimum liquidity (default $5K)"),
      max_price_impact_pct: z.number().min(0).max(100).default(5).describe(
        "Max entry impact (default 5%)"
      ),
      top_n: z.number().min(1).max(50).default(10).describe("Number of results (default 10)"),
      compact: z.boolean().default(false).describe("One-line output"),
    },
    async ({
      capital_usd,
      min_spread_pct,
      chain: chainFilter,
      asset_filter,
      min_tvl_usd,
      min_liquidity_usd,
      max_price_impact_pct,
      top_n: rawTopN,
      compact,
    }) => {
      const topN = Math.min(Math.max(1, rawTopN), 50);

      try {
        // Fetch markets
        let allMarkets: Array<{ market: PendleMarket; chain: string }>;
        let failedChains: string[] = [];

        if (chainFilter) {
          const result = await fetchPendleMarkets(chainFilter);
          if (!result.ok) failedChains.push(chainFilter);
          const now = Date.now();
          allMarkets = result.markets
            .filter((m) => new Date(m.expiry).getTime() > now)
            .filter((m) => (m.details.totalTvl || 0) >= min_tvl_usd)
            .filter((m) => (m.details.liquidity || 0) >= min_liquidity_usd)
            .map((m) => ({ market: m, chain: chainFilter }));
        } else {
          const scan = await scanAllPendleMarkets({ min_tvl_usd, min_liquidity_usd, asset_filter });
          allMarkets = scan.markets;
          failedChains = scan.failedChains;
        }

        // Apply asset filter for single-chain case
        if (chainFilter && asset_filter) {
          const upper = asset_filter.toUpperCase();
          allMarkets = allMarkets.filter(({ market }) =>
            market.name.toUpperCase().includes(upper)
          );
        }

        const maxImpactFrac = max_price_impact_pct / 100;
        const opportunities: PendleYtArb[] = [];

        for (const { market, chain } of allMarkets) {
          const d = market.details;
          const days = pendleDaysToMaturity(market.expiry);
          if (days <= 0) continue;

          const underlyingApy = (d.underlyingApy || 0) * 100;
          const impliedApy = (d.impliedApy || 0) * 100;
          const spreadPct = underlyingApy - impliedApy;
          const absSpread = Math.abs(spreadPct);

          if (absSpread < min_spread_pct) continue;

          const poolLiqUsd = d.liquidity || 0;
          const totalPt = d.totalPt || 0;
          const totalSy = d.totalSy || 0;
          const impactFrac = estimatePendlePriceImpact(capital_usd, poolLiqUsd, totalPt, totalSy, days);
          const impactPct = impactFrac * 100;

          if (impactFrac > maxImpactFrac) continue;

          // Break-even: how many days must the spread persist to cover entry cost?
          const breakEvenDays = absSpread > 0
            ? (impactPct / absSpread) * 365
            : Infinity;

          const warnings: string[] = [];
          if (days < 14) warnings.push("Very short maturity (<14d)");
          else if (days < 30) warnings.push("Short maturity (<30d)");
          if (poolLiqUsd < 50000) warnings.push("Low liquidity (<$50K)");
          if (impactPct > 2) warnings.push(`Significant entry impact (${formatPct(impactPct)})`);
          if (underlyingApy === 0) warnings.push("Underlying APY is 0 (possibly stale data)");
          if (breakEvenDays > days) warnings.push("Break-even exceeds maturity");

          opportunities.push({
            name: market.name,
            chain,
            marketAddress: market.address,
            ptAddress: market.pt,
            ytAddress: market.yt,
            daysToMaturity: days,
            expiryDate: market.expiry.split("T")[0],
            underlyingApy,
            impliedApy,
            spreadPct,
            tvlUsd: d.totalTvl || 0,
            liquidityUsd: poolLiqUsd,
            entryImpactPct: impactPct,
            breakEvenDays,
            lpApy: (d.aggregatedApy || 0) * 100,
            warnings,
          });
        }

        // Sort by absolute spread descending
        opportunities.sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));
        const topOpps = opportunities.slice(0, topN);

        if (topOpps.length === 0) {
          const scope = chainFilter ? `on ${PENDLE_CHAIN_NAMES[chainFilter] || chainFilter}` : "across Pendle chains";
          const lines = [
            `No Pendle YT arbitrage opportunities above ${formatPct(min_spread_pct)} spread ${scope}.`,
            `Capital: ${formatUsd(capital_usd)}, max impact: ${formatPct(max_price_impact_pct)}`,
            asset_filter ? `Asset filter: ${asset_filter}` : "",
            failedChains.length > 0 ? `Failed chains: ${failedChains.join(", ")}` : "",
            ``,
            `YT implied rates are close to underlying variable rates (tight spreads).`,
            `Try: lower min_spread_pct, increase max_price_impact_pct, or check again after rate changes.`,
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text" as const, text: lines }] };
        }

        const lines: string[] = [];
        lines.push(`== Pendle YT Arbitrage Scan ==`);
        lines.push(`  Capital: ${formatUsd(capital_usd)} | Min Spread: ${formatPct(min_spread_pct)} | Max Impact: ${formatPct(max_price_impact_pct)}`);
        lines.push(`  Results: ${topOpps.length} opportunit${topOpps.length === 1 ? "y" : "ies"}`);
        if (asset_filter) lines.push(`  Asset filter: ${asset_filter}`);
        if (failedChains.length > 0) lines.push(`  Failed chains: ${failedChains.join(", ")}`);
        lines.push(``);

        for (let i = 0; i < topOpps.length; i++) {
          lines.push(formatYtArb(topOpps[i], i + 1, compact));
          if (!compact) lines.push(``);
        }

        lines.push(`--- Execution Notes ---`);
        lines.push(`  Pendle YT trades directly on the AMM (unlike Spectra's Router flash-mint/redeem).`);
        lines.push(`  Buy YT: swap SY → YT on Pendle. Sell YT: swap YT → SY on Pendle.`);
        lines.push(`  Break-even assumes the spread persists — variable rates fluctuate.`);
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`  • Market detail: pendle_get_market_details(chain=CHAIN, market_address=ADDR)`);
        lines.push(`  • Compare with Spectra YT: spectra_scan_yt_arbitrage(capital_usd=${capital_usd})`);
        lines.push(`  • Fixed yield alternative: pendle_scan_opportunities(capital_usd=${capital_usd})`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
