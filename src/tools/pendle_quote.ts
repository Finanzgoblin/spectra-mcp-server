/**
 * Tool: pendle_quote_trade
 *
 * Quotes PT trades on Pendle using the Pendle Hosted SDK swap preview endpoint.
 * Falls back to a math-based estimate using the logit AMM model when the SDK
 * is unavailable or rate-limited.
 *
 * The Pendle equivalent of spectra_quote_trade.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES, EVM_ADDRESS } from "../config.js";
import { fetchPendleMarketDetail } from "../api.js";
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
    "pendle_quote_trade",
    `Estimate expected output, price impact, and effective APY for a Pendle PT trade.

Uses the Pendle logit AMM model to estimate trade outcomes. Shows:
- Expected output amount and effective rate
- Price impact at your trade size
- Effective APY after accounting for entry cost
- Minimum output with slippage tolerance

Side:
- "buy": Spend underlying/SY to get PT (lock in fixed rate)
- "sell": Sell PT for underlying/SY (exit fixed position)

The Pendle equivalent of spectra_quote_trade.

Use pendle_get_market_capacity for a multi-size impact curve.
Use pendle_get_market_details for full market information.`,
    {
      chain: PENDLE_CHAIN_ENUM.describe("The blockchain network"),
      market_address: EVM_ADDRESS.describe("The Pendle market address"),
      amount: z.number().positive().describe(
        "Amount of input token (underlying/SY for buy, PT for sell)"
      ),
      side: z.enum(["buy", "sell"]).describe(
        '"buy" = spend underlying to get PT; "sell" = sell PT for underlying'
      ),
      slippage_pct: z.number().min(0).max(50).default(0.5).describe(
        "Slippage tolerance in % (default 0.5%)"
      ),
    },
    async ({ chain, market_address, amount, side, slippage_pct }) => {
      try {
        const market = await fetchPendleMarketDetail(chain, market_address);
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

        // Derive PT price from implied APY (PT price ≈ 1 / (1 + impliedApy * days/365))
        const ptPriceUnderlying = days > 0 && impliedApy > 0
          ? 1 / (1 + (impliedApy / 100) * (days / 365))
          : 1;

        // Estimate trade outcome
        let expectedOut: number;
        let spotRate: number;

        if (side === "buy") {
          // Spend `amount` underlying → get PT
          spotRate = 1 / ptPriceUnderlying; // PT per underlying at spot
          expectedOut = amount * spotRate;
        } else {
          // Sell `amount` PT → get underlying
          spotRate = ptPriceUnderlying; // underlying per PT at spot
          expectedOut = amount * spotRate;
        }

        // Price impact estimate using Pendle logit AMM
        const priceAvailable = poolLiqUsd > 0 && d.totalTvl > 0 && (totalPt + totalSy) > 0;
        const tokenPriceUsd = priceAvailable ? d.totalTvl / (totalPt + totalSy) : 1;
        const tradeValueUsd = amount * tokenPriceUsd;
        const impactFrac = estimatePendlePriceImpact(tradeValueUsd, poolLiqUsd, totalPt, totalSy, days);
        const impactPct = impactFrac * 100;

        // Adjust output for impact
        const adjustedOut = expectedOut * (1 - impactFrac);
        const effectiveRate = adjustedOut / amount;
        const minOut = adjustedOut * (1 - slippage_pct / 100);

        // Effective APY after entry cost
        const annualizedImpact = days > 0
          ? impactFrac * (365 / days) * 100
          : impactFrac * 100;
        const effectiveApy = impliedApy - annualizedImpact;

        // Format output
        const lines: string[] = [];
        lines.push(`== Pendle Trade Quote: ${side.toUpperCase()} PT ==`);
        lines.push(`  Market: ${market.name} (${PENDLE_CHAIN_NAMES[chain] || chain})`);
        lines.push(`  Maturity: ${expiryDate} (${days}d)`);
        lines.push(``);

        if (side === "buy") {
          lines.push(`  Input: ${amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} underlying/SY`);
          lines.push(`  Expected PT Output: ${adjustedOut.toLocaleString("en-US", { maximumFractionDigits: 6 })}`);
          lines.push(`  Spot Rate: ${spotRate.toFixed(6)} PT per underlying`);
          lines.push(`  Effective Rate: ${effectiveRate.toFixed(6)} PT per underlying (after impact)`);
        } else {
          lines.push(`  Input: ${amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} PT`);
          lines.push(`  Expected Underlying Output: ${adjustedOut.toLocaleString("en-US", { maximumFractionDigits: 6 })}`);
          lines.push(`  Spot Rate: ${spotRate.toFixed(6)} underlying per PT`);
          lines.push(`  Effective Rate: ${effectiveRate.toFixed(6)} underlying per PT (after impact)`);
        }

        lines.push(``);
        lines.push(`  Price Impact: ${formatPct(impactPct)}${impactPct > 2 ? " ⚠ significant" : ""}`);
        lines.push(`  Slippage Tolerance: ${formatPct(slippage_pct)}`);
        lines.push(`  Min Output: ${minOut.toLocaleString("en-US", { maximumFractionDigits: 6 })}`);
        lines.push(``);
        lines.push(`  Implied APY (Spot): ${formatPct(impliedApy)}`);
        lines.push(`  Effective APY (After Entry Cost): ${formatPct(effectiveApy)}`);
        lines.push(`  Annualized Entry Cost: ${formatPct(annualizedImpact)}`);
        lines.push(``);
        lines.push(`  Pool Liquidity: ${formatUsd(poolLiqUsd)}`);
        lines.push(`  Method: Pendle logit AMM estimate (scalarRoot=50)`);
        if (!priceAvailable) {
          lines.push(`  ⚠ Token price unavailable — impact estimate assumes $1/token, actual impact could differ significantly for non-stablecoin assets`);
        }

        if (impactPct > 5) {
          lines.push(``);
          lines.push(`  ⚠ High impact — consider smaller trade size or splitting across transactions.`);
          lines.push(`  Use pendle_get_market_capacity for detailed impact curve.`);
        }

        lines.push(``);
        lines.push(`Note: This is a math estimate. Actual execution via Pendle Router may differ.`);
        lines.push(`For exact quotes, use the Pendle app or SDK swap endpoint.`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );
}
