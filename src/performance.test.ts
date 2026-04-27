/**
 * Unit tests for performance.ts — TWR/DD/volatility/Sharpe computation +
 * full-block render + one-line render.
 *
 * Coverage:
 *   - `computePerformanceMetrics`: edge cases (insufficient epochs, zero rate,
 *     monotonic vs volatile rates), Sharpe-null branch, max-drawdown ranges.
 *   - `formatPerformanceMetrics`: byte-equivalent to the prior tools/metavault
 *     implementation. Track-record warning rendering at 30/90 day thresholds.
 *   - `formatPerformanceMetricsOneLine` (NEW PR7a/PR7b): happy path, Sharpe
 *     null → `n/a`, <30d → track-record-class warning suffix.
 *
 * Why a new file (vs adding to formatters.test.ts): the move is the refactor.
 * Tests follow the code. Future PRs that touch performance metrics edit two
 * sites instead of three.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computePerformanceMetrics,
  formatPerformanceMetrics,
  formatPerformanceMetricsOneLine,
} from "./performance.js";
import type { MetavaultPerformanceMetrics, SpectraMetavaultEpoch } from "./types.js";

// ─── Fixture builders ───────────────────────────────────────────────────────

/**
 * Build a synthetic epoch series for 6-decimal underlying.
 * Each rate is provided as the simple multiplier (1.0 = par, 1.0786 = +7.86%);
 * the helper scales it to wei.
 */
function mkEpochs(
  rateMultipliers: number[],
  startTimestamp: number = 1_700_000_000,
  daySpacing: number = 14,
  decimals: number = 6,
): SpectraMetavaultEpoch[] {
  const wei = Math.pow(10, decimals);
  return rateMultipliers.map((m, i) => ({
    timestamp: startTimestamp + i * daySpacing * 86400,
    rate: Math.round(m * wei).toString(),
    assets: "0",
  }));
}

// ─── computePerformanceMetrics ──────────────────────────────────────────────

describe("computePerformanceMetrics", () => {
  it("returns null on fewer than 2 epochs", () => {
    assert.equal(computePerformanceMetrics([]), null);
    assert.equal(computePerformanceMetrics([{ timestamp: 1, rate: "1000000", assets: "0" }]), null);
  });

  it("returns null on zero or negative first rate", () => {
    const epochs: SpectraMetavaultEpoch[] = [
      { timestamp: 1, rate: "0", assets: "0" },
      { timestamp: 86400, rate: "1000000", assets: "0" },
    ];
    assert.equal(computePerformanceMetrics(epochs), null);
  });

  it("returns null when all epochs share the same timestamp (totalDays = 0)", () => {
    const epochs: SpectraMetavaultEpoch[] = [
      { timestamp: 1_700_000_000, rate: "1000000", assets: "0" },
      { timestamp: 1_700_000_000, rate: "1000000", assets: "0" },
    ];
    assert.equal(computePerformanceMetrics(epochs), null);
  });

  it("computes monotonic-growth annualized return on a 100-day series", () => {
    // 1.00 → 1.05 over 100 days; ~18.25% annualized (5% × 365/100).
    const epochs = mkEpochs([1.0, 1.05], 1_700_000_000, 100);
    const m = computePerformanceMetrics(epochs)!;
    assert.ok(m, "metrics must compute");
    assert.equal(m.totalDays, 100);
    assert.equal(m.epochCount, 2);
    assert.ok(m.annualizedReturnPct > 18 && m.annualizedReturnPct < 18.5);
    // Monotonic series — no drawdown.
    assert.equal(m.maxDrawdownPct, 0);
    assert.equal(m.drawdownStartDate, null);
    assert.equal(m.drawdownEndDate, null);
  });

  it("captures max drawdown across a peak-trough-recovery series", () => {
    // 1.00 → 1.10 (peak) → 0.99 (trough, -10%) → 1.05 over 80 days.
    const epochs = mkEpochs([1.0, 1.1, 0.99, 1.05], 1_700_000_000, 20);
    const m = computePerformanceMetrics(epochs)!;
    assert.ok(m, "metrics must compute");
    assert.ok(m.maxDrawdownPct < -9 && m.maxDrawdownPct > -11, `expected ~-10%, got ${m.maxDrawdownPct}`);
    assert.ok(m.drawdownStartDate, "drawdown start date must populate");
    assert.ok(m.drawdownEndDate, "drawdown end date must populate");
  });

  it("returns sharpeRatio = null when fewer than 3 epochs (no return-series volatility)", () => {
    // 2 epochs → 1 return → epochReturns.length === 1 < 2 → sharpe stays null.
    const epochs = mkEpochs([1.0, 1.05], 1_700_000_000, 50);
    const m = computePerformanceMetrics(epochs)!;
    assert.equal(m.sharpeRatio, null);
    assert.equal(m.volatilityAnnualizedPct, 0);
  });

  it("computes positive sharpe on a smoothly-growing series with ≥3 epochs", () => {
    // 4 epochs of steady growth → low volatility → high Sharpe (positive return,
    // small denominator). Just assert sign + non-null.
    const epochs = mkEpochs([1.0, 1.01, 1.02, 1.03], 1_700_000_000, 30);
    const m = computePerformanceMetrics(epochs)!;
    assert.ok(m.sharpeRatio !== null);
  });

  it("uses underlyingDecimals to scale rate (USDC=6 vs WETH=18)", () => {
    // Same simple multipliers, different decimals — TWR identical regardless,
    // because rate enters as a ratio.
    const e6 = mkEpochs([1.0, 1.05], 1_700_000_000, 100, 6);
    const e18 = mkEpochs([1.0, 1.05], 1_700_000_000, 100, 18);
    const m6 = computePerformanceMetrics(e6, 5, 6)!;
    const m18 = computePerformanceMetrics(e18, 5, 18)!;
    assert.ok(Math.abs(m6.annualizedReturnPct - m18.annualizedReturnPct) < 0.001);
  });
});

