/**
 * Tools: spectra_get_pt_details, spectra_list_pools, spectra_get_best_fixed_yields, spectra_compare_yield
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, SUPPORTED_CHAINS, resolveNetwork } from "../config.js";
import type { SpectraPt, SpectraPool, MerklCampaign } from "../types.js";
import { fetchSpectraPtValidated, fetchSpectraPoolsValidated, fetchVeTotalSupply, scanAllChainPools, fetchMerklCampaigns, lookupMerklCampaigns, resolvePtFromPoolAddress } from "../api.js";
import {
  formatUsd,
  formatPct,
  formatDate,
  daysToMaturity,
  formatPoolSummary,
  formatPoolCompact,
  formatPtSummary,
  extractLpApyBreakdown,
  computeSpectraBoost,
  estimatePriceImpact,
  formatMerklCampaignLines,
  formatBalance,
} from "../formatters.js";

export function register(server: McpServer): void {
  // ===========================================================================
  // spectra_get_pt_details
  // ===========================================================================

  server.tool(
    "spectra_get_pt_details",
    `Get detailed information about a specific Spectra Principal Token (PT).
Returns: maturity date, TVL, implied APY, PT/YT prices, pool liquidity, LP APY breakdown,
underlying asset info, IBT protocol, yield leverage, pool reserves (IBT/PT amounts),
maturity redemption value, points program multipliers, asset tags, and base IBT info.

Protocol context:
- PT trades at a discount to its underlying (the discount IS the fixed yield).
  At maturity, PT redeems for the maturityValue shown (may differ from 1:1).
- PT + YT = 1 underlying at maturity. YT price = 1 - PT price (in underlying terms).
- YT leverage shows how much yield exposure 1 unit of YT provides relative to holding
  the underlying directly. Higher leverage = more amplified yield exposure.
- IBT APR breakdown shows organic yield vs external incentive programs. High APR from
  incentives alone may not be sustainable.

Includes external Merkl campaign APR when available.

Output surfaces conditional competing interpretations when data is ambiguous — e.g.,
PT above par, skewed reserves, high APY with thin liquidity, or incentive-dominated APR.
These appear only when triggered by the specific data returned.

Use spectra_compare_yield to compare fixed vs. variable rates. Use spectra_get_looping_strategy to
calculate leveraged fixed yield via Morpho. Use spectra_get_portfolio to check wallet holdings.
Use spectra_get_pool_activity to see trading patterns on this pool.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pt_address: EVM_ADDRESS.describe("The PT contract address (0x...)"),
    },
    async ({ chain, pt_address }) => {
      try {
        const network = resolveNetwork(chain);
        const chainInfo = SUPPORTED_CHAINS[network];

        // Fetch PT data and Merkl campaigns in parallel
        let effectivePtAddr = pt_address;
        const [ptResult, merklResult] = await Promise.all([
          fetchSpectraPtValidated(chain, effectivePtAddr),
          chainInfo ? fetchMerklCampaigns(chainInfo.id).catch(() => ({ campaigns: new Map<string, MerklCampaign[]>(), available: false })) : Promise.resolve({ campaigns: new Map<string, MerklCampaign[]>(), available: true }),
        ]);
        const merklMap = merklResult.campaigns;
        let pt = ptResult.data as SpectraPt | undefined;

        // If not found, the address might be a pool address — try resolving
        if (!pt) {
          const resolved = await resolvePtFromPoolAddress(chain, pt_address);
          if (resolved) {
            effectivePtAddr = resolved;
            const retry = await fetchSpectraPtValidated(chain, effectivePtAddr);
            pt = retry.data as SpectraPt | undefined;
          }
        }

        if (!pt) {
          const text = `No PT found at ${pt_address} on ${chain}. If this is a pool address, use spectra_list_pools to find the PT address.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Look up Merkl campaigns for this pool's addresses
        const poolAddr = pt.pools?.[0]?.address;
        const ibtAddr = pt.ibt?.address;
        const lookupAddrs = [pt_address, poolAddr, ibtAddr].filter(Boolean) as string[];
        const campaigns = lookupMerklCampaigns(merklMap, lookupAddrs);

        const summary = formatPtSummary(pt, chain, campaigns);

        // Data-driven tensions: surface ambiguity where THIS data creates it
        const pool = pt.pools?.[0];
        const tensions: string[] = [];
        if (pool) {
          const ptPriceUnderlying = pool.ptPrice?.underlying ?? 0;
          const impliedApy = pool.impliedApy ?? 0;
          const poolLiqUsd = pool.liquidity?.usd ?? 0;
          const tvlUsd = pt.tvl?.usd ?? 0;

          // PT trading above underlying = negative implied APY or pricing anomaly
          if (ptPriceUnderlying > 1.001) {
            tensions.push(
              `  Data tension: PT trades ABOVE underlying (${ptPriceUnderlying.toFixed(6)}). ` +
              `Buying PT here means paying a premium, not locking in a discount. ` +
              `This could indicate: (A) temporary AMM imbalance from a large trade, ` +
              `(B) market pricing in expected IBT rate increase that hasn't materialized in APR yet, ` +
              `or (C) stale oracle/pricing data. Check spectra_get_pool_activity for recent large swaps.`
            );
          }

          // Pool reserves heavily skewed = slippage risk that APY doesn't show
          if (pool.ibtAmount && pool.ptAmount) {
            const ibtDec = pt.ibt?.decimals ?? pt.decimals ?? 18;
            const ptDec = pt.decimals ?? 18;
            const ibtReserve = formatBalance(pool.ibtAmount, ibtDec);
            const ptReserve = formatBalance(pool.ptAmount, ptDec);
            if (ibtReserve > 0 && ptReserve > 0) {
              const ptIbtRatio = ptReserve / ibtReserve;
              if (ptIbtRatio > 5) {
                tensions.push(
                  `  Data tension: Pool is ${ptIbtRatio.toFixed(1)}:1 PT/IBT. ` +
                  `Selling PT into this pool will face elevated slippage. ` +
                  `This skew could mean: (A) persistent net selling pressure on PT (bearish signal), ` +
                  `or (B) heavy YT minting via Router (which deposits IBT, mints PT+YT, and the PT stays in the pool) -- ` +
                  `a bullish variable-rate bet that manifests as pool imbalance. ` +
                  `spectra_get_pool_activity shows which.`
                );
              } else if (ptIbtRatio < 0.2) {
                tensions.push(
                  `  Data tension: Pool is ${(1/ptIbtRatio).toFixed(1)}:1 IBT/PT -- almost no PT in reserves. ` +
                  `Buying PT will face elevated slippage. Heavy PT buying or redemptions have drained PT side.`
                );
              }
            }
          }

          // High APY with thin liquidity = headline rate you can't actually capture
          if (impliedApy > 10 && poolLiqUsd > 0 && poolLiqUsd < 50000) {
            tensions.push(
              `  Data tension: ${formatPct(impliedApy)} implied APY but only ${formatUsd(poolLiqUsd)} liquidity. ` +
              `Any meaningful position ($10K+) would face significant price impact, reducing effective yield well below the headline. ` +
              `Use spectra_scan_opportunities with your capital size to see effective APY after entry cost.`
            );
          }

          // IBT APR dominated by incentives -- the "fixed rate" is locking in against a potentially unsustainable variable rate
          const ibtTotal = pt.ibt?.apr?.total ?? 0;
          const ibtBase = pt.ibt?.apr?.details?.base ?? 0;
          if (ibtTotal > 5 && ibtBase >= 0 && ibtBase < ibtTotal * 0.3 && impliedApy > 0) {
            tensions.push(
              `  Data tension: IBT variable APR (${formatPct(ibtTotal)}) is ${((1 - ibtBase / ibtTotal) * 100).toFixed(0)}% incentive-driven (base: ${formatPct(ibtBase)}). ` +
              `If incentives end, the variable rate drops to ~${formatPct(ibtBase)} and the fixed rate lock ` +
              `(${formatPct(impliedApy)}) looks increasingly attractive in hindsight. ` +
              `But if incentives persist, the variable rate continues to outperform. ` +
              `The fixed-vs-variable decision here is really a bet on incentive duration.`
            );
          }
        }

        // Next-step hints: guide agent to logical follow-up tools
        const ptAddr = pt.address || pt_address;
        const nextSteps = [
          ``,
          ...(tensions.length > 0 ? [``, ...tensions, ``] : []),
          `--- Next Steps ---`,
          `• Compare fixed vs variable yield: spectra_compare_yield(chain="${chain}", pt_address="${ptAddr}")`,
          `• Check leverage potential: spectra_get_looping_strategy(chain="${chain}", pt_address="${ptAddr}")`,
          ...(poolAddr ? [`• See trading patterns: spectra_get_pool_activity(chain="${chain}", pool_address="${poolAddr}")`] : []),
          `• Capital-aware ranking: spectra_scan_opportunities(capital_usd=YOUR_AMOUNT) to see where this PT ranks at your size`,
        ];

        let text = summary + "\n" + nextSteps.join("\n");
        if (!merklResult.available) {
          text += `\nNote: Merkl incentive data unavailable — external campaign APR may be missing.`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // spectra_list_pools
  // ===========================================================================

  server.tool(
    "spectra_list_pools",
    `List all active Spectra pools on a given chain.
Returns a summary of each pool including: asset name, maturity, TVL, implied APY,
LP APY, pool liquidity, pool reserves (IBT/PT amounts with ratio), IBT APR breakdown
(organic vs incentive yield), maturity redemption value, points multipliers, and asset tags.

Metric definitions used across all Spectra tools:
- PT TVL = value of underlying deposited to mint PTs (pt.tvl in API)
- Liquidity = AMM pool depth (IBT + PT both sides of the Curve pool, pool.liquidity in API)
- Implied APY = annualized fixed rate from buying PT at discount
- IBT APR = variable rate on the underlying vault (labeled APR, not compounded)

Each pool is a Curve StableSwap-NG AMM pair of IBT and PT.
LP APY is the yield from providing liquidity to the pool (fees + gauge emissions).

Set include_expired=true to also show recently matured pools (if the API returns them).
By default only active (non-expired) pools are shown.

Includes external Merkl campaign APR when available. Output surfaces conditional
competing interpretations when data is ambiguous (e.g., high APY with thin liquidity).

For multi-chain discovery, use spectra_get_best_fixed_yields (raw APY ranking) or
spectra_scan_opportunities (capital-aware with price impact and looping analysis).
Use spectra_get_pool_activity on a specific pool to see recent trading patterns.`,
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
      compact: z
        .boolean()
        .default(false)
        .describe("If true, return one-line-per-pool output (much shorter). Use for quick scanning; omit for full details."),
      include_expired: z
        .boolean()
        .default(false)
        .describe("If true, include recently matured/expired pools in results. Default false (active only)."),
    },
    async ({ chain, sort_by, min_tvl_usd, compact, include_expired }) => {
      try {
        const network = resolveNetwork(chain);
        const chainInfo = SUPPORTED_CHAINS[network];

        // Fetch pools and Merkl campaigns in parallel
        const [poolsResult, merklResult] = await Promise.all([
          fetchSpectraPoolsValidated(chain),
          chainInfo ? fetchMerklCampaigns(chainInfo.id).catch(() => ({ campaigns: new Map<string, MerklCampaign[]>(), available: false })) : Promise.resolve({ campaigns: new Map<string, MerklCampaign[]>(), available: true }),
        ]);
        const merklMap = merklResult.campaigns;
        const pts = poolsResult.data as SpectraPt[];

        if (!Array.isArray(pts) || pts.length === 0) {
          const text = `No pools found on ${chain}. The endpoint may use a different format -- try spectra_get_pt_details with a specific address.`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Expand each PT into one entry per pool so multi-pool PTs are all visible
        const expanded: Array<{ pt: SpectraPt; pool: SpectraPool }> = [];
        for (const pt of pts) {
          if (!pt.pools || pt.pools.length === 0) continue;
          if (!include_expired && pt.maturity * 1000 <= Date.now()) continue;
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
          const text = `No active pools on ${chain} with TVL >= ${formatUsd(min_tvl_usd)}`;
          return { content: [{ type: "text" as const, text }] };
        }

        const header = `Found ${expanded.length} active pool(s) on ${SUPPORTED_CHAINS[chain]?.name || chain} (sorted by ${sort_by}):\n`;
        let body: string;
        if (compact) {
          body = expanded.map(({ pt, pool }) => formatPoolCompact(pt, pool, chain)).join("\n");
        } else {
          body = expanded.map(({ pt, pool }) => {
            const addrs = [pt.address, pool.address, pt.ibt?.address].filter(Boolean) as string[];
            const campaigns = lookupMerklCampaigns(merklMap, addrs);
            return formatPoolSummary(pt, pool, chain, campaigns);
          }).join("\n\n");
        }

        // Data-driven tensions: surface only when THIS result set creates ambiguity
        const tensionLines: string[] = [];
        if (sort_by === "implied_apy" && expanded.length >= 2) {
          const topPool = expanded[0].pool;
          const topLiq = topPool.liquidity?.usd ?? 0;
          const topApy = topPool.impliedApy ?? 0;
          // Check if the #1 pool by APY has significantly less liquidity than lower-ranked pools
          const medianLiq = [...expanded]
            .map(e => e.pool.liquidity?.usd ?? 0)
            .sort((a, b) => a - b)[Math.floor(expanded.length / 2)];
          if (topApy > 5 && topLiq > 0 && medianLiq > 0 && topLiq < medianLiq * 0.3) {
            tensionLines.push(
              `  Data tension: #1 by APY (${formatPct(topApy)}) has ${formatUsd(topLiq)} liquidity -- ` +
              `less than 30% of the median pool (${formatUsd(medianLiq)}). ` +
              `The headline rate may not survive a real entry. ` +
              `Use spectra_scan_opportunities(capital_usd=YOUR_AMOUNT) to rank by what you can actually capture.`
            );
          }
        }

        // Check for negative implied APY pools in the result set
        const negApyPools = expanded.filter(e => (e.pool.impliedApy ?? 0) < 0);
        if (negApyPools.length > 0) {
          tensionLines.push(
            `  Data tension: ${negApyPools.length} pool(s) show negative implied APY -- ` +
            `PT trades above its underlying. Buying PT there means paying a premium, not earning yield. ` +
            `This can happen when pool reserves are skewed from heavy selling or stale pricing.`
          );
        }

        // Check for phantom pools: non-zero APY but near-zero TVL and liquidity
        const phantomPools = expanded.filter(e =>
          (e.pt.tvl?.usd ?? 0) < 1 && (e.pool.liquidity?.usd ?? 0) < 1
        );
        if (phantomPools.length > 0) {
          tensionLines.push(
            `  Data tension: ${phantomPools.length} pool(s) show <$1 TVL and <$1 liquidity ` +
            `but appear active with non-zero APY. Likely price feed outage or unfunded pool.`
          );
        }

        const footer = [
          ``,
          ...(tensionLines.length > 0 ? [...tensionLines, ``] : []),
          `--- Next Steps ---`,
          `• Drill into a pool: spectra_get_pt_details(chain="${chain}", pt_address=PT_ADDRESS) for full details`,
          `• Compare yield: spectra_compare_yield(chain="${chain}", pt_address=PT_ADDRESS) for fixed vs variable`,
          `• Capital-aware ranking: spectra_scan_opportunities(capital_usd=YOUR_AMOUNT) for cross-chain comparison with price impact`,
        ].join("\n");

        let text = header + "\n" + body + footer;
        if (!merklResult.available) {
          text += `\nNote: Merkl incentive data unavailable — external campaign APR may be missing.`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error listing pools: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // spectra_get_best_fixed_yields
  // ===========================================================================

  server.tool(
    "spectra_get_best_fixed_yields",
    `Find the best fixed-rate yield opportunities across all Spectra chains.
Scans all supported networks and returns the top opportunities ranked by implied APY.
Filters by asset type if specified.

Important: This ranks by raw implied APY without considering your capital size or pool
liquidity. These rankings will often disagree with spectra_scan_opportunities (which ranks by
effective APY after entry cost). That disagreement is intentional -- raw APY reflects
the pool's headline rate while effective APY reflects what you actually capture at your
capital size. Neither ranking is "correct" -- they measure different things. Use both to
develop conviction about which pools genuinely serve your strategy.`,
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
      compact: z
        .boolean()
        .default(false)
        .describe("If true, return one-line-per-opportunity output (much shorter). Use for quick scanning; omit for full details."),
    },
    async ({ asset_filter, min_tvl_usd, min_liquidity_usd, top_n: rawTopN, compact }) => {
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
          const text = `No opportunities found matching criteria.${asset_filter ? ` Asset filter: ${asset_filter}.` : ""} Try lowering min_tvl_usd or min_liquidity_usd.${chainWarning}`;
          return { content: [{ type: "text" as const, text }] };
        }

        const truncNote = rawOpps.length > top_n ? ` (showing top ${top.length} of ${rawOpps.length})` : "";
        const header = `Top ${top.length} Fixed Yield Opportunities on Spectra${asset_filter ? ` (filtered: ${asset_filter})` : ""}${truncNote}:\n`;
        let body: string;
        if (compact) {
          body = top.map((opp, i) => `#${i + 1} ${formatPoolCompact(opp.pt, opp.pool, opp.chain)}`).join("\n");
        } else {
          body = top.map((opp, i) => `#${i + 1}\n${formatPoolSummary(opp.pt, opp.pool, opp.chain)}`).join("\n\n");
        }

        // Data-driven tensions: surface when THIS ranking has deceptive properties
        const yieldTensions: string[] = [];
        if (top.length >= 2) {
          // Check if top results have very different liquidity depths
          const topLiq = top[0].pool.liquidity?.usd ?? 0;
          const secondLiq = top[1].pool.liquidity?.usd ?? 0;
          const topApy = top[0].pool.impliedApy ?? 0;
          const secondApy = top[1].pool.impliedApy ?? 0;
          if (topLiq > 0 && topLiq < 50000 && secondLiq > topLiq * 3 && topApy > secondApy) {
            yieldTensions.push(
              `  Data tension: #1 (${formatPct(topApy)}) has ${formatUsd(topLiq)} liquidity while #2 (${formatPct(secondApy)}) ` +
              `has ${formatUsd(secondLiq)}. At any meaningful capital size, #2 likely delivers more actual yield than #1. ` +
              `This ranking reflects headline rates, not deployable returns.`
            );
          }

          // Check if results span very different maturities -- short maturity = higher annualized entry cost
          const shortestDays = Math.min(...top.map(o => daysToMaturity(o.pt.maturity)));
          const longestDays = Math.max(...top.map(o => daysToMaturity(o.pt.maturity)));
          if (shortestDays > 0 && longestDays > 0 && longestDays > shortestDays * 4) {
            const shortOpp = top.find(o => daysToMaturity(o.pt.maturity) === shortestDays);
            if (shortOpp && (shortOpp.pool.impliedApy ?? 0) > secondApy) {
              yieldTensions.push(
                `  Data tension: Results span ${shortestDays}d to ${longestDays}d maturities. ` +
                `Short-maturity pools show higher annualized APY but entry cost gets ` +
                `annualized over fewer days, potentially inverting the effective yield. ` +
                `spectra_scan_opportunities accounts for this.`
              );
            }
          }
        }

        const footer = [
          ``,
          ...(yieldTensions.length > 0 ? [...yieldTensions, ``] : []),
          `--- Next Steps ---`,
          `• Capital-aware re-ranking: spectra_scan_opportunities(capital_usd=YOUR_AMOUNT) — ranks by effective APY after price impact (these rankings intentionally disagree with raw APY)`,
          `• Drill into a pool: spectra_get_pt_details(chain=CHAIN, pt_address=PT_ADDRESS) for full details`,
          `• Compare yield: spectra_compare_yield(chain=CHAIN, pt_address=PT_ADDRESS) for fixed vs variable spread`,
          `• Check leverage: spectra_get_looping_strategy(chain=CHAIN, pt_address=PT_ADDRESS) for Morpho looping`,
        ].join("\n");

        const text = header + chainWarning + "\n" + body + footer;
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error scanning yields: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // spectra_compare_yield
  // ===========================================================================

  server.tool(
    "spectra_compare_yield",
    `Compare Spectra's fixed yield (via PT) against the variable yield of the underlying
interest-bearing token. Helps users decide if locking in a fixed rate is worthwhile
versus staying in the variable-rate position.

Protocol context:
- Fixed rate is labeled "implied APY" (annualized, compounded). Variable rate is labeled
  "IBT APR" (not compounded). LP yield is labeled "LP APY". Each is labeled at point of use.
- Entry cost (price impact) is amortized over days to maturity.
- LP alternative: providing liquidity earns trading fees + SPECTRA gauge emissions.

Output surfaces competing interpretations when the data is ambiguous — e.g., positive
raw spread but negative effective spread after entry cost, or incentive-dominated variable rate.

Use spectra_get_looping_strategy to lever up the fixed yield via Morpho. Use spectra_get_portfolio to
check your current positions. Use spectra_scan_opportunities for multi-chain comparison.`,
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
        const chainInfo = SUPPORTED_CHAINS[network];

        // Fetch PT data and Merkl campaigns in parallel
        let effectivePtAddr = pt_address;
        const [ptResult, merklResult] = await Promise.all([
          fetchSpectraPtValidated(chain, effectivePtAddr),
          chainInfo ? fetchMerklCampaigns(chainInfo.id).catch(() => ({ campaigns: new Map<string, MerklCampaign[]>(), available: false })) : Promise.resolve({ campaigns: new Map<string, MerklCampaign[]>(), available: true }),
        ]);
        const merklMap = merklResult.campaigns;
        let pt = ptResult.data as SpectraPt | undefined;

        // If not found, the address might be a pool address — try resolving
        if (!pt) {
          const resolved = await resolvePtFromPoolAddress(chain, pt_address);
          if (resolved) {
            effectivePtAddr = resolved;
            const retry = await fetchSpectraPtValidated(chain, effectivePtAddr);
            pt = retry.data as SpectraPt | undefined;
          }
        }

        if (!pt) {
          return { content: [{ type: "text" as const, text: `No PT found at ${pt_address} on ${chain}. If this is a pool address, use spectra_list_pools to find the PT address.` }], isError: true };
        }

        const pool = pt.pools?.[0];
        if (!pool) {
          return { content: [{ type: "text" as const, text: `No active pool for this PT` }], isError: true };
        }

        const fixedApy = pool.impliedApy || 0;
        const variableApr = pt.ibt?.apr?.total || 0;
        const spread = fixedApy - variableApr;
        const maturityDays = daysToMaturity(pt.maturity);
        const tvlUsd = pt.tvl?.usd || 0;
        const poolLiqUsd = pool.liquidity?.usd || 0;

        // Compute real boost if veSPECTRA balance provided
        // Use pool liquidity (total AMM depth), not PT TVL — the gauge boost formula
        // uses the user's share of the pool, which is pool.liquidity, not pt.tvl
        let boostInfo: { multiplier: number; boostFraction: number } | undefined;
        let veTotalSupply: number | null = null;
        let veDataAvailable = true;
        if (ve_spectra_balance !== undefined && ve_spectra_balance > 0) {
          try {
            veTotalSupply = await fetchVeTotalSupply();
            boostInfo = computeSpectraBoost(ve_spectra_balance, veTotalSupply, poolLiqUsd || tvlUsd, capital_usd);
          } catch {
            veDataAvailable = false;
            // Degrade gracefully if RPC fails
          }
        }

        // Extract full LP breakdown
        const lpData = extractLpApyBreakdown(pool, boostInfo?.boostFraction ?? 0);
        const lpParts: string[] = [];
        if (lpData.lpApyBreakdown.fees > 0) lpParts.push(`fees ${formatPct(lpData.lpApyBreakdown.fees)}`);
        if (lpData.lpApyBreakdown.pt > 0) lpParts.push(`PT convergence ${formatPct(lpData.lpApyBreakdown.pt)}`);
        if (lpData.lpApyBreakdown.ibt > 0) lpParts.push(`IBT accrual ${formatPct(lpData.lpApyBreakdown.ibt)}`);
        for (const [token, apy] of Object.entries(lpData.lpApyBreakdown.rewards)) {
          lpParts.push(`${token} ${formatPct(apy)}`);
        }
        for (const [token, range] of Object.entries(lpData.lpApyBreakdown.boostedRewards)) {
          lpParts.push(`${token} gauge ${formatPct(range.min)}-${formatPct(range.max)}`);
        }

        // Entry cost at agent's capital size
        const impactFrac = estimatePriceImpact(capital_usd, poolLiqUsd);
        const impactPct = impactFrac * 100;
        const annualizedEntryCost = maturityDays > 0
          ? impactFrac * (365 / maturityDays) * 100
          : impactFrac * 100;
        const effectiveFixedApy = fixedApy - annualizedEntryCost;

        const lines = [
          `-- Yield Comparison: ${pt.underlying?.symbol || "?"} --`,
          ``,
          `  Fixed (Spectra PT):   ${formatPct(fixedApy)} APY (compounded)`,
          `  Variable (${pt.ibt?.symbol || "IBT"}${pt.ibt?.address ? ` @ ${pt.ibt.address}` : ""}):   ${formatPct(variableApr)} APR (simple, not compounded)`,
          `  Note: APR vs APY — at ${formatPct(variableApr)}, the difference is ~${formatPct(variableApr > 0 ? (Math.pow(1 + variableApr / 36500, 365) - 1) * 100 - variableApr : 0)}. Matters more at higher rates.`,
        ];

        // IBT APR breakdown — surface composition so agents can reason about variable rate sources
        const ibtDetails = pt.ibt?.apr?.details;
        if (ibtDetails) {
          const parts: string[] = [];
          if (ibtDetails.base != null) {
            parts.push(`base ${formatPct(ibtDetails.base)}`);
          }
          if (ibtDetails.rewards && Object.keys(ibtDetails.rewards).length > 0) {
            for (const [token, apy] of Object.entries(ibtDetails.rewards)) {
              parts.push(`${token} ${formatPct(apy)}`);
            }
          }
          if (parts.length > 0) {
            lines.push(`    +-- Composition: ${parts.join(" + ")}`);
          }
        }

        lines.push(
          `  Spread:               ${spread >= 0 ? "+" : ""}${formatPct(spread)}`,
          ``,
          `  Maturity: ${formatDate(pt.maturity)} (${maturityDays} days)`,
          `  PT Discount: ${formatPct((1 - (pool.ptPrice?.underlying || 1)) * 100)}`,
          ``,
          `  Entry Cost at ${formatUsd(capital_usd)}:`,
          `    Liquidity: ${formatUsd(poolLiqUsd)}`,
          `    Est. Price Impact: ~${formatPct(impactPct)} (conservative upper bound)`,
          `    Effective Fixed APY: ${formatPct(effectiveFixedApy)} (after amortizing entry cost over ${maturityDays} days)`,
          ``,
          `  Spread after entry cost: ${effectiveFixedApy > variableApr ? "+" : ""}${formatPct(effectiveFixedApy - variableApr)} (effective fixed APY minus variable APR)`,
          `  Spread before entry cost: ${fixedApy > variableApr ? "+" : ""}${formatPct(fixedApy - variableApr)} (raw fixed APY minus variable APR)`,
          `  Entry cost narrows spread by ${formatPct(annualizedEntryCost)} annualized — scales with trade size relative to pool depth.`,
          ``,
          `  LP Alternative: ${formatPct(lpData.lpApy)} APY (${lpParts.join(" + ")})`,
        );
        if (lpData.lpApyBoostedTotal > lpData.lpApy) {
          lines.push(`  LP (Max Boost): ${formatPct(lpData.lpApyBoostedTotal)} APY (with max veSPECTRA boost)`);
        }
        if (boostInfo && boostInfo.multiplier > 1) {
          lines.push(`  LP (Your ${boostInfo.multiplier.toFixed(2)}x Boost at ${formatUsd(capital_usd)} deposit): ${formatPct(lpData.lpApyAtBoost)} APY`);
          // Show how much veSPECTRA needed for full boost
          if ((poolLiqUsd || tvlUsd) > 0 && ve_spectra_balance !== undefined && veTotalSupply !== null) {
            const neededForMax = veTotalSupply * (capital_usd / (poolLiqUsd || tvlUsd));
            if (ve_spectra_balance < neededForMax) {
              lines.push(`  Full 2.5x boost requires: ${neededForMax.toLocaleString("en-US", { maximumFractionDigits: 0 })} veSPECTRA at this deposit size`);
            } else {
              lines.push(`  You have FULL 2.5x boost in this pool at ${formatUsd(capital_usd)} deposit.`);
            }
          }
        }
        lines.push(`  YT Leverage: ${(pool.ytLeverage || 0).toFixed(1)}x`);

        // Merkl external campaigns
        {
          const addrs = [pt_address, pool.address, pt.ibt?.address].filter(Boolean) as string[];
          const campaigns = lookupMerklCampaigns(merklMap, addrs);
          if (campaigns.length > 0) {
            const existingTokens = new Set<string>();
            for (const token of Object.keys(lpData.lpApyBreakdown.rewards)) existingTokens.add(token.toUpperCase());
            const merklLines = formatMerklCampaignLines(campaigns, existingTokens);
            for (const ml of merklLines) lines.push(ml);
          }
        }

        // Data-driven tensions: surface where THIS comparison creates genuine ambiguity
        const compareTensions: string[] = [];

        // Spread positive on raw, negative after entry cost = the entry cost IS the decision
        if (spread > 0 && effectiveFixedApy < variableApr) {
          compareTensions.push(
            `  Data tension: Raw spread is positive (${formatPct(spread)}) but effective spread after entry cost ` +
            `is negative (${formatPct(effectiveFixedApy - variableApr)}). At ${formatUsd(capital_usd)}, ` +
            `the AMM impact erases the fixed-rate advantage. Either reduce position size to reduce impact, ` +
            `or accept the variable rate. A smaller entry (or DCA across multiple transactions) would preserve more of the spread.`
          );
        }

        // Variable rate dominated by incentives = the comparison is really "fixed rate vs incentive duration"
        const ibtTotalApr = pt.ibt?.apr?.total || 0;
        const ibtBaseApr = pt.ibt?.apr?.details?.base ?? ibtTotalApr;
        if (ibtTotalApr > 3 && ibtBaseApr >= 0 && ibtBaseApr < ibtTotalApr * 0.3) {
          compareTensions.push(
            `  Data tension: Variable APR (${formatPct(ibtTotalApr)}) is ${((1 - ibtBaseApr / ibtTotalApr) * 100).toFixed(0)}% incentive-driven. ` +
            `Base organic yield is only ${formatPct(ibtBaseApr)}. If incentives expire, ` +
            `the variable rate collapses to ~${formatPct(ibtBaseApr)} and the fixed rate (${formatPct(fixedApy)}) ` +
            `would have been the better choice. This comparison is implicitly a bet on incentive program longevity.`
          );
        }

        // LP APY exceeds both fixed and variable = there's a third option the binary comparison hides
        if (lpData.lpApy > fixedApy && lpData.lpApy > variableApr && lpData.lpApy > 1) {
          compareTensions.push(
            `  Data tension: LP APY (${formatPct(lpData.lpApy)}) exceeds both fixed (${formatPct(fixedApy)}) and variable (${formatPct(variableApr)}). ` +
            `The fixed-vs-variable framing may be misleading when a third option dominates. ` +
            `But LP APY includes gauge emissions that require veSPECTRA for full boost and ` +
            `is not truly "fixed" — it fluctuates with pool trading volume and emission rates.`
          );
        }

        if (compareTensions.length > 0) {
          lines.push(``);
          for (const t of compareTensions) lines.push(t);
        }

        // Next-step hints
        const ptAddr = pt.address || pt_address;
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        if (effectiveFixedApy > variableApr) {
          lines.push(`• Fixed yield exceeds variable — consider locking in: spectra_quote_trade(chain="${chain}", pt_address="${ptAddr}", amount=YOUR_AMOUNT, side="buy")`);
        }
        lines.push(`• Leverage the spread: spectra_get_looping_strategy(chain="${chain}", pt_address="${ptAddr}") for Morpho looping`);
        lines.push(`• Preview portfolio impact: spectra_simulate_trade(chain="${chain}", pt_address="${ptAddr}", address=YOUR_WALLET, amount=YOUR_AMOUNT, side="buy")`);
        lines.push(`• Cross-chain comparison: spectra_scan_opportunities(capital_usd=${capital_usd}) to compare this against all opportunities`);

        if (!merklResult.available) {
          lines.push(``);
          lines.push(`Note: Merkl incentive data unavailable — external campaign APR may be missing.`);
        }

        if (!veDataAvailable && ve_spectra_balance !== undefined && ve_spectra_balance > 0) {
          lines.push(``);
          lines.push(`Note: veSPECTRA data unavailable (Base RPC unreachable) — boost calculations omitted. LP APY shown without boost.`);
        }

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error comparing yields: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
