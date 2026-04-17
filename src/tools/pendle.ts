/**
 * Tools: list_pendle_markets, compare_pendle_spectra
 *
 * Pendle integration for cross-protocol yield comparison.
 * Enables curators to evaluate Pendle pools alongside Spectra pools
 * for MetaVault allocation decisions.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PENDLE_CHAIN_IDS,
  PENDLE_CHAIN_NAMES,
  SUPPORTED_CHAINS,
  resolveNetwork,
  EVM_ADDRESS,
} from "../config.js";
import type { PendleMarket, SpectraPt, SpectraPool, MerklCampaign } from "../types.js";
import { fetchPendleMarkets, scanAllPendleMarkets, fetchSpectraPoolsValidated, fetchMerklCampaigns, lookupMerklCampaigns } from "../api.js";
import {
  formatUsd,
  formatPct,
  formatPendleMarketCompact,
  formatPendleMarketSummary,
  formatPendleSpectraComparison,
  pendleDaysToMaturity,
  daysToMaturity,
  matchByAssetAndMaturity,
} from "../formatters.js";

// Pendle chain enum includes all Pendle-supported chains (not just Spectra overlap)
const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

export function register(server: McpServer): void {
  // ===========================================================================
  // list_pendle_markets
  // ===========================================================================

  server.tool(
    "pendle_list_markets",
    `List active Pendle markets on a given chain, or scan all Pendle-supported chains.
Returns: market name, implied APY (fixed rate), LP APY, TVL (underlying deposited),
liquidity (AMM depth), maturity, and token addresses.

Pendle is a competing/complementary yield tokenization protocol. Like Spectra, it splits
yield-bearing tokens into PT (principal) and YT (yield). Key differences:
- Pendle uses its own AMM (not Curve) with time-decay pricing
- Pendle has PENDLE token incentives on LP positions
- Pendle markets exist on chains where Spectra may not be deployed yet

This data is essential for curators building cross-protocol MetaVaults. A MetaVault can
integrate Pendle PTs alongside Spectra PTs, allocating to whichever protocol offers
better rates for a given underlying + maturity.

Pendle-supported chains: ${PENDLE_CHAIN_KEYS.map((k) => `${PENDLE_CHAIN_NAMES[k]} (${k})`).join(", ")}
Chains with Spectra overlap: ${PENDLE_CHAIN_KEYS.filter((k) => SUPPORTED_CHAINS[k]).join(", ")}
Pendle-only chains (Spectra not deployed): ${PENDLE_CHAIN_KEYS.filter((k) => !SUPPORTED_CHAINS[k]).join(", ")}

Includes external Merkl campaign APR when available (LP, YT, and SY incentive programs).
Merkl campaigns are fetched best-effort per chain and shown alongside native PENDLE incentives.

Use mv_compare_yield to do a head-to-head comparison on a specific underlying.
Use mv_scan_curator_opportunities for unified cross-protocol ranking with capital-aware sizing.
Use spectra_scan_opportunities for Spectra-native opportunity ranking.`,
    {
      chain: PENDLE_CHAIN_ENUM.optional().describe(
        "Pendle chain to query. Omit to scan all Pendle chains."
      ),
      sort_by: z.enum(["implied_apy", "tvl", "lp_apy", "liquidity", "maturity"]).default("implied_apy").describe(
        "Sort results by this metric (descending)"
      ),
      min_tvl_usd: z.number().default(10000).describe("Minimum TVL in USD to include"),
      min_liquidity_usd: z.number().default(5000).describe("Minimum pool liquidity in USD"),
      asset_filter: z.string().max(100).optional().describe(
        "Filter by asset name/symbol (e.g., 'USDC', 'ETH', 'stETH'). Matches against market name."
      ),
      top_n: z.number().min(1).max(50).default(15).describe("Number of results to return"),
      compact: z.boolean().default(false).describe("One-line-per-market output for quick scanning"),
    },
    async ({ chain, sort_by, min_tvl_usd, min_liquidity_usd, asset_filter, top_n, compact }) => {
      try {
        let allMarkets: Array<{ market: PendleMarket; chain: string }>;
        let failedChains: string[] = [];

        if (chain) {
          // Single chain
          const result = await fetchPendleMarkets(chain);
          if (!result.ok) {
            failedChains.push(chain);
          }
          const now = Date.now();
          allMarkets = result.markets
            .filter((m) => {
              if (new Date(m.expiry).getTime() <= now) return false;
              if ((m.details.totalTvl || 0) < min_tvl_usd) return false;
              if ((m.details.liquidity || 0) < min_liquidity_usd) return false;
              if (asset_filter && !m.name.toUpperCase().includes(asset_filter.toUpperCase())) return false;
              return true;
            })
            .map((m) => ({ market: m, chain }));
        } else {
          // All chains
          const scan = await scanAllPendleMarkets({
            min_tvl_usd,
            min_liquidity_usd,
            asset_filter,
          });
          allMarkets = scan.markets;
          failedChains = scan.failedChains;
        }

        // Sort
        allMarkets.sort((a, b) => {
          const ad = a.market.details;
          const bd = b.market.details;
          switch (sort_by) {
            case "implied_apy": return (bd.impliedApy || 0) - (ad.impliedApy || 0);
            case "tvl": return (bd.totalTvl || 0) - (ad.totalTvl || 0);
            case "lp_apy": return (bd.aggregatedApy || 0) - (ad.aggregatedApy || 0);
            case "liquidity": return (bd.liquidity || 0) - (ad.liquidity || 0);
            case "maturity":
              return new Date(b.market.expiry).getTime() - new Date(a.market.expiry).getTime();
            default: return 0;
          }
        });

        // Cap results
        const capped = allMarkets.slice(0, top_n);

        if (capped.length === 0) {
          const scope = chain ? `on ${PENDLE_CHAIN_NAMES[chain] || chain}` : "across all Pendle chains";
          const text = `No active Pendle markets found ${scope} matching filters (min TVL ${formatUsd(min_tvl_usd)}, min liquidity ${formatUsd(min_liquidity_usd)}${asset_filter ? `, asset="${asset_filter}"` : ""}).`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Fetch Merkl campaigns for chains present in results (best-effort, parallel)
        const uniqueChains = [...new Set(capped.map(({ chain: c }) => c))];
        const merklMaps = new Map<string, Map<string, MerklCampaign[]>>();
        let merklAvailable = true;
        if (!compact) {
          const merklResults = await Promise.allSettled(
            uniqueChains.map(async (c) => {
              const chainId = PENDLE_CHAIN_IDS[c];
              if (!chainId) return { chain: c, map: new Map<string, MerklCampaign[]>() };
              const result = await fetchMerklCampaigns(chainId).catch(() => ({ campaigns: new Map<string, MerklCampaign[]>(), available: false }));
              if (!result.available) merklAvailable = false;
              return { chain: c, map: result.campaigns };
            })
          );
          for (const r of merklResults) {
            if (r.status === "fulfilled") merklMaps.set(r.value.chain, r.value.map);
          }
        }

        // Format
        const header = chain
          ? `== Pendle Markets: ${PENDLE_CHAIN_NAMES[chain] || chain} ==\n  Found: ${capped.length} market(s)${allMarkets.length > top_n ? ` (showing top ${top_n} of ${allMarkets.length})` : ""}\n\n`
          : `== Pendle Markets (all chains) ==\n  Found: ${capped.length} market(s)${allMarkets.length > top_n ? ` (showing top ${top_n} of ${allMarkets.length})` : ""}\n\n`;

        let body: string;
        if (compact) {
          body = capped.map(({ market, chain: c }) => formatPendleMarketCompact(market, c)).join("\n");
        } else {
          body = capped.map(({ market, chain: c }) => {
            const merklMap = merklMaps.get(c) || new Map();
            const addrs = [market.address, market.pt, market.yt, market.sy].filter(Boolean);
            const campaigns = lookupMerklCampaigns(merklMap, addrs);
            return formatPendleMarketSummary(market, c, campaigns);
          }).join("\n\n");
        }

        // Chain coverage info
        const spectraOverlap = PENDLE_CHAIN_KEYS.filter((k) => SUPPORTED_CHAINS[k]);
        const pendleOnly = PENDLE_CHAIN_KEYS.filter((k) => !SUPPORTED_CHAINS[k]);

        const footer: string[] = [`\n`];
        if (failedChains.length > 0) {
          footer.push(`  Failed chains: ${failedChains.join(", ")}`);
        }
        if (!merklAvailable && !compact) {
          footer.push(`  Note: Merkl incentive data unavailable — external campaign APR may be missing`);
        }
        footer.push(`--- Chain Coverage ---`);
        footer.push(`  Spectra + Pendle overlap: ${spectraOverlap.join(", ")}`);
        footer.push(`  Pendle-only (Spectra expansion opportunities): ${pendleOnly.join(", ")}`);
        footer.push(``);
        footer.push(`--- Next Steps ---`);
        footer.push(`  • Compare with Spectra: mv_compare_yield(chain=CHAIN, asset_filter="ASSET") to find matching pools`);
        footer.push(`  • Spectra pools on same chain: spectra_list_pools(chain=CHAIN) for head-to-head data`);
        footer.push(`  • Capital-aware Spectra scan: spectra_scan_opportunities(capital_usd=AMOUNT) for Spectra-native ranking`);

        const text = header + body + footer.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ===========================================================================
  // compare_pendle_spectra
  // ===========================================================================

  server.tool(
    "mv_compare_yield",
    `Compare Pendle and Spectra yield opportunities side-by-side on the same chain.
Auto-matches markets by underlying asset AND maturity proximity for head-to-head comparison.

Essential for MetaVault curators who can allocate to either protocol. Shows:
- Implied APY (fixed rate) comparison
- LP APY comparison (relevant for MetaVault allocation)
- Pool liquidity and TVL comparison
- Variable rate comparison
- Per-market winner analysis
- Maturity match quality (exact ≤7d, close ≤30d, loose ≤90d gap)

Only works on chains where both Spectra and Pendle are deployed:
${PENDLE_CHAIN_KEYS.filter((k) => SUPPORTED_CHAINS[k]).map((k) => PENDLE_CHAIN_NAMES[k]).join(", ")}

Includes external Merkl campaign APR for both protocols when available.

Use pendle_list_markets for Pendle-only chain data.
Use mv_scan_curator_opportunities for unified cross-protocol ranking with capital-aware sizing.
Use spectra_scan_opportunities for Spectra-native capital-aware ranking.`,
    {
      chain: z.enum(
        PENDLE_CHAIN_KEYS.filter((k) => SUPPORTED_CHAINS[k]) as [string, ...string[]]
      ).describe("Chain where both Spectra and Pendle are deployed"),
      asset_filter: z.string().max(100).optional().describe(
        "Filter by underlying asset (e.g., 'USDC', 'ETH', 'stETH'). Matches against pool/market names."
      ),
      min_tvl_usd: z.number().default(10000).describe("Minimum TVL in USD"),
      min_liquidity_usd: z.number().default(5000).describe("Minimum pool liquidity in USD"),
      maturity_tolerance_days: z.number().min(0).max(365).default(90).describe(
        "Maximum maturity gap (days) to consider a match. Matches within 7d are 'exact', within 30d are 'close', within this tolerance are 'loose'. Default 90."
      ),
      compact: z.boolean().default(false).describe("Compact output mode"),
    },
    async ({ chain, asset_filter, min_tvl_usd, min_liquidity_usd, maturity_tolerance_days, compact }) => {
      try {
        const network = resolveNetwork(chain);
        const assetUpper = asset_filter?.toUpperCase();

        // Fetch both in parallel
        const [pendleResult, spectraResult] = await Promise.all([
          fetchPendleMarkets(chain),
          fetchSpectraPoolsValidated(network),
        ]);

        // Parse Spectra pools (schema-validated, malformed elements dropped)
        const spectraPts = spectraResult.data as SpectraPt[];
        const now = Date.now();

        // Filter Pendle markets
        const activePendle = pendleResult.markets.filter((m) => {
          if (new Date(m.expiry).getTime() <= now) return false;
          if ((m.details.totalTvl || 0) < min_tvl_usd) return false;
          if ((m.details.liquidity || 0) < min_liquidity_usd) return false;
          if (assetUpper && !m.name.toUpperCase().includes(assetUpper)) return false;
          return true;
        });

        // Filter Spectra pools
        const activeSpectra: Array<{ pt: SpectraPt; pool: SpectraPool }> = [];
        for (const pt of spectraPts) {
          if (!pt.pools || pt.pools.length === 0) continue;
          if (pt.maturity * 1000 <= now) continue;
          if ((pt.tvl?.usd || 0) < min_tvl_usd) continue;
          if (assetUpper) {
            const sym = (pt.underlying?.symbol || "").toUpperCase();
            const name = (pt.name || "").toUpperCase();
            if (!sym.includes(assetUpper) && !name.includes(assetUpper)) continue;
          }
          for (const pool of pt.pools) {
            if ((pool.liquidity?.usd || 0) < min_liquidity_usd) continue;
            activeSpectra.push({ pt, pool });
          }
        }

        // Build output
        const lines: string[] = [];
        lines.push(`== Spectra vs Pendle: ${PENDLE_CHAIN_NAMES[chain] || chain} ==`);
        if (asset_filter) lines.push(`  Asset filter: ${asset_filter}`);
        lines.push(`  Spectra pools: ${activeSpectra.length} | Pendle markets: ${activePendle.length}`);
        if (!pendleResult.ok) {
          lines.push(`  ⚠ Pendle API failed for ${chain}: ${pendleResult.error || "unknown error"}. Pendle data may be incomplete.`);
        }
        lines.push(``);

        // Match by underlying asset + maturity proximity
        const crossMatches = matchByAssetAndMaturity(
          activeSpectra.map(sp => ({ pt: sp.pt, pool: sp.pool, chain })),
          activePendle.map(pm => ({ market: pm, chain })),
          maturity_tolerance_days,
        );

        // Separate matched pairs from unmatched
        const pairedMatches = crossMatches.filter(m => m.spectra && m.pendle && m.matchQuality !== "unmatched");
        const unmatchedSpectraMatches = crossMatches.filter(m => m.spectra && !m.pendle);
        const unmatchedPendleMatches = crossMatches.filter(m => !m.spectra && m.pendle);

        if (pairedMatches.length > 0) {
          lines.push(`--- Matched Comparisons (${pairedMatches.length}) ---`);
          lines.push(``);
          for (const match of pairedMatches) {
            const spectra = match.spectra!;
            const pendle = match.pendle!;
            if (compact) {
              const si = spectra.pool.impliedApy || 0;
              const pi = pendle.market.details.impliedApy * 100;
              const sl = spectra.pool.lpApy?.total || 0;
              const pl = pendle.market.details.aggregatedApy * 100;
              const winner = si > pi ? "Spectra" : pi > si ? "Pendle" : "Tied";
              lines.push(`  ${spectra.pt.underlying?.symbol || spectra.pt.name} | Spectra: Impl ${formatPct(si)} LP ${formatPct(sl)} | Pendle: Impl ${formatPct(pi)} LP ${formatPct(pl)} | Winner: ${winner} | Match: ${match.matchQuality} (${match.maturityGapDays}d gap)`);
            } else {
              lines.push(formatPendleSpectraComparison({
                spectraPt: spectra.pt,
                spectraPool: spectra.pool,
                pendleMarket: pendle.market,
                chain,
              }));
              lines.push(`  Maturity Match: ${match.matchQuality} (${match.maturityGapDays} day gap)`);
              lines.push(``);
            }
          }
        }

        // Collect unmatched pools for display below
        const unmatchedSpectra = unmatchedSpectraMatches
          .map(m => m.spectra!)
          .map(s => ({ pt: s.pt, pool: s.pool }));
        const unmatchedPendle = unmatchedPendleMatches
          .map(m => m.pendle!.market);

        if (unmatchedSpectra.length > 0) {
          lines.push(`--- Spectra-Only Pools (${unmatchedSpectra.length}, no Pendle equivalent) ---`);
          for (const sp of unmatchedSpectra) {
            const days = daysToMaturity(sp.pt.maturity);
            lines.push(`  ${sp.pt.name} | Impl ${formatPct(sp.pool.impliedApy || 0)} | LP ${formatPct(sp.pool.lpApy?.total || 0)} | TVL ${formatUsd(sp.pt.tvl?.usd || 0)} | ${days}d`);
          }
          lines.push(``);
        }

        if (unmatchedPendle.length > 0) {
          lines.push(`--- Pendle-Only Markets (${unmatchedPendle.length}, no Spectra equivalent) ---`);
          for (const pm of unmatchedPendle) {
            const days = pendleDaysToMaturity(pm.expiry);
            lines.push(`  ${pm.name} | Impl ${formatPct(pm.details.impliedApy * 100)} | LP ${formatPct(pm.details.aggregatedApy * 100)} | TVL ${formatUsd(pm.details.totalTvl)} | ${days}d`);
          }
          lines.push(``);
        }

        // Summary stats
        if (activeSpectra.length > 0 && activePendle.length > 0) {
          const avgSpectraImpl = activeSpectra.reduce((s, x) => s + (x.pool.impliedApy || 0), 0) / activeSpectra.length;
          const avgPendleImpl = activePendle.reduce((s, x) => s + x.details.impliedApy * 100, 0) / activePendle.length;
          const totalSpectraTvl = activeSpectra.reduce((s, x) => s + (x.pt.tvl?.usd || 0), 0);
          const totalPendleTvl = activePendle.reduce((s, x) => s + x.details.totalTvl, 0);

          lines.push(`--- Aggregate Stats ---`);
          lines.push(`  Avg Implied APY:  Spectra ${formatPct(avgSpectraImpl)} | Pendle ${formatPct(avgPendleImpl)}`);
          lines.push(`  Total TVL:        Spectra ${formatUsd(totalSpectraTvl)} | Pendle ${formatUsd(totalPendleTvl)}  (different APIs — not directly comparable)`);

          // Surface protocol-level disagreements as signals
          const implDiff = Math.abs(avgSpectraImpl - avgPendleImpl);
          if (implDiff > 0.5 && pairedMatches.length > 0) {
            const higher = avgSpectraImpl > avgPendleImpl ? "Spectra" : "Pendle";
            const lower = higher === "Spectra" ? "Pendle" : "Spectra";
            lines.push(``);
            lines.push(`  The protocols disagree on average fixed rate by ${formatPct(implDiff)}.`);
            lines.push(`  Neither is "right" — the disagreement itself is the signal:`);
            lines.push(`  (A) ${higher}'s higher rate reflects thinner liquidity — the rate is`);
            lines.push(`      mechanically elevated because fewer participants set the price`);
            lines.push(`  (B) ${lower}'s lower rate reflects deeper markets with more informed`);
            lines.push(`      participants who have bid the discount tighter`);
            lines.push(`  (C) Different AMM designs (Curve StableSwap vs Pendle logit) produce`);
            lines.push(`      different equilibrium prices for the same underlying risk`);
            lines.push(`  Compare pool liquidity in the matched pairs above to distinguish.`);
          }

          // TVL divergence can also be meaningful
          if (totalSpectraTvl > 0 && totalPendleTvl > 0) {
            const tvlRatio = Math.max(totalSpectraTvl, totalPendleTvl) / Math.min(totalSpectraTvl, totalPendleTvl);
            if (tvlRatio > 5) {
              const dominant = totalSpectraTvl > totalPendleTvl ? "Pendle" : "Spectra";
              lines.push(`  Note: TVL is heavily concentrated on ${dominant === "Spectra" ? "Pendle" : "Spectra"} (${formatPct((tvlRatio - 1) * 100 / tvlRatio)} of combined TVL).`);
              lines.push(`  The ${dominant} side's rates are set by a much smaller pool of capital.`);
            }
          }
          lines.push(``);
        }

        lines.push(`--- Next Steps ---`);
        lines.push(`  • Cross-protocol scan: mv_scan_curator_opportunities(capital_usd=AMOUNT) for unified ranking with capital-aware sizing`);
        lines.push(`  • Drill into a Spectra pool: spectra_get_pt_details(chain="${chain}", pt_address="PT_ADDRESS")`);
        lines.push(`  • List all Pendle markets: pendle_list_markets(chain="${chain}") for full Pendle data`);
        lines.push(`  • Check MetaVault positions: spectra_list_metavaults() to see current curator allocations`);
        lines.push(`  • Evaluate looping: spectra_get_looping_strategy(chain="${chain}", pt_address="PT_ADDRESS") for Morpho leverage`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
