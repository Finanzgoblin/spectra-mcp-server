/**
 * Tool: pendle_get_protocol_stats
 *
 * Protocol-wide statistics for Pendle across all chains.
 * The Pendle equivalent of spectra_get_protocol_stats.
 * Aggregates TVL, market count, liquidity, and volume across all Pendle-supported chains.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES, SUPPORTED_CHAINS } from "../config.js";
import { fetchPendleMarkets } from "../api.js";
import type { PendleMarket } from "../types.js";
import { formatUsd, formatPct, pendleDaysToMaturity } from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "pendle_get_protocol_stats",
    `Get Pendle protocol-wide statistics: total TVL, market count, liquidity, and
volume across all Pendle-supported chains.

Shows per-chain breakdown and aggregate metrics. Includes:
- Active market count and TVL per chain
- Total pool liquidity and 24h volume
- Average implied APY and LP APY
- Chain overlap with Spectra (expansion opportunities)

The Pendle equivalent of spectra_get_protocol_stats.

Use pendle_list_markets for detailed market-level data.
Use mv_scan_curator_opportunities for cross-protocol ranking.`,
    {},
    async () => {
      try {
        const pendleChains = Object.keys(PENDLE_CHAIN_IDS);

        // Fetch all chains in parallel
        const results = await Promise.allSettled(
          pendleChains.map(async (chain) => {
            const result = await fetchPendleMarkets(chain);
            return { chain, result };
          })
        );

        interface ChainStats {
          chain: string;
          chainName: string;
          markets: number;
          tvlUsd: number;
          liquidityUsd: number;
          volumeUsd: number;
          avgImpliedApy: number;
          avgLpApy: number;
          hasSpectraOverlap: boolean;
        }

        const chainStats: ChainStats[] = [];
        const failedChains: string[] = [];
        let totalMarkets = 0;
        let totalTvl = 0;
        let totalLiquidity = 0;
        let totalVolume = 0;
        let totalImpliedApySum = 0;
        let totalLpApySum = 0;
        let totalActiveCount = 0;

        const now = Date.now();

        for (const r of results) {
          if (r.status !== "fulfilled") {
            continue;
          }
          const { chain, result } = r.value;
          if (!result.ok) {
            failedChains.push(chain);
            continue;
          }

          // Only count active (non-expired) markets
          const active = result.markets.filter(
            (m) => new Date(m.expiry).getTime() > now
          );

          if (active.length === 0) continue;

          let chainTvl = 0;
          let chainLiq = 0;
          let chainVol = 0;
          let chainImpliedSum = 0;
          let chainLpSum = 0;

          for (const m of active) {
            const d = m.details;
            chainTvl += d.totalTvl || 0;
            chainLiq += d.liquidity || 0;
            chainVol += d.tradingVolume || 0;
            chainImpliedSum += (d.impliedApy || 0) * 100;
            chainLpSum += (d.aggregatedApy || 0) * 100;
          }

          const avgImplied = active.length > 0 ? chainImpliedSum / active.length : 0;
          const avgLp = active.length > 0 ? chainLpSum / active.length : 0;

          chainStats.push({
            chain,
            chainName: PENDLE_CHAIN_NAMES[chain] || chain,
            markets: active.length,
            tvlUsd: chainTvl,
            liquidityUsd: chainLiq,
            volumeUsd: chainVol,
            avgImpliedApy: avgImplied,
            avgLpApy: avgLp,
            hasSpectraOverlap: !!SUPPORTED_CHAINS[chain],
          });

          totalMarkets += active.length;
          totalTvl += chainTvl;
          totalLiquidity += chainLiq;
          totalVolume += chainVol;
          totalImpliedApySum += chainImpliedSum;
          totalLpApySum += chainLpSum;
          totalActiveCount += active.length;
        }

        // Sort chains by TVL descending
        chainStats.sort((a, b) => b.tvlUsd - a.tvlUsd);

        const avgImplied = totalActiveCount > 0 ? totalImpliedApySum / totalActiveCount : 0;
        const avgLp = totalActiveCount > 0 ? totalLpApySum / totalActiveCount : 0;

        const overlapChains = chainStats.filter((c) => c.hasSpectraOverlap);
        const pendleOnlyChains = chainStats.filter((c) => !c.hasSpectraOverlap);

        const lines: string[] = [];
        lines.push(`-- Pendle Protocol Stats --`);
        lines.push(``);
        lines.push(`  Aggregate:`);
        lines.push(`    Active Markets: ${totalMarkets}`);
        lines.push(`    Total TVL: ${formatUsd(totalTvl)}`);
        lines.push(`    Total Pool Liquidity: ${formatUsd(totalLiquidity)}`);
        lines.push(`    Total 24h Volume: ${formatUsd(totalVolume)}`);
        lines.push(`    Avg Implied APY: ${formatPct(avgImplied)}`);
        lines.push(`    Avg LP APY: ${formatPct(avgLp)}`);
        lines.push(`    Chains Active: ${chainStats.length} of ${pendleChains.length}`);
        lines.push(``);

        // Per-chain breakdown
        lines.push(`  Per-Chain Breakdown:`);
        const hdr = "  Chain          | Markets |       TVL |  Liquidity |   24h Vol | Avg Impl | Avg LP | Spectra";
        lines.push(hdr);
        lines.push(`  ${"─".repeat(hdr.length - 2)}`);

        for (const cs of chainStats) {
          const ch = cs.chainName.padEnd(14);
          const mk = String(cs.markets).padStart(7);
          const tvl = formatUsd(cs.tvlUsd).padStart(9);
          const liq = formatUsd(cs.liquidityUsd).padStart(10);
          const vol = formatUsd(cs.volumeUsd).padStart(9);
          const impl = formatPct(cs.avgImpliedApy).padStart(8);
          const lp = formatPct(cs.avgLpApy).padStart(6);
          const overlap = cs.hasSpectraOverlap ? "  ✓" : "  —";
          lines.push(`  ${ch} | ${mk} | ${tvl} | ${liq} | ${vol} | ${impl} | ${lp} | ${overlap}`);
        }

        if (failedChains.length > 0) {
          lines.push(``);
          lines.push(`  Failed chains: ${failedChains.join(", ")}`);
        }

        lines.push(``);
        lines.push(`  Protocol Notes:`);
        lines.push(`    AMM: Pendle's time-decay logit AMM (not Curve)`);
        lines.push(`    Incentives: PENDLE token emissions + vePENDLE boosting`);
        lines.push(`    Chains with Spectra overlap: ${overlapChains.map((c) => c.chainName).join(", ") || "none"}`);
        lines.push(`    Pendle-only chains: ${pendleOnlyChains.map((c) => c.chainName).join(", ") || "none"}`);
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`  • Market listing: pendle_list_markets(chain=CHAIN) for detailed market data`);
        lines.push(`  • Best yields: pendle_get_best_fixed_yields() for top fixed rates`);
        lines.push(`  • Cross-protocol: mv_scan_curator_opportunities(capital_usd=AMOUNT) for unified ranking`);
        lines.push(`  • Spectra stats: spectra_get_protocol_stats() for comparison`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
