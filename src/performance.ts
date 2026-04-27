/**
 * MetaVault performance metrics — computation + rendering.
 *
 * HOME for `computePerformanceMetrics` (computes TWR / max-drawdown / volatility
 * / Sharpe from epoch snapshots), `formatPerformanceMetrics` (full dashboard
 * block, multi-line), and `formatPerformanceMetricsOneLine` (compact one-line
 * for `spectra_list_metavaults` per discard-layer-spec PR7b).
 *
 * PR7a refactor (discard-layer-spec §1):
 *   - Extracted from `src/tools/metavault.ts:95-220` (module-private to
 *     `register()`'s closure prior to v3-final).
 *   - Numerical equivalence preserved: every existing test that exercised
 *     these functions passes byte-identically.
 *   - The full-block render (`formatPerformanceMetrics`) is unchanged from its
 *     previous shape; it remains the dashboard's render path.
 *   - The new one-line variant lives next to its siblings so future drift
 *     between them is visible (a PR that changes the multi-line format must
 *     touch this file, increasing the chance the one-liner gets updated too).
 *
 * Imports stay shallow: types (no logic) + primitives (`formatPct` /
 * `formatDate`). No formatters.ts dependency — keeps the dependency graph
 * acyclic.
 */

import type { MetavaultPerformanceMetrics, SpectraMetavaultEpoch } from "./types.js";
import { formatDate, formatPct } from "./primitives.js";

/**
 * Compute MetaVault historical performance from epoch snapshots.
 *
 * Inputs:
 *   - `epochs`: array of `SpectraMetavaultEpoch` (rate + timestamp, raw
 *     wei-style integer string for `rate`). Sorted internally by timestamp;
 *     callers don't need to pre-sort.
 *   - `riskFreeRatePct` (default 5): used for Sharpe ratio computation. Pass a
 *     real risk-free proxy when available; 5% matches T-bill territory in
 *     April 2026 and is the existing call-site default.
 *   - `underlyingDecimals` (default 6): rate divisor exponent. The Spectra API
 *     emits `rate` in underlying-token wei (USDC=6, WETH=18, ...). Pass
 *     `mv.underlying.decimals` whenever it's available.
 *
 * Returns `null` when fewer than 2 epochs exist (single epoch can't bound a
 * period), when total time is non-positive, or when the first rate is ≤0.
 * Caller's `if (perfMetrics)` guard is the contract — never throws.
 *
 * Computation:
 *   - TWR (annualized): `(lastRate / firstRate - 1) * (365 / totalDays) * 100`.
 *     Geometric, simple-annualized — accurate when rate growth is monotonic.
 *   - Max drawdown: tracks running peak; reports the largest peak-to-trough
 *     percentage decline along with start + end dates.
 *   - Volatility (annualized): epoch-return stdev × sqrt(365 / avgEpochDays).
 *     Requires ≥2 epoch returns (i.e. ≥3 epochs); else stays 0 with Sharpe=null.
 *   - Sharpe: `(annualizedReturn - riskFree) / volatility`. Returns null when
 *     volatility is 0 (insufficient data); the formatters branch on null.
 */
