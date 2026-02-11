/**
 * Tools: get_pt_details, list_pools, get_best_fixed_yields, compare_yield
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, SUPPORTED_CHAINS, resolveNetwork } from "../config.js";
import type { SpectraPt, SpectraPool } from "../types.js";
import { fetchSpectra, fetchVeTotalSupply, scanAllChainPools } from "../api.js";
import {
  formatUsd,
  formatPct,
  formatDate,
  daysToMaturity,
  formatPoolSummary,
  formatPtSummary,
  parsePtResponse,
  extractLpApyBreakdown,
  computeSpectraBoost,
  estimatePriceImpact,
} from "../formatters.js";

export function register(server: McpServer): void {
  // ===========================================================================
  // get_pt_details
  // ===========================================================================

  server.tool(
    "get_pt_details",
    `Get detailed information about a specific Spectra Principal Token (PT).
Returns: maturity date, TVL, implied APY, PT/YT prices, pool liquidity, LP APY breakdown,
underlying asset info, IBT protocol, and yield leverage.
Use this when you know the specific PT address and chain.

Protocol context:
- PT trades at a discount to its underlying (the discount IS the fixed yield).
  At maturity, PT redeems 1:1 for the underlying asset.
- PT + YT = 1 underlying at maturity. YT price = 1 - PT price (in underlying terms).
- YT leverage shows how much yield exposure 1 unit of YT provides relative to holding
  the underlying directly. Higher leverage = more amplified yield exposure.

Use compare_yield to compare fixed vs. variable rates. Use get_looping_strategy to
calculate leveraged fixed yield via Morpho. Use get_portfolio to check wallet holdings.
Use get_pool_activity to see trading patterns on this pool.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pt_address: EVM_ADDRESS.describe("The PT contract address (0x...)"),
    },
    async ({ chain, pt_address }) => {
      try {
        const network = resolveNetwork(chain);
        const data = await fetchSpectra(`/${network}/pt/${pt_address}`) as any;
        const pt = parsePtResponse(data);

        if (!pt) {
          return { content: [{ type: "text", text: `No PT found at ${pt_address} on ${chain}` }] };
        }

        const summary = formatPtSummary(pt, chain);

        return {
          content: [{ type: "text", text: summary }],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ===========================================================================
  // list_pools
  // ===========================================================================

  server.tool(
    "list_pools",
    `List all active Spectra pools on a given chain.
Returns a summary of each pool including: asset name, maturity, TVL, implied APY,
LP APY, and pool liquidity. Useful for discovering available yield opportunities.

Each pool is a Curve StableSwap-NG AMM pair of IBT (interest-bearing token) and PT
(Principal Token). Implied APY is the fixed rate you lock in by buying PT at discount.
LP APY is the yield from providing liquidity to the pool (fees + gauge emissions).

For multi-chain discovery, use get_best_fixed_yields (raw APY ranking) or
scan_opportunities (capital-aware with price impact and looping analysis).
Use get_pool_activity on a specific pool to see recent trading patterns.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network to query"),
      sort_by: z
        .enum(["implied_apy", "tvl", "lp_apy", "maturity"])
        .default("implied_apy")
        .describe("Sort results by this metric (descending)"),
      min_tvl_usd: z
        .number()
        .default(0)
        .describe("Minimum TVL in USD to include in results"),
    },
    async ({ chain, sort_by, min_tvl_usd }) => {
      try {
        const network = resolveNetwork(chain);
        const raw = await fetchSpectra(`/${network}/pools`) as any;
        const pts: SpectraPt[] = raw?.data || raw || [];

        if (!Array.isArray(pts) || pts.length === 0) {
          return { content: [{ type: "text", text: `No pools found on ${chain}. The endpoint may use a different format -- try get_pt_details with a specific address.` }] };
        }

        // Expand each PT into one entry per pool so multi-pool PTs are all visible
        const expanded: Array<{ pt: SpectraPt; pool: SpectraPool }> = [];
        for (const pt of pts) {
          if (!pt.pools || pt.pools.length === 0) continue;
          if (pt.maturity * 1000 <= Date.now()) continue;
          if ((pt.tvl?.usd || 0) < min_tvl_usd) continue;
          for (const pool of pt.pools) {
            expanded.push({ pt, pool });
          }
        }

        // Sort by the pool-level metric
        expanded.sort((a, b) => {
          switch (sort_by) {
            case "implied_apy":
              return (b.pool.impliedApy || 0) - (a.pool.impliedApy || 0);
            case "tvl":
              return (b.pt.tvl?.usd || 0) - (a.pt.tvl?.usd || 0);
            case "lp_apy":
              return (b.pool.lpApy?.total || 0) - (a.pool.lpApy?.total || 0);
            case "maturity":
              return a.pt.maturity - b.pt.maturity;
            default:
              return 0;
          }
        });

        if (expanded.length === 0) {
          return { content: [{ type: "text", text: `No active pools on ${chain} with TVL >= ${formatUsd(min_tvl_usd)}` }] };
        }

        const summaries = expanded.map(({ pt, pool }) => formatPoolSummary(pt, pool, chain));
        const header = `Found ${expanded.length} active pool(s) on ${SUPPORTED_CHAINS[chain]?.name || chain} (sorted by ${sort_by}):\n`;

        return {
          content: [{ type: "text", text: header + "\n" + summaries.join("\n\n") }],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error listing pools: ${e.message}` }], isError: true };
      }
    }
  );

  // ===========================================================================
  // get_best_fixed_yields
  // ===========================================================================

  server.tool(
    "get_best_fixed_yields",
    `Find the best fixed-rate yield opportunities across all Spectra chains.
Scans all supported networks and returns the top opportunities ranked by implied APY.
Filters by asset type if specified.
This is the primary discovery tool -- use it when looking for "where to get the best yield".

Important: This ranks by raw implied APY without considering your capital size or pool
liquidity. A 50% APY pool with $10K liquidity is unusable at $500K capital (entry impact
would destroy the yield). For capital-aware sizing that accounts for price impact,
effective APY after entry cost, and Morpho looping availability, use scan_opportunities
instead — it's the strategy tool for deploying real capital.`,
    {
      asset_filter: z
        .string()
        .max(100)
        .optional()
        .describe("Optional: filter by underlying asset symbol (e.g., 'USDC', 'ETH', 'GHO')"),
      min_tvl_usd: z
        .number()
        .default(10000)
        .describe("Minimum pool TVL in USD (default $10,000)"),
      min_liquidity_usd: z
        .number()
        .default(5000)
        .describe("Minimum pool liquidity in USD (default $5,000)"),
      top_n: z
        .number()
        .default(10)
        .describe("Number of top results to return (default 10, max 50)"),
    },
    async ({ asset_filter, min_tvl_usd, min_liquidity_usd, top_n: rawTopN }) => {
      const top_n = Math.min(Math.max(1, rawTopN), 50);
      try {
        const { opportunities: rawOpps, failedChains } = await scanAllChainPools({
          min_tvl_usd,
          min_liquidity_usd,
          asset_filter,
        });

        // Sort by implied APY descending
        rawOpps.sort((a, b) => (b.pool.impliedApy || 0) - (a.pool.impliedApy || 0));
        const top = rawOpps.slice(0, top_n);

        const chainWarning = failedChains.length > 0
          ? `\nNote: ${failedChains.length} chain(s) failed to respond (${failedChains.join(", ")}). Results may be partial.\n`
          : "";

        if (top.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No opportunities found matching criteria.${asset_filter ? ` Asset filter: ${asset_filter}.` : ""} Try lowering min_tvl_usd or min_liquidity_usd.${chainWarning}`,
            }],
          };
        }

        const header = `Top ${top.length} Fixed Yield Opportunities on Spectra${asset_filter ? ` (filtered: ${asset_filter})` : ""}:\n`;
        const summaries = top.map((opp, i) => `#${i + 1}\n${formatPoolSummary(opp.pt, opp.pool, opp.chain)}`);

        return {
          content: [{ type: "text", text: header + chainWarning + "\n" + summaries.join("\n\n") }],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error scanning yields: ${e.message}` }], isError: true };
      }
    }
  );

  // ===========================================================================
  // compare_yield
  // ===========================================================================

  server.tool(
    "compare_yield",
    `Compare Spectra's fixed yield (via PT) against the variable yield of the underlying
interest-bearing token. Helps users decide if locking in a fixed rate is worthwhile
versus staying in the variable-rate position.

Protocol context:
- The fixed rate comes from buying PT at a discount. Entry cost (price impact from the
  AMM trade) is amortized over days to maturity — shorter maturity means higher annualized
  entry cost, longer maturity spreads the cost thin.
- Variable rate (IBT APR) fluctuates continuously. The fixed rate locks in at purchase.
- LP alternative: providing liquidity to the Curve pool earns trading fees + SPECTRA
  gauge emissions. This is a third option alongside fixed (PT) and variable (IBT).

Use get_looping_strategy to lever up the fixed yield via Morpho. Use get_portfolio to
check your current positions. Use scan_opportunities for multi-chain comparison.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pt_address: EVM_ADDRESS.describe("The PT contract address to compare"),
      ve_spectra_balance: z
        .number()
        .min(0)
        .optional()
        .describe("Your veSPECTRA token balance. Computes real boost using B = min(2.5, 1.5*(v/V)*(D/d)+1)."),
      capital_usd: z
        .number()
        .positive()
        .default(10000)
        .describe("Your deposit size in USD (default $10,000). Used with ve_spectra_balance to compute per-pool boost."),
    },
    async ({ chain, pt_address, ve_spectra_balance, capital_usd }) => {
      try {
        const network = resolveNetwork(chain);
        const data = await fetchSpectra(`/${network}/pt/${pt_address}`) as any;
        const pt = parsePtResponse(data);

        if (!pt) {
          return { content: [{ type: "text", text: `No PT found at ${pt_address} on ${chain}` }] };
        }

        const pool = pt.pools?.[0];
        if (!pool) {
          return { content: [{ type: "text", text: `No active pool for this PT` }] };
        }

        const fixedApy = pool.impliedApy || 0;
        const variableApr = pt.ibt?.apr?.total || 0;
        const spread = fixedApy - variableApr;
        const maturityDays = daysToMaturity(pt.maturity);
        const tvlUsd = pt.tvl?.usd || 0;

        // Compute real boost if veSPECTRA balance provided
        let boostInfo: { multiplier: number; boostFraction: number } | undefined;
        let veTotalSupply: number | null = null;
        if (ve_spectra_balance !== undefined && ve_spectra_balance > 0) {
          try {
            veTotalSupply = await fetchVeTotalSupply();
            boostInfo = computeSpectraBoost(ve_spectra_balance, veTotalSupply, tvlUsd, capital_usd);
          } catch {
            // Degrade gracefully if RPC fails
          }
        }

        // Extract full LP breakdown
        const lpData = extractLpApyBreakdown(pool, boostInfo?.boostFraction ?? 0);
        const lpParts: string[] = [];
        if (lpData.lpApyBreakdown.fees > 0) lpParts.push(`fees ${formatPct(lpData.lpApyBreakdown.fees)}`);
        if (lpData.lpApyBreakdown.pt > 0) lpParts.push(`PT ${formatPct(lpData.lpApyBreakdown.pt)}`);
        if (lpData.lpApyBreakdown.ibt > 0) lpParts.push(`IBT ${formatPct(lpData.lpApyBreakdown.ibt)}`);
        for (const [token, apy] of Object.entries(lpData.lpApyBreakdown.rewards)) {
          lpParts.push(`${token} ${formatPct(apy)}`);
        }
        for (const [token, range] of Object.entries(lpData.lpApyBreakdown.boostedRewards)) {
          lpParts.push(`${token} gauge ${formatPct(range.min)}-${formatPct(range.max)}`);
        }

        // Entry cost at agent's capital size
        const poolLiqUsd = pool.liquidity?.usd || 0;
        const impactFrac = estimatePriceImpact(capital_usd, poolLiqUsd);
        const impactPct = impactFrac * 100;
        const annualizedEntryCost = maturityDays > 0
          ? impactFrac * (365 / maturityDays) * 100
          : impactFrac * 100;
        const effectiveFixedApy = fixedApy - annualizedEntryCost;

        const lines = [
          `-- Yield Comparison: ${pt.underlying?.symbol || "?"} --`,
          ``,
          `  Fixed (Spectra PT):   ${formatPct(fixedApy)} APY`,
          `  Variable (${pt.ibt?.symbol || "IBT"}):   ${formatPct(variableApr)} APR`,
          `  Spread:               ${spread >= 0 ? "+" : ""}${formatPct(spread)}`,
          ``,
          `  Maturity: ${formatDate(pt.maturity)} (${maturityDays} days)`,
          `  PT Discount: ${formatPct((1 - (pool.ptPrice?.underlying || 1)) * 100)}`,
          ``,
          `  Entry Cost at ${formatUsd(capital_usd)}:`,
          `    Pool Liquidity: ${formatUsd(poolLiqUsd)}`,
          `    Est. Price Impact: ~${formatPct(impactPct)} (conservative upper bound)`,
          `    Effective Fixed APY: ${formatPct(effectiveFixedApy)} (after amortizing entry cost over ${maturityDays} days)`,
          ``,
          effectiveFixedApy > variableApr
            ? `  Fixed rate is HIGHER than variable (even after entry cost). Locking in via PT is currently favorable.`
            : fixedApy > variableApr
              ? `  Fixed rate is higher than variable, but entry cost narrows the advantage. Consider trade size vs pool depth.`
              : `  Variable rate is HIGHER than fixed. PT lock only makes sense if you expect rates to drop.`,
          ``,
          `  LP Alternative: ${formatPct(lpData.lpApy)} APY (${lpParts.join(" + ")})`,
        ];
        if (lpData.lpApyBoostedTotal > lpData.lpApy) {
          lines.push(`  LP (Max Boost): ${formatPct(lpData.lpApyBoostedTotal)} APY (with max veSPECTRA boost)`);
        }
        if (boostInfo && boostInfo.multiplier > 1) {
          lines.push(`  LP (Your ${boostInfo.multiplier.toFixed(2)}x Boost at ${formatUsd(capital_usd)} deposit): ${formatPct(lpData.lpApyAtBoost)} APY`);
          // Show how much veSPECTRA needed for full boost
          if (tvlUsd > 0 && ve_spectra_balance !== undefined && veTotalSupply !== null) {
            const neededForMax = veTotalSupply * (capital_usd / tvlUsd);
            if (ve_spectra_balance < neededForMax) {
              lines.push(`  Full 2.5x boost requires: ${neededForMax.toLocaleString("en-US", { maximumFractionDigits: 0 })} veSPECTRA at this deposit size`);
            } else {
              lines.push(`  You have FULL 2.5x boost in this pool at ${formatUsd(capital_usd)} deposit.`);
            }
          }
        }
        lines.push(`  YT Leverage: ${(pool.ytLeverage || 0).toFixed(1)}x (for yield bulls)`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error comparing yields: ${e.message}` }], isError: true };
      }
    }
  );
}
