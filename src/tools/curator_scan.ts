/**
 * Tool: mv_scan_curator_opportunities
 *
 * Cross-protocol opportunity scanner for MetaVault curators.
 * Scans both Spectra and Pendle across all chains, computes capital-aware
 * metrics for both protocols, matches opportunities by underlying + maturity,
 * and ranks by effective yield.
 *
 * Composes existing primitives:
 *   - Spectra scanning from scanAllChainPools (same as scan_opportunities)
 *   - Pendle scanning from scanAllPendleMarkets
 *   - Maturity matching from matchByAssetAndMaturity
 *   - Price impact from estimatePriceImpact
 *   - Morpho looping from findMorphoMarketsForPts + cumulativeLeverageAtLoop
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MORPHO_CHAIN_IDS,
  SUPPORTED_CHAINS,
  PENDLE_CHAIN_IDS,
  PROTOCOL_CONSTANTS,
  resolveNetwork,
} from "../config.js";
import type { CuratorOpportunity, MerklCampaign } from "../types.js";
import { scanAllChainPools, scanAllPendleMarkets, findMorphoMarketsForPts, fetchVeTotalSupply, fetchHyperliquidFunding, resolveHyperliquidSymbol, fetchMerklCampaigns, lookupMerklCampaigns } from "../api.js";
import {
  formatPct,
  formatUsd,
  daysToMaturity,
  pendleDaysToMaturity,
  estimatePriceImpact,
  estimatePendlePriceImpact,
  estimateLoopingEntryCost,
  formatMorphoLltv,
  cumulativeLeverageAtLoop,
  matchByAssetAndMaturity,
  extractLpApyBreakdown,
  computeSpectraBoost,
  formatCuratorScanResults,
  formatCuratorOpportunityCompact,
  getEffectiveLiquidityUsd,
} from "../formatters.js";
import type { BoostInfo } from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "mv_scan_curator_opportunities",
    `Scan all Spectra AND Pendle chains for the best yield opportunities, sized to your capital.
Cross-protocol scanner designed for MetaVault curators who can allocate to either protocol.

Unlike spectra_scan_opportunities (Spectra-only), this tool includes Pendle markets with:
- Capital-aware price impact for BOTH protocols
- Maturity-aware cross-protocol matching (same underlying + similar expiry)
- Morpho looping analysis for Spectra PTs (Pendle looping in future phase)
- Unified ranking by effective APY across both protocols
- External Merkl campaign APR for both protocols (incentive programs beyond native yield)
- Protocol tags ([Spectra] vs [Pendle]) and cross-protocol match indicators

Unlike spectra_get_best_fixed_yields or pendle_list_markets, this tool computes effective APY
at YOUR capital size — a high-APY pool with thin liquidity may be useless at your scale.

The ranking can disagree with spectra_scan_opportunities because it includes a different opportunity
set (Pendle markets). This disagreement is intentional — both tools measure different things.

Use mv_compare_yield for detailed head-to-head on a specific chain.
Use spectra_model_metavault to model blended Spectra+Pendle MetaVault allocation.
Use spectra_get_curator_dashboard for operational monitoring of an existing MetaVault.`,
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
      max_price_impact_pct: z
        .number()
        .min(0)
        .max(100)
        .default(5)
        .describe("Filter out pools where entry impact exceeds this % (default 5)"),
      top_n: z
        .number()
        .default(15)
        .describe("Number of top results to return (default 15, max 50)"),
      include_looping: z
        .boolean()
        .default(true)
        .describe("Whether to check Morpho looping for Spectra PTs (default true)"),
      compact: z
        .boolean()
        .default(false)
        .describe("If true, return one-line-per-opportunity output (much shorter)."),
      ve_spectra_balance: z
        .number()
        .min(0)
        .optional()
        .describe("Your veSPECTRA token balance. Computes Spectra boost for LP APY."),
    },
    async ({
      capital_usd,
      asset_filter,
      min_tvl_usd,
      min_liquidity_usd,
      max_price_impact_pct,
      top_n: rawTopN,
      include_looping,
      compact,
      ve_spectra_balance,
    }) => {
      const topN = Math.min(Math.max(1, rawTopN), 50);

      try {
        // Resolve veSPECTRA data once (shared across all Spectra pools)
        let veTotalSupply: number | null = null;
        let veDataAvailable = true;
        if (ve_spectra_balance !== undefined && ve_spectra_balance > 0) {
          try {
            veTotalSupply = await fetchVeTotalSupply();
          } catch (err) {
            veDataAvailable = false;
            console.error(`Warning: could not fetch veSPECTRA totalSupply: ${(err as any).message}`);
          }
        }

        // ================================================================
        // PHASE 1: Parallel fetch Spectra pools + Pendle markets
        // ================================================================

        const [poolResult, pendleResult] = await Promise.all([
          scanAllChainPools({ min_tvl_usd, min_liquidity_usd, asset_filter }),
          scanAllPendleMarkets({ min_tvl_usd, min_liquidity_usd, asset_filter }),
        ]);

        const { opportunities: rawSpectra, failedChains: spectraFailed } = poolResult;
        const { markets: rawPendle, failedChains: pendleFailed } = pendleResult;
        const failedChains = [...new Set([...spectraFailed, ...pendleFailed])];

        // Fetch Merkl campaigns for all unique chains (best-effort, parallel)
        const allChainIds = new Map<string, number>();
        for (const { chain } of rawSpectra) {
          const net = resolveNetwork(chain);
          const info = SUPPORTED_CHAINS[net];
          if (info && !allChainIds.has(net)) allChainIds.set(net, info.id);
        }
        for (const { chain } of rawPendle) {
          const chainId = PENDLE_CHAIN_IDS[chain];
          if (chainId && !allChainIds.has(chain)) allChainIds.set(chain, chainId);
        }
        const curatorMerklMaps = new Map<string, Map<string, MerklCampaign[]>>();
        let merklAvailable = true;
        const curatorMerklResults = await Promise.allSettled(
          [...allChainIds.entries()].map(async ([net, chainId]) => {
            const result = await fetchMerklCampaigns(chainId).catch(() => ({ campaigns: new Map<string, MerklCampaign[]>(), available: false }));
            if (!result.available) merklAvailable = false;
            return { net, map: result.campaigns };
          })
        );
        for (const r of curatorMerklResults) {
          if (r.status === "fulfilled") curatorMerklMaps.set(r.value.net, r.value.map);
        }

        // ================================================================
        // PHASE 2: Compute capital-aware metrics for both protocols
        // ================================================================

        const maxImpactFrac = max_price_impact_pct / 100;
        const opportunities: CuratorOpportunity[] = [];
        const processingWarnings: string[] = [];

        // --- Spectra opportunities ---
        for (const { pt, pool, chain } of rawSpectra) {
          try {
            const impliedApy = pool.impliedApy || 0;
            const variableApr = pt.ibt?.apr?.total || 0;
            const poolLiqUsd = pool.liquidity?.usd || 0;
            const tvlUsd = pt.tvl?.usd || 0;
            const maturityTs = pt.maturity;
            const days = daysToMaturity(maturityTs);

            const impactFrac = estimatePriceImpact(capital_usd, poolLiqUsd);
            const impactPct = impactFrac * 100;

            const annualizedEntryCost = days > 0
              ? impactFrac * (365 / days) * 100
              : impactFrac * 100;
            const effectiveApy = impliedApy - annualizedEntryCost;
            const capacityUsd = maxImpactFrac * 2 * poolLiqUsd;

            // LP APY with optional veSPECTRA boost (computed before impact filter)
            let boostInfo: BoostInfo | undefined;
            if (ve_spectra_balance !== undefined && ve_spectra_balance > 0 && veTotalSupply !== null) {
              boostInfo = computeSpectraBoost(ve_spectra_balance, veTotalSupply, tvlUsd, capital_usd);
            }
            const lpData = extractLpApyBreakdown(pool, boostInfo?.boostFraction ?? 0);

            // Impact filter: skip only if BOTH PT and LP strategies are unviable
            // PT swap impact doesn't apply to LP adds, so LP-dominant pools should survive
            if (impactFrac > maxImpactFrac && lpData.lpApy <= 0) continue;

            const warnings: string[] = [];
            if (days < 14) warnings.push("Very short maturity (<14d)");
            else if (days < 30) warnings.push("Short maturity (<30d)");
            if (poolLiqUsd < 50000) warnings.push("Low liquidity (<$50K)");
            if (impactPct > 2) warnings.push(`High entry impact (${formatPct(impactPct)})`);
            if (effectiveApy < 0) warnings.push("Negative effective APY");

            const bestIsLp = lpData.lpApy > effectiveApy;

            // Look up Merkl campaigns
            const spectraNet = resolveNetwork(chain);
            const spectraMerklMap = curatorMerklMaps.get(spectraNet) || new Map();
            const spectraAddrs = [pt.address, pool.address, pt.ibt?.address].filter(Boolean) as string[];
            const spectraMerklCampaigns = lookupMerklCampaigns(spectraMerklMap, spectraAddrs);

            opportunities.push({
              protocol: "spectra",
              chain,
              name: pt.name,
              underlying: pt.underlying?.symbol || "?",
              maturityTimestamp: maturityTs,
              daysToMaturity: days,
              impliedApy,
              lpApy: lpData.lpApy,
              variableApr,
              tvlUsd,
              poolLiquidityUsd: poolLiqUsd,
              entryImpactPct: impactPct,
              effectiveApy,
              capacityUsd,
              sortApy: Math.max(effectiveApy, lpData.lpApy), // best strategy wins
              bestStrategy: bestIsLp ? "lp" : "pt_spot",     // updated in Phase 3 if looping beats both
              ptAddress: pt.address,
              poolAddress: pool.address || "",
              looping: null,
              lpApyBreakdown: lpData.lpApyBreakdown,
              merklCampaigns: spectraMerklCampaigns.length > 0 ? spectraMerklCampaigns : undefined,
              warnings,
            });
          } catch (err) {
            const ptName = pt?.name || pt?.address || "unknown";
            processingWarnings.push(`Skipped Spectra pool ${ptName} on ${chain}: ${(err as Error).message}`);
          }
        }

        // --- Pendle opportunities ---
        for (const { market, chain } of rawPendle) {
          try {
            const impliedApy = (market.details.impliedApy || 0) * 100;
            const variableApr = (market.details.underlyingApy || 0) * 100;
            const poolLiqUsd = market.details.liquidity || 0;
            const tvlUsd = market.details.totalTvl || 0;
            const days = pendleDaysToMaturity(market.expiry);
            const maturityTs = Math.floor(new Date(market.expiry).getTime() / 1000);
            const lpApy = (market.details.aggregatedApy || 0) * 100;

            // Pendle logit AMM impact: uses pool reserves + maturity for tighter estimate
            const totalPt = market.details.totalPt || 0;
            const totalSy = market.details.totalSy || 0;
            const impactFrac = estimatePendlePriceImpact(capital_usd, poolLiqUsd, totalPt, totalSy, days);
            const impactPct = impactFrac * 100;
            // Impact filter: skip only if BOTH PT and LP strategies are unviable
            if (impactFrac > maxImpactFrac && lpApy <= 0) continue;

            const annualizedEntryCost = days > 0
              ? impactFrac * (365 / days) * 100
              : impactFrac * 100;
            const effectiveApy = impliedApy - annualizedEntryCost;
            const capacityUsd = maxImpactFrac * 2 * poolLiqUsd;

            const warnings: string[] = [];
            if (days < 14) warnings.push("Very short maturity (<14d)");
            else if (days < 30) warnings.push("Short maturity (<30d)");
            if (poolLiqUsd < 50000) warnings.push("Low liquidity (<$50K)");
            if (impactPct > 2) warnings.push(`High entry impact (${formatPct(impactPct)})`);
            if (effectiveApy < 0) warnings.push("Negative effective APY");

            const bestIsLp = lpApy > effectiveApy;

            // Parse clean underlying symbol from Pendle market name (strip date suffix like "-26MAR2026")
            const pendleUnderlying = market.name.replace(/-\d{1,2}[A-Z]{3}\d{4}$/, "");

            // Build LP APY breakdown from Pendle market details
            const swapFeeApyPct = (market.details.swapFeeApy || 0) * 100;
            const pendleIncentivePct = (market.details.pendleApy || 0) * 100;
            const maxBoostedPct = (market.details.maxBoostedApy || 0) * 100;
            const pendleLpBreakdown: CuratorOpportunity["lpApyBreakdown"] = {
              fees: swapFeeApyPct,
              pt: 0,
              ibt: 0,
              rewards: pendleIncentivePct > 0 ? { PENDLE: pendleIncentivePct } : {},
              boostedRewards: maxBoostedPct > lpApy
                ? { PENDLE: { min: pendleIncentivePct, max: maxBoostedPct } }
                : {},
            };

            // Look up Merkl campaigns for Pendle market
            const pendleMerklMap = curatorMerklMaps.get(chain) || new Map();
            const pendleAddrs = [market.address, market.pt, market.yt, market.sy].filter(Boolean);
            const pendleMerklCampaigns = lookupMerklCampaigns(pendleMerklMap, pendleAddrs);

            opportunities.push({
              protocol: "pendle",
              chain,
              name: market.name,
              underlying: pendleUnderlying,
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
              sortApy: Math.max(effectiveApy, lpApy), // best strategy wins
              bestStrategy: bestIsLp ? "lp" : "pt_spot",
              pendleMarketAddress: market.address,
              pendlePtAddress: market.pt,
              pendleSyAddress: market.sy,
              lpApyBreakdown: pendleLpBreakdown,
              merklCampaigns: pendleMerklCampaigns.length > 0 ? pendleMerklCampaigns : undefined,
              warnings,
            });
          } catch (err) {
            const marketName = market?.name || market?.address || "unknown";
            processingWarnings.push(`Skipped Pendle market ${marketName} on ${chain}: ${(err as Error).message}`);
          }
        }

        // ================================================================
        // PHASE 3: Morpho looping for ALL PTs (Spectra + Pendle)
        // ================================================================

        if (include_looping) {
          // Group ALL PT addresses by Morpho-capable chain
          const ptsByChain: Record<string, { addr: string; idx: number }[]> = {};
          for (let i = 0; i < opportunities.length; i++) {
            const opp = opportunities[i];
            const ptAddr = opp.ptAddress || opp.pendlePtAddress;
            if (!ptAddr) continue;

            const network = resolveNetwork(opp.chain);
            if (!MORPHO_CHAIN_IDS[network]) continue;
            if (!ptsByChain[network]) ptsByChain[network] = [];
            ptsByChain[network].push({ addr: ptAddr, idx: i });
          }

          if (Object.keys(ptsByChain).length > 0) {

            // Parallel batch lookup
            const morphoChains = Object.keys(ptsByChain);
            const morphoResults = await Promise.allSettled(
              morphoChains.map(async (chain) => {
                const addrs = [...new Set(ptsByChain[chain].map(e => e.addr))];
                const markets = await findMorphoMarketsForPts(addrs, chain);
                return { chain, markets };
              })
            );

            // Apply Morpho data
            for (const result of morphoResults) {
              if (result.status !== "fulfilled") continue;
              const { chain, markets } = result.value;

              for (const entry of ptsByChain[chain]) {
                const market = markets.get(entry.addr.toLowerCase());
                const opp = opportunities[entry.idx];

                if (!market) {
                  // No Morpho market — compute hypothetical loop as creation signal
                  const hypoLltv = 0.86;  // standard LLTV assumption
                  const hypoBorrow = PROTOCOL_CONSTANTS.loopingDefaults.borrowRatePct;  // consistent with get_looping_strategy defaults
                  const morphoBlock: typeof opp.morpho = { marketExists: false };

                  if (opp.impliedApy > 0) {
                    let bestHypoNet = opp.impliedApy;
                    let bestHypoLoop = 0;
                    let bestHypoLev = 1;

                    for (let i = 1; i <= 5; i++) {
                      const lev = cumulativeLeverageAtLoop(hypoLltv, i);
                      const net = opp.impliedApy * lev - hypoBorrow * (lev - 1);
                      if (net > bestHypoNet) {
                        bestHypoNet = net;
                        bestHypoLoop = i;
                        bestHypoLev = lev;
                      }
                    }

                    if (bestHypoLoop > 0) {
                      morphoBlock.hypotheticalLltv = hypoLltv;
                      morphoBlock.hypotheticalBorrowRate = hypoBorrow;
                      morphoBlock.hypotheticalLoops = bestHypoLoop;
                      morphoBlock.hypotheticalLeverage = bestHypoLev;
                      morphoBlock.hypotheticalLoopNetApy = bestHypoNet;
                      // Use impliedApy (not effectiveApy) — curator controls liquidity depth,
                      // so entry impact is a design choice, not a given constraint
                      morphoBlock.hypotheticalBreakEvenBorrow = bestHypoLev > 1
                        ? (opp.impliedApy * bestHypoLev) / (bestHypoLev - 1)
                        : undefined;
                    }
                  }

                  opp.morpho = morphoBlock;
                  continue;
                }

                const lltv = formatMorphoLltv(market.lltv);
                const borrowRatePct = (market.state?.borrowApy || 0) * 100;
                const supplyApyPct = (market.state?.supplyApy || 0) * 100;
                const availableLiquidityUsd = getEffectiveLiquidityUsd(market);
                const utilization = market.state?.utilization || 0;

                // Populate morpho block for all markets (even if lltv is bad)
                opp.morpho = {
                  marketExists: true,
                  marketKey: market.uniqueKey,
                  lltv: lltv > 0 ? lltv : undefined,
                  supplyApyPct,
                  borrowApyPct: borrowRatePct,
                  availableLiquidityUsd,
                  utilization,
                };

                if (lltv <= 0) continue;

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

                if (bestLoop > 0) {
                  const { totalImpactPct: cumImpactPct } = estimateLoopingEntryCost(
                    capital_usd, opp.poolLiquidityUsd, lltv, bestLoop
                  );
                  const annualizedCumCost = opp.daysToMaturity > 0
                    ? cumImpactPct * (365 / opp.daysToMaturity)
                    : cumImpactPct;
                  const effectiveNetApy = bestNet - annualizedCumCost;

                  opp.looping = {
                    morphoMarketKey: market.uniqueKey,
                    lltv,
                    borrowRatePct,
                    optimalLoops: bestLoop,
                    optimalLeverage: bestLev,
                    optimalNetApy: bestNet,
                    optimalEffectiveNetApy: effectiveNetApy,
                    cumulativeEntryImpactPct: cumImpactPct,
                    morphoLiquidityUsd: availableLiquidityUsd,
                  };

                  // Break-even borrow rate: max borrow before loop goes negative
                  opp.morpho.breakEvenBorrowRate = bestLev > 1
                    ? (opp.effectiveApy * bestLev) / (bestLev - 1)
                    : undefined;

                  // Looping only becomes best strategy if it beats both LP and PT spot
                  if (effectiveNetApy > opp.sortApy) {
                    opp.sortApy = effectiveNetApy;
                    opp.bestStrategy = "pt_loop";
                  }
                }

                // Morpho warnings
                if (utilization > 0.9) {
                  opp.warnings.push("Morpho utilization >90% — limited borrow capacity");
                }
                if (availableLiquidityUsd > 0 && availableLiquidityUsd < capital_usd * 0.5) {
                  opp.warnings.push("Morpho liquidity may not support full loop at this capital size");
                }
              }
            }
          }
        }

        // ================================================================
        // PHASE 3.5: MetaVault gross estimate
        // ================================================================
        // Conservative estimate: LP APY + 30% of variable APR (YT compounding)
        for (const opp of opportunities) {
          if (opp.lpApy > 0 && opp.variableApr > 0) {
            opp.mvGrossEstimatePct = opp.lpApy + opp.variableApr * 0.3;
          }
          // YT exposure signal: variable APR significantly exceeds implied fixed rate
          if (opp.variableApr > opp.impliedApy * 2 && opp.impliedApy > 0) {
            opp.warnings.push("Variable APR 2x+ implied — consider YT exposure over PT");
          }
        }

        // ================================================================
        // PHASE 3.6: Hyperliquid funding rates (delta-neutral signals)
        // ================================================================
        // Best-effort: fetch funding rates in parallel, match to underlyings.
        // Stablecoins don't need hedging — only non-stable underlyings get funding data.
        let fundingAvailable = true;
        try {
          const fundingResult = await fetchHyperliquidFunding();
          fundingAvailable = fundingResult.available;
          const fundingMap = fundingResult.data;
          if (fundingMap.size > 0) {
            const STABLES = new Set(["USDC", "USDT", "DAI", "FRAX", "GHO", "LUSD", "AUSD", "NUSD", "SNUSD", "SUSD", "USP", "USDU", "SUSDU", "CUSD", "REUSD", "USDAI", "APYUSD", "COREUSD", "COREUSDC", "VBUSDC", "VBUSDT"]);
            for (const opp of opportunities) {
              if (STABLES.has(opp.underlying.toUpperCase())) continue;
              const symbol = resolveHyperliquidSymbol(opp.underlying);
              if (!symbol) continue;
              const annualized = fundingMap.get(symbol);
              if (annualized == null) continue;

              // For shorts: you PAY positive funding, RECEIVE negative funding
              // Delta-neutral cost budget = break-even borrow rate adjusted for funding
              const breakEven = opp.morpho?.breakEvenBorrowRate
                ?? opp.morpho?.hypotheticalBreakEvenBorrow;
              opp.funding = {
                perpSymbol: symbol,
                annualizedPct: annualized,
                deltaNeutralCostBudget: breakEven != null
                  ? breakEven - annualized  // subtract funding cost (negative funding adds budget)
                  : undefined,
              };
            }
          }
        } catch {
          // Non-fatal: funding data is best-effort
          fundingAvailable = false;
        }

        // ================================================================
        // PHASE 4: Cross-protocol maturity matching
        // ================================================================

        const spectraForMatch = opportunities
          .filter(o => o.protocol === "spectra")
          .map(o => {
            // Reconstruct minimal pt/pool for matching (we have the data in the opp)
            const pt = rawSpectra.find(r => r.pt.address === o.ptAddress);
            return pt ? { pt: pt.pt, pool: pt.pool, chain: o.chain } : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

        const pendleForMatch = rawPendle.map(p => ({ market: p.market, chain: p.chain }));

        const matches = matchByAssetAndMaturity(spectraForMatch, pendleForMatch, 90);

        // Tag matched opportunities with their cross-protocol counterpart
        for (const match of matches) {
          if (match.matchQuality === "unmatched" || !match.spectra || !match.pendle) continue;

          // Find corresponding CuratorOpportunity entries
          const spectraOpp = opportunities.find(
            o => o.protocol === "spectra" && o.ptAddress === match.spectra!.pt.address && o.chain === match.spectra!.chain
          );
          const pendleOpp = opportunities.find(
            o => o.protocol === "pendle" && o.pendleMarketAddress === match.pendle!.market.address && o.chain === match.pendle!.chain
          );

          if (spectraOpp && pendleOpp) {
            spectraOpp.matchedWith = {
              protocol: "pendle",
              chain: pendleOpp.chain,
              name: pendleOpp.name,
              impliedApy: pendleOpp.impliedApy,
              lpApy: pendleOpp.lpApy,
              maturityGapDays: match.maturityGapDays,
              matchQuality: match.matchQuality,
            };
            pendleOpp.matchedWith = {
              protocol: "spectra",
              chain: spectraOpp.chain,
              name: spectraOpp.name,
              impliedApy: spectraOpp.impliedApy,
              lpApy: spectraOpp.lpApy,
              maturityGapDays: match.maturityGapDays,
              matchQuality: match.matchQuality,
            };
          }
        }

        // ================================================================
        // PHASE 5: Sort, filter, and format
        // ================================================================

        // Filter out negative-sortApy opportunities
        const filtered = opportunities.filter(o => o.sortApy >= 0);
        filtered.sort((a, b) => b.sortApy - a.sortApy);
        const topOpps = filtered.slice(0, topN);

        const warningsSuffix = processingWarnings.length > 0
          ? `\n\n--- Processing Warnings (${processingWarnings.length} items skipped) ---\n${processingWarnings.join("\n")}`
          : "";

        if (topOpps.length === 0) {
          const lines = [
            `No opportunities found matching criteria (capital: ${formatUsd(capital_usd)}, max impact: ${formatPct(max_price_impact_pct)}).`,
            ...(asset_filter ? [`Asset filter: ${asset_filter}`] : []),
            ...(failedChains.length > 0 ? [`Failed chains: ${failedChains.join(", ")}`] : []),
            ``,
            `Spectra pools scanned: ${rawSpectra.length} | Pendle markets scanned: ${rawPendle.length}`,
            ``,
            `Try: lower min_tvl_usd/min_liquidity_usd, increase max_price_impact_pct, or reduce capital_usd.`,
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") + warningsSuffix }] };
        }

        let text = formatCuratorScanResults(
          topOpps,
          capital_usd,
          max_price_impact_pct,
          asset_filter,
          failedChains,
          compact,
        );

        if (!merklAvailable) {
          text += `\nNote: Merkl incentive data unavailable — external campaign APR may be missing from results above.\n`;
        }
        if (!fundingAvailable) {
          text += `\nNote: Hyperliquid funding rate data unavailable — delta-neutral hedge signals may be missing from results above.\n`;
        }
        if (!veDataAvailable && ve_spectra_balance !== undefined && ve_spectra_balance > 0) {
          text += `\nNote: veSPECTRA totalSupply unavailable (Base RPC unreachable) — boost calculations defaulted to min APY range.\n`;
        }

        return { content: [{ type: "text" as const, text: text + warningsSuffix }] };
      } catch (e: any) {
        const text = `Error scanning curator opportunities: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
