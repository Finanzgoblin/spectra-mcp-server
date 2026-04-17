/**
 * Tool: spectra_simulate_trade
 *
 * Previews what a wallet's Spectra portfolio would look like after executing
 * a PT trade. Combines portfolio fetching + quote computation + simulation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork } from "../config.js";
import type { SpectraPt, SpectraPool, PositionSnapshot, TradeQuote } from "../types.js";
import { fetchSpectraPtValidated, fetchSpectraPortfolioValidated, resolvePtFromPoolAddress } from "../api.js";
import {
  buildQuoteFromPt,
  formatBalance,
  formatPortfolioSimulation,
} from "../formatters.js";
import { tryOnChainQuote } from "./quote.js";

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
    "spectra_simulate_trade",
    `Preview what a wallet's Spectra portfolio would look like after a PT trade.

Fetches the wallet's current position (if any) and the PT pool data,
computes a trade quote, then shows BEFORE / TRADE / AFTER with deltas.

Works even if the wallet has no existing position (simulates a new entry).
Side: "buy" = acquire PT, "sell" = dispose PT.

Note: This simulates PT trades only, not YT. YT is acquired by minting (deposit IBT
to get PT+YT) and sold via the Router's flash-redeem mechanism, not through the Curve
pool directly. The wallet's YT balance is shown but not modified by this simulation.

Use spectra_get_portfolio to see current full positions. Use spectra_quote_trade for a standalone
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
        let effectivePtAddr = pt_address;
        const [portfolioResult, ptResult] = await Promise.all([
          fetchSpectraPortfolioValidated(network, address).catch(() => ({ data: [] as unknown[], warnings: [] })),
          fetchSpectraPtValidated(chain, effectivePtAddr),
        ]);

        let pt = ptResult.data as SpectraPt | undefined;

        // If not found, the address might be a pool address — try resolving
        if (!pt) {
          const resolved = await resolvePtFromPoolAddress(chain, pt_address);
          if (resolved) {
            effectivePtAddr = resolved;
            pt = (await fetchSpectraPtValidated(chain, effectivePtAddr)).data as SpectraPt | undefined;
          }
        }

        if (!pt) {
          const text = `No PT found at ${pt_address} on ${chain}. If this is a pool address, use spectra_list_pools to find the PT address.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const pool = pt.pools?.[0];
        if (!pool) {
          const text = `No active pool for PT ${pt.name}`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Build the trade quote (math estimate first, then try on-chain)
        const mathQuote = buildQuoteFromPt(pt, pool, amount, side, slippage_tolerance);
        if (!mathQuote) {
          const text = `Cannot quote: PT price data unavailable for ${pt.name}. The pool may have no liquidity.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Try on-chain Curve get_dy() for exact output (best-effort)
        // Uses shared tryOnChainQuote to avoid duplicating quoting logic with quote_trade
        let quote: TradeQuote = mathQuote;
        if (pool.address) {
          const ibtDec = pt.ibt?.decimals ?? pt.decimals ?? 18;
          const ptDec = pt.decimals ?? 18;
          const onChainQuote = await tryOnChainQuote(
            mathQuote, pool.address, chain, amount, side,
            ibtDec, ptDec, slippage_tolerance,
          );
          if (onChainQuote) {
            quote = onChainQuote;
          }
        }

        // Extract prices from pool
        const ptPriceUsd = pool.ptPrice?.usd || 0;
        const ytPriceUsd = pool.ytPrice?.usd || 0;
        const lpPriceUsd = pool.lpt?.price?.usd || 0;
        const decimals = pt.decimals ?? 18;

        // Find existing position for this PT in the portfolio.
        // portfolioResult is ValidatedResponse<PtParsed[]> on success or the fallback
        // { data: [], warnings: [] } when the fetch was caught. `portfolioFetchFailed`
        // tracks only transport-level failures (currently impossible through the
        // validated fetcher, but we keep the branch for forward compatibility).
        const portfolioFetchFailed = false;
        const positions = portfolioResult.data as SpectraPt[];
        const existingPos: SpectraPt | undefined = positions.find(
          (p) => p.address?.toLowerCase() === pt_address.toLowerCase()
        );

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

        const simText = formatPortfolioSimulation({
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

        // Next-step hints
        const nextLines: string[] = [``, `--- Next Steps ---`];
        if (side === "buy") {
          nextLines.push(`• Check looping potential: spectra_get_looping_strategy(chain="${chain}", pt_address="${pt_address}") for leveraged yield after this trade`);
        }
        nextLines.push(`• Compare yield: spectra_compare_yield(chain="${chain}", pt_address="${pt_address}") for fixed vs variable analysis`);
        nextLines.push(`• View full portfolio: spectra_get_portfolio(address="${address}") for all positions across chains`);

        const text = simText + nextLines.join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error simulating trade: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
