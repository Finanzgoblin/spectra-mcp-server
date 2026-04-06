/**
 * Tool: pendle_scan_opportunities
 *
 * Capital-aware opportunity scanner for Pendle markets.
 * The Pendle equivalent of spectra_scan_opportunities.
 * Computes price impact at the user's capital size using Pendle's logit AMM model,
 * calculates effective APY after entry costs, and ranks by risk-adjusted yield.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES, MORPHO_CHAIN_IDS } from "../config.js";
import type { MerklCampaign } from "../types.js";
import { scanAllPendleMarkets, findMorphoMarketsForPts, fetchMerklCampaigns, lookupMerklCampaigns } from "../api.js";
import {
  formatPct,
  formatUsd,
  pendleDaysToMaturity,
  estimatePendlePriceImpact,
  formatMorphoLltv,
  cumulativeLeverageAtLoop,
  getEffectiveLiquidityUsd,
  formatPrescriptiveObservationBoundary,
} from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

interface PendleOpportunity {
  chain: string;
  name: string;
  underlying: string;
  marketAddress: string;
  ptAddress: string;
  syAddress: string;
  maturityTimestamp: number;
  daysToMaturity: number;
  impliedApy: number;       // %
  lpApy: number;             // %
  variableApr: number;       // %
  tvlUsd: number;
  poolLiquidityUsd: number;
  entryImpactPct: number;
  effectiveApy: number;      // implied minus annualized entry cost
  capacityUsd: number;
  sortApy: number;           // max(effectiveApy, lpApy)
  bestStrategy: "pt_spot" | "lp" | "pt_loop";
  looping?: {
    marketKey: string;
    lltv: number;
    borrowRatePct: number;
    optimalLoops: number;
    optimalLeverage: number;
    optimalNetApy: number;
    morphoLiquidityUsd: number;
  };
  totalPt?: number;
  totalSy?: number;
  merklCampaigns?: MerklCampaign[];
  warnings: string[];
}

function formatOpportunity(opp: PendleOpportunity, rank: number, compact: boolean): string {
  if (compact) {
    const loopSuffix = opp.looping
      ? ` | Loop ${formatPct(opp.looping.optimalNetApy)} @${opp.looping.optimalLoops}x`
      : "";
    const merklSuffix = opp.merklCampaigns && opp.merklCampaigns.length > 0
      ? ` | +Merkl`
      : "";
    return `  #${rank} ${opp.name} (${PENDLE_CHAIN_NAMES[opp.chain] || opp.chain}) | Eff ${formatPct(opp.effectiveApy)} | LP ${formatPct(opp.lpApy)} | Impact ${formatPct(opp.entryImpactPct)} | Depth ${formatUsd(opp.poolLiquidityUsd)} | ${opp.daysToMaturity}d${loopSuffix}${merklSuffix}`;
  }

  const lines: string[] = [];
  lines.push(`  #${rank} ${opp.name} (${PENDLE_CHAIN_NAMES[opp.chain] || opp.chain})`);
  lines.push(`    Market: ${opp.marketAddress}`);
  lines.push(`    Maturity: ${opp.daysToMaturity}d`);
  lines.push(`    Implied APY: ${formatPct(opp.impliedApy)}  |  Effective APY: ${formatPct(opp.effectiveApy)}`);
  lines.push(`    LP APY: ${formatPct(opp.lpApy)}  |  Variable APR: ${formatPct(opp.variableApr)}`);
  lines.push(`    Entry Impact: ${formatPct(opp.entryImpactPct)}  |  Capacity: ${formatUsd(opp.capacityUsd)}`);
  lines.push(`    TVL: ${formatUsd(opp.tvlUsd)}  |  Liquidity: ${formatUsd(opp.poolLiquidityUsd)}`);
  lines.push(`    Best Strategy: ${opp.bestStrategy === "lp" ? "LP" : opp.bestStrategy === "pt_loop" ? "PT + Morpho Loop" : "PT Spot"}`);

  if (opp.looping) {
    lines.push(`    Morpho Looping: ${formatPct(opp.looping.optimalNetApy)} net @ ${opp.looping.optimalLoops} loops (${opp.looping.optimalLeverage.toFixed(2)}x leverage)`);
    lines.push(`      Borrow rate: ${formatPct(opp.looping.borrowRatePct)}  |  Morpho liquidity: ${formatUsd(opp.looping.morphoLiquidityUsd)}`);
  }

  if (opp.merklCampaigns && opp.merklCampaigns.length > 0) {
    const totalMerklApr = opp.merklCampaigns.reduce((s, c) => s + (c.apr || 0), 0);
    if (totalMerklApr > 0) {
      lines.push(`    Merkl Incentives: +${formatPct(totalMerklApr)} (${opp.merklCampaigns.length} campaign(s))`);
    }
  }

  // Pool reserves — data the scanner already fetched for impact calc
  if (opp.totalPt && opp.totalSy && opp.totalPt > 0 && opp.totalSy > 0) {
    const ratio = opp.totalPt / opp.totalSy;
    lines.push(`    Pool Reserves: ${opp.totalSy.toFixed(2)} SY / ${opp.totalPt.toFixed(2)} PT (ratio ${ratio.toFixed(2)}:1)`);
  }

  // Full loop curve when looping exists
  if (opp.looping && opp.looping.lltv > 0) {
    const loopLines: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const lev = cumulativeLeverageAtLoop(i, opp.looping.lltv);
      const borrowed = lev - 1;
      const grossApy = lev * opp.impliedApy;
      const borrowCost = borrowed * opp.looping.borrowRatePct;
      const netApy = grossApy - borrowCost;
      loopLines.push(`${i}L: ${lev.toFixed(2)}x, ${formatPct(netApy)} net`);
    }
    lines.push(`    Loop Curve: ${loopLines.join(" | ")}`);
  }

  if (opp.warnings.length > 0) {
    for (const w of opp.warnings) {
      lines.push(`    ⚠ ${w}`);
    }
  }

  return lines.join("\n");
}

export function register(server: McpServer): void {
  server.tool(
    "pendle_scan_opportunities",
    `Scan all Pendle chains for the best yield opportunities, sized to your capital.

This is the Pendle equivalent of spectra_scan_opportunities. Unlike pendle_get_best_fixed_yields
(raw APY ranking), this tool computes:
- Entry price impact at YOUR capital size using Pendle's logit AMM model
- Effective APY after amortizing entry cost over days to maturity
- Pool capacity (max capital before impact exceeds threshold)
- Morpho looping availability for Pendle PTs on Morpho-capable chains
- External Merkl campaign incentives

The ranking reflects what you can actually EARN, not just what the protocol advertises.

For cross-protocol scanning (Spectra + Pendle together), use mv_scan_curator_opportunities.
For Spectra-only scanning, use spectra_scan_opportunities.`,
    {
      capital_usd: z
        .number()
        .positive()
        .describe("How much capital (in USD) to deploy"),
      chain: PENDLE_CHAIN_ENUM.optional().describe(
        "Limit to a specific chain. Omit to scan all Pendle chains."
      ),
      asset_filter: z.string().max(100).optional().describe(
        "Filter by underlying asset (e.g., 'USDC', 'ETH', 'stETH')"
      ),
      min_tvl_usd: z.number().default(10000).describe("Minimum TVL in USD (default $10,000)"),
      min_liquidity_usd: z.number().default(5000).describe("Minimum pool liquidity (default $5,000)"),
      max_price_impact_pct: z.number().min(0).max(100).default(5).describe(
        "Filter out markets where entry impact exceeds this % (default 5)"
      ),
      top_n: z.number().min(1).max(50).default(15).describe("Number of results (default 15)"),
      include_looping: z.boolean().default(true).describe(
        "Check Morpho looping for Pendle PTs on Morpho-capable chains (default true)"
      ),
      compact: z.boolean().default(false).describe("One-line-per-opportunity output"),
    },
    async ({
      capital_usd,
      chain: chainFilter,
      asset_filter,
      min_tvl_usd,
      min_liquidity_usd,
      max_price_impact_pct,
      top_n: rawTopN,
      include_looping,
      compact,
    }) => {
      const topN = Math.min(Math.max(1, rawTopN), 50);

      try {
        // Phase 1: Fetch all Pendle markets
        const scan = await scanAllPendleMarkets({
          min_tvl_usd,
          min_liquidity_usd,
          asset_filter,
        });

        let rawMarkets = scan.markets;
        if (chainFilter) {
          rawMarkets = rawMarkets.filter(({ chain }) => chain === chainFilter);
        }

        const maxImpactFrac = max_price_impact_pct / 100;

        // Phase 2: Compute capital-aware metrics
        const opportunities: PendleOpportunity[] = [];

        for (const { market, chain } of rawMarkets) {
          const d = market.details;
          const impliedApy = (d.impliedApy || 0) * 100;
          const variableApr = (d.underlyingApy || 0) * 100;
          const lpApy = (d.aggregatedApy || 0) * 100;
          const poolLiqUsd = d.liquidity || 0;
          const tvlUsd = d.totalTvl || 0;
          const days = pendleDaysToMaturity(market.expiry);
          const maturityTs = Math.floor(new Date(market.expiry).getTime() / 1000);

          if (days <= 0) continue;

          // Pendle logit AMM price impact
          const totalPt = d.totalPt || 0;
          const totalSy = d.totalSy || 0;
          const impactFrac = estimatePendlePriceImpact(capital_usd, poolLiqUsd, totalPt, totalSy, days);
          const impactPct = impactFrac * 100;

          // Impact filter: skip only if BOTH PT and LP strategies are unviable
          if (impactFrac > maxImpactFrac && lpApy <= 0) continue;

          const annualizedEntryCost = days > 0
            ? impactFrac * (365 / days) * 100
            : impactFrac * 100;
          const effectiveApy = impliedApy - annualizedEntryCost;
          const capacityUsd = maxImpactFrac * 2 * poolLiqUsd;

          const bestIsLp = lpApy > effectiveApy;

          // Parse underlying from market name
          const underlying = market.name.replace(/-\d{1,2}[A-Z]{3}\d{4}$/, "");

          const warnings: string[] = [];
          if (days < 14) warnings.push("Very short maturity (<14d)");
          else if (days < 30) warnings.push("Short maturity (<30d)");
          if (poolLiqUsd < 50000) warnings.push("Low liquidity (<$50K)");
          if (impactPct > 2) warnings.push(`High entry impact (${formatPct(impactPct)})`);
          if (effectiveApy < 0) warnings.push("Negative effective APY");

          opportunities.push({
            chain,
            name: market.name,
            underlying,
            marketAddress: market.address,
            ptAddress: market.pt,
            syAddress: market.sy,
            maturityTimestamp: maturityTs,
            daysToMaturity: days,
            impliedApy,
            lpApy,
            variableApr,
            tvlUsd,
            poolLiquidityUsd: poolLiqUsd,
            entryImpactPct: impactPct,
            effectiveApy,
            capacityUsd,
            sortApy: Math.max(effectiveApy, lpApy),
            bestStrategy: bestIsLp ? "lp" : "pt_spot",
            totalPt: totalPt || undefined,
            totalSy: totalSy || undefined,
            warnings,
          });
        }

        // Phase 3: Morpho looping for Pendle PTs
        if (include_looping) {
          const ptsByChain: Record<string, { addr: string; idx: number }[]> = {};
          for (let i = 0; i < opportunities.length; i++) {
            const opp = opportunities[i];
            if (!opp.ptAddress) continue;
            const chainKey = opp.chain;
            if (!MORPHO_CHAIN_IDS[chainKey]) continue;
            if (!ptsByChain[chainKey]) ptsByChain[chainKey] = [];
            ptsByChain[chainKey].push({ addr: opp.ptAddress, idx: i });
          }

          if (Object.keys(ptsByChain).length > 0) {
            const morphoResults = await Promise.allSettled(
              Object.entries(ptsByChain).map(async ([c, entries]) => {
                const addrs = [...new Set(entries.map((e) => e.addr))];
                const markets = await findMorphoMarketsForPts(addrs, c);
                return { chain: c, markets, entries };
              })
            );

            for (const result of morphoResults) {
              if (result.status !== "fulfilled") continue;
              const { markets, entries } = result.value;

              for (const { addr, idx } of entries) {
                const market = markets.get(addr.toLowerCase());
                if (!market) continue;

                const opp = opportunities[idx];
                const lltv = formatMorphoLltv(market.lltv);
                if (lltv <= 0) continue;

                const borrowRatePct = (market.state?.borrowApy || 0) * 100;
                const availableLiquidityUsd = getEffectiveLiquidityUsd(market);

                let bestNet = opp.impliedApy;
                let bestLoop = 0;
                let bestLev = 1;

                for (let l = 1; l <= 5; l++) {
                  const lev = cumulativeLeverageAtLoop(lltv, l);
                  const net = opp.impliedApy * lev - borrowRatePct * (lev - 1);
                  if (net > bestNet) {
                    bestNet = net;
                    bestLoop = l;
                    bestLev = lev;
                  }
                }

                if (bestLoop > 0) {
                  opp.looping = {
                    marketKey: market.uniqueKey,
                    lltv,
                    borrowRatePct,
                    optimalLoops: bestLoop,
                    optimalLeverage: bestLev,
                    optimalNetApy: bestNet,
                    morphoLiquidityUsd: availableLiquidityUsd,
                  };

                  if (bestNet > opp.sortApy) {
                    opp.sortApy = bestNet;
                    opp.bestStrategy = "pt_loop";
                  }
                }

                if ((market.state?.utilization || 0) > 0.9) {
                  opp.warnings.push("Morpho utilization >90%");
                }
              }
            }
          }
        }

        // Phase 4: Merkl campaigns (best-effort, parallel)
        const uniqueChains = [...new Set(opportunities.map((o) => o.chain))];
        const merklMaps = new Map<string, Map<string, MerklCampaign[]>>();
        const merklResults = await Promise.allSettled(
          uniqueChains.map(async (c) => {
            const chainId = PENDLE_CHAIN_IDS[c];
            if (!chainId) return { chain: c, map: new Map<string, MerklCampaign[]>() };
            const result = await fetchMerklCampaigns(chainId).catch(() => ({
              campaigns: new Map<string, MerklCampaign[]>(),
              available: false,
            }));
            return { chain: c, map: result.campaigns };
          })
        );
        for (const r of merklResults) {
          if (r.status === "fulfilled") merklMaps.set(r.value.chain, r.value.map);
        }

        for (const opp of opportunities) {
          const merklMap = merklMaps.get(opp.chain);
          if (!merklMap) continue;
          const addrs = [opp.marketAddress, opp.ptAddress, opp.syAddress].filter(Boolean);
          const campaigns = lookupMerklCampaigns(merklMap, addrs);
          if (campaigns.length > 0) opp.merklCampaigns = campaigns;
        }

        // Phase 5: Sort, filter, format
        const negativeApyCount = opportunities.filter((o) => o.sortApy < 0).length;
        const filtered = opportunities.filter((o) => o.sortApy >= 0);
        filtered.sort((a, b) => b.sortApy - a.sortApy);
        const topOpps = filtered.slice(0, topN);

        if (topOpps.length === 0) {
          const scope = chainFilter ? `on ${PENDLE_CHAIN_NAMES[chainFilter] || chainFilter}` : "across all Pendle chains";
          const text = [
            `No Pendle opportunities found ${scope} matching criteria.`,
            `Capital: ${formatUsd(capital_usd)}, max impact: ${formatPct(max_price_impact_pct)}`,
            asset_filter ? `Asset filter: ${asset_filter}` : "",
            `Markets scanned: ${rawMarkets.length}`,
            ``,
            `--- Strategic Context ---`,
            `No results at this capital size may indicate thin liquidity, not lack of markets.`,
            ...(negativeApyCount > 0 ? [`${negativeApyCount} market(s) had negative effective APY (entry cost exceeds yield at your capital size).`] : []),
            `Pool liquidity determines how much capital can be deployed without excessive slippage.`,
            `Consider: deploying across multiple smaller positions, or providing LP instead of buying PT.`,
            ``,
            `Try: lower min_tvl_usd, increase max_price_impact_pct, or reduce capital_usd.`,
            `Use pendle_list_markets() for raw APY ranking without capital-aware sizing.`,
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        const lines: string[] = [];
        const scope = chainFilter ? PENDLE_CHAIN_NAMES[chainFilter] || chainFilter : "All Chains";
        lines.push(`== Pendle Opportunities: ${scope} ==`);
        lines.push(`  Capital: ${formatUsd(capital_usd)} | Max Impact: ${formatPct(max_price_impact_pct)}`);
        lines.push(`  Found: ${topOpps.length} opportunit${topOpps.length === 1 ? "y" : "ies"}${filtered.length > topN ? ` (showing top ${topN} of ${filtered.length})` : ""}`);
        if (asset_filter) lines.push(`  Asset filter: ${asset_filter}`);
        lines.push(``);

        for (let i = 0; i < topOpps.length; i++) {
          lines.push(formatOpportunity(topOpps[i], i + 1, compact));
          if (!compact) lines.push(``);
        }

        if (scan.failedChains.length > 0) {
          lines.push(`  Failed chains: ${scan.failedChains.join(", ")}`);
        }

        lines.push(``);
        if (negativeApyCount > 0) {
          lines.push(`  Note: Filtered ${negativeApyCount} opportunit${negativeApyCount === 1 ? "y" : "ies"} where entry cost exceeds yield (negative effective APY at ${formatUsd(capital_usd)} capital)`);
          lines.push(``);
        }

        lines.push(`--- Methodology ---`);
        lines.push(`  Impact model: Pendle logit AMM (scalarRoot=50, conservative). Real impact is typically lower.`);
        lines.push(`  Effective APY = Implied APY - (annualized entry impact at your capital size)`);
        lines.push(`  Capacity = max capital before impact exceeds ${formatPct(max_price_impact_pct)}`);
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`  • Market detail: pendle_get_market_details(chain=CHAIN, market_address=ADDR)`);
        lines.push(`  • Cross-protocol: mv_scan_curator_opportunities(capital_usd=${capital_usd}) for unified ranking`);
        lines.push(`  • Spectra scan: spectra_scan_opportunities(capital_usd=${capital_usd}) for Spectra-native ranking`);
        lines.push(`  • Compare: mv_compare_yield(chain=CHAIN, asset_filter="ASSET") for head-to-head`);
        // Dynamic tensions based on what the data actually shows
        const tensions: string[] = [];

        const shortMaturity = topOpps.filter(o => o.daysToMaturity < 21);
        if (shortMaturity.length > 0) {
          tensions.push(`${shortMaturity.length} result(s) mature in <21 days — short lock period amplifies entry cost impact`);
        }

        const lpDominant = topOpps.filter(o => o.bestStrategy === "lp");
        if (lpDominant.length > topOpps.length * 0.5) {
          tensions.push(`${lpDominant.length} of ${topOpps.length} results favor LP over PT — PENDLE incentives may be driving this (incentives depend on governance votes)`);
        }

        const capacityConstrained = topOpps.filter(o => capital_usd > o.capacityUsd * 0.8);
        if (capacityConstrained.length > 0) {
          tensions.push(`${capacityConstrained.length} result(s) near capacity at your capital size`);
        }

        const placeholderLoops = topOpps.filter(o => o.looping && !o.looping.marketKey);
        if (placeholderLoops.length > 0) {
          tensions.push(`${placeholderLoops.length} looping result(s) use placeholder rates — no Morpho market exists (creation is permissionless)`);
        }

        if (tensions.length > 0) {
          lines.push(``);
          lines.push(`--- Tensions in This Data ---`);
          tensions.forEach(t => lines.push(`  ⚡ ${t}`));
        }

        // Observation boundary
        lines.push(``);
        const boundaryLines = formatPrescriptiveObservationBoundary("pendle_scan");
        for (const bl of boundaryLines) lines.push(bl);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
