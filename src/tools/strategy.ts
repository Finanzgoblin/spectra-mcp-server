/**
 * Tool: scan_opportunities
 *
 * Composite strategy-layer tool for autonomous DeFi agents.
 * Scans all chains, computes capital-aware metrics (price impact, effective APY,
 * capacity), checks Morpho looping availability, and ranks opportunities by
 * risk-adjusted yield.
 *
 * Composes existing primitives:
 *   - Chain scanning from get_best_fixed_yields (Promise.allSettled pattern)
 *   - Price impact from estimatePriceImpact() (constant-product upper bound)
 *   - Looping math from cumulativeLeverageAtLoop() + formatMorphoLltv()
 *   - Batch Morpho lookup from findMorphoMarketsForPts()
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MORPHO_CHAIN_IDS,
  resolveNetwork,
} from "../config.js";
import type { ScanOpportunity } from "../types.js";
import { scanAllChainPools, findMorphoMarketsForPts, fetchVeTotalSupply } from "../api.js";
import {
  formatPct,
  formatUsd,
  daysToMaturity,
  estimatePriceImpact,
  estimateLoopingEntryCost,
  formatMorphoLltv,
  cumulativeLeverageAtLoop,
  formatScanResults,
  formatScanOpportunityCompact,
  extractLpApyBreakdown,
  computeSpectraBoost,
} from "../formatters.js";
import type { BoostInfo } from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "scan_opportunities",
    `Scan all Spectra chains for the best risk-adjusted yield opportunities, sized to
your capital.

Unlike get_best_fixed_yields (which ranks by raw APY), this tool computes:
- Entry price impact at YOUR capital size (a 50% APY pool with $10K liquidity is useless at $500K)
- Effective APY after amortizing entry cost over days to maturity
- Morpho looping availability and optimal leveraged net APY
- Pool capacity (max capital before price impact exceeds your threshold)
- Risk warnings (low liquidity, short maturity, high impact)

Returns opportunities ranked by effective APY (or looping net APY where available).
Ranking logic: when a profitable Morpho looping market exists, ranks by looping net APY
with cumulative entry cost amortized; otherwise ranks by effective APY (base APY minus
annualized entry cost).

Use get_looping_strategy to drill into a specific opportunity's leverage details.
Use get_pool_activity and get_portfolio to investigate trading patterns and positions.`,
    {
      capital_usd: z
        .number()
        .positive()
        .describe("How much capital (in USD) to deploy"),
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
      include_looping: z
        .boolean()
        .default(true)
        .describe("Whether to check Morpho looping availability (default true)"),
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
        .describe("Your veSPECTRA token balance. Computes the real per-pool boost using B = min(2.5, 1.5*(v/V)*(D/d)+1). Fetches live totalSupply from Base chain. If omitted, shows min/max APY ranges."),
    },
    async ({
      capital_usd,
      asset_filter,
      min_tvl_usd,
      min_liquidity_usd,
      include_looping,
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
        // PHASE 2: Compute capital-aware metrics per opportunity
        // ================================================================

        const maxImpactFrac = max_price_impact_pct / 100;
        const opportunities: ScanOpportunity[] = [];
        const boostInfoPerOpp: (BoostInfo | undefined)[] = []; // parallel to opportunities

        for (const { pt, pool, chain } of rawOpps) {
          const impliedApy = pool.impliedApy || 0;
          const variableApr = pt.ibt?.apr?.total || 0;
          const poolLiqUsd = pool.liquidity?.usd || 0;
          const tvlUsd = pt.tvl?.usd || 0;
          const maturityTs = pt.maturity;
          const days = daysToMaturity(maturityTs);

          // Price impact at agent's capital size
          const impactFrac = estimatePriceImpact(capital_usd, poolLiqUsd);
          const impactPct = impactFrac * 100;

          // Filter by max price impact
          if (impactFrac > maxImpactFrac) continue;

          // Effective APY: base APY minus entry cost amortized over holding period
          // Entry cost (fraction) annualized: impactFrac * (365 / days) * 100 (as %)
          const annualizedEntryCost = days > 0
            ? impactFrac * (365 / days) * 100
            : impactFrac * 100;
          const effectiveApy = impliedApy - annualizedEntryCost;

          // Capacity: max capital where impact < threshold
          // impactFrac = capital / (2 * poolLiq) => capital = threshold * 2 * poolLiq
          const capacityUsd = maxImpactFrac * 2 * poolLiqUsd;

          // Warnings
          const warnings: string[] = [];
          if (days < 14) warnings.push("Very short maturity (<14 days)");
          else if (days < 30) warnings.push("Short maturity (<30 days)");
          if (poolLiqUsd < 50000) warnings.push("Low pool liquidity (<$50K)");
          if (impactPct > 2) warnings.push(`Significant entry impact (${formatPct(impactPct)})`);
          if (tvlUsd < 50000) warnings.push("Low TVL (<$50K)");
          if (effectiveApy < 0) warnings.push("Effective APY negative after entry cost");

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
            impliedApy,
            variableApr,
            fixedVsVariableSpread: impliedApy - variableApr,
            maturityTimestamp: maturityTs,
            daysToMaturity: days,
            tvlUsd,
            poolLiquidityUsd: poolLiqUsd,
            entryImpactPct: impactPct,
            effectiveApy,
            capacityUsd,
            looping: null,           // filled in Phase 3
            lpApy: lpData.lpApy,
            lpApyBoostedTotal: lpData.lpApyBoostedTotal,
            lpApyAtBoost: lpData.lpApyAtBoost,
            lpApyBreakdown: lpData.lpApyBreakdown,
            sortApy: effectiveApy,   // updated in Phase 3 if looping profitable
            underlying: pt.underlying?.symbol || "?",
            ibtSymbol: pt.ibt?.symbol || "?",
            ibtProtocol: pt.ibt?.protocol || "Unknown",
            warnings,
          });
          boostInfoPerOpp.push(boostInfo);
        }

        // ================================================================
        // PHASE 3: Batch Morpho lookups (if include_looping)
        // ================================================================

        if (include_looping && opportunities.length > 0) {
          // Group PT addresses by Morpho-capable chain
          const ptsByChain: Record<string, { addr: string; idx: number }[]> = {};

          for (let i = 0; i < opportunities.length; i++) {
            const opp = opportunities[i];
            const network = resolveNetwork(opp.chain);
            if (!MORPHO_CHAIN_IDS[network]) continue;

            if (!ptsByChain[network]) ptsByChain[network] = [];
            ptsByChain[network].push({ addr: opp.ptAddress, idx: i });
          }

          // Parallel batch lookup: one GraphQL call per chain
          const morphoChains = Object.keys(ptsByChain);
          const morphoResults = await Promise.allSettled(
            morphoChains.map(async (chain) => {
              const addrs = [...new Set(ptsByChain[chain].map((e) => e.addr))];
              const markets = await findMorphoMarketsForPts(addrs, chain);
              return { chain, markets };
            })
          );

          // Apply Morpho data to opportunities
          for (const result of morphoResults) {
            if (result.status !== "fulfilled") continue;
            const { chain, markets } = result.value;

            for (const entry of ptsByChain[chain]) {
              const market = markets.get(entry.addr.toLowerCase());
              if (!market) continue;

              const opp = opportunities[entry.idx];
              const lltv = formatMorphoLltv(market.lltv);
              const borrowRatePct = (market.state?.borrowApy || 0) * 100;
              const morphoLiqUsd = market.state?.liquidityAssetsUsd || 0;

              if (lltv <= 0) continue;

              // Find optimal loop count (same logic as looping.ts)
              const maxLoops = 5;
              let bestNet = opp.impliedApy;
              let bestLoop = 0;
              let bestLev = 1;

              for (let i = 1; i <= maxLoops; i++) {
                const lev = cumulativeLeverageAtLoop(lltv, i);
                const net = opp.impliedApy * lev - borrowRatePct * (lev - 1);
                if (net > bestNet) {
                  bestNet = net;
                  bestLoop = i;
                  bestLev = lev;
                }
              }

              // Compute cumulative entry cost across all loops at this capital size
              const { totalImpactPct: cumImpactPct } = estimateLoopingEntryCost(
                capital_usd, opp.poolLiquidityUsd, lltv, bestLoop
              );
              const annualizedCumCost = opp.daysToMaturity > 0
                ? cumImpactPct * (365 / opp.daysToMaturity)
                : cumImpactPct;
              const effectiveNetApy = bestNet - annualizedCumCost;

              // Only attach looping if it actually improves over base
              if (bestLoop > 0) {
                opp.looping = {
                  morphoMarketKey: market.uniqueKey,
                  lltv,
                  borrowRatePct,
                  optimalLoops: bestLoop,
                  optimalLeverage: bestLev,
                  optimalNetApy: bestNet,
                  optimalEffectiveNetApy: effectiveNetApy,
                  cumulativeEntryImpactPct: cumImpactPct,
                  morphoLiquidityUsd: morphoLiqUsd,
                };
                // Rank by effective net APY (steady-state yield minus cumulative entry cost)
                opp.sortApy = effectiveNetApy;
              }
            }
          }
        }

        // ================================================================
        // PHASE 4: Sort and return top_n
        // ================================================================

        // Build indexed pairs so we can sort boostInfos in sync
        // Filter out negative-sortApy opportunities — entry cost exceeds yield
        const indexed = opportunities
          .map((opp, i) => ({ opp, bi: boostInfoPerOpp[i] }))
          .filter(({ opp }) => opp.sortApy >= 0);
        indexed.sort((a, b) => b.opp.sortApy - a.opp.sortApy);
        const topIndexed = indexed.slice(0, topN);
        const topOpps = topIndexed.map((e) => e.opp);
        const topBoostInfos = topIndexed.map((e) => e.bi);

        if (topOpps.length === 0) {
          const msg = `No opportunities found matching criteria (capital: ${formatUsd(capital_usd)}, max impact: ${formatPct(max_price_impact_pct)}).` +
            (asset_filter ? ` Asset filter: ${asset_filter}.` : "") +
            ` Try lowering min_tvl_usd/min_liquidity_usd or increasing max_price_impact_pct.` +
            (failedChains.length > 0 ? `\nNote: ${failedChains.length} chain(s) failed (${failedChains.join(", ")}).` : "");

          return { content: [{ type: "text" as const, text: msg }] };
        }

        let text: string;
        if (compact) {
          const lines = [`== Opportunity Scan: ${formatUsd(capital_usd)} capital ==`];
          if (asset_filter) lines.push(`  Asset: ${asset_filter}`);
          lines.push(`  Results: ${topOpps.length} | Max Impact: ${formatPct(max_price_impact_pct)}`);
          if (failedChains.length > 0) lines.push(`  Failed: ${failedChains.join(", ")}`);
          lines.push(``);
          for (let i = 0; i < topOpps.length; i++) {
            lines.push(formatScanOpportunityCompact(topOpps[i], i + 1));
          }
          text = lines.join("\n");
        } else {
          text = formatScanResults(
          topOpps,
          capital_usd,
          max_price_impact_pct,
          asset_filter,
          failedChains,
          include_looping,
          ve_spectra_balance,
          topBoostInfos,
        );
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error scanning opportunities: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
