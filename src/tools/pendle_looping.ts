/**
 * Tool: pendle_get_looping_strategy
 *
 * Detailed leveraged fixed-yield strategy for a Pendle PT + Morpho looping.
 * The Pendle equivalent of spectra_get_looping_strategy.
 *
 * Strategy: Buy Pendle PT → use as Morpho collateral → borrow underlying →
 * buy more PT → repeat. Each loop multiplies yield exposure.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES, MORPHO_CHAIN_IDS, PROTOCOL_CONSTANTS, EVM_ADDRESS } from "../config.js";
import { fetchPendleMarketDetail, findMorphoMarketForPt, fetchMorphoMarketHistory } from "../api.js";
import type { BorrowRateRisk } from "../types.js";
import {
  formatPct,
  formatUsd,
  pendleDaysToMaturity,
  formatMorphoLltv,
  getEffectiveLiquidityUsd,
  cumulativeLeverageAtLoop,
  estimateLoopingEntryCost,
  estimatePendlePriceImpact,
  formatPrescriptiveObservationBoundary,
} from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

/** Standard normal CDF (Abramowitz & Stegun). */
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;
  const p = d * Math.exp((-x * x) / 2) *
    (t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
  return x > 0 ? 1 - p : p;
}

export function register(server: McpServer): void {
  server.tool(
    "pendle_get_looping_strategy",
    `Calculate a leveraged fixed-yield strategy using Pendle PT + Morpho looping.

Strategy: Buy Pendle PT → use as Morpho collateral → borrow underlying → buy more PT → repeat.
Each loop multiplies yield exposure.

Returns projected yields at different leverage levels (1x to max safe leverage),
effective APY, risk parameters, borrow rate sensitivity, and break-even analysis.

Automatically fetches the live Morpho borrow rate and LLTV when a matching market exists.

NOTE: Looping requires a Morpho market that accepts the specific Pendle PT as collateral.
Morpho markets for Pendle PTs exist primarily on Ethereum mainnet and some on Arbitrum.

The Pendle equivalent of spectra_get_looping_strategy.

Use pendle_get_market_details for full market info.
Use pendle_scan_opportunities(include_looping=true) for cross-market looping rankings.
Use morpho_list_markets to find available Morpho markets.`,
    {
      chain: PENDLE_CHAIN_ENUM.describe("The blockchain network"),
      market_address: EVM_ADDRESS.describe("The Pendle market address"),
      morpho_ltv: z.number().gt(0).lt(1).optional().describe(
        "Override Morpho LTV ratio (e.g. 0.86). Auto-detected if omitted."
      ),
      borrow_rate: z.number().optional().describe(
        "Override Morpho borrow rate in % APY. Fetched live if omitted."
      ),
      max_loops: z.number().min(1).max(20).default(5).describe(
        "Maximum loop iterations (default 5)"
      ),
    },
    async ({ chain, market_address, morpho_ltv, borrow_rate, max_loops }) => {
      try {
        const market = await fetchPendleMarketDetail(chain, market_address);
        if (!market) {
          return {
            content: [{ type: "text" as const, text: `Pendle market ${market_address} not found on ${PENDLE_CHAIN_NAMES[chain] || chain}.` }],
            isError: true,
          };
        }

        const d = market.details;
        const days = pendleDaysToMaturity(market.expiry);
        const baseApy = (d.impliedApy || 0) * 100;
        const poolLiqUsd = d.liquidity || 0;
        const expiryDate = market.expiry.split("T")[0];

        if (baseApy <= 0) {
          return {
            content: [{
              type: "text" as const,
              text: `Pendle market ${market.name} has 0% implied APY — looping produces no yield.\nConsider LP instead: LP APY ${formatPct((d.aggregatedApy || 0) * 100)}.`,
            }],
          };
        }

        // Look up Morpho market for this Pendle PT
        const ptAddress = market.pt;
        const morphoMarket = await findMorphoMarketForPt(ptAddress, chain);
        const morphoDetected = morphoMarket !== null;

        const effectiveLtv = morpho_ltv ?? (morphoDetected
          ? formatMorphoLltv(morphoMarket!.lltv)
          : PROTOCOL_CONSTANTS.loopingDefaults.ltv);
        const effectiveBorrowRate = borrow_rate ?? (morphoDetected
          ? (morphoMarket!.state?.borrowApy || 0) * 100
          : PROTOCOL_CONSTANTS.loopingDefaults.borrowRatePct);

        const lines: string[] = [
          `-- Pendle Looping Strategy: ${market.name} --`,
          `  Chain: ${PENDLE_CHAIN_NAMES[chain] || chain}`,
          `  Base Fixed APY: ${formatPct(baseApy)}`,
          `  LP APY: ${formatPct((d.aggregatedApy || 0) * 100)}`,
          `  Maturity: ${expiryDate} (${days} days)`,
          `  Pool Liquidity: ${formatUsd(poolLiqUsd)}`,
          `  PT: ${ptAddress}`,
        ];

        // ── Absolute return: always show, no threshold ──
        {
          const absoluteReturn = baseApy * (days / 365);
          lines.push(`  Absolute Return: ~${formatPct(absoluteReturn)} over ${days} days (${formatPct(baseApy)} annualized)`);
        }

        if (morphoDetected) {
          const mk = morphoMarket!.uniqueKey;
          lines.push(`  Morpho Market: ${mk} (auto-detected)`);
          lines.push(`    Collateral: ${morphoMarket!.collateralAsset?.symbol || "?"}`);
          lines.push(`    Loan: ${morphoMarket!.loanAsset?.symbol || "?"}`);
          lines.push(`    Utilization: ${formatPct((morphoMarket!.state?.utilization || 0) * 100)}`);
          lines.push(`    Available Liquidity: ${formatUsd(getEffectiveLiquidityUsd(morphoMarket!))}`);
          lines.push(`    LLTV: ${formatPct(effectiveLtv * 100)}${morpho_ltv !== undefined ? " (user override)" : " (from Morpho)"}`);
          lines.push(`    Borrow Rate: ${formatPct(effectiveBorrowRate)}${borrow_rate !== undefined ? " (user override)" : " (live)"}`);
        } else {
          lines.push(`  Morpho Market: not found for this Pendle PT on ${chain}`);
          lines.push(`  Morpho LTV: ${formatPct(effectiveLtv * 100)}${morpho_ltv !== undefined ? " (user provided)" : " (default estimate)"}`);
          lines.push(`  Borrow Rate: ${formatPct(effectiveBorrowRate)}${borrow_rate !== undefined ? " (user provided)" : " (default estimate)"}`);
          if (morpho_ltv === undefined || borrow_rate === undefined) {
            lines.push(`  ** WARNING: No Morpho market found. Numbers below use placeholder assumptions. **`);
            lines.push(``);
            lines.push(`  ⚡ TENSION: Looping is not currently possible — but Morpho market creation is`);
            lines.push(`    permissionless (~$50 gas). This could mean:`);
            lines.push(`    (A) No curator has identified the opportunity → first-mover advantage`);
            lines.push(`    (B) The PT is too new/illiquid for comfortable collateralization → wait`);
            lines.push(`    (C) Demand exists but supply-side hasn't formed → curators, asset issuers, or LPs seed these markets`);
            lines.push(``);
            lines.push(`  Without leverage:`);
            lines.push(`    • pendle_get_market_details(chain="${chain}", market_address="${market_address}") — evaluate unleveraged`);
            lines.push(`    • pendle_scan_opportunities(capital_usd=YOUR_AMOUNT) — find markets with existing Morpho loops`);
          }
        }

        // Loop analysis
        lines.push(``);
        lines.push(`  Loop Analysis:`);

        const refCapital = 10_000;
        // For Pendle, use constant-product estimate for entry cost (poolLiqUsd)
        const hasLiq = poolLiqUsd > 0;
        const totalPt = d.totalPt || 0;
        const totalSy = d.totalSy || 0;

        if (hasLiq) {
          lines.push(`  ${"Loop".padEnd(6)} ${"Leverage".padEnd(10)} ${"Gross APY".padEnd(12)} ${"Net APY".padEnd(12)} ${"Entry Cost".padEnd(12)} ${"Eff. Margin".padEnd(12)}`);
        } else {
          lines.push(`  ${"Loop".padEnd(6)} ${"Leverage".padEnd(10)} ${"Gross APY".padEnd(12)} ${"Net APY".padEnd(12)} ${"Eff. Margin".padEnd(12)}`);
        }
        lines.push(`  ${"--".repeat(hasLiq ? 32 : 26)}`);

        for (let i = 0; i <= max_loops; i++) {
          const lev = cumulativeLeverageAtLoop(effectiveLtv, i);
          const grossApy = baseApy * lev;
          const borrowCost = effectiveBorrowRate * (lev - 1);
          const netApy = grossApy - borrowCost;

          let entryCostStr = "—";
          if (hasLiq && i > 0) {
            // Per-loop impact model: each loop trades capital * ltv^j,
            // and prior loops drain liquidity, increasing subsequent impact
            let weightedSum = 0;
            let totalDeployed = 0;
            for (let j = 0; j < i; j++) {
              const loopAmount = refCapital * Math.pow(effectiveLtv, j);
              const cumulativePrior = j === 0 ? 0 : refCapital * (1 - Math.pow(effectiveLtv, j)) / (1 - effectiveLtv);
              const effectiveLiq = Math.max(poolLiqUsd - cumulativePrior / 2, poolLiqUsd * 0.01);
              const loopImpact = estimatePendlePriceImpact(loopAmount, effectiveLiq, totalPt, totalSy, days);
              weightedSum += loopAmount * loopImpact;
              totalDeployed += loopAmount;
            }
            const blendedImpactPct = totalDeployed > 0 ? (weightedSum / totalDeployed) * 100 : 0;
            entryCostStr = `~${formatPct(blendedImpactPct)}`;
          } else if (hasLiq) {
            entryCostStr = "0.00%";
          }

          const debtRatio = lev > 1 ? (lev - 1) / (lev * effectiveLtv) : 0;
          const effectiveMargin = (1 - debtRatio) * 100;

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

        // Find optimal loop using per-loop impact model
        let bestNet = baseApy;
        let bestLoop = 0;
        for (let i = 1; i <= max_loops; i++) {
          const lev = cumulativeLeverageAtLoop(effectiveLtv, i);
          const net = baseApy * lev - effectiveBorrowRate * (lev - 1);
          let effectiveNet = net;
          if (hasLiq && days > 0) {
            let weightedSum = 0;
            let totalDeployed = 0;
            for (let j = 0; j < i; j++) {
              const loopAmount = refCapital * Math.pow(effectiveLtv, j);
              const cumulativePrior = j === 0 ? 0 : refCapital * (1 - Math.pow(effectiveLtv, j)) / (1 - effectiveLtv);
              const effectiveLiq = Math.max(poolLiqUsd - cumulativePrior / 2, poolLiqUsd * 0.01);
              const loopImpact = estimatePendlePriceImpact(loopAmount, effectiveLiq, totalPt, totalSy, days);
              weightedSum += loopAmount * loopImpact;
              totalDeployed += loopAmount;
            }
            const blendedImpactPct = totalDeployed > 0 ? (weightedSum / totalDeployed) * 100 : 0;
            const annualizedDrag = blendedImpactPct * (365 / days);
            effectiveNet = net - annualizedDrag;
          }
          if (effectiveNet > bestNet) {
            bestNet = effectiveNet;
            bestLoop = i;
          }
        }

        lines.push(``);
        lines.push(`  * Highest net APY: ${bestLoop} loops -> ~${formatPct(bestNet)} (borrow rates are variable)`);

        if (bestLoop <= 1 && bestLoop > 0) {
          lines.push(``);
          lines.push(`  ** Minimal looping benefit: optimal is only 1 loop.`);
          lines.push(`     Consider unleveraged PT yield instead. **`);
        } else if (bestLoop === 0) {
          lines.push(``);
          lines.push(`  ** Looping is unprofitable: borrow cost (${formatPct(effectiveBorrowRate)}) exceeds benefit. **`);
        }

        // Borrow rate sensitivity
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
          const breakEvenBorrow = bestLev > 1 ? (baseApy * bestLev) / (bestLev - 1) : Infinity;
          if (Number.isFinite(breakEvenBorrow)) {
            lines.push(`    Break-even borrow rate: ${formatPct(breakEvenBorrow)}`);
          }
        }

        // Borrow rate risk (30d historical)
        if (morphoDetected && bestLoop > 0) {
          const network = chain;
          const morphoChainId = MORPHO_CHAIN_IDS[network];
          if (morphoChainId) {
            const now = Math.floor(Date.now() / 1000);
            const thirtyDaysAgo = now - 30 * 86400;
            const [histResult] = await Promise.allSettled([
              fetchMorphoMarketHistory(morphoMarket!.uniqueKey, morphoChainId, thirtyDaysAgo, now, "DAY"),
            ]);

            if (histResult.status === "fulfilled" && histResult.value.history.length >= 3) {
              const { history } = histResult.value;
              const borrowRates = history.map((dp) => dp.borrowApy * 100);
              const n = borrowRates.length;
              const meanRate = borrowRates.reduce((s, v) => s + v, 0) / n;
              const variance = borrowRates.reduce((s, v) => s + (v - meanRate) ** 2, 0) / n;
              const stdDev = Math.sqrt(variance);
              const maxRate = Math.max(...borrowRates);
              const minRate = Math.min(...borrowRates);
              const currentRate = borrowRates[n - 1];

              const riskTable: BorrowRateRisk[] = [];
              for (let i = 1; i <= max_loops; i++) {
                const lev = cumulativeLeverageAtLoop(effectiveLtv, i);
                const breakEvenRate = lev > 1 ? (baseApy * lev) / (lev - 1) : Infinity;
                let probUnderwater = 0;
                let safe95th = true;
                if (Number.isFinite(breakEvenRate) && stdDev > 0) {
                  const z_val = (breakEvenRate - meanRate) / stdDev;
                  probUnderwater = 1 - normalCDF(z_val);
                  safe95th = breakEvenRate > meanRate + 2 * stdDev;
                } else if (Number.isFinite(breakEvenRate) && stdDev === 0) {
                  probUnderwater = meanRate > breakEvenRate ? 1 : 0;
                  safe95th = breakEvenRate > meanRate;
                }
                riskTable.push({ loop: i, leverage: lev, breakEvenRate, meanRate, stdDev, maxObservedRate: maxRate, probabilityUnderwater: probUnderwater, safe95thPercentile: safe95th });
              }

              lines.push(``);
              lines.push(`--- Borrow Rate Risk (30d historical) ---`);
              lines.push(`  Mean: ${formatPct(meanRate)} | StdDev: ${formatPct(stdDev)} | Max: ${formatPct(maxRate)} | Min: ${formatPct(minRate)} | Current: ${formatPct(currentRate)}`);
              lines.push(`  Data points: ${n} (daily)`);
              lines.push(``);
              lines.push(`  ${"Loop".padEnd(6)} ${"Leverage".padEnd(10)} ${"Break-Even".padEnd(12)} ${"P(underwater)".padEnd(15)} ${"95th-pct Safe?"}`);
              lines.push(`  ${"--".repeat(30)}`);

              for (const row of riskTable) {
                const beStr = Number.isFinite(row.breakEvenRate) ? formatPct(row.breakEvenRate) : "Inf";
                const probStr = row.probabilityUnderwater < 0.001 ? "<0.1%" : formatPct(row.probabilityUnderwater * 100);
                const safeIcon = row.safe95thPercentile ? "yes" : "no";
                lines.push(`  ${String(row.loop).padEnd(6)} ${(row.leverage.toFixed(2) + "x").padEnd(10)} ${beStr.padEnd(12)} ${probStr.padEnd(15)} ${safeIcon}`);
              }

              lines.push(``);
              lines.push(`  P(underwater) = probability borrow rate exceeds break-even (normal approx, 30d data).`);
            }
          }
        }

        lines.push(``);
        lines.push(`  Note: "Eff. Margin" = how far PT can drop before liquidation.`);
        lines.push(`  At 0 loops (no leverage) there is no liquidation risk.`);
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`  • Market detail: pendle_get_market_details(chain="${chain}", market_address="${market_address}")`);
        lines.push(`  • Capacity check: pendle_get_market_capacity(chain="${chain}", market_address="${market_address}")`);
        lines.push(`  • Compare alternatives: pendle_scan_opportunities(capital_usd=YOUR_AMOUNT, include_looping=true)`);
        if (morphoDetected) {
          lines.push(`  • Monitor borrow rate: morpho_get_rate(chain="${chain}", market_key="${morphoMarket!.uniqueKey}")`);
        }
        lines.push(`  • Spectra looping: spectra_get_looping_strategy for Spectra equivalents`);

        // Observation boundary — leverage amplifies temporal instability
        lines.push(``);
        const boundaryLines = formatPrescriptiveObservationBoundary("pendle_looping");
        for (const bl of boundaryLines) lines.push(bl);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
