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
import type { PendleMarket, SpectraPt, SpectraPool } from "../types.js";
import { fetchPendleMarkets, scanAllPendleMarkets, fetchSpectra } from "../api.js";
import {
  formatUsd,
  formatPct,
  formatPendleMarketCompact,
  formatPendleMarketSummary,
  formatPendleSpectraComparison,
  pendleDaysToMaturity,
  parsePtResponse,
  daysToMaturity,
} from "../formatters.js";

// Pendle chain enum includes all Pendle-supported chains (not just Spectra overlap)
const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

export function register(server: McpServer): void {
  // ===========================================================================
  // list_pendle_markets
  // ===========================================================================

  server.tool(
    "list_pendle_markets",
    `List active Pendle markets on a given chain, or scan all Pendle-supported chains.
Returns: market name, implied APY (fixed rate), LP APY, TVL, liquidity, maturity, and token addresses.

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

Use compare_pendle_spectra to do a head-to-head comparison on a specific underlying.
Use scan_opportunities for Spectra-native opportunity ranking.`,
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
          const markets = await fetchPendleMarkets(chain);
          const now = Date.now();
          allMarkets = markets
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

        // Format
        const header = chain
          ? `== Pendle Markets: ${PENDLE_CHAIN_NAMES[chain] || chain} ==\n  Found: ${capped.length} market(s)${allMarkets.length > top_n ? ` (showing top ${top_n} of ${allMarkets.length})` : ""}\n\n`
          : `== Pendle Markets (all chains) ==\n  Found: ${capped.length} market(s)${allMarkets.length > top_n ? ` (showing top ${top_n} of ${allMarkets.length})` : ""}\n\n`;

        let body: string;
        if (compact) {
          body = capped.map(({ market, chain: c }) => formatPendleMarketCompact(market, c)).join("\n");
        } else {
          body = capped.map(({ market, chain: c }) => formatPendleMarketSummary(market, c)).join("\n\n");
        }

        // Chain coverage info
        const spectraOverlap = PENDLE_CHAIN_KEYS.filter((k) => SUPPORTED_CHAINS[k]);
        const pendleOnly = PENDLE_CHAIN_KEYS.filter((k) => !SUPPORTED_CHAINS[k]);

        const footer: string[] = [`\n`];
        if (failedChains.length > 0) {
          footer.push(`  Failed chains: ${failedChains.join(", ")}`);
        }
        footer.push(`--- Chain Coverage ---`);
        footer.push(`  Spectra + Pendle overlap: ${spectraOverlap.join(", ")}`);
        footer.push(`  Pendle-only (Spectra expansion opportunities): ${pendleOnly.join(", ")}`);
        footer.push(``);
        footer.push(`--- Next Steps ---`);
        footer.push(`  • Compare with Spectra: compare_pendle_spectra(chain=CHAIN, asset_filter="ASSET") to find matching pools`);
        footer.push(`  • Spectra pools on same chain: list_pools(chain=CHAIN) for head-to-head data`);
        footer.push(`  • Capital-aware Spectra scan: scan_opportunities(capital_usd=AMOUNT) for Spectra-native ranking`);

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
    "compare_pendle_spectra",
    `Compare Pendle and Spectra yield opportunities side-by-side on the same chain.
Auto-matches markets by underlying asset to produce a head-to-head comparison.

Essential for MetaVault curators who can allocate to either protocol. Shows:
- Implied APY (fixed rate) comparison
- LP APY comparison (relevant for MetaVault allocation)
- Pool liquidity and TVL comparison
- Variable rate comparison
- Per-market winner analysis

Only works on chains where both Spectra and Pendle are deployed:
${PENDLE_CHAIN_KEYS.filter((k) => SUPPORTED_CHAINS[k]).map((k) => PENDLE_CHAIN_NAMES[k]).join(", ")}

Use list_pendle_markets for Pendle-only chain data.
Use scan_opportunities for Spectra-native capital-aware ranking.`,
    {
      chain: z.enum(
        PENDLE_CHAIN_KEYS.filter((k) => SUPPORTED_CHAINS[k]) as [string, ...string[]]
      ).describe("Chain where both Spectra and Pendle are deployed"),
      asset_filter: z.string().max(100).optional().describe(
        "Filter by underlying asset (e.g., 'USDC', 'ETH', 'stETH'). Matches against pool/market names."
      ),
      min_tvl_usd: z.number().default(10000).describe("Minimum TVL in USD"),
      min_liquidity_usd: z.number().default(5000).describe("Minimum pool liquidity in USD"),
      compact: z.boolean().default(false).describe("Compact output mode"),
    },
    async ({ chain, asset_filter, min_tvl_usd, min_liquidity_usd, compact }) => {
      try {
        const network = resolveNetwork(chain);
        const assetUpper = asset_filter?.toUpperCase();

        // Fetch both in parallel
        const [pendleMarkets, spectraRaw] = await Promise.all([
          fetchPendleMarkets(chain),
          fetchSpectra(`/${network}/pools`) as Promise<any>,
        ]);

        // Parse Spectra pools
        const spectraPts: SpectraPt[] = spectraRaw?.data || spectraRaw || [];
        const now = Date.now();

        // Filter Pendle markets
        const activePendle = pendleMarkets.filter((m) => {
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
        lines.push(``);

        // Try to match by underlying asset for head-to-head comparisons
        const matched: Array<{
          spectra: { pt: SpectraPt; pool: SpectraPool };
          pendle: PendleMarket;
          matchScore: number;
        }> = [];

        for (const sp of activeSpectra) {
          const spectraSymbol = (sp.pt.underlying?.symbol || "").toUpperCase();
          const spectraName = (sp.pt.name || "").toUpperCase();

          for (const pm of activePendle) {
            const pendleName = pm.name.toUpperCase();
            // Match if underlying symbols overlap meaningfully
            if (
              (spectraSymbol && pendleName.includes(spectraSymbol)) ||
              (spectraSymbol && spectraSymbol.includes("USD") && pendleName.includes("USD")) ||
              (spectraSymbol && spectraSymbol.includes("ETH") && pendleName.includes("ETH")) ||
              (spectraSymbol && spectraSymbol.includes("BTC") && pendleName.includes("BTC"))
            ) {
              matched.push({ spectra: sp, pendle: pm, matchScore: 1 });
            }
          }
        }

        // Deduplicate: keep best match per Spectra pool
        const seenSpectra = new Set<string>();
        const seenPendle = new Set<string>();
        const uniqueMatches = matched.filter(({ spectra, pendle }) => {
          const sKey = spectra.pool.address || spectra.pt.address;
          const pKey = pendle.address;
          if (seenSpectra.has(sKey) || seenPendle.has(pKey)) return false;
          seenSpectra.add(sKey);
          seenPendle.add(pKey);
          return true;
        });

        if (uniqueMatches.length > 0) {
          lines.push(`--- Matched Comparisons (${uniqueMatches.length}) ---`);
          lines.push(``);
          for (const { spectra, pendle } of uniqueMatches) {
            if (compact) {
              const si = spectra.pool.impliedApy || 0;
              const pi = pendle.details.impliedApy * 100;
              const sl = spectra.pool.lpApy?.total || 0;
              const pl = pendle.details.aggregatedApy * 100;
              const winner = si > pi ? "Spectra" : pi > si ? "Pendle" : "Tied";
              lines.push(`  ${spectra.pt.underlying?.symbol || spectra.pt.name} | Spectra: Impl ${formatPct(si)} LP ${formatPct(sl)} | Pendle: Impl ${formatPct(pi)} LP ${formatPct(pl)} | Fixed rate winner: ${winner}`);
            } else {
              lines.push(formatPendleSpectraComparison({
                spectraPt: spectra.pt,
                spectraPool: spectra.pool,
                pendleMarket: pendle,
                chain,
              }));
              lines.push(``);
            }
          }
        }

        // Show unmatched pools
        const unmatchedSpectra = activeSpectra.filter(
          (sp) => !seenSpectra.has(sp.pool.address || sp.pt.address)
        );
        const unmatchedPendle = activePendle.filter(
          (pm) => !seenPendle.has(pm.address)
        );

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
          lines.push(`  Total TVL:        Spectra ${formatUsd(totalSpectraTvl)} | Pendle ${formatUsd(totalPendleTvl)}`);
          lines.push(``);
        }

        lines.push(`--- Next Steps ---`);
        lines.push(`  • Drill into a Spectra pool: get_pt_details(chain="${chain}", pt_address="PT_ADDRESS")`);
        lines.push(`  • List all Pendle markets: list_pendle_markets(chain="${chain}") for full Pendle data`);
        lines.push(`  • Check MetaVault positions: get_metavaults() to see current curator allocations`);
        lines.push(`  • Evaluate looping: get_looping_strategy(chain="${chain}", pt_address="PT_ADDRESS") for Morpho leverage`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
