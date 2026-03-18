/**
 * Tool: mv_check_ibt_health
 *
 * Multi-signal health assessment of the IBT (interest-bearing token) underlying
 * a PT pool. Checks conversion rate, APR composition, pool balance, protocol
 * recognition, and liquidity to produce a HEALTHY / CAUTION / WARNING verdict.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork } from "../config.js";
import { fetchSpectra, fetchIbtConversionRate, fetchTokenDecimals, fetchSyExchangeRate } from "../api.js";
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
    "mv_check_ibt_health",
    `Perform a multi-signal health assessment of the IBT underlying a PT pool.

Checks conversion rate (on-chain ERC-4626), APR composition (organic vs incentive),
pool balance ratio, APR magnitude, protocol recognition, and liquidity level.

Returns HEALTHY / CAUTION / WARNING verdict with per-check details.

A CAUTION flag means "proceed with awareness." A WARNING flag means "investigate before
deploying." Output includes observation boundaries declaring what the snapshot cannot
detect (rate trajectory, underlying governance, whether imbalance is transient).
Pool imbalance checks surface competing explanations (demand vs withdrawal vs maturity).

Two modes:
  1. Spectra mode (pt_address): Full analysis using Spectra API + on-chain checks.
  2. Direct mode (ibt_address): Protocol-agnostic on-chain checks.
     Tries ERC-4626 convertToAssets(), falls back to Pendle SY exchangeRate().
     Use for Pendle SY tokens, or any ERC-4626 vault not listed on Spectra.
     Runs: conversion rate + rate direction. Skips: APR, pool balance, liquidity.

If both are provided, pt_address takes priority (richer data from Spectra API).

Use spectra_get_pool_capacity to assess how much capital the pool can absorb.
Use spectra_compare_yield for fixed-vs-variable rate analysis on the same PT.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pt_address: EVM_ADDRESS.optional().describe("The PT contract address (resolves to underlying IBT). Provide this OR ibt_address."),
      ibt_address: EVM_ADDRESS.optional().describe("Direct IBT/ERC-4626 address for protocol-agnostic health check. Use for Pendle SY tokens or any ERC-4626 vault."),
    },
    async ({ chain, pt_address, ibt_address }) => {
      try {
        // ── Validate: need at least one address ──
        if (!pt_address && !ibt_address) {
          return { content: [{ type: "text" as const, text: "Provide either pt_address (Spectra mode) or ibt_address (direct ERC-4626 mode)." }], isError: true };
        }

        // ── Direct mode: raw ERC-4626 health check without Spectra API ──
        if (ibt_address && !pt_address) {
          return await runDirectMode(chain, ibt_address);
        }

        // ── Spectra mode: full analysis via Spectra API ──
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

            // Rate velocity check: a rate above 1.0 could mean healthy accrual OR stale oracle.
            // The tool sees a single snapshot — it cannot distinguish between:
            //   (A) Vault is actively accruing yield (rate rises over time)
            //   (B) Oracle or vault is stale (rate is frozen, yield is not being compounded)
            // Both produce the same single-point reading. Cross-reference with IBT APR below —
            // if APR > 0 but rate barely exceeds 1.0 for a vault that has been live for months,
            // the rate and APR may be measuring different things.
            // This is NOT a bug — it is a measurement limitation of single-snapshot health checks.
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
            compLines.push(`But: high incentive share does not mean the vault is unhealthy — early-stage protocols often bootstrap with incentives that later convert to organic yield. The risk is discontinuity, not the ratio itself.`);
            checks.push({ name: "APR Composition", signal: "caution", lines: compLines });
          } else {
            compLines.push(`${Math.round(organicPct)}% organic at the Spectra layer`);
            compLines.push(`Note: "organic" means Spectra sees no incentive breakdown — the underlying protocol may itself run incentive programs that Spectra cannot decompose. A 100% organic reading here does NOT guarantee the yield is sustainable.`);
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
            const ratio = ptReserve / ibtReserve;
            const ratioStr = ratio >= 1
              ? `${ratio.toFixed(1)}:1`
              : `1:${(1 / ratio).toFixed(1)}`;

            if (ratio > 20 || ratio < 0.05) {
              checks.push({
                name: "Pool Balance",
                signal: "warning",
                lines: [
                  `PT:IBT ratio ${ratioStr} — severely imbalanced pool reserves — one side nearly depleted`,
                  `Reserves: ${ibtReserve.toLocaleString("en-US", { maximumFractionDigits: 2 })} IBT / ${ptReserve.toLocaleString("en-US", { maximumFractionDigits: 2 })} PT`,
                  `Competing readings:`,
                  `  (A) ${ratio > 1 ? "High PT / low IBT" : "High IBT / low PT"} — ${ratio > 1 ? "heavy PT buying exhausted IBT reserves (strong demand signal)" : "IBT accumulating as LPs withdraw or PT sellers exit (weak demand signal)"}`,
                  `  (B) Pool may be approaching maturity convergence — PT/IBT ratio shifts naturally as expiry nears`,
                  `  (C) Single large transaction skewed reserves — check spectra_get_pool_activity for recent whale activity`,
                ],
              });
            } else if (ratio > 4 || ratio < 0.25) {
              checks.push({
                name: "Pool Balance",
                signal: "caution",
                lines: [
                  `PT:IBT ratio ${ratioStr} — pool imbalanced`,
                  `Reserves: ${ibtReserve.toLocaleString("en-US", { maximumFractionDigits: 2 })} IBT / ${ptReserve.toLocaleString("en-US", { maximumFractionDigits: 2 })} PT`,
                  `This imbalance is ambiguous — ${ratio > 1 ? "PT-heavy could mean strong buyer demand (bullish for fixed-rate) OR LP withdrawal leaving PT behind (bearish for liquidity)" : "IBT-heavy could mean LPs depositing fresh capital (healthy) OR PT sellers dumping into the pool (bearish for fixed-rate)"}`,
                ],
              });
            } else {
              checks.push({
                name: "Pool Balance",
                signal: "ok",
                lines: [`PT:IBT ratio ${ratioStr} (within normal range)`],
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

        // Observation boundary
        lines.push("");
        lines.push("── Observation Boundary ──");
        lines.push("This health check is a single-point snapshot. It cannot detect:");
        lines.push("  - Rate trajectory (accruing vs frozen) — only a single reading, not a time series");
        lines.push("  - Underlying protocol health beyond conversion rate (governance, counterparty risk, audit status)");
        lines.push("  - Whether pool imbalance is transient (single trade) or structural (sustained flow)");
        if (!hasWarning && !hasCaution) {
          lines.push("A HEALTHY verdict means no anomalies were detected in this snapshot.");
          lines.push("It does NOT mean the IBT is safe to deploy unlimited capital into.");
        }

        lines.push("");
        lines.push("Use spectra_compare_yield for fixed-vs-variable rate analysis.");
        lines.push("Use spectra_get_pool_capacity for capital-aware depth assessment.");
        lines.push("Use spectra_get_pool_activity to check if pool imbalance is from a single trade or sustained pattern.");

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const text = `Error checking IBT health: ${err?.message || String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}

// =============================================================================
// Direct Mode — protocol-agnostic ERC-4626 health check
// =============================================================================

async function runDirectMode(chain: string, ibtAddress: string) {
  const checks: HealthCheck[] = [];

  // Read decimals on-chain
  const decimals = await fetchTokenDecimals(ibtAddress, chain);
  const effectiveDecimals = decimals ?? 18;

  if (decimals != null) {
    checks.push({ name: "Token Decimals", signal: "ok", lines: [`${decimals}`] });
  } else {
    checks.push({ name: "Token Decimals", signal: "caution", lines: ["Could not read decimals() — assuming 18. May be non-ERC-20."] });
  }

  // Conversion rate: convertToAssets(10^decimals) — ERC-4626
  const onChainRate = await fetchIbtConversionRate(ibtAddress, effectiveDecimals, chain);
  if (onChainRate !== null) {
    checks.push({
      name: "Conversion Rate",
      signal: "ok",
      lines: [`${onChainRate.toFixed(6)} underlying per token (on-chain ERC-4626)`],
    });

    // Rate direction
    if (onChainRate < 1.0) {
      checks.push({
        name: "Rate Direction",
        signal: "warning",
        lines: [
          `${onChainRate.toFixed(6)} — below 1.0`,
          "Token may have lost value (bad debt, hack, or depeg). Or this may be a wrapper token where sub-1.0 is expected.",
          "Verify: is this a wrapper (like sw- tokens)? If so, sub-1.0 is the exchange ratio, not value loss.",
        ],
      });
    } else {
      checks.push({
        name: "Rate Direction",
        signal: "ok",
        lines: [`${onChainRate.toFixed(6)} — above 1.0 (accruing value normally)`],
      });
    }
  } else {
    // ERC-4626 failed — try Pendle SY exchangeRate() as fallback
    const syRate = await fetchSyExchangeRate(ibtAddress, chain);
    if (syRate !== null) {
      checks.push({
        name: "Conversion Rate",
        signal: "ok",
        lines: [`${syRate.toFixed(6)} underlying per token (Pendle SY exchangeRate)`],
      });

      // Rate direction (same logic as ERC-4626)
      if (syRate < 1.0) {
        checks.push({
          name: "Rate Direction",
          signal: "warning",
          lines: [
            `${syRate.toFixed(6)} — below 1.0`,
            "SY token may have lost value, or this may be a wrapper where sub-1.0 is expected.",
          ],
        });
      } else {
        checks.push({
          name: "Rate Direction",
          signal: "ok",
          lines: [`${syRate.toFixed(6)} — above 1.0 (SY accruing value normally)`],
        });
      }
    } else {
      // Neither ERC-4626 nor Pendle SY worked
      checks.push({
        name: "Conversion Rate",
        signal: "caution",
        lines: ["Could not read convertToAssets() or exchangeRate() — token may not be ERC-4626 or Pendle SY, or no RPC available."],
      });
    }
  }

  // ── Aggregate verdict ──
  const hasWarning = checks.some(c => c.signal === "warning");
  const hasCaution = checks.some(c => c.signal === "caution");
  const cautionCount = checks.filter(c => c.signal === "caution").length;
  const warningCount = checks.filter(c => c.signal === "warning").length;

  let overallLabel: string;
  if (hasWarning) {
    overallLabel = `WARNING (${warningCount} warning${warningCount > 1 ? "s" : ""}${cautionCount > 0 ? `, ${cautionCount} caution${cautionCount > 1 ? "s" : ""}` : ""})`;
  } else if (hasCaution) {
    overallLabel = `CAUTION (${cautionCount} flag${cautionCount > 1 ? "s" : ""})`;
  } else {
    overallLabel = "HEALTHY";
  }

  // ── Format output ──
  const addrShort = `${ibtAddress.slice(0, 6)}...${ibtAddress.slice(-4)}`;
  const lines: string[] = [];
  lines.push(`IBT Health Check: ${addrShort} (direct mode)`);
  lines.push("=".repeat(lines[0].length));
  lines.push("");
  lines.push(`Address: ${ibtAddress}`);
  lines.push(`Chain: ${chain}`);
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
  lines.push("Direct mode: on-chain ERC-4626 checks only.");
  lines.push("APR composition, pool balance, and liquidity checks require a Spectra PT address.");
  lines.push("Use spectra_get_pt_details with a Spectra PT for full analysis.");

  const text = lines.join("\n");
  return { content: [{ type: "text" as const, text }] };
}
