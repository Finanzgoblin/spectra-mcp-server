/**
 * Tool: spectra_scan_opportunities
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
  SUPPORTED_CHAINS,
  resolveNetwork,
} from "../config.js";
import type { ScanOpportunity, SpectraMetavault, MerklCampaign } from "../types.js";
import { scanAllChainPools, scanAllMetavaults, findMorphoMarketsForPts, fetchVeTotalSupply, fetchMerklCampaigns, lookupMerklCampaigns } from "../api.js";
import {
  formatPct,
  formatUsd,
  formatDate,
  daysToMaturity,
  estimatePriceImpact,
  estimateLpDepositImpact,
  estimateLoopingEntryCost,
  formatMorphoLltv,
  cumulativeLeverageAtLoop,
  formatScanResults,
  formatScanOpportunityCompact,
  formatMetavaultScanSection,
  extractLpApyBreakdown,
  computeSpectraBoost,
  getEffectiveLiquidityUsd,
  formatPrescriptiveObservationBoundary,
} from "../formatters.js";
import type { BoostInfo } from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "spectra_scan_opportunities",
    `Scan all Spectra chains for the best risk-adjusted yield opportunities, sized to
your capital.

Unlike spectra_get_best_fixed_yields (which ranks by raw APY), this tool computes:
- Entry price impact at YOUR capital size (a 50% APY pool with $10K liquidity is useless at $500K)
- Effective APY after amortizing entry cost over days to maturity
- Morpho looping availability and optimal leveraged net APY
- Pool capacity (max capital before price impact exceeds your threshold)
- IBT APR composition (organic base yield vs external incentive programs)
- Points program multipliers and asset tags per opportunity
- External Merkl campaign APR (incentive programs beyond native yield)
- Risk warnings (low liquidity, short maturity, high impact)
- MetaVault alternatives (curated auto-rolling LP vaults with YT compounding)

Returns opportunities ranked by effective APY (or looping net APY where available).
Ranking logic: when a profitable Morpho looping market exists, ranks by looping net APY
with cumulative entry cost amortized; otherwise ranks by effective APY (base APY minus
annualized entry cost).

MetaVaults are shown in a separate section (not interleaved with PT rankings) because
they have different risk profiles: variable APY, curator-managed, auto-rolling positions.
Set include_metavaults=false to skip MetaVault scanning.

NOTE: This scans Spectra pools only. For broader coverage including Pendle markets,
use mv_scan_curator_opportunities — it includes both protocols and may surface significantly
more opportunities, especially at smaller capital sizes.

Effective APY is a conservative lower bound (constant-product impact model). Real Curve
StableSwap-NG pools are more capital-efficient. Verify top picks with spectra_quote_trade().

Output includes conditional competing interpretations when rankings are ambiguous —
e.g., thin-liquidity pools dominating the ranking, or MetaVaults with high idle ratios.

Use spectra_get_looping_strategy to drill into a specific opportunity's leverage details.
Use spectra_get_pool_activity and spectra_get_portfolio to investigate trading patterns and positions.
Use spectra_model_metavault to model MetaVault looping economics.`,
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
      include_metavaults: z
        .boolean()
        .default(true)
        .describe("Whether to include MetaVault alternatives in results (default true). MetaVaults are curated auto-rolling LP vaults shown in a separate section."),
      compact: z
        .boolean()
        .default(false)
        .describe("If true, return one-line-per-opportunity output (much shorter). Omit for full details."),
      envelope: z
        .boolean()
        .default(false)
        .describe("If true, return structured two-block response: JSON data + narrative layer. Enables programmatic extraction while preserving interpretive content. Overridden by compact mode."),
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
      include_metavaults,
      ve_spectra_balance,
      compact,
      envelope,
    }) => {
      const topN = Math.min(Math.max(1, rawTopN), 50);

      try {
        // Resolve veSPECTRA data once (shared across all pools)
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
        // PHASE 1: Parallel fetch all chains + MetaVaults
        // ================================================================

        const [poolResult, metavaultResult] = await Promise.all([
          scanAllChainPools({ min_tvl_usd, min_liquidity_usd, asset_filter }),
          include_metavaults
            ? scanAllMetavaults()
            : Promise.resolve({ metavaults: [] as Array<{ metavault: any; chain: string }> }),
        ]);

        const { opportunities: rawOpps, failedChains } = poolResult;

        // Fetch Merkl campaigns for unique chains in results (best-effort, parallel)
        const uniqueChainIds = new Map<string, number>();
        for (const { chain } of rawOpps) {
          const net = resolveNetwork(chain);
          const info = SUPPORTED_CHAINS[net];
          if (info && !uniqueChainIds.has(net)) uniqueChainIds.set(net, info.id);
        }
        const merklMaps = new Map<string, Map<string, MerklCampaign[]>>();
        let merklAvailable = true;
        const merklResults = await Promise.allSettled(
          [...uniqueChainIds.entries()].map(async ([net, chainId]) => {
            const result = await fetchMerklCampaigns(chainId).catch(() => ({ campaigns: new Map<string, MerklCampaign[]>(), available: false }));
            if (!result.available) merklAvailable = false;
            return { net, map: result.campaigns };
          })
        );
        for (const r of merklResults) {
          if (r.status === "fulfilled") merklMaps.set(r.value.net, r.value.map);
        }

        // ================================================================
        // PHASE 2: Compute capital-aware metrics per opportunity
        // ================================================================

        const maxImpactFrac = max_price_impact_pct / 100;
        const opportunities: ScanOpportunity[] = [];
        const boostInfoPerOpp: (BoostInfo | undefined)[] = []; // parallel to opportunities

        for (const { pt, pool, chain } of rawOpps) {
          try {
            const impliedApy = pool.impliedApy || 0;
            const variableApr = pt.ibt?.apr?.total || 0;
            const poolLiqUsd = pool.liquidity?.usd || 0;
            const tvlUsd = pt.tvl?.usd || 0;
            const maturityTs = pt.maturity;
            const days = daysToMaturity(maturityTs);

            // Price impact at agent's capital size (PT swap impact)
            const impactFrac = estimatePriceImpact(capital_usd, poolLiqUsd);
            const impactPct = impactFrac * 100;

            // LP deposit impact (much lower than swap impact for balanced deposits)
            const lpImpactFrac = estimateLpDepositImpact(capital_usd, poolLiqUsd);

            // Effective APY: base APY minus entry cost amortized over holding period
            // Entry cost (fraction) annualized: impactFrac * (365 / days) * 100 (as %)
            const annualizedEntryCost = days > 0
              ? impactFrac * (365 / days) * 100
              : impactFrac * 100;
            const effectiveApy = impliedApy - annualizedEntryCost;

            // Extract LP APY with gauge emissions BEFORE filtering (needed to determine best strategy)
            let boostInfo: BoostInfo | undefined;
            if (ve_spectra_balance !== undefined && ve_spectra_balance > 0 && veTotalSupply !== null) {
              boostInfo = computeSpectraBoost(ve_spectra_balance, veTotalSupply, tvlUsd, capital_usd);
            }
            const lpData = extractLpApyBreakdown(pool, boostInfo?.boostFraction ?? 0);

            // Determine best strategy: LP vs PT spot
            const bestIsLp = lpData.lpApy > effectiveApy;

            // Filter by max price impact using the RELEVANT impact for the best strategy:
            // - PT swap impact for directional PT buying
            // - LP deposit impact for LP provision (much lower — LP adds deepen pools)
            const relevantImpact = bestIsLp ? lpImpactFrac : impactFrac;
            if (relevantImpact > maxImpactFrac) continue;

            // Capacity: max capital where impact < threshold
            // For PT: impactFrac = capital / (2 * poolLiq) => capital = threshold * 2 * poolLiq
            // For LP: capacity is much higher (LP adds deepen pools)
            const capacityUsd = bestIsLp
              ? poolLiqUsd * 10  // LP capacity is roughly 10x+ swap capacity (conservative)
              : maxImpactFrac * 2 * poolLiqUsd;

            // Warnings
            const warnings: string[] = [];
            if (days < 14) warnings.push("Very short maturity (<14 days)");
            else if (days < 30) warnings.push("Short maturity (<30 days)");
            if (poolLiqUsd < 50000) warnings.push("Low pool liquidity (<$50K)");
            if (!bestIsLp && impactPct > 2) warnings.push(`Significant entry impact (${formatPct(impactPct)})`);
            if (tvlUsd < 50000) warnings.push("Low TVL (<$50K)");
            if (effectiveApy < 0 && !bestIsLp) warnings.push("Effective APY negative after entry cost");

            // Look up Merkl campaigns for this pool
            const network = resolveNetwork(chain);
            const merklMap = merklMaps.get(network) || new Map();
            const lookupAddrs = [pt.address, pool.address, pt.ibt?.address].filter(Boolean) as string[];
            const merklCampaigns = lookupMerklCampaigns(merklMap, lookupAddrs);

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
              capitalUsd: capital_usd,
              entryImpactPct: bestIsLp ? lpImpactFrac * 100 : impactPct,
              effectiveApy,
              capacityUsd,
              looping: null,           // filled in Phase 3
              lpApy: lpData.lpApy,
              lpApyBoostedTotal: lpData.lpApyBoostedTotal,
              lpApyAtBoost: lpData.lpApyAtBoost,
              lpApyBreakdown: lpData.lpApyBreakdown,
              merklCampaigns: merklCampaigns.length > 0 ? merklCampaigns : undefined,
              sortApy: bestIsLp ? lpData.lpApy : effectiveApy,   // LP APY if LP is best strategy; updated in Phase 3 if looping profitable
              underlying: pt.underlying?.symbol || "?",
              ibtAddress: pt.ibt?.address || "",
              ibtSymbol: pt.ibt?.symbol || "?",
              ibtProtocol: pt.ibt?.protocol || "Unknown",
              warnings,
            });
            boostInfoPerOpp.push(boostInfo);
          } catch (err: any) {
            // H3: Skip malformed entries instead of crashing the entire scan
            console.error(`Warning: skipping pool ${pt?.address || "?"} on ${chain}: ${err.message}`);
            continue;
          }
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
              const morphoLiqUsd = getEffectiveLiquidityUsd(market);

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
                // M2: Only override sortApy when looping effective APY actually beats base effective APY
                if (effectiveNetApy > opp.effectiveApy) {
                  opp.sortApy = effectiveNetApy;
                }

                // M6: Warn if Morpho market lacks sufficient borrow liquidity for the recommended loops
                const requiredBorrowUsd = capital_usd * (bestLev - 1);
                if (morphoLiqUsd > 0 && requiredBorrowUsd > morphoLiqUsd) {
                  opp.warnings.push(`Morpho borrow liquidity (${formatUsd(morphoLiqUsd)}) insufficient for ${bestLoop} loops at ${formatUsd(capital_usd)} capital (needs ${formatUsd(requiredBorrowUsd)})`);
                }
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
          const negativeFilteredCount = opportunities.filter(o => o.sortApy < 0).length;
          const lines = [
            `No PT pool opportunities found matching criteria (capital: ${formatUsd(capital_usd)}, max impact: ${formatPct(max_price_impact_pct)}).`,
            ...(asset_filter ? [`Asset filter: ${asset_filter}.`] : []),
            ...(failedChains.length > 0 ? [`Note: ${failedChains.length} chain(s) failed (${failedChains.join(", ")}).`] : []),
            ``,
            `--- What This Means ---`,
            ...(negativeFilteredCount > 0 ? [`${negativeFilteredCount} pool(s) had negative effective APY (entry cost exceeds yield at ${formatUsd(capital_usd)} capital).`] : []),
            `At your capital size, price impact may consume more yield than the pools generate.`,
            ``,
            `Alternative approaches:`,
            `• Try a smaller capital size or increase max_price_impact_pct`,
            `• Lower filters: min_tvl_usd or min_liquidity_usd`,
            ...(asset_filter ? [`• Remove asset filter to see all available pools`] : []),
            `• Check raw APY: spectra_get_best_fixed_yields() — headline rates without capital adjustment`,
            `• Check YT spreads: spectra_scan_yt_arbitrage(capital_usd=${capital_usd}) — different opportunity type`,
          ];

          // Still show MetaVault alternatives even when no PT pools match
          if (include_metavaults && metavaultResult.metavaults.length > 0) {
            let filteredMvs = metavaultResult.metavaults;
            if (asset_filter) {
              const filterLower = asset_filter.toLowerCase();
              filteredMvs = filteredMvs.filter(({ metavault }) =>
                (metavault.underlying?.symbol || "").toLowerCase().includes(filterLower)
              );
            }
            filteredMvs = filteredMvs.filter(({ metavault }) =>
              (metavault.tvl?.usd || 0) >= min_tvl_usd
            );
            if (filteredMvs.length > 0) {
              lines.push(``);
              lines.push(`However, MetaVault alternatives are available:`);
              lines.push(formatMetavaultScanSection(filteredMvs, compact));
            }
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        // ================================================================
        // PHASE 4b: Filter MetaVaults (shared by all output modes)
        // ================================================================

        let filteredMvs: Array<{ metavault: SpectraMetavault; chain: string }> = [];
        if (include_metavaults && metavaultResult.metavaults.length > 0) {
          filteredMvs = metavaultResult.metavaults;
          if (asset_filter) {
            const filterLower = asset_filter.toLowerCase();
            filteredMvs = filteredMvs.filter(({ metavault }) =>
              (metavault.underlying?.symbol || "").toLowerCase().includes(filterLower)
            );
          }
          filteredMvs = filteredMvs.filter(({ metavault }) =>
            (metavault.tvl?.usd || 0) >= min_tvl_usd
          );
        }

        // ================================================================
        // PHASE 4c: Build dynamic tensions (shared by all output modes)
        // ================================================================

        const tensions: string[] = [];

        const gaugeDependent = topOpps.filter(o => {
          const gaugeTotal = Object.values(o.lpApyBreakdown.boostedRewards).reduce((s, r) => s + (r.min || 0), 0);
          return gaugeTotal > 0 && gaugeTotal > (o.lpApy * 0.5);
        });
        if (gaugeDependent.length > 0) {
          tensions.push(`${gaugeDependent.length} of ${topOpps.length} results derive >50% of LP APY from gauge emissions — gauge votes reset weekly`);
        }

        const placeholderLoops = topOpps.filter(o => o.looping && o.warnings.some(w => w.toLowerCase().includes("placeholder") || w.toLowerCase().includes("not from a real")));
        if (placeholderLoops.length > 0) {
          tensions.push(`${placeholderLoops.length} result(s) show looping APY based on placeholder borrow rates — no Morpho market exists yet (market creation is permissionless)`);
        }

        const shortMaturity = topOpps.filter(o => o.daysToMaturity < 21);
        if (shortMaturity.length > 0) {
          tensions.push(`${shortMaturity.length} result(s) mature in <21 days — entry cost amortizes over a shorter period, amplifying impact on effective APY`);
        }

        const capacityConstrained = topOpps.filter(o => capital_usd > o.capacityUsd * 0.8);
        if (capacityConstrained.length > 0) {
          tensions.push(`${capacityConstrained.length} result(s) are near capacity at your capital size — actual entry impact may exceed estimates`);
        }

        const highEntryCost = topOpps.filter(o => o.impliedApy > 0 && (o.impliedApy - o.effectiveApy) / o.impliedApy > 0.25);
        if (highEntryCost.length > 0) {
          tensions.push(`${highEntryCost.length} result(s) lose >25% of implied APY to entry cost at your capital size`);
        }

        // ================================================================
        // PHASE 5: Build output — envelope, compact, or full prose
        // ================================================================

        const truncNote = indexed.length > topN ? ` (showing top ${topOpps.length} of ${indexed.length})` : "";

        // ── Envelope mode: structured JSON + narrative layer ──
        if (envelope && !compact) {
          return buildEnvelopeResponse(
            topOpps, topBoostInfos, filteredMvs, tensions,
            capital_usd, max_price_impact_pct, asset_filter,
            failedChains, include_looping, merklAvailable, veDataAvailable,
            ve_spectra_balance, indexed.length,
          );
        }

        // ── Compact mode or standard prose ──
        let text: string;
        if (compact) {
          const lines = [`== Opportunity Scan: ${formatUsd(capital_usd)} capital ==`];
          if (asset_filter) lines.push(`  Asset: ${asset_filter}`);
          lines.push(`  Results: ${topOpps.length}${truncNote} | Max Impact: ${formatPct(max_price_impact_pct)}`);
          if (failedChains.length > 0) lines.push(`  Failed: ${failedChains.join(", ")}`);
          if (!merklAvailable) lines.push(`  Note: Merkl incentive data unavailable — external campaign APR may be missing`);
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
          indexed.length,
        );
        }

        if (!merklAvailable) {
          text += `\nNote: Merkl incentive data unavailable — external campaign APR may be missing from results above.\n`;
        }
        if (!veDataAvailable && ve_spectra_balance !== undefined && ve_spectra_balance > 0) {
          text += `\nNote: veSPECTRA totalSupply unavailable (Base RPC unreachable) — boost calculations defaulted to min APY range.\n`;
        }

        if (filteredMvs.length > 0) {
          text += formatMetavaultScanSection(filteredMvs, compact);
        }

        // Next-step hints referencing top opportunity
        const top = topOpps[0];
        const nextStepLines = [
          ``,
          `--- Next Steps ---`,
          `• Drill into #1: spectra_get_looping_strategy(chain="${top.chain}", pt_address="${top.ptAddress}") for detailed leverage table`,
          `• Quote entry: spectra_quote_trade(chain="${top.chain}", pt_address="${top.ptAddress}", amount=${capital_usd}, side="buy")`,
          `• Preview portfolio: spectra_simulate_trade(chain="${top.chain}", pt_address="${top.ptAddress}", address=YOUR_WALLET, amount=${capital_usd}, side="buy")`,
          `• Compare with YT arb: spectra_scan_yt_arbitrage(capital_usd=${capital_usd}) for spread-based opportunities`,
        ];

        if (include_metavaults && metavaultResult.metavaults.length > 0) {
          const topMv = metavaultResult.metavaults
            .sort((a, b) => (b.metavault.liveApy?.total || 0) - (a.metavault.liveApy?.total || 0))[0];
          if (topMv) {
            nextStepLines.push(`• Model MetaVault: spectra_model_metavault(chain="${topMv.chain}", metavault_address="${topMv.metavault.address}") for looping economics`);
          }
        }

        nextStepLines.push(`• Cross-protocol: mv_scan_curator_opportunities(capital_usd=${capital_usd}) for unified Spectra + Pendle ranking`);

        text += nextStepLines.join("\n");

        if (tensions.length > 0) {
          text += `\n\n--- Tensions in This Data ---\n` + tensions.map(t => `⚡ ${t}`).join("\n");
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error scanning opportunities: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}

// =============================================================================
// Envelope Builder — structured JSON + narrative layer
// =============================================================================

interface EnvelopeOpportunity {
  rank: number;
  name: string;
  chain: string;
  ptAddress: string;
  poolAddress: string;
  ibtAddress: string;
  maturity: string;
  daysToMaturity: number;
  tvlUsd: number;
  poolLiquidityUsd: number;
  entryImpactPct: number;
  capacityUsd: number;
  impliedApy: number;
  effectiveApy: number;
  variableApr: number;
  fixedVsVariableSpread: number;
  sortApy: number;
  lpApy: number;
  lpApyMaxBoost: number;
  lpBreakdown: {
    fees: number;
    pt: number;
    ibt: number;
    rewards: Record<string, number>;
    spectraGauge: Record<string, { min: number; max: number }>;
  };
  ibtApr: {
    total: number;
    base: number | null;
    rewards: Record<string, number>;
  };
  underlying: string;
  ibtSymbol: string;
  ibtProtocol: string;
  looping: {
    morphoMarketKey: string;
    lltv: number;
    borrowRatePct: number;
    optimalLoops: number;
    optimalLeverage: number;
    optimalNetApy: number;
    optimalEffectiveNetApy: number;
    cumulativeEntryImpactPct: number;
    morphoLiquidityUsd: number;
    loopCurve: Array<{ loop: number; leverage: number; netApy: number }>;
  } | null;
  poolReserves: { ibt: number; pt: number; ratio: number } | null;
  tags: string[];
  points: Array<{ name: string; amount: number }>;
  merklCampaigns: Array<{ name: string; apr: number; action: string; rewardTokens: string[] }>;
  warnings: string[];
}

interface EnvelopeMetavault {
  name: string;
  symbol: string;
  chain: string;
  address: string;
  underlying: string;
  tvlUsd: number;
  liveApyTotal: number;
  liveApyBase: number | null;
  curator: string;
  activePositions: number;
}

interface EnvelopeData {
  scan: {
    capitalUsd: number;
    maxImpactPct: number;
    assetFilter: string | null;
    loopingEnabled: boolean;
    resultCount: number;
    totalBeforeFilter: number;
    failedChains: string[];
    merklAvailable: boolean;
    veDataAvailable: boolean;
    veSpectraBalance: number | null;
  };
  opportunities: EnvelopeOpportunity[];
  metavaults: EnvelopeMetavault[];
}

function serializeOpportunity(opp: ScanOpportunity, rank: number): EnvelopeOpportunity {
  // Pool reserves
  let poolReserves: EnvelopeOpportunity["poolReserves"] = null;
  if (opp.pool.ibtAmount && opp.pool.ptAmount) {
    const ibtDec = opp.pt.ibt?.decimals ?? 18;
    const ptDec = opp.pt.decimals ?? 18;
    const ibtAmt = Number(opp.pool.ibtAmount) / 10 ** ibtDec;
    const ptAmt = Number(opp.pool.ptAmount) / 10 ** ptDec;
    if (ibtAmt > 0 && ptAmt > 0) {
      poolReserves = { ibt: round4(ibtAmt), pt: round4(ptAmt), ratio: round4(ptAmt / ibtAmt) };
    }
  }

  // Loop curve
  let loopingData: EnvelopeOpportunity["looping"] = null;
  if (opp.looping && opp.looping.lltv > 0) {
    const curve: Array<{ loop: number; leverage: number; netApy: number }> = [];
    for (let i = 1; i <= 5; i++) {
      const lev = cumulativeLeverageAtLoop(i, opp.looping.lltv);
      const borrowed = lev - 1;
      const grossApy = lev * opp.impliedApy;
      const borrowCost = borrowed * opp.looping.borrowRatePct;
      const netApy = grossApy - borrowCost;
      curve.push({ loop: i, leverage: round4(lev), netApy: round4(netApy) });
    }
    loopingData = {
      morphoMarketKey: opp.looping.morphoMarketKey,
      lltv: opp.looping.lltv,
      borrowRatePct: round4(opp.looping.borrowRatePct),
      optimalLoops: opp.looping.optimalLoops,
      optimalLeverage: round4(opp.looping.optimalLeverage),
      optimalNetApy: round4(opp.looping.optimalNetApy),
      optimalEffectiveNetApy: round4(opp.looping.optimalEffectiveNetApy),
      cumulativeEntryImpactPct: round4(opp.looping.cumulativeEntryImpactPct),
      morphoLiquidityUsd: round4(opp.looping.morphoLiquidityUsd),
      loopCurve: curve,
    };
  }

  // IBT APR details
  const ibtDetails = opp.pt.ibt?.apr?.details;
  const ibtApr = {
    total: round4(opp.variableApr),
    base: ibtDetails?.base != null ? round4(ibtDetails.base) : null,
    rewards: {} as Record<string, number>,
  };
  if (ibtDetails?.rewards) {
    for (const [token, apy] of Object.entries(ibtDetails.rewards)) {
      ibtApr.rewards[token] = round4(apy);
    }
  }

  return {
    rank,
    name: opp.pt.name,
    chain: opp.chain,
    ptAddress: opp.ptAddress,
    poolAddress: opp.poolAddress,
    ibtAddress: opp.ibtAddress,
    maturity: formatDate(opp.maturityTimestamp),
    daysToMaturity: opp.daysToMaturity,
    tvlUsd: round4(opp.tvlUsd),
    poolLiquidityUsd: round4(opp.poolLiquidityUsd),
    entryImpactPct: round4(opp.entryImpactPct),
    capacityUsd: round4(opp.capacityUsd),
    impliedApy: round4(opp.impliedApy),
    effectiveApy: round4(opp.effectiveApy),
    variableApr: round4(opp.variableApr),
    fixedVsVariableSpread: round4(opp.fixedVsVariableSpread),
    sortApy: round4(opp.sortApy),
    lpApy: round4(opp.lpApy),
    lpApyMaxBoost: round4(opp.lpApyBoostedTotal),
    lpBreakdown: {
      fees: round4(opp.lpApyBreakdown.fees),
      pt: round4(opp.lpApyBreakdown.pt),
      ibt: round4(opp.lpApyBreakdown.ibt),
      rewards: mapValues(opp.lpApyBreakdown.rewards, round4),
      spectraGauge: mapValues(opp.lpApyBreakdown.boostedRewards, (v: { min: number; max: number }) => ({
        min: round4(v.min),
        max: round4(v.max),
      })) as Record<string, { min: number; max: number }>,
    },
    ibtApr,
    underlying: opp.underlying,
    ibtSymbol: opp.ibtSymbol,
    ibtProtocol: opp.ibtProtocol,
    looping: loopingData,
    poolReserves,
    tags: opp.pt.tags || [],
    points: (opp.pt.multipliers || []).map(m => ({ name: m.name, amount: m.amount })),
    merklCampaigns: (opp.merklCampaigns || []).map(c => ({
      name: c.name,
      apr: round4(c.apr),
      action: c.action,
      rewardTokens: c.rewardTokens,
    })),
    warnings: opp.warnings,
  };
}

function serializeMetavault(mv: any, chain: string): EnvelopeMetavault {
  const activePositions = (mv.positions || []).filter((p: any) => p.maturity * 1000 > Date.now());
  return {
    name: mv.metadata?.title || mv.name,
    symbol: mv.symbol,
    chain,
    address: mv.address,
    underlying: mv.underlying?.symbol || "?",
    tvlUsd: round4(mv.tvl?.usd || 0),
    liveApyTotal: round4(mv.liveApy?.total || 0),
    liveApyBase: mv.liveApy?.details?.base != null ? round4(mv.liveApy.details.base) : null,
    curator: mv.curator?.name || "Unknown",
    activePositions: activePositions.length,
  };
}

function buildNarrativeLayer(
  topOpps: ScanOpportunity[],
  tensions: string[],
  merklAvailable: boolean,
  veDataAvailable: boolean,
  veSpectraBalance: number | undefined,
): string {
  const lines: string[] = [];

  // ── Impact accuracy framing (once, not per opportunity) ──
  lines.push(`--- Impact Accuracy ---`);
  lines.push(`Effective APY values are CONSERVATIVE LOWER BOUNDS. Entry impact uses a constant-product model; real Curve StableSwap-NG pools are more capital-efficient — actual effective APY is typically 30-60% higher. Verify top picks with spectra_quote_trade for exact on-chain quotes.`);
  lines.push(``);
  lines.push(`Rankings reflect one dimension of a multi-dimensional space. A lower-ranked pool could be better for a different strategy (YT accumulation, LP farming) or time horizon.`);
  lines.push(``);

  // ── Per-opportunity tensions (only when data triggers them) ──
  const perOppTensions: string[] = [];

  for (let i = 0; i < topOpps.length; i++) {
    const opp = topOpps[i];
    const oppLines: string[] = [];

    // Strategy tension: YT vs looping
    if (opp.variableApr > 0 && opp.looping) {
      const ytExposure = opp.variableApr * (opp.pool.ytLeverage || 1);
      if (ytExposure > opp.looping.optimalEffectiveNetApy * 0.7) {
        oppLines.push(`YT accumulation at ${(opp.pool.ytLeverage || 0).toFixed(1)}x leverage could yield ~${formatPct(ytExposure)} if variable rates persist — competes with looping fixed ~${formatPct(opp.looping.optimalEffectiveNetApy)}. Choice depends on rate direction conviction.`);
      }
    }

    // Combined LP + Loop strategy hint
    if (opp.looping && opp.lpApy > 5) {
      const bestLp = opp.lpApyBoostedTotal > opp.lpApy ? opp.lpApyBoostedTotal : opp.lpApy;
      if (bestLp > opp.looping.optimalEffectiveNetApy * 0.5) {
        oppLines.push(`Combined strategy viable: Mint PT+YT, LP a portion (${formatPct(bestLp)} LP APY) + loop remaining PT via Morpho (${formatPct(opp.looping.optimalEffectiveNetApy)} net). Split ratio depends on pool depth vs Morpho liquidity.`);
      }
    }

    // Reserve interpretation
    if (opp.pool.ibtAmount && opp.pool.ptAmount) {
      const ibtDec = opp.pt.ibt?.decimals ?? 18;
      const ptDec = opp.pt.decimals ?? 18;
      const ibtAmt = Number(opp.pool.ibtAmount) / 10 ** ibtDec;
      const ptAmt = Number(opp.pool.ptAmount) / 10 ** ptDec;
      if (ibtAmt > 0 && ptAmt > 0) {
        const ratio = ptAmt / ibtAmt;
        if (ratio > 5) {
          oppLines.push(`Heavy PT side (${ratio.toFixed(1)}:1) — could mean high PT supply from minting, or LP withdrawal on IBT side.`);
        } else if (ratio < 0.2) {
          oppLines.push(`Heavy IBT side (1:${(1/ratio).toFixed(1)}) — could mean strong PT demand (rate compression), or fresh pool with few mints.`);
        }
      }
    }

    // Incentive sustainability
    const ibtDet = opp.pt.ibt?.apr?.details;
    if (ibtDet) {
      const ibtBase = ibtDet.base ?? 0;
      if (opp.variableApr > 0 && ibtBase < opp.variableApr * 0.5) {
        const incentivePct = ((opp.variableApr - ibtBase) / opp.variableApr * 100).toFixed(0);
        oppLines.push(`${incentivePct}% of IBT APR is incentive-driven. Base alone: ${formatPct(ibtBase)}. Sustainability depends on incentive program continuity.`);
      }
    }

    if (oppLines.length > 0) {
      perOppTensions.push(`#${i + 1} ${opp.pt.name}:\n` + oppLines.map(l => `  - ${l}`).join("\n"));
    }
  }

  if (perOppTensions.length > 0) {
    lines.push(`--- Per-Opportunity Tensions ---`);
    lines.push(perOppTensions.join("\n"));
    lines.push(``);
  }

  // ── Global tensions (aggregate across result set) ──
  if (tensions.length > 0) {
    lines.push(`--- Global Tensions ---`);
    for (const t of tensions) lines.push(`- ${t}`);
    lines.push(``);
  }

  // ── Observation boundaries ──
  // The Dialectician found: prescriptive tools that recommend capital deployment
  // must declare what they cannot see, with the same honesty as diagnostic tools.
  const scanExtras: string[] = [
    `This scan covers Spectra pools only. Use mv_scan_curator_opportunities for cross-protocol coverage.`,
  ];
  if (!merklAvailable) {
    scanExtras.push(`Merkl incentive data was unavailable — external campaign APR may be missing.`);
  }
  if (!veDataAvailable && veSpectraBalance !== undefined && veSpectraBalance > 0) {
    scanExtras.push(`veSPECTRA totalSupply unavailable (Base RPC unreachable) — boost calculations defaulted to min APY range.`);
  }
  const boundaryLines = formatPrescriptiveObservationBoundary("scan", scanExtras);
  for (const bl of boundaryLines) lines.push(bl);

  return lines.join("\n");
}

function buildEnvelopeResponse(
  topOpps: ScanOpportunity[],
  topBoostInfos: (import("../formatters.js").BoostInfo | undefined)[],
  filteredMvs: Array<{ metavault: any; chain: string }>,
  tensions: string[],
  capitalUsd: number,
  maxImpactPct: number,
  assetFilter: string | undefined,
  failedChains: string[],
  includeLooping: boolean,
  merklAvailable: boolean,
  veDataAvailable: boolean,
  veSpectraBalance: number | undefined,
  totalBeforeFilter: number,
): { content: Array<{ type: "text"; text: string }> } {
  // Build structured data
  const structuredData: EnvelopeData = {
    scan: {
      capitalUsd,
      maxImpactPct,
      assetFilter: assetFilter || null,
      loopingEnabled: includeLooping,
      resultCount: topOpps.length,
      totalBeforeFilter,
      failedChains,
      merklAvailable,
      veDataAvailable,
      veSpectraBalance: veSpectraBalance ?? null,
    },
    opportunities: topOpps.map((opp, i) => serializeOpportunity(opp, i + 1)),
    metavaults: filteredMvs.map(({ metavault, chain }) => serializeMetavault(metavault, chain)),
  };

  // Build narrative layer
  const narrativeLayer = buildNarrativeLayer(
    topOpps, tensions, merklAvailable, veDataAvailable, veSpectraBalance,
  );

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredData, null, 2) },
      { type: "text" as const, text: narrativeLayer },
    ],
  };
}

// Helpers
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function mapValues<V, R>(obj: Record<string, V>, fn: (v: V) => R): Record<string, R> {
  const result: Record<string, R> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = fn(v);
  }
  return result;
}
