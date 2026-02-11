/**
 * Tool: get_looping_strategy
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, PROTOCOL_CONSTANTS, resolveNetwork } from "../config.js";
import { fetchSpectra, findMorphoMarketForPt } from "../api.js";
import {
  formatPct,
  formatUsd,
  formatDate,
  daysToMaturity,
  parsePtResponse,
  formatMorphoLltv,
  cumulativeLeverageAtLoop,
  estimateLoopingEntryCost,
  estimatePriceImpact,
} from "../formatters.js";
import { dual } from "./dual.js";

export function register(server: McpServer): void {
  server.tool(
    "get_looping_strategy",
    `Calculate a leveraged fixed-yield strategy using Spectra PT + Morpho looping.

Strategy: Deposit asset -> mint PT on Spectra -> use PT as collateral on Morpho ->
borrow underlying -> deposit again -> repeat. Each loop multiplies yield exposure.

Returns projected yields at different leverage levels (1x to max safe leverage),
effective APY, and risk parameters. This is the "killer feature" -- the thing that
makes Spectra yields significantly higher than competing protocols.

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
      // Note: capital_usd is not a tool param — we use pool liquidity to estimate
      // cumulative entry impact as a fraction, which is capital-independent for the
      // relative cost column. The absolute cost depends on capital, but the
      // annualized drag as % APY is what matters for the optimal loop decision.
      try {
        const network = resolveNetwork(chain);
        const data = await fetchSpectra(`/${network}/pt/${pt_address}`) as any;
        const pt = parsePtResponse(data);

        if (!pt) {
          const ts = Math.floor(Date.now() / 1000);
          return dual(`No PT found at ${pt_address} on ${chain}`, {
            tool: "get_looping_strategy",
            ts,
            params: { chain, pt_address, morpho_ltv, borrow_rate, max_loops },
            data: { pt: null },
          });
        }

        const pool = pt.pools?.[0];
        if (!pool) {
          const ts = Math.floor(Date.now() / 1000);
          return dual(`PT has no active pool`, {
            tool: "get_looping_strategy",
            ts,
            params: { chain, pt_address, morpho_ltv, borrow_rate, max_loops },
            data: { pt, pool: null },
          });
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
        const ptDiscount = 1 - (pool.ptPrice?.underlying || 1);
        const maturityDays = daysToMaturity(pt.maturity);
        const poolLiqUsd = pool.liquidity?.usd || 0;

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
          lines.push(`  Morpho Market: ${mk.slice(0, 14)}...${mk.slice(-6)} (auto-detected)`);
          lines.push(`    Collateral: ${morphoMarket!.collateralAsset?.symbol || "?"}`);
          lines.push(`    Loan: ${morphoMarket!.loanAsset?.symbol || "?"}`);
          lines.push(`    Utilization: ${formatPct((morphoMarket!.state?.utilization || 0) * 100)}`);
          lines.push(`    Available Liquidity: ${formatUsd(morphoMarket!.state?.liquidityAssetsUsd || 0)}`);
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
            lines.push(`     Looping may not be possible for this PT. Use get_morpho_markets to verify. **`);
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

        // Find optimal loop count (highest net APY)
        let bestNet = baseApy;
        let bestLoop = 0;
        for (let i = 1; i <= max_loops; i++) {
          const lev = cumulativeLeverageAtLoop(effectiveLtv, i);
          const net = baseApy * lev - effectiveBorrowRate * (lev - 1);
          if (net > bestNet) {
            bestNet = net;
            bestLoop = i;
          }
        }

        lines.push(``);
        lines.push(`  * Optimal: ${bestLoop} loops -> ${formatPct(bestNet)} net APY`);

        // Show cumulative entry cost at optimal loop count
        if (hasLiq && bestLoop > 0) {
          const { totalImpactPct } = estimateLoopingEntryCost(refCapital, poolLiqUsd, effectiveLtv, bestLoop);
          const annualizedDrag = maturityDays > 0
            ? totalImpactPct * (365 / maturityDays)
            : totalImpactPct;
          lines.push(`    Cumulative entry cost: ~${formatPct(totalImpactPct)} (${formatPct(annualizedDrag)} annualized over ${maturityDays} days)`);
          lines.push(`    Entry cost scales with capital — shown for $10K reference. Larger trades face proportionally more impact.`);
        }

        lines.push(``);
        lines.push(`  Note: "Eff. Margin" = how far PT can drop before liquidation.`);
        lines.push(`  "Entry Cost" = estimated blended price impact across all loop iterations (for $10K).`);
        lines.push(`  At 0 loops (no leverage) there is no liquidation risk.`);
        lines.push(``);
        lines.push(`  Risks: Liquidation if PT depegs, smart contract risk on Morpho + Spectra,`);
        lines.push(`     borrow rate may increase, PT illiquidity near maturity,`);
        lines.push(`     cumulative entry cost increases with capital size and loop count.`);
        lines.push(`     This is NOT financial advice. Do your own research.`);

        const ts = Math.floor(Date.now() / 1000);
        return dual(lines.join("\n"), {
          tool: "get_looping_strategy",
          ts,
          params: { chain, pt_address, morpho_ltv, borrow_rate, max_loops },
          data: {
            pt,
            pool,
            morphoMarket: morphoMarket || null,
            morphoDetected,
            effectiveLtv,
            effectiveBorrowRate,
            baseApy,
            bestLoop,
            bestNet,
            rows,
          },
        });
      } catch (e: any) {
        return dual(`Error calculating loop strategy: ${e.message}`, { tool: "get_looping_strategy", ts: Math.floor(Date.now() / 1000), params: { chain, pt_address, morpho_ltv, borrow_rate, max_loops }, data: { error: e.message } }, { isError: true });
      }
    }
  );
}
