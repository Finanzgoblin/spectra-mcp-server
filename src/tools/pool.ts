/**
 * Tools: get_pool_volume, get_pool_activity
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork, API_NETWORKS, CHAIN_GAS_ESTIMATES } from "../config.js";
import type { SpectraPt } from "../types.js";
import { fetchSpectra, fetchAddressType } from "../api.js";
import { formatUsd, formatDate, formatActivityType, parsePtResponse, detectActivityCycles, formatCycleAnalysis, formatFlowAccounting, formatBalance, formatVolumeHints } from "../formatters.js";

/**
 * Resolve a PT address to its Curve pool address.
 * Fetches the PT details and extracts the first pool's address.
 * Returns null if the PT has no pools or doesn't exist.
 */
async function resolvePoolAddressFromPt(network: string, address: string): Promise<string | null> {
  try {
    const data = await fetchSpectra(`/${network}/pt/${address}`) as any;
    const pt = parsePtResponse(data);
    if (!pt?.pools?.[0]?.address) return null;
    return pt.pools[0].address;
  } catch {
    return null;
  }
}

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

Output includes volume/liquidity ratio analysis when pool data is available. For
individual transaction details and whale activity, use get_pool_activity instead.
Use quote_trade to estimate price impact for a specific trade size.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pool_address: EVM_ADDRESS.describe("The Curve pool address (0x...) OR a PT address. If a PT address is given, it will be resolved to the corresponding pool automatically."),
    },
    async ({ chain, pool_address }) => {
      try {
        const network = resolveNetwork(chain);
        let effectivePoolAddr = pool_address;
        let raw = await fetchSpectra(`/${network}/pools/${effectivePoolAddr}/volume`) as any;
        let entries: Array<{ timestamp: number; buyUsd: number; sellUsd: number }> =
          Array.isArray(raw) ? raw : raw?.data || [];

        // If empty, the address might be a PT address — try resolving
        if (entries.length === 0) {
          const resolved = await resolvePoolAddressFromPt(network, pool_address);
          if (resolved && resolved.toLowerCase() !== pool_address.toLowerCase()) {
            effectivePoolAddr = resolved;
            raw = await fetchSpectra(`/${network}/pools/${effectivePoolAddr}/volume`) as any;
            entries = Array.isArray(raw) ? raw : raw?.data || [];
          }
        }

        if (entries.length === 0) {
          const text = `No volume data found for ${pool_address} on ${chain}. Verify this is a valid Curve pool or PT address.`;
          return { content: [{ type: "text" as const, text }] };
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

        const resolvedNote = effectivePoolAddr.toLowerCase() !== pool_address.toLowerCase()
          ? `  (Resolved from PT: ${pool_address})\n` : "";
        const lines = [
          `-- Pool Volume: ${effectivePoolAddr.slice(0, 10)}...${effectivePoolAddr.slice(-6)} --`,
          `  Chain: ${chain}`,
          ...(resolvedNote ? [resolvedNote.trimEnd()] : []),
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

        // Layer 3: Volume context hints (best-effort liquidity fetch)
        try {
          const ptData = await fetchSpectra(`/${network}/pt/${pool_address}`).catch(() => null) as any;
          const ptParsed = ptData ? parsePtResponse(ptData) : null;
          const poolLiq = ptParsed?.pools?.[0]?.liquidity?.usd || 0;

          const volumeHints = formatVolumeHints({
            totalVolume,
            totalBuy,
            totalSell,
            recentTotal,
            recentBuy,
            recentSell,
            rangeDays,
            poolLiquidityUsd: poolLiq > 0 ? poolLiq : undefined,
          });
          lines.push(...volumeHints);
        } catch {
          // Best-effort: swallow errors, don't block core output
        }

        // Next-step hints
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`• Individual trades: get_pool_activity(chain="${chain}", pool_address="${effectivePoolAddr}") for transaction-level detail`);
        lines.push(`• Quote a trade: quote_trade(chain="${chain}", pt_address="${pool_address}", amount=YOUR_AMOUNT, side="buy") to estimate entry cost`);
        lines.push(`• Pool details: get_pt_details(chain="${chain}", pt_address="${pool_address}") for APY, maturity, and yield data`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching pool volume: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
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
USD values, timestamps, and tx hashes.

Pool activity shows only the Curve pool's perspective (IBT ↔ PT swaps and LP
events). The Spectra Router batches operations atomically, so any single pool
event may be one step of a multi-step strategy. There is no BUY_YT or SELL_YT
event type — the pool never touches YT directly. Use get_protocol_context for
the full mechanics of how Router batching maps to pool activity types.

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
addresses from Address Concentration, and compare_yield or get_pt_details for rate context.

Address isolation mode: When you provide an 'address' parameter, the tool filters to that
address only, sorts chronologically (oldest first), and adds:
- Sequence Analysis: detects repeating action cycles (e.g., ADD→REMOVE→SELL repeated 8×)
  that reveal looping strategies. Uses "could be" language — cycles are structural patterns,
  not conclusions about intent.
- Capital Efficiency: compares total activity volume against the address's throughput,
  flagging high ratios that indicate capital recycling (looping) vs accumulation.
- If the address shows high-frequency activity (>10 txns), consider checking whether it is
  a contract (programmatic execution via Router execute()) vs an EOA (manual/scripted).
  Contracts execute atomically; EOAs submit separate transactions. This distinction affects
  whether apparent "sequences" are truly sequential or batched.
- Flow Accounting: automatically cross-references portfolio data to infer invisible mints
  and show PT/YT flow reconciliation. Compares YT holdings vs PT sell volume.
- Contract Detection: checks whether the address is a contract or EOA via on-chain
  eth_getCode. Contracts execute atomically; EOAs submit sequential transactions.
- Pool Impact: flags when SELL_PT or BUY_PT volume is significant relative to pool
  liquidity, indicating potential market impact on implied APY.
- Gas Estimates: estimates total gas cost from transaction count using chain-specific
  gas heuristics. Shows gas as percentage of activity volume and position value.
- Pool Context: fetches pool liquidity and implied APY for baseline context.

For multi-pool activity scanning, use get_address_activity to find all pools an address
has interacted with in a single call.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pool_address: EVM_ADDRESS.describe("The Curve pool address (0x...) OR a PT address. If a PT address is given, it will be resolved to the corresponding pool automatically."),
      type_filter: z
        .enum(["BUY_PT", "SELL_PT", "AMM_ADD_LIQUIDITY", "AMM_REMOVE_LIQUIDITY", "all"])
        .default("all")
        .describe("Filter by activity type. Default: all."),
      limit: z
        .number()
        .max(100)
        .default(20)
        .describe("Number of most recent activities to return (default 20, max 100)"),
      address: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .optional()
        .describe("Filter to a specific wallet address. Enables chronological sort, sequence analysis, and capital efficiency hints."),
    },
    async ({ chain, pool_address, type_filter, limit, address }) => {
      try {
        const network = resolveNetwork(chain);
        let effectivePoolAddr = pool_address;
        let raw = await fetchSpectra(`/${network}/pools/${effectivePoolAddr}/activity`) as any;
        let entries: Array<{
          hash: string;
          timestamp: number;
          valueUsd: number;
          valueUnderlying: number;
          type: string;
          from: string;
        }> = Array.isArray(raw) ? raw : raw?.data || [];

        // If empty, the address might be a PT address — try resolving
        if (entries.length === 0) {
          const resolved = await resolvePoolAddressFromPt(network, pool_address);
          if (resolved && resolved.toLowerCase() !== pool_address.toLowerCase()) {
            effectivePoolAddr = resolved;
            raw = await fetchSpectra(`/${network}/pools/${effectivePoolAddr}/activity`) as any;
            entries = Array.isArray(raw) ? raw : raw?.data || [];
          }
        }

        if (entries.length === 0) {
          const text = `No activity found for ${pool_address} on ${chain}. Verify this is a valid Curve pool or PT address.`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Filter by address (before type filter, so we get full picture for cycle detection)
        const addressFilter = address?.toLowerCase();
        if (addressFilter) {
          entries = entries.filter((e) => (e.from || "").toLowerCase() === addressFilter);
        }

        // Filter by type
        if (type_filter !== "all") {
          entries = entries.filter((e) => e.type === type_filter);
        }

        // Guard against empty array after filtering
        if (entries.length === 0) {
          const filterDesc = addressFilter
            ? `address ${address} with ${type_filter === "all" ? "any" : formatActivityType(type_filter)} activity`
            : `${formatActivityType(type_filter)} activity`;
          const addressHint = addressFilter
            ? `No visible pool activity for ${address} on this pool. ` +
              `This address may have entered via Spectra Router (atomic mint + LP), which is invisible in pool activity data. ` +
              `Use get_portfolio to verify holdings, or get_address_activity to scan all pools.`
            : `The pool may have activity of other types -- try type_filter "all".`;
          return {
            content: [{
              type: "text" as const,
              text: `No ${filterDesc} found for pool ${pool_address} on ${chain}. ${addressHint}`,
            }],
          };
        }

        // Sort: chronological (oldest first) for address mode, reverse-chron for pool-wide
        if (addressFilter) {
          entries.sort((a, b) => a.timestamp - b.timestamp);
        } else {
          entries.sort((a, b) => b.timestamp - a.timestamp);
        }

        // Clamp limit
        const clampedLimit = Math.min(Math.max(1, limit), 100);
        const shown = entries.slice(addressFilter ? Math.max(0, entries.length - clampedLimit) : 0, addressFilter ? entries.length : clampedLimit);

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
        // After chrono sort (address mode): [0]=oldest, [len-1]=newest
        // After reverse-chron sort (pool mode): [0]=newest, [len-1]=oldest
        const firstTs = Math.min(entries[0].timestamp, entries[entries.length - 1].timestamp);
        const lastTs = Math.max(entries[0].timestamp, entries[entries.length - 1].timestamp);

        const resolvedNote = effectivePoolAddr.toLowerCase() !== pool_address.toLowerCase()
          ? `  (Resolved from PT: ${pool_address})` : "";
        const lines = [
          `-- Pool Activity: ${effectivePoolAddr.slice(0, 10)}...${effectivePoolAddr.slice(-6)} --`,
          `  Chain: ${chain}`,
          ...(resolvedNote ? [resolvedNote] : []),
          ...(addressFilter ? [`  Address: ${address}`] : []),
          `  Filter: ${type_filter === "all" ? "All types" : formatActivityType(type_filter)}`,
          `  Total Entries: ${entries.length}`,
          `  Time Range: ${formatDate(firstTs)} -> ${formatDate(lastTs)}`,
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

        // === Address-specific analysis (only in address-filter mode) ===
        if (addressFilter && type_filter === "all") {

          // -------------------------------------------------------
          // Parallel fetch: pool context + portfolio + address type
          // -------------------------------------------------------
          let poolLiquidityUsd = 0;
          let poolData: any = null;
          let portfolioPositions: any[] = [];
          let addressType: "contract" | "eoa" | "unknown" = "unknown";

          const [poolResult, portfolioResult, addrTypeResult] = await Promise.allSettled([
            fetchSpectra(`/${network}/pt/${pool_address}`).catch(() => null),
            fetchSpectra(`/${network}/portfolio/${address}`).catch(() => null),
            fetchAddressType(address!, network),
          ]);

          // Extract pool context (Feature 6)
          if (poolResult.status === "fulfilled" && poolResult.value) {
            const ptRaw = poolResult.value as any;
            const pt = ptRaw?.data || ptRaw;
            if (pt?.pools?.[0]) {
              poolData = pt;
              poolLiquidityUsd = pt.pools[0].liquidity?.usd || 0;
            }
          }

          // Extract portfolio (Feature 2)
          if (portfolioResult.status === "fulfilled" && portfolioResult.value) {
            const raw = portfolioResult.value as any;
            portfolioPositions = Array.isArray(raw) ? raw : raw?.data || [];
          }

          // Extract address type (Feature 1)
          if (addrTypeResult.status === "fulfilled") {
            addressType = addrTypeResult.value;
          }

          // -------------------------------------------------------
          // Feature 6: Pool Context
          // -------------------------------------------------------
          if (poolLiquidityUsd > 0) {
            lines.push(``);
            lines.push(`  Pool Context:`);
            lines.push(`    Pool Liquidity: ${formatUsd(poolLiquidityUsd)}`);
            if (poolData?.pools?.[0]?.impliedApy != null) {
              lines.push(`    Implied APY: ${poolData.pools[0].impliedApy.toFixed(2)}%`);
            }
          }

          // -------------------------------------------------------
          // Sequence / Cycle Detection (existing)
          // -------------------------------------------------------
          const cycleResult = detectActivityCycles(entries);
          if (cycleResult) {
            lines.push(``);
            lines.push(...formatCycleAnalysis(cycleResult, totalValue));
          }

          // -------------------------------------------------------
          // Feature 2: Flow Accounting (portfolio cross-reference)
          // -------------------------------------------------------
          let ytBalance = 0;
          let ptBalance = 0;
          let lpBalance = 0;
          let portfolioFetched = false;

          if (portfolioPositions.length > 0) {
            const poolAddrLower = pool_address.toLowerCase();
            for (const pos of portfolioPositions) {
              const ptAddr = (pos.address || "").toLowerCase();
              const posPoolAddr = (pos.pools?.[0]?.address || "").toLowerCase();
              if (ptAddr === poolAddrLower || posPoolAddr === poolAddrLower) {
                const decimals = pos.decimals ?? 18;
                ptBalance = formatBalance(pos.balance, decimals);
                ytBalance = formatBalance(pos.yt?.balance, pos.yt?.decimals ?? decimals);
                lpBalance = pos.pools?.reduce((sum: number, p: any) => {
                  return sum + formatBalance(p.lpt?.balance, p.lpt?.decimals ?? 18);
                }, 0) || 0;
                portfolioFetched = true;
                break;
              }
            }
          }

          if (portfolioFetched) {
            const ptPriceUsd = poolData?.pools?.[0]?.ptPrice?.usd || 0;
            const ytPriceUsd = poolData?.pools?.[0]?.ytPrice?.usd || 0;

            const flowLines = formatFlowAccounting({
              ytBalance,
              ptBalance,
              lpBalance,
              ptSellCount: typeCounts["SELL_PT"]?.count || 0,
              ptSellVolumeUsd: typeCounts["SELL_PT"]?.value || 0,
              addLiqCount: typeCounts["AMM_ADD_LIQUIDITY"]?.count || 0,
              addLiqVolumeUsd: typeCounts["AMM_ADD_LIQUIDITY"]?.value || 0,
              buyPtCount: typeCounts["BUY_PT"]?.count || 0,
              buyPtVolumeUsd: typeCounts["BUY_PT"]?.value || 0,
              removeLiqCount: typeCounts["AMM_REMOVE_LIQUIDITY"]?.count || 0,
              removeLiqVolumeUsd: typeCounts["AMM_REMOVE_LIQUIDITY"]?.value || 0,
              ptPriceUsd,
              ytPriceUsd,
            });
            lines.push(``);
            lines.push(...flowLines);
          }

          // -------------------------------------------------------
          // Capital Efficiency (existing, enhanced)
          // -------------------------------------------------------
          lines.push(``);
          lines.push(`  Capital Efficiency:`);
          lines.push(`    Total Activity Volume: ${formatUsd(totalValue)} across ${entries.length} txns`);
          const activeDays = new Set(entries.map(e => formatDate(e.timestamp))).size;
          lines.push(`    Active Days: ${activeDays} | Avg Txns/Day: ${(entries.length / Math.max(1, activeDays)).toFixed(1)}`);

          // -------------------------------------------------------
          // Feature 4: PT Sell Volume vs Pool Liquidity Warning
          // -------------------------------------------------------
          if (poolLiquidityUsd > 0) {
            const sellPtValue = typeCounts["SELL_PT"]?.value || 0;
            if (sellPtValue > 0) {
              const sellPctOfLiq = (sellPtValue / poolLiquidityUsd) * 100;
              if (sellPctOfLiq > 5) {
                lines.push(`    ⚠ SELL_PT volume (${formatUsd(sellPtValue)}) represents ${sellPctOfLiq.toFixed(1)}% of pool liquidity (${formatUsd(poolLiquidityUsd)}). This address's activity may have materially impacted implied APY.`);
              } else if (sellPctOfLiq > 1) {
                lines.push(`    Note: SELL_PT volume is ${sellPctOfLiq.toFixed(1)}% of pool liquidity — modest relative to pool size.`);
              }
            }
            const buyPtValue = typeCounts["BUY_PT"]?.value || 0;
            if (buyPtValue > 0) {
              const buyPctOfLiq = (buyPtValue / poolLiquidityUsd) * 100;
              if (buyPctOfLiq > 5) {
                lines.push(`    ⚠ BUY_PT volume (${formatUsd(buyPtValue)}) represents ${buyPctOfLiq.toFixed(1)}% of pool liquidity. This address's activity may have materially impacted PT price.`);
              }
            }
          }

          // -------------------------------------------------------
          // Feature 5: Gas Cost Heuristic
          // -------------------------------------------------------
          const gasPerTxn = CHAIN_GAS_ESTIMATES[network] || 0;
          if (gasPerTxn > 0 && entries.length > 0) {
            const estimatedGas = entries.length * gasPerTxn;
            lines.push(`    Estimated Gas: ~${entries.length} txns x ~${formatUsd(gasPerTxn)}/txn = ~${formatUsd(estimatedGas)}`);
            if (totalValue > 0) {
              const gasPct = (estimatedGas / totalValue) * 100;
              lines.push(`      Gas as % of activity volume: ~${gasPct.toFixed(2)}%`);
              if (gasPct > 5) {
                lines.push(`      ⚠ Gas costs may significantly erode profitability at this activity level.`);
              }
            }
            // If portfolio is available, show gas as % of position
            if (portfolioFetched) {
              const ptPriceUsd = poolData?.pools?.[0]?.ptPrice?.usd || 0;
              const ytPriceUsd = poolData?.pools?.[0]?.ytPrice?.usd || 0;
              const positionValue = ptBalance * ptPriceUsd + ytBalance * ytPriceUsd;
              if (positionValue > 0) {
                const gasPctOfPosition = (estimatedGas / positionValue) * 100;
                lines.push(`      Gas as % of current position (${formatUsd(positionValue)}): ~${gasPctOfPosition.toFixed(2)}%`);
              }
            }
          }

          // -------------------------------------------------------
          // Feature 1: Contract vs EOA Detection
          // -------------------------------------------------------
          if (addressType === "contract") {
            lines.push(`    Address Type: Contract (deployed code detected — executes atomically via Router)`);
            lines.push(`      Apparent "sequences" in activity may be batched into single atomic transactions.`);
          } else if (addressType === "eoa") {
            lines.push(`    Address Type: EOA (no contract code — submits individual transactions)`);
            lines.push(`      Activity sequences represent separate on-chain transactions.`);
          } else {
            lines.push(`    Address Type: Unknown (RPC unavailable for ${chain})`);
          }

          // High-frequency hint (existing, enhanced)
          if (entries.length > 10) {
            lines.push(`    ⚠ High-frequency pattern (${entries.length} txns). Cross-reference with get_portfolio to see resulting PT/YT/LP balances.`);
          }
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

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching pool activity: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // get_address_activity
  // ===========================================================================

  server.tool(
    "get_address_activity",
    `Scan all pools on a chain (or all chains) for a given address's activity.
Returns per-pool breakdown and cross-pool aggregates. Useful for discovering
multi-pool strategies without making N manual get_pool_activity calls.

When investigating a wallet that operates across multiple pools (e.g., a curator
or yield farmer diversifying across maturities), this tool reveals the full scope
of their on-chain activity in one call.

Each pool's activity is summarized with type breakdown and total volume.
Cross-pool totals show the address's aggregate engagement with Spectra.

For deep per-pool analysis (cycle detection, flow accounting, contract detection),
use get_pool_activity with the address parameter on the specific pool of interest.
Use get_portfolio to see current holdings across all pools.`,
    {
      address: EVM_ADDRESS.describe("The wallet address to scan (0x...)"),
      chain: CHAIN_ENUM
        .optional()
        .describe("Specific chain to scan. Omit to scan all chains (slower)."),
      min_volume_usd: z
        .number()
        .default(0)
        .describe("Minimum activity volume (USD) per pool to include in results (default 0)"),
    },
    async ({ address, chain, min_volume_usd }) => {
      try {
        const networks = chain
          ? [resolveNetwork(chain)]
          : API_NETWORKS;

        const addressLower = address.toLowerCase();

        interface PoolActivity {
          chain: string;
          poolAddress: string;
          ptName: string;
          ptAddress: string;
          totalValueUsd: number;
          txnCount: number;
          typeCounts: Record<string, { count: number; value: number }>;
        }

        const allPoolActivities: PoolActivity[] = [];
        const failedChains: string[] = [];

        // Phase 1: Fetch all pools per chain, then activity per pool — parallel within each chain
        const chainResults = await Promise.allSettled(
          networks.map(async (net): Promise<PoolActivity[]> => {
            // Get all pools on this chain
            const raw = await fetchSpectra(`/${net}/pools`) as any;
            const pts: any[] = Array.isArray(raw) ? raw : raw?.data || [];
            if (!Array.isArray(pts)) return [];

            // Collect unique pool addresses
            const poolEntries: Array<{ poolAddr: string; ptName: string; ptAddr: string }> = [];
            for (const pt of pts) {
              for (const pool of (pt.pools || [])) {
                if (pool.address) {
                  poolEntries.push({
                    poolAddr: pool.address,
                    ptName: pt.name || "Unknown PT",
                    ptAddr: pt.address || "",
                  });
                }
              }
            }

            // Fetch activity for each pool in batches (max 10 concurrent)
            const batchSize = 10;
            const results: PoolActivity[] = [];

            for (let i = 0; i < poolEntries.length; i += batchSize) {
              const batch = poolEntries.slice(i, i + batchSize);
              const batchResults = await Promise.allSettled(
                batch.map(async ({ poolAddr, ptName, ptAddr }) => {
                  const actRaw = await fetchSpectra(`/${net}/pools/${poolAddr}/activity`) as any;
                  const allEntries: any[] = Array.isArray(actRaw) ? actRaw : actRaw?.data || [];

                  // Filter for this address
                  const filtered = allEntries.filter(
                    (e: any) => (e.from || "").toLowerCase() === addressLower
                  );

                  if (filtered.length === 0) return null;

                  // Aggregate
                  let totalVal = 0;
                  const types: Record<string, { count: number; value: number }> = {};
                  for (const e of filtered) {
                    const val = e.valueUsd || 0;
                    totalVal += val;
                    if (!types[e.type]) types[e.type] = { count: 0, value: 0 };
                    types[e.type].count++;
                    types[e.type].value += val;
                  }

                  if (totalVal < min_volume_usd) return null;

                  const txnCount = filtered.length;

                  return {
                    chain: net,
                    poolAddress: poolAddr,
                    ptName,
                    ptAddress: ptAddr,
                    totalValueUsd: totalVal,
                    txnCount,
                    typeCounts: types,
                  } satisfies PoolActivity;
                })
              );

              for (const r of batchResults) {
                if (r.status === "fulfilled" && r.value) {
                  results.push(r.value);
                }
              }
            }

            return results;
          })
        );

        // Collect results
        chainResults.forEach((result, i) => {
          if (result.status === "fulfilled") {
            allPoolActivities.push(...result.value);
          } else {
            failedChains.push(networks[i]);
          }
        });

        if (allPoolActivities.length === 0) {
          const scope = chain || "all chains";
          return {
            content: [{
              type: "text",
              text: `No pool activity found for ${address} on ${scope}.${
                failedChains.length > 0 ? ` (${failedChains.length} chain(s) failed: ${failedChains.join(", ")})` : ""
              }`,
            }],
          };
        }

        // Sort by total value descending
        allPoolActivities.sort((a, b) => b.totalValueUsd - a.totalValueUsd);

        // Format output
        const crossPoolTotals: Record<string, { count: number; value: number }> = {};
        let grandTotal = 0;
        let totalTxns = 0;

        const lines: string[] = [
          `-- Address Activity Scan: ${address} --`,
          `  Scope: ${chain || "all chains"}`,
          `  Pools with Activity: ${allPoolActivities.length}`,
        ];

        if (failedChains.length > 0) {
          lines.push(`  Note: ${failedChains.length} chain(s) failed (${failedChains.join(", ")})`);
        }
        lines.push(``);

        for (const pa of allPoolActivities) {
          grandTotal += pa.totalValueUsd;
          totalTxns += pa.txnCount;

          lines.push(`  ${pa.ptName} (${pa.chain})`);
          lines.push(`    Pool: ${pa.poolAddress}`);
          lines.push(`    PT: ${pa.ptAddress}`);
          lines.push(`    Volume: ${formatUsd(pa.totalValueUsd)} across ${pa.txnCount} txns`);

          const typeParts = Object.entries(pa.typeCounts)
            .sort((a, b) => b[1].value - a[1].value)
            .map(([t, s]) => `${formatActivityType(t)}: ${s.count} (${formatUsd(s.value)})`);
          lines.push(`    Types: ${typeParts.join(" | ")}`);
          lines.push(``);

          // Accumulate cross-pool totals
          for (const [t, s] of Object.entries(pa.typeCounts)) {
            if (!crossPoolTotals[t]) crossPoolTotals[t] = { count: 0, value: 0 };
            crossPoolTotals[t].count += s.count;
            crossPoolTotals[t].value += s.value;
          }
        }

        // Cross-pool summary
        lines.push(`  -- Cross-Pool Totals --`);
        lines.push(`    Grand Total: ${formatUsd(grandTotal)} across ${totalTxns} txns in ${allPoolActivities.length} pools`);
        for (const [t, s] of Object.entries(crossPoolTotals).sort((a, b) => b[1].value - a[1].value)) {
          lines.push(`    ${formatActivityType(t).padEnd(18)} ${String(s.count).padEnd(6)} txns  ${formatUsd(s.value)}`);
        }

        // Next-step hints with prioritized drill-down
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        const topPool = allPoolActivities[0];
        if (topPool) {
          lines.push(`• Highest-volume pool (${formatUsd(topPool.totalValueUsd)}): get_pool_activity(chain="${topPool.chain}", pool_address="${topPool.poolAddress}", address="${address}") for deep analysis`);
        }
        lines.push(`• Current holdings: get_portfolio(address="${address}") for PT/YT/LP balances`);
        lines.push(`• Deep analysis on any pool: get_pool_activity(chain=CHAIN, pool_address=POOL, address="${address}") for cycle detection, flow accounting, gas estimates`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error scanning address activity: ${e.message}` }], isError: true };
      }
    }
  );
}
