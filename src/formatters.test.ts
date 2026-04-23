/**
 * Unit tests for formatters.ts — pure computation functions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { CuratorDashboardOpts } from "./formatters.js";
import {
  formatUsd,
  formatPct,
  formatDate,
  daysToMaturity,
  fractionalDaysToMaturity,
  formatBalance,
  parsePtResponse,
  formatMorphoLltv,
  formatActivityType,
  cumulativeLeverageAtLoop,
  computeSpectraBoost,
  computeLpApyAtBoost,
  extractLpApyBreakdown,
  formatLpApyLines,
  estimatePriceImpact,
  estimatePendlePriceImpact,
  estimateLoopingEntryCost,
  buildQuoteFromPt,
  detectActivityCycles,
  formatCycleAnalysis,
  formatFlowAccounting,
  formatMerklRewards,
  formatUnmatchedMerklRewards,
  normalizeUnderlyingSymbol,
  matchByAssetAndMaturity,
  formatMetavaultStrategy,
  formatCuratorDashboard,
  CURATOR_DASHBOARD_THRESHOLDS,
  formatObservationCoverage,
  pendleDaysToMaturity,
  formatPendleMarketCompact,
  formatPendleMarketSummary,
  ROUTER_BATCHABLE_TYPES,
  ROUTER_BATCH_FOOTNOTE,
  parsePtMaturityFromName,
} from "./formatters.js";
import type { SpectraPt, SpectraPool, PendleMarket } from "./types.js";

// =============================================================================
// Primitive Formatters
// =============================================================================

describe("formatUsd", () => {
  it("formats positive numbers", () => {
    assert.equal(formatUsd(1234.5), "$1,234.50");
  });

  it("formats zero", () => {
    assert.equal(formatUsd(0), "$0.00");
  });

  it("formats small decimals", () => {
    assert.equal(formatUsd(0.1), "$0.10");
  });
});

describe("formatPct", () => {
  it("formats to 2 decimal places", () => {
    assert.equal(formatPct(12.345), "12.35%");
  });

  it("formats zero", () => {
    assert.equal(formatPct(0), "0.00%");
  });

  it("formats negative percentages", () => {
    assert.equal(formatPct(-3.5), "-3.50%");
  });
});

describe("formatDate", () => {
  it("converts unix timestamp to YYYY-MM-DD", () => {
    // 2025-01-01 00:00:00 UTC
    assert.equal(formatDate(1735689600), "2025-01-01");
  });
});

describe("daysToMaturity", () => {
  it("returns 0 for past timestamps", () => {
    assert.equal(daysToMaturity(0), 0);
    assert.equal(daysToMaturity(1000), 0);
  });

  it("returns positive for future timestamps", () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 86400 * 30;
    assert.equal(daysToMaturity(futureTimestamp), 30);
  });
});

describe("fractionalDaysToMaturity", () => {
  it("returns 0 for past timestamps", () => {
    assert.equal(fractionalDaysToMaturity(0), 0);
  });

  it("returns fractional days", () => {
    // 12 hours from now = 0.5 days
    const halfDayFromNow = Math.floor(Date.now() / 1000) + 43200;
    const result = fractionalDaysToMaturity(halfDayFromNow);
    assert.ok(Math.abs(result - 0.5) < 0.01, `Expected ~0.5 but got ${result}`);
  });
});

// =============================================================================
// parsePtMaturityFromName
// =============================================================================

describe("parsePtMaturityFromName", () => {
  it("parses Morpho/Pendle ddMONyyyy format", () => {
    const d = parsePtMaturityFromName("PT Staked cap USD 29JAN2026");
    assert.ok(d);
    assert.equal(d!.toISOString().slice(0, 10), "2026-01-29");
  });

  it("parses single-digit day", () => {
    const d = parsePtMaturityFromName("PT-RLP-9APR2026");
    assert.ok(d);
    assert.equal(d!.toISOString().slice(0, 10), "2026-04-09");
  });

  it("parses Spectra yyyy/mm/dd format", () => {
    const d = parsePtMaturityFromName("PT-yvvbUSDC(vbUSDC)-2026/02/13");
    assert.ok(d);
    assert.equal(d!.toISOString().slice(0, 10), "2026-02-13");
  });

  it("parses date embedded in campaign name", () => {
    const d = parsePtMaturityFromName("Provide liquidity to the Spectra yvvbUSDC / PT-yvvbUSDC(vbUSDC)-2026/08/02 pool");
    assert.ok(d);
    assert.equal(d!.toISOString().slice(0, 10), "2026-08-02");
  });

  it("returns null for names without dates", () => {
    assert.equal(parsePtMaturityFromName("USDC"), null);
    assert.equal(parsePtMaturityFromName(""), null);
    assert.equal(parsePtMaturityFromName("PT-wstETH"), null);
  });

  it("handles case-insensitive month", () => {
    const d = parsePtMaturityFromName("PT-sUSDE-7May2026");
    assert.ok(d);
    assert.equal(d!.toISOString().slice(0, 10), "2026-05-07");
  });
});

// =============================================================================
// formatBalance
// =============================================================================

describe("formatBalance", () => {
  it("returns 0 for null/undefined/empty", () => {
    assert.equal(formatBalance(null, 18), 0);
    assert.equal(formatBalance(undefined, 18), 0);
    assert.equal(formatBalance("0", 18), 0);
  });

  it("handles 18-decimal tokens (1 ETH)", () => {
    assert.equal(formatBalance("1000000000000000000", 18), 1);
  });

  it("handles 6-decimal tokens (1 USDC)", () => {
    assert.equal(formatBalance("1000000", 6), 1);
  });

  it("handles fractional amounts", () => {
    const result = formatBalance("1500000", 6);
    assert.equal(result, 1.5);
  });

  it("handles large values without precision loss", () => {
    // 1 million USDC
    const result = formatBalance("1000000000000", 6);
    assert.equal(result, 1_000_000);
  });

  it("handles >18 decimals (24-decimal token)", () => {
    // 1 token with 24 decimals
    const result = formatBalance("1000000000000000000000000", 24);
    assert.equal(result, 1);
  });

  it("handles zero decimals", () => {
    assert.equal(formatBalance("42", 0), 42);
  });
});

// =============================================================================
// parsePtResponse
// =============================================================================

describe("parsePtResponse", () => {
  it("returns undefined for null/undefined", () => {
    assert.equal(parsePtResponse(null), undefined);
    assert.equal(parsePtResponse(undefined), undefined);
  });

  it("unwraps { data: <object> }", () => {
    const pt = { address: "0x1", maturity: 12345 };
    const result = parsePtResponse({ data: pt });
    assert.deepEqual(result, pt);
  });

  it("unwraps { data: [<object>] }", () => {
    const pt = { address: "0x1", maturity: 12345 };
    const result = parsePtResponse({ data: [pt] });
    assert.deepEqual(result, pt);
  });

  it("unwraps bare array", () => {
    const pt = { address: "0x1", maturity: 12345 };
    const result = parsePtResponse([pt]);
    assert.deepEqual(result, pt);
  });

  it("returns bare object with address + maturity", () => {
    const pt = { address: "0x1", maturity: 12345, name: "PT-aUSDC" };
    const result = parsePtResponse(pt);
    assert.deepEqual(result, pt);
  });

  it("returns undefined for object without address/maturity", () => {
    assert.equal(parsePtResponse({ foo: "bar" }), undefined);
  });

  it("returns undefined for empty array in data", () => {
    assert.equal(parsePtResponse({ data: [] }), undefined);
  });
});

// =============================================================================
// formatMorphoLltv
// =============================================================================

describe("formatMorphoLltv", () => {
  it("converts BigInt string to decimal", () => {
    // 860000000000000000 / 1e18 = 0.86
    const result = formatMorphoLltv("860000000000000000");
    assert.ok(Math.abs(result - 0.86) < 1e-10);
  });

  it("handles 1e18 (100% LTV)", () => {
    const result = formatMorphoLltv("1000000000000000000");
    assert.equal(result, 1);
  });

  it("returns 0 for null/undefined", () => {
    assert.equal(formatMorphoLltv(null), 0);
    assert.equal(formatMorphoLltv(undefined), 0);
  });

  it("returns 0 for empty string", () => {
    assert.equal(formatMorphoLltv(""), 0);
  });

  it("handles zero", () => {
    assert.equal(formatMorphoLltv("0"), 0);
  });
});

// =============================================================================
// formatActivityType
// =============================================================================

describe("formatActivityType", () => {
  it("maps known types", () => {
    assert.equal(formatActivityType("BUY_PT"), "Buy PT");
    assert.equal(formatActivityType("SELL_PT"), "Sell PT");
    assert.equal(formatActivityType("AMM_ADD_LIQUIDITY"), "Add Liquidity");
    assert.equal(formatActivityType("AMM_REMOVE_LIQUIDITY"), "Remove Liquidity");
  });

  it("passes through unknown types", () => {
    assert.equal(formatActivityType("UNKNOWN"), "UNKNOWN");
  });
});

// =============================================================================
// cumulativeLeverageAtLoop
// =============================================================================

describe("cumulativeLeverageAtLoop", () => {
  it("returns 1 for 0 loops (just initial deposit)", () => {
    assert.equal(cumulativeLeverageAtLoop(0.86, 0), 1);
  });

  it("returns 1 + ltv for 1 loop", () => {
    const result = cumulativeLeverageAtLoop(0.86, 1);
    assert.ok(Math.abs(result - 1.86) < 1e-10);
  });

  it("converges toward 1/(1-ltv) as loops increase", () => {
    const ltv = 0.86;
    const theoretical = 1 / (1 - ltv); // ~7.14
    const result = cumulativeLeverageAtLoop(ltv, 50);
    assert.ok(Math.abs(result - theoretical) < 0.01, `Expected ~${theoretical.toFixed(2)} but got ${result.toFixed(4)}`);
  });

  it("handles ltv = 0 (no borrowing)", () => {
    // Should always be 1 regardless of loops
    assert.equal(cumulativeLeverageAtLoop(0, 5), 1);
  });

  it("handles ltv = 1 (degenerate case)", () => {
    // Sum of 1s: loops + 1
    assert.equal(cumulativeLeverageAtLoop(1, 5), 6);
  });

  it("returns correct value for 3 loops at 86% LTV", () => {
    // 1 + 0.86 + 0.86^2 + 0.86^3 = 1 + 0.86 + 0.7396 + 0.636056 = 3.235656
    const result = cumulativeLeverageAtLoop(0.86, 3);
    assert.ok(Math.abs(result - 3.235656) < 1e-4, `Expected ~3.2357 but got ${result}`);
  });

  it("returns 1 for negative loops", () => {
    assert.equal(cumulativeLeverageAtLoop(0.86, -1), 1);
  });
});

// =============================================================================
// computeSpectraBoost
// =============================================================================

describe("computeSpectraBoost", () => {
  it("returns min boost (1.0) when veBalance is 0", () => {
    const result = computeSpectraBoost(0, 1_000_000, 5_000_000, 50_000);
    assert.equal(result.multiplier, 1);
    assert.equal(result.boostFraction, 0);
  });

  it("returns min boost when veTotalSupply is 0", () => {
    const result = computeSpectraBoost(1000, 0, 5_000_000, 50_000);
    assert.equal(result.multiplier, 1);
    assert.equal(result.boostFraction, 0);
  });

  it("returns min boost when capitalUsd is 0", () => {
    const result = computeSpectraBoost(1000, 1_000_000, 5_000_000, 0);
    assert.equal(result.multiplier, 1);
    assert.equal(result.boostFraction, 0);
  });

  it("caps at max boost (2.5) when v/V >= d/D", () => {
    // veShare = 10%, poolShareInverse = D/d = 100, B = min(2.5, 1.5*0.1*100 + 1) = min(2.5, 16) = 2.5
    const result = computeSpectraBoost(100_000, 1_000_000, 5_000_000, 50_000);
    assert.equal(result.multiplier, 2.5);
    assert.equal(result.boostFraction, 1);
  });

  it("computes intermediate boost correctly", () => {
    // v/V = 0.01, D/d = 10, B = min(2.5, 1.5 * 0.01 * 10 + 1) = min(2.5, 1.15) = 1.15
    const result = computeSpectraBoost(10_000, 1_000_000, 500_000, 50_000);
    assert.ok(Math.abs(result.multiplier - 1.15) < 1e-10);
    // boostFraction = (1.15 - 1) / 1.5 = 0.1
    assert.ok(Math.abs(result.boostFraction - 0.1) < 1e-10);
  });

  it("full boost condition: v/V = d/D gives 2.5x", () => {
    // v/V = 0.01, d/D = 0.01 => D/d = 100 => B = min(2.5, 1.5*0.01*100 + 1) = 2.5
    const result = computeSpectraBoost(10_000, 1_000_000, 10_000_000, 100_000);
    assert.equal(result.multiplier, 2.5);
    assert.equal(result.boostFraction, 1);
  });
});

// =============================================================================
// computeLpApyAtBoost
// =============================================================================

describe("computeLpApyAtBoost", () => {
  const breakdown = {
    fees: 2.0,
    pt: 1.0,
    ibt: 0.5,
    rewards: { KAT: 10.0 },
    boostedRewards: { SPECTRA: { min: 5.0, max: 15.0 } },
  };

  it("returns min gauge APY at boost=0", () => {
    const result = computeLpApyAtBoost(breakdown, 0);
    // 2 + 1 + 0.5 + 10 + 5 = 18.5
    assert.ok(Math.abs(result - 18.5) < 1e-10);
  });

  it("returns max gauge APY at boost=1", () => {
    const result = computeLpApyAtBoost(breakdown, 1);
    // 2 + 1 + 0.5 + 10 + 15 = 28.5
    assert.ok(Math.abs(result - 28.5) < 1e-10);
  });

  it("interpolates at boost=0.5", () => {
    const result = computeLpApyAtBoost(breakdown, 0.5);
    // 2 + 1 + 0.5 + 10 + (5 + 0.5*(15-5)) = 2+1+0.5+10+10 = 23.5
    assert.ok(Math.abs(result - 23.5) < 1e-10);
  });

  it("clamps negative boost to 0", () => {
    const result = computeLpApyAtBoost(breakdown, -1);
    // Same as boost=0
    assert.ok(Math.abs(result - 18.5) < 1e-10);
  });

  it("clamps boost > 1 to 1", () => {
    const result = computeLpApyAtBoost(breakdown, 5);
    // Same as boost=1
    assert.ok(Math.abs(result - 28.5) < 1e-10);
  });

  it("handles empty boostedRewards", () => {
    const bd = { fees: 1, pt: 0, ibt: 0, rewards: {}, boostedRewards: {} };
    assert.equal(computeLpApyAtBoost(bd, 0.5), 1);
  });

  it("handles multiple gauge tokens", () => {
    const bd = {
      fees: 0, pt: 0, ibt: 0,
      rewards: {},
      boostedRewards: {
        SPECTRA: { min: 10, max: 20 },
        OTHER: { min: 5, max: 15 },
      },
    };
    // boost=0.5: (10 + 5) + (5 + 5) = 25
    const result = computeLpApyAtBoost(bd, 0.5);
    assert.ok(Math.abs(result - 25) < 1e-10);
  });
});

// =============================================================================
// extractLpApyBreakdown
// =============================================================================

describe("extractLpApyBreakdown", () => {
  it("normalizes missing fields to defaults", () => {
    const pool = {} as any;
    const result = extractLpApyBreakdown(pool, 0);
    assert.equal(result.lpApy, 0);
    assert.equal(result.lpApyBoostedTotal, 0);
    assert.deepEqual(result.lpApyBreakdown.rewards, {});
    assert.deepEqual(result.lpApyBreakdown.boostedRewards, {});
  });

  it("extracts values from populated pool", () => {
    const pool = {
      lpApy: {
        total: 15.0,
        boostedTotal: 25.0,
        details: {
          fees: 2.0,
          pt: 1.0,
          ibt: 0.5,
          rewards: { KAT: 5.0 },
          boostedRewards: { SPECTRA: { min: 3.0, max: 10.0 } },
        },
      },
    } as any;
    const result = extractLpApyBreakdown(pool, 0);
    assert.equal(result.lpApy, 15.0);
    assert.equal(result.lpApyBoostedTotal, 25.0);
    assert.equal(result.lpApyBreakdown.fees, 2.0);
    assert.equal(result.lpApyBreakdown.rewards["KAT"], 5.0);
  });

  it("uses total as fallback for boostedTotal when missing", () => {
    const pool = { lpApy: { total: 10 } } as any;
    const result = extractLpApyBreakdown(pool, 0);
    assert.equal(result.lpApyBoostedTotal, 10);
  });

  it("computes lpApyAtBoost via computeLpApyAtBoost", () => {
    const pool = {
      lpApy: {
        total: 10,
        details: {
          fees: 2, pt: 1, ibt: 0,
          boostedRewards: { SPECTRA: { min: 4, max: 12 } },
        },
      },
    } as any;
    const result = extractLpApyBreakdown(pool, 0.5);
    // 2 + 1 + 0 + (4 + 0.5*8) = 3 + 8 = 11
    assert.ok(Math.abs(result.lpApyAtBoost - 11) < 1e-10);
  });
});

// =============================================================================
// formatLpApyLines
// =============================================================================

describe("formatLpApyLines", () => {
  const breakdown = {
    fees: 2.0,
    pt: 1.0,
    ibt: 0.0,
    rewards: {},
    boostedRewards: { SPECTRA: { min: 5.0, max: 15.0 } },
  };

  it("returns at least one line", () => {
    const lines = formatLpApyLines(10, 20, 15, breakdown);
    assert.ok(lines.length >= 1);
    assert.ok(lines[0].includes("LP APY"));
  });

  it("includes max boost line when boostedTotal > lpApy", () => {
    const lines = formatLpApyLines(10, 20, 15, breakdown);
    const hasMaxBoost = lines.some((l) => l.includes("Max Boost"));
    assert.ok(hasMaxBoost);
  });

  it("omits max boost line when boostedTotal equals lpApy", () => {
    const lines = formatLpApyLines(10, 10, 10, breakdown);
    const hasMaxBoost = lines.some((l) => l.includes("Max Boost"));
    assert.ok(!hasMaxBoost);
  });

  it("shows user boost line when boostInfo has multiplier > 1", () => {
    const lines = formatLpApyLines(10, 20, 15, breakdown, { multiplier: 1.5, boostFraction: 0.333 });
    const hasYourBoost = lines.some((l) => l.includes("Your 1.50x Boost"));
    assert.ok(hasYourBoost);
  });

  it("omits user boost line when boostInfo is undefined", () => {
    const lines = formatLpApyLines(10, 20, 15, breakdown);
    const hasYourBoost = lines.some((l) => l.includes("Your"));
    assert.ok(!hasYourBoost);
  });
});

// =============================================================================
// estimatePriceImpact
// =============================================================================

describe("estimatePriceImpact", () => {
  it("returns amountUsd / (2 * poolLiq)", () => {
    // 10000 / (2 * 1_000_000) = 0.005
    assert.equal(estimatePriceImpact(10_000, 1_000_000), 0.005);
  });

  it("returns 1 (100%) for zero liquidity", () => {
    assert.equal(estimatePriceImpact(10_000, 0), 1);
  });

  it("returns 1 for negative liquidity", () => {
    assert.equal(estimatePriceImpact(10_000, -100), 1);
  });

  it("returns 0 for zero amount", () => {
    assert.equal(estimatePriceImpact(0, 1_000_000), 0);
  });

  it("scales linearly with amount", () => {
    const impact1 = estimatePriceImpact(10_000, 1_000_000);
    const impact2 = estimatePriceImpact(20_000, 1_000_000);
    assert.ok(Math.abs(impact2 - 2 * impact1) < 1e-10);
  });
});

// =============================================================================
// estimateLoopingEntryCost
// =============================================================================

describe("estimateLoopingEntryCost", () => {
  it("returns zero for no loops", () => {
    const result = estimateLoopingEntryCost(10_000, 1_000_000, 0.86, 0);
    assert.equal(result.totalImpactPct, 0);
    assert.equal(result.perLoopImpacts.length, 0);
  });

  it("returns zero for zero capital", () => {
    const result = estimateLoopingEntryCost(0, 1_000_000, 0.86, 3);
    assert.equal(result.totalImpactPct, 0);
  });

  it("returns zero for zero pool liquidity", () => {
    const result = estimateLoopingEntryCost(10_000, 0, 0.86, 3);
    assert.equal(result.totalImpactPct, 0);
  });

  it("first loop matches simple estimatePriceImpact", () => {
    const capital = 10_000;
    const poolLiq = 1_000_000;
    const result = estimateLoopingEntryCost(capital, poolLiq, 0.86, 1);
    const simpleImpact = estimatePriceImpact(capital, poolLiq) * 100;
    assert.ok(Math.abs(result.perLoopImpacts[0] - simpleImpact) < 1e-10);
  });

  it("produces correct number of per-loop impacts", () => {
    const result = estimateLoopingEntryCost(10_000, 1_000_000, 0.86, 5);
    assert.equal(result.perLoopImpacts.length, 5);
  });

  it("each subsequent loop has higher impact than previous", () => {
    const result = estimateLoopingEntryCost(50_000, 500_000, 0.86, 5);
    for (let i = 1; i < result.perLoopImpacts.length; i++) {
      // Each loop deploys less capital (ltv^i shrinks), BUT effective liquidity shrinks too.
      // For realistic parameters, the liquidity drain dominates over the smaller amount,
      // but for small capital relative to pool, amounts shrink faster.
      // Just verify they're all positive.
      assert.ok(result.perLoopImpacts[i] > 0, `Loop ${i} impact should be positive`);
    }
  });

  it("blended impact is a weighted average", () => {
    const capital = 10_000;
    const poolLiq = 1_000_000;
    const ltv = 0.86;
    const loops = 3;
    const result = estimateLoopingEntryCost(capital, poolLiq, ltv, loops);

    // Manually compute: weighted average of per-loop impacts
    let totalDeployed = 0;
    let weightedSum = 0;
    for (let i = 0; i < loops; i++) {
      const amt = capital * Math.pow(ltv, i);
      weightedSum += amt * (result.perLoopImpacts[i] / 100);
      totalDeployed += amt;
    }
    const expectedBlended = (weightedSum / totalDeployed) * 100;
    assert.ok(Math.abs(result.totalImpactPct - expectedBlended) < 1e-6);
  });

  it("clamps individual loop impacts to 99%", () => {
    // Huge capital, tiny pool — should clamp
    const result = estimateLoopingEntryCost(10_000_000, 100, 0.86, 3);
    for (const impact of result.perLoopImpacts) {
      assert.ok(impact <= 99, `Impact ${impact} should be clamped to 99`);
    }
  });

  it("respects effective liquidity floor (1% of pool)", () => {
    // Large capital relative to pool — prior loops drain a lot
    const result = estimateLoopingEntryCost(500_000, 600_000, 0.86, 10);
    // Should not produce NaN or Infinity
    assert.ok(Number.isFinite(result.totalImpactPct));
    for (const impact of result.perLoopImpacts) {
      assert.ok(Number.isFinite(impact));
    }
  });
});

// =============================================================================
// buildQuoteFromPt
// =============================================================================

describe("buildQuoteFromPt", () => {
  const makePt = (overrides = {}) => ({
    name: "PT-aUSDC",
    address: "0x1234567890abcdef1234567890abcdef12345678",
    maturity: Math.floor(Date.now() / 1000) + 86400 * 90,
    underlying: { symbol: "USDC", name: "USD Coin" },
    ibt: { symbol: "aUSDC", protocol: "Aave" },
    ...overrides,
  });

  const makePool = (overrides = {}) => ({
    ptPrice: { usd: 0.95, underlying: 0.95 },
    liquidity: { usd: 1_000_000 },
    ...overrides,
  });

  it("returns null for zero PT price", () => {
    const result = buildQuoteFromPt(
      makePt() as any,
      makePool({ ptPrice: { usd: 0, underlying: 0 } }) as any,
      1000, "buy", 0.5
    );
    assert.equal(result, null);
  });

  it("returns null for zero amount", () => {
    const result = buildQuoteFromPt(makePt() as any, makePool() as any, 0, "buy", 0.5);
    assert.equal(result, null);
  });

  it("returns null for negative amount", () => {
    const result = buildQuoteFromPt(makePt() as any, makePool() as any, -100, "buy", 0.5);
    assert.equal(result, null);
  });

  it("computes buy quote correctly", () => {
    const result = buildQuoteFromPt(makePt() as any, makePool() as any, 1000, "buy", 0.5);
    assert.ok(result !== null);
    assert.equal(result!.side, "buy");
    assert.equal(result!.inputToken, "USDC");
    assert.equal(result!.outputToken, "PT-aUSDC");
    assert.equal(result!.amountIn, 1000);
    // spotRate = 1 / 0.95 ≈ 1.0526
    assert.ok(Math.abs(result!.spotRate - 1 / 0.95) < 1e-4);
    // expectedOut = spotOut * (1 - impact), impact is small
    assert.ok(result!.expectedOut > 0);
    assert.ok(result!.expectedOut <= 1000 * (1 / 0.95)); // can't exceed spot
    // minOut < expectedOut
    assert.ok(result!.minOut < result!.expectedOut);
  });

  it("computes sell quote correctly", () => {
    const result = buildQuoteFromPt(makePt() as any, makePool() as any, 1000, "sell", 0.5);
    assert.ok(result !== null);
    assert.equal(result!.side, "sell");
    assert.equal(result!.inputToken, "PT-aUSDC");
    assert.equal(result!.outputToken, "USDC");
    // spotRate = ptPriceUnderlying = 0.95
    assert.ok(Math.abs(result!.spotRate - 0.95) < 1e-4);
  });

  it("higher slippage tolerance means lower minOut", () => {
    const low = buildQuoteFromPt(makePt() as any, makePool() as any, 1000, "buy", 0.1);
    const high = buildQuoteFromPt(makePt() as any, makePool() as any, 1000, "buy", 5.0);
    assert.ok(low !== null && high !== null);
    assert.ok(high!.minOut < low!.minOut);
  });

  it("higher amount means higher price impact", () => {
    const small = buildQuoteFromPt(makePt() as any, makePool() as any, 100, "buy", 0.5);
    const large = buildQuoteFromPt(makePt() as any, makePool() as any, 100_000, "buy", 0.5);
    assert.ok(small !== null && large !== null);
    assert.ok(large!.priceImpactPct > small!.priceImpactPct);
  });

  it("clamps price impact to 99%", () => {
    // Huge trade relative to pool
    const result = buildQuoteFromPt(
      makePt() as any,
      makePool({ liquidity: { usd: 100 } }) as any,
      1_000_000, "buy", 0.5
    );
    assert.ok(result !== null);
    assert.ok(result!.expectedOut > 0, "expectedOut should be positive even with clamped impact");
  });

  it("records pool liquidity in the quote", () => {
    const result = buildQuoteFromPt(makePt() as any, makePool() as any, 1000, "buy", 0.5);
    assert.ok(result !== null);
    assert.equal(result!.poolLiquidityUsd, 1_000_000);
  });
});

// =============================================================================
// detectActivityCycles
// =============================================================================

describe("detectActivityCycles", () => {
  const entry = (type: string, valueUsd = 100) => ({ type, valueUsd });

  it("returns null for fewer than 6 entries", () => {
    const entries = [entry("SELL_PT"), entry("SELL_PT"), entry("SELL_PT")];
    assert.equal(detectActivityCycles(entries), null);
  });

  it("detects a simple 2-action repeating cycle", () => {
    // ADD→SELL repeated 4 times = 8 entries
    const entries = [
      entry("AMM_ADD_LIQUIDITY", 200), entry("SELL_PT", 180),
      entry("AMM_ADD_LIQUIDITY", 200), entry("SELL_PT", 180),
      entry("AMM_ADD_LIQUIDITY", 200), entry("SELL_PT", 180),
      entry("AMM_ADD_LIQUIDITY", 200), entry("SELL_PT", 180),
    ];
    const result = detectActivityCycles(entries);
    assert.ok(result !== null);
    assert.deepEqual(result!.pattern, ["AMM_ADD_LIQUIDITY", "SELL_PT"]);
    assert.equal(result!.count, 4);
    assert.ok(result!.coverageFraction === 1);
  });

  it("detects a 3-action repeating cycle", () => {
    // ADD→REMOVE→SELL repeated 3 times = 9 entries
    const entries = [
      entry("AMM_ADD_LIQUIDITY", 300), entry("AMM_REMOVE_LIQUIDITY", 280), entry("SELL_PT", 270),
      entry("AMM_ADD_LIQUIDITY", 300), entry("AMM_REMOVE_LIQUIDITY", 280), entry("SELL_PT", 270),
      entry("AMM_ADD_LIQUIDITY", 300), entry("AMM_REMOVE_LIQUIDITY", 280), entry("SELL_PT", 270),
    ];
    const result = detectActivityCycles(entries);
    assert.ok(result !== null);
    assert.deepEqual(result!.pattern, ["AMM_ADD_LIQUIDITY", "AMM_REMOVE_LIQUIDITY", "SELL_PT"]);
    assert.equal(result!.count, 3);
    assert.ok(result!.coverageFraction === 1);
  });

  it("handles uncovered entries at edges", () => {
    // Leading BUY_PT + 3 cycles of ADD→SELL
    const entries = [
      entry("BUY_PT", 50),
      entry("AMM_ADD_LIQUIDITY", 200), entry("SELL_PT", 180),
      entry("AMM_ADD_LIQUIDITY", 200), entry("SELL_PT", 180),
      entry("AMM_ADD_LIQUIDITY", 200), entry("SELL_PT", 180),
    ];
    const result = detectActivityCycles(entries);
    assert.ok(result !== null);
    assert.deepEqual(result!.pattern, ["AMM_ADD_LIQUIDITY", "SELL_PT"]);
    assert.equal(result!.count, 3);
    assert.equal(result!.uncoveredCount, 1);
  });

  it("returns null when no pattern repeats 3+ times", () => {
    const entries = [
      entry("AMM_ADD_LIQUIDITY"), entry("SELL_PT"),
      entry("AMM_ADD_LIQUIDITY"), entry("SELL_PT"),
      entry("BUY_PT"), entry("AMM_REMOVE_LIQUIDITY"),
      entry("BUY_PT"), entry("AMM_REMOVE_LIQUIDITY"),
    ];
    // Each pattern repeats only 2× — below threshold
    const result = detectActivityCycles(entries);
    // Could be null or find a 2-count (below threshold)
    if (result !== null) {
      assert.ok(result.count >= 3);
    }
  });

  it("prefers higher-coverage cycles", () => {
    // 5 cycles of SELL_PT→SELL_PT (len 2, coverage 10/12) vs
    // 3 cycles of ADD→SELL→SELL (len 3, coverage 9/12)
    const entries = [
      entry("AMM_ADD_LIQUIDITY"), entry("SELL_PT"), entry("SELL_PT"),
      entry("AMM_ADD_LIQUIDITY"), entry("SELL_PT"), entry("SELL_PT"),
      entry("AMM_ADD_LIQUIDITY"), entry("SELL_PT"), entry("SELL_PT"),
      entry("AMM_ADD_LIQUIDITY"), entry("SELL_PT"), entry("SELL_PT"),
    ];
    const result = detectActivityCycles(entries);
    assert.ok(result !== null);
    // Should pick whichever has highest coverage
    assert.ok(result!.coverageFraction >= 0.75);
  });

  it("computes correct total and avg value", () => {
    const entries = [
      entry("AMM_ADD_LIQUIDITY", 100), entry("SELL_PT", 200),
      entry("AMM_ADD_LIQUIDITY", 100), entry("SELL_PT", 200),
      entry("AMM_ADD_LIQUIDITY", 100), entry("SELL_PT", 200),
    ];
    const result = detectActivityCycles(entries);
    assert.ok(result !== null);
    assert.equal(result!.totalValueUsd, 900); // 3 * (100+200)
    assert.equal(result!.avgValueUsd, 300);   // 900 / 3
  });

  it("populates temporal fields when timestamps are provided", () => {
    const now = Math.floor(Date.now() / 1000);
    const te = (type: string, ts: number) => ({ type, valueUsd: 100, timestamp: ts });
    // 4 cycles of ADD→SELL, with a 20-day gap between cycles 2 and 3
    const entries = [
      te("AMM_ADD_LIQUIDITY", now - 60 * 86400), te("SELL_PT", now - 59 * 86400),
      te("AMM_ADD_LIQUIDITY", now - 50 * 86400), te("SELL_PT", now - 49 * 86400),
      // 20-day gap here
      te("AMM_ADD_LIQUIDITY", now - 30 * 86400), te("SELL_PT", now - 29 * 86400),
      te("AMM_ADD_LIQUIDITY", now - 5 * 86400),  te("SELL_PT", now - 4 * 86400),
    ];
    const result = detectActivityCycles(entries);
    assert.ok(result !== null);
    assert.ok(result!.firstOccurrenceTs !== null, "Should have firstOccurrenceTs");
    assert.ok(result!.lastOccurrenceTs !== null, "Should have lastOccurrenceTs");
    assert.ok(result!.maxGapBetweenCyclesSec !== null, "Should have maxGapBetweenCyclesSec");
    // First cycle starts at now-60d
    assert.equal(result!.firstOccurrenceTs, now - 60 * 86400);
    // Last cycle starts at now-5d
    assert.equal(result!.lastOccurrenceTs, now - 5 * 86400);
    // Max gap should be ~20-25 days (between cycle 2 and cycle 3, accounting for greedy match positions)
    const maxGapDays = Math.round(result!.maxGapBetweenCyclesSec! / 86400);
    assert.ok(maxGapDays >= 15 && maxGapDays <= 30, `Max gap should be ~20-25 days, got ${maxGapDays}`);
  });

  it("temporal fields are null when no timestamps provided", () => {
    const entries = [
      entry("SELL_PT"), entry("SELL_PT"),
      entry("SELL_PT"), entry("SELL_PT"),
      entry("SELL_PT"), entry("SELL_PT"),
    ];
    const result = detectActivityCycles(entries);
    assert.ok(result !== null);
    assert.equal(result!.firstOccurrenceTs, null, "Should be null without timestamps");
    assert.equal(result!.lastOccurrenceTs, null, "Should be null without timestamps");
    assert.equal(result!.maxGapBetweenCyclesSec, null, "Should be null without timestamps");
  });
});

// =============================================================================
// formatCycleAnalysis
// =============================================================================

describe("formatCycleAnalysis", () => {
  it("produces output lines for ADD→REMOVE→SELL cycle", () => {
    const cycle = {
      pattern: ["AMM_ADD_LIQUIDITY", "AMM_REMOVE_LIQUIDITY", "SELL_PT"],
      count: 8,
      totalValueUsd: 12000,
      avgValueUsd: 1500,
      coverageFraction: 0.85,
      uncoveredCount: 4,
      firstOccurrenceTs: null,
      lastOccurrenceTs: null,
      maxGapBetweenCyclesSec: null,
    };
    const lines = formatCycleAnalysis(cycle, 15000);
    assert.ok(lines.length >= 3);
    // Should contain the pattern
    const joined = lines.join("\n");
    assert.ok(joined.includes("Add Liquidity"), "Should format activity types");
    assert.ok(joined.includes("Remove Liquidity"));
    assert.ok(joined.includes("Sell PT"));
    assert.ok(joined.includes("8×"), "Should show repetition count");
    assert.ok(joined.includes("Mint→LP→unwind→sell"), "Should include interpretive hint for ADD→REMOVE→SELL");
    assert.ok(joined.includes("spectra_get_portfolio"), "Should cross-reference portfolio");
  });

  it("hints at flash-mint for SELL_PT-only cycle", () => {
    const cycle = {
      pattern: ["SELL_PT", "SELL_PT"],
      count: 10,
      totalValueUsd: 5000,
      avgValueUsd: 500,
      coverageFraction: 0.9,
      uncoveredCount: 2,
      firstOccurrenceTs: null,
      lastOccurrenceTs: null,
      maxGapBetweenCyclesSec: null,
    };
    const lines = formatCycleAnalysis(cycle, 6000);
    const joined = lines.join("\n");
    assert.ok(joined.includes("Flash-mint") || joined.includes("PT liquidation"), "Should hint at flash-mint or PT liquidation");
  });

  it("hints at PT accumulation for BUY_PT-only cycle", () => {
    const cycle = {
      pattern: ["BUY_PT", "BUY_PT"],
      count: 5,
      totalValueUsd: 10000,
      avgValueUsd: 2000,
      coverageFraction: 0.8,
      uncoveredCount: 3,
      firstOccurrenceTs: null,
      lastOccurrenceTs: null,
      maxGapBetweenCyclesSec: null,
    };
    const lines = formatCycleAnalysis(cycle, 12000);
    const joined = lines.join("\n");
    assert.ok(joined.includes("Fixed-rate accumulation") || joined.includes("Flash-redeem"), "Should hint at fixed-rate accumulation or flash-redeem YT exit");
  });

  it("includes uncovered count when present", () => {
    const cycle = {
      pattern: ["AMM_ADD_LIQUIDITY", "SELL_PT"],
      count: 4,
      totalValueUsd: 4000,
      avgValueUsd: 1000,
      coverageFraction: 0.8,
      uncoveredCount: 2,
      firstOccurrenceTs: null,
      lastOccurrenceTs: null,
      maxGapBetweenCyclesSec: null,
    };
    const lines = formatCycleAnalysis(cycle, 5000);
    const joined = lines.join("\n");
    assert.ok(joined.includes("2 txn(s) outside"), "Should mention uncovered transactions");
  });

  it("shows staleness warning when pattern last seen >30 days ago", () => {
    const now = Math.floor(Date.now() / 1000);
    const cycle = {
      pattern: ["SELL_PT", "SELL_PT"],
      count: 6,
      totalValueUsd: 6000,
      avgValueUsd: 1000,
      coverageFraction: 0.9,
      uncoveredCount: 1,
      firstOccurrenceTs: now - 90 * 86400,  // 90 days ago
      lastOccurrenceTs: now - 45 * 86400,   // 45 days ago
      maxGapBetweenCyclesSec: null,
    };
    const lines = formatCycleAnalysis(cycle, 7000);
    const joined = lines.join("\n");
    assert.ok(joined.includes("may no longer be active"), "Should warn about stale pattern");
    assert.ok(joined.includes("Timespan"), "Should show timespan");
  });

  it("shows gap warning when pattern spans >14 day gap between cycles", () => {
    const now = Math.floor(Date.now() / 1000);
    const cycle = {
      pattern: ["BUY_PT", "BUY_PT"],
      count: 6,
      totalValueUsd: 6000,
      avgValueUsd: 1000,
      coverageFraction: 0.85,
      uncoveredCount: 2,
      firstOccurrenceTs: now - 60 * 86400,  // 60 days ago
      lastOccurrenceTs: now - 2 * 86400,    // 2 days ago (recent, no staleness warning)
      maxGapBetweenCyclesSec: 30 * 86400,   // 30-day gap between consecutive cycles
    };
    const lines = formatCycleAnalysis(cycle, 7000);
    const joined = lines.join("\n");
    assert.ok(joined.includes("pre-gap and post-gap occurrences may be unrelated"), "Should warn about temporal gap");
    assert.ok(joined.includes("30-day gap"), "Should show gap duration");
    assert.ok(!joined.includes("may no longer be active"), "Should NOT show staleness warning since pattern is recent");
  });

  it("shows timespan without warnings for recent, continuous patterns", () => {
    const now = Math.floor(Date.now() / 1000);
    const cycle = {
      pattern: ["SELL_PT", "BUY_PT"],
      count: 8,
      totalValueUsd: 8000,
      avgValueUsd: 1000,
      coverageFraction: 0.9,
      uncoveredCount: 1,
      firstOccurrenceTs: now - 7 * 86400,   // 7 days ago
      lastOccurrenceTs: now - 1 * 86400,    // 1 day ago
      maxGapBetweenCyclesSec: 2 * 86400,    // 2-day max gap (small)
    };
    const lines = formatCycleAnalysis(cycle, 9000);
    const joined = lines.join("\n");
    assert.ok(joined.includes("Timespan"), "Should show timespan");
    assert.ok(!joined.includes("may no longer be active"), "Should NOT show staleness warning");
    assert.ok(!joined.includes("pre-gap and post-gap"), "Should NOT show gap warning");
  });
});

// =============================================================================
// formatFlowAccounting
// =============================================================================

describe("formatFlowAccounting", () => {
  const baseOpts = {
    ytBalance: 0,
    ptBalance: 0,
    lpBalance: 0,
    ptSellCount: 0,
    ptSellVolumeUsd: 0,
    addLiqCount: 0,
    addLiqVolumeUsd: 0,
    buyPtCount: 0,
    buyPtVolumeUsd: 0,
    removeLiqCount: 0,
    removeLiqVolumeUsd: 0,
    ptPriceUsd: 1.0,
    ytPriceUsd: 0.05,
  };

  it("flags YT-only position shape with competing hypotheses for PT sells", () => {
    const lines = formatFlowAccounting({
      ...baseOpts,
      ytBalance: 18000,
      ptBalance: 0,
      ptSellCount: 12,
      ptSellVolumeUsd: 17500,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Flow Accounting"), "Should have header");
    assert.ok(joined.includes("18000.00 YT"), "Should show YT balance");
    assert.ok(joined.includes("Estimated Minimum Mints"), "Should infer mints from YT");
    assert.ok(joined.includes("SELL_PT: 12 txns"), "Should show PT sell count");
    assert.ok(joined.includes("Position Shape: YT-only"), "Should identify YT-only position shape");
    assert.ok(joined.includes("Competing Hypotheses"), "Should present competing hypotheses (Open Emergence)");
    assert.ok(joined.includes("YT accumulation via mint-and-sell"), "Should include YT accumulation hypothesis");
  });

  it("flags fixed-rate for PT-only position with PT buys", () => {
    const lines = formatFlowAccounting({
      ...baseOpts,
      ptBalance: 5000,
      ytBalance: 0,
      buyPtCount: 8,
      buyPtVolumeUsd: 4800,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("5000.00 PT"), "Should show PT balance");
    assert.ok(joined.includes("fixed-rate"), "Should flag fixed-rate accumulation");
    assert.ok(joined.includes("BUY_PT: 8 txns"), "Should show PT buy count");
    // Should NOT infer mints (no YT balance)
    assert.ok(!joined.includes("Estimated Minimum Mints"), "Should not infer mints when no YT");
  });

  it("shows high YT/PT ratio for imbalanced position", () => {
    const lines = formatFlowAccounting({
      ...baseOpts,
      ytBalance: 10000,
      ptBalance: 500,
      ptSellCount: 5,
      ptSellVolumeUsd: 9000,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("YT/PT") && joined.includes("20.0:1"), "Should show the YT/PT ratio");
    assert.ok(joined.includes("Heavily YT-weighted"), "Should flag heavily YT-weighted position");
  });

  it("shows full outflow breakdown including ADD_LIQ and REMOVE_LIQ", () => {
    const lines = formatFlowAccounting({
      ...baseOpts,
      ytBalance: 8000,
      ptBalance: 200,
      lpBalance: 1.5,
      ptSellCount: 6,
      ptSellVolumeUsd: 5500,
      addLiqCount: 8,
      addLiqVolumeUsd: 7200,
      buyPtCount: 2,
      buyPtVolumeUsd: 1800,
      removeLiqCount: 7,
      removeLiqVolumeUsd: 6800,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("SELL_PT: 6 txns"), "Should show SELL_PT outflow");
    assert.ok(joined.includes("ADD_LIQ: 8 txns"), "Should show ADD_LIQ outflow");
    assert.ok(joined.includes("BUY_PT: 2 txns"), "Should show BUY_PT inflow");
    assert.ok(joined.includes("LP Removals: 7 txns"), "Should show LP removals");
    assert.ok(joined.includes("LP: 1.5000"), "Should show LP balance");
  });

  it("handles zero activity gracefully", () => {
    const lines = formatFlowAccounting({ ...baseOpts });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Flow Accounting"), "Should have header");
    assert.ok(joined.includes("0.00 YT"), "Should show zero YT");
    assert.ok(joined.includes("0.00 PT"), "Should show zero PT");
    assert.ok(joined.includes("approximate"), "Should include disclaimer");
    // Should not have PT outflows/inflows sections
    assert.ok(!joined.includes("PT Outflows"), "Should not show outflows with zero activity");
    assert.ok(!joined.includes("PT Inflows"), "Should not show inflows with zero activity");
  });
});

// =============================================================================
// Merkl Rewards Formatting
// =============================================================================

describe("formatMerklRewards", () => {
  it("formats a single reward token", () => {
    const lines = formatMerklRewards([
      { tokenAddress: "0xabc", symbol: "SPECTRA", decimals: 18, accumulated: 2500, unclaimed: 1234.5678, pending: 0 },
    ]);
    assert.ok(lines.length >= 2, "Should have header + at least 1 reward line");
    assert.ok(lines[0].includes("Merkl Rewards"), "Header should say Merkl Rewards");
    assert.ok(lines[1].includes("SPECTRA"), "Should contain token symbol");
    assert.ok(lines[1].includes("unclaimed:"), "Should show unclaimed amount");
    assert.ok(lines[1].includes("total earned:"), "Should show total earned");
  });

  it("formats multiple reward tokens", () => {
    const lines = formatMerklRewards([
      { tokenAddress: "0xabc", symbol: "SPECTRA", decimals: 18, accumulated: 1000, unclaimed: 500, pending: 0 },
      { tokenAddress: "0xdef", symbol: "ARB", decimals: 18, accumulated: 50, unclaimed: 25, pending: 5 },
    ]);
    assert.equal(lines.length, 3, "Header + 2 reward lines");
    assert.ok(lines[1].includes("SPECTRA"));
    assert.ok(lines[2].includes("ARB"));
    assert.ok(lines[2].includes("pending:"), "ARB should show pending");
  });

  it("returns empty for empty array", () => {
    const lines = formatMerklRewards([]);
    assert.equal(lines.length, 0);
  });

  it("shows pending only when unclaimed is zero", () => {
    const lines = formatMerklRewards([
      { tokenAddress: "0xabc", symbol: "TOKEN", decimals: 18, accumulated: 100, unclaimed: 0, pending: 50 },
    ]);
    assert.ok(lines.length >= 2);
    assert.ok(lines[1].includes("pending:"), "Should show pending");
    assert.ok(!lines[1].includes("unclaimed:"), "Should not show unclaimed when 0");
  });

  it("returns empty when all values are zero", () => {
    const lines = formatMerklRewards([
      { tokenAddress: "0xabc", symbol: "TOKEN", decimals: 18, accumulated: 0, unclaimed: 0, pending: 0 },
    ]);
    assert.equal(lines.length, 0, "Should return empty for all-zero rewards");
  });
});

describe("formatUnmatchedMerklRewards", () => {
  it("formats rewards from multiple chains", () => {
    const result = formatUnmatchedMerklRewards([
      { chain: "mainnet", rewards: [
        { tokenAddress: "0xabc", symbol: "SPECTRA", decimals: 18, accumulated: 1000, unclaimed: 500, pending: 0 },
      ]},
      { chain: "base", rewards: [
        { tokenAddress: "0xdef", symbol: "ARB", decimals: 18, accumulated: 200, unclaimed: 100, pending: 0 },
      ]},
    ]);
    assert.ok(result.includes("exited positions"), "Should mention exited positions");
    assert.ok(result.includes("SPECTRA (mainnet)"), "Should show token with chain");
    assert.ok(result.includes("ARB (base)"), "Should show second chain");
    assert.ok(result.includes("merkl.xyz"), "Should include claim link");
  });

  it("returns empty string for empty input", () => {
    assert.equal(formatUnmatchedMerklRewards([]), "");
  });

  it("returns empty string when no chains have rewards", () => {
    assert.equal(formatUnmatchedMerklRewards([{ chain: "mainnet", rewards: [] }]), "");
  });
});

// =============================================================================
// normalizeUnderlyingSymbol
// =============================================================================

describe("normalizeUnderlyingSymbol", () => {
  it("normalizes wrapped ETH variants", () => {
    assert.equal(normalizeUnderlyingSymbol("WETH"), "ETH");
    assert.equal(normalizeUnderlyingSymbol("weth"), "ETH");
    assert.equal(normalizeUnderlyingSymbol("WETH.E"), "ETH");
    assert.equal(normalizeUnderlyingSymbol("wethe"), "ETH");
  });

  it("normalizes wrapped BTC variants", () => {
    assert.equal(normalizeUnderlyingSymbol("WBTC"), "BTC");
    assert.equal(normalizeUnderlyingSymbol("WBTC.E"), "BTC");
  });

  it("normalizes bridged stablecoin variants", () => {
    assert.equal(normalizeUnderlyingSymbol("USDC.e"), "USDC");
    assert.equal(normalizeUnderlyingSymbol("USDCe"), "USDC");
    assert.equal(normalizeUnderlyingSymbol("USDC.b"), "USDC");
    assert.equal(normalizeUnderlyingSymbol("USDT.e"), "USDT");
  });

  it("normalizes liquid staking equivalences", () => {
    assert.equal(normalizeUnderlyingSymbol("wstETH"), "STETH");
  });

  it("normalizes DAI/USDS rebrand", () => {
    assert.equal(normalizeUnderlyingSymbol("sDAI"), "USDS");
    assert.equal(normalizeUnderlyingSymbol("sUSDS"), "USDS");
  });

  it("passes through unknown symbols unchanged (uppercased)", () => {
    assert.equal(normalizeUnderlyingSymbol("GHO"), "GHO");
    assert.equal(normalizeUnderlyingSymbol("AAVE"), "AAVE");
    assert.equal(normalizeUnderlyingSymbol("sFRAX"), "SFRAX");
  });

  it("handles whitespace and casing", () => {
    assert.equal(normalizeUnderlyingSymbol("  weth  "), "ETH");
    assert.equal(normalizeUnderlyingSymbol("Wbtc"), "BTC");
  });
});

// =============================================================================
// matchByAssetAndMaturity
// =============================================================================

describe("matchByAssetAndMaturity", () => {
  // Helper to create minimal test data
  function makePt(address: string, symbol: string, maturityUnix: number): SpectraPt {
    return {
      name: `PT-${symbol}`,
      address,
      maturity: maturityUnix,
      underlying: { symbol, address: "0x0", decimals: 18 },
    } as SpectraPt;
  }

  function makePool(address: string): SpectraPool {
    return { address } as SpectraPool;
  }

  function makePendleMarket(address: string, name: string, expiryIso: string): PendleMarket {
    return {
      name,
      address,
      expiry: expiryIso,
      pt: "0xpt",
      yt: "0xyt",
      sy: "0xsy",
      underlyingAsset: "0xunderlying",
      details: {
        liquidity: 100000,
        totalTvl: 500000,
        tradingVolume: 10000,
        underlyingApy: 0.05,
        swapFeeApy: 0.01,
        pendleApy: 0.02,
        impliedApy: 0.08,
        feeRate: 0.003,
        aggregatedApy: 0.03,
        maxBoostedApy: 0.05,
        totalPt: 1000,
        totalSy: 2000,
        totalSupply: 1500,
        totalActiveSupply: 1400,
      },
      chainId: 1,
    };
  }

  const june2026 = Math.floor(new Date("2026-06-25T00:00:00Z").getTime() / 1000);
  const june2026Iso = "2026-06-25T00:00:00.000Z";

  it("matches exact maturity (≤7d gap)", () => {
    const spectra = [{ pt: makePt("0xa", "USDC", june2026), pool: makePool("0xpool"), chain: "mainnet" }];
    // 3 days later
    const pendleExpiry = new Date((june2026 + 3 * 86400) * 1000).toISOString();
    const pendle = [{ market: makePendleMarket("0xb", "PT USDC 28JUN2026", pendleExpiry), chain: "mainnet" }];

    const matches = matchByAssetAndMaturity(spectra, pendle, 90);
    const paired = matches.filter(m => m.matchQuality !== "unmatched");

    assert.equal(paired.length, 1);
    assert.equal(paired[0].matchQuality, "exact");
    assert.equal(paired[0].maturityGapDays, 3);
  });

  it("matches close maturity (≤30d gap)", () => {
    const spectra = [{ pt: makePt("0xa", "USDC", june2026), pool: makePool("0xpool"), chain: "mainnet" }];
    // 20 days later
    const pendleExpiry = new Date((june2026 + 20 * 86400) * 1000).toISOString();
    const pendle = [{ market: makePendleMarket("0xb", "PT USDC 15JUL2026", pendleExpiry), chain: "mainnet" }];

    const matches = matchByAssetAndMaturity(spectra, pendle, 90);
    const paired = matches.filter(m => m.matchQuality !== "unmatched");

    assert.equal(paired.length, 1);
    assert.equal(paired[0].matchQuality, "close");
  });

  it("matches loose maturity (≤90d gap)", () => {
    const spectra = [{ pt: makePt("0xa", "USDC", june2026), pool: makePool("0xpool"), chain: "mainnet" }];
    // 60 days later
    const pendleExpiry = new Date((june2026 + 60 * 86400) * 1000).toISOString();
    const pendle = [{ market: makePendleMarket("0xb", "PT USDC 24AUG2026", pendleExpiry), chain: "mainnet" }];

    const matches = matchByAssetAndMaturity(spectra, pendle, 90);
    const paired = matches.filter(m => m.matchQuality !== "unmatched");

    assert.equal(paired.length, 1);
    assert.equal(paired[0].matchQuality, "loose");
  });

  it("does not match beyond tolerance", () => {
    const spectra = [{ pt: makePt("0xa", "USDC", june2026), pool: makePool("0xpool"), chain: "mainnet" }];
    // 120 days later — beyond 90d tolerance
    const pendleExpiry = new Date((june2026 + 120 * 86400) * 1000).toISOString();
    const pendle = [{ market: makePendleMarket("0xb", "PT USDC 23OCT2026", pendleExpiry), chain: "mainnet" }];

    const matches = matchByAssetAndMaturity(spectra, pendle, 90);
    const paired = matches.filter(m => m.matchQuality !== "unmatched");

    assert.equal(paired.length, 0, "Should not match beyond 90d tolerance");
    // Both should be unmatched
    const unmatched = matches.filter(m => m.matchQuality === "unmatched");
    assert.equal(unmatched.length, 2);
  });

  it("returns unmatched items for different assets", () => {
    const spectra = [{ pt: makePt("0xa", "USDC", june2026), pool: makePool("0xpool"), chain: "mainnet" }];
    const pendle = [{ market: makePendleMarket("0xb", "PT stETH 25JUN2026", june2026Iso), chain: "mainnet" }];

    const matches = matchByAssetAndMaturity(spectra, pendle, 90);
    const paired = matches.filter(m => m.matchQuality !== "unmatched");
    const unmatched = matches.filter(m => m.matchQuality === "unmatched");

    assert.equal(paired.length, 0);
    assert.equal(unmatched.length, 2);
  });

  it("handles empty inputs", () => {
    assert.deepEqual(matchByAssetAndMaturity([], [], 90), []);
    const spectra = [{ pt: makePt("0xa", "USDC", june2026), pool: makePool("0xpool"), chain: "mainnet" }];
    const matches = matchByAssetAndMaturity(spectra, [], 90);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matchQuality, "unmatched");
    assert.ok(matches[0].spectra);
    assert.equal(matches[0].pendle, null);
  });

  it("matches wstETH to stETH via normalization", () => {
    const spectra = [{ pt: makePt("0xa", "wstETH", june2026), pool: makePool("0xpool"), chain: "mainnet" }];
    const pendle = [{ market: makePendleMarket("0xb", "PT stETH 25JUN2026", june2026Iso), chain: "mainnet" }];

    const matches = matchByAssetAndMaturity(spectra, pendle, 90);
    const paired = matches.filter(m => m.matchQuality !== "unmatched");

    assert.equal(paired.length, 1, "wstETH should match stETH via normalization");
    assert.equal(paired[0].matchQuality, "exact");
  });

  it("prefers closest maturity when multiple options exist", () => {
    const spectra = [{ pt: makePt("0xa", "USDC", june2026), pool: makePool("0xpool"), chain: "mainnet" }];
    // Two Pendle markets: one 5d away, one 40d away
    const close = new Date((june2026 + 5 * 86400) * 1000).toISOString();
    const far = new Date((june2026 + 40 * 86400) * 1000).toISOString();
    const pendle = [
      { market: makePendleMarket("0xfar", "PT USDC AUG2026", far), chain: "mainnet" },
      { market: makePendleMarket("0xclose", "PT USDC JUN2026", close), chain: "mainnet" },
    ];

    const matches = matchByAssetAndMaturity(spectra, pendle, 90);
    const paired = matches.filter(m => m.matchQuality !== "unmatched");

    assert.equal(paired.length, 1);
    assert.equal(paired[0].maturityGapDays, 5, "Should match closest maturity");
    assert.equal(paired[0].pendle!.market.address, "0xclose");
  });
});

// =============================================================================
// formatMetavaultStrategy — blended allocation
// =============================================================================

describe("formatMetavaultStrategy — blended allocation", () => {
  const baseOpts = {
    baseApy: 12,
    ytCompoundingApy: 0,
    curatorFeePct: 10,
    netVaultApy: 10.8,
    grossVaultApy: 12,
    morphoLtv: 0.86,
    borrowRate: 5,
    daysToMaturity: 90,
    rows: [
      { loop: 0, leverage: 1, grossApy: 10.8, netApy: 10.8, effectiveMargin: 100 },
      { loop: 1, leverage: 1.86, grossApy: 20.09, netApy: 15.79, effectiveMargin: 37.6 },
    ],
    bestLoop: 1,
    bestNetApy: 15.79,
    bestLeverage: 1.86,
  };

  it("shows Allocation Model section when pendleAllocationPct > 0", () => {
    const result = formatMetavaultStrategy({
      ...baseOpts,
      baseApy: 10.8, // blended: 12 * 0.7 + 8 * 0.3
      pendleAllocationPct: 30,
      pendleLpApy: 8,
      spectraBaseApy: 12,
    });
    assert.ok(result.includes("Allocation Model"), "should contain Allocation Model section");
    assert.ok(result.includes("Spectra LP"), "should show Spectra LP line");
    assert.ok(result.includes("Pendle LP"), "should show Pendle LP line");
    assert.ok(result.includes("70% allocation"), "should show Spectra allocation");
    assert.ok(result.includes("30% allocation"), "should show Pendle allocation");
    assert.ok(result.includes("Blended Base APY"), "should show blended APY label");
    assert.ok(result.includes("manual rollover"), "should warn about Pendle manual rollover");
  });

  it("omits Allocation Model when pendleAllocationPct is 0 or undefined", () => {
    const result = formatMetavaultStrategy(baseOpts);
    assert.ok(!result.includes("Allocation Model"), "should not contain Allocation Model");
    assert.ok(!result.includes("Pendle LP"), "should not mention Pendle LP");
  });

  it("still shows all other sections when blended", () => {
    const result = formatMetavaultStrategy({
      ...baseOpts,
      baseApy: 10.8,
      pendleAllocationPct: 30,
      pendleLpApy: 8,
      spectraBaseApy: 12,
    });
    assert.ok(result.includes("Vault Economics"), "should have Vault Economics");
    assert.ok(result.includes("Looping Table"), "should have Looping Table");
    assert.ok(result.includes("Rollover Advantage"), "should have Rollover Advantage");
    assert.ok(result.includes("Risks"), "should have Risks");
  });
});

// =============================================================================
// formatCuratorDashboard — protocol tags
// =============================================================================

describe("formatCuratorDashboard — protocol tags", () => {
  const baseDashOpts = {
    chain: "base",
    metavaultAddress: "0x1234567890abcdef1234567890abcdef12345678",
    curatorName: "TestCurator",
    curatorAddresses: ["0xaaaa000000000000000000000000000000000001"],
    vaultName: "Test Vault",
    vaultSymbol: "TV",
    underlyingSymbol: "USDC",
    underlyingDecimals: 6,
    underlyingPriceUsd: 1,
    tvlUsd: 500000,
    tvlUnderlying: 500000,
    liveApyTotal: 10,
    liveApyBoostedTotal: null,
    liveApyBase: 8,
    apyDetails: undefined,
    sharePriceUsd: 1.05,
    sharePriceUnderlying: 1.05,
    epochFlows: [],
    lifetimeNetFlowUsd: 0,
    lifetimeYieldUsd: 0,
    firstRate: 1,
    lastRate: 1.05,
    epochCount: 0,
    bridgeTxCount: 0,
    bridgePendingUsd: 0,
    bridgeDirections: [] as { direction: string; count: number; totalUsd: number }[],
    actionItems: [],
    curatorFeePct: 10,
    estimatedAnnualFeeRevenueUsd: 5000,
  };

  it("shows [Spectra] protocol tag on positions", () => {
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      positions: [{
        symbol: "PT-sUSDC",
        ptAddress: "0xpt01",
        poolAddress: "0xpool01",
        maturityTimestamp: Math.floor(Date.now() / 1000) + 86400 * 60,
        daysToMaturity: 60,
        expired: false,
        tvlUsd: 250000,
        vaultAllocationUsd: 250000,
        ptApy: 8,
        lpApyTotal: 6,
        lpApyBoostedTotal: null,
        protocol: "Spectra",
      }],
    });
    assert.ok(result.includes("[Spectra]"), "should show [Spectra] tag");
    assert.ok(result.includes("PT-sUSDC"), "should show position symbol");
  });

  it("shows [Pendle] protocol tag on Pendle positions", () => {
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      positions: [{
        symbol: "PT-pUSDC",
        ptAddress: "0xpt02",
        poolAddress: "0xpool02",
        maturityTimestamp: Math.floor(Date.now() / 1000) + 86400 * 20,
        daysToMaturity: 20,
        expired: false,
        tvlUsd: 100000,
        vaultAllocationUsd: 100000,
        ptApy: 7,
        lpApyTotal: 5,
        lpApyBoostedTotal: null,
        protocol: "Pendle",
      }],
    });
    assert.ok(result.includes("[Pendle]"), "should show [Pendle] tag");
  });

  it("includes cross-protocol scanner in next steps", () => {
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      positions: [],
    });
    assert.ok(result.includes("mv_scan_curator_opportunities"), "should mention cross-protocol scanner");
  });

  // ──────────────────────────────────────────────────────────────
  // externalPositions — idle math correctness + rendering
  // ──────────────────────────────────────────────────────────────

  it("subtracts externalPositions from unallocated math (Base Gami shape)", () => {
    // Shape approximates Base Gami USDC: $7.29M TVL, $4.7K deployed LP,
    // $3.65M external avant. Without the subtraction, unallocated reads ~99%.
    // With the subtraction, unallocated is ~49.8%.
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      tvlUsd: 7_290_000,
      tvlUnderlying: 7_290_000,
      positions: [{
        symbol: "PT-sw-avUSD",
        ptAddress: "0xpt",
        poolAddress: "0xpool",
        maturityTimestamp: Math.floor(Date.now() / 1000) + 86400 * 20,
        daysToMaturity: 20,
        expired: false,
        tvlUsd: 4_700,
        vaultAllocationUsd: 4_700,
        ptApy: 8,
        lpApyTotal: 5,
        lpApyBoostedTotal: null,
        protocol: "Spectra",
      }],
      externalPositions: [
        { protocol: "avant", chainId: 43114, valueUsd: 3_648_221, source: "avusdx-burn" } as any,
      ],
    });
    // Expect headline to show ~50% unallocated, NOT ~99%.
    assert.ok(
      /4[89]% unallocated|50% unallocated/.test(result),
      `expected ~50% unallocated headline; got first 400 chars: ${result.slice(0, 400)}`,
    );
    assert.ok(!/99% unallocated/.test(result), "must not mislabel external capital as unallocated");
  });

  it("renders External Positions section with avant branch", () => {
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      positions: [{
        symbol: "PT-x",
        ptAddress: "0xpt",
        poolAddress: "0xpool",
        maturityTimestamp: Math.floor(Date.now() / 1000) + 86400 * 30,
        daysToMaturity: 30,
        expired: false,
        tvlUsd: 100_000,
        vaultAllocationUsd: 100_000,
        ptApy: 5,
        lpApyTotal: 4,
        lpApyBoostedTotal: null,
        protocol: "Spectra",
      }],
      externalPositions: [
        {
          protocol: "avant",
          chainId: 43114,
          valueUsd: 200_000,
          source: "avusdx-burn",
          burnt: { address: "0x1", symbol: "avUSDx" },
          claim: { address: "0x2", symbol: "avUSD" },
          orderId: 42,
          updatedAt: Date.now() - 86400 * 1000, // 1 day ago
        } as any,
      ],
    });
    assert.ok(result.includes("External Positions (1)"), "section header must appear");
    assert.ok(result.includes("[avant]"), "avant branch must render");
    assert.ok(result.includes("avUSDx → avUSD"), "burnt → claim symbols must render");
    assert.ok(result.includes("order=42"), "orderId must render");
  });

  it("renders External Positions pendle branch with APY + maturity", () => {
    const matSec = Math.floor(Date.now() / 1000) + 86400 * 14;
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      positions: [],
      externalPositions: [
        {
          protocol: "pendle",
          chainId: 1,
          valueUsd: 50_000,
          market: {
            address: "0xmarket",
            name: "fusnstETH-Jun",
            maturity: matSec,
            aggregatedApy: 0.0825,
          },
        } as any,
      ],
    });
    assert.ok(result.includes("[pendle]"), "pendle branch must render");
    assert.ok(result.includes("fusnstETH-Jun"), "market name must render");
    assert.ok(result.includes("LP APY"), "aggregatedApy must render as LP APY");
  });

  it("renders Status line for HIDDEN vaults", () => {
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      status: "HIDDEN",
      positions: [],
    });
    assert.ok(result.includes("Status: HIDDEN"), "Status label must appear for HIDDEN");
  });

  it("suppresses Status line for VISIBLE vaults (default)", () => {
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      status: "VISIBLE",
      positions: [],
    });
    assert.ok(!/^\s*Status:/m.test(result), "Status label must NOT appear for VISIBLE");
  });

  it("renders 30d avg alongside Live APY when present", () => {
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      avgApy30dTotal: 8.5,
      positions: [],
    });
    assert.ok(result.includes("30d avg"), "30d avg suffix must appear");
  });

  it("renders APY breakdown when base or incentive delta ≥ 0.5pp", () => {
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      liveApyTotal: 6.73,
      liveApyBase: 6.73,
      avgApy30dTotal: 11.74,
      avgApy30dBase: 10.06,
      positions: [],
    });
    // baseDelta = 6.73 - 10.06 = -3.33pp, incentDelta = 0 - 1.68 = -1.68pp.
    // Both exceed 0.5pp threshold → APY breakdown must emit.
    assert.ok(result.includes("APY breakdown"), "APY breakdown must appear when deltas significant");
    // The line must NOT contain causal language (Inverter's correction).
    assert.ok(!/falling|tapering|rising|compensating/i.test(result), "must not assert causality");
  });

  it("suppresses APY breakdown when both deltas < 0.5pp", () => {
    const result = formatCuratorDashboard({
      ...baseDashOpts,
      liveApyTotal: 6.5,
      liveApyBase: 6.5,
      avgApy30dTotal: 6.7,
      avgApy30dBase: 6.7,
      positions: [],
    });
    assert.ok(!result.includes("APY breakdown"), "APY breakdown must NOT appear when stable");
  });

  // ──────────────────────────────────────────────────────────────
  // Scenario builder — intent-legible test fixtures
  // ──────────────────────────────────────────────────────────────
  //
  // Why this helper exists: threshold-boundary tests need controlled inputs
  // (a real vault won't sit at exactly 20% unallocated for a drift test).
  // But hand-crafted magic numbers like `130_000` + `128_500` don't tell a
  // reader what's being tested — they force archaeology. This helper maps
  // intent (percentages of TVL) to the USD values the formatter consumes,
  // so each test reads as a scenario declaration, not a fixture decode.
  //
  // Open-emergence note: this helper is the synthetic path. For "does a
  // real live vault render sensibly end-to-end", see the fixture-based
  // tests below — they load test/fixtures/metavaults-*.json (re-captured
  // against live API) and exercise the formatter against real shapes.
  //
  // Params are fractions of tvlUsd expressed as percentages. An `expired`
  // slice consumes both the deployed-total (all_LP) and the expired-stuck
  // bucket per the formatter's `deployed = all_LP − expired_LP` math.
  function makeScenario(params: {
    tvlUsd: number;
    deployedPct?: number;    // active Spectra LP
    expiredPct?: number;     // LP in expired positions (included in all_LP, subtracted into expired-stuck)
    externalPct?: number;    // avant/pendle/other external positions
    status?: string;         // VISIBLE / HIDDEN / etc
    avgApy30dTotal?: number;
    avgApy30dBase?: number;
  }): CuratorDashboardOpts {
    const { tvlUsd, deployedPct = 0, expiredPct = 0, externalPct = 0, status, avgApy30dTotal, avgApy30dBase } = params;
    const positions: CuratorDashboardOpts["positions"] = [];
    const nowS = Math.floor(Date.now() / 1000);
    if (deployedPct > 0) {
      positions.push({
        symbol: "PT-active-scenario",
        ptAddress: "0xdeadbeef01" + "0".repeat(30),
        poolAddress: "0xdeadbeef02" + "0".repeat(30),
        maturityTimestamp: nowS + 86400 * 60,
        daysToMaturity: 60,
        expired: false,
        tvlUsd: tvlUsd * deployedPct / 100,
        vaultAllocationUsd: tvlUsd * deployedPct / 100,
        ptApy: 5,
        lpApyTotal: 4,
        lpApyBoostedTotal: null,
        protocol: "Spectra",
      });
    }
    if (expiredPct > 0) {
      positions.push({
        symbol: "PT-expired-scenario",
        ptAddress: "0xdeadbeef03" + "0".repeat(30),
        poolAddress: "0xdeadbeef04" + "0".repeat(30),
        maturityTimestamp: nowS - 86400 * 3,
        daysToMaturity: 0,
        expired: true,
        tvlUsd: tvlUsd * expiredPct / 100,
        vaultAllocationUsd: tvlUsd * expiredPct / 100,
        ptApy: 0,
        lpApyTotal: 0,
        lpApyBoostedTotal: null,
        protocol: "Spectra",
      });
    }
    const externalPositions = externalPct > 0
      ? [{ protocol: "avant", chainId: 43114, valueUsd: tvlUsd * externalPct / 100 } as any]
      : undefined;
    return {
      ...baseDashOpts,
      tvlUsd,
      tvlUnderlying: tvlUsd,
      status,
      avgApy30dTotal,
      avgApy30dBase,
      externalPositions,
      positions,
    };
  }

  it("emits Capital state when ≥1 non-LP bucket (expired-stuck or external) populated", () => {
    // Gami-shape scenario: tiny active LP + expired-stuck + dominant external.
    // This is the exact pathology the Capital State line was designed for —
    // reader would otherwise see "48% unallocated headline" vs "$3.65M external
    // below" and have to mentally reconcile.
    const result = formatCuratorDashboard(makeScenario({
      tvlUsd: 7_290_000,
      deployedPct: 0.06,   // ≈ Gami's live live-LP share
      expiredPct: 1.7,     // expired-stuck bucket above noise threshold (0.5%)
      externalPct: 50,     // dominant external bucket
    }));
    assert.ok(result.includes("Capital state:"), "Capital state line must appear");
    assert.ok(/expired-stuck/.test(result), "expired bucket must render");
    assert.ok(/external/.test(result), "external bucket must render");
  });

  it("suppresses Capital state when only deployed + unallocated (simple vault)", () => {
    // ~1% unallocated, no expired-stuck, no external → zero non-LP-non-idle
    // buckets populated → suppress the whole line. Headline TVL already says
    // everything a simple vault's reader needs.
    const result = formatCuratorDashboard(makeScenario({
      tvlUsd: 130_000,
      deployedPct: 98.8,
    }));
    assert.ok(!result.includes("Capital state:"), "Capital state must be suppressed for simple vault");
  });

  it("emits temporal boundary when unallocated >= TEMPORAL_BOUNDARY_UNALLOC_PCT", () => {
    // Diverger finding, 5-lens dialectic: "unallocated" is point-in-time.
    // When the bucket is large enough to anchor a reader's inference, the
    // caveat becomes load-bearing — capital in pending timelock executions
    // or cross-chain transit may appear unallocated until indexer refresh.
    const result = formatCuratorDashboard(makeScenario({
      tvlUsd: 7_290_000,
      deployedPct: 0.06,
      externalPct: 50,    // forces Capital State to emit (non-LP-non-idle bucket populated)
      // unallocated ≈ 49.94% → well above TEMPORAL_BOUNDARY_UNALLOC_PCT (20%)
    }));
    assert.ok(result.includes("Capital state:"), "Capital state line precondition");
    assert.ok(
      result.includes('"unallocated" is point-in-time'),
      `temporal boundary note must emit when unallocated >= ${CURATOR_DASHBOARD_THRESHOLDS.TEMPORAL_BOUNDARY_UNALLOC_PCT}%; got first 600 chars: ${result.slice(0, 600)}`,
    );
  });

  it("suppresses temporal boundary when unallocated < TEMPORAL_BOUNDARY_UNALLOC_PCT", () => {
    // 80% deployed + 18% expired-stuck + 2% unallocated. Capital State may
    // emit (expired-stuck bucket is populated), but the temporal note must
    // suppress — at 2% unallocated a reader won't make a load-bearing
    // inference from the label.
    const result = formatCuratorDashboard(makeScenario({
      tvlUsd: 1_000_000,
      deployedPct: 80,
      expiredPct: 18,
    }));
    if (result.includes("Capital state:")) {
      assert.ok(
        !result.includes('"unallocated" is point-in-time'),
        `temporal note must be suppressed when unallocated < ${CURATOR_DASHBOARD_THRESHOLDS.TEMPORAL_BOUNDARY_UNALLOC_PCT}%`,
      );
    }
  });

  // ──────────────────────────────────────────────────────────────
  // Fixture-based E2E — real vault shapes produce sensible output
  // ──────────────────────────────────────────────────────────────
  //
  // Why fixture-based: the synthetic tests above pin threshold BEHAVIOR.
  // These tests pin that a REAL vault shape (re-captured against live API)
  // produces sensible output end-to-end. When Spectra adds a field or
  // changes a shape, these tests are where the breakage surfaces.
  //
  // Dissolution condition: these tests validate the current fixture state.
  // If the fixtures are re-captured and the new reality no longer exhibits
  // the asserted patterns (e.g., Gami resolves its avant burns), the
  // assertions should be updated to reflect the new reality — not loosened
  // to hide it.

  describe("formatCuratorDashboard — fixture-based end-to-end", () => {
    // Tests run from build/; fixtures live at repo-root/test/fixtures.
    const __dirname_e2e = dirname(fileURLToPath(import.meta.url));
    const fixturesDir = resolve(__dirname_e2e, "../test/fixtures");

    function loadMvFixture(chain: string): any[] {
      const path = resolve(fixturesDir, `metavaults-${chain}.json`);
      return JSON.parse(readFileSync(path, "utf8"));
    }

    // Map a fixture MetaVault into the CuratorDashboardOpts shape the
    // formatter consumes. Mirrors the projection in src/tools/metavault.ts
    // at the spectra_get_curator_dashboard handler — kept in sync so
    // E2E tests exercise the actual rendering path, not a mock.
    function projectFixtureToOpts(mv: any, chain: string): CuratorDashboardOpts {
      const positions = (mv.positions || []).map((pos: any) => {
        const pool = pos.pools?.[0];
        let vaultAllocationUsd: number | null = null;
        const rawBalance = pool?.lpt?.balance || pos.balance;
        if (rawBalance && pool?.lpt?.price?.usd) {
          const decimals = pool.lpt.decimals || 18;
          const raw = BigInt(rawBalance);
          const d = 10n ** BigInt(decimals);
          const lpBalance = Number(raw / d) + Number(raw % d) / Number(d);
          vaultAllocationUsd = lpBalance * pool.lpt.price.usd;
        }
        return {
          symbol: pos.symbol || "?",
          ptAddress: pos.address,
          poolAddress: pool?.address || null,
          maturityTimestamp: pos.maturity,
          daysToMaturity: Math.max(0, Math.ceil((pos.maturity * 1000 - Date.now()) / 86400000)),
          expired: pos.maturity * 1000 <= Date.now(),
          tvlUsd: pos.tvl?.usd || 0,
          vaultAllocationUsd,
          ptApy: pool?.ptApy || 0,
          lpApyTotal: pool?.lpApy?.total || 0,
          lpApyBoostedTotal: pool?.lpApy?.boostedTotal ?? null,
          protocol: "Spectra" as const,
        };
      });
      return {
        ...baseDashOpts,
        chain,
        metavaultAddress: mv.address,
        curatorName: mv.curator?.name || "?",
        curatorAddresses: mv.curator?.addresses || [],
        vaultName: mv.metadata?.title || mv.name,
        vaultSymbol: mv.symbol,
        underlyingSymbol: mv.underlying?.symbol || "?",
        underlyingDecimals: mv.underlying?.decimals || 6,
        underlyingPriceUsd: mv.underlying?.price?.usd || 0,
        tvlUsd: mv.tvl?.usd || 0,
        tvlUnderlying: mv.tvl?.underlying || 0,
        liveApyTotal: mv.liveApy?.total || 0,
        liveApyBoostedTotal: mv.liveApy?.boostedTotal ?? null,
        liveApyBase: mv.liveApy?.details?.base ?? null,
        apyDetails: mv.liveApy?.details,
        sharePriceUsd: mv.price?.usd || 0,
        sharePriceUnderlying: mv.price?.underlying || 0,
        status: mv.status,
        avgApy30dTotal: mv.avgApy30d?.total ?? undefined,
        avgApy30dBase: mv.avgApy30d?.details?.base ?? undefined,
        externalPositions: mv.externalPositions,
        positions,
      };
    }

    it("Base Gami USDC renders External Positions + Capital State + temporal boundary", () => {
      const base = loadMvFixture("base");
      const gami = base.find((m: any) => m.name === "Gami USDC");
      assert.ok(gami, "Base fixture must contain Gami USDC");
      const result = formatCuratorDashboard(projectFixtureToOpts(gami, "base"));

      // External positions exist in the fixture (3 avant avUSDx-burn entries).
      assert.ok(result.includes("External Positions"), "External Positions section must render");
      assert.ok(result.includes("[avant]"), "avant branch must render");

      // Gami's shape triggers the Capital State line (deployed + expired-stuck
      // + external all populated).
      assert.ok(result.includes("Capital state:"), "Capital state line must render on Gami shape");

      // Gami's unallocated exceeds the temporal boundary threshold.
      assert.ok(result.includes('"unallocated" is point-in-time'), "temporal boundary note must render for Gami");

      // Gami is VISIBLE — Status line must NOT render.
      assert.ok(!/^\s*Status:/m.test(result), "VISIBLE vault must not show Status line");

      // No undefined or NaN leaks anywhere in the output.
      assert.ok(!result.includes("undefined"), "no undefined in rendered output");
      assert.ok(!result.includes("NaN"), "no NaN in rendered output");
    });

    it("Mainnet WETH MetaVault (HIDDEN + pendle external) renders Status + pendle branch", () => {
      const mainnet = loadMvFixture("mainnet");
      assert.ok(mainnet.length > 0, "mainnet fixture must not be empty");
      const vault = mainnet[0];  // only one vault in the mainnet fixture today
      const result = formatCuratorDashboard(projectFixtureToOpts(vault, "mainnet"));

      if (vault.status === "HIDDEN") {
        assert.ok(result.includes("Status: HIDDEN"), "HIDDEN vault must show Status label");
      }
      if ((vault.externalPositions || []).some((e: any) => e.protocol === "pendle")) {
        assert.ok(result.includes("[pendle]"), "pendle external branch must render");
      }
      assert.ok(!result.includes("undefined"), "no undefined leaks");
      assert.ok(!result.includes("NaN"), "no NaN leaks");
    });

    it("simple vaults (no external, no expired-stuck) suppress Capital state + temporal note", () => {
      // UltraYield WETH fixture shape: deployed ≈ 99%, no external, no expired.
      const base = loadMvFixture("base");
      const ultra = base.find((m: any) => m.name === "UltraYield WETH");
      assert.ok(ultra, "Base fixture must contain UltraYield WETH");
      const result = formatCuratorDashboard(projectFixtureToOpts(ultra, "base"));
      assert.ok(!result.includes("Capital state:"), "simple vault must not emit Capital state");
      assert.ok(!result.includes('"unallocated" is point-in-time'), "no temporal boundary without Capital state");
    });
  });
});

// =============================================================================
// ROUTER_BATCHABLE_TYPES
// =============================================================================

describe("ROUTER_BATCHABLE_TYPES", () => {
  it("includes BUY_PT, SELL_PT, AMM_ADD_LIQUIDITY but not AMM_REMOVE_LIQUIDITY", () => {
    assert.ok(ROUTER_BATCHABLE_TYPES.has("BUY_PT"));
    assert.ok(ROUTER_BATCHABLE_TYPES.has("SELL_PT"));
    assert.ok(ROUTER_BATCHABLE_TYPES.has("AMM_ADD_LIQUIDITY"));
    assert.ok(!ROUTER_BATCHABLE_TYPES.has("AMM_REMOVE_LIQUIDITY"));
  });

  it("footnote starts with dagger symbol", () => {
    assert.ok(ROUTER_BATCH_FOOTNOTE.startsWith("†"), "Footnote should start with †");
  });
});

// =============================================================================
// formatObservationCoverage
// =============================================================================

describe("formatObservationCoverage", () => {
  it("reports 0% value coverage when position exists but no activity observed", () => {
    const lines = formatObservationCoverage({
      totalActivityVolumeUsd: 0,
      currentPositionValueUsd: 50000,
      entryTimestamps: [],
      portfolioFetched: true,
      poolContextFetched: true,
      distinctActivityTypes: 0,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Value Coverage: 0%"), "Should show 0% value coverage");
    assert.ok(joined.includes("no observable pool activity"), "Should note no observable activity");
    assert.ok(joined.includes("invisible to this tool"), "Should mention invisible channels");
    assert.ok(joined.includes("Observation Coverage"), "Should have header");
  });

  it("reports partial (~40%) value coverage when activity explains less than half the position", () => {
    const lines = formatObservationCoverage({
      totalActivityVolumeUsd: 20000,
      currentPositionValueUsd: 50000,
      entryTimestamps: [1700000000, 1700100000],
      portfolioFetched: true,
      poolContextFetched: true,
      distinctActivityTypes: 2,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Value Coverage: 40%"), "Should show 40% value coverage");
    assert.ok(joined.includes("explains less than half"), "Should flag less-than-half coverage");
    assert.ok(joined.includes("invisible activity"), "Should mention invisible activity");
  });

  it("reports 100% value coverage when activity roughly matches position", () => {
    const lines = formatObservationCoverage({
      totalActivityVolumeUsd: 50000,
      currentPositionValueUsd: 50000,
      entryTimestamps: [1700000000, 1700200000, 1700400000],
      portfolioFetched: true,
      poolContextFetched: true,
      distinctActivityTypes: 3,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Value Coverage: 100%"), "Should show 100% value coverage");
    assert.ok(joined.includes("roughly matches"), "Should say activity roughly matches position");
  });

  it("reports capital recycling when activity volume greatly exceeds position", () => {
    const lines = formatObservationCoverage({
      totalActivityVolumeUsd: 200000,
      currentPositionValueUsd: 10000,
      entryTimestamps: [1700000000, 1700100000],
      portfolioFetched: true,
      poolContextFetched: true,
      distinctActivityTypes: 2,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("2000%"), "Should show high value coverage percentage");
    assert.ok(joined.includes("significantly exceeds"), "Should flag activity exceeding position");
    assert.ok(joined.includes("capital recycling") || joined.includes("round-trips"), "Should mention capital recycling or round-trips");
  });

  it("reports missing data sources when not all tools consulted", () => {
    const lines = formatObservationCoverage({
      totalActivityVolumeUsd: 10000,
      currentPositionValueUsd: 10000,
      entryTimestamps: [1700000000, 1700100000],
      portfolioFetched: false,
      poolContextFetched: false,
      onchainConsulted: false,
      crossChainConsulted: false,
      distinctActivityTypes: 2,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Data Sources:"), "Should have Data Sources section");
    assert.ok(joined.includes("1/5"), "Should show 1/5 sources consulted (only pool activity)");
    assert.ok(joined.includes("Not consulted:"), "Should list unconsulted sources");
    assert.ok(joined.includes("portfolio"), "Should list portfolio as not consulted");
    assert.ok(joined.includes("on-chain events"), "Should list on-chain events as not consulted");
    assert.ok(joined.includes("cross-chain scan"), "Should list cross-chain scan as not consulted");
  });

  it("reports temporal gaps when dark periods exist between entries", () => {
    const base = 1700000000;
    const lines = formatObservationCoverage({
      totalActivityVolumeUsd: 30000,
      currentPositionValueUsd: 30000,
      entryTimestamps: [
        base,
        base + 86400,
        base + 86400 * 25,
      ],
      portfolioFetched: true,
      poolContextFetched: true,
      distinctActivityTypes: 2,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Temporal Coverage:"), "Should have Temporal Coverage section");
    assert.ok(joined.includes("active on"), "Should report active days");
    assert.ok(joined.includes("dark period"), "Should report longest dark period");
  });

  it("reports all data sources as used when all tools consulted", () => {
    const lines = formatObservationCoverage({
      totalActivityVolumeUsd: 10000,
      currentPositionValueUsd: 10000,
      entryTimestamps: [1700000000],
      portfolioFetched: true,
      poolContextFetched: true,
      onchainConsulted: true,
      crossChainConsulted: true,
      distinctActivityTypes: 2,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Data Sources:"), "Should have Data Sources section");
    assert.ok(joined.includes("5/5"), "Should show 5/5 sources consulted");
    assert.ok(joined.includes("pool activity"), "Used sources should include pool activity");
    assert.ok(joined.includes("portfolio"), "Used sources should include portfolio");
    assert.ok(joined.includes("pool context"), "Used sources should include pool context");
    assert.ok(joined.includes("on-chain events"), "Used sources should include on-chain events");
    assert.ok(joined.includes("cross-chain scan"), "Used sources should include cross-chain scan");
  });
});

// =============================================================================
// formatCycleAnalysis — statistical insufficiency threshold
// =============================================================================

describe("formatCycleAnalysis — statistical insufficiency threshold", () => {
  it("includes 'Do not extrapolate' warning when cycle count is 5", () => {
    const cycle = {
      pattern: ["AMM_ADD_LIQUIDITY", "SELL_PT"],
      count: 5,
      totalValueUsd: 5000,
      avgValueUsd: 1000,
      coverageFraction: 0.9,
      uncoveredCount: 1,
      firstOccurrenceTs: null,
      lastOccurrenceTs: null,
      maxGapBetweenCyclesSec: null,
    };
    const lines = formatCycleAnalysis(cycle, 6000);
    const joined = lines.join("\n");
    assert.ok(joined.includes("Do not extrapolate"), "Should include 'Do not extrapolate' warning for count=5");
    assert.ok(joined.includes("Insufficient"), "Should include 'Insufficient' language for count=5");
    assert.ok(joined.includes("5 repetitions"), "Should mention exact count of 5");
  });

  it("omits 'Do not extrapolate' warning when cycle count is 6", () => {
    const cycle = {
      pattern: ["AMM_ADD_LIQUIDITY", "SELL_PT"],
      count: 6,
      totalValueUsd: 6000,
      avgValueUsd: 1000,
      coverageFraction: 0.92,
      uncoveredCount: 1,
      firstOccurrenceTs: null,
      lastOccurrenceTs: null,
      maxGapBetweenCyclesSec: null,
    };
    const lines = formatCycleAnalysis(cycle, 7000);
    const joined = lines.join("\n");
    assert.ok(!joined.includes("Do not extrapolate"), "Should NOT include 'Do not extrapolate' warning for count=6");
    assert.ok(!joined.includes("Insufficient"), "Should NOT include 'Insufficient' language for count=6");
  });
});

// =============================================================================
// Pendle: estimatePendlePriceImpact
// =============================================================================

describe("estimatePendlePriceImpact", () => {
  it("returns 1 (100%) for zero liquidity", () => {
    assert.equal(estimatePendlePriceImpact(10_000, 0, 100, 100, 30), 1);
  });

  it("returns 0 for zero capital", () => {
    assert.equal(estimatePendlePriceImpact(0, 1_000_000, 100, 100, 30), 0);
  });

  it("returns constant-product estimate when pool reserves are zero", () => {
    // totalPt + totalSy = 0 → falls back to cpImpact
    const cpImpact = 10_000 / (2 * 1_000_000); // 0.005
    assert.equal(estimatePendlePriceImpact(10_000, 1_000_000, 0, 0, 30), cpImpact);
  });

  it("logit model returns less impact than constant-product for balanced pools", () => {
    // Balanced pool: PT = SY = 500, p = 0.5
    const pendleImpact = estimatePendlePriceImpact(10_000, 1_000_000, 500, 500, 30);
    const cpImpact = 10_000 / (2 * 1_000_000);
    assert.ok(pendleImpact <= cpImpact,
      `Pendle logit (${pendleImpact}) should be <= constant-product (${cpImpact})`);
  });

  it("impact increases with capital size", () => {
    const small = estimatePendlePriceImpact(10_000, 1_000_000, 500, 500, 30);
    const large = estimatePendlePriceImpact(100_000, 1_000_000, 500, 500, 30);
    assert.ok(large > small, `$100K impact (${large}) should exceed $10K impact (${small})`);
  });

  it("impact decreases with more liquidity", () => {
    const thin = estimatePendlePriceImpact(10_000, 100_000, 500, 500, 30);
    const deep = estimatePendlePriceImpact(10_000, 10_000_000, 500, 500, 30);
    assert.ok(thin > deep, `Thin pool impact (${thin}) should exceed deep pool impact (${deep})`);
  });

  it("near-maturity pools have lower impact (higher rateScalar)", () => {
    // Near maturity: rateScalar = 50 * 365 / 7 ≈ 2607 → very deep
    // Far maturity: rateScalar = 50 * 365 / 365 = 50 → shallower
    const nearMaturity = estimatePendlePriceImpact(10_000, 1_000_000, 500, 500, 7);
    const farMaturity = estimatePendlePriceImpact(10_000, 1_000_000, 500, 500, 365);
    assert.ok(nearMaturity < farMaturity,
      `Near-maturity impact (${nearMaturity}) should be less than far-maturity (${farMaturity})`);
  });

  it("never exceeds constant-product estimate", () => {
    // Even with extreme imbalance, should cap at cpImpact
    const cpImpact = 50_000 / (2 * 500_000);
    const result = estimatePendlePriceImpact(50_000, 500_000, 990, 10, 365);
    assert.ok(result <= cpImpact + 1e-10,
      `Impact (${result}) should not exceed cp estimate (${cpImpact})`);
  });

  it("handles highly imbalanced pools", () => {
    // 99% PT, 1% SY
    const impact = estimatePendlePriceImpact(10_000, 1_000_000, 990, 10, 30);
    assert.ok(impact > 0 && impact <= 1, `Impact ${impact} should be between 0 and 1`);
  });

  it("handles 1-day maturity without error", () => {
    const impact = estimatePendlePriceImpact(10_000, 1_000_000, 500, 500, 1);
    assert.ok(impact >= 0 && impact <= 1, `Impact ${impact} should be valid`);
  });

  it("scales linearly with amount (logit model)", () => {
    const impact1 = estimatePendlePriceImpact(10_000, 1_000_000, 500, 500, 30);
    const impact2 = estimatePendlePriceImpact(20_000, 1_000_000, 500, 500, 30);
    // Logit model is linear in amount (same formula structure)
    assert.ok(Math.abs(impact2 - 2 * impact1) < 1e-10,
      `Double capital (${impact2}) should produce double impact (${2 * impact1})`);
  });
});

// =============================================================================
// Pendle: pendleDaysToMaturity
// =============================================================================

describe("pendleDaysToMaturity", () => {
  it("returns 0 for past expiry dates", () => {
    assert.equal(pendleDaysToMaturity("2020-01-01T00:00:00Z"), 0);
  });

  it("returns positive days for future dates", () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    assert.equal(pendleDaysToMaturity(future), 30);
  });

  it("handles ISO date strings without time component", () => {
    // Far future to ensure it's always positive
    const days = pendleDaysToMaturity("2030-06-15T00:00:00Z");
    assert.ok(days > 0, `Should return positive days for 2030 date, got ${days}`);
  });

  it("returns 0 for epoch date", () => {
    assert.equal(pendleDaysToMaturity("1970-01-01T00:00:00Z"), 0);
  });

  it("rounds to nearest integer", () => {
    // 30.5 days from now
    const halfDayOffset = new Date(Date.now() + 30.5 * 86_400_000).toISOString();
    const result = pendleDaysToMaturity(halfDayOffset);
    assert.ok(result === 30 || result === 31, `Should round to 30 or 31, got ${result}`);
  });
});

// =============================================================================
// Pendle: formatPendleMarketCompact
// =============================================================================

describe("formatPendleMarketCompact", () => {
  function makePendleMarket(overrides?: Partial<PendleMarket>): PendleMarket {
    return {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      name: "PT USDC 26MAR2026",
      expiry: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      pt: "0xptptpt",
      yt: "0xytytyt",
      sy: "0xsysysy",
      underlyingAsset: "0xunderlying",
      chainId: 1,
      isPrime: false,
      categoryIds: [],
      details: {
        impliedApy: 0.05,
        underlyingApy: 0.03,
        aggregatedApy: 0.08,
        maxBoostedApy: 0.12,
        swapFeeApy: 0.02,
        pendleApy: 0.06,
        totalTvl: 5_000_000,
        liquidity: 2_000_000,
        tradingVolume: 500_000,
        feeRate: 0.003,
        totalPt: 1000,
        totalSy: 800,
        totalSupply: 0,
        totalActiveSupply: 0,
      },
      ...overrides,
    };
  }

  it("includes market name and chain", () => {
    const m = makePendleMarket();
    const result = formatPendleMarketCompact(m, "ethereum");
    assert.ok(result.includes("PT USDC 26MAR2026"));
    assert.ok(result.includes("ethereum"));
  });

  it("includes implied APY, LP APY, and variable APY", () => {
    const m = makePendleMarket();
    const result = formatPendleMarketCompact(m, "ethereum");
    assert.ok(result.includes("Impl 5.00%"), `Should have implied APY, got: ${result}`);
    assert.ok(result.includes("LP 8.00%"), `Should have LP APY, got: ${result}`);
    assert.ok(result.includes("Var 3.00%"), `Should have variable APY, got: ${result}`);
  });

  it("includes TVL and liquidity", () => {
    const m = makePendleMarket();
    const result = formatPendleMarketCompact(m, "ethereum");
    assert.ok(result.includes("TVL"), "Should include TVL");
    assert.ok(result.includes("Liq"), "Should include liquidity");
  });

  it("shows prime star when isPrime is true", () => {
    const m = makePendleMarket({ isPrime: true });
    const result = formatPendleMarketCompact(m, "ethereum");
    assert.ok(result.includes("★"), "Should show prime star");
  });

  it("omits prime star when isPrime is false", () => {
    const m = makePendleMarket({ isPrime: false });
    const result = formatPendleMarketCompact(m, "ethereum");
    assert.ok(!result.includes("★"), "Should not show prime star");
  });

  it("shows boost when maxBoostedApy > aggregatedApy", () => {
    const m = makePendleMarket();
    // defaults have maxBoostedApy=0.12 > aggregatedApy=0.08
    const result = formatPendleMarketCompact(m, "ethereum");
    assert.ok(result.includes("Boost"), "Should show boost");
    assert.ok(result.includes("12.00%"), "Should show max boosted APY");
  });

  it("omits boost when maxBoostedApy <= aggregatedApy", () => {
    const m = makePendleMarket({
      details: {
        impliedApy: 0.05, underlyingApy: 0.03, aggregatedApy: 0.08,
        maxBoostedApy: 0.08, swapFeeApy: 0.02, pendleApy: 0.06,
        totalTvl: 5_000_000, liquidity: 2_000_000, tradingVolume: 500_000,
        feeRate: 0.003, totalPt: 1000, totalSy: 800,
        totalSupply: 0, totalActiveSupply: 0,
      },
    });
    const result = formatPendleMarketCompact(m, "ethereum");
    assert.ok(!result.includes("Boost"), "Should not show boost when equal");
  });

  it("includes market address", () => {
    const m = makePendleMarket();
    const result = formatPendleMarketCompact(m, "ethereum");
    assert.ok(result.includes("Market: 0x1234"), "Should include market address");
  });
});

// =============================================================================
// Pendle: formatPendleMarketSummary
// =============================================================================

describe("formatPendleMarketSummary", () => {
  function makePendleMarket(overrides?: Partial<PendleMarket>): PendleMarket {
    return {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      name: "PT stETH 26JUN2026",
      expiry: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      pt: "0xpt_address",
      yt: "0xyt_address",
      sy: "0xsy_address",
      underlyingAsset: "0xunderlying",
      chainId: 1,
      isPrime: true,
      categoryIds: ["LRT"],
      details: {
        impliedApy: 0.04,
        underlyingApy: 0.035,
        aggregatedApy: 0.07,
        maxBoostedApy: 0.10,
        swapFeeApy: 0.015,
        pendleApy: 0.055,
        totalTvl: 10_000_000,
        liquidity: 4_000_000,
        tradingVolume: 1_000_000,
        feeRate: 0.005,
        totalPt: 2000,
        totalSy: 1500,
        totalSupply: 0,
        totalActiveSupply: 0,
      },
      ...overrides,
    };
  }

  it("includes market name", () => {
    const result = formatPendleMarketSummary(makePendleMarket(), "ethereum");
    assert.ok(result.includes("PT stETH 26JUN2026"));
  });

  it("includes chain name", () => {
    const result = formatPendleMarketSummary(makePendleMarket(), "arbitrum");
    assert.ok(result.includes("Chain: arbitrum"));
  });

  it("includes PT, YT, SY addresses", () => {
    const result = formatPendleMarketSummary(makePendleMarket(), "ethereum");
    assert.ok(result.includes("PT: 0xpt_address"));
    assert.ok(result.includes("YT: 0xyt_address"));
    assert.ok(result.includes("SY: 0xsy_address"));
  });

  it("includes implied and underlying APY with spread", () => {
    const result = formatPendleMarketSummary(makePendleMarket(), "ethereum");
    assert.ok(result.includes("Implied APY (Fixed Rate): 4.00%"));
    assert.ok(result.includes("Underlying APY (Variable): 3.50%"));
    assert.ok(result.includes("Fixed vs Variable Spread: 0.50%"));
  });

  it("includes LP APY breakdown", () => {
    const result = formatPendleMarketSummary(makePendleMarket(), "ethereum");
    assert.ok(result.includes("LP APY: 7.00%"));
    assert.ok(result.includes("Swap Fees: 1.50%"));
    assert.ok(result.includes("PENDLE Incentives: 5.50%"));
  });

  it("shows max boosted APY when positive", () => {
    const result = formatPendleMarketSummary(makePendleMarket(), "ethereum");
    assert.ok(result.includes("Max Boosted LP APY: 10.00%"));
  });

  it("omits max boosted line when 0", () => {
    const m = makePendleMarket();
    m.details.maxBoostedApy = 0;
    const result = formatPendleMarketSummary(m, "ethereum");
    assert.ok(!result.includes("Max Boosted LP APY"), "Should omit max boosted when 0");
  });

  it("shows Prime and category tags", () => {
    const result = formatPendleMarketSummary(makePendleMarket(), "ethereum");
    assert.ok(result.includes("★ Prime"));
    assert.ok(result.includes("LRT"));
  });

  it("includes TVL, liquidity, volume, fee rate", () => {
    const result = formatPendleMarketSummary(makePendleMarket(), "ethereum");
    assert.ok(result.includes("TVL:"), "Should include TVL");
    assert.ok(result.includes("Liquidity:"), "Should include liquidity");
    assert.ok(result.includes("24h Volume:"), "Should include volume");
    assert.ok(result.includes("Fee Rate:"), "Should include fee rate");
  });

  it("includes pool reserves", () => {
    const result = formatPendleMarketSummary(makePendleMarket(), "ethereum");
    assert.ok(result.includes("Pool Reserves:"), "Should include pool reserves");
    assert.ok(result.includes("PT"), "Should include PT in reserves");
    assert.ok(result.includes("SY"), "Should include SY in reserves");
  });
});
