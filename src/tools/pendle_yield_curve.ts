/**
 * Tool: pendle_get_yield_curve
 *
 * Term structure view for a given underlying asset across all Pendle chains.
 * The Pendle equivalent of spectra_get_yield_curve.
 * Shows all available maturities sorted chronologically with implied APY,
 * TVL, and liquidity — the fixed-income yield curve.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES } from "../config.js";
import { scanAllPendleMarkets, fetchPendleMarkets } from "../api.js";
import type { PendleMarket } from "../types.js";
import { formatPct, formatUsd, pendleDaysToMaturity } from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

/** Normalize Pendle market name to an underlying symbol for matching. */
function normalizePendleUnderlying(name: string): string {
  // Strip date suffix like "-26MAR2026" and normalize
  return name
    .replace(/-\d{1,2}[A-Z]{3}\d{4}$/, "")
    .toUpperCase()
    .replace(/^W/, "") // WETH → ETH, WBTC → BTC
    .replace(/\.E$/i, ""); // USDC.e → USDC
}

export function register(server: McpServer): void {
  server.tool(
    "pendle_get_yield_curve",
    `Show the yield curve (term structure) for a given underlying asset across Pendle chains.

Fetches all active Pendle markets matching the underlying (e.g., "USDC", "ETH", "stETH"),
sorts by maturity, and displays implied APY at each point on the curve.

This is the fixed-income view: "What rate can I lock for 30 days vs 90 days vs 180 days?"
Helps curators spot term premium anomalies, compare cross-chain rates, and choose maturities.

The Pendle equivalent of spectra_get_yield_curve.

Use pendle_get_market_details to drill into a specific maturity.
Use pendle_get_market_capacity to check depth at your capital size.
Use mv_compare_yield for Spectra vs Pendle comparison on the same underlying.`,
    {
      underlying: z
        .string()
        .min(1)
        .max(20)
        .describe("Underlying asset symbol (e.g., 'USDC', 'ETH', 'stETH', 'weETH')"),
      chain: PENDLE_CHAIN_ENUM
        .optional()
        .describe("Restrict to a single chain. Omit to scan all Pendle chains."),
      min_tvl_usd: z.number().default(0).describe("Minimum TVL in USD (default 0)"),
      min_liquidity_usd: z.number().default(0).describe("Minimum pool liquidity in USD (default 0)"),
      compact: z.boolean().default(false).describe("One-line-per-maturity output"),
    },
    async ({ underlying, chain, min_tvl_usd, min_liquidity_usd, compact }) => {
      try {
        // Fetch markets
        let allMarkets: Array<{ market: PendleMarket; chain: string }>;
        let failedChains: string[] = [];

        if (chain) {
          const result = await fetchPendleMarkets(chain);
          if (!result.ok) failedChains.push(chain);
          const now = Date.now();
          allMarkets = result.markets
            .filter((m) => new Date(m.expiry).getTime() > now)
            .filter((m) => (m.details.totalTvl || 0) >= min_tvl_usd)
            .filter((m) => (m.details.liquidity || 0) >= min_liquidity_usd)
            .map((m) => ({ market: m, chain }));
        } else {
          const scan = await scanAllPendleMarkets({ min_tvl_usd, min_liquidity_usd });
          allMarkets = scan.markets;
          failedChains = scan.failedChains;
        }

        // Match by underlying
        const targetNorm = underlying.toUpperCase()
          .replace(/^W/, "")
          .replace(/\.E$/i, "");

        // Prefer exact match; fall back to substring only if no exact matches
        let matched = allMarkets.filter(({ market }) => {
          const norm = normalizePendleUnderlying(market.name);
          return norm === targetNorm;
        });
        if (matched.length === 0) {
          matched = allMarkets.filter(({ market }) => {
            const norm = normalizePendleUnderlying(market.name);
            return norm.includes(targetNorm) || targetNorm.includes(norm);
          });
        }

        if (matched.length === 0) {
          const chainNote = chain ? ` on ${PENDLE_CHAIN_NAMES[chain] || chain}` : " across any Pendle chain";
          const failNote = failedChains.length > 0
            ? `\nFailed chains: ${failedChains.join(", ")}`
            : "";
          const text = `No active Pendle markets found for "${underlying}"${chainNote}.${failNote}\n\nTry a different symbol (USDC, ETH, stETH, weETH, etc.) or relax filters.`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Sort by maturity ascending
        matched.sort((a, b) => {
          const aTs = new Date(a.market.expiry).getTime();
          const bTs = new Date(b.market.expiry).getTime();
          return aTs - bTs;
        });

        const chains = [...new Set(matched.map((m) => m.chain))];

        const lines: string[] = [];
        lines.push(`${underlying.toUpperCase()} Yield Curve — Pendle (${matched.length} maturit${matched.length === 1 ? "y" : "ies"} across ${chains.length} chain${chains.length === 1 ? "" : "s"})`);
        lines.push("");

        if (compact) {
          const hdr = "Maturity     | Days | Impl. APY |   LP APY |       TVL | Pool Depth | Chain     | Market Address";
          lines.push(hdr);
          lines.push("─".repeat(hdr.length));

          for (const { market, chain: c } of matched) {
            const d = market.details;
            const days = String(pendleDaysToMaturity(market.expiry)).padStart(4);
            const date = market.expiry.split("T")[0];
            const apy = formatPct(d.impliedApy * 100).padStart(9);
            const lpApy = formatPct(d.aggregatedApy * 100).padStart(8);
            const tvl = formatUsd(d.totalTvl).padStart(9);
            const liq = formatUsd(d.liquidity).padStart(9);
            const ch = (PENDLE_CHAIN_NAMES[c] || c).padEnd(9);
            const addr = market.address.slice(0, 6) + "..." + market.address.slice(-4);
            lines.push(`${date}  | ${days} | ${apy} | ${lpApy} | ${tvl} | ${liq} | ${ch} | ${addr}`);
          }
        } else {
          for (const { market, chain: c } of matched) {
            const d = market.details;
            const days = pendleDaysToMaturity(market.expiry);
            const expiryDate = market.expiry.split("T")[0];
            lines.push(`-- ${market.name} (${PENDLE_CHAIN_NAMES[c] || c}) --`);
            lines.push(`  Maturity: ${expiryDate} (${days} days)`);
            lines.push(`  Implied APY: ${formatPct(d.impliedApy * 100)}`);
            lines.push(`  LP APY: ${formatPct(d.aggregatedApy * 100)}`);
            lines.push(`  Underlying APY: ${formatPct(d.underlyingApy * 100)}`);
            lines.push(`  TVL: ${formatUsd(d.totalTvl)} | Pool Depth: ${formatUsd(d.liquidity)}`);
            lines.push(`  Market: ${market.address}`);
            lines.push("");
          }
        }

        // Curve shape analysis
        if (matched.length >= 2) {
          lines.push("");
          lines.push("--- Curve Shape Analysis ---");
          const first = matched[0].market.details;
          const last = matched[matched.length - 1].market.details;
          const firstApy = (first.impliedApy || 0) * 100;
          const lastApy = (last.impliedApy || 0) * 100;
          const diff = lastApy - firstApy;

          if (Math.abs(diff) < 0.1) {
            lines.push("Shape: Flat (similar rates across maturities)");
          } else if (diff > 0) {
            lines.push("Shape: Normal (upward sloping — longer maturities pay more)");
          } else {
            lines.push("Shape: Inverted (shorter maturities pay more than longer ones)");
            lines.push("");
            lines.push("  An inverted yield curve has multiple valid readings:");
            lines.push("  (A) Near-term liquidity crunch — short pools are thin, so fewer");
            lines.push("      sellers of PT drive prices down and yields up mechanically");
            lines.push("  (B) Market expects rate compression — participants believe current");
            lines.push("      high variable rates won't persist, so longer PT is priced closer to par");
            lines.push("  (C) Maturity premium inversion — short maturities carry rollover risk");
            lines.push("      costs that the market is pricing into a higher annualized rate");
            lines.push("  Check pool liquidity at each maturity to distinguish (A) from (B)/(C).");
          }

          // Find steepest segment
          let maxSlopePer30d = 0;
          let steepestIdx = 0;
          for (let i = 1; i < matched.length; i++) {
            const daysCurr = pendleDaysToMaturity(matched[i].market.expiry);
            const daysPrev = pendleDaysToMaturity(matched[i - 1].market.expiry);
            const daysDelta = daysCurr - daysPrev;
            const apyDelta = (matched[i].market.details.impliedApy - matched[i - 1].market.details.impliedApy) * 100;
            const slopePer30d = daysDelta > 0 ? (apyDelta / daysDelta) * 30 : 0;
            if (Math.abs(slopePer30d) > Math.abs(maxSlopePer30d)) {
              maxSlopePer30d = slopePer30d;
              steepestIdx = i;
            }
          }

          if (steepestIdx > 0) {
            const daysPrev = pendleDaysToMaturity(matched[steepestIdx - 1].market.expiry);
            const daysCurr = pendleDaysToMaturity(matched[steepestIdx].market.expiry);
            const apyDelta = (matched[steepestIdx].market.details.impliedApy - matched[steepestIdx - 1].market.details.impliedApy) * 100;
            const sign = apyDelta >= 0 ? "+" : "";
            lines.push(`Steepest segment: ${daysPrev}d→${daysCurr}d (${sign}${formatPct(apyDelta)} over ${daysCurr - daysPrev} days)`);
          }

          // Detect liquidity-rate divergence
          const liqRatePairs = matched.map(({ market, chain: c }) => ({
            days: pendleDaysToMaturity(market.expiry),
            apy: (market.details.impliedApy || 0) * 100,
            liq: market.details.liquidity || 0,
            chain: c,
          }));
          const highApyLowLiq = liqRatePairs.filter(p => p.liq > 0).sort((a, b) => b.apy - a.apy);
          if (highApyLowLiq.length >= 2) {
            const top = highApyLowLiq[0];
            const medianLiq = [...highApyLowLiq].sort((a, b) => a.liq - b.liq)[Math.floor(highApyLowLiq.length / 2)].liq;
            if (top.liq < medianLiq * 0.3 && top.apy > highApyLowLiq[1].apy * 1.3) {
              lines.push("");
              lines.push(`  Note: Highest APY maturity (${top.days}d, ${formatPct(top.apy)}) has significantly`);
              lines.push(`  less liquidity (${formatUsd(top.liq)}) than the median (${formatUsd(medianLiq)}).`);
              lines.push(`  The elevated rate may reflect thin liquidity rather than genuine yield demand.`);
            }
          }

          // Cross-chain pairs at similar maturities
          for (let i = 1; i < matched.length; i++) {
            const prev = matched[i - 1];
            const curr = matched[i];
            if (curr.chain === prev.chain) continue;
            const dayGap = Math.abs(
              pendleDaysToMaturity(curr.market.expiry) - pendleDaysToMaturity(prev.market.expiry)
            );
            if (dayGap <= 7) {
              const apyDelta = Math.abs(
                (curr.market.details.impliedApy - prev.market.details.impliedApy) * 100
              );
              if (apyDelta < 0.1) {
                lines.push(`Cross-chain pair: ${prev.market.expiry.split("T")[0]} ${PENDLE_CHAIN_NAMES[prev.chain] || prev.chain} vs ${PENDLE_CHAIN_NAMES[curr.chain] || curr.chain} — APY delta ${formatPct(apyDelta)} (negligible, choose by liquidity)`);
              } else {
                lines.push(`Cross-chain pair: ${prev.market.expiry.split("T")[0]} ${PENDLE_CHAIN_NAMES[prev.chain] || prev.chain} vs ${PENDLE_CHAIN_NAMES[curr.chain] || curr.chain} — APY delta ${formatPct(apyDelta)}`);
                lines.push(`  Rate divergence at similar maturity across chains could indicate:`);
                lines.push(`  (A) Different SY wrappers with different underlying risk`);
                lines.push(`  (B) Liquidity imbalance — one pool is deeper, compressing its rate`);
                lines.push(`  (C) Chain-specific PENDLE incentive allocations tilting one side`);
              }
            }
          }
        }

        if (failedChains.length > 0) {
          lines.push("");
          lines.push(`Note: Failed to fetch from: ${failedChains.join(", ")}`);
        }

        lines.push("");
        lines.push(`--- Next Steps ---`);
        lines.push(`  • Market detail: pendle_get_market_details(chain=CHAIN, market_address=ADDR)`);
        lines.push(`  • Capacity check: pendle_get_market_capacity(chain=CHAIN, market_address=ADDR)`);
        lines.push(`  • Compare with Spectra: spectra_get_yield_curve(underlying="${underlying}") for Spectra term structure`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error building yield curve: ${err?.message || String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
