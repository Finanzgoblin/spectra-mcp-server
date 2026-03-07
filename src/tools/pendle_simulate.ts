/**
 * Tool: pendle_simulate_trade
 *
 * Simulates a Pendle PT trade's impact on a wallet's portfolio.
 * Shows before/after position values and blended APY.
 * The Pendle equivalent of spectra_simulate_trade.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES, EVM_ADDRESS } from "../config.js";
import { fetchPendleMarketDetail, fetchPendleUserPositions } from "../api.js";
import {
  formatPct,
  formatUsd,
  pendleDaysToMaturity,
  estimatePendlePriceImpact,
} from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

export function register(server: McpServer): void {
  server.tool(
    "pendle_simulate_trade",
    `Simulate how a Pendle PT trade would change a wallet's portfolio.

Shows before/after comparison:
- Existing Pendle positions on the target chain
- New position from the simulated trade
- Blended APY across all positions
- Concentration analysis

Does NOT execute any transaction — purely informational.

The Pendle equivalent of spectra_simulate_trade.

Use pendle_quote_trade for a detailed trade quote first.
Use pendle_get_portfolio to see full current portfolio.`,
    {
      chain: PENDLE_CHAIN_ENUM.describe("The blockchain network"),
      market_address: EVM_ADDRESS.describe("The Pendle market address to trade"),
      address: EVM_ADDRESS.describe("Wallet address to simulate for"),
      amount: z.number().positive().describe(
        "Amount of input token (underlying/SY for buy, PT for sell)"
      ),
      side: z.enum(["buy", "sell"]).describe(
        '"buy" = acquire PT; "sell" = sell PT for underlying'
      ),
    },
    async ({ chain, market_address, address, amount, side }) => {
      try {
        // Fetch market and current portfolio in parallel
        const [market, portfolio] = await Promise.all([
          fetchPendleMarketDetail(chain, market_address),
          fetchPendleUserPositions(chain, address),
        ]);

        if (!market) {
          return {
            content: [{
              type: "text" as const,
              text: `Pendle market ${market_address} not found on ${PENDLE_CHAIN_NAMES[chain] || chain}.`,
            }],
            isError: true,
          };
        }

        const d = market.details;
        const days = pendleDaysToMaturity(market.expiry);
        const impliedApy = (d.impliedApy || 0) * 100;
        const poolLiqUsd = d.liquidity || 0;
        const totalPt = d.totalPt || 0;
        const totalSy = d.totalSy || 0;
        const expiryDate = market.expiry.split("T")[0];

        // PT price approximation
        const ptPriceUnderlying = days > 0 && impliedApy > 0
          ? 1 / (1 + (impliedApy / 100) * (days / 365))
          : 1;

        // Estimate trade outcome with impact
        const tradeValueUsd = amount; // simplified: assume amount ≈ USD value
        const impactFrac = estimatePendlePriceImpact(tradeValueUsd, poolLiqUsd, totalPt, totalSy, days);

        let ptDelta: number;
        let underlyingDelta: number;

        if (side === "buy") {
          const spotPt = amount / ptPriceUnderlying;
          ptDelta = spotPt * (1 - impactFrac);
          underlyingDelta = -amount;
        } else {
          ptDelta = -amount;
          underlyingDelta = amount * ptPriceUnderlying * (1 - impactFrac);
        }

        // Current portfolio state
        const positions = portfolio.positions;
        const beforeTotalUsd = positions.reduce((s, p) => s + p.totalValueUsd, 0);

        // Find existing position in this market
        const existingPos = positions.find(
          (p) => p.marketAddress.toLowerCase() === market_address.toLowerCase()
        );
        const existingPtBalance = existingPos?.pt.balance || 0;
        const existingPtValueUsd = existingPos?.pt.valueUsd || 0;

        // After-trade position
        const newPtBalance = Math.max(0, existingPtBalance + ptDelta);
        const newPtValueUsd = newPtBalance * ptPriceUnderlying; // simplified
        const positionDeltaUsd = side === "buy" ? ptDelta * ptPriceUnderlying : -amount * ptPriceUnderlying;
        const afterTotalUsd = beforeTotalUsd + positionDeltaUsd;

        // Blended APY (simplified)
        let beforeBlendedApy = 0;
        let beforeWeightSum = 0;
        for (const p of positions) {
          if (p.totalValueUsd > 0 && p.impliedApy > 0) {
            beforeBlendedApy += p.impliedApy * 100 * p.totalValueUsd;
            beforeWeightSum += p.totalValueUsd;
          }
        }
        beforeBlendedApy = beforeWeightSum > 0 ? beforeBlendedApy / beforeWeightSum : 0;

        const afterWeightSum = beforeWeightSum + positionDeltaUsd;
        const afterBlendedApy = afterWeightSum > 0
          ? (beforeBlendedApy * beforeWeightSum + impliedApy * positionDeltaUsd) / afterWeightSum
          : impliedApy;

        // Format output
        const lines: string[] = [];
        lines.push(`== Pendle Trade Simulation: ${side.toUpperCase()} ==`);
        lines.push(`  Market: ${market.name} (${PENDLE_CHAIN_NAMES[chain] || chain})`);
        lines.push(`  Maturity: ${expiryDate} (${days}d) | Implied APY: ${formatPct(impliedApy)}`);
        lines.push(`  Wallet: ${address.slice(0, 6)}...${address.slice(-4)}`);
        lines.push(``);

        // Trade details
        lines.push(`  Trade:`);
        if (side === "buy") {
          lines.push(`    Spend: ${amount.toLocaleString("en-US", { maximumFractionDigits: 4 })} underlying/SY`);
          lines.push(`    Receive: ~${ptDelta.toLocaleString("en-US", { maximumFractionDigits: 4 })} PT`);
        } else {
          lines.push(`    Spend: ${amount.toLocaleString("en-US", { maximumFractionDigits: 4 })} PT`);
          lines.push(`    Receive: ~${underlyingDelta.toLocaleString("en-US", { maximumFractionDigits: 4 })} underlying`);
        }
        lines.push(`    Entry Impact: ${formatPct(impactFrac * 100)}`);
        lines.push(``);

        // Before/after
        lines.push(`  Portfolio Impact (${PENDLE_CHAIN_NAMES[chain] || chain}):`);
        lines.push(`                    Before        After         Delta`);
        lines.push(`    Total Value:    ${formatUsd(beforeTotalUsd).padEnd(13)} ${formatUsd(afterTotalUsd).padEnd(13)} ${(positionDeltaUsd >= 0 ? "+" : "") + formatUsd(positionDeltaUsd)}`);
        lines.push(`    Blended APY:    ${formatPct(beforeBlendedApy).padEnd(13)} ${formatPct(afterBlendedApy).padEnd(13)} ${((afterBlendedApy - beforeBlendedApy) >= 0 ? "+" : "") + formatPct(afterBlendedApy - beforeBlendedApy)}`);
        lines.push(``);

        // Position detail
        lines.push(`  Target Position (${market.name}):`);
        lines.push(`    PT Balance: ${existingPtBalance.toLocaleString("en-US", { maximumFractionDigits: 4 })} → ${newPtBalance.toLocaleString("en-US", { maximumFractionDigits: 4 })}`);
        lines.push(`    PT Value:   ${formatUsd(existingPtValueUsd)} → ${formatUsd(newPtValueUsd)}`);

        if (!portfolio.available) {
          lines.push(``);
          lines.push(`  Note: Could not fetch existing portfolio — simulation shows trade impact only.`);
        }

        // Concentration check
        if (afterTotalUsd > 0 && newPtValueUsd > 0) {
          const concentration = (newPtValueUsd / afterTotalUsd) * 100;
          if (concentration > 50) {
            lines.push(``);
            lines.push(`  ⚠ Concentration: ${formatPct(concentration)} in single market after trade.`);
          }
        }

        lines.push(``);
        lines.push(`  This is a SIMULATION — no transaction is executed.`);
        lines.push(`  For actual execution, use the Pendle app or Router contract.`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
