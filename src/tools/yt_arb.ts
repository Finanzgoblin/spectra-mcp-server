/**
 * Tool: scan_yt_arbitrage
 *
 * Scans all Spectra chains for YT (Yield Token) arbitrage opportunities.
 * Compares the IBT's actual current APR against the rate implied by the
 * YT's market price. When these diverge, an arbitrage opportunity may exist:
 *
 *   - Positive spread: IBT APR > YT implied rate
 *   - Negative spread: IBT APR < YT implied rate
 *
 * Uses the same 4-phase pipeline pattern as scan_opportunities:
 *   Phase 1: Parallel multi-chain fetch
 *   Phase 2: Per-pool YT arbitrage math
 *   Phase 3: Sort by absolute spread
 *   Phase 4: Format output
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YtArbitrageOpportunity } from "../types.js";
import { scanAllChainPools, fetchVeTotalSupply } from "../api.js";
import {
  formatPct,
  formatUsd,
  daysToMaturity,
  fractionalDaysToMaturity,
  estimatePriceImpact,
  formatYtArbitrageResults,
  formatYtArbCompact,
  extractLpApyBreakdown,
  computeSpectraBoost,
} from "../formatters.js";
import type { BoostInfo } from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "scan_yt_arbitrage",
    `Scan all Spectra chains for YT (Yield Token) arbitrage opportunities.

Compares the IBT's actual current variable APR against the rate implied by the YT's
market price. When these diverge significantly, an arbitrage opportunity may exist:

  - Positive spread (IBT APR > YT implied rate): IBT earns more than the YT price implies
  - Negative spread (IBT APR < YT implied rate): IBT earns less than the YT price implies

Returns opportunities sorted by absolute spread, with capital-aware entry sizing
and break-even analysis.

Execution mechanics:
- Buying YT: The Spectra Router can flash-mint (flash-borrow IBT → mint PT+YT → sell PT
  on pool → user covers shortfall → user receives YT). This appears as SELL_PT in pool
  activity. Alternatively, minting IBT → PT+YT and selling PT separately.
- Selling YT: The Router flash-redeems (borrow IBT → buy PT from pool → burn PT+YT →
  repay → profit). This appears as BUY_PT in pool activity. The Curve pool does NOT
  trade YT directly.
- Break-even assumes the spread persists. Real variable rates fluctuate — spreads can
  close quickly. The break-even period is the minimum time needed, not a guarantee.

Use compare_yield for a detailed fixed-vs-variable breakdown on a specific pool.
Use get_pool_activity to monitor recent trading patterns in the target pool.`,
    {
      capital_usd: z
        .number()
        .positive()
        .describe("How much capital (in USD) to deploy"),
      min_spread_pct: z
        .number()
        .min(0)
        .default(1.0)
        .describe("Minimum absolute spread (%) to surface (default 1.0)"),
      asset_filter: z
        .string()
        .max(100)
        .optional()
        .describe("Optional: filter by underlying asset symbol (e.g., 'USDC', 'ETH')"),
      min_tvl_usd: z
        .number()
        .default(10000)
        .describe("Minimum pool TVL in USD (default $10,000)"),
      min_liquidity_usd: z
        .number()
        .default(5000)
        .describe("Minimum pool liquidity in USD (default $5,000)"),
      max_price_impact_pct: z
        .number()
        .min(0)
        .max(100)
        .default(5)
        .describe("Filter out pools where entry impact exceeds this % (default 5)"),
      top_n: z
        .number()
        .default(10)
        .describe("Number of top results to return (default 10, max 50)"),
      compact: z
        .boolean()
        .default(false)
        .describe("If true, return one-line-per-opportunity output (much shorter). Omit for full details."),
      ve_spectra_balance: z
        .number()
        .min(0)
        .optional()
        .describe("Your veSPECTRA token balance. Computes the real per-pool boost using B = min(2.5, 1.5*(v/V)*(D/d)+1). Fetches live totalSupply from Base chain."),
    },
    async ({
      capital_usd,
      min_spread_pct,
      asset_filter,
      min_tvl_usd,
      min_liquidity_usd,
      max_price_impact_pct,
      top_n: rawTopN,
      ve_spectra_balance,
      compact,
    }) => {
      const topN = Math.min(Math.max(1, rawTopN), 50);

      try {
        // Resolve veSPECTRA data once (shared across all pools)
        let veTotalSupply: number | null = null;
        if (ve_spectra_balance !== undefined && ve_spectra_balance > 0) {
          try {
            veTotalSupply = await fetchVeTotalSupply();
          } catch (err) {
            console.error(`Warning: could not fetch veSPECTRA totalSupply: ${(err as any).message}`);
          }
        }

        // ================================================================
        // PHASE 1: Parallel fetch all chains
        // ================================================================

        const { opportunities: rawOpps, failedChains } = await scanAllChainPools({
          min_tvl_usd,
          min_liquidity_usd,
          asset_filter,
        });

        // ================================================================
        // PHASE 2: Compute YT arbitrage metrics per opportunity
        // ================================================================

        const maxImpactFrac = max_price_impact_pct / 100;
        const opportunities: YtArbitrageOpportunity[] = [];
        const boostInfoPerOpp: (BoostInfo | undefined)[] = [];

        for (const { pt, pool, chain } of rawOpps) {
          const ptPriceUnderlying = pool.ptPrice?.underlying || 0;
          const poolLiqUsd = pool.liquidity?.usd || 0;
          const tvlUsd = pt.tvl?.usd || 0;
          const days = daysToMaturity(pt.maturity);           // integer, for display
          const fracDays = fractionalDaysToMaturity(pt.maturity); // precise, for math

          // Need valid PT price and maturity for the math
          if (ptPriceUnderlying <= 0 || ptPriceUnderlying >= 1 || fracDays <= 0) continue;

          // YT price in underlying = 1 - PT price in underlying
          const ytPriceUnderlying = 1 - ptPriceUnderlying;

          // YT implied rate: what APR does the YT market price imply?
          const ytImpliedRate = ytPriceUnderlying * (365 / fracDays) * 100;

          // IBT current APR: what the IBT is actually earning right now
          const ibtCurrentApr = pt.ibt?.apr?.total || 0;

          // Spread: positive = YT underpriced (IBT earns more than market expects)
          const spreadPct = ibtCurrentApr - ytImpliedRate;
          const absSpread = Math.abs(spreadPct);

          // Filter by minimum spread
          if (absSpread < min_spread_pct) continue;

          // Price impact at agent's capital size
          const impactFrac = estimatePriceImpact(capital_usd, poolLiqUsd);
          const impactPct = impactFrac * 100;

          // Filter by max price impact
          if (impactFrac > maxImpactFrac) continue;

          // Capacity: max capital where impact < threshold
          const capacityUsd = maxImpactFrac * 2 * poolLiqUsd;

          // Break-even: how many days must the spread persist to cover entry cost?
          const breakEvenDays = absSpread > 0
            ? (impactPct / absSpread) * 365
            : Infinity;

          // Warnings
          const warnings: string[] = [];
          if (days < 14) warnings.push("Very short maturity (<14 days)");
          else if (days < 30) warnings.push("Short maturity (<30 days)");
          if (poolLiqUsd < 50000) warnings.push("Low pool liquidity (<$50K)");
          if (impactPct > 2) warnings.push(`Significant entry impact (${formatPct(impactPct)})`);
          if (ibtCurrentApr === 0) warnings.push("IBT APR is 0 (possibly stale data)");
          if (breakEvenDays > days) warnings.push("Break-even exceeds maturity");

          // Extract LP APY with gauge emissions (computed from real boost formula)
          let boostInfo: BoostInfo | undefined;
          if (ve_spectra_balance !== undefined && ve_spectra_balance > 0 && veTotalSupply !== null) {
            boostInfo = computeSpectraBoost(ve_spectra_balance, veTotalSupply, tvlUsd, capital_usd);
          }
          const lpData = extractLpApyBreakdown(pool, boostInfo?.boostFraction ?? 0);

          opportunities.push({
            pt,
            pool,
            chain,
            ptAddress: pt.address,
            poolAddress: pool.address || "",
            ytPriceUsd: pool.ytPrice?.usd || 0,
            ytPriceUnderlying,
            ytLeverage: pool.ytLeverage || 0,
            ibtCurrentApr,
            ytImpliedRate,
            spreadPct,
            maturityTimestamp: pt.maturity,
            daysToMaturity: days,
            tvlUsd,
            poolLiquidityUsd: poolLiqUsd,
            entryImpactPct: impactPct,
            capacityUsd,
            breakEvenDays,
            lpApy: lpData.lpApy,
            lpApyBoostedTotal: lpData.lpApyBoostedTotal,
            lpApyAtBoost: lpData.lpApyAtBoost,
            lpApyBreakdown: lpData.lpApyBreakdown,
            underlying: pt.underlying?.symbol || "?",
            ibtSymbol: pt.ibt?.symbol || "?",
            ibtProtocol: pt.ibt?.protocol || "Unknown",
            warnings,
          });
          boostInfoPerOpp.push(boostInfo);
        }

        // ================================================================
        // PHASE 3: Sort by absolute spread (descending)
        // ================================================================

        const indexed = opportunities.map((opp, i) => ({ opp, bi: boostInfoPerOpp[i] }));
        indexed.sort((a, b) => Math.abs(b.opp.spreadPct) - Math.abs(a.opp.spreadPct));
        const topIndexed = indexed.slice(0, topN);
        const topOpps = topIndexed.map((e) => e.opp);
        const topBoostInfos = topIndexed.map((e) => e.bi);

        // ================================================================
        // PHASE 4: Format and return
        // ================================================================

        if (topOpps.length === 0) {
          const msg = `No YT arbitrage opportunities found above ${formatPct(min_spread_pct)} spread ` +
            `(capital: ${formatUsd(capital_usd)}, max impact: ${formatPct(max_price_impact_pct)}).` +
            (asset_filter ? ` Asset filter: ${asset_filter}.` : "") +
            ` Try lowering min_spread_pct or min_tvl_usd/min_liquidity_usd.` +
            (failedChains.length > 0 ? `\nNote: ${failedChains.length} chain(s) failed (${failedChains.join(", ")}).` : "");

          return { content: [{ type: "text" as const, text: msg }] };
        }

        let text: string;
        if (compact) {
          const lines = [`== YT Arbitrage Scan: ${formatUsd(capital_usd)} capital ==`];
          if (asset_filter) lines.push(`  Asset: ${asset_filter}`);
          lines.push(`  Results: ${topOpps.length} | Min Spread: ${formatPct(min_spread_pct)}`);
          if (failedChains.length > 0) lines.push(`  Failed: ${failedChains.join(", ")}`);
          lines.push(``);
          for (let i = 0; i < topOpps.length; i++) {
            lines.push(formatYtArbCompact(topOpps[i], i + 1));
          }
          text = lines.join("\n");
        } else {
          text = formatYtArbitrageResults(
            topOpps,
            capital_usd,
            min_spread_pct,
            asset_filter,
            failedChains,
            ve_spectra_balance,
            topBoostInfos,
          );
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error scanning YT arbitrage: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
