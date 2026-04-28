/**
 * Tool: spectra_list_expiring_pools
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
import { scanAllChainPools, fetchSpectra, fetchMerklCampaigns, lookupMerklCampaigns } from "../api.js";
import type { MerklCampaign } from "../types.js";
import { formatDate, daysToMaturity, formatPct, formatUsd } from "../formatters.js";
// PR-B2 of hardcode-vs-generalize-spec.md (2026-04-28): route urgency
// classification through the centralized `getMaturityCategory`. The user-facing
// vocabulary (CRITICAL/WARNING/ALERT) stays distinct from action-items
// (URGENT/SOON/UPCOMING) — different surface, different audience — but the
// boundary semantics are now shared. When the central thresholds shift
// (urgent=7 → urgent=10, say), expiry_monitor follows automatically.
import { getMaturityCategory } from "../action-items/types.js";
import type { RawPoolOpportunity } from "../types.js";

/** Result from the governance API — distinguishes "no gauges" from "API unavailable" */
interface GaugeResult {
  addrs: Set<string>;
  available: boolean;
}

/** Fetch pool addresses that have gauges from the governance API.
 *  The endpoint returns GovernanceResponse[] (array of epochs), each containing
 *  a .data array of GaugeEntry objects. Gauge pool addresses live in entry.data[].address.
 */
