/**
 * Tool: quote_trade
 *
 * Quotes PT trades using on-chain Curve get_dy() when available,
 * falling back to a conservative constant-product math estimate.
 * On-chain quotes reflect the actual StableSwap-NG amplification
 * parameter and pool state — significantly more accurate for large trades.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork } from "../config.js";
import { fetchSpectra, fetchCurveGetDy } from "../api.js";
import type { TradeQuote } from "../types.js";
import { parsePtResponse, buildQuoteFromPt, formatTradeQuote } from "../formatters.js";

/**
 * Try to build a TradeQuote from an on-chain Curve get_dy() call.
 * Returns null if the RPC is unavailable, the call reverts, or data is missing.
 * On success, overrides the math-estimated expectedOut with the exact on-chain value.
 */
async function tryOnChainQuote(
  mathQuote: TradeQuote,
  poolAddress: string,
  chain: string,
  amount: number,
  side: "buy" | "sell",
  ibtDecimals: number,
  ptDecimals: number,
  slippagePct: number,
): Promise<TradeQuote | null> {
  // Curve pool: coins(0) = IBT, coins(1) = PT
  // Buy PT: get_dy(0, 1, dx)   — input IBT, output PT
  // Sell PT: get_dy(1, 0, dx)   — input PT, output IBT
  const i = side === "buy" ? 0 : 1;
  const j = side === "buy" ? 1 : 0;
  const inputDecimals = side === "buy" ? ibtDecimals : ptDecimals;
  const outputDecimals = side === "buy" ? ptDecimals : ibtDecimals;

  // Convert human-readable amount to raw token units
  const dx = BigInt(Math.round(amount * 10 ** inputDecimals));
  if (dx <= 0n) return null;

  const dyRaw = await fetchCurveGetDy(poolAddress, i, j, dx, chain);
  if (dyRaw === null || dyRaw <= 0n) return null;

  // Convert raw output back to human-readable
  const expectedOut = Number(dyRaw) / 10 ** outputDecimals;
  if (expectedOut <= 0 || !Number.isFinite(expectedOut)) return null;

  const effectiveRate = expectedOut / amount;
  const spotOut = amount * mathQuote.spotRate;
  // Derive actual price impact from on-chain quote vs spot
  const priceImpactPct = spotOut > 0 ? Math.max(0, (1 - expectedOut / spotOut) * 100) : 0;
  const minOut = expectedOut * (1 - slippagePct / 100);

  return {
    ...mathQuote,
    expectedOut,
    effectiveRate,
    priceImpactPct,
    minOut,
    onChain: true,
  };
}

export function register(server: McpServer): void {
  server.tool(
    "quote_trade",
    `Estimate expected output, price impact, and minimum output for a PT trade.
Automatically uses on-chain Curve get_dy() for exact quotes when a public RPC
is available for the chain. Falls back to a conservative constant-product math
estimate if on-chain quoting fails.

Side:
  "buy"  = spend underlying/IBT to buy PT (e.g. spend USDC-worth to get PT)
  "sell" = sell PT to receive underlying/IBT

This tool only quotes PT trades on the Curve AMM pool. YT does not trade on the
pool directly — YT is acquired by minting (deposit IBT to get PT+YT) or sold via
flash-redeem. To estimate YT value: YT price = 1 - PT price in underlying terms.

Returns: expected output amount, spot & effective rates, price impact,
and minOut at the specified slippage tolerance. The output indicates whether the
quote came from on-chain (exact) or math estimate (conservative upper bound).

On-chain quotes reflect the actual Curve StableSwap-NG amplification parameter
and current pool state — significantly more accurate than the math estimate,
especially for large trades.

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
          const text = `No PT found at ${pt_address} on ${chain}`;
          return { content: [{ type: "text" as const, text }] };
        }

        const pool = pt.pools?.[0];
        if (!pool) {
          const text = `No active pool for PT ${pt.name}`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Step 1: Build the math-based fallback quote
        const mathQuote = buildQuoteFromPt(pt, pool, amount, side, slippage_tolerance);
        if (!mathQuote) {
          const ptName = pt.name || "PT";
          const text = `Cannot quote: PT price data unavailable for ${ptName}. The pool may have no liquidity.`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Step 2: Try on-chain quote (best-effort, falls back to math)
        const poolAddress = pool.address;
        let quote = mathQuote;
        if (poolAddress) {
          const ibtDecimals = pt.ibt?.decimals ?? pt.decimals ?? 18;
          const ptDecimals = pt.decimals ?? 18;
          const onChainQuote = await tryOnChainQuote(
            mathQuote, poolAddress, chain, amount, side,
            ibtDecimals, ptDecimals, slippage_tolerance,
          );
          if (onChainQuote) {
            quote = onChainQuote;
          }
        }

        const text = formatTradeQuote(quote);
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error quoting trade: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
