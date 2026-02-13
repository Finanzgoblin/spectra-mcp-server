/**
 * Tool: simulate_portfolio_after_trade
 *
 * Previews what a wallet's Spectra portfolio would look like after executing
 * a PT trade. Combines portfolio fetching + quote computation + simulation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork } from "../config.js";
import type { SpectraPt, SpectraPool, PositionSnapshot, TradeQuote } from "../types.js";
import { fetchSpectra, fetchCurveGetDy } from "../api.js";
import {
  parsePtResponse,
  buildQuoteFromPt,
  formatBalance,
  formatPortfolioSimulation,
} from "../formatters.js";

function buildSnapshot(
  ptBal: number, ytBal: number, lpBal: number,
  ptPriceUsd: number, ytPriceUsd: number, lpPriceUsd: number
): PositionSnapshot {
  const ptValueUsd = ptBal * ptPriceUsd;
  const ytValueUsd = ytBal * ytPriceUsd;
  const lpValueUsd = lpBal * lpPriceUsd;
  return {
    ptBalance: ptBal,
    ptValueUsd,
    ytBalance: ytBal,
    ytValueUsd,
    lpBalance: lpBal,
    lpValueUsd,
    totalValueUsd: ptValueUsd + ytValueUsd + lpValueUsd,
  };
}

export function register(server: McpServer): void {
  server.tool(
    "simulate_portfolio_after_trade",
    `Preview what a wallet's Spectra portfolio would look like after a PT trade.

Fetches the wallet's current position (if any) and the PT pool data,
computes a trade quote, then shows BEFORE / TRADE / AFTER with deltas.

Works even if the wallet has no existing position (simulates a new entry).
Side: "buy" = acquire PT, "sell" = dispose PT.

Note: This simulates PT trades only, not YT. YT is acquired by minting (deposit IBT
to get PT+YT) and sold via the Router's flash-redeem mechanism, not through the Curve
pool directly. The wallet's YT balance is shown but not modified by this simulation.

Use get_portfolio to see current full positions. Use quote_trade for a standalone
price quote without portfolio context.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pt_address: EVM_ADDRESS.describe("The PT contract address (0x...)"),
      address: EVM_ADDRESS.describe("The wallet address to simulate for (0x...)"),
      amount: z
        .number()
        .positive()
        .describe("Amount of input token (in human-readable units, not raw decimals)"),
      side: z
        .enum(["buy", "sell"])
        .describe("Trade direction: 'buy' = acquire PT (input underlying), 'sell' = dispose PT (input PT)"),
      slippage_tolerance: z
        .number()
        .min(0)
        .max(50)
        .default(0.5)
        .describe("Slippage tolerance in % (default 0.5%). minOut = expectedOut * (1 - tolerance/100)"),
    },
    async ({ chain, pt_address, address, amount, side, slippage_tolerance }) => {
      try {
        const network = resolveNetwork(chain);

        // Fetch portfolio and PT data in parallel
        // Portfolio is best-effort — if it fails, simulate from zero
        const [portfolioResult, ptData] = await Promise.all([
          fetchSpectra(`/${network}/portfolio/${address}`).catch(() => null) as Promise<any>,
          fetchSpectra(`/${network}/pt/${pt_address}`) as Promise<any>,
        ]);

        const pt = parsePtResponse(ptData);
        if (!pt) {
          const text = `No PT found at ${pt_address} on ${chain}`;
          return { content: [{ type: "text" as const, text }] };
        }

        const pool = pt.pools?.[0];
        if (!pool) {
          const text = `No active pool for PT ${pt.name}`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Build the trade quote (math estimate first, then try on-chain)
        const mathQuote = buildQuoteFromPt(pt, pool, amount, side, slippage_tolerance);
        if (!mathQuote) {
          const text = `Cannot quote: PT price data unavailable for ${pt.name}. The pool may have no liquidity.`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Try on-chain Curve get_dy() for exact output (best-effort)
        let quote: TradeQuote = mathQuote;
        if (pool.address) {
          const ibtDec = pt.ibt?.decimals ?? pt.decimals ?? 18;
          const ptDec = pt.decimals ?? 18;
          const i = side === "buy" ? 0 : 1;
          const j = side === "buy" ? 1 : 0;
          const inputDec = side === "buy" ? ibtDec : ptDec;
          const outputDec = side === "buy" ? ptDec : ibtDec;
          const dx = BigInt(Math.round(amount * 10 ** inputDec));
          if (dx > 0n) {
            const dyRaw = await fetchCurveGetDy(pool.address, i, j, dx, chain);
            if (dyRaw !== null && dyRaw > 0n) {
              const expectedOut = Number(dyRaw) / 10 ** outputDec;
              if (expectedOut > 0 && Number.isFinite(expectedOut)) {
                const spotOut = amount * mathQuote.spotRate;
                const priceImpactPct = spotOut > 0 ? Math.max(0, (1 - expectedOut / spotOut) * 100) : 0;
                const minOut = expectedOut * (1 - slippage_tolerance / 100);
                quote = { ...mathQuote, expectedOut, effectiveRate: expectedOut / amount, priceImpactPct, minOut, onChain: true };
              }
            }
          }
        }

        // Extract prices from pool
        const ptPriceUsd = pool.ptPrice?.usd || 0;
        const ytPriceUsd = pool.ytPrice?.usd || 0;
        const lpPriceUsd = pool.lpt?.price?.usd || 0;
        const decimals = pt.decimals ?? 18;

        // Find existing position for this PT in the portfolio
        let portfolioFetchFailed = false;
        let existingPos: SpectraPt | undefined;

        if (portfolioResult === null) {
          portfolioFetchFailed = true;
        } else {
          const positions: SpectraPt[] = Array.isArray(portfolioResult)
            ? portfolioResult
            : portfolioResult?.data || [];
          existingPos = positions.find(
            (p) => p.address?.toLowerCase() === pt_address.toLowerCase()
          );
        }

        // Build BEFORE snapshot
        let ptBal = 0;
        let ytBal = 0;
        let lpBal = 0;

        if (existingPos) {
          ptBal = formatBalance(existingPos.balance, existingPos.decimals ?? decimals);
          ytBal = formatBalance(existingPos.yt?.balance, existingPos.yt?.decimals ?? decimals);
          lpBal = existingPos.pools?.reduce((sum: number, p: SpectraPool) => {
            return sum + formatBalance(p.lpt?.balance, p.lpt?.decimals ?? 18);
          }, 0) || 0;
        }

        const isNewPosition = ptBal === 0 && ytBal === 0 && lpBal === 0;
        const before = buildSnapshot(ptBal, ytBal, lpBal, ptPriceUsd, ytPriceUsd, lpPriceUsd);

        // Build AFTER snapshot
        let afterPtBal: number;
        let sellExceedsBalance = false;

        if (side === "buy") {
          afterPtBal = ptBal + quote.expectedOut;
        } else {
          if (amount > ptBal) {
            sellExceedsBalance = true;
          }
          afterPtBal = Math.max(0, ptBal - amount);
        }

        const after = buildSnapshot(afterPtBal, ytBal, lpBal, ptPriceUsd, ytPriceUsd, lpPriceUsd);

        const text = formatPortfolioSimulation({
          ptName: pt.name,
          chain,
          maturity: pt.maturity,
          wallet: address,
          underlyingSymbol: pt.underlying?.symbol || "UNDERLYING",
          ibtSymbol: pt.ibt?.symbol || "IBT",
          ibtAddress: pt.ibt?.address,
          before,
          after,
          quote,
          isNewPosition,
          sellExceedsBalance,
          ptPriceUsd,
          ytPriceUsd,
          lpPriceUsd,
          portfolioFetchFailed,
        });

        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error simulating trade: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