export function computePerformanceMetrics(
  epochs: SpectraMetavaultEpoch[],
  riskFreeRatePct: number = 5,
  underlyingDecimals: number = 6,
): MetavaultPerformanceMetrics | null {
  if (!epochs || epochs.length < 2) return null;

  const rateDivisor = Math.pow(10, underlyingDecimals);
  const sorted = [...epochs].sort((a, b) => a.timestamp - b.timestamp);
  const rates = sorted.map((e) => Number(e.rate) / rateDivisor);
  const timestamps = sorted.map((e) => e.timestamp);

  const firstRate = rates[0];
  const lastRate = rates[rates.length - 1];
  const startDate = formatDate(timestamps[0]);
  const endDate = formatDate(timestamps[timestamps.length - 1]);
  const totalDays = (timestamps[timestamps.length - 1] - timestamps[0]) / 86400;

  if (totalDays <= 0 || firstRate <= 0) return null;

  const annualizedReturnPct = (lastRate / firstRate - 1) * (365 / totalDays) * 100;

  // Max drawdown
  let peak = rates[0];
  let maxDrawdownPct = 0;
  let drawdownStartIdx: number | null = null;
  let drawdownEndIdx: number | null = null;
  let currentPeakIdx = 0;

  if (peak <= 0) return null;

  for (let i = 1; i < rates.length; i++) {
    if (rates[i] > peak) {
      peak = rates[i];
      currentPeakIdx = i;
    }
    const drawdown = (rates[i] - peak) / peak * 100;
    if (drawdown < maxDrawdownPct) {
      maxDrawdownPct = drawdown;
      drawdownStartIdx = currentPeakIdx;
      drawdownEndIdx = i;
    }
  }

  const drawdownStartDate = drawdownStartIdx !== null ? formatDate(timestamps[drawdownStartIdx]) : null;
  const drawdownEndDate = drawdownEndIdx !== null ? formatDate(timestamps[drawdownEndIdx]) : null;

  // Volatility
  const epochReturns: number[] = [];
  let totalEpochDays = 0;
  for (let i = 1; i < rates.length; i++) {
    if (rates[i - 1] > 0) {
      epochReturns.push((rates[i] - rates[i - 1]) / rates[i - 1]);
    }
    totalEpochDays += (timestamps[i] - timestamps[i - 1]) / 86400;
  }

  let volatilityAnnualizedPct = 0;
  let sharpeRatio: number | null = null;

  if (epochReturns.length >= 2) {
    const avgEpochDays = totalEpochDays / epochReturns.length;
    const mean = epochReturns.reduce((s, r) => s + r, 0) / epochReturns.length;
    const variance = epochReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (epochReturns.length - 1);
    const stdDev = Math.sqrt(variance);
    const annualizationFactor = avgEpochDays > 0 ? Math.sqrt(365 / avgEpochDays) : 0;
    volatilityAnnualizedPct = stdDev * annualizationFactor * 100;

    if (volatilityAnnualizedPct > 0) {
      sharpeRatio = (annualizedReturnPct - riskFreeRatePct) / volatilityAnnualizedPct;
    }
  }

  return {
    startDate,
    endDate,
    totalDays: Math.round(totalDays),
    epochCount: sorted.length,
    annualizedReturnPct,
    maxDrawdownPct,
    drawdownStartDate,
    drawdownEndDate,
    volatilityAnnualizedPct,
    sharpeRatio,
    riskFreeRatePct,
  };
}

/**
 * Render the full multi-line performance block — the existing dashboard format.
 *
 * Byte-identical to the prior `tools/metavault.ts` implementation. The Sharpe
 * line carries a track-record warning suffix when `totalDays < 30` (⚠ glyph)
 * or `totalDays < 90` (parenthetical caution). Considerations footer trails.
 *
 * Render shape (preserved for byte-equivalence with PR7a tests):
 *
 *     --- Performance (since inception) ---
 *       Period: 2026-01-15 to 2026-04-27 (102 days, 8 epochs)
 *       Time-Weighted Return: 7.86% annualized
 *       Max Drawdown: -1.23% (2026-02-10 to 2026-02-14)
 *       Volatility: 4.50% annualized
 *       Sharpe Ratio: 0.6 (vs 5.00% risk-free proxy)
 *
 *       Considerations:
 *       - Returns are in underlying terms ...
 */
