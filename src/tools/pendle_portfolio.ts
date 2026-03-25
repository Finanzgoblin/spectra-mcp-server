/**
 * Tool: pendle_get_portfolio
 *
 * User portfolio viewer for Pendle positions across all chains.
 * The Pendle equivalent of spectra_get_portfolio.
 * Shows PT, YT, and LP balances with USD valuations per market.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES, EVM_ADDRESS } from "../config.js";
import { scanAllPendleUserPositions, fetchPendleUserPositions } from "../api.js";
import type { PendleUserPosition } from "../api.js";
import { formatPct, formatUsd, pendleDaysToMaturity } from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

function formatPendlePosition(pos: PendleUserPosition, rank: number): string {
  const lines: string[] = [];
  const days = pos.expiry ? pendleDaysToMaturity(pos.expiry) : 0;
  const expiryDate = pos.expiry ? pos.expiry.split("T")[0] : "N/A";
  const statusTag = pos.isExpired ? " [EXPIRED]" : "";

  lines.push(`  #${rank} ${pos.marketName}${statusTag} (${PENDLE_CHAIN_NAMES[pos.chain] || pos.chain})`);
  lines.push(`    Market: ${pos.marketAddress}`);
  lines.push(`    Maturity: ${expiryDate} (${days}d)`);

  // Balances
  const hasBalance = (b: number, v: number) => b > 0 || v > 0;

  if (hasBalance(pos.pt.balance, pos.pt.valueUsd)) {
    lines.push(`    PT: ${pos.pt.balance.toLocaleString("en-US", { maximumFractionDigits: 4 })} (${formatUsd(pos.pt.valueUsd)})`);
  }
  if (hasBalance(pos.yt.balance, pos.yt.valueUsd)) {
    lines.push(`    YT: ${pos.yt.balance.toLocaleString("en-US", { maximumFractionDigits: 4 })} (${formatUsd(pos.yt.valueUsd)})`);
  }
  if (hasBalance(pos.lp.balance, pos.lp.valueUsd)) {
    lines.push(`    LP: ${pos.lp.balance.toLocaleString("en-US", { maximumFractionDigits: 4 })} (${formatUsd(pos.lp.valueUsd)})`);
  }

  lines.push(`    Total Value: ${formatUsd(pos.totalValueUsd)}`);

  // APY info
  if (pos.impliedApy > 0) {
    lines.push(`    Implied APY: ${formatPct(pos.impliedApy * 100)}`);
  }
  if (pos.lpApy > 0) {
    lines.push(`    LP APY: ${formatPct(pos.lpApy * 100)}`);
  }

  // Strategy inference
  if (pos.yt.balance > 0 && pos.pt.balance === 0 && pos.lp.balance === 0) {
    lines.push(`    Strategy: Pure YT (variable yield bull)`);
  } else if (pos.pt.balance > 0 && pos.yt.balance === 0 && pos.lp.balance === 0) {
    lines.push(`    Strategy: Pure PT (fixed-rate lock)`);
  } else if (pos.lp.balance > 0) {
    lines.push(`    Strategy: LP${pos.yt.balance > 0 ? " + YT exposure" : ""}`);
  }

  // Warnings
  if (pos.isExpired) {
    lines.push(`    ⚠ Position expired — redeem to recover underlying`);
  } else if (days > 0 && days < 7) {
    lines.push(`    ⚠ Approaching maturity — plan rollover or redemption`);
  }

  return lines.join("\n");
}

export function register(server: McpServer): void {
  server.tool(
    "pendle_get_portfolio",
    `View a wallet's Pendle positions across all chains (or a specific chain).

Shows PT, YT, and LP token balances with USD valuations for each Pendle market
the wallet has positions in. Includes maturity dates, implied APY, LP APY,
strategy inference, and expiry warnings.

This is the Pendle equivalent of spectra_get_portfolio.

Use pendle_get_market_details to drill into a specific market.
Use mv_plan_rollover to plan rollovers for expiring positions.
Use spectra_get_portfolio for Spectra positions.`,
    {
      address: EVM_ADDRESS.describe("The wallet address to look up."),
      chain: PENDLE_CHAIN_ENUM.optional().describe(
        "Limit to a specific chain. Omit to scan all Pendle chains."
      ),
    },
    async ({ address, chain }) => {
      try {
        let positions: PendleUserPosition[];
        let failedChains: string[];

        if (chain) {
          const result = await fetchPendleUserPositions(chain, address);
          positions = result.positions;
          failedChains = result.available ? [] : [chain];
        } else {
          const result = await scanAllPendleUserPositions(address);
          positions = result.positions;
          failedChains = result.failedChains;
        }

        if (positions.length === 0 && failedChains.length === 0) {
          const scope = chain ? `on ${PENDLE_CHAIN_NAMES[chain] || chain}` : "across any Pendle chain";
          const text = [
            `No Pendle positions found for ${address} ${scope}.`,
            ``,
            `This could mean:`,
            `  - The wallet has no active Pendle positions`,
            `  - Positions are on a different chain`,
            `  - The Pendle API does not support position queries for this chain`,
            ``,
            `Use pendle_list_markets to browse available markets.`,
          ].join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        if (positions.length === 0 && failedChains.length > 0) {
          const text = [
            `⚠ Pendle portfolio endpoint unavailable for ${address}.`,
            `Failed chains: ${failedChains.join(", ")}`,
            ``,
            `The Pendle API /users/{address}/active-positions endpoint returns errors.`,
            `This is a KNOWN LIMITATION — the endpoint may be deprecated or unstable.`,
            ``,
            `Workaround: use pendle_list_markets to find markets, then check on-chain`,
            `PT/YT/LP token balances manually. The wallet's positions exist on-chain`,
            `even when this API endpoint doesn't respond.`,
          ].join("\n");
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Separate active and expired
        const active = positions.filter((p) => !p.isExpired);
        const expired = positions.filter((p) => p.isExpired);

        // Sort active by total value descending
        active.sort((a, b) => b.totalValueUsd - a.totalValueUsd);
        expired.sort((a, b) => b.totalValueUsd - a.totalValueUsd);

        const totalValueUsd = positions.reduce((s, p) => s + p.totalValueUsd, 0);
        const totalPtUsd = positions.reduce((s, p) => s + p.pt.valueUsd, 0);
        const totalYtUsd = positions.reduce((s, p) => s + p.yt.valueUsd, 0);
        const totalLpUsd = positions.reduce((s, p) => s + p.lp.valueUsd, 0);

        const lines: string[] = [];
        const scope = chain ? PENDLE_CHAIN_NAMES[chain] || chain : "All Chains";
        lines.push(`== Pendle Portfolio: ${scope} ==`);
        lines.push(`  Wallet: ${address}`);
        lines.push(`  Total Value: ${formatUsd(totalValueUsd)}`);
        lines.push(`  Breakdown: PT ${formatUsd(totalPtUsd)} | YT ${formatUsd(totalYtUsd)} | LP ${formatUsd(totalLpUsd)}`);
        lines.push(`  Positions: ${active.length} active${expired.length > 0 ? `, ${expired.length} expired` : ""}`);

        // Chain distribution
        const chainCounts = new Map<string, number>();
        for (const p of positions) {
          chainCounts.set(p.chain, (chainCounts.get(p.chain) || 0) + 1);
        }
        if (chainCounts.size > 1) {
          const chainDistrib = [...chainCounts.entries()]
            .map(([c, n]) => `${PENDLE_CHAIN_NAMES[c] || c}: ${n}`)
            .join(", ");
          lines.push(`  Chain distribution: ${chainDistrib}`);
        }
        lines.push(``);

        // Active positions
        if (active.length > 0) {
          lines.push(`--- Active Positions (${active.length}) ---`);
          for (let i = 0; i < active.length; i++) {
            lines.push(formatPendlePosition(active[i], i + 1));
            lines.push(``);
          }
        }

        // Expired positions
        if (expired.length > 0) {
          lines.push(`--- Expired Positions (${expired.length}) ---`);
          for (let i = 0; i < expired.length; i++) {
            lines.push(formatPendlePosition(expired[i], i + 1));
            lines.push(``);
          }
        }

        // Portfolio-level interpretation when multiple active positions exist
        if (active.length >= 2) {
          // Check for maturity spread pattern
          const maturities = active
            .filter(p => p.expiry && !p.isExpired)
            .map(p => pendleDaysToMaturity(p.expiry!))
            .filter(d => d > 0)
            .sort((a, b) => a - b);

          if (maturities.length >= 2) {
            const spread = maturities[maturities.length - 1] - maturities[0];
            const gaps = maturities.slice(1).map((d, i) => d - maturities[i]);
            const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
            const gapVariance = gaps.reduce((s, g) => s + Math.pow(g - avgGap, 2), 0) / gaps.length;
            const isRegular = gapVariance < avgGap * avgGap * 0.5; // roughly even spacing

            lines.push(`--- Position Interpretation ---`);
            if (maturities.length >= 3 && isRegular && spread > 30) {
              lines.push(`  Maturity pattern: Ladder-like (${maturities.length} maturities, ~${Math.round(avgGap)}d spacing, ${spread}d total spread)`);
              lines.push(`  This could indicate intentional duration management — rolling exposure across`);
              lines.push(`  maturities to smooth rollover risk and capture the term structure.`);
            } else if (spread < 14) {
              lines.push(`  Maturity pattern: Clustered (all within ${spread}d of each other)`);
              lines.push(`  Concentrated maturity exposure — all positions roll over simultaneously,`);
              lines.push(`  creating a reinvestment cliff. This could be intentional (conviction trade)`);
              lines.push(`  or accidental (entered all at once without maturity diversification).`);
            } else {
              lines.push(`  Maturity pattern: Scattered (${maturities.length} maturities, ${spread}d range, irregular spacing)`);
              lines.push(`  Positions entered at different times rather than structured as a maturity ladder.`);
            }
            lines.push(``);
          }

          // Check for protocol-level concentration
          const chainValues = new Map<string, number>();
          for (const p of active) {
            chainValues.set(p.chain, (chainValues.get(p.chain) || 0) + p.totalValueUsd);
          }
          const activeTotal = active.reduce((s, p) => s + p.totalValueUsd, 0);
          if (chainValues.size >= 2 && activeTotal > 0) {
            const maxChainValue = Math.max(...chainValues.values());
            const maxChainPct = (maxChainValue / activeTotal) * 100;
            if (maxChainPct > 80) {
              const maxChain = [...chainValues.entries()].find(([, v]) => v === maxChainValue)?.[0] || "";
              lines.push(`  Chain concentration: ${formatPct(maxChainPct)} on ${PENDLE_CHAIN_NAMES[maxChain] || maxChain}`);
              lines.push(``);
            }
          }
        }

        if (failedChains.length > 0) {
          lines.push(`  Note: Could not fetch positions from: ${failedChains.join(", ")}`);
          lines.push(``);
        }

        lines.push(`--- Next Steps ---`);
        lines.push(`  • Market detail: pendle_get_market_details(chain=CHAIN, market_address=ADDR)`);
        lines.push(`  • Spectra positions: spectra_get_portfolio(chain=CHAIN, address="${address}")`);
        lines.push(`  • Rollover planning: mv_plan_rollover(chain=CHAIN, metavault_address=ADDR)`);
        lines.push(`  • IBT health: mv_check_ibt_health(chain=CHAIN, ibt_address=SY_ADDR)`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
