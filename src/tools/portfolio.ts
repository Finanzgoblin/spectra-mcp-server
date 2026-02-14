/**
 * Tool: get_portfolio
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, API_NETWORKS, resolveNetwork } from "../config.js";
import type { SpectraPt, MorphoMarket } from "../types.js";
import { fetchSpectra, findMorphoMarketsForPts } from "../api.js";
import {
  formatUsd,
  formatPct,
  formatPositionSummary,
  formatPortfolioHints,
  daysToMaturity,
  formatBalance,
  formatMorphoLltv,
  cumulativeLeverageAtLoop,
} from "../formatters.js";
import type { SpectraPool } from "../types.js";

/**
 * Compute compact inline looping projections for a single portfolio position.
 * Returns a formatted string to append directly to the position summary.
 */
function formatInlineLooping(
  morphoEntry: MorphoMarket | false | undefined,
  pos: SpectraPt,
  chain: string,
): string {
  if (morphoEntry === undefined) {
    return "\n  Looping: Morpho lookup failed — use get_looping_strategy for manual check";
  }
  if (morphoEntry === false) {
    return "\n  Looping: No Morpho market — can't loop this position";
  }

  const pool = pos.pools?.[0];
  const baseApy = pool?.impliedApy || 0;
  if (baseApy <= 0) {
    return "\n  Looping: Pool has no implied APY — looping analysis not applicable";
  }

  const lltv = formatMorphoLltv(morphoEntry.lltv);
  if (lltv <= 0) {
    return "\n  Looping: Invalid LLTV from Morpho market";
  }

  const borrowRatePct = (morphoEntry.state?.borrowApy || 0) * 100;
  const morphoLiqUsd = morphoEntry.state?.liquidityAssetsUsd || 0;
  const maxLoops = 5;

  // Compute net APY at each loop level
  const loopResults: Array<{ loop: number; leverage: number; netApy: number }> = [];
  let bestLoop = 0;
  let bestNet = baseApy;

  for (let i = 0; i <= maxLoops; i++) {
    const lev = cumulativeLeverageAtLoop(lltv, i);
    const grossApy = baseApy * lev;
    const borrowCost = borrowRatePct * (lev - 1);
    const netApy = grossApy - borrowCost;
    loopResults.push({ loop: i, leverage: lev, netApy });
    if (i > 0 && netApy > bestNet) {
      bestNet = netApy;
      bestLoop = i;
    }
  }

  // If no looping level improves yield, note it
  if (bestLoop === 0) {
    return `\n  Looping: Available but not profitable (borrow ${formatPct(borrowRatePct)} > yield spread at all levels)`;
  }

  // Build compact one-line summary: "1x: 8.20% | 2x: 12.15% | 3x: 15.90% ← optimal | 4x: 14.80%"
  const parts = loopResults
    .filter((r) => r.loop <= Math.min(bestLoop + 1, maxLoops))
    .map((r) => {
      const label = `${r.loop}x: ${formatPct(r.netApy)}`;
      return r.loop === bestLoop ? `${label} ← optimal` : label;
    });

  const lines = [
    ``,
    `  Looping Potential (Morpho):`,
    `    ${parts.join(" | ")}`,
    `    LLTV: ${formatPct(lltv * 100)} | Borrow: ${formatPct(borrowRatePct)} | Morpho Liq: ${formatUsd(morphoLiqUsd)}`,
    `    Full details: get_looping_strategy(chain="${chain}", pt_address="${pos.address}")`,
  ];

  return lines.join("\n");
}

