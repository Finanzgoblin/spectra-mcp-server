/**
 * Tool: get_expiring_pools
 *
 * Scans all Spectra chains for pools approaching maturity.
 * Designed for operators who need lead time to create follow-up pools
 * and submit gauge proposals before existing pools expire.
 *
 * Default warning threshold: 21 days (3 weeks).
 * Groups results by urgency: CRITICAL (≤7d), WARNING (≤14d), ALERT (≤21d+).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, SUPPORTED_CHAINS } from "../config.js";
import { scanAllChainPools, fetchSpectra } from "../api.js";
import { formatDate, daysToMaturity, formatPct, formatUsd } from "../formatters.js";
import type { RawPoolOpportunity } from "../types.js";

/** Fetch pool addresses that have gauges from the governance API */
async function fetchGaugePoolAddresses(): Promise<Set<string>> {
  try {
    const data = (await fetchSpectra("/governance/voting-incentives")) as any[];
    const addrs = new Set<string>();
    for (const entry of data) {
      if (entry.address) addrs.add(entry.address.toLowerCase());
    }
    return addrs;
  } catch {
    return new Set(); // best-effort — don't block on gauge fetch failure
  }
}

interface ExpiringPool {
  name: string;
  chain: string;
  chainId: number;
  daysLeft: number;
  maturityDate: string;
  maturityTimestamp: number;
  ptAddress: string;
  ibtAddress: string;
  ibtSymbol: string;
  ibtProtocol: string;
  underlyingSymbol: string;
  underlyingAddress: string;
  tvlUsd: number;
  impliedApy: number;
  liquidityUsd: number;
  poolAddress: string;
}

/** A non-expiring pool that shares the same IBT as an expiring pool */
interface SuccessorPool {
  name: string;
  chain: string;
  ptAddress: string;
  maturityDate: string;
  daysLeft: number;
  impliedApy: number;
  tvlUsd: number;
  hasGauge: boolean;
}

function urgencyLabel(days: number): string {
  if (days <= 7) return "CRITICAL";
  if (days <= 14) return "WARNING";
  return "ALERT";
}

function urgencyIcon(days: number): string {
  if (days <= 7) return "!!!";
  if (days <= 14) return "!!";
  return "!";
}

