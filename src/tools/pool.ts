/**
 * Tools: get_pool_volume, get_pool_activity
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork } from "../config.js";
import { fetchSpectra } from "../api.js";
import { formatUsd, formatDate, formatActivityType } from "../formatters.js";

export function register(server: McpServer): void {
  // ===========================================================================
  // get_pool_volume
  // ===========================================================================

  server.tool(
    "get_pool_volume",
    `Get historical trading volume for a specific Spectra pool.
Returns timestamped buy/sell volume in USD. Use list_pools first to find pool addresses.
Useful for assessing pool activity and liquidity depth before entering a position.

Context: Volume alone doesn't indicate capital efficiency — $1M volume in a $5M liquidity
pool is very different from $1M in a $500K pool. Combine volume data with pool liquidity
(from list_pools or get_pt_details) to assess real trading conditions.

For individual transaction details and whale activity, use get_pool_activity instead.
Use quote_trade to estimate price impact for a specific trade size.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pool_address: EVM_ADDRESS.describe("The Curve pool contract address (0x...). This is the pool address, not the PT address -- use list_pools to find it."),
    },
    async ({ chain, pool_address }) => {
      try {
        const network = resolveNetwork(chain);
        const raw = await fetchSpectra(`/${network}/pools/${pool_address}/volume`) as any;
        const entries: Array<{ timestamp: number; buyUsd: number; sellUsd: number }> =
          Array.isArray(raw) ? raw : raw?.data || [];

        if (entries.length === 0) {
          return {
            content: [{ type: "text", text: `No volume data found for pool ${pool_address} on ${chain}. Verify this is a valid Curve pool address (not a PT address).` }],
          };
        }

        // Aggregate totals
        let totalBuy = 0;
        let totalSell = 0;
        for (const e of entries) {
          totalBuy += e.buyUsd || 0;
          totalSell += e.sellUsd || 0;
        }
        const totalVolume = totalBuy + totalSell;

        // Time range
        const first = entries[0];
        const last = entries[entries.length - 1];
        const rangeStart = formatDate(first.timestamp);
        const rangeEnd = formatDate(last.timestamp);
        const rangeDays = Math.max(1, Math.round((last.timestamp - first.timestamp) / 86400));

        // Recent activity: last 7 days
        const sevenDaysAgo = Date.now() / 1000 - 7 * 86400;
        let recentBuy = 0;
        let recentSell = 0;
        for (const e of entries) {
          if (e.timestamp >= sevenDaysAgo) {
            recentBuy += e.buyUsd || 0;
            recentSell += e.sellUsd || 0;
          }
        }
        const recentTotal = recentBuy + recentSell;

        // Non-zero activity days
        const activeDays = entries.filter((e) => (e.buyUsd || 0) > 0 || (e.sellUsd || 0) > 0).length;

        const lines = [
          `-- Pool Volume: ${pool_address.slice(0, 10)}...${pool_address.slice(-6)} --`,
          `  Chain: ${chain}`,
          `  Data Range: ${rangeStart} -> ${rangeEnd} (${rangeDays} days, ${entries.length} data points)`,
          ``,
          `  All-Time Volume:`,
          `    Buy:   ${formatUsd(totalBuy)}`,
          `    Sell:  ${formatUsd(totalSell)}`,
          `    Total: ${formatUsd(totalVolume)}`,
          `    Daily Avg: ${formatUsd(totalVolume / rangeDays)}`,
          ``,
          `  Last 7 Days:`,
          `    Buy:   ${formatUsd(recentBuy)}`,
          `    Sell:  ${formatUsd(recentSell)}`,
          `    Total: ${formatUsd(recentTotal)}`,
          ``,
          `  Activity: ${activeDays} active data points out of ${entries.length}`,
        ];

        // Show most recent non-zero entries (up to 5)
        const recentNonZero = entries
          .filter((e) => (e.buyUsd || 0) > 0 || (e.sellUsd || 0) > 0)
          .slice(-5);

        if (recentNonZero.length > 0) {
          lines.push(``);
          lines.push(`  Recent Trades:`);
          lines.push(`  ${"Date".padEnd(14)} ${"Buy".padEnd(16)} ${"Sell".padEnd(16)}`);
          lines.push(`  ${"--".repeat(23)}`);
          for (const e of recentNonZero) {
            lines.push(
              `  ${formatDate(e.timestamp).padEnd(14)} ${formatUsd(e.buyUsd || 0).padEnd(16)} ${formatUsd(e.sellUsd || 0).padEnd(16)}`
            );
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error fetching pool volume: ${e.message}` }], isError: true };
      }
    }
  );

  // ===========================================================================
  // get_pool_activity
  // ===========================================================================

  server.tool(
    "get_pool_activity",
    `Get recent trade and liquidity activity for a specific Spectra pool.
Returns individual transactions: buys, sells, and liquidity adds/removes with
USD values, timestamps, and tx hashes. Use list_pools first to find pool addresses.
Useful for monitoring trading patterns and whale activity.

CRITICAL: Pool activity only shows the Curve pool's perspective (IBT ↔ PT swaps and
LP events). It does NOT show the full picture of what users are doing. The Spectra
Router's execute() batches multiple operations atomically, so a single pool event
may be one step of a larger strategy that is invisible in the activity data.

Protocol mechanics that affect how activity appears:
- BUY_PT and SELL_PT are Curve pool swaps between IBT and PT.
- There is NO "BUY_YT" or "SELL_YT" type. The pool never touches YT directly.
- YT selling via the Router's flash-redeem internally buys PT from the pool to
  pair with YT for redemption — so YT sells show up as BUY_PT in the activity log.
- A standalone mint (deposit IBT → PT+YT) does NOT appear in pool activity.
  However, the Router can batch a mint + LP add in one atomic execute() call.
  The minted PT + remaining IBT enter the pool as AMM_ADD_LIQUIDITY while the
  minted YT goes directly to the user's wallet. So AMM_ADD_LIQUIDITY events
  may ALSO represent YT acquisition — the YT minting is invisible in pool data.
- The Router can also flash-mint atomically: flash-borrow IBT → mint PT+YT →
  sell PT on the pool → user tops up the shortfall → user receives YT. This
  shows up as SELL_PT but the user's net action is acquiring YT, not selling PT.
- AMM_REMOVE_LIQUIDITY returns IBT + PT from the pool. Users often follow up by
  selling the PT (SELL_PT) to recover capital, completing a mint→LP→remove→sell
  loop that nets them YT at the cost of the PT discount (~1 - ptPrice).

Key principle: any pool event type can be one step of a multi-step Router operation.
Do not assume SELL_PT means "user is bearish on PT" or AMM_ADD_LIQUIDITY means
"user is providing liquidity for yield." Always cross-reference with get_portfolio
to see what the address actually holds (PT, YT, LP balances) — the holdings reveal
the true strategy better than the activity log alone.

Analysis tips:
- If an address has high SELL_PT count but holds mostly YT → mint-and-sell loop
  (YT accumulation via PT discount). Check if YT balance >> PT balance.
- If an address has BUY_PT events → could be YT flash-redeem (selling YT).
  Check if their YT balance is low/zero relative to activity volume.
- If an address has paired ADD/REMOVE liquidity → likely cycling through LP as
  part of a mint loop, not long-term liquidity provision.
- Compare activity volume to current position size. Large activity volume with
  small current holdings = capital recycling (looping strategy).

Output includes an Address Concentration section with full addresses and per-address
type breakdowns. Use get_portfolio on those addresses to see their PT, YT, and LP
balances. Most analysis can be done without a block explorer — use get_portfolio on
addresses from Address Concentration, and compare_yield or get_pt_details for rate context.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pool_address: EVM_ADDRESS.describe("The Curve pool contract address (0x...). Use list_pools to find it."),
      type_filter: z
        .enum(["BUY_PT", "SELL_PT", "AMM_ADD_LIQUIDITY", "AMM_REMOVE_LIQUIDITY", "all"])
        .default("all")
        .describe("Filter by activity type. Default: all."),
      limit: z
        .number()
        .max(100)
        .default(20)
        .describe("Number of most recent activities to return (default 20, max 100)"),
    },
    async ({ chain, pool_address, type_filter, limit }) => {
      try {
        const network = resolveNetwork(chain);
        const raw = await fetchSpectra(`/${network}/pools/${pool_address}/activity`) as any;
        let entries: Array<{
          hash: string;
          timestamp: number;
          valueUsd: number;
          valueUnderlying: number;
          type: string;
          from: string;
        }> = Array.isArray(raw) ? raw : raw?.data || [];

        if (entries.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No activity found for pool ${pool_address} on ${chain}. Verify this is a valid Curve pool address (not a PT address).`,
            }],
          };
        }

        // Filter by type
        if (type_filter !== "all") {
          entries = entries.filter((e) => e.type === type_filter);
        }

        // Guard against empty array after filtering
        if (entries.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No ${formatActivityType(type_filter)} activity found for pool ${pool_address} on ${chain}. The pool has activity of other types -- try type_filter "all".`,
            }],
          };
        }

        // Sort by timestamp descending (most recent first)
        entries.sort((a, b) => b.timestamp - a.timestamp);

        // Clamp limit
        const clampedLimit = Math.min(Math.max(1, limit), 100);
        const shown = entries.slice(0, clampedLimit);

        // Aggregate stats across all (filtered) entries
        let totalValue = 0;
        const typeCounts: Record<string, { count: number; value: number }> = {};
        const addressStats: Record<string, { count: number; value: number; types: Record<string, number> }> = {};
        for (const e of entries) {
          totalValue += e.valueUsd || 0;
          const t = e.type;
          if (!typeCounts[t]) typeCounts[t] = { count: 0, value: 0 };
          typeCounts[t].count++;
          typeCounts[t].value += e.valueUsd || 0;

          const addr = e.from || "unknown";
          if (!addressStats[addr]) addressStats[addr] = { count: 0, value: 0, types: {} };
          addressStats[addr].count++;
          addressStats[addr].value += e.valueUsd || 0;
          addressStats[addr].types[t] = (addressStats[addr].types[t] || 0) + 1;
        }

        // Sort addresses by value descending
        const sortedAddrs = Object.entries(addressStats)
          .sort((a, b) => b[1].value - a[1].value);

        // Time range — safe now, entries is guaranteed non-empty
        const oldest = entries[entries.length - 1];
        const newest = entries[0];

        const lines = [
          `-- Pool Activity: ${pool_address.slice(0, 10)}...${pool_address.slice(-6)} --`,
          `  Chain: ${chain}`,
          `  Filter: ${type_filter === "all" ? "All types" : formatActivityType(type_filter)}`,
          `  Total Entries: ${entries.length}`,
          `  Time Range: ${formatDate(oldest.timestamp)} -> ${formatDate(newest.timestamp)}`,
          `  Total Value: ${formatUsd(totalValue)}`,
          ``,
          `  Breakdown by Type:`,
        ];

        for (const [t, stats] of Object.entries(typeCounts)) {
          lines.push(`    ${formatActivityType(t).padEnd(18)} ${String(stats.count).padEnd(6)} txns  ${formatUsd(stats.value)}`);
        }

        // Address concentration
        lines.push(``);
        lines.push(`  Address Concentration (${sortedAddrs.length} unique):`);
        const topAddrs = sortedAddrs.slice(0, 5);
        for (const [addr, stats] of topAddrs) {
          const pct = totalValue > 0 ? ((stats.value / totalValue) * 100).toFixed(1) : "0.0";
          lines.push(`    ${addr}  ${stats.count} txns  ${formatUsd(stats.value)} (${pct}%)`);
          // Per-address type breakdown
          const typeParts = Object.entries(stats.types)
            .sort((a, b) => b[1] - a[1])
            .map(([t, c]) => `${formatActivityType(t)}: ${c}`);
          if (typeParts.length > 0) {
            lines.push(`      ${typeParts.join("  ")}`);
          }

          // Pattern hints: flag activity that likely involves Router batching
          const sellPt = stats.types["SELL_PT"] || 0;
          const buyPt = stats.types["BUY_PT"] || 0;
          const addLiq = stats.types["AMM_ADD_LIQUIDITY"] || 0;
          const remLiq = stats.types["AMM_REMOVE_LIQUIDITY"] || 0;

          const hints: string[] = [];
          if (addLiq > 0 && (sellPt > 0 || remLiq > 0)) {
            hints.push("LP adds may include minted YT (Router batching)");
          }
          if (sellPt > 0 && buyPt === 0 && addLiq === 0) {
            hints.push("SELL_PT with no LP — could be flash-mint YT acquisition or simple PT selling");
          }
          if (buyPt > 0 && sellPt === 0 && addLiq === 0 && remLiq === 0) {
            hints.push("BUY_PT only — could be flash-redeem YT selling");
          } else if (buyPt > 0 && sellPt === 0) {
            hints.push("BUY_PT events may include flash-redeem YT sells");
          }
          if (hints.length > 0) {
            lines.push(`      ⚠ ${hints.join("; ")}. Use get_portfolio to check actual holdings.`);
          }
        }
        if (sortedAddrs.length > 5) {
          lines.push(`    ... and ${sortedAddrs.length - 5} more addresses`);
        }

        // Recent activity table
        lines.push(``);
        lines.push(`  Recent Activity (${shown.length} of ${entries.length}):`);
        lines.push(`  ${"Date".padEnd(12)} ${"Type".padEnd(18)} ${"Value (USD)".padEnd(16)} ${"From".padEnd(14)} ${"Tx Hash"}`);
        lines.push(`  ${"--".repeat(40)}`);

        for (const e of shown) {
          const date = formatDate(e.timestamp || 0);
          const actType = formatActivityType(e.type || "UNKNOWN");
          const value = formatUsd(e.valueUsd || 0);
          const from = e.from ? `${e.from.slice(0, 6)}...${e.from.slice(-4)}` : "unknown";
          const hash = e.hash ? `${e.hash.slice(0, 10)}...` : "unknown";
          lines.push(`  ${date.padEnd(12)} ${actType.padEnd(18)} ${value.padEnd(16)} ${from.padEnd(14)} ${hash}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error fetching pool activity: ${e.message}` }], isError: true };
      }
    }
  );
}
