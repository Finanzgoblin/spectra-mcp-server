/**
 * Tool: check_ibt_health
 *
 * Multi-signal health assessment of the IBT (interest-bearing token) underlying
 * a PT pool. Checks conversion rate, APR composition, pool balance, protocol
 * recognition, and liquidity to produce a HEALTHY / CAUTION / WARNING verdict.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork } from "../config.js";
import { fetchSpectra, fetchIbtConversionRate, fetchTokenDecimals } from "../api.js";
import { parsePtResponse, formatUsd, formatPct, formatBalance } from "../formatters.js";

type Signal = "ok" | "caution" | "warning";

interface HealthCheck {
  name: string;
  signal: Signal;
  lines: string[];  // indented detail lines
}

const ICON: Record<Signal, string> = { ok: "OK", caution: "CAUTION", warning: "WARNING" };

export function register(server: McpServer): void {
  server.tool(
    "check_ibt_health",
    `Perform a multi-signal health assessment of the IBT underlying a PT pool.

Checks conversion rate (on-chain ERC-4626), APR composition (organic vs incentive),
pool balance ratio, APR magnitude, protocol recognition, and liquidity level.

Returns HEALTHY / CAUTION / WARNING verdict with per-check details.

A CAUTION flag means "proceed with awareness" — the IBT may be fine but has
characteristics that warrant attention. A WARNING flag means "investigate before
deploying" — something looks anomalous.

Use get_pool_capacity to assess how much capital the pool can absorb.
Use compare_yield for fixed-vs-variable rate analysis on the same PT.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pt_address: EVM_ADDRESS.describe("The PT contract address (resolves to underlying IBT)"),
    },
    async ({ chain, pt_address }) => {
      try {
        const network = resolveNetwork(chain);
        const data = await fetchSpectra(`/${network}/pt/${pt_address}`) as any;
        const pt = parsePtResponse(data);

        if (!pt) {
          return { content: [{ type: "text" as const, text: `No PT found at ${pt_address} on ${chain}` }], isError: true };
        }

        const pool = pt.pools?.[0];
        const ibt = pt.ibt;
        const ibtAddress = ibt?.address;
        const ibtDecimals = ibt?.decimals ?? pt.decimals ?? 18;
        // Underlying decimals: prefer API, then on-chain fallback, then ibtDecimals
        let underlyingDecimals = pt.underlying?.decimals;
        if (underlyingDecimals == null && pt.underlying?.address) {
          underlyingDecimals = await fetchTokenDecimals(pt.underlying.address, chain) ?? undefined;
        }
        const effectiveUnderlyingDecimals = underlyingDecimals ?? ibtDecimals;
        const ibtSymbol = ibt?.symbol || "IBT";
        const ibtProtocol = ibt?.protocol || "";
        const poolLiqUsd = pool?.liquidity?.usd || 0;
        // Detect Spectra wrapper tokens (sw- prefix). For wrappers, on-chain
        // convertToAssets measures wrapper→baseIBT, NOT wrapper→underlying.
        // API ibt.price.underlying measures the full chain (wrapper→baseIBT→underlying).
        // Divergence and sub-1.0 rates are architecturally expected for wrappers.
        const isWrapper = !!(pt.baseIbt?.address);
        const baseIbtAddress = pt.baseIbt?.address;
        const baseIbtSymbol = pt.baseIbt?.symbol || "";

        const checks: HealthCheck[] = [];

        // ── Check 1: Conversion Rate (on-chain ERC-4626) ──
        const apiRate = ibt?.price?.underlying;
        if (ibtAddress) {
          const onChainRate = await fetchIbtConversionRate(ibtAddress, ibtDecimals, chain, effectiveUnderlyingDecimals);
          if (onChainRate !== null) {
            const rateLines: string[] = [`${onChainRate.toFixed(6)} underlying per IBT (on-chain)`];

            if (isWrapper) {
              // Wrapper token: on-chain and API measure different conversion paths
              rateLines.push(`sw- wrapper detected — on-chain rate is ${ibtSymbol}→${baseIbtSymbol || "baseIBT"}, not ${ibtSymbol}→underlying`);
              if (apiRate != null) {
                rateLines.push(`API rate ${apiRate.toFixed(6)} measures full chain (${ibtSymbol}→underlying) — divergence expected`);
              }
              if (baseIbtAddress) {
                rateLines.push(`To verify full conversion: read convertToAssets on baseIBT ${baseIbtAddress}`);
              }
              checks.push({ name: "Conversion Rate", signal: "ok", lines: rateLines });
            } else if (apiRate != null && apiRate > 0) {
              const divergence = Math.abs(onChainRate - apiRate) / apiRate * 100;
              rateLines.push(`API reports ${apiRate.toFixed(6)} — divergence ${formatPct(divergence)}`);

              if (divergence > 5) {
                checks.push({ name: "Conversion Rate", signal: "warning", lines: rateLines });
              } else if (divergence > 2) {
                checks.push({ name: "Conversion Rate", signal: "caution", lines: rateLines });
              } else {
                checks.push({ name: "Conversion Rate", signal: "ok", lines: rateLines });
              }
            } else {
              rateLines.push("API rate unavailable — cannot compare divergence");
              checks.push({ name: "Conversion Rate", signal: "ok", lines: rateLines });
            }

            // Rate direction check
            if (onChainRate < 1.0 && isWrapper) {
              checks.push({
                name: "Rate Direction",
                signal: "ok",
                lines: [
                  `${onChainRate.toFixed(6)} — below 1.0 (normal for sw- wrapper tokens)`,
                  `Wrapper rate measures ${ibtSymbol}→${baseIbtSymbol || "baseIBT"} exchange ratio, not value loss`,
                ],
              });
            } else if (onChainRate < 1.0) {
              checks.push({
                name: "Rate Direction",
                signal: "warning",
                lines: [
                  `${onChainRate.toFixed(6)} — below 1.0`,
                  "IBT may have lost value (bad debt, hack, or depeg)",
                ],
              });
            } else {
              checks.push({
                name: "Rate Direction",
                signal: "ok",
                lines: [`Above 1.0 (IBT accruing value normally)`],
              });
            }
          } else {
            checks.push({
              name: "Conversion Rate",
              signal: "ok",
              lines: ["On-chain read unavailable (no RPC or non-ERC-4626). Skipped."],
            });
            // Still check API rate direction if available
            if (apiRate != null) {
              if (apiRate < 1.0) {
                checks.push({
                  name: "Rate Direction",
                  signal: "warning",
                  lines: [`API rate ${apiRate.toFixed(6)} — below 1.0 (IBT may have lost value)`],
                });
              } else {
                checks.push({
                  name: "Rate Direction",
                  signal: "ok",
                  lines: [`API rate ${apiRate.toFixed(6)} — above 1.0`],
                });
              }
            }
          }
        } else {
          checks.push({
            name: "Conversion Rate",
            signal: "caution",
            lines: ["No IBT address available — cannot verify on-chain"],
          });
        }

        // ── Check 2: APR Composition ──
        const aprTotal = ibt?.apr?.total ?? 0;
        const aprBase = ibt?.apr?.details?.base ?? 0;
        const aprRewards = ibt?.apr?.details?.rewards || {};
        const incentiveTotal = Object.values(aprRewards).reduce((sum, v) => sum + (v || 0), 0);
        const organicPct = aprTotal > 0 ? (aprBase / aprTotal) * 100 : 100;
        const incentivePct = aprTotal > 0 ? (incentiveTotal / aprTotal) * 100 : 0;

        if (aprTotal > 0) {
          const parts: string[] = [];
          parts.push(`${formatPct(aprBase)} organic`);
          if (incentiveTotal > 0) {
            const rewardParts = Object.entries(aprRewards).map(([k, v]) => `${k} ${formatPct(v || 0)}`);
            parts.push(`${formatPct(incentiveTotal)} incentive (${rewardParts.join(", ")})`);
          }
          const compLines = [
            `${formatPct(aprTotal)} total (${parts.join(" / ")})`,
          ];

          if (incentivePct > 80) {
            compLines.push(`${Math.round(incentivePct)}% from incentives — yield may drop if program ends`);
            checks.push({ name: "APR Composition", signal: "caution", lines: compLines });
          } else {
            compLines.push(`${Math.round(organicPct)}% organic — sustainable yield base`);
            checks.push({ name: "APR Composition", signal: "ok", lines: compLines });
          }
        } else {
          checks.push({
            name: "APR Composition",
            signal: "caution",
            lines: ["No APR data available from API"],
          });
        }

        // ── Check 3: APR Magnitude ──
        if (aprTotal > 100) {
          checks.push({
            name: "APR Magnitude",
            signal: "warning",
            lines: [`${formatPct(aprTotal)} — extreme APR, verify source and sustainability`],
          });
        } else if (aprTotal > 50) {
          checks.push({
            name: "APR Magnitude",
            signal: "caution",
            lines: [`${formatPct(aprTotal)} — elevated APR, check if incentive-driven`],
          });
        } else if (aprTotal > 0) {
          checks.push({
            name: "APR Magnitude",
            signal: "ok",
            lines: [`${formatPct(aprTotal)} — reasonable range`],
          });
        }

        // ── Check 4: Pool Balance Ratio ──
        if (pool && pool.ibtAmount && pool.ptAmount) {
          const ibtDec = ibt?.decimals ?? pt.decimals ?? 18;
          const ptDec = pt.decimals ?? 18;
          const ibtReserve = formatBalance(pool.ibtAmount, ibtDec);
          const ptReserve = formatBalance(pool.ptAmount, ptDec);

          if (ibtReserve > 0 && ptReserve > 0) {
            const ratio = ibtReserve / ptReserve;
            const ratioStr = ratio >= 1
              ? `${ratio.toFixed(1)}:1`
              : `1:${(1 / ratio).toFixed(1)}`;

            if (ratio > 4 || ratio < 0.25) {
              checks.push({
                name: "Pool Balance",
                signal: "caution",
                lines: [
                  `IBT/PT ratio ${ratioStr} — pool imbalanced`,
                  `Reserves: ${ibtReserve.toLocaleString("en-US", { maximumFractionDigits: 2 })} IBT / ${ptReserve.toLocaleString("en-US", { maximumFractionDigits: 2 })} PT`,
                ],
              });
            } else {
              checks.push({
                name: "Pool Balance",
                signal: "ok",
                lines: [`IBT/PT ratio ${ratioStr} (within normal range)`],
              });
            }
          }
        }

        // ── Check 5: Protocol Recognition ──
        if (ibtProtocol) {
          checks.push({
            name: "Protocol",
            signal: "ok",
            lines: [`${ibtProtocol}`],
          });
        } else {
          checks.push({
            name: "Protocol",
            signal: "caution",
            lines: ["Unknown protocol — verify IBT source independently"],
          });
        }

        // ── Check 6: Liquidity Level ──
        if (poolLiqUsd > 0) {
          if (poolLiqUsd < 10_000) {
            checks.push({
              name: "Liquidity",
              signal: "warning",
              lines: [`${formatUsd(poolLiqUsd)} — very thin, high slippage risk`],
            });
          } else if (poolLiqUsd < 50_000) {
            checks.push({
              name: "Liquidity",
              signal: "caution",
              lines: [`${formatUsd(poolLiqUsd)} — thin for larger positions`],
            });
          } else {
            checks.push({
              name: "Liquidity",
              signal: "ok",
              lines: [`${formatUsd(poolLiqUsd)} pool liquidity`],
            });
          }
        } else {
          checks.push({
            name: "Liquidity",
            signal: "caution",
            lines: ["No liquidity data available"],
          });
        }

        // ── Aggregate verdict ──
        const hasWarning = checks.some(c => c.signal === "warning");
        const hasCaution = checks.some(c => c.signal === "caution");
        const cautionCount = checks.filter(c => c.signal === "caution").length;
        const warningCount = checks.filter(c => c.signal === "warning").length;

        let overallLabel: string;
        let overallIcon: string;
        if (hasWarning) {
          overallIcon = "!!";
          const flagCount = warningCount + cautionCount;
          overallLabel = `WARNING (${warningCount} warning${warningCount > 1 ? "s" : ""}${cautionCount > 0 ? `, ${cautionCount} caution${cautionCount > 1 ? "s" : ""}` : ""})`;
        } else if (hasCaution) {
          overallIcon = "!";
          overallLabel = `CAUTION (${cautionCount} flag${cautionCount > 1 ? "s" : ""})`;
        } else {
          overallIcon = "ok";
          overallLabel = "HEALTHY";
        }

        // ── Format output ──
        const protocolSuffix = ibtProtocol ? ` (${ibtProtocol})` : "";
        const lines: string[] = [];
        lines.push(`IBT Health Check: ${ibtSymbol}${protocolSuffix}`);
        lines.push("=".repeat(lines[0].length));
        lines.push("");
        lines.push(`Overall: ${overallLabel}`);
        lines.push("");
        lines.push("Checks:");

        for (const check of checks) {
          const icon = ICON[check.signal];
          const firstLine = check.lines[0];
          lines.push(`  ${check.name.padEnd(20)} [${icon}]  ${firstLine}`);
          for (let i = 1; i < check.lines.length; i++) {
            lines.push(`  ${"".padEnd(20)}       ${check.lines[i]}`);
          }
        }

        lines.push("");
        lines.push("Use compare_yield for fixed-vs-variable rate analysis.");
        lines.push("Use get_pool_capacity for capital-aware depth assessment.");

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const text = `Error checking IBT health: ${err?.message || String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}
