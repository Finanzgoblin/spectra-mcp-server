/**
 * Tool: spectra_quote_trade
 *
 * Quotes PT trades using on-chain Curve get_dy() when available,
 * falling back to a conservative constant-product math estimate.
 * On-chain quotes reflect the actual StableSwap-NG amplification
 * parameter and pool state — significantly more accurate for large trades.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork } from "../config.js";
import { fetchSpectra, fetchCurveGetDy, amountToBigInt } from "../api.js";
import type { TradeQuote } from "../types.js";
import { parsePtResponse, buildQuoteFromPt, formatTradeQuote, formatPct, formatBalance } from "../formatters.js";

/**
 * Try to build a TradeQuote from an on-chain Curve get_dy() call.
 * Returns null if the RPC is unavailable, the call reverts, or data is missing.
 * On success, overrides the math-estimated expectedOut with the exact on-chain value.
 *
 * Exported for reuse by simulate_portfolio_after_trade (avoids duplicating quoting logic).
 */
export async function tryOnChainQuote(
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

  // Convert human-readable amount to raw token units (string arithmetic to avoid float overflow)
  const dx = amountToBigInt(amount, inputDecimals);
  if (dx <= 0n) return null;

  const dyRaw = await fetchCurveGetDy(poolAddress, i, j, dx, chain);
  if (dyRaw === null || dyRaw <= 0n) return null;

  // Convert raw output back to human-readable (BigInt-safe to avoid precision loss for large values)
  const divisor = 10n ** BigInt(outputDecimals);
  const wholePart = dyRaw / divisor;
  const fracPart = dyRaw % divisor;
  const expectedOut = Number(wholePart) + Number(fracPart) / Number(divisor);
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
    "spectra_quote_trade",
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
and minOut at the specified slippage tolerance. Also includes pool context: IBT/PT
reserves with ratio, and IBT APR composition (organic vs incentive yield).
The output indicates whether the quote came from on-chain (exact) or math estimate.

On-chain quotes reflect the actual Curve StableSwap-NG amplification parameter
and current pool state — significantly more accurate than the math estimate,
especially for large trades.

Use spectra_simulate_trade to preview your full portfolio state after this trade
(BEFORE / TRADE / AFTER with deltas). Use spectra_compare_yield to evaluate whether the trade
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
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const pool = pt.pools?.[0];
        if (!pool) {
          const text = `No active pool for PT ${pt.name}`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Step 1: Build the math-based fallback quote
        const mathQuote = buildQuoteFromPt(pt, pool, amount, side, slippage_tolerance);
        if (!mathQuote) {
          const ptName = pt.name || "PT";
          const text = `Cannot quote: PT price data unavailable for ${ptName}. The pool may have no liquidity.`;
          return { content: [{ type: "text" as const, text }], isError: true };
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

        const quoteText = formatTradeQuote(quote);

        // Quote method divergence: when both math and on-chain exist, the gap is a signal
        const divergenceLines: string[] = [];
        if (quote.onChain && mathQuote) {
          const mathImpact = mathQuote.priceImpactPct;
          const onChainImpact = quote.priceImpactPct;
          const impactRatio = mathImpact > 0 ? onChainImpact / mathImpact : 0;
          // Surface meaningful divergence — the gap between math and on-chain reveals pool shape
          if (impactRatio > 0 && Math.abs(1 - impactRatio) > 0.3) {
            divergenceLines.push("");
            divergenceLines.push("--- Quote Method Divergence ---");
            divergenceLines.push(`  Math estimate: ${formatPct(mathImpact)} impact | On-chain: ${formatPct(onChainImpact)} impact`);
            if (onChainImpact < mathImpact * 0.7) {
              divergenceLines.push(`  On-chain impact is ${Math.round((1 - impactRatio) * 100)}% lower than math estimate.`);
              divergenceLines.push(`  The pool's StableSwap amplification is significantly reducing slippage.`);
              divergenceLines.push(`  Scanner rankings (which use math estimates) understate this pool's capacity.`);
            } else if (onChainImpact > mathImpact * 1.3) {
              divergenceLines.push(`  On-chain impact is ${Math.round((impactRatio - 1) * 100)}% higher than math estimate.`);
              divergenceLines.push(`  Unusual — the pool may be in a stressed state, near imbalance limits,`);
              divergenceLines.push(`  or have low amplification. The math estimate was optimistic here.`);
            }
          }
        }

        // Pool context: reserves + IBT APR composition (helps agents assess pool health)
        const contextLines: string[] = [];
        if (pool.ibtAmount && pool.ptAmount) {
          const ibtDec = pt.ibt?.decimals ?? pt.decimals ?? 18;
          const ptDec = pt.decimals ?? 18;
          const ibtReserve = formatBalance(pool.ibtAmount, ibtDec);
          const ptReserve = formatBalance(pool.ptAmount, ptDec);
          if (ibtReserve > 0 || ptReserve > 0) {
            const ratio = ibtReserve > 0 ? (ptReserve / ibtReserve).toFixed(2) : "N/A";
            contextLines.push(`  Pool Reserves: ${ibtReserve.toLocaleString("en-US", { maximumFractionDigits: 2 })} IBT / ${ptReserve.toLocaleString("en-US", { maximumFractionDigits: 2 })} PT (ratio ${ratio})`);
          }
        }
        const ibtDetails = pt.ibt?.apr?.details;
        if (ibtDetails) {
          const parts: string[] = [];
          if (ibtDetails.base != null) parts.push(`base ${formatPct(ibtDetails.base)}`);
          if (ibtDetails.rewards) {
            for (const [token, apy] of Object.entries(ibtDetails.rewards)) {
              parts.push(`${token} ${formatPct(apy)}`);
            }
          }
          if (parts.length > 0) {
            contextLines.push(`  IBT APR: ${formatPct(pt.ibt?.apr?.total || 0)} (${parts.join(" + ")})`);
          }
        }

        // Next-step hints + negative signal for high impact
        const nextLines: string[] = [``, `--- Next Steps ---`];
        nextLines.push(`• Preview portfolio: spectra_simulate_trade(chain="${chain}", pt_address="${pt_address}", address=YOUR_WALLET, amount=${amount}, side="${side}")`);
        nextLines.push(`• Compare yield: spectra_compare_yield(chain="${chain}", pt_address="${pt_address}") for fixed vs variable analysis`);
        nextLines.push(`• Check leverage: spectra_get_looping_strategy(chain="${chain}", pt_address="${pt_address}") for Morpho looping`);

        if (quote.priceImpactPct > 5) {
          nextLines.push(``);
          nextLines.push(`⚠ High impact (${formatPct(quote.priceImpactPct)}): consider reducing trade size, or check pool depth via spectra_get_pool_volume(chain="${chain}", pool_address="${pool.address || pt_address}")`);
        }

        const contextStr = contextLines.length > 0 ? "\n\n--- Pool Context ---\n" + contextLines.join("\n") : "";
        const divergenceStr = divergenceLines.length > 0 ? "\n" + divergenceLines.join("\n") : "";
        const text = quoteText + contextStr + divergenceStr + "\n" + nextLines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error quoting trade: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