export function register(server: McpServer): void {
  server.tool(
    "get_portfolio",
    `Get wallet positions on Spectra for a specific address.
Returns PT, YT, and LP balances with USD values, claimable yield,
and current rates. Queries a single chain or all chains.
Use this to understand what a wallet currently holds on Spectra.

Set include_looping_analysis=true to get inline Morpho looping projections for each
position — shows optimal leverage, net APY at each loop level, borrow rate, and
available liquidity. This saves separate get_looping_strategy calls per position.

Protocol context:
- Depositing IBT always mints BOTH PT and YT in equal amounts. If a wallet holds
  YT but no PT, it sold or LPed its PT. If it holds PT but no YT, it sold its YT.
- PT + YT = 1 underlying at maturity. This identity is fundamental to all strategies.
- Balance ratios are the key signal. Output shows Position Shape (e.g., "YT/PT 4:1")
  so you can reason about what the holder's position implies given the mechanics above.
- When investigating a strategy, ALWAYS cross-reference portfolio with
  get_pool_activity. Activity shows the HOW (transaction patterns), portfolio
  shows the WHAT (resulting position). Neither alone tells the full story.
- Strategies often span multiple wallets. If get_pool_activity shows concentrated
  activity from several addresses, check each one to build the full picture.
- For activity analysis, use get_pool_activity with the address parameter — it will
  automatically cross-reference portfolio data and provide flow accounting, contract
  detection, gas estimates, and pool impact analysis.
- Use get_address_activity to scan all pools for an address's activity in one call.`,
    {
      address: EVM_ADDRESS.describe("The wallet address (0x...)"),
      chain: CHAIN_ENUM
        .optional()
        .describe("Specific chain to query. Omit to scan all chains."),
      include_looping_analysis: z
        .boolean()
        .default(false)
        .describe("If true, compute inline Morpho looping projections for each position that has a Morpho market. Shows optimal leverage, net APY at each loop level, and borrow rate — saves a separate get_looping_strategy call per position."),
    },
    async ({ address, chain, include_looping_analysis }) => {
      try {
        const networks = chain
          ? [resolveNetwork(chain)]
          : API_NETWORKS;

        type Position = { pos: SpectraPt; chain: string };
        const failedChains: string[] = [];

        const portfolioResults = await Promise.allSettled(
          networks.map(async (net): Promise<Position[]> => {
            const raw = await fetchSpectra(`/${net}/portfolio/${address}`) as any;
            const items = Array.isArray(raw) ? raw : raw?.data || [];
            return items.map((pos: SpectraPt) => ({ pos, chain: net }));
          })
        );

        // Collect results and track which chains failed
        const allPositions: Position[] = [];
        portfolioResults.forEach((result, i) => {
          if (result.status === "fulfilled") {
            allPositions.push(...result.value);
          } else {
            failedChains.push(networks[i]);
          }
        });

        const chainWarning = failedChains.length > 0
          ? `\nNote: ${failedChains.length} chain(s) failed to respond (${failedChains.join(", ")}). Results may be partial.\n`
          : "";

        // Format only positions with non-zero balances, collecting totalValue from each
        let totalPortfolioValue = 0;
        const summaries: string[] = [];
        const hintData: Array<{
          totalValue: number; chain: string; maturityDays: number;
          ptBalance: number; ytBalance: number; lpBalance: number; name: string;
          ptAddress?: string; maturityTs?: number;
          morphoAvailable?: boolean; // true=market exists, false=checked but none, undefined=lookup failed
        }> = [];

        // Batch Morpho market lookup (best-effort, parallel with formatting)
        const chainPtMap = new Map<string, string[]>();
        for (const { pos, chain: c } of allPositions) {
          const net = resolveNetwork(c);
          if (!chainPtMap.has(net)) chainPtMap.set(net, []);
          chainPtMap.get(net)!.push(pos.address);
        }

        // Store full MorphoMarket objects (needed for looping enrichment) or false if checked but none found
        const morphoAvailability = new Map<string, MorphoMarket | false>();
        const morphoResults = await Promise.allSettled(
          Array.from(chainPtMap.entries()).map(async ([net, ptAddrs]) => {
            const markets = await findMorphoMarketsForPts(ptAddrs, net);
            return { net, markets, ptAddrs };
          })
        );
        for (const result of morphoResults) {
          if (result.status === "fulfilled") {
            const { markets, ptAddrs } = result.value;
            for (const addr of ptAddrs) {
              const addrLower = addr.toLowerCase();
              morphoAvailability.set(addrLower, markets.get(addrLower) || false);
            }
          }
          // On failure: ptAddrs stay absent from map → morphoAvailable remains undefined
        }

        for (const { pos, chain: c } of allPositions) {
          const result = formatPositionSummary(pos, c);
          if (result) {
            let posText = result.text;
            totalPortfolioValue += result.totalValue;
            // Collect data for portfolio-level hints
            const decimals = pos.decimals ?? 18;
            const ptAddrLower = pos.address.toLowerCase();
            const morphoEntry = morphoAvailability.get(ptAddrLower);
            // morphoAvailable: true if MorphoMarket object, false if checked but none, undefined if lookup failed
            const morphoAvailable = morphoEntry === undefined ? undefined : morphoEntry !== false;

            // Inline looping enrichment
            if (include_looping_analysis) {
              posText += formatInlineLooping(morphoEntry, pos, c);
            }

            summaries.push(posText);
            hintData.push({
              totalValue: result.totalValue,
              chain: c,
              maturityDays: daysToMaturity(pos.maturity),
              ptBalance: formatBalance(pos.balance, decimals),
              ytBalance: formatBalance(pos.yt?.balance, pos.yt?.decimals ?? decimals),
              lpBalance: pos.pools?.reduce((sum: number, p: SpectraPool) =>
                sum + formatBalance(p.lpt?.balance, p.lpt?.decimals ?? 18), 0) || 0,
              name: pos.name,
              ptAddress: ptAddrLower,
              maturityTs: pos.maturity,
              morphoAvailable,
            });
          }
        }

        if (summaries.length === 0) {
          const scope = chain || "any chain";
          const lines = [
            `No active Spectra positions found for ${address} on ${scope}.${chainWarning}`,
            ``,
            `--- What This Means ---`,
            `This wallet has no PT, YT, or LP positions on Spectra${chain ? ` on ${chain}` : ""}.`,
            ...(chain ? [`• Try scanning all chains: get_portfolio(address="${address}") without chain filter`] : []),
            `• Check activity history: get_address_activity(address="${address}") — the wallet may have had past positions`,
            `• Find opportunities: scan_opportunities(capital_usd=YOUR_AMOUNT) to discover yield opportunities`,
          ];
          const text = lines.join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        const scope = chain || "all chains";
        const header = `Spectra Portfolio for ${address} (${scope}):\n` +
          `Total Positions: ${summaries.length} | Estimated Value: ${formatUsd(totalPortfolioValue)}\n`;
        let text = header + chainWarning + "\n" + summaries.join("\n\n");

        // Layer 3: Portfolio-level hints for multi-position portfolios
        const portfolioHintLines = formatPortfolioHints(hintData, totalPortfolioValue);
        if (portfolioHintLines.length > 0) {
          text += "\n" + portfolioHintLines.join("\n");
        }

        // Next-step hints: Morpho looping opportunities + general follow-ups
        const nextSteps: string[] = [``, `--- Next Steps ---`];

        // Surface loopable positions with actionable tool calls
        const loopable = hintData.filter((h) => h.morphoAvailable === true && h.ptAddress);
        const notLoopable = hintData.filter((h) => h.morphoAvailable === false);
        if (loopable.length > 0) {
          nextSteps.push(`• Looping opportunities (Morpho market available):`);
          for (const h of loopable) {
            nextSteps.push(`    ${h.name}: get_looping_strategy(chain="${h.chain}", pt_address="${h.ptAddress}")`);
          }
        }
        if (notLoopable.length > 0) {
          nextSteps.push(`• No Morpho market for: ${notLoopable.map((h) => h.name).join(", ")} — can't loop these positions`);
          nextSteps.push(`    Alternative: compare_yield on these PTs for unleveraged spread analysis`);
        }

        // General follow-ups
        nextSteps.push(`• Activity analysis: get_pool_activity(chain=CHAIN, pool_address=POOL, address="${address}") for strategy inference`);
        nextSteps.push(`• Cross-pool scan: get_address_activity(address="${address}") for multi-pool overview`);

        text += nextSteps.join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching portfolio: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
