/**
 * Tool: get_portfolio
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CHAIN_ENUM, EVM_ADDRESS, API_NETWORKS, SUPPORTED_CHAINS, resolveNetwork } from "../config.js";
import type { SpectraPt, MerklTokenReward, MerklChainRewards } from "../types.js";
import { fetchSpectra, findMorphoMarketsForPts, fetchMerkl, parseMerklRewards } from "../api.js";
import { formatUsd, formatPositionSummary, formatPortfolioHints, formatMerklRewards, formatUnmatchedMerklRewards, daysToMaturity, formatBalance } from "../formatters.js";
import type { SpectraPool } from "../types.js";

export function register(server: McpServer): void {
  server.tool(
    "get_portfolio",
    `Get wallet positions on Spectra for a specific address.
Returns PT, YT, and LP balances with USD values, claimable yield,
and current rates. Queries a single chain or all chains.
Use this to understand what a wallet currently holds on Spectra.

Also fetches unclaimed Merkl rewards (SPECTRA gauge emissions and other
incentive programs) per position. Merkl rewards are best-effort — if the
Merkl API is unavailable, the portfolio still displays without reward data.

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
    },
    async ({ address, chain }) => {
      try {
        const networks = chain
          ? [resolveNetwork(chain)]
          : API_NETWORKS;

        type Position = { pos: SpectraPt; chain: string };
        const failedChains: string[] = [];
        const merklFailedChains: string[] = [];

        // Fire portfolio + Merkl fetches in parallel (no added latency)
        const [portfolioResults, merklSettled] = await Promise.all([
          Promise.allSettled(
            networks.map(async (net): Promise<Position[]> => {
              const raw = await fetchSpectra(`/${net}/portfolio/${address}`) as any;
              const items = Array.isArray(raw) ? raw : raw?.data || [];
              return items.map((pos: SpectraPt) => ({ pos, chain: net }));
            })
          ),
          Promise.allSettled(
            networks.map(async (net): Promise<{ chain: string; raw: Record<string, any> }> => {
              const chainInfo = SUPPORTED_CHAINS[net];
              if (!chainInfo) return { chain: net, raw: {} };
              const raw = await fetchMerkl(address, chainInfo.id);
              return { chain: net, raw };
            })
          ),
        ]);

        // Collect portfolio results and track which chains failed
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

        // Build set of known pool addresses for Merkl matching
        const knownPoolAddresses = new Set<string>();
        for (const { pos } of allPositions) {
          for (const pool of pos.pools || []) {
            if (pool.address) knownPoolAddresses.add(pool.address.toLowerCase());
          }
        }

        // Parse Merkl rewards and match to portfolio positions
        const merklByChain: MerklChainRewards[] = [];
        merklSettled.forEach((result, i) => {
          if (result.status === "fulfilled") {
            const { raw, chain: c } = result.value;
            if (Object.keys(raw).length > 0) {
              merklByChain.push(parseMerklRewards(raw, knownPoolAddresses, c));
            }
          } else {
            merklFailedChains.push(networks[i]);
          }
        });

        // Build unified lookup: poolAddress -> MerklTokenReward[]
        const merklByPool = new Map<string, MerklTokenReward[]>();
        for (const chainRewards of merklByChain) {
          for (const [poolAddr, rewards] of chainRewards.matched) {
            const existing = merklByPool.get(poolAddr);
            if (existing) {
              existing.push(...rewards);
            } else {
              merklByPool.set(poolAddr, [...rewards]);
            }
          }
        }

        const merklWarning = merklFailedChains.length > 0
          ? `\nNote: Merkl rewards unavailable for ${merklFailedChains.join(", ")}. Reward totals may be incomplete.\n`
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

        const morphoAvailability = new Map<string, boolean>();
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
              morphoAvailability.set(addr.toLowerCase(), markets.has(addr.toLowerCase()));
            }
          }
          // On failure: ptAddrs stay absent from map → morphoAvailable remains undefined
        }

        for (const { pos, chain: c } of allPositions) {
          const result = formatPositionSummary(pos, c);
          if (result) {
            // Append Merkl rewards if any exist for this position's pool
            let positionText = result.text;
            const poolAddr = pos.pools?.[0]?.address?.toLowerCase();
            if (poolAddr) {
              const merklRewards = merklByPool.get(poolAddr);
              if (merklRewards && merklRewards.length > 0) {
                const rewardLines = formatMerklRewards(merklRewards);
                if (rewardLines.length > 0) {
                  positionText += "\n" + rewardLines.join("\n");
                }
              }
            }
            summaries.push(positionText);
            totalPortfolioValue += result.totalValue;
            // Collect data for portfolio-level hints
            const decimals = pos.decimals ?? 18;
            const ptAddrLower = pos.address.toLowerCase();
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
              morphoAvailable: morphoAvailability.get(ptAddrLower),
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
        let text = header + chainWarning + merklWarning + "\n" + summaries.join("\n\n");

        // Layer 3: Portfolio-level hints for multi-position portfolios
        const portfolioHintLines = formatPortfolioHints(hintData, totalPortfolioValue);
        if (portfolioHintLines.length > 0) {
          text += "\n" + portfolioHintLines.join("\n");
        }

        // Unmatched Merkl rewards (from exited positions)
        const unmatchedByChain = merklByChain
          .filter(c => c.unmatched.length > 0)
          .map(c => ({ chain: c.chain, rewards: c.unmatched }));
        const unmatchedText = formatUnmatchedMerklRewards(unmatchedByChain);
        if (unmatchedText) {
          text += unmatchedText;
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
