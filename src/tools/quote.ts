/**
 * Tool: quote_trade
 *
 * Estimates expected output, price impact, and minimum output for a PT swap.
 * Uses pool data from the Spectra API (spot price + liquidity) to compute
 * a mathematical quote. For exact on-chain quotes, use the Curve pool's
 * get_dy() or the Spectra Router's previewRate().
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork } from "../config.js";
import { fetchSpectra } from "../api.js";
import { parsePtResponse, buildQuoteFromPt, formatTradeQuote } from "../formatters.js";
import { dual } from "./dual.js";

export function register(server: McpServer): void {
  server.tool(
    "quote_trade",
    `Estimate expected output, price impact, and minimum output for a PT trade.
Uses pool spot prices and liquidity from the Spectra API.

Side:
  "buy"  = spend underlying/IBT to buy PT (e.g. spend USDC-worth to get PT)
  "sell" = sell PT to receive underlying/IBT

This tool only quotes PT trades on the Curve AMM pool. YT does not trade on the
pool directly — YT is acquired by minting (deposit IBT to get PT+YT) or sold via
flash-redeem. To estimate YT value: YT price = 1 - PT price in underlying terms.

Returns: expected output amount, spot & effective rates, estimated price impact,
and minOut at the specified slippage tolerance.

Note: This is an off-chain estimate using a conservative constant-product price impact
model. Spectra pools use Curve StableSwap-NG which is more capital-efficient near peg,
so actual impact is likely lower than shown. For execution, use the Spectra Router or
Curve pool get_dy() for an exact on-chain quote.

Use simulate_portfolio_after_trade to preview your full portfolio state after this trade
(BEFORE / TRADE / AFTER with deltas). Use compare_yield to evaluate whether the trade
makes sense relative to variable rates.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pt_address: EVM_ADDRESS.describe("The PT contract address (0x...)"),
      amount: z
        .number()
        .positive()
        .describe("Amount of input token (in human-readable units, not raw decimals)"),
      side: z
        .enum(["buy", "sell"])
        .describe("Trade direction: 'buy' = acquire PT, 'sell' = dispose PT"),
      slippage_tolerance: z
        .number()
        .min(0)
        .max(50)
        .default(0.5)
        .describe("Slippage tolerance in % (default 0.5%). minOut = expectedOut * (1 - tolerance/100)"),
    },
    async ({ chain, pt_address, amount, side, slippage_tolerance }) => {
      try {
        const network = resolveNetwork(chain);
        const data = await fetchSpectra(`/${network}/pt/${pt_address}`) as any;
        const pt = parsePtResponse(data);

        if (!pt) {
          const ts = Math.floor(Date.now() / 1000);
          const params = { chain, pt_address, amount, side, slippage_tolerance };
          return dual(`No PT found at ${pt_address} on ${chain}`, { tool: "quote_trade", ts, params, data: { pt: null } });
        }

        const pool = pt.pools?.[0];
        if (!pool) {
          const ts = Math.floor(Date.now() / 1000);
          const params = { chain, pt_address, amount, side, slippage_tolerance };
          return dual(`No active pool for PT ${pt.name}`, { tool: "quote_trade", ts, params, data: { pt, pool: null } });
        }

        const quote = buildQuoteFromPt(pt, pool, amount, side, slippage_tolerance);
        if (!quote) {
          const ptName = pt.name || "PT";
          const ts = Math.floor(Date.now() / 1000);
          const params = { chain, pt_address, amount, side, slippage_tolerance };
          return dual(`Cannot quote: PT price data unavailable for ${ptName}. The pool may have no liquidity.`, { tool: "quote_trade", ts, params, data: { quote: null } });
        }

        const ts = Math.floor(Date.now() / 1000);
        const params = { chain, pt_address, amount, side, slippage_tolerance };
        return dual(formatTradeQuote(quote), { tool: "quote_trade", ts, params, data: { quote } });
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error quoting trade: ${e.message}` }], isError: true };
      }
    }
  );
}
