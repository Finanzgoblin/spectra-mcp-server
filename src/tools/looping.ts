/**
 * Tool: get_looping_strategy
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, PROTOCOL_CONSTANTS, MORPHO_CHAIN_IDS, resolveNetwork } from "../config.js";
import { fetchSpectra, findMorphoMarketForPt, fetchMorphoMarketHistory } from "../api.js";
import type { BorrowRateRisk } from "../types.js";
import {
  formatPct,
  formatUsd,
  formatDate,
  daysToMaturity,
  parsePtResponse,
  formatMorphoLltv,
  getEffectiveLiquidityUsd,
  cumulativeLeverageAtLoop,
  estimateLoopingEntryCost,
  estimatePriceImpact,
} from "../formatters.js";

/**
 * Approximate the standard normal CDF using the Abramowitz & Stegun method.
 * No external libraries needed — accurate to ~1e-7 for typical inputs.
 */
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327; // 1/sqrt(2*PI)
  const p =
    d *
    Math.exp((-x * x) / 2) *
    (t *
      (0.31938153 +
        t *
          (-0.356563782 +
            t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
  return x > 0 ? 1 - p : p;
}

export function register(server: McpServer): void {
  server.tool(
    "get_looping_strategy",
    `Calculate a leveraged fixed-yield strategy using Spectra PT + Morpho looping.

Strategy: Deposit asset -> mint PT on Spectra -> use PT as collateral on Morpho ->
borrow underlying -> deposit again -> repeat. Each loop multiplies yield exposure.

Returns projected yields at different leverage levels (1x to max safe leverage),
effective APY, and risk parameters.

Automatically fetches the live Morpho borrow rate and LLTV when a matching market
exists. You can still override morpho_ltv and borrow_rate manually if needed.

NOTE: Looping requires a Morpho market that accepts the specific PT as collateral.

Risk context:
- Borrow rates are variable. A 5% spread (7% yield - 2% borrow) can turn negative if
  borrow rates spike above your fixed yield. Monitor rates in Morpho.
- Higher leverage amplifies both returns and liquidation risk. Consider keeping 1-2
  loops below maximum for safety buffer.
- Entry cost (price impact) compounds across loops — each iteration faces degraded
  effective pool liquidity.

Use get_morpho_markets to find available Morpho markets. Use scan_opportunities to
discover the best looping opportunities across all chains with capital-aware sizing.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pt_address: EVM_ADDRESS.describe("The PT contract address to loop"),
      morpho_ltv: z
        .number()
        .gt(0)
        .lt(1)
        .optional()
        .describe("Override Morpho LTV ratio (e.g. 0.86 = 86%). If omitted, auto-detected from Morpho."),
      borrow_rate: z
        .number()
        .optional()
        .describe("Override Morpho borrow rate in % APY. If omitted, fetched live from Morpho."),
      max_loops: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum number of loop iterations to calculate (default 5)"),
    },
    async ({ chain, pt_address, morpho_ltv, borrow_rate, max_loops }) => {
      // Note: capital_usd is not a tool param. Entry cost IS proportional to capital
      // (estimatePriceImpact = capital / (2 * poolLiq)). We use a $10K reference to
      // illustrate the cost column. Users with larger capital should verify with
      // quote_trade() or scan_opportunities(capital_usd=...) for accurate sizing.
      try {
        const network = resolveNetwork(chain);
        const data = await fetchSpectra(`/${network}/pt/${pt_address}`) as any;
        const pt = parsePtResponse(data);

        if (!pt) {
          const text = `No PT found at ${pt_address} on ${chain}`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const pool = pt.pools?.[0];
        if (!pool) {
          const text = `PT has no active pool`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Try to auto-detect Morpho market for this PT
        const morphoMarket = await findMorphoMarketForPt(pt_address, chain);
        const morphoDetected = morphoMarket !== null;

        // Use overrides if provided, otherwise use detected values, otherwise protocol defaults
        const effectiveLtv = morpho_ltv ?? (morphoDetected
          ? formatMorphoLltv(morphoMarket!.lltv)
          : PROTOCOL_CONSTANTS.loopingDefaults.ltv);
        const effectiveBorrowRate = borrow_rate ?? (morphoDetected
          ? (morphoMarket!.state?.borrowApy || 0) * 100  // API returns decimal, we use %
          : PROTOCOL_CONSTANTS.loopingDefaults.borrowRatePct);

        const baseApy = pool.impliedApy || 0;
        const ptPriceUnderlying = pool.ptPrice?.underlying || 1;
        const ptDiscount = 1 - ptPriceUnderlying;
        const maturityDays = daysToMaturity(pt.maturity);
        const poolLiqUsd = pool.liquidity?.usd || 0;

        // H2: Guard against PT trading at premium (discount goes negative)
        if (ptPriceUnderlying >= 1) {
          const text = [
            `PT ${pt.name} is trading at or above underlying (price: ${ptPriceUnderlying.toFixed(4)}).`,
            `Looping requires PT at a discount to generate fixed yield.`,
            `At premium, the "fixed yield" is negative — you'd pay more for PT than you receive at maturity.`,
            ``,
            `This can happen near/post maturity or during temporary market dislocations.`,
            `Consider: compare_yield(chain="${chain}", pt_address="${pt_address}") to check current rates.`,
          ].join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        // Calculate looping returns
        const lines: string[] = [
          `-- Looping Strategy: ${pt.name} --`,
          `  Chain: ${chain}`,
          `  Base Fixed APY: ${formatPct(baseApy)}`,
          `  PT Discount: ${formatPct(ptDiscount * 100)}`,
          `  Maturity: ${formatDate(pt.maturity)} (${maturityDays} days)`,
          `  Pool Liquidity: ${formatUsd(poolLiqUsd)}`,
        ];

        // Show Morpho source
        if (morphoDetected) {
          const mk = morphoMarket!.uniqueKey;
          lines.push(`  Morpho Market: ${mk} (auto-detected)`);
          lines.push(`    Collateral: ${morphoMarket!.collateralAsset?.symbol || "?"}`);
          lines.push(`    Loan: ${morphoMarket!.loanAsset?.symbol || "?"}`);
          lines.push(`    Utilization: ${formatPct((morphoMarket!.state?.utilization || 0) * 100)}`);
          lines.push(`    Available Liquidity: ${formatUsd(getEffectiveLiquidityUsd(morphoMarket!))}`);
          if (morpho_ltv !== undefined) lines.push(`    LLTV: ${formatPct(effectiveLtv * 100)} (user override)`);
          else lines.push(`    LLTV: ${formatPct(effectiveLtv * 100)} (from Morpho)`);
          if (borrow_rate !== undefined) lines.push(`    Borrow Rate: ${formatPct(effectiveBorrowRate)} (user override)`);
          else lines.push(`    Borrow Rate: ${formatPct(effectiveBorrowRate)} (live from Morpho)`);
        } else {
          lines.push(`  Morpho Market: not found for this PT on ${chain}`);
          lines.push(`  Morpho LTV: ${formatPct(effectiveLtv * 100)}${morpho_ltv !== undefined ? " (user provided)" : " (default estimate -- NOT from a real market)"}`);
          lines.push(`  Borrow Rate: ${formatPct(effectiveBorrowRate)}${borrow_rate !== undefined ? " (user provided)" : " (default estimate -- NOT from a real market)"}`);
          if (morpho_ltv === undefined || borrow_rate === undefined) {
            lines.push(`  ** WARNING: No Morpho market found. Numbers below use placeholder assumptions.`);
            lines.push(`     Looping is likely NOT possible for this PT on ${chain}. **`);
            lines.push(``);
            lines.push(`  Alternative strategies for this PT:`);
            lines.push(`    • Unleveraged fixed yield: compare_yield(chain="${chain}", pt_address="${pt_address}") to evaluate the raw spread`);
            lines.push(`    • Find loopable alternatives: scan_opportunities(capital_usd=YOUR_AMOUNT, include_looping=true)`);
            lines.push(`    • Check other chains: get_morpho_markets(pt_symbol_filter="${pt.underlying?.symbol || ""}") to find Morpho markets for similar PTs`);
            lines.push(`    • YT arbitrage: scan_yt_arbitrage(capital_usd=YOUR_AMOUNT) for spread-based opportunities`);
          }
          lines.push(`  Tip: Use get_morpho_markets to find which PTs have Morpho markets.`);
        }

        lines.push(``);
        lines.push(`  Loop Analysis:`);
        // Use a reference capital of $10K to illustrate cumulative entry cost
        // (the annualized drag % is what varies with pool size, not with capital)
        const refCapital = 10_000;
        const hasLiq = poolLiqUsd > 0;

        if (hasLiq) {
          lines.push(`  ${"Loop".padEnd(6)} ${"Leverage".padEnd(10)} ${"Gross APY".padEnd(12)} ${"Net APY".padEnd(12)} ${"Entry Cost".padEnd(12)} ${"Eff. Margin".padEnd(12)}`);
        } else {
          lines.push(`  ${"Loop".padEnd(6)} ${"Leverage".padEnd(10)} ${"Gross APY".padEnd(12)} ${"Net APY".padEnd(12)} ${"Eff. Margin".padEnd(12)}`);
        }
        lines.push(`  ${"--".repeat(hasLiq ? 32 : 26)}`);

        // Build rows array for both formatting and data envelope
        const rows: Array<{
          loop: number;
          leverage: number;
          grossApy: number;
          netApy: number;
          entryCostPct: number;
          effectiveMarginPct: number;
        }> = [];

        for (let i = 0; i <= max_loops; i++) {
          const lev = cumulativeLeverageAtLoop(effectiveLtv, i);

          const grossApy = baseApy * lev;
          const borrowCost = effectiveBorrowRate * (lev - 1);
          const netApy = grossApy - borrowCost;

          // Cumulative entry cost across all loops (i loops = i buy-PT transactions)
          let totalImpactPct = 0;
          let entryCostStr = "—";
          if (hasLiq && i > 0) {
            totalImpactPct = estimateLoopingEntryCost(refCapital, poolLiqUsd, effectiveLtv, i).totalImpactPct;
            entryCostStr = `~${formatPct(totalImpactPct)}`;
          } else if (hasLiq) {
            entryCostStr = "0.00%";
          }

          // Effective liquidation margin: how far PT can drop before liquidation
          const debtRatio = lev > 1
            ? (lev - 1) / (lev * effectiveLtv)
            : 0;
          const effectiveMargin = (1 - debtRatio) * 100;

          rows.push({
            loop: i,
            leverage: lev,
            grossApy,
            netApy,
            entryCostPct: totalImpactPct,
            effectiveMarginPct: effectiveMargin,
          });

          if (hasLiq) {
            lines.push(
              `  ${String(i).padEnd(6)} ${(lev.toFixed(2) + "x").padEnd(10)} ${formatPct(grossApy).padEnd(12)} ${formatPct(netApy).padEnd(12)} ${entryCostStr.padEnd(12)} ${formatPct(effectiveMargin).padEnd(12)}`
            );
          } else {
            lines.push(
              `  ${String(i).padEnd(6)} ${(lev.toFixed(2) + "x").padEnd(10)} ${formatPct(grossApy).padEnd(12)} ${formatPct(netApy).padEnd(12)} ${formatPct(effectiveMargin).padEnd(12)}`
            );
          }
        }

        // Find optimal loop count: highest net APY minus annualized entry cost
        // H1: Entry cost is factored into the optimization objective, not just displayed
        let bestNet = baseApy;
        let bestLoop = 0;
        for (let i = 1; i <= max_loops; i++) {
          const lev = cumulativeLeverageAtLoop(effectiveLtv, i);
          const net = baseApy * lev - effectiveBorrowRate * (lev - 1);
          // Subtract annualized entry drag at reference capital
          let effectiveNet = net;
          if (hasLiq && maturityDays > 0) {
            const { totalImpactPct } = estimateLoopingEntryCost(refCapital, poolLiqUsd, effectiveLtv, i);
            const annualizedDrag = totalImpactPct * (365 / maturityDays);
            effectiveNet = net - annualizedDrag;
          }
          if (effectiveNet > bestNet) {
            bestNet = effectiveNet;
            bestLoop = i;
          }
        }

        lines.push(``);
        lines.push(`  * Highest net APY at current rates: ${bestLoop} loops -> ~${formatPct(bestNet)} (borrow rates are variable -- this could shift. See margin column for liquidation buffer at each level.)`);

        // Show cumulative entry cost at that loop count
        if (hasLiq && bestLoop > 0) {
          const { totalImpactPct } = estimateLoopingEntryCost(refCapital, poolLiqUsd, effectiveLtv, bestLoop);
          const annualizedDrag = maturityDays > 0
            ? totalImpactPct * (365 / maturityDays)
            : totalImpactPct;
          lines.push(`    Cumulative entry cost: ~${formatPct(totalImpactPct)} (${formatPct(annualizedDrag)} annualized over ${maturityDays} days)`);
          lines.push(`    Entry cost scales with capital — shown for $10K reference. Larger trades face proportionally more impact.`);
        }

        // Failure scenario: optimal_loops <= 1 adds complexity for minimal benefit
        if (bestLoop <= 1 && bestLoop > 0) {
          lines.push(``);
          lines.push(`  ** Minimal looping benefit: optimal is only ${bestLoop} loop(s).`);
          lines.push(`     At 1 loop, you add Morpho smart contract risk, liquidation exposure, and`);
          lines.push(`     variable borrow cost for modest leverage. Consider unleveraged PT yield instead. **`);
        } else if (bestLoop === 0) {
          lines.push(``);
          lines.push(`  ** Looping is unprofitable at current rates: borrow cost (${formatPct(effectiveBorrowRate)}) exceeds`);
          lines.push(`     PT yield benefit from leverage. Unleveraged (0 loops) is optimal. **`);
        }

        // Break-even period: how long until yield covers entry cost
        if (hasLiq && bestLoop > 0 && bestNet > 0 && maturityDays > 0) {
          const { totalImpactPct: bestImpact } = estimateLoopingEntryCost(refCapital, poolLiqUsd, effectiveLtv, bestLoop);
          if (bestImpact > 0) {
            // Daily yield (net APY / 365), entry cost as % of capital → days to break even
            const dailyYieldPct = bestNet / 365;
            const breakEvenDays = dailyYieldPct > 0 ? Math.ceil(bestImpact / dailyYieldPct) : Infinity;
            lines.push(``);
            lines.push(`  Break-Even: ~${breakEvenDays} days to recover entry cost at current rates (for $10K reference)`);
            if (breakEvenDays > maturityDays * 0.5) {
              lines.push(`    ** Break-even is >${Math.round(breakEvenDays / maturityDays * 100)}% of time to maturity — tight margin for profitability **`);
            }
          }
        }

        // Borrow rate sensitivity: what happens if rates increase
        if (bestLoop > 0) {
          const bestLev = cumulativeLeverageAtLoop(effectiveLtv, bestLoop);
          lines.push(``);
          lines.push(`  Borrow Rate Sensitivity (at ${bestLoop} loops / ${bestLev.toFixed(2)}x leverage):`);
          for (const delta of [1, 2, 3]) {
            const stressedRate = effectiveBorrowRate + delta;
            const stressedNet = baseApy * bestLev - stressedRate * (bestLev - 1);
            const label = stressedNet < 0 ? "** NEGATIVE **" : stressedNet < baseApy ? "worse than unleveraged" : "profitable";
            lines.push(`    Borrow +${delta}% (${formatPct(stressedRate)}): net APY ${formatPct(stressedNet)} (${label})`);
          }
          // Find break-even borrow rate
          const breakEvenBorrow = bestLev > 1 ? (baseApy * bestLev) / (bestLev - 1) : Infinity;
          if (Number.isFinite(breakEvenBorrow)) {
            lines.push(`    Break-even borrow rate: ${formatPct(breakEvenBorrow)} (looping yields 0% net at this rate)`);
          }
        }

        lines.push(``);
        lines.push(`  Note: "Eff. Margin" = how far PT can drop before liquidation.`);
        lines.push(`  "Entry Cost" = estimated blended price impact across all loop iterations (for $10K).`);
        lines.push(`  At 0 loops (no leverage) there is no liquidation risk.`);
        lines.push(``);
        lines.push(`  Risks: Liquidation if PT depegs, smart contract risk on Morpho + Spectra,`);
        lines.push(`     borrow rate may increase (see sensitivity above), PT illiquidity near maturity,`);
        lines.push(`     cumulative entry cost increases with capital size and loop count.`);

        // -----------------------------------------------------------------
        // Borrow Rate Risk Analysis (best-effort, appended if data exists)
        // -----------------------------------------------------------------
        if (morphoDetected && bestLoop > 0) {
          const morphoChainId = MORPHO_CHAIN_IDS[network];
          if (morphoChainId) {
            const now = Math.floor(Date.now() / 1000);
            const thirtyDaysAgo = now - 30 * 86400;

            // Use Promise.allSettled so a fetch failure never blocks the main output
            const [histResult] = await Promise.allSettled([
              fetchMorphoMarketHistory(
                morphoMarket!.uniqueKey,
                morphoChainId,
                thirtyDaysAgo,
                now,
                "DAY",
              ),
            ]);

            if (histResult.status === "fulfilled" && histResult.value.history.length >= 3) {
              const { history } = histResult.value;

              // Borrow APY values from Morpho are decimals (e.g. 0.03 = 3%).
              // Convert to percentages for display.
              const borrowRates = history.map((dp) => dp.borrowApy * 100);

              const n = borrowRates.length;
              const meanRate = borrowRates.reduce((s, v) => s + v, 0) / n;
              const variance =
                borrowRates.reduce((s, v) => s + (v - meanRate) ** 2, 0) / n;
              const stdDev = Math.sqrt(variance);
              const maxRate = Math.max(...borrowRates);
              const minRate = Math.min(...borrowRates);
              const currentRate = borrowRates[borrowRates.length - 1];

              // Build the risk table for each loop level (skip loop 0 = unleveraged)
              const riskTable: BorrowRateRisk[] = [];
              for (let i = 1; i <= max_loops; i++) {
                const lev = cumulativeLeverageAtLoop(effectiveLtv, i);
                // Break-even borrow rate: rate at which net APY = 0
                // net = baseApy * lev - borrowRate * (lev - 1) = 0
                // => borrowRate = baseApy * lev / (lev - 1)
                const breakEvenRate =
                  lev > 1 ? (baseApy * lev) / (lev - 1) : Infinity;

                let probUnderwater = 0;
                let safe95th = true;
                if (Number.isFinite(breakEvenRate) && stdDev > 0) {
                  const z = (breakEvenRate - meanRate) / stdDev;
                  // P(rate > breakEven) = 1 - CDF(z)
                  probUnderwater = 1 - normalCDF(z);
                  safe95th = breakEvenRate > meanRate + 2 * stdDev;
                } else if (Number.isFinite(breakEvenRate) && stdDev === 0) {
                  // Zero variance: deterministic — either always safe or always underwater
                  probUnderwater = meanRate > breakEvenRate ? 1 : 0;
                  safe95th = breakEvenRate > meanRate;
                }

                riskTable.push({
                  loop: i,
                  leverage: lev,
                  breakEvenRate,
                  meanRate,
                  stdDev,
                  maxObservedRate: maxRate,
                  probabilityUnderwater: probUnderwater,
                  safe95thPercentile: safe95th,
                });
              }

              // Format the risk section
              lines.push(``);
              lines.push(`--- Borrow Rate Risk (30d historical) ---`);
              lines.push(
                `  Mean: ${formatPct(meanRate)} | StdDev: ${formatPct(stdDev)} | Max: ${formatPct(maxRate)} | Min: ${formatPct(minRate)} | Current: ${formatPct(currentRate)}`,
              );
              lines.push(`  Data points: ${n} (daily over 30d)`);
              lines.push(``);
              lines.push(
                `  ${"Loop".padEnd(6)} ${"Leverage".padEnd(10)} ${"Break-Even".padEnd(12)} ${"P(underwater)".padEnd(15)} ${"95th-pct Safe?"}`,
              );
              lines.push(`  ${"--".repeat(30)}`);

              for (const row of riskTable) {
                const beStr = Number.isFinite(row.breakEvenRate)
                  ? formatPct(row.breakEvenRate)
                  : "Inf";
                const probStr =
                  row.probabilityUnderwater < 0.001
                    ? "<0.1%"
                    : formatPct(row.probabilityUnderwater * 100);
                const safeIcon = row.safe95thPercentile ? "yes" : "no";
                lines.push(
                  `  ${String(row.loop).padEnd(6)} ${(row.leverage.toFixed(2) + "x").padEnd(10)} ${beStr.padEnd(12)} ${probStr.padEnd(15)} ${safeIcon}`,
                );
              }

              lines.push(``);
              lines.push(
                `  Reading: P(underwater) = probability that borrow rate exceeds break-even,`,
              );
              lines.push(
                `  based on 30d historical distribution (normal approximation).`,
              );
              lines.push(
                `  This is a statistical estimate, not a guarantee — tail events happen.`,
              );
            }
            // If history fetch failed or had < 3 data points, silently skip the section
          }
        }

        // Next-step hints
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`• Quote entry trade: quote_trade(chain="${chain}", pt_address="${pt_address}", amount=YOUR_AMOUNT, side="buy")`);
        lines.push(`• Preview portfolio: simulate_portfolio_after_trade(chain="${chain}", pt_address="${pt_address}", address=YOUR_WALLET, amount=YOUR_AMOUNT, side="buy")`);
        lines.push(`• Compare against alternatives: scan_opportunities(capital_usd=YOUR_AMOUNT) for cross-chain ranking`);
        if (morphoDetected) {
          lines.push(`• Monitor borrow rate: get_morpho_rate(chain="${chain}", market_key="${morphoMarket!.uniqueKey}") — rates are variable`);
        }

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error calculating loop strategy: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