export function formatPerformanceMetrics(metrics: MetavaultPerformanceMetrics): string {
  const lines: string[] = [];
  lines.push(`--- Performance (since inception) ---`);
  lines.push(`  Period: ${metrics.startDate} to ${metrics.endDate} (${metrics.totalDays} days, ${metrics.epochCount} epochs)`);
  lines.push(`  Time-Weighted Return: ${formatPct(metrics.annualizedReturnPct)} annualized`);

  if (metrics.maxDrawdownPct < 0 && metrics.drawdownStartDate && metrics.drawdownEndDate) {
    lines.push(`  Max Drawdown: ${formatPct(metrics.maxDrawdownPct)} (${metrics.drawdownStartDate} to ${metrics.drawdownEndDate})`);
  } else {
    lines.push(`  Max Drawdown: none`);
  }

  lines.push(`  Volatility: ${formatPct(metrics.volatilityAnnualizedPct)} annualized`);

  if (metrics.sharpeRatio !== null) {
    const sharpeStr = `  Sharpe Ratio: ${metrics.sharpeRatio.toFixed(1)} (vs ${formatPct(metrics.riskFreeRatePct)} risk-free proxy)`;
    if (metrics.totalDays < 30) {
      lines.push(`${sharpeStr} ⚠ ${metrics.totalDays}d track record — too short for meaningful Sharpe`);
    } else if (metrics.totalDays < 90) {
      lines.push(`${sharpeStr} (${metrics.totalDays}d track record — interpret with caution)`);
    } else {
      lines.push(sharpeStr);
    }
  } else {
    lines.push(`  Sharpe Ratio: N/A (insufficient volatility data)`);
  }

  lines.push(``);
  lines.push(`  Considerations:`);
  lines.push(`  - Returns are in underlying terms (not USD) — denomination asset price changes are excluded`);
  lines.push(`  - Performance based on ${metrics.epochCount} epoch snapshots — granularity is limited by epoch frequency`);
  lines.push(`  - Max drawdown measures share rate decline, which can reflect LP impermanent loss or pool rebalancing`);
  if (metrics.totalDays < 90) {
    lines.push(`  - Short track record (${metrics.totalDays} days) — insufficient for robust statistical inference`);
  }

  return lines.join("\n");
}

/**
 * Render performance metrics as a single line for `spectra_list_metavaults`
 * (discard-layer-spec PR7b — AMMUNITION — multi-vault Sharpe scan in list).
 *
 * Shape: `Performance: TWR 7.86% / DD -1.23% / Sharpe 0.6 (102d)` — terse,
 * pipe-style segmentation with `/` separators for the three metrics + a
 * trailing parenthesized track-record-days marker.
 *
 * Track-record warning policy (DESIGN CHOICE — spec did not pin):
 *   - When `totalDays < 30`, append ` (track-record-class warning)` after the
 *     `(Xd)` segment. Mirrors the multi-line ⚠ behavior without using a glyph
 *     here (§7.1 consolidation rule disallows extra glyphs in list_metavaults
 *     since other warnings already may consume the per-MV glyph budget).
 *   - When `30 ≤ totalDays < 90`, no extra warning — the caution belongs in
 *     the dashboard's Considerations footer; the list-line is for triage.
 *
 * Sharpe-null policy (DESIGN CHOICE — spec did not pin):
 *   - When `metrics.sharpeRatio === null` (insufficient volatility data), the
 *     Sharpe segment renders as `Sharpe n/a`. The reader sees the same shape;
 *     "n/a" signals "data missing," not "computed-and-zero." Skipping the
 *     segment was the alternative — rejected because variable shape across
 *     vaults makes scan-comparison harder.
 */
export function formatPerformanceMetricsOneLine(metrics: MetavaultPerformanceMetrics): string {
  const sharpeSeg = metrics.sharpeRatio !== null
    ? `Sharpe ${metrics.sharpeRatio.toFixed(1)}`
    : `Sharpe n/a`;
  const trackWarn = metrics.totalDays < 30 ? ` (track-record-class warning)` : "";
  return `Performance: TWR ${formatPct(metrics.annualizedReturnPct)} / DD ${formatPct(metrics.maxDrawdownPct)} / ${sharpeSeg} (${metrics.totalDays}d)${trackWarn}`;
}