export function register(server: McpServer): void {
  server.tool(
    "get_expiring_pools",
    `Scan all Spectra chains for pools approaching maturity.

Returns pools expiring within the specified threshold (default 21 days / 3 weeks),
grouped by urgency level. Designed for operators who need lead time to:
- Create follow-up pools with new maturities
- Submit gauge proposals for successor pools
- Plan LP migration and rollover strategies
- Coordinate with IBT protocol teams

Each result includes the PT address, IBT address, chain ID, underlying asset,
TVL, and current implied APY — everything needed to plan the successor pool.

Automatically cross-references each expiring pool's IBT against all active pools
to flag whether a successor pool (same IBT, later maturity) already exists or
needs to be created.

Urgency levels:
  CRITICAL (≤7 days): Immediate action required
  WARNING  (≤14 days): Start preparations now
  ALERT    (≤21+ days): Plan ahead

Use plan_rollover on a specific MetaVault for automated rollover candidate discovery.
Use get_yield_curve to see what maturities already exist for the same underlying.
Use list_pools to check if a successor pool has already been created.`,
    {
      threshold_days: z
        .number()
        .min(1)
        .max(365)
        .default(21)
        .describe(
          "Warning threshold in days before maturity (default 21 = 3 weeks). Pools expiring within this window are returned."
        ),
      chain: CHAIN_ENUM.optional().describe(
        "Restrict to a single chain. Omit to scan all chains."
      ),
      min_tvl_usd: z
        .number()
        .default(0)
        .describe("Minimum TVL in USD to include (default 0 = show all)"),
      compact: z
        .boolean()
        .default(false)
        .describe(
          "One-line-per-pool output for quick scanning. Omit for full details."
        ),
    },
    async ({ threshold_days, chain, min_tvl_usd, compact }) => {
      try {
        // Scan all chains + fetch gauge list in parallel
        const [{ opportunities, failedChains }, gaugePoolAddrs] = await Promise.all([
          scanAllChainPools({ min_tvl_usd: 0, min_liquidity_usd: 0 }),
          fetchGaugePoolAddresses(),
        ]);

        // Filter to expiring pools within threshold
        const now = Date.now() / 1000;
        const expiring: ExpiringPool[] = [];

        for (const opp of opportunities) {
          // Chain filter
          if (chain && opp.chain !== chain) continue;

          const days = daysToMaturity(opp.pt.maturity);

          // Only include pools within the warning window
          if (days > threshold_days) continue;

          // TVL filter (applied after maturity filter so we don't miss low-TVL expiring pools by default)
          const tvl = opp.pt.tvl?.usd || 0;
          if (tvl < min_tvl_usd) continue;

          const chainInfo = SUPPORTED_CHAINS[opp.chain as keyof typeof SUPPORTED_CHAINS];

          expiring.push({
            name: opp.pt.name,
            chain: opp.chain,
            chainId: chainInfo?.id || 0,
            daysLeft: days,
            maturityDate: formatDate(opp.pt.maturity),
            maturityTimestamp: opp.pt.maturity,
            ptAddress: opp.pt.address,
            ibtAddress: opp.pt.ibt?.address || "",
            ibtSymbol: opp.pt.ibt?.symbol || "unknown",
            ibtProtocol: opp.pt.ibt?.protocol || "unknown",
            underlyingSymbol: opp.pt.underlying?.symbol || "unknown",
            underlyingAddress: opp.pt.underlying?.address || "",
            tvlUsd: tvl,
            impliedApy: opp.pool.impliedApy || 0,
            liquidityUsd: opp.pool.liquidity?.usd || 0,
            poolAddress: opp.pool.address || "",
          });
        }

        // Sort by days remaining (most urgent first)
        expiring.sort((a, b) => a.daysLeft - b.daysLeft);

        // Build IBT → successor pools map (same IBT, later maturity, not itself expiring)
        // Key: lowercase IBT address + ":" + chain
        const expiringPtSet = new Set(expiring.map((p) => p.ptAddress.toLowerCase()));
        const ibtSuccessors = new Map<string, SuccessorPool[]>();

        for (const opp of opportunities) {
          const ibtAddr = opp.pt.ibt?.address?.toLowerCase();
          if (!ibtAddr) continue;
          // Skip pools that are themselves expiring
          if (expiringPtSet.has(opp.pt.address.toLowerCase())) continue;

          const key = `${ibtAddr}:${opp.chain}`;
          if (!ibtSuccessors.has(key)) ibtSuccessors.set(key, []);
          const days = daysToMaturity(opp.pt.maturity);
          // Gauge detection: pool address present in governance voting-incentives endpoint
          const poolAddr = opp.pool.address?.toLowerCase() || "";
          const hasGauge = gaugePoolAddrs.has(poolAddr);
          ibtSuccessors.get(key)!.push({
            name: opp.pt.name,
            chain: opp.chain,
            ptAddress: opp.pt.address,
            maturityDate: formatDate(opp.pt.maturity),
            daysLeft: days,
            impliedApy: opp.pool.impliedApy || 0,
            tvlUsd: opp.pt.tvl?.usd || 0,
            hasGauge,
          });
        }
        // Sort each group by maturity (nearest first)
        for (const succs of ibtSuccessors.values()) {
          succs.sort((a, b) => a.daysLeft - b.daysLeft);
        }

        // Helper to look up successors for an expiring pool
        function getSuccessors(p: ExpiringPool): SuccessorPool[] {
          if (!p.ibtAddress) return [];
          const key = `${p.ibtAddress.toLowerCase()}:${p.chain}`;
          return ibtSuccessors.get(key) || [];
        }

        // Build output
        const lines: string[] = [];

        if (expiring.length === 0) {
          const scope = chain ? ` on ${chain}` : " across all chains";
          lines.push(
            `No pools expiring within ${threshold_days} days${scope}.`
          );
          if (failedChains.length > 0) {
            lines.push(
              `Note: Failed to fetch from: ${failedChains.join(", ")}`
            );
          }
          lines.push("");
          lines.push(
            "All pools have sufficient runway. Use list_pools to see active pools."
          );
          const text = lines.join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        // Count by urgency
        const critical = expiring.filter((p) => p.daysLeft <= 7);
        const warning = expiring.filter(
          (p) => p.daysLeft > 7 && p.daysLeft <= 14
        );
        const alert = expiring.filter((p) => p.daysLeft > 14);

        const scope = chain ? ` on ${chain}` : "";
        lines.push(
          `Expiring Pools${scope} (${expiring.length} pool${expiring.length === 1 ? "" : "s"} within ${threshold_days} days)`
        );
        lines.push("");

        // Summary bar
        const summaryParts: string[] = [];
        if (critical.length > 0)
          summaryParts.push(`!!! CRITICAL: ${critical.length}`);
        if (warning.length > 0)
          summaryParts.push(`!! WARNING: ${warning.length}`);
        if (alert.length > 0)
          summaryParts.push(`! ALERT: ${alert.length}`);
        lines.push(summaryParts.join("  |  "));
        lines.push("");

        if (compact) {
          const hdr =
            "Urgency  | Days | Maturity   | Impl. APY |       TVL | Chain    | Underlying | IBT             | Succ | PT Address";
          lines.push(hdr);
          lines.push("─".repeat(hdr.length));

          for (const p of expiring) {
            const urg = urgencyIcon(p.daysLeft).padEnd(8);
            const days = String(p.daysLeft).padStart(4);
            const apy = formatPct(p.impliedApy).padStart(9);
            const tvl = formatUsd(p.tvlUsd).padStart(9);
            const ch = p.chain.padEnd(8);
            const ul = p.underlyingSymbol.padEnd(10);
            const ibt = p.ibtSymbol.slice(0, 15).padEnd(15);
            const succs = getSuccessors(p);
            const succFlag = succs.length === 0 ? `  NO` : succs[0].hasGauge ? ` Y+G` : ` Y-G`;
            const addr =
              p.ptAddress.slice(0, 6) + "..." + p.ptAddress.slice(-4);
            lines.push(
              `${urg} | ${days} | ${p.maturityDate} | ${apy} | ${tvl} | ${ch} | ${ul} | ${ibt} | ${succFlag} | ${addr}`
            );
          }
        } else {
          // Group by urgency level
          const groups = [
            { label: "CRITICAL (≤7 days)", pools: critical },
            { label: "WARNING (≤14 days)", pools: warning },
            { label: "ALERT (≤" + threshold_days + " days)", pools: alert },
          ];

          for (const group of groups) {
            if (group.pools.length === 0) continue;

            lines.push(`── ${group.label} ${"─".repeat(50)}`);
            lines.push("");

            for (const p of group.pools) {
              lines.push(`${urgencyIcon(p.daysLeft)} ${p.name} (${p.chain})`);
              lines.push(
                `  Maturity: ${p.maturityDate} (${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} remaining)`
              );
              lines.push(
                `  Implied APY: ${formatPct(p.impliedApy)} | TVL: ${formatUsd(p.tvlUsd)} | Liquidity: ${formatUsd(p.liquidityUsd)}`
              );
              lines.push(`  Underlying: ${p.underlyingSymbol} (${p.underlyingAddress || "n/a"})`);
              lines.push(
                `  IBT: ${p.ibtSymbol} (${p.ibtAddress || "n/a"}) — ${p.ibtProtocol}`
              );
              lines.push(`  PT Address: ${p.ptAddress}`);
              lines.push(`  Pool Address: ${p.poolAddress || "n/a"}`);
              lines.push(`  Chain ID: ${p.chainId}`);

              // Successor pool status
              const succs = getSuccessors(p);
              if (succs.length > 0) {
                const s = succs[0]; // nearest successor
                const gaugeTag = s.hasGauge ? "gauge YES" : "gauge NO";
                lines.push(
                  `  Successor: YES — ${s.name} maturing ${s.maturityDate} (${s.daysLeft}d), APY ${formatPct(s.impliedApy)}, TVL ${formatUsd(s.tvlUsd)}, ${gaugeTag}`
                );
                if (succs.length > 1) {
                  lines.push(
                    `             +${succs.length - 1} more pool${succs.length - 1 === 1 ? "" : "s"} with same IBT`
                  );
                }
              } else {
                lines.push(
                  `  Successor: NONE — no active pool found with same IBT (${p.ibtSymbol}). Needs creation.`
                );
              }
              lines.push("");
            }
          }
        }

        // Action items
        lines.push("");
        lines.push("── Action Items ──");
        if (critical.length > 0) {
          lines.push(
            `• ${critical.length} pool${critical.length === 1 ? "" : "s"} expiring within 7 days — successor pools should already exist`
          );
        }
        if (warning.length > 0) {
          lines.push(
            `• ${warning.length} pool${warning.length === 1 ? "" : "s"} expiring within 14 days — finalize gauge proposals and seed liquidity`
          );
        }
        if (alert.length > 0) {
          lines.push(
            `• ${alert.length} pool${alert.length === 1 ? "" : "s"} expiring within ${threshold_days} days — start planning successor pools`
          );
        }

        // Group by IBT for successor pool planning
        const byIbt = new Map<string, ExpiringPool[]>();
        for (const p of expiring) {
          const key = p.ibtAddress
            ? `${p.ibtAddress.toLowerCase()}:${p.chain}`
            : `unknown:${p.chain}:${p.underlyingSymbol}`;
          if (!byIbt.has(key)) byIbt.set(key, []);
          byIbt.get(key)!.push(p);
        }
        if (byIbt.size > 0) {
          lines.push("");
          lines.push("── Successor Pool Status ──");

          const needsCreation: string[] = [];
          const hasSuccessor: string[] = [];

          for (const [, pools] of byIbt) {
            const earliest = pools[0];
            const succs = getSuccessors(earliest);

            if (succs.length > 0) {
              const s = succs[0];
              const gaugeTag = s.hasGauge ? "gauge YES" : "gauge NO — needs proposal";
              hasSuccessor.push(
                `• ${earliest.ibtSymbol} on ${earliest.chain}: ${pools.length} expiring pool${pools.length === 1 ? "" : "s"} — successor exists: ${s.name} (${s.maturityDate}, ${s.daysLeft}d, APY ${formatPct(s.impliedApy)}, ${gaugeTag})`
              );
            } else {
              needsCreation.push(
                `• ${earliest.ibtSymbol} on ${earliest.chain}: ${pools.length} expiring pool${pools.length === 1 ? "" : "s"}, earliest ${earliest.maturityDate} (${earliest.daysLeft}d) — NO SUCCESSOR, needs creation (IBT: ${earliest.ibtAddress})`
              );
            }
          }

          if (needsCreation.length > 0) {
            lines.push("");
            lines.push(`Needs successor pool (${needsCreation.length}):`);
            lines.push(...needsCreation);
          }
          if (hasSuccessor.length > 0) {
            lines.push("");
            lines.push(`Successor already deployed (${hasSuccessor.length}):`);
            lines.push(...hasSuccessor);
          }
        }

        if (failedChains.length > 0) {
          lines.push("");
          lines.push(
            `Note: Failed to fetch from: ${failedChains.join(", ")}`
          );
        }

        lines.push("");
        lines.push(
          "Use get_yield_curve to check if successor maturities already exist."
        );
        lines.push(
          "Use plan_rollover for MetaVault-specific rollover candidates."
        );

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const text = `Error scanning for expiring pools: ${err?.message || String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