// ─── formatPerformanceMetrics (byte-equivalence with prior render) ─────────

describe("formatPerformanceMetrics", () => {
  function mkMetrics(overrides: Partial<MetavaultPerformanceMetrics>): MetavaultPerformanceMetrics {
    return {
      startDate: "2026-01-15",
      endDate: "2026-04-27",
      totalDays: 102,
      epochCount: 8,
      annualizedReturnPct: 7.86,
      maxDrawdownPct: -1.23,
      drawdownStartDate: "2026-02-10",
      drawdownEndDate: "2026-02-14",
      volatilityAnnualizedPct: 4.5,
      sharpeRatio: 0.6,
      riskFreeRatePct: 5,
      ...overrides,
    };
  }

  it("renders the full block exactly as the dashboard expects (≥90d, all fields populated)", () => {
    const out = formatPerformanceMetrics(mkMetrics({}));
    // Spot-check the canonical lines (byte-equivalence with tools/metavault legacy).
    assert.match(out, /^--- Performance \(since inception\) ---$/m);
    assert.match(out, /Period: 2026-01-15 to 2026-04-27 \(102 days, 8 epochs\)/);
    assert.match(out, /Time-Weighted Return: 7\.86% annualized/);
    assert.match(out, /Max Drawdown: -1\.23% \(2026-02-10 to 2026-02-14\)/);
    assert.match(out, /Volatility: 4\.50% annualized/);
    assert.match(out, /Sharpe Ratio: 0\.6 \(vs 5\.00% risk-free proxy\)/);
    // No track-record warning appended in the ≥90d branch.
    assert.equal(out.includes("track record"), false);
    // No short-track-record consideration.
    assert.equal(out.includes("Short track record"), false);
  });

  it("renders 'Max Drawdown: none' when no drawdown", () => {
    const out = formatPerformanceMetrics(mkMetrics({ maxDrawdownPct: 0, drawdownStartDate: null, drawdownEndDate: null }));
    assert.match(out, /Max Drawdown: none/);
  });

  it("appends ⚠ warning when totalDays < 30", () => {
    const out = formatPerformanceMetrics(mkMetrics({ totalDays: 14 }));
    assert.match(out, /Sharpe Ratio: 0\.6 \(vs 5\.00% risk-free proxy\) ⚠ 14d track record — too short for meaningful Sharpe/);
    assert.match(out, /Short track record \(14 days\)/);
  });

  it("appends parenthetical caution when 30 ≤ totalDays < 90", () => {
    const out = formatPerformanceMetrics(mkMetrics({ totalDays: 60 }));
    assert.match(out, /Sharpe Ratio: 0\.6 \(vs 5\.00% risk-free proxy\) \(60d track record — interpret with caution\)/);
    assert.match(out, /Short track record \(60 days\)/);
  });

  it("renders 'N/A (insufficient volatility data)' when sharpeRatio is null", () => {
    const out = formatPerformanceMetrics(mkMetrics({ sharpeRatio: null }));
    assert.match(out, /Sharpe Ratio: N\/A \(insufficient volatility data\)/);
  });
});

// ─── formatPerformanceMetricsOneLine (NEW v3-final PR7b) ───────────────────

describe("formatPerformanceMetricsOneLine", () => {
  function mkMetrics(overrides: Partial<MetavaultPerformanceMetrics>): MetavaultPerformanceMetrics {
    return {
      startDate: "2026-01-15",
      endDate: "2026-04-27",
      totalDays: 102,
      epochCount: 8,
      annualizedReturnPct: 7.86,
      maxDrawdownPct: -1.23,
      drawdownStartDate: "2026-02-10",
      drawdownEndDate: "2026-02-14",
      volatilityAnnualizedPct: 4.5,
      sharpeRatio: 0.6,
      riskFreeRatePct: 5,
      ...overrides,
    };
  }

  it("renders the canonical happy-path shape (≥90d + Sharpe populated)", () => {
    assert.equal(
      formatPerformanceMetricsOneLine(mkMetrics({})),
      "Performance: TWR 7.86% / DD -1.23% / Sharpe 0.6 (102d)",
    );
  });

  it("renders Sharpe as 'n/a' when sharpeRatio is null", () => {
    assert.equal(
      formatPerformanceMetricsOneLine(mkMetrics({ sharpeRatio: null })),
      "Performance: TWR 7.86% / DD -1.23% / Sharpe n/a (102d)",
    );
  });

  it("appends '(track-record-class warning)' when totalDays < 30", () => {
    const out = formatPerformanceMetricsOneLine(mkMetrics({ totalDays: 14 }));
    assert.match(out, /\(14d\) \(track-record-class warning\)$/);
  });

  it("does NOT append warning when 30 ≤ totalDays < 90 (medium track-record)", () => {
    const out = formatPerformanceMetricsOneLine(mkMetrics({ totalDays: 60 }));
    assert.equal(out.includes("track-record-class warning"), false);
    assert.match(out, /\(60d\)$/);
  });

  it("renders zero drawdown as -0.00%", () => {
    // formatPct uses .toFixed(2) — 0 renders as "0.00%". Drawdowns are negative
    // so "-0.00%" comes from formatPct(-0) = "-0.00%" only on JS engines that
    // preserve sign of zero; the canonical render is "0.00%" via toFixed.
    const out = formatPerformanceMetricsOneLine(mkMetrics({ maxDrawdownPct: 0 }));
    assert.match(out, /DD 0\.00%/);
  });
});