async function fetchGaugePoolAddresses(): Promise<GaugeResult> {
  try {
    const data = await fetchSpectra("/governance/voting-incentives");
    if (!Array.isArray(data)) {
      return { addrs: new Set(), available: false };
    }
    const addrs = new Set<string>();
    for (const epoch of data) {
      const gauges = epoch.data || [];
      for (const gauge of gauges) {
        if (gauge.address) addrs.add(gauge.address.toLowerCase());
      }
    }
    return { addrs, available: true };
  } catch {
    return { addrs: new Set(), available: false }; // best-effort — don't block on gauge fetch failure
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
  poolAddress: string;
  maturityDate: string;
  daysLeft: number;
  impliedApy: number;
  tvlUsd: number;
  hasGauge: boolean | null; // null = unknown (gauge API unavailable)
}

/** Readiness assessment for a pool's transition state */
interface ReadinessSignal {
  level: "OK" | "CAUTION" | "WARNING";
  messages: string[];
}

function urgencyLabel(days: number): string {
  // PR-B2: route via central getMaturityCategory for boundary consistency.
  // CRITICAL/WARNING/ALERT vocabulary preserved (distinct from action-items
  // URGENT/SOON/UPCOMING — this is the operator-facing tool, not the curator
  // dashboard).
  const cat = getMaturityCategory(days);
  if (cat === "urgent" || cat === "expired") return "CRITICAL";
  if (cat === "soon") return "WARNING";
  return "ALERT";
}

function urgencyIcon(days: number): string {
  const cat = getMaturityCategory(days);
  if (cat === "urgent" || cat === "expired") return "!!!";
  if (cat === "soon") return "!!";
  return "!";
}

/** Assess transition readiness: successor pool + gauge + Merkl campaign + timing */
function assessReadiness(
  p: ExpiringPool,
  succs: SuccessorPool[],
  merklMap?: Map<string, MerklCampaign[]>,
): ReadinessSignal {
  const messages: string[] = [];
  let level: "OK" | "CAUTION" | "WARNING" = "OK";

  // No successor — but absence is ambiguous
  if (succs.length === 0) {
    level = p.daysLeft <= 7 ? "WARNING" : "CAUTION";
    messages.push(`No successor pool deployed for IBT ${p.ibtSymbol}`);
    if (p.daysLeft <= 7) {
      messages.push("Pool expires within 7 days — LPs need migration path");
    }
    // Surface competing readings of absence
    messages.push(
      `Absence could mean: (A) successor not yet created — action needed, or (B) IBT has moved to a different venue (Pendle, direct lending) — no Spectra successor intended`
    );
    return { level, messages };
  }

  // Has successor — check gauge
  const s = succs[0];
  if (s.hasGauge === false) {
    level = p.daysLeft <= 14 ? "WARNING" : "CAUTION";
    messages.push(
      `Successor ${s.name} exists but has no gauge — needs governance proposal`
    );
  } else if (s.hasGauge === null) {
    // Gauge API unavailable — don't penalize, but note the uncertainty
    messages.push(
      `Successor ${s.name} — gauge status unknown (governance API unavailable), verify manually`
    );
  }

  // Merkl campaign check — gauge without Merkl means emissions don't reach LPs
  if (s.hasGauge === true && merklMap) {
    const campaigns = lookupMerklCampaigns(merklMap, [s.poolAddress]);
    if (campaigns.length === 0) {
      if (level !== "WARNING") level = "CAUTION";
      messages.push(
        `Successor has gauge but no Merkl campaign at ${s.poolAddress.slice(0, 10)}... — emissions allocated but not distributed to LPs`
      );
    }
  }

  // Successor has very low TVL (< $1K) — not seeded yet
  if (s.tvlUsd < 1000) {
    if (level !== "WARNING") level = "CAUTION";
    messages.push(
      `Successor TVL is ${formatUsd(s.tvlUsd)} — pool may not be seeded yet`
    );
  }

  if (messages.length === 0) {
    messages.push(
      `Successor deployed with gauge: ${s.name} (${formatUsd(s.tvlUsd)} TVL)`
    );
  }

  return { level, messages };
}

export function register(server: McpServer): void {
  server.tool(
    "spectra_list_expiring_pools",
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

Gauge status is fetched from the governance voting-incentives API. A pool address
present in that endpoint has a gauge (even if it currently has 0 votes / 0 emissions).
Gauge API failure is best-effort — gauge status shows as unknown, does not block results.

Per-pool readiness assessment combines successor status, gauge status, and timing:
  OK:      Successor deployed with gauge and seeded
  CAUTION: Successor exists but missing gauge or low TVL; or no successor but >7d runway
  WARNING: No successor and ≤7d; or successor without gauge and ≤14d

Urgency (time-based) and readiness (action-based) are independent dimensions.
A pool can be ALERT urgency (21d runway) but WARNING readiness (no successor at all).
The Operator Checklist section groups required actions by type:
  - Deploy successor pool: IBTs with no active successor
  - Submit gauge proposal: successors that exist but lack a gauge
  - Ready for migration: successors with gauge and adequate TVL

Urgency levels:
  CRITICAL (≤7 days): Immediate action required
  WARNING  (≤14 days): Start preparations now
  ALERT    (≤21+ days): Plan ahead

Set include_expired=true to also show recently matured pools (if the API returns them).
By default only active (non-expired) pools are shown.

Use mv_plan_rollover on a specific MetaVault for automated rollover candidate discovery.
Use spectra_get_yield_curve to see what maturities already exist for the same underlying.
Use spectra_list_pools to check if a successor pool has already been created.`,
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
        const [{ opportunities, failedChains }, gaugeResult] =
          await Promise.all([
            scanAllChainPools({ min_tvl_usd: 0, min_liquidity_usd: 0 }),
            fetchGaugePoolAddresses(),
          ]);
        const { addrs: gaugePoolAddrs, available: gaugeApiAvailable } = gaugeResult;

        // Filter to expiring pools within threshold
        const expiring: ExpiringPool[] = [];

        for (const opp of opportunities) {
          if (chain && opp.chain !== chain) continue;

          const days = daysToMaturity(opp.pt.maturity);
          if (days > threshold_days) continue;

          const tvl = opp.pt.tvl?.usd || 0;
          if (tvl < min_tvl_usd) continue;

          const chainInfo =
            SUPPORTED_CHAINS[opp.chain as keyof typeof SUPPORTED_CHAINS];

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

        // Build IBT → successor pools map
        const expiringPtSet = new Set(
          expiring.map((p) => p.ptAddress.toLowerCase())
        );
        const ibtSuccessors = new Map<string, SuccessorPool[]>();

        for (const opp of opportunities) {
          const ibtAddr = opp.pt.ibt?.address?.toLowerCase();
          if (!ibtAddr) continue;
          if (expiringPtSet.has(opp.pt.address.toLowerCase())) continue;

          const key = `${ibtAddr}:${opp.chain}`;
          if (!ibtSuccessors.has(key)) ibtSuccessors.set(key, []);
          const poolAddr = opp.pool.address?.toLowerCase() || "";
          ibtSuccessors.get(key)!.push({
            name: opp.pt.name,
            chain: opp.chain,
            ptAddress: opp.pt.address,
            poolAddress: opp.pool.address || "",
            maturityDate: formatDate(opp.pt.maturity),
            daysLeft: daysToMaturity(opp.pt.maturity),
            impliedApy: opp.pool.impliedApy || 0,
            tvlUsd: opp.pt.tvl?.usd || 0,
            hasGauge: gaugeApiAvailable ? gaugePoolAddrs.has(poolAddr) : null,
          });
        }
        for (const succs of ibtSuccessors.values()) {
          succs.sort((a, b) => a.daysLeft - b.daysLeft);
        }

        function getSuccessors(p: ExpiringPool): SuccessorPool[] {
          if (!p.ibtAddress) return [];
          const key = `${p.ibtAddress.toLowerCase()}:${p.chain}`;
          return ibtSuccessors.get(key) || [];
        }

        // ── Build output ──
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
            "All pools have sufficient runway. Use spectra_list_pools to see active pools."
          );
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        // Urgency counts — PR-B2: dispatch via getMaturityCategory so the
        // 7/14 boundaries don't drift from action-items semantics.
        const critical = expiring.filter((p) => {
          const c = getMaturityCategory(p.daysLeft);
          return c === "urgent" || c === "expired";
        });
        const warning = expiring.filter(
          (p) => getMaturityCategory(p.daysLeft) === "soon",
        );
        // ALERT bucket = anything past the SOON tier but within threshold_days
        // (which is the user-configurable filter applied earlier at line ~250).
        const alert = expiring.filter((p) => {
          const c = getMaturityCategory(p.daysLeft);
          return c === "upcoming" || c === "status";
        });

        // Fetch Merkl campaigns for readiness assessment (best-effort, parallel)
        const expiringChains = [...new Set(expiring.map(p => p.chain))];
        const merklByChain = new Map<string, Map<string, MerklCampaign[]>>();
        const merklFetches = await Promise.allSettled(
          expiringChains.map(async (ch) => {
            const chainId = SUPPORTED_CHAINS[ch]?.id;
            if (!chainId) return null;
            const result = await fetchMerklCampaigns(chainId).catch(() => null);
            if (result?.available) merklByChain.set(ch, result.campaigns);
            return null;
          })
        );

        // Readiness counts
        let okCount = 0;
        let cautionCount = 0;
        let warningCount = 0;
        const poolReadiness = new Map<string, ReadinessSignal>();
        for (const p of expiring) {
          const succs = getSuccessors(p);
          // Pass Merkl map for the successor's chain (successor may be on same chain)
          const succChain = succs[0]?.chain;
          const merklMap = succChain ? merklByChain.get(succChain) : undefined;
          const r = assessReadiness(p, succs, merklMap);
          poolReadiness.set(p.ptAddress, r);
          if (r.level === "OK") okCount++;
          else if (r.level === "CAUTION") cautionCount++;
          else warningCount++;
        }

        const scope = chain ? ` on ${chain}` : "";
        lines.push(
          `Expiring Pools${scope} — ${expiring.length} pool${expiring.length === 1 ? "" : "s"} within ${threshold_days} days`
        );
        lines.push("");

        // Summary
        const urgParts: string[] = [];
        if (critical.length > 0)
          urgParts.push(`!!! ${critical.length} CRITICAL`);
        if (warning.length > 0)
          urgParts.push(`!! ${warning.length} WARNING`);
        if (alert.length > 0) urgParts.push(`! ${alert.length} ALERT`);
        lines.push(`Urgency:   ${urgParts.join("  |  ")}`);

        const rdParts: string[] = [];
        if (warningCount > 0) rdParts.push(`${warningCount} WARNING`);
        if (cautionCount > 0) rdParts.push(`${cautionCount} CAUTION`);
        if (okCount > 0) rdParts.push(`${okCount} OK`);
        lines.push(`Readiness: ${rdParts.join("  |  ")}`);
        lines.push(
          `Gauges:    ${gaugeApiAvailable ? `${gaugePoolAddrs.size} gauged pools in governance` : "governance API unavailable — gauge status unknown"}`
        );
        lines.push("");

        if (compact) {
          const hdr =
            "Urg | Days | Rdy | Chain    | IBT             | TVL       | Succ  | Gauge | Maturity";
          lines.push(hdr);
          lines.push("─".repeat(hdr.length));

          for (const p of expiring) {
            const urg = urgencyIcon(p.daysLeft).padEnd(3);
            const days = String(p.daysLeft).padStart(4);
            const r = poolReadiness.get(p.ptAddress)!;
            const rdy =
              r.level === "OK"
                ? " OK"
                : r.level === "CAUTION"
                  ? " ! "
                  : " !!";
            const ch = p.chain.padEnd(8);
            const ibt = p.ibtSymbol.slice(0, 15).padEnd(15);
            const tvl = formatUsd(p.tvlUsd).padStart(9);
            const succs = getSuccessors(p);
            const succ =
              succs.length === 0
                ? "  NO "
                : ` YES `;
            const gauge =
              succs.length === 0
                ? " n/a "
                : succs[0].hasGauge === true
                  ? " YES "
                  : succs[0].hasGauge === false
                    ? "  NO "
                    : "  ?  ";
            lines.push(
              `${urg} | ${days} | ${rdy} | ${ch} | ${ibt} | ${tvl} | ${succ} | ${gauge} | ${p.maturityDate}`
            );
          }
        } else {
          // Group by urgency level
          const groups = [
            { label: "CRITICAL (≤7 days)", pools: critical },
            { label: "WARNING (≤14 days)", pools: warning },
            {
              label: "ALERT (≤" + threshold_days + " days)",
              pools: alert,
            },
          ];

          for (const group of groups) {
            if (group.pools.length === 0) continue;

            lines.push(
              `── ${group.label} ${"─".repeat(50)}`
            );
            lines.push("");

            for (const p of group.pools) {
              const r = poolReadiness.get(p.ptAddress)!;
              const rdyTag =
                r.level === "WARNING"
                  ? "!! "
                  : r.level === "CAUTION"
                    ? "!  "
                    : "   ";

              lines.push(
                `${urgencyIcon(p.daysLeft)} ${p.ibtSymbol} on ${p.chain} — ${p.daysLeft}d to maturity (${p.maturityDate})`
              );
              lines.push(
                `    PT TVL: ${formatUsd(p.tvlUsd)} | Liquidity: ${formatUsd(p.liquidityUsd)} | APY: ${formatPct(p.impliedApy)}`
              );
              lines.push(
                `    IBT: ${p.ibtAddress} (${p.ibtProtocol})`
              );
              lines.push(
                `    PT:  ${p.ptAddress} | Pool: ${p.poolAddress || "n/a"} | Chain ID: ${p.chainId}`
              );

              // Successor + gauge status
              const succs = getSuccessors(p);
              if (succs.length > 0) {
                const s = succs[0];
                const gaugeStr = s.hasGauge === true ? "gauge: YES" : s.hasGauge === false ? "gauge: NO" : "gauge: ?";
                lines.push(
                  `    Successor: ${s.name}`
                );
                lines.push(
                  `      Maturity: ${s.maturityDate} (${s.daysLeft}d) | APY: ${formatPct(s.impliedApy)} | TVL: ${formatUsd(s.tvlUsd)} | ${gaugeStr}`
                );
                lines.push(
                  `      PT: ${s.ptAddress} | Pool: ${s.poolAddress}`
                );
                if (succs.length > 1) {
                  lines.push(
                    `      +${succs.length - 1} more pool${succs.length - 1 === 1 ? "" : "s"} with same IBT`
                  );
                }
              } else {
                lines.push(
                  `    Successor: NONE`
                );
              }

              // Readiness
              lines.push(
                `    Readiness: ${r.level}${r.messages.length > 0 ? " — " + r.messages.join("; ") : ""}`
              );
              lines.push("");
            }
          }
        }

        // ── Operator Checklist ──
        lines.push("");
        lines.push("── Operator Checklist ──");

        // Pools needing successor creation
        const needsPool = expiring.filter(
          (p) => getSuccessors(p).length === 0
        );
        const needsGauge = expiring.filter((p) => {
          const s = getSuccessors(p);
          return s.length > 0 && s[0].hasGauge === false;
        });
        const unknownGauge = expiring.filter((p) => {
          const s = getSuccessors(p);
          return s.length > 0 && s[0].hasGauge === null;
        });
        const ready = expiring.filter((p) => {
          const r = poolReadiness.get(p.ptAddress)!;
          return r.level === "OK";
        });

        if (needsPool.length > 0) {
          lines.push("");
          lines.push(
            `Deploy successor pool (${needsPool.length}):`
          );
          for (const p of needsPool) {
            lines.push(
              `  • ${p.ibtSymbol} on ${p.chain} (${p.daysLeft}d) — IBT: ${p.ibtAddress}`
            );
          }
        }

        if (needsGauge.length > 0) {
          lines.push("");
          lines.push(
            `Submit gauge proposal (${needsGauge.length}):`
          );
          for (const p of needsGauge) {
            const s = getSuccessors(p)[0];
            lines.push(
              `  • ${s.name} on ${p.chain} — pool: ${s.poolAddress}`
            );
          }
        }

        if (unknownGauge.length > 0) {
          lines.push("");
          lines.push(
            `Verify gauge status (${unknownGauge.length}) — governance API unavailable:`
          );
          for (const p of unknownGauge) {
            const s = getSuccessors(p)[0];
            lines.push(
              `  • ${s.name} on ${p.chain} — pool: ${s.poolAddress}`
            );
          }
        }

        if (ready.length > 0) {
          lines.push("");
          lines.push(
            `Ready for migration (${ready.length}):`
          );
          for (const p of ready) {
            const s = getSuccessors(p)[0];
            lines.push(
              `  • ${p.ibtSymbol} on ${p.chain} → ${s.name} (${formatUsd(s.tvlUsd)} TVL)`
            );
          }
        }

        if (failedChains.length > 0) {
          lines.push("");
          lines.push(
            `Note: Failed to fetch from: ${failedChains.join(", ")}`
          );
        }

        lines.push("");
        lines.push("── Observation Boundary ──");
        lines.push("This scan covers Spectra pools only. Expiring positions on Pendle are invisible here.");
        lines.push("Use pendle_list_expiring_markets for Pendle-side expiry monitoring.");
        if (needsPool.length > 0) {
          lines.push(`"No successor" pools (${needsPool.length}): the absence of a successor is a fact, not a diagnosis.`);
          lines.push("Some IBTs deliberately migrate between protocols or venues — verify with the IBT");
          lines.push("protocol team whether a Spectra successor is intended before deploying one.");
        }
        lines.push("Gauge status is point-in-time — a proposal may be pending that this scan cannot see.");

        lines.push("");
        lines.push("── Next Steps ──");
        if (needsPool.length > 0) {
          const p = needsPool[0];
          lines.push(
            `• Deploy: Use spectra_get_pt_details(chain="${p.chain}", pt_address="${p.ptAddress}") to review IBT specs before deploying successor`
          );
        }
        if (needsGauge.length > 0) {
          lines.push(
            `• Gauge proposals: Submit at gov.spectra.finance — successor pool addresses listed above`
          );
        }
        lines.push(
          `• Yield curve: spectra_get_yield_curve(underlying="SYMBOL") to see all active maturities for an asset`
        );
        lines.push(
          `• MetaVault rollover: mv_plan_rollover(chain, metavault_address) for automated candidate discovery`
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
