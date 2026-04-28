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
    assert.ok(result.includes("avant:"), "avant protocol label must render");
    assert.ok(result.includes("burn:avUSDx → claim:avUSD"), "burnt → claim symbols must render via template");
    assert.ok(result.includes("order=42"), "orderId must render via FieldSpec label");
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
    assert.ok(result.includes("pendle:"), "pendle protocol label must render");
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
      assert.ok(result.includes("avant:"), "avant protocol label must render");

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
        assert.ok(result.includes("pendle:"), "pendle protocol label must render");
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

// =============================================================================
// Theme A Phase 2 — formatChainTruthFooter (spec §7.1)
// =============================================================================
//
// Tests cover:
//   - Compact mode (clean state) on both reference vaults
//   - Verbose mode (warn/error firing or explicit verbose flag)
//   - Stakeholder-conditional severity (curator vs lp viewMode)
//   - Per-share value math edge cases (totalSupply = 0n)
//   - Capital scope decomposition (when wrapper has supply and gap is non-trivial)
//   - Withdraw capacity line presence
//   - Price feed outage (price-feed-zero) rendering
//
// The reference state objects below mirror what the engine would produce
// against the fixtures at tests/fixtures/{csfusionmvweth,gamisusdc}-*.json.

import { formatChainTruthFooter } from "./formatters.js";
import type { MetaVaultChainState, ChainReadWarning, SafeState, InfraVaultState, SecondaryVaultState } from "./types.js";

function makeCleanState(overrides: Partial<MetaVaultChainState> = {}): MetaVaultChainState {
  return {
    chain: "base",
    block: 45_197_827,
    rpcUsed: "https://base-rpc.publicnode.com",
    fetchedAt: 1_700_000_000_000,
    safe: {
      address: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
      bytecodePresent: true,
      bytecodeSize: 171,
      isSafeProxy: true,
      singleton: "0xfb1bffc9d739b8d520daf37df666da4c687191ea",
      singletonKnown: "safe-v1.3.0-l2",
      assetBalance: 32_743_210_000n, // 32,743.21 USDC
    } satisfies SafeState,
    infraVault: {
      address: "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1",
      bytecodePresent: true,
      bytecodeSize: 1129,
      totalAssets: 5_125_392_650_000n, // 5,125,392.65 USDC
      totalSupply: 5_018_927_000_000n, // 5,018,927 shares (6 decimals)
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      decimals: 6,
      name: "gamisUSDC infra",
      symbol: "gamisUSDC",
      owner: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
      paused: false,
      selfAssetBalance: 0n,
    } satisfies InfraVaultState,
    secondaryVault: {
      address: "0x776f95321a0285f8bcde149e3264d16dc08da69a",
      bytecodePresent: true,
      bytecodeSize: 1129,
      totalAssets: 2_963_474_720_000n, // 2,963,474.72 USDC
      totalSupply: 2_902_571_123_061n, // ~2.9M shares
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      decimals: 6,
      name: "gamisUSDC",
      symbol: "gamisUSDC",
      selfAssetBalance: 0n,
      infraVaultShareBalance: 5_017_223_000_000n, // ~99.97% of infra supply
      maxWithdrawSelf: 0n,
      maxRedeemSelf: 0n,
      previewRedeemOneShare: 1_020_990n, // ~1.020990 USDC per share
    } satisfies SecondaryVaultState,
    modifiers: null,
    remoteModifiers: {},
    warnings: [
      {
        severity: "info",
        code: "secondaryvault-reasoning-prohibited",
        detail: "secondaryVault accounting is wrapper-scope; do not directly compare its totalAssets against infraVault or api.tvl.underlying",
        nextProbe: "OQ-L tracks the residual provenance gap; agents should reason on infraVault.totalAssets only.",
      } satisfies ChainReadWarning,
    ],
    ...overrides,
  };
}

function makePreOnboardingState(): MetaVaultChainState {
  return makeCleanState({
    chain: "mainnet",
    block: 24_962_385,
    rpcUsed: "https://ethereum-rpc.publicnode.com",
    safe: {
      address: "0x3b1913e474c37cbcf375e644d1af51589d8e44ea",
      bytecodePresent: true,
      bytecodeSize: 171,
      isSafeProxy: true,
      singleton: "0x41675c099f32341bf84bfc5382af534df5c7461a",
      singletonKnown: "safe-v1.4.1",
      assetBalance: 3_000_000_010_000_000_000n, // ~3.000000010 WETH
    },
    infraVault: {
      address: "0x2151c851c1808c6609f24535dd77d8216f17118f",
      bytecodePresent: true,
      bytecodeSize: 1129,
      totalAssets: 3_006_398_000_000_000_000n, // 3.006398 WETH
      totalSupply: 3_000_000_000_000_000_000n,
      asset: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      decimals: 18,
      name: "CSfusionMVWETH infra",
      symbol: "CSfusionMVWETH",
      owner: "0x3b1913e474c37cbcf375e644d1af51589d8e44ea",
      paused: false,
      selfAssetBalance: 0n,
    },
    secondaryVault: {
      address: "0xefda9a1d6b5f4a0279c05b616924776c4d9dc13d",
      bytecodePresent: true,
      bytecodeSize: 1129,
      totalAssets: 0n,
      totalSupply: 0n, // pre-onboarding
      asset: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      decimals: 18,
      name: "CSfusionMVWETH",
      symbol: "CSfusionMVWETH",
      selfAssetBalance: 0n,
      infraVaultShareBalance: 0n,
      maxWithdrawSelf: 0n,
      maxRedeemSelf: 0n,
      previewRedeemOneShare: null,
    },
    warnings: [
      {
        severity: "info",
        code: "pre-onboarding-state",
        detail: "secondaryVault has 0 supply; infraVault populated. Vault is in pre-onboarding state.",
        nextProbe: "expected for HIDDEN vaults; cross-check api.status field — if status is VISIBLE, investigate why outer wrapper has no shares",
      },
    ],
  });
}

describe("formatChainTruthFooter — compact mode", () => {
  it("returns single-line summary on clean info-only state (curator view)", () => {
    const state = makeCleanState();
    const lines = formatChainTruthFooter(state, { viewMode: "curator" });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Chain truth \(block 45,?197,?827, RPC https/);
    assert.match(lines[0], /all checks pass/);
    // 1 informational notice from secondaryvault-reasoning-prohibited.
    assert.match(lines[0], /\[1 informational\]/);
  });

  it("does not include 'ammunition' or 'consulting' wording (round-3 BLOCKER #1, 5-lens convergence)", () => {
    const state = makeCleanState();
    const lines = formatChainTruthFooter(state, { viewMode: "curator", verbose: true, api: { tvlUnderlying: 5_125_544.79, underlyingPriceUsd: 1 } });
    const joined = lines.join("\n");
    assert.equal(joined.toLowerCase().includes("ammunition"), false, "ammunition should not appear");
    assert.equal(joined.toLowerCase().includes("consulting"), false, "consulting should not appear");
  });

  it("does not include 'plasma vault' / 'ipor fusion' wording (BLOCKER #3 + handover note)", () => {
    const state = makeCleanState();
    const lines = formatChainTruthFooter(state, { viewMode: "curator", verbose: true });
    const joined = lines.join("\n").toLowerCase();
    assert.equal(joined.includes("plasma"), false);
    assert.equal(joined.includes("ipor fusion"), false);
  });
});

describe("formatChainTruthFooter — verbose mode (warn/error triggers)", () => {
  it("renders verbose output when a warn-level warning fires", () => {
    const state = makeCleanState({
      warnings: [
        {
          severity: "warn",
          code: "tvl-divergence-large",
          detail: "chain TVL diverges from API by 7.2%",
          nextProbe: "check externalPositions for unreconciled position",
        },
      ],
    });
    const lines = formatChainTruthFooter(state, { viewMode: "curator" });
    assert.ok(lines.length > 1, "verbose should produce multiple lines");
    assert.ok(lines.some((l) => l.includes("--- Chain Truth")), "header line missing");
    assert.ok(lines.some((l) => l.includes("[warn] tvl-divergence-large")));
  });

  it("renders verbose output when explicitly requested even with no warnings", () => {
    const state = makeCleanState({ warnings: [] });
    const lines = formatChainTruthFooter(state, { viewMode: "curator", verbose: true });
    assert.ok(lines.some((l) => l.includes("--- Chain Truth")), "header line missing");
    assert.ok(lines.some((l) => l.includes("Safe (safe-v1.3.0-l2):")));
    assert.ok(lines.some((l) => l.includes("infraVault [PRIMARY]:")));
    assert.ok(lines.some((l) => l.includes("secondaryVault [WRAPPER]:")));
  });

  it("uses 'outer-wrapper aggregate user claim' label (BLOCKER #5)", () => {
    const state = makeCleanState({ warnings: [] });
    const lines = formatChainTruthFooter(state, { viewMode: "curator", verbose: true });
    const joined = lines.join("\n");
    assert.ok(joined.includes("outer-wrapper aggregate user claim"));
    // The old label "user-entitlement" should NOT appear in user-facing output.
    assert.equal(joined.includes("user-entitlement"), false);
  });

  it("renders per-share value as separate line (BLOCKER #5)", () => {
    const state = makeCleanState({ warnings: [] });
    const lines = formatChainTruthFooter(state, { viewMode: "curator", verbose: true });
    assert.ok(lines.some((l) => l.includes("Per-share:")));
    assert.ok(lines.some((l) => l.includes("(wrapped accounting)")));
  });

  it("skips per-share line when totalSupply is 0n (divide-by-zero edge case)", () => {
    const state = makePreOnboardingState();
    const lines = formatChainTruthFooter(state, { viewMode: "curator", verbose: true });
    // Pre-onboarding has totalSupply=0n; no per-share line should render.
    assert.equal(lines.some((l) => l.includes("Per-share:")), false);
  });

  // Decimals-divergence fix: per-share computation must scale by share-decimals
  // (sv.decimals), not underlying-decimals. The legacy formula (* 10^underlying)
  // gave wrong-magnitude results when shareDecimals != underlyingDecimals.
  it("uses share-decimals not underlying-decimals when wrapper decimals diverge (decimals-divergence fix)", () => {
    // Synthetic divergent state: same USDC totalAssets (6-decimal) but the
    // wrapper supplies 18-decimal shares.
    //
    //   Fixed formula: perShareWei = (totalAssets × 10^18) / (2902571 × 10^18)
    //                              = 2_963_474_720_000 / 2_902_571
    //                              ≈ 1_020_982  (in 6-decimal scale = 1.020982 USDC/share)
    //
    //   Legacy bug:    perShareWei = (totalAssets × 10^6)  / (2902571 × 10^18)
    //                              = 2_963_474_720_000_000_000 / 2.9e24
    //                              = 0n (bigint floor — divisor exceeds dividend)
    //                              → would render "Per-share: 0.000000 USDC" silently.
    const cleanState = makeCleanState({ warnings: [] });
    const sv = cleanState.secondaryVault!;
    const divergentState: MetaVaultChainState = {
      ...cleanState,
      secondaryVault: {
        ...sv,
        totalSupply: 2_902_571n * 10n ** 18n, // 18-decimal shares
        decimals: 18,
        // previewRedeem retry reconstructs in underlying-decimals scale to
        // match perShareWei. ~1.020982 USDC per share.
        previewRedeemOneShare: 1_020_982n,
      },
      warnings: [
        {
          severity: "warn",
          code: "wrapper-decimals-divergence",
          detail: "synthetic test — share-decimals 18 vs underlying 6",
          nextProbe: "synthetic",
        } satisfies ChainReadWarning,
      ],
    };
    const lines = formatChainTruthFooter(divergentState, {
      viewMode: "curator",
      verbose: true,
    });
    const perShareLine = lines.find((l) => l.includes("Per-share:"));
    assert.ok(perShareLine, "Per-share line missing");
    // ~1.020982 USDC/share — legacy bug would produce 0.000000.
    assert.match(perShareLine!, /Per-share: 1\.020/);
    // Cross-check must NOT fire — engine retry put previewRedeem in
    // matching scale, so they agree to within 1bp.
    assert.equal(perShareLine!.includes("disagrees"), false);
  });

  it("falls back to underlying-decimals when sv.decimals is null (decimals-unknown branch)", () => {
    // When the wrapper's decimals() failed to decode, the engine emits
    // wrapper-decimals-unknown and sets previewRedeemOneShare = null. The
    // formatter falls back to underlying-decimals for per-share computation
    // (legacy behavior — preserves render for unverifiable wrappers).
    const cleanState = makeCleanState({ warnings: [] });
    const sv = cleanState.secondaryVault!;
    const unknownDecimalsState: MetaVaultChainState = {
      ...cleanState,
      secondaryVault: {
        ...sv,
        decimals: null,
        previewRedeemOneShare: null,
      },
      warnings: [
        {
          severity: "info",
          code: "wrapper-decimals-unknown",
          detail: "synthetic test — decimals() did not decode",
          nextProbe: "synthetic",
        } satisfies ChainReadWarning,
      ],
    };
    const lines = formatChainTruthFooter(unknownDecimalsState, {
      viewMode: "curator",
      verbose: true,
    });
    const perShareLine = lines.find((l) => l.includes("Per-share:"));
    assert.ok(perShareLine, "Per-share line missing — fallback path should still render");
    // Cross-check is suppressed (previewRedeemOneShare = null) — no "disagrees".
    assert.equal(perShareLine!.includes("disagrees"), false);
  });

  it("renders withdraw capacity line when maxWithdrawSelf is non-null (BLOCKER #4)", () => {
    const state = makeCleanState({
      secondaryVault: {
        ...makeCleanState().secondaryVault!,
        maxWithdrawSelf: 1_500_000_000_000n, // 1.5M USDC
      },
      warnings: [],
    });
    const lines = formatChainTruthFooter(state, { viewMode: "curator", verbose: true });
    assert.ok(lines.some((l) => l.includes("Withdraw capacity (vault-side):")));
  });

  it("omits withdraw capacity line when maxWithdrawSelf is null (read reverted)", () => {
    const state = makeCleanState({
      secondaryVault: {
        ...makeCleanState().secondaryVault!,
        maxWithdrawSelf: null,
      },
      warnings: [],
    });
    const lines = formatChainTruthFooter(state, { viewMode: "curator", verbose: true });
    assert.equal(lines.some((l) => l.includes("Withdraw capacity")), false);
  });

  it("renders capital scope decomposition (BLOCKER #2 — round-3 reframe)", () => {
    const state = makeCleanState({ warnings: [] });
    const lines = formatChainTruthFooter(state, {
      viewMode: "curator",
      verbose: true,
      api: { tvlUnderlying: 5_125_544.79, underlyingPriceUsd: 1 },
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Capital scope:"), "decomposition heading missing");
    assert.ok(joined.includes("via outer wrapper (user deposits):"));
    assert.ok(joined.includes("via direct paths:"));
    assert.ok(joined.includes("[curator self-seed, cross-chain transit, infraVault-direct]"));
  });

  it("renders Price feed outage section when api.underlyingPriceUsd === 0", () => {
    const state = makeCleanState({ warnings: [] });
    const lines = formatChainTruthFooter(state, {
      viewMode: "curator",
      verbose: true,
      api: { tvlUnderlying: 5_125_544.79, underlyingPriceUsd: 0 },
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("Price feed outage"));
    assert.ok(joined.includes("price-feed-zero"));
    // The chain-side TVL line should also still render (tvl.usd is broken,
    // tvl.underlying is fine).
    assert.ok(joined.includes("chain-side TVL above is trustworthy"));
  });

  // Phase-2 audit: 2-lens convergence (Diverger + DeFi-analyst inversion test).
  // The price-feed-zero signal lives in the API context, not the engine
  // warnings — without this trigger, production callers (no explicit
  // verbose:true) would see "all checks pass" when the price feed is broken.
  it("price-feed-zero alone (no engine warns) triggers verbose render WITHOUT explicit verbose:true", () => {
    const state = makeCleanState({ warnings: [] });
    const lines = formatChainTruthFooter(state, {
      viewMode: "curator",
      // NOTE: no verbose:true — production caller path
      api: { tvlUnderlying: 5_125_544.79, underlyingPriceUsd: 0 },
    });
    assert.ok(lines.length > 1, "price-feed-zero alone should NOT collapse to compact mode");
    const joined = lines.join("\n");
    assert.ok(joined.includes("Price feed outage"), "Price feed outage section must render");
    assert.ok(joined.includes("price-feed-zero"));
  });

  // Phase-2 audit: Sonnet semantic Bug 1.
  // maxWithdraw(vault) returns 0 because the vault holds no shares of itself.
  // Rendering "0 USDC" misleads readers into thinking withdrawals are blocked.
  it("omits withdraw capacity line when maxWithdrawSelf is 0n (vacuous answer)", () => {
    const state = makeCleanState({
      secondaryVault: {
        ...makeCleanState().secondaryVault!,
        maxWithdrawSelf: 0n,
      },
      warnings: [],
    });
    const lines = formatChainTruthFooter(state, { viewMode: "curator", verbose: true });
    assert.equal(
      lines.some((l) => l.includes("Withdraw capacity")),
      false,
      "0n must be treated like null — vacuous, not informative",
    );
  });

  // Phase-2 audit: Diverger sensing-gap #7.
  // The prohibition reminder is most-needed when divergence is being
  // investigated — that's exactly when an agent might confuse wrapper-scope
  // accounting with primary-aggregate. Keep both warnings together.
  it("keeps secondaryvault-reasoning-prohibited when paired with tvl-divergence-large", () => {
    const state = makeCleanState({
      warnings: [
        {
          severity: "warn",
          code: "tvl-divergence-large",
          detail: "API ↔ chain divergence at 7.3% on infraVault.totalAssets",
          nextProbe: "external position not yet reconciled by indexer",
        },
        {
          severity: "info",
          code: "secondaryvault-reasoning-prohibited",
          detail: "secondaryVault accounting is wrapper-scope",
          nextProbe: "OQ-L tracks the residual provenance gap",
        },
      ],
    });
    const lines = formatChainTruthFooter(state, { viewMode: "curator" });
    const joined = lines.join("\n");
    assert.ok(joined.includes("tvl-divergence-large"), "divergence warning must render");
    assert.ok(
      joined.includes("secondaryvault-reasoning-prohibited"),
      "reminder must NOT be suppressed when divergence is firing — anchors interpretation",
    );
  });
});

describe("formatChainTruthFooter — stakeholder-conditional severity (BLOCKER #11)", () => {
  it("for curator view: pre-onboarding-state stays info — render is COMPACT", () => {
    const state = makePreOnboardingState();
    const lines = formatChainTruthFooter(state, { viewMode: "curator" });
    // info-only → compact, single line.
    assert.equal(lines.length, 1);
    assert.match(lines[0], /all checks pass/);
  });

  it("for lp view: pre-onboarding-state promoted to warn — render is VERBOSE", () => {
    const state = makePreOnboardingState();
    const lines = formatChainTruthFooter(state, { viewMode: "lp" });
    // warn → verbose, multi-line, with the warning marked [warn].
    assert.ok(lines.length > 1);
    assert.ok(lines.some((l) => l.includes("[warn] pre-onboarding-state")));
  });
});

describe("formatChainTruthFooter — type-signature backward-compat", () => {
  it("the (state) arity from Phase 1 still works (no opts)", () => {
    const state = makeCleanState();
    const lines = formatChainTruthFooter(state);
    // Default viewMode is "curator"; default opts collapse info-only to compact.
    assert.equal(lines.length, 1);
  });
});

// =============================================================================
// Theme A Phase 2 — chain-truth cache (spec BLOCKER #7 / OQ-E promoted)
// =============================================================================

import {
  readMetaVaultChainStateCached,
  _clearChainTruthCacheForTest,
  _chainTruthCacheSizeForTest,
} from "./chain-reads.js";

describe("readMetaVaultChainStateCached — 5-min curator-tempo cache", () => {
  it("starts empty after _clearChainTruthCacheForTest()", () => {
    _clearChainTruthCacheForTest();
    assert.equal(_chainTruthCacheSizeForTest(), 0);
  });

  // Note: full cache hit/miss verification requires either mocking the engine
  // or running against live RPCs. We verify the cache mechanism via the
  // observable effect: a forceRefresh:false call after a successful cached
  // read should not increase cache size beyond 1 for the same key.
  //
  // The integration test below (gated by INTEGRATION_TEST=1) exercises the
  // full path against live RPCs.

  it("integration: second call hits cache (no second RPC blast)", { skip: process.env.INTEGRATION_TEST !== "1" }, async () => {
    _clearChainTruthCacheForTest();
    const input = {
      address: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
      vault: "0x776f95321a0285f8bcde149e3264d16dc08da69a",
      infraVault: "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1",
      underlying: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC" },
    };
    const t0 = Date.now();
    const first = await readMetaVaultChainStateCached("base", input, { forceRefresh: false });
    const t1 = Date.now();
    const second = await readMetaVaultChainStateCached("base", input, { forceRefresh: false });
    const t2 = Date.now();

    // Cached read should be near-instant (< 50ms is generous).
    assert.ok(t2 - t1 < 50, `expected cached read <50ms, got ${t2 - t1}ms`);
    assert.ok(t1 - t0 > t2 - t1, "first call should take longer than second");

    // Same state object reference (or at least same block).
    assert.equal(first.block, second.block);
    assert.equal(first.rpcUsed, second.rpcUsed);
    assert.equal(_chainTruthCacheSizeForTest(), 1);
  });
});

// =============================================================================
// Theme A Phase 4 — verify_onchain on spectra_list_metavaults
// =============================================================================
//
// Tests the formatter-level integration of chain-truth summary lines into
// formatMetavaultList. Tool-level wiring (concurrency cap, Promise.allSettled,
// readMetaVaultChainStateCached) is exercised via the formatter contract:
//   - chainResults undefined  → output identical to current (verify_onchain=false)
//   - chainResults map populated with `ok` state → [✓] line per MV
//   - chainResults map populated with `failed` → [✗] line per MV (one bad
//     MV does NOT break list rendering)

import {
  formatMetavaultList,
  formatChainTruthSummaryLine,
  type ChainTruthSummaryResult,
} from "./formatters.js";
import type { SpectraMetavault } from "./types.js";

/**
 * Build a minimal SpectraMetavault that survives formatMetavaultSummary
 * without choking on missing fields. The tests assert on chain-truth lines
 * only — the rest of the body is filler.
 */
function makeMinimalMv(overrides: Partial<SpectraMetavault> = {}): SpectraMetavault {
  return {
    chainId: 8453,
    address: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
    vault: "0x776f95321a0285f8bcde149e3264d16dc08da69a",
    infraVault: "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1",
    name: "gamisUSDC",
    symbol: "gamisUSDC",
    decimals: 6,
    status: "VISIBLE",
    underlying: {
      address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      symbol: "USDC",
      decimals: 6,
      price: { usd: 1 },
    },
    tvl: { usd: 5_125_544.79, underlying: 5_125_392.65 },
    liveApy: { total: 0.082, details: { base: 0.05 } },
    avgApy30d: { total: 0.078 },
    price: { usd: 1.02, underlying: 1.02 },
    curator: { name: "Test Curator", addresses: ["0xabc"] },
    metadata: { title: "gamisUSDC", shortDescription: "test" },
    positions: [],
    externalPositions: [],
    epochs: [],
    bridge: { transactions: [] },
    ...overrides,
  } as unknown as SpectraMetavault;
}

describe("formatChainTruthSummaryLine — single-line per-MV format (Phase 4)", () => {
  it("renders [✓] for clean info-only state with API↔chain drift suffix", () => {
    const state = makeCleanState();
    const line = formatChainTruthSummaryLine({
      kind: "ok",
      state,
      apiTvlUnderlying: 5_125_544.79,
      apiUnderlyingPriceUsd: 1,
    });
    assert.match(line, /\[chain-truth ✓\]/);
    assert.match(line, /block 45,?197,?827/);
    assert.match(line, /via https/);
    assert.match(line, /API↔chain drift/);
    // 5,125,544.79 vs 5,125,392.65 → 0.003% (none class, threshold 0.5%)
    assert.match(line, /\(none\)/);
  });

  it("renders [✓] without drift suffix when apiTvlUnderlying not provided", () => {
    const state = makeCleanState();
    const line = formatChainTruthSummaryLine({ kind: "ok", state });
    assert.match(line, /\[chain-truth ✓\]/);
    assert.equal(line.includes("API↔chain drift"), false);
  });

  it("renders [⚠] with warning codes when actionable warnings fire", () => {
    const state = makeCleanState({
      warnings: [
        {
          severity: "warn",
          code: "wrapper-signature-broken",
          detail: "secondaryVault holds 0.0% of infraVault shares",
          nextProbe: "topology shifted",
        },
        {
          severity: "error",
          code: "owner-mismatch",
          detail: "infraVault.owner() != Safe address",
          nextProbe: "check governance",
        },
      ],
    });
    const line = formatChainTruthSummaryLine({ kind: "ok", state });
    assert.match(line, /\[chain-truth ⚠\]/);
    assert.match(line, /2 warning\(s\)/);
    assert.match(line, /wrapper-signature-broken/);
    assert.match(line, /owner-mismatch/);
    // No drift suffix on warn lines (codes carry the signal).
    assert.equal(line.includes("API↔chain drift"), false);
  });

  it("treats info-only warnings as clean (renders [✓], not [⚠])", () => {
    // The default makeCleanState carries a single info warning
    // (secondaryvault-reasoning-prohibited) — must NOT escalate to [⚠].
    const state = makeCleanState();
    const line = formatChainTruthSummaryLine({ kind: "ok", state });
    assert.match(line, /\[chain-truth ✓\]/);
    assert.equal(line.includes("[chain-truth ⚠]"), false);
  });

  it("renders [✗] from failed kind with truncated error", () => {
    const longErr = "All RPCs failed for base: tried 3 endpoint(s); the underlying detail goes on and on and on far past the 80-char truncation point";
    const line = formatChainTruthSummaryLine({ kind: "failed", error: longErr });
    assert.match(line, /\[chain-truth ✗\]/);
    assert.match(line, /RPC unavailable/);
    assert.match(line, /\.\.\./); // truncation marker present
  });

  it("renders [✗] when state carries rpc-all-failed warning even on ok kind", () => {
    // Engine returns a state object with rpc-all-failed instead of throwing —
    // PR0 graceful degradation. Summary line collapses to ✗ shape.
    const state = makeCleanState({
      block: 0,
      rpcUsed: "",
      warnings: [
        {
          severity: "error",
          code: "rpc-all-failed",
          detail: "all RPCs failed for base: tried 3 endpoints",
          nextProbe: "use a premium RPC for chain base",
        },
      ],
    });
    const line = formatChainTruthSummaryLine({ kind: "ok", state });
    assert.match(line, /\[chain-truth ✗\]/);
    assert.match(line, /RPC unavailable/);
  });

  it("caps shown codes at 4 with overflow suffix", () => {
    const state = makeCleanState({
      warnings: [
        { severity: "warn", code: "wrapper-signature-broken", detail: "", nextProbe: "" },
        { severity: "warn", code: "owner-mismatch", detail: "", nextProbe: "" },
        { severity: "warn", code: "asset-mismatch-infravault", detail: "", nextProbe: "" },
        { severity: "warn", code: "asset-mismatch-secondaryvault", detail: "", nextProbe: "" },
        { severity: "warn", code: "tvl-divergence-large", detail: "", nextProbe: "" },
        { severity: "warn", code: "safe-non-proxy", detail: "", nextProbe: "" },
      ],
    });
    const line = formatChainTruthSummaryLine({ kind: "ok", state });
    assert.match(line, /\+2 more/);
  });

  it("computes drift class correctly: small (>=0.5%), large (>=5%), none (<0.5%)", () => {
    const state = makeCleanState();
    // chain primary = 5,125,392.65 (from infraVault.totalAssets)
    // small: api ~= 5,150,000 (delta ~24,607, ~0.48%) is still < 0.5% → none.
    // Pick a clearer pair. small: api=5,150,000 (delta ~0.48%) borderline.
    // Use api=5,200,000 → delta=74,607 → 1.43% → small.
    const small = formatChainTruthSummaryLine({
      kind: "ok",
      state,
      apiTvlUnderlying: 5_200_000,
    });
    assert.match(small, /\(tvl-divergence-small\)/);
    // large: api=6,000,000 → delta=874,607 → 14.6% → large.
    const large = formatChainTruthSummaryLine({
      kind: "ok",
      state,
      apiTvlUnderlying: 6_000_000,
    });
    assert.match(large, /\(tvl-divergence-large\)/);
  });
});

describe("formatMetavaultList — verify_onchain integration (Phase 4)", () => {
  it("verify_onchain=false (chainResults undefined) produces output identical to current path", () => {
    const mv = makeMinimalMv({
      address: "0xaaaa000000000000000000000000000000000000",
    });
    const entries = [{ metavault: mv, chain: "base" }];
    const before = formatMetavaultList(entries, "base", undefined, undefined);
    const after = formatMetavaultList(entries, "base", undefined, undefined, undefined);
    // Byte-for-byte: both omit the chainResults arg → render is identical.
    assert.equal(after, before);
    // And no chain-truth chrome leaks in.
    assert.equal(after.includes("chain-truth"), false);
  });

  it("verify_onchain=true clean state produces [✓] line in per-MV block", () => {
    const mvAddr = "0xaaaa000000000000000000000000000000000000";
    const mv = makeMinimalMv({ address: mvAddr });
    const state = makeCleanState();
    const chainResults = new Map<string, ChainTruthSummaryResult>([
      [
        `base:${mvAddr.toLowerCase()}`,
        { kind: "ok", state, apiTvlUnderlying: mv.tvl?.underlying },
      ],
    ]);
    const text = formatMetavaultList([{ metavault: mv, chain: "base" }], "base", undefined, undefined, chainResults);
    assert.match(text, /\[chain-truth ✓\]/);
    // The MV block is intact — TVL line, APY line still render.
    assert.match(text, /TVL: /);
    assert.match(text, /Live APY/);
  });

  it("chain-read failure on one MV does NOT break list rendering for the others", () => {
    const okAddr = "0xbbbb000000000000000000000000000000000000";
    const failAddr = "0xcccc000000000000000000000000000000000000";
    const mvOk = makeMinimalMv({
      address: okAddr,
      name: "OkVault",
      symbol: "OK",
      metadata: { title: "OkVault", shortDescription: "test" },
    });
    const mvFail = makeMinimalMv({
      address: failAddr,
      name: "FailVault",
      symbol: "FAIL",
      metadata: { title: "FailVault", shortDescription: "test" },
    });
    const state = makeCleanState();
    const chainResults = new Map<string, ChainTruthSummaryResult>([
      [
        `base:${okAddr.toLowerCase()}`,
        { kind: "ok", state, apiTvlUnderlying: mvOk.tvl?.underlying },
      ],
      [
        `base:${failAddr.toLowerCase()}`,
        { kind: "failed", error: "All RPCs failed for base: tried 3 endpoint(s)" },
      ],
    ]);
    const text = formatMetavaultList(
      [
        { metavault: mvOk, chain: "base" },
        { metavault: mvFail, chain: "base" },
      ],
      "base",
      undefined,
      undefined,
      chainResults,
    );
    // Both MVs render their core block.
    assert.match(text, /OkVault/);
    assert.match(text, /FailVault/);
    // OkVault gets a [✓] line, FailVault gets a [✗] line.
    assert.match(text, /\[chain-truth ✓\]/);
    assert.match(text, /\[chain-truth ✗\]/);
    assert.match(text, /RPC unavailable/);
    // The failure does NOT poison the OK rendering — both lines coexist.
    const okIdx = text.indexOf("OkVault");
    const failIdx = text.indexOf("FailVault");
    assert.ok(okIdx >= 0 && failIdx > okIdx, "both MV blocks must render in order");
  });

  it("chainResults map miss for a given MV degrades silently (no chrome)", () => {
    // If the verify_onchain block ran but somehow skipped an MV (off-by-one,
    // entry filtered), the formatter must NOT crash and NOT inject empty
    // chain-truth chrome. The MV block renders as if verify_onchain=false.
    const mvAddr = "0xdddd000000000000000000000000000000000000";
    const mv = makeMinimalMv({ address: mvAddr });
    // Empty map → no entry for this MV.
    const chainResults = new Map<string, ChainTruthSummaryResult>();
    const text = formatMetavaultList([{ metavault: mv, chain: "base" }], "base", undefined, undefined, chainResults);
    assert.equal(text.includes("chain-truth"), false);
  });
});

// =============================================================================
// formatHaltCheckLine — source-vault halt-check (Theme A Phase 4 sub-PR 2)
// =============================================================================
//
// Tests the rollover halt-check formatter contract. Tool-level wiring (the
// 30s Promise.race timeout, projectChainReadInput, readMetaVaultChainStateCached
// cache hit) is exercised at the formatter contract level here:
//   - verify_onchain=false → handler never builds a haltCheckLine, render
//     contains no "halt-check" chrome (asserted at formatter level by
//     omitting the line)
//   - verify_onchain=true clean state → [✓] line, fresh-read no cache suffix
//   - verify_onchain=true cached state → [✓] line WITH (cached Xm ago)
//   - chain-read failure → [✗] line (formatter contract — handler builds
//     RolloverHaltCheckResult with kind: "failed")
//   - infraVault.paused=true synthesizes "infravault-paused" pseudo-code
//   - actionable codes (subset filter) → [⚠] line with codes listed
//   - non-halt codes (e.g., tvl-divergence-large, owner-mismatch) DO NOT
//     trigger halt — they're list-view drift signals, not source-halt signals

import {
  formatHaltCheckLine,
  type RolloverHaltCheckResult,
} from "./formatters.js";

describe("formatHaltCheckLine — source-vault pre-flight (Phase 4 sub-PR 2)", () => {
  it("renders [✓] for clean info-only state with NO cache suffix when fresh", () => {
    // Fresh read: state.fetchedAt within the 30s threshold → no suffix.
    const state = makeCleanState({ fetchedAt: Date.now() });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ✓\]/);
    assert.match(line, /block 45,?197,?827/);
    assert.match(line, /via https/);
    // No "(cached Xm ago)" suffix on fresh reads.
    assert.equal(line.includes("(cached"), false);
  });

  it("renders [✓] WITH (cached Xm ago) suffix when fetchedAt is ≥60s old", () => {
    // 4 minutes ago: cache hit, suffix should read "(cached 4m ago)".
    const fourMinAgo = Date.now() - 4 * 60_000;
    const state = makeCleanState({ fetchedAt: fourMinAgo });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ✓\]/);
    assert.match(line, /\(cached 4m ago\)/);
  });

  it("renders [✓] WITHOUT cache suffix in the 30-59s window (B1 regression test)", () => {
    // Sonnet+depth audit B1: legacy threshold of 30s combined with minute-
    // floor rendering produced "(cached 0m ago)" — the noise the threshold
    // existed to prevent. The fix raised the gate to 60s. This test pins
    // the corrected behavior so a future regression to 30s is caught.
    const fortyFiveSecAgo = Date.now() - 45_000;
    const state = makeCleanState({ fetchedAt: fortyFiveSecAgo });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ✓\]/);
    assert.equal(line.includes("(cached"), false, "30-59s reads must not render cache suffix");
  });

  it("renders [✗] from failed kind with truncated error", () => {
    const longErr = "chain-read timed out after 30000ms; the underlying detail extends well past the 80-char truncation point and should be cut";
    const line = formatHaltCheckLine({ kind: "failed", error: longErr });
    assert.match(line, /\[source halt-check ✗\]/);
    assert.match(line, /RPC unavailable/);
    assert.match(line, /\.\.\./);
  });

  it("renders [✗] when state carries rpc-all-failed even on ok kind", () => {
    // Engine returns a state object with rpc-all-failed instead of throwing —
    // PR0 graceful degradation. Halt-check collapses to ✗ shape.
    const state = makeCleanState({
      block: 0,
      rpcUsed: "",
      warnings: [
        {
          severity: "error",
          code: "rpc-all-failed",
          detail: "all RPCs failed for base: tried 3 endpoints",
          nextProbe: "use a premium RPC for chain base",
        },
      ],
    });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ✗\]/);
    assert.match(line, /RPC unavailable/);
  });

  it("renders [⚠] when role-inversion-detected fires (catastrophic topology shift)", () => {
    const state = makeCleanState({
      fetchedAt: Date.now(),
      warnings: [
        {
          severity: "error",
          code: "role-inversion-detected",
          detail: "metavault.address responds to totalAssets()",
          nextProbe: "halt further chain reasoning",
        },
      ],
    });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ⚠\]/);
    assert.match(line, /1 actionable/);
    assert.match(line, /role-inversion-detected/);
  });

  it("renders [⚠] when infraVault.paused=true (synthetic infravault-paused code)", () => {
    // Engine never emits a 'paused' warning — we read state.infraVault.paused
    // directly per spec §6. This test guards that behavior.
    const state = makeCleanState({ fetchedAt: Date.now() });
    state.infraVault!.paused = true;
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ⚠\]/);
    assert.match(line, /infravault-paused/);
  });

  it("filters out non-halt codes — tvl-divergence-large does NOT trigger ⚠", () => {
    // Drift is a list-view signal, not a halt signal. The rollover decision
    // doesn't depend on source TVL accuracy (candidate ranking uses CANDIDATE
    // pool liquidity), so drift on the source vault stays clean here.
    const state = makeCleanState({
      fetchedAt: Date.now(),
      warnings: [
        {
          severity: "warn",
          code: "tvl-divergence-large",
          detail: "chain TVL diverges from API by 7.2%",
          nextProbe: "check externalPositions",
        },
      ],
    });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ✓\]/);
    assert.equal(line.includes("[source halt-check ⚠]"), false);
  });

  it("filters out owner-mismatch — governance change is list-view signal, not halt", () => {
    const state = makeCleanState({
      fetchedAt: Date.now(),
      warnings: [
        {
          severity: "warn",
          code: "owner-mismatch",
          detail: "infraVault.owner() != Safe address",
          nextProbe: "ownership transfer or API drift",
        },
      ],
    });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ✓\]/);
  });

  it("renders [⚠] for accounting-state-zero (broken vault deployment)", () => {
    const state = makeCleanState({
      fetchedAt: Date.now(),
      warnings: [
        {
          severity: "warn",
          code: "accounting-state-zero",
          detail: "all vault accounting contracts show null/zero supply",
          nextProbe: "trace deployment txn",
        },
      ],
    });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ⚠\]/);
    assert.match(line, /accounting-state-zero/);
  });

  it("renders [⚠] for wrapper-signature-broken (OQ-J pattern violated)", () => {
    const state = makeCleanState({
      fetchedAt: Date.now(),
      warnings: [
        {
          severity: "warn",
          code: "wrapper-signature-broken",
          detail: "secondaryVault holds 0.0% of infraVault shares",
          nextProbe: "topology shifted",
        },
      ],
    });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ⚠\]/);
    assert.match(line, /wrapper-signature-broken/);
  });

  it("renders [⚠] for safe-no-bytecode + infravault-no-bytecode (catastrophic)", () => {
    const state = makeCleanState({
      fetchedAt: Date.now(),
      warnings: [
        {
          severity: "error",
          code: "safe-no-bytecode",
          detail: "Safe address has no code",
          nextProbe: "verify on Etherscan",
        },
        {
          severity: "error",
          code: "infravault-no-bytecode",
          detail: "infraVault address has no code",
          nextProbe: "primary accounting source missing",
        },
      ],
    });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ⚠\]/);
    assert.match(line, /2 actionable/);
    assert.match(line, /safe-no-bytecode/);
    assert.match(line, /infravault-no-bytecode/);
  });

  it("combines paused field + halt-code warnings without double-counting", () => {
    // role-inversion warning + paused field → 2 distinct codes.
    const state = makeCleanState({
      fetchedAt: Date.now(),
      warnings: [
        {
          severity: "error",
          code: "role-inversion-detected",
          detail: "topology shift",
          nextProbe: "halt",
        },
      ],
    });
    state.infraVault!.paused = true;
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ⚠\]/);
    assert.match(line, /2 actionable/);
    assert.match(line, /role-inversion-detected/);
    assert.match(line, /infravault-paused/);
  });

  it("preserves cache suffix on warn lines", () => {
    // Both ✓ and ⚠ paths must show the cache age — staleness matters most
    // when warnings fire (curator may want to force-refresh before halting).
    const tenMinAgo = Date.now() - 10 * 60_000;
    const state = makeCleanState({
      fetchedAt: tenMinAgo,
      warnings: [
        {
          severity: "error",
          code: "role-inversion-detected",
          detail: "topology shift",
          nextProbe: "halt",
        },
      ],
    });
    const line = formatHaltCheckLine({ kind: "ok", state });
    assert.match(line, /\[source halt-check ⚠\]/);
    assert.match(line, /\(cached 10m ago\)/);
  });
});

// =============================================================================
// Discard-layer Phase 1 — PR1, PR4, PR12b, PR17 (formatMetavaultSummary +
// backports to formatPositionSummary + formatPoolSummary)
// =============================================================================
//
// Spec: docs/discard-layer-spec.md §1 PR1, PR4, PR12b, PR17. Tests target the
// rendering contract; bug-fix backport tests prove the Array-vs-object union
// no longer silently no-ops on the {lp,yt} shape variant.

import {
  formatMetavaultSummary,
  formatMultipliers,
  hasPointsMultiplier,
  formatPositionSummary,
  formatPoolSummary,
  formatPointsMultipliers,
} from "./formatters.js";
import { PROTOCOL_METADATA } from "./protocols/metadata.js";

describe("formatMultipliers — Array | object union (PR12b core)", () => {
  it("returns null for undefined input", () => {
    assert.equal(formatMultipliers(undefined), null);
  });

  it("returns null for empty Array", () => {
    assert.equal(formatMultipliers([]), null);
  });

  it("returns null for object with no populated branches", () => {
    assert.equal(formatMultipliers({}), null);
    assert.equal(formatMultipliers({ lp: [], yt: [] }), null);
  });

  it("renders Array form as comma-joined name-amountX pairs", () => {
    const out = formatMultipliers([
      { name: "Avant points", amount: 40 },
      { name: "Aegis points", amount: 5 },
    ]);
    assert.equal(out, "Avant points 40x, Aegis points 5x");
  });

  it("renders single-item Array form", () => {
    const out = formatMultipliers([{ name: "Firelight points", amount: 2 }]);
    assert.equal(out, "Firelight points 2x");
  });

  it("renders object form with lp + yt branches as bracketed | join", () => {
    const out = formatMultipliers({
      lp: [{ name: "Avant points", amount: 40 }],
      yt: [{ name: "Avant points", amount: 60 }],
    });
    assert.equal(out, "lp [Avant points 40x] | yt [Avant points 60x]");
  });

  it("renders object form with only lp populated (skips empty yt)", () => {
    const out = formatMultipliers({
      lp: [{ name: "Avant points", amount: 40 }],
      yt: [],
    });
    assert.equal(out, "lp [Avant points 40x]");
  });

  it("renders object form with only yt populated (skips missing lp)", () => {
    const out = formatMultipliers({
      yt: [{ name: "Avant points", amount: 60 }],
    });
    assert.equal(out, "yt [Avant points 60x]");
  });
});

describe("hasPointsMultiplier — /points$/i detection across union shapes", () => {
  it("returns false for undefined / empty", () => {
    assert.equal(hasPointsMultiplier(undefined), false);
    assert.equal(hasPointsMultiplier([]), false);
    assert.equal(hasPointsMultiplier({}), false);
  });

  it("detects 'Avant points' in Array form (case-insensitive)", () => {
    assert.equal(hasPointsMultiplier([{ name: "Avant points", amount: 40 }]), true);
    assert.equal(hasPointsMultiplier([{ name: "avant POINTS", amount: 40 }]), true);
  });

  it("rejects 'Drops' (does not end in 'points')", () => {
    assert.equal(hasPointsMultiplier([{ name: "Drops", amount: 3 }]), false);
  });

  it("detects mixed Array (Drops + InfiniFi points) — second item triggers", () => {
    assert.equal(
      hasPointsMultiplier([
        { name: "Drops", amount: 3 },
        { name: "InfiniFi points", amount: 12 },
      ]),
      true,
    );
  });

  it("detects in object form (lp branch)", () => {
    assert.equal(
      hasPointsMultiplier({
        lp: [{ name: "Avant points", amount: 40 }],
      }),
      true,
    );
  });

  it("detects in object form (yt branch when lp missing)", () => {
    assert.equal(
      hasPointsMultiplier({
        yt: [{ name: "Avant points", amount: 60 }],
      }),
      true,
    );
  });
});

describe("formatMetavaultSummary — PR1 inception + track-record bucket", () => {
  // PR1 — `Inception: <YYYY-MM-DD> (<N>d ago, track-record-class: <bucket>)`.
  // Buckets: <30d, 30-90d, ≥90d. Silent when createdAt undefined.
  // Use Math.floor((Date.now()/1000 - createdAt)/86400) — relative to test
  // run-date, so we frame `createdAt` against `Date.now()`.
  const NOW = Math.floor(Date.now() / 1000);

  function mkMv(overrides: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs: [],
      bridge: { transactions: [] },
      ...overrides,
    };
  }

  it("renders <30d bucket for fresh vault (5 days old)", () => {
    const mv = mkMv({ createdAt: NOW - 5 * 86400 });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /Inception: \d{4}-\d{2}-\d{2} \(5d ago, track-record-class: <30d\)/);
  });

  it("renders 30-90d bucket at lower boundary (30 days old)", () => {
    const mv = mkMv({ createdAt: NOW - 30 * 86400 });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /track-record-class: 30-90d/);
  });

  it("renders 30-90d bucket mid-range (60 days old)", () => {
    const mv = mkMv({ createdAt: NOW - 60 * 86400 });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /\(60d ago, track-record-class: 30-90d\)/);
  });

  it("renders ≥90d bucket at lower boundary (90 days old)", () => {
    const mv = mkMv({ createdAt: NOW - 90 * 86400 });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /track-record-class: ≥90d/);
  });

  it("renders ≥90d bucket for established vault (300 days old)", () => {
    const mv = mkMv({ createdAt: NOW - 300 * 86400 });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /\(300d ago, track-record-class: ≥90d\)/);
  });

  it("silent when createdAt undefined", () => {
    const mv = mkMv({});
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(out.includes("Inception:"), false);
    assert.equal(out.includes("track-record-class"), false);
  });

  it("inception line appears between Curator and Underlying lines", () => {
    const mv = mkMv({ createdAt: NOW - 100 * 86400 });
    const out = formatMetavaultSummary(mv, "base");
    const lines = out.split("\n");
    const curatorIdx = lines.findIndex((l) => l.startsWith("  Curator:"));
    const inceptionIdx = lines.findIndex((l) => l.startsWith("  Inception:"));
    const underlyingIdx = lines.findIndex((l) => l.startsWith("  Underlying:"));
    assert.ok(curatorIdx >= 0 && inceptionIdx > curatorIdx && underlyingIdx > inceptionIdx,
      "order: Curator → Inception → Underlying");
  });
});

describe("formatMetavaultSummary — PR4 vault-level tags", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMv(overrides: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
      ...overrides,
    };
  }

  it("renders vault tags as bracketed comma-joined list", () => {
    const mv = mkMv({ tags: ["stable"] });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Tags: \[stable\]$/m);
  });

  it("renders multi-tag vault (the spec's example shape)", () => {
    const mv = mkMv({ tags: ["stable", "eth"] });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Tags: \[stable, eth\]$/m);
  });

  it("silent when tags undefined", () => {
    const mv = mkMv({});
    const out = formatMetavaultSummary(mv, "base");
    // No vault-level Tags line. (Per-position Tags would have 6-space indent.)
    assert.equal(/^  Tags:/m.test(out), false);
  });

  it("silent when tags empty array", () => {
    const mv = mkMv({ tags: [] });
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Tags:/m.test(out), false);
  });
});

describe("formatMetavaultSummary — fixture-driven PR4/PR12b/PR17 (per-position)", () => {
  // Tests run from build/; fixtures live at repo-root/test/fixtures.
  const __dirname_ph1 = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = resolve(__dirname_ph1, "../test/fixtures");
  function loadMvFixture(chain: string): any[] {
    return JSON.parse(readFileSync(resolve(fixturesDir, `metavaults-${chain}.json`), "utf8"));
  }

  it("base Gami USDC: vault-level Tags renders [stable]", () => {
    const mv = loadMvFixture("base").find((m: any) => m.name === "Gami USDC");
    assert.ok(mv, "fixture missing");
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Tags: \[stable\]$/m);
  });

  it("base Gami USDC pos[3] (sw-avUSD): renders Wraps + object-form Multipliers + attribution-creep", () => {
    const mv = loadMvFixture("base").find((m: any) => m.name === "Gami USDC");
    const out = formatMetavaultSummary(mv, "base");
    // PR17 — sw-avUSD wraps avUSD (baseIbt.symbol differs from ibt.symbol).
    assert.match(out, /^      Wraps: avUSD$/m);
    // PR12b — object form: lp [Avant points 40x] | yt [Avant points 60x].
    assert.match(out, /lp \[Avant points 40x\] \| yt \[Avant points 60x\]/);
    // PR4 — attribution-creep flag (rewards empty + points declared).
    assert.match(
      out,
      /Multipliers: lp \[Avant points 40x\] \| yt \[Avant points 60x\] \(no on-chain rewards populated — points program declared, settlement evidence absent\)/,
    );
  });

  it("katana CSMVUSDC pos[2] (sw-syUSD): renders Array-form Multipliers (Drops + InfiniFi)", () => {
    const mv = loadMvFixture("katana").find((m: any) => m.name === "Clearstar USDC");
    assert.ok(mv, "fixture missing");
    const out = formatMetavaultSummary(mv, "katana");
    // PR12b Array form. PR4: 'InfiniFi points' triggers /points$/i ('Drops' alone would not).
    assert.match(out, /Multipliers: Drops 3x, InfiniFi points 12x \(no on-chain rewards populated — points program declared, settlement evidence absent\)/);
    // PR17 — sw-syUSD wraps syUSD.
    assert.match(out, /^      Wraps: syUSD$/m);
    // PR4 — per-position Tags (the only fixture chain where pos.tags populates).
    assert.match(out, /^      Tags: \[stable\]$/m);
  });

  it("katana CSMVUSDC pos[0,1,3] (yvvbUSDC/yvvbUSDT): no Multipliers line (rewards populated, multipliers absent)", () => {
    const mv = loadMvFixture("katana").find((m: any) => m.name === "Clearstar USDC");
    const out = formatMetavaultSummary(mv, "katana");
    // These positions have rewards but no multipliers — silent on Multipliers,
    // but per-position Tags still renders since pos.tags = ["stable"].
    // Match a yvvbUSDC PT block; no Multipliers immediately following.
    const lines = out.split("\n");
    const yvIdx = lines.findIndex((l) => /yvvbUSDC.*EXPIRED|yvvbUSDC.*\(\d+d\)/.test(l));
    assert.ok(yvIdx >= 0, "yvvbUSDC position not found");
    // Within the next 6 lines (the position's block), no Multipliers should appear
    // for the yvvbUSDC entry — verify by finding the next position-header line.
    const nextHeaderRel = lines.slice(yvIdx + 1).findIndex((l) => /^    PT-/.test(l));
    const blockEnd = nextHeaderRel < 0 ? lines.length : yvIdx + 1 + nextHeaderRel;
    const block = lines.slice(yvIdx, blockEnd).join("\n");
    assert.equal(block.includes("Multipliers:"), false, "yvvbUSDC block must be silent on Multipliers");
  });

  it("flare gamisXRP pos[0]: Array-form Firelight points — attribution-creep fires", () => {
    const mv = loadMvFixture("flare").find((m: any) => m.name === "Gami Spectra XRP");
    assert.ok(mv, "fixture missing");
    const out = formatMetavaultSummary(mv, "flare");
    assert.match(out, /Multipliers: Firelight points 2x \(no on-chain rewards populated — points program declared, settlement evidence absent\)/);
    // gamisXRP has tags=undefined at vault level → no vault Tags line.
    assert.equal(/^  Tags:/m.test(out), false);
  });

  it("mainnet WETH MetaVault: Fusion points + Wraps fusnstETH", () => {
    const mv = loadMvFixture("mainnet").find((m: any) => m.name === "WETH MetaVault");
    assert.ok(mv, "fixture missing");
    const out = formatMetavaultSummary(mv, "mainnet");
    assert.match(out, /Multipliers: Fusion points 10x \(no on-chain rewards populated — points program declared, settlement evidence absent\)/);
    assert.match(out, /^      Wraps: fusnstETH$/m);
    // Vault-level Tags = ["eth"].
    assert.match(out, /^  Tags: \[eth\]$/m);
  });

  it("base UltraYield WETH pos[0] (sw-weETH): Wraps renders, no Multipliers (none populated)", () => {
    const mv = loadMvFixture("base").find((m: any) => m.name === "UltraYield WETH");
    assert.ok(mv, "fixture missing");
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^      Wraps: weETH$/m);
    // pos[0] has no multipliers → flag silent.
    // Find the sw-weETH block and confirm no Multipliers line within it.
    const lines = out.split("\n");
    const wIdx = lines.findIndex((l) => /sw-weETH/.test(l) && /^    PT-/.test(l));
    assert.ok(wIdx >= 0, "sw-weETH header not found");
    const nextHeaderRel = lines.slice(wIdx + 1).findIndex((l) => /^    PT-/.test(l));
    const blockEnd = nextHeaderRel < 0 ? Math.min(wIdx + 8, lines.length) : wIdx + 1 + nextHeaderRel;
    const block = lines.slice(wIdx, blockEnd).join("\n");
    assert.equal(block.includes("Multipliers:"), false);
  });
});

describe("formatPositionSummary — PR12b backport (formatters.ts:676)", () => {
  // The pre-fix bug: `pos.multipliers && pos.multipliers.length > 0` silently
  // no-ops on the object-form `{lp, yt}` variant — `.length` is undefined,
  // truthy check fails. Backport uses formatMultipliers() which handles both.
  function mkPos(overrides: any): any {
    return {
      name: "PT-test",
      address: "0xpt",
      maturity: Math.floor(Date.now() / 1000) + 86400 * 30,
      decimals: 18,
      balance: (10n ** 18n).toString(), // 1.0 PT
      pools: [
        {
          address: "0xpool",
          ptPrice: { usd: 0.95 },
          ytPrice: { usd: 0.05 },
          impliedApy: 0.05,
          lpApy: { total: 0.04 },
        },
      ],
      ibt: { symbol: "iUSDC", address: "0xibt", decimals: 18 },
      underlying: { symbol: "USDC", address: "0xu", decimals: 6 },
      ...overrides,
    };
  }

  it("renders Array-form multipliers as 'Points: <list>'", () => {
    const pos = mkPos({
      multipliers: [
        { name: "Avant points", amount: 40 },
        { name: "Aegis points", amount: 5 },
      ],
    });
    const result = formatPositionSummary(pos as SpectraPt, "base");
    assert.ok(result, "result must not be null");
    assert.match(result!.text, /^  Points: Avant points 40x, Aegis points 5x$/m);
  });

  it("renders object-form multipliers (PRE-FIX BUG: would silently no-op)", () => {
    const pos = mkPos({
      multipliers: {
        lp: [{ name: "Avant points", amount: 40 }],
        yt: [{ name: "Avant points", amount: 60 }],
      },
    });
    const result = formatPositionSummary(pos as SpectraPt, "base");
    assert.ok(result, "result must not be null");
    assert.match(result!.text, /^  Points: lp \[Avant points 40x\] \| yt \[Avant points 60x\]$/m);
  });

  it("silent on undefined multipliers", () => {
    const pos = mkPos({});
    const result = formatPositionSummary(pos as SpectraPt, "base");
    assert.ok(result);
    assert.equal(result!.text.includes("Points:"), false);
  });

  it("silent on empty Array multipliers", () => {
    const pos = mkPos({ multipliers: [] });
    const result = formatPositionSummary(pos as SpectraPt, "base");
    assert.ok(result);
    assert.equal(result!.text.includes("Points:"), false);
  });

  it("silent on object multipliers with no populated branches", () => {
    const pos = mkPos({ multipliers: { lp: [], yt: [] } });
    const result = formatPositionSummary(pos as SpectraPt, "base");
    assert.ok(result);
    assert.equal(result!.text.includes("Points:"), false);
  });
});

describe("formatPoolSummary — PR12b backport (formatters.ts:592)", () => {
  // Same bug-class as formatPositionSummary — fixed via formatMultipliers().
  function mkPt(overrides: any): any {
    return {
      name: "PT-test",
      address: "0xpt",
      maturity: Math.floor(Date.now() / 1000) + 86400 * 30,
      decimals: 18,
      tvl: { usd: 100_000 },
      pools: [
        {
          address: "0xpool",
          ptPrice: { usd: 0.95, underlying: 0.95 },
          ytPrice: { usd: 0.05 },
          ytLeverage: 20,
          impliedApy: 0.05,
          ptApy: 0.05,
          liquidity: { usd: 1_000_000 },
          ibtAmount: "1000",
          ptAmount: "1000",
        },
      ],
      ibt: { symbol: "iUSDC", protocol: "TestProtocol" },
      ...overrides,
    };
  }

  it("renders Array-form multipliers as 'Points: <list>'", () => {
    const pt = mkPt({
      multipliers: [{ name: "Drops", amount: 3 }, { name: "InfiniFi points", amount: 12 }],
    });
    const out = formatPoolSummary(pt as SpectraPt, pt.pools[0] as SpectraPool, "base");
    assert.match(out, /^  Points: Drops 3x, InfiniFi points 12x$/m);
  });

  it("renders object-form multipliers (PRE-FIX BUG: would silently no-op)", () => {
    const pt = mkPt({
      multipliers: {
        lp: [{ name: "Avant points", amount: 40 }],
        yt: [{ name: "Avant points", amount: 60 }],
      },
    });
    const out = formatPoolSummary(pt as SpectraPt, pt.pools[0] as SpectraPool, "base");
    assert.match(out, /^  Points: lp \[Avant points 40x\] \| yt \[Avant points 60x\]$/m);
  });

  it("silent on undefined multipliers", () => {
    const pt = mkPt({});
    const out = formatPoolSummary(pt as SpectraPt, pt.pools[0] as SpectraPool, "base");
    assert.equal(out.includes("Points:"), false);
  });

  it("silent on empty Array multipliers", () => {
    const pt = mkPt({ multipliers: [] });
    const out = formatPoolSummary(pt as SpectraPt, pt.pools[0] as SpectraPool, "base");
    assert.equal(out.includes("Points:"), false);
  });

  it("silent on object multipliers with no populated branches", () => {
    const pt = mkPt({ multipliers: {} });
    const out = formatPoolSummary(pt as SpectraPt, pt.pools[0] as SpectraPool, "base");
    assert.equal(out.includes("Points:"), false);
  });
});

describe("PR12b cross-call-site parity — same input renders consistently", () => {
  // The three call sites (formatMetavaultSummary, formatPositionSummary,
  // formatPoolSummary) share the formatMultipliers helper. This guards against
  // future drift where one site receives a fix the others don't.
  const objMult = {
    lp: [{ name: "Avant points", amount: 40 }],
    yt: [{ name: "Avant points", amount: 60 }],
  };
  const expectedRender = "lp [Avant points 40x] | yt [Avant points 60x]";

  it("formatMultipliers (the shared helper) produces the canonical render", () => {
    assert.equal(formatMultipliers(objMult), expectedRender);
  });

  it("formatPositionSummary uses the canonical render", () => {
    const pos: any = {
      name: "PT-test",
      address: "0xpt",
      maturity: Math.floor(Date.now() / 1000) + 86400 * 30,
      decimals: 18,
      balance: (10n ** 18n).toString(),
      pools: [{ address: "0xp", ptPrice: { usd: 0.95 }, ytPrice: { usd: 0.05 }, lpApy: { total: 0 }, impliedApy: 0 }],
      multipliers: objMult,
    };
    const r = formatPositionSummary(pos as SpectraPt, "base");
    assert.ok(r);
    assert.ok(r!.text.includes(expectedRender));
  });

  it("formatPoolSummary uses the canonical render", () => {
    const pt: any = {
      name: "PT-test",
      address: "0xpt",
      maturity: Math.floor(Date.now() / 1000) + 86400 * 30,
      decimals: 18,
      tvl: { usd: 100_000 },
      pools: [{
        address: "0xp",
        ptPrice: { usd: 0.95, underlying: 0.95 },
        ytPrice: { usd: 0.05 },
        ytLeverage: 20,
        ptApy: 0,
        impliedApy: 0,
        liquidity: { usd: 1_000_000 },
        ibtAmount: "1",
        ptAmount: "1",
      }],
      ibt: { symbol: "iUSDC", protocol: "X" },
      multipliers: objMult,
    };
    const out = formatPoolSummary(pt as SpectraPt, pt.pools[0] as SpectraPool, "base");
    assert.ok(out.includes(expectedRender));
  });
});

// ─── Phase 2 (discard-layer-spec v3-final) ──────────────────────────────────
//
// The next several describe blocks cover PR2a / PR2b / PR5 / PR6 / PR7b / PR8
// / PR9. PR7a (export refactor) is exercised by `performance.test.ts` —
// byte-equivalence of the moved functions is the contract there. Tests here
// validate the new formatter integration paths.

describe("formatMetavaultSummary — PR2b (curator URL)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMv(overrides: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
      ...overrides,
    };
  }

  it("appends URL when curator.url is populated", () => {
    const mv = mkMv({ curator: { name: "GamiLabs", addresses: ["0xabc"], url: "https://gamilabs.io/" } });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Curator: GamiLabs \(0xabc\) \| https:\/\/gamilabs\.io\/$/m);
  });

  it("silent when curator.url is missing (URL not appended)", () => {
    const mv = mkMv({ curator: { name: "Anon", addresses: ["0xabc"] } });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Curator: Anon \(0xabc\)$/m);
    assert.equal(out.includes(" | http"), false);
  });

  it("renders without address (curator.addresses empty) but with URL", () => {
    const mv = mkMv({ curator: { name: "Anon", addresses: [], url: "https://x.example/" } });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Curator: Anon \| https:\/\/x\.example\/$/m);
  });
});

describe("formatMetavaultSummary — PR2a (declared strategy + drift detection)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMv(overrides: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
      ...overrides,
    };
  }

  it("silent when defaultIbt is undefined", () => {
    const mv = mkMv({});
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Declared:/m.test(out), false);
    assert.equal(/^    drift:/m.test(out), false);
  });

  it("silent when positions array is empty (even with defaultIbt populated)", () => {
    const mv = mkMv({ defaultIbt: "0xdeadbeef", positions: [] });
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Declared:/m.test(out), false);
  });

  it("renders Declared without drift when ALL positions match defaultIbt", () => {
    const mv = mkMv({
      defaultIbt: "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
      positions: [
        { address: "0xpt1", maturity: NOW + 86400 * 30, ibt: { address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", symbol: "iUSDC" } },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Declared: iUSDC$/m, "Declared line must render with resolved symbol");
    assert.equal(/^    drift:/m.test(out), false, "no drift line when all positions match");
  });

  it("appends ' via <option>' when defaultOption is populated", () => {
    const mv = mkMv({
      defaultIbt: "0xdead",
      defaultOption: "0xc0ffee",
      positions: [{ address: "0xpt1", maturity: NOW + 86400, ibt: { address: "0xdead", symbol: "iWETH" } }],
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Declared: iWETH via 0xc0ffee$/m);
  });

  it("renders drift line when SOME positions diverge from defaultIbt", () => {
    const mv = mkMv({
      defaultIbt: "0xDEAD",
      positions: [
        { address: "0xpt1", maturity: NOW + 86400, ibt: { address: "0xdead", symbol: "iA" } },
        { address: "0xpt2", maturity: NOW + 86400, ibt: { address: "0xbeef", symbol: "iB" } },
        { address: "0xpt3", maturity: NOW + 86400, ibt: { address: "0xc0ffee", symbol: "iC" } },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Declared: iA$/m);
    assert.match(out, /^    drift: 1\/3 positions in declared address$/m);
  });

  it("renders drift line when NO positions match (full drift, inDeclared = 0)", () => {
    const mv = mkMv({
      defaultIbt: "0xDEAD",
      positions: [
        { address: "0xpt1", maturity: NOW + 86400, ibt: { address: "0xbeef", symbol: "iB" } },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    // No matched position → declared symbol falls back to the address itself.
    assert.match(out, /^  Declared: 0xDEAD$/m);
    assert.match(out, /^    drift: 0\/1 positions in declared address$/m);
  });

  it("uses no marker glyph (PR2a per §7.1 consolidation rule)", () => {
    const mv = mkMv({
      defaultIbt: "0xdead",
      positions: [
        { address: "0xpt1", maturity: NOW + 86400, ibt: { address: "0xbeef", symbol: "iB" } },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(out.includes("⚠"), false, "PR2a must NOT use ⚠ glyph");
  });

  it("denominator is mv.positions.length not positionAddrs.length (architect-inline-fix Phase 2)", () => {
    // Sonnet+soul depth lens (Phase 2 audit) caught: drift fraction was using
    // the count of positions WITH ibt.address (the filtered set), not total
    // positions. Spec says positions.length. With one position lacking an
    // ibt.address, the bug-shape would produce `0/1` (subset count) instead of
    // `0/2` (true count). Fix: denominator is mv.positions.length.
    const mv = mkMv({
      defaultIbt: "0xDEAD",
      positions: [
        { address: "0xpt1", maturity: NOW + 86400, ibt: { address: "0xbeef", symbol: "iB" } }, // address present, doesn't match declared
        { address: "0xpt2", maturity: NOW + 86400, ibt: { symbol: "iC" /* no address */ } }, // address missing
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    // Two positions total; zero match the declared address.
    // Pre-fix bug would produce `0/1` (only counting the address-populated subset).
    // Post-fix: `0/2` (true position count per spec).
    assert.match(out, /^    drift: 0\/2 positions in declared address$/m);
  });
});

describe("formatMetavaultSummary — PR2a fixture verification (Clearstar katana)", () => {
  // Phase 0 verified: only the katana Clearstar USDC fixture has defaultIbt
  // populated. positions[1] and positions[3] match (Yearn at the declared
  // address); positions[0] (Yearn alt) and positions[2] (Lucidly) diverge.
  const __dirname_pr2a = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = resolve(__dirname_pr2a, "../test/fixtures");
  function loadMvFixture(chain: string): any[] {
    return JSON.parse(readFileSync(resolve(fixturesDir, `metavaults-${chain}.json`), "utf8"));
  }

  it("Clearstar USDC renders Declared + drift line counting matches", () => {
    const mv = loadMvFixture("katana").find((m: any) => m.name === "Clearstar USDC");
    assert.ok(mv, "fixture missing");
    const out = formatMetavaultSummary(mv, "katana");
    // Declared line renders with resolved IBT symbol from a matching position.
    assert.match(out, /^  Declared: /m);
    // Drift line: 2 of 4 positions (Yearn pos[1] + Yearn pos[3]) match
    // declaredAddr; pos[0] (Yearn at different address) + pos[2] (Lucidly)
    // diverge.
    assert.match(out, /^    drift: 2\/4 positions in declared address$/m);
  });

  it("base Gami USDC has no defaultIbt → silent (no Declared, no drift)", () => {
    const mv = loadMvFixture("base").find((m: any) => m.name === "Gami USDC");
    assert.ok(mv, "fixture missing");
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Declared:/m.test(out), false);
    assert.equal(/^    drift:/m.test(out), false);
  });
});

describe("formatMetavaultSummary — PR5 (Upstream protocol with registry linkage)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMvWithProto(protoRaw: string): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1_000_000, underlying: 1_000_000 },
      liveApy: { total: 0.05 },
      positions: [
        {
          symbol: "PT-test",
          address: "0xpt1",
          maturity: NOW + 86400 * 30,
          decimals: 18,
          tvl: { usd: 100_000 },
          pools: [
            {
              address: "0xpool",
              lpt: { balance: (10n ** 18n).toString(), decimals: 18, price: { usd: 100 } },
              ptApy: 0.05,
              lpApy: { total: 0.04 },
            },
          ],
          ibt: { protocol: protoRaw, symbol: "iUSDC", address: "0xibt" },
        },
      ],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
    };
  }

  it("known protocol (avant) renders WITHOUT registry-pending annotation", () => {
    const mv = mkMvWithProto("Avant");
    const out = formatMetavaultSummary(mv, "base");
    // Display value preserves original casing.
    assert.match(out, /^      Upstream: Avant$/m);
    assert.equal(out.includes("registry: pending"), false);
  });

  it("trim-resilient: whitespace-padded 'Avant ' resolves through normalizeProtocolName", () => {
    const mv = mkMvWithProto("Avant ");
    const out = formatMetavaultSummary(mv, "base");
    // Renders the raw display value (with trailing space) but normalization
    // resolves to `avant` so no annotation fires.
    assert.match(out, /^      Upstream: Avant $/m);
    assert.equal(out.includes("registry: pending"), false);
  });

  it("unmapped CamelCase (Yearn) renders WITH registry-pending annotation", () => {
    const mv = mkMvWithProto("Yearn");
    const out = formatMetavaultSummary(mv, "base");
    assert.match(
      out,
      /^      Upstream: Yearn \(registry: pending — author entry per protocols-metadata-spec\)$/m,
    );
  });

  it("uses no ⚠ glyph (PR5 v3-final tonal fix)", () => {
    const mv = mkMvWithProto("Yearn");
    const out = formatMetavaultSummary(mv, "base");
    // Confirm no marker on the Upstream line specifically.
    const lines = out.split("\n");
    const upstreamLine = lines.find((l) => l.includes("Upstream:"));
    assert.ok(upstreamLine);
    assert.equal(upstreamLine!.includes("⚠"), false);
  });

  it("silent when ibt.protocol is undefined", () => {
    const mv = mkMvWithProto("");
    // Override with explicit undefined to test the silent path.
    mv.positions[0].ibt = { symbol: "iUSDC", address: "0xibt" };
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^      Upstream:/m.test(out), false);
  });
});

describe("formatMetavaultSummary — PR8 (reward tokens with addresses)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMvWithRewardTokens(rewardTokens: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1_000_000, underlying: 1_000_000 },
      liveApy: { total: 0.05 },
      positions: [
        {
          symbol: "PT-test",
          address: "0xpt1",
          maturity: NOW + 86400 * 30,
          decimals: 18,
          tvl: { usd: 100_000 },
          pools: [
            {
              address: "0xpool",
              lpt: { balance: (10n ** 18n).toString(), decimals: 18, price: { usd: 100 } },
              ptApy: 0.05,
            },
          ],
          ibt: {
            symbol: "iUSDC",
            address: "0xibt",
            apr: { details: { rewardTokens } },
          },
        },
      ],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
    };
  }

  it("renders symbols with shortened addresses when populated", () => {
    const mv = mkMvWithRewardTokens({
      rFLR: { address: "0x26d1234567890abcdef1234567890abcdef12345" },
      AvantPoints: { address: "0xab1234567890abcdef1234567890abcdef123456" },
    });
    const out = formatMetavaultSummary(mv, "flare");
    assert.match(
      out,
      /^      Reward tokens: rFLR \(0x26d1\.\.\.2345\), AvantPoints \(0xab12\.\.\.3456\)$/m,
    );
  });

  it("renders symbol-only when token lacks address", () => {
    const mv = mkMvWithRewardTokens({ POINTS: {} });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^      Reward tokens: POINTS$/m);
  });

  it("silent when rewardTokens record is empty", () => {
    const mv = mkMvWithRewardTokens({});
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^      Reward tokens:/m.test(out), false);
  });

  it("silent when rewardTokens is undefined", () => {
    const mv = mkMvWithRewardTokens(undefined);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^      Reward tokens:/m.test(out), false);
  });
});

describe("formatMetavaultSummary — PR6 (maturity value absolute + delta)", () => {
  // PR6 architect-inline-fix during Phase 2 audit synthesis (DEVIATION 1):
  // `maturityValue.usd` is per-share (e.g., $1.00 for USDC-pegged PT at par);
  // `tvl.usd` is position-total. The render bridges by multiplying per-share ×
  // balance/10^decimals. Tests set balance = 1 token (10^18 raw at 18 decimals)
  // so matUsd × 1 = matUsd — the existing test semantics survive verbatim.
  // A separate dedicated test below exercises the multiplication explicitly.
  const NOW = Math.floor(Date.now() / 1000);
  function mkMvWithMaturity(maturityUsd: number | undefined, tvlUsd: number | undefined): any {
    const ibt: any = { symbol: "iUSDC", address: "0xibt" };
    const pos: any = {
      symbol: "PT-test",
      address: "0xpt1",
      maturity: NOW + 86400 * 30,
      decimals: 18,
      balance: (10n ** 18n).toString(), // 1 token — multiplication identity
      ibt,
      pools: [
        {
          address: "0xpool",
          lpt: { balance: (10n ** 18n).toString(), decimals: 18, price: { usd: 100 } },
          ptApy: 0.05,
        },
      ],
    };
    if (typeof tvlUsd === "number") pos.tvl = { usd: tvlUsd };
    if (typeof maturityUsd === "number") pos.maturityValue = { usd: maturityUsd };

    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1_000_000, underlying: 1_000_000 },
      liveApy: { total: 0.05 },
      positions: [pos],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
    };
  }

  it("renders absolute + delta when |delta|/tvl > 1% (positive delta)", () => {
    const mv = mkMvWithMaturity(128_000, 126_000);
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^      Maturity value: \$128,000\.00 \(\+\$2,000\.00 vs TVL\)$/m);
  });

  it("renders absolute + delta when |delta|/tvl > 1% (negative delta = capital loss)", () => {
    const mv = mkMvWithMaturity(120_000, 126_000);
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^      Maturity value: \$120,000\.00 \(-\$6,000\.00 vs TVL\)$/m);
  });

  it("silent when |delta|/tvl ≤ 1% (within tolerance)", () => {
    // 126,000 → 126,500 = 0.4% deviation → silent.
    const mv = mkMvWithMaturity(126_500, 126_000);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^      Maturity value:/m.test(out), false);
  });

  it("silent when maturityValue.usd is undefined", () => {
    const mv = mkMvWithMaturity(undefined, 126_000);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^      Maturity value:/m.test(out), false);
  });

  it("silent when tvl.usd is undefined", () => {
    const mv = mkMvWithMaturity(128_000, undefined);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^      Maturity value:/m.test(out), false);
  });

  it("silent when both fields undefined", () => {
    const mv = mkMvWithMaturity(undefined, undefined);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^      Maturity value:/m.test(out), false);
  });

  it("multiplies per-share × balance to position-level (architect-inline-fix DEVIATION 1)", () => {
    // Realistic PT scenario: 100,000 tokens × $1.00/share = $100,000 expected
    // at maturity. tvl = $97,000. Delta = +$3,000 ≈ 3.1% > 1% threshold.
    // Verifies the multiplication bridges per-share API value to position-level
    // USD before delta comparison — without this, the literal-spec
    // implementation produces nonsense ($1.00 - $97,000 = -$96,999).
    const ibt: any = { symbol: "iUSDC", address: "0xibt" };
    const pos: any = {
      symbol: "PT-test",
      address: "0xpt1",
      maturity: NOW + 86400 * 30,
      decimals: 18,
      balance: (100_000n * 10n ** 18n).toString(), // 100,000 tokens
      ibt,
      pools: [
        {
          address: "0xpool",
          lpt: { balance: (10n ** 18n).toString(), decimals: 18, price: { usd: 100 } },
          ptApy: 0.05,
        },
      ],
      tvl: { usd: 97_000 },
      maturityValue: { usd: 1.0 }, // per-share USD
    };
    const mv: any = {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1_000_000, underlying: 1_000_000 },
      liveApy: { total: 0.05 },
      positions: [pos],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
    };
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^      Maturity value: \$100,000\.00 \(\+\$3,000\.00 vs TVL\)$/m);
  });

  it("silent when decimals is undefined (architect-inline-fix Diverger Phase 2)", () => {
    // Diverger lens caught: `PositionSchema.decimals: z.number().optional()` —
    // a future API state could ship `decimals: undefined` for a USDC (6-decimal)
    // position. Pre-fix `?? 18` default would mis-scale by 10^12 and render
    // visible-but-wrong output. Post-fix guards on `typeof === "number"`.
    const ibt: any = { symbol: "iUSDC", address: "0xibt" };
    const pos: any = {
      symbol: "PT-test",
      address: "0xpt1",
      maturity: NOW + 86400 * 30,
      // NO decimals field — schema-permitted undefined
      balance: "100000000000", // 100K USDC scale (would be 100K tokens at 6 decimals)
      ibt,
      pools: [{ address: "0xpool", lpt: { balance: (10n ** 18n).toString(), decimals: 18, price: { usd: 100 } }, ptApy: 0.05 }],
      tvl: { usd: 100_000 },
      maturityValue: { usd: 1.0 },
    };
    const mv: any = {
      address: "0xa0", vault: "0xb0", chainId: 8453, decimals: 6,
      name: "TestVault", symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1_000_000, underlying: 1_000_000 },
      liveApy: { total: 0.05 },
      positions: [pos],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
    };
    const out = formatMetavaultSummary(mv, "base");
    // Silent: no Maturity value line at all (better than mis-scaled nonsense).
    assert.equal(/^      Maturity value:/m.test(out), false);
  });

  it("silent when balance is missing (defensive — prevents per-share-vs-total nonsense)", () => {
    // Without balance, the multiplication can't proceed → silent. This is the
    // defensive guard preventing the DEVIATION 1 nonsense output (e.g., the
    // builder's flagged `$1.00 (-$449,157.00 vs TVL)` smoke test).
    const ibt: any = { symbol: "iUSDC", address: "0xibt" };
    const pos: any = {
      symbol: "PT-test",
      address: "0xpt1",
      maturity: NOW + 86400 * 30,
      decimals: 18,
      // NO balance field
      ibt,
      pools: [{ address: "0xpool", lpt: { balance: (10n ** 18n).toString(), decimals: 18, price: { usd: 100 } }, ptApy: 0.05 }],
      tvl: { usd: 97_000 },
      maturityValue: { usd: 1.0 },
    };
    const mv: any = {
      address: "0xa0", vault: "0xb0", chainId: 8453, decimals: 6,
      name: "TestVault", symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1_000_000, underlying: 1_000_000 },
      liveApy: { total: 0.05 },
      positions: [pos],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
    };
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^      Maturity value:/m.test(out), false);
  });
});

describe("formatMetavaultSummary — PR9 (bridge aggregate state with completion-collapse)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMvWithBridge(bridge: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs: [],
      bridge,
      createdAt: NOW - 100 * 86400,
    };
  }

  function mkTx(amountUsd: number, ts: number = NOW): any {
    return {
      status: "COMPLETED",
      hash: "0xfeedfacecafe1234567890",
      srcChainId: 8453,
      dstChainId: 43114,
      timestamp: ts,
      amountUsd,
    };
  }

  it("collapse fires: totalPendingUsd === 0 with completed txns → one-line summary", () => {
    const mv = mkMvWithBridge({
      transactions: [mkTx(100_000, NOW - 86400), mkTx(50_000, NOW - 2 * 86400)],
      totalPendingUsd: 0,
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Bridge: \$150,000\.00 total, 2 txns completed$/m);
    // No per-tx detail line.
    assert.equal(out.includes("  Bridge Transactions ("), false);
  });

  it("pending-with-no-history: totalPendingUsd > 0, empty txns → pending-only line", () => {
    const mv = mkMvWithBridge({
      transactions: [],
      totalPendingUsd: 75_000,
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Bridge: \$75,000\.00 pending \(no historical txns yet\)$/m);
  });

  it("active bridge: txns + nonzero pending → existing per-tx detail rendering", () => {
    const mv = mkMvWithBridge({
      transactions: [mkTx(100_000)],
      totalPendingUsd: 25_000,
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Bridge Transactions \(1\):$/m);
    assert.match(out, /^    Pending: \$25,000\.00$/m);
  });

  it("undefined totalPendingUsd with completed txns: falls through to per-tx detail (not collapse)", () => {
    const mv = mkMvWithBridge({
      transactions: [mkTx(100_000)],
      // no totalPendingUsd
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Bridge Transactions \(1\):$/m);
    // No collapse line, no pending line.
    assert.equal(/^  Bridge: \$.* total, .* txns completed$/m.test(out), false);
    assert.equal(/^    Pending:/m.test(out), false);
  });

  it("silent when no txns AND no/zero pending", () => {
    const mv1 = mkMvWithBridge({ transactions: [], totalPendingUsd: 0 });
    const out1 = formatMetavaultSummary(mv1, "base");
    assert.equal(/^  Bridge/m.test(out1), false);

    const mv2 = mkMvWithBridge({ transactions: [] });
    const out2 = formatMetavaultSummary(mv2, "base");
    assert.equal(/^  Bridge/m.test(out2), false);
  });

  it("NaN totalPendingUsd with txns falls through to per-tx detail (no NaN-string render)", () => {
    const mv = mkMvWithBridge({
      transactions: [mkTx(100_000)],
      totalPendingUsd: NaN,
    });
    const out = formatMetavaultSummary(mv, "base");
    // NaN === 0 is false, NaN > 0 is false → falls through to per-tx render.
    assert.match(out, /^  Bridge Transactions \(1\):$/m);
    assert.equal(out.includes("NaN"), false);
  });
});

describe("formatMetavaultSummary — PR7b (one-line performance integration)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMvWithEpochs(epochs: any[]): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs,
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
    };
  }

  it("renders 'Performance: TWR / DD / Sharpe (Xd)' line when epochs sufficient", () => {
    // 4 epochs over 90d, monotonic growth → TWR positive, DD ~0, Sharpe populated.
    const wei = 1_000_000;
    const epochs = [
      { timestamp: NOW - 90 * 86400, rate: String(1.0 * wei), assets: "0" },
      { timestamp: NOW - 60 * 86400, rate: String(1.01 * wei), assets: "0" },
      { timestamp: NOW - 30 * 86400, rate: String(1.02 * wei), assets: "0" },
      { timestamp: NOW, rate: String(1.03 * wei), assets: "0" },
    ];
    const mv = mkMvWithEpochs(epochs);
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Performance: TWR \d+\.\d+% \/ DD .+ \/ Sharpe .+ \(\d+d\)/m);
  });

  it("silent when epochs < 2 (computePerformanceMetrics returns null)", () => {
    const mv = mkMvWithEpochs([]);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Performance:/m.test(out), false);
  });

  it("silent when epochs is undefined", () => {
    const mv = mkMvWithEpochs(undefined as any);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Performance:/m.test(out), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — discard-layer-spec PR3 + PR12a + PR14
// PR3:  Description (priority INVERTED v3-final — description primary path,
//       shortDescription is curator-controlled override checked first only
//       when present)
// PR12a: Vault-level multipliers (Record<string, number> per schema)
// PR14:  Per-position Position Opened (createdAt → YYYY-MM-DD (Xd ago))
// ─────────────────────────────────────────────────────────────────────────────

describe("formatMetavaultSummary — PR3 (description-primary inversion v3-final)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMv(metadata: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
      metadata,
    };
  }

  it("description populated → renders truncated as primary path (PRIMARY)", () => {
    const mv = mkMv({
      description: "Gami's Spectra USDC vault deploys curator capital across PT-class positions.",
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(
      out,
      /^  Description: "Gami's Spectra USDC vault deploys curator capital across PT-class positions\."$/m,
    );
  });

  it("shortDescription populated → renders raw as override (curator-controlled)", () => {
    const mv = mkMv({
      shortDescription: "Curator-tuned brevity",
      description: "A much longer description that should NOT render when shortDescription is present.",
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Description: "Curator-tuned brevity"$/m);
    // Description must NOT render — shortDescription wins as override.
    assert.equal(out.includes("much longer description"), false);
  });

  it("both empty/undefined → silent (no Description line at all)", () => {
    const mv = mkMv(undefined);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Description:/m.test(out), false);
  });

  it("metadata object exists but both fields empty/undefined → silent", () => {
    const mv = mkMv({ title: "Just a title" });
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Description:/m.test(out), false);
  });

  it("long description (>140 chars) truncates with single-char ellipsis …", () => {
    const long =
      "This is a very long description that exceeds the 140 character cap and must be truncated to fit a single readable line on the cold-reader path output rendering.";
    const mv = mkMv({ description: long });
    const out = formatMetavaultSummary(mv, "base");
    const match = out.match(/^  Description: "(.+)"$/m);
    assert.ok(match, "Description line must render");
    const rendered = match![1];
    // truncateDescription cap is 140 chars including the ellipsis.
    assert.ok(rendered.length <= 140, `rendered length ${rendered.length} should be ≤ 140`);
    assert.ok(rendered.endsWith("…"), "truncated description must end with U+2026 ellipsis");
  });

  it("description exactly 140 chars → renders without ellipsis", () => {
    const exact = "x".repeat(140);
    const mv = mkMv({ description: exact });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, new RegExp(`^  Description: "${"x".repeat(140)}"$`, "m"));
    // Must NOT have an ellipsis appended.
    const match = out.match(/^  Description: "(.+)"$/m);
    assert.ok(match);
    assert.equal(match![1].endsWith("…"), false);
  });

  it("multi-paragraph description renders only first paragraph (per truncateDescription)", () => {
    const mv = mkMv({
      description: "First paragraph.\n\nSecond paragraph that should not render.",
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Description: "First paragraph\."$/m);
    assert.equal(out.includes("Second paragraph"), false);
  });
});

describe("formatMetavaultSummary — PR12a (vault-level multipliers)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMv(multipliers: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
      multipliers,
    };
  }

  it("renders 'Multipliers: <name> <amount>x' for single entry", () => {
    const mv = mkMv({ "Avant points": 40 });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Multipliers: Avant points 40x$/m);
  });

  it("renders multiple entries joined by ', '", () => {
    const mv = mkMv({ "PointsX": 2.0, "Avant": 3 });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Multipliers: PointsX 2x, Avant 3x$/m);
  });

  it("silent when multipliers undefined", () => {
    const mv = mkMv(undefined);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Multipliers:/m.test(out), false);
  });

  it("silent when multipliers is empty object", () => {
    const mv = mkMv({});
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Multipliers:/m.test(out), false);
  });

  it("renders BETWEEN TVL line and Live APY line per spec §6 layout", () => {
    const mv = mkMv({ "Avant points": 40 });
    const out = formatMetavaultSummary(mv, "base");
    const lines = out.split("\n");
    const tvlIdx = lines.findIndex((l) => l.startsWith("  TVL:"));
    const multIdx = lines.findIndex((l) => l.startsWith("  Multipliers:"));
    const apyIdx = lines.findIndex((l) => l.startsWith("  Live APY:"));
    assert.ok(tvlIdx >= 0 && multIdx >= 0 && apyIdx >= 0, "all three lines must render");
    assert.ok(tvlIdx < multIdx, "Multipliers must follow TVL");
    assert.ok(multIdx < apyIdx, "Multipliers must precede Live APY");
  });
});

describe("formatMetavaultSummary — PR14 (per-position Position Opened)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMvWithPosition(posOverrides: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1_000_000, underlying: 1_000_000 },
      liveApy: { total: 0.05 },
      positions: [
        {
          symbol: "PT-test",
          address: "0xpt1",
          maturity: NOW + 86400 * 30,
          decimals: 18,
          tvl: { usd: 100_000 },
          pools: [
            {
              address: "0xpool",
              lpt: { balance: (10n ** 18n).toString(), decimals: 18, price: { usd: 100 } },
              ptApy: 0.05,
              lpApy: { total: 0.04 },
            },
          ],
          ibt: { protocol: "Avant", symbol: "iUSDC", address: "0xibt" },
          ...posOverrides,
        },
      ],
      epochs: [],
      bridge: { transactions: [] },
      createdAt: NOW - 100 * 86400,
    };
  }

  it("renders 'Position Opened: YYYY-MM-DD (Xd ago)' when createdAt populated", () => {
    const opened = NOW - 30 * 86400; // 30 days ago
    const mv = mkMvWithPosition({ createdAt: opened });
    const out = formatMetavaultSummary(mv, "base");
    // Match a 6-space-indented line, ISO date, and a positive day-count.
    // Allow for off-by-one on day boundary edge (28-31 captures real fixture
    // time-of-day rounding).
    assert.match(
      out,
      /^      Position Opened: \d{4}-\d{2}-\d{2} \(\d+d ago\)$/m,
    );
  });

  it("uses 'Position Opened:' label NOT 'Inception:' per spec PR14 rename", () => {
    const opened = NOW - 5 * 86400;
    const mv = mkMvWithPosition({ createdAt: opened });
    const out = formatMetavaultSummary(mv, "base");
    // Vault-level Inception line exists (PR1); position-level must use the
    // distinct label. Search per-position render block specifically.
    const lines = out.split("\n");
    const positionLines = lines.filter((l) => l.startsWith("      "));
    const inceptionInPosition = positionLines.find((l) => l.includes("Inception:"));
    assert.equal(inceptionInPosition, undefined, "no 'Inception:' label inside per-position render");
    const openedLine = positionLines.find((l) => l.includes("Position Opened:"));
    assert.ok(openedLine, "'Position Opened:' must appear in per-position render");
  });

  it("silent when position.createdAt is undefined (defensive)", () => {
    const mv = mkMvWithPosition({}); // no createdAt
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^      Position Opened:/m.test(out), false);
  });

  it("renders correct day-count for known fixed timestamp", () => {
    const sevenDaysAgo = NOW - 7 * 86400;
    const mv = mkMvWithPosition({ createdAt: sevenDaysAgo });
    const out = formatMetavaultSummary(mv, "base");
    // Allow 6-7 days due to UTC midnight rounding.
    assert.match(out, /^      Position Opened: \d{4}-\d{2}-\d{2} \([67]d ago\)$/m);
  });
});

describe("formatMetavaultSummary — Phase 3 cross-PR fixture integration (gamisUSDC base)", () => {
  // Live gamisUSDC base fixture is the only MV with vault-level multipliers
  // populated (`{"Avant points": 40}`) — confirms PR3 + PR12a + PR14 all
  // render together on a single representative vault.
  const __dirname_ph3 = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = resolve(__dirname_ph3, "../test/fixtures");
  function loadMvFixture(chain: string): any[] {
    return JSON.parse(readFileSync(resolve(fixturesDir, `metavaults-${chain}.json`), "utf8"));
  }

  it("Gami USDC: PR3 description renders (truncated <=140), PR12a vault-multipliers renders, PR14 per-position Position Opened renders", () => {
    const mv = loadMvFixture("base").find((m: any) => m.name === "Gami USDC");
    assert.ok(mv, "Gami USDC fixture missing from base chain");
    const out = formatMetavaultSummary(mv, "base");

    // PR3 — description renders (Phase 0 confirmed shortDescription empty 0/6).
    // Match opening of Gami's actual fixture text — not the full 140-char window.
    const descMatch = out.match(/^  Description: "(.+)"$/m);
    assert.ok(descMatch, "Description line must render from base description");
    assert.ok(descMatch![1].length > 0, "Description must have content");
    assert.ok(descMatch![1].length <= 140, "Description must be ≤140 chars after truncation");

    // PR12a — vault-level multipliers renders Avant points 40x.
    assert.match(out, /^  Multipliers: Avant points 40x$/m);

    // PR14 — at least one allocated position renders Position Opened.
    // Per Phase 1 DEVIATION 1, only allocated positions render; gamisUSDC
    // has 4 active positions so at least one must surface this line.
    assert.match(
      out,
      /^      Position Opened: \d{4}-\d{2}-\d{2} \(\d+d ago\)$/m,
    );
  });
});

// =============================================================================
// Discard-layer Phase 4 — PR10a (home governance), PR10b (remote governance),
// PR11 (pending actions / transactionQueue).
// =============================================================================
//
// Spec: docs/discard-layer-spec.md §1 PR10a + PR10b + PR11, §6 layout, §7
// fixture-first gate, §7.1 consolidation rule.
//
// FIXTURE STATE (Phase 4 capture, all 4 chains, 6 vaults):
//   - metavault.modifier: 6/6 populated; roles=Record<3, address>, delay=Record<1, address>
//   - metavault.remote: 2/6 populated (gamisUSDC + UltraWETH on chainId 43114)
//   - metavault.transactionQueue: 1/6 populated (gamisUSDC base, single QUEUED action on 43114)
//   - metavault.swap: 6/6 populated as { cow: [] } — empty array → silent (PR11 swap-rendering deferred)
//
// DEVIATION 1 (PR10a/b): modifier.delay values are delay-module addresses
// (42-char hex), not seconds-as-string. Renderer routes through formatRoleRecord
// (address shape), not formatDelayRecord. Tests verify the address-shape render.

import {
  TRANSACTION_QUEUE_KNOWN_KEYS,
} from "./formatters.js";

describe("formatMetavaultSummary — PR10a (home-chain governance)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMv(modifier: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs: [],
      modifier,
      createdAt: NOW - 100 * 86400,
    };
  }

  it("renders Governance line with roles + delays when modifier populated", () => {
    const mv = mkMv({
      roles: {
        default: "0x0ff57d8ffd6cf7084a55da7620ab96bc895ce4ba",
        pool: "0x549b402952142f5b5a9153cec5cf2100de027f51",
      },
      delay: {
        default: "0x4bfc00addb8d4ba5d1c35e7bee6d8e10bbb5fde5",
      },
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(
      out,
      /^  Governance: default=0x0ff5\.\.\.e4ba, pool=0x549b\.\.\.7f51 \| default=0x4bfc\.\.\.fde5$/m,
    );
  });

  it("silent when modifier undefined", () => {
    const mv = mkMv(undefined);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Governance:/m.test(out), false);
  });

  it("silent when modifier present but roles + delay both empty", () => {
    const mv = mkMv({ roles: {}, delay: {} });
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Governance:/m.test(out), false);
  });

  it("DEVIATION 1: delay values render as addresses (formatRoleRecord shape), not [unparsed:0x...] or '0s'", () => {
    // The Phase 0 formatSecondsAsDuration would mis-render '0x...' as '0s'
    // because parseInt('0x...', 10) === 0. This test guards against the
    // wrong-helper regression: must NOT contain '[unparsed:' AND must NOT
    // contain ' 0s' (with leading space, to avoid catching the scary 's' in
    // 'positions').
    const mv = mkMv({
      roles: { default: "0x0ff57d8ffd6cf7084a55da7620ab96bc895ce4ba" },
      delay: { default: "0x4bfc00addb8d4ba5d1c35e7bee6d8e10bbb5fde5" },
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(out.includes("[unparsed:"), false, "delays must not render as [unparsed:...]");
    assert.equal(/Governance:.*\b0s\b/.test(out), false, "delays must not render as '0s'");
    // Positive: delay address must appear in shortened form on the Governance line.
    assert.match(out, /Governance:.*0x4bfc\.\.\.fde5/);
  });

  it("renders without ⚠ glyph (§7.1 consolidation rule)", () => {
    const mv = mkMv({
      roles: { default: "0x0ff57d8ffd6cf7084a55da7620ab96bc895ce4ba" },
      delay: { default: "0x4bfc00addb8d4ba5d1c35e7bee6d8e10bbb5fde5" },
    });
    const out = formatMetavaultSummary(mv, "base");
    const govLine = out.split("\n").find((l) => /^  Governance:/.test(l));
    assert.ok(govLine, "Governance line must render");
    assert.equal(govLine!.includes("⚠"), false, "PR10a must NOT use ⚠ glyph");
  });

  it("renders with only roles populated (delay undefined)", () => {
    const mv = mkMv({
      roles: { default: "0x0ff57d8ffd6cf7084a55da7620ab96bc895ce4ba" },
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Governance: default=0x0ff5\.\.\.e4ba \| \(no delays\)$/m);
  });

  it("renders with only delay populated (roles undefined)", () => {
    const mv = mkMv({
      delay: { default: "0x4bfc00addb8d4ba5d1c35e7bee6d8e10bbb5fde5" },
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Governance: \(no roles\) \| default=0x4bfc\.\.\.fde5$/m);
  });
});

describe("formatMetavaultSummary — PR10b (remote-chain governance, list-always)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMv(remote: any, modifier: any = undefined): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs: [],
      remote,
      modifier,
      createdAt: NOW - 100 * 86400,
    };
  }

  it("renders per-chain Governance line when remote populated", () => {
    const mv = mkMv({
      "43114": {
        address: "0xremote",
        modifier: {
          roles: { default: "0x1040d6728da55813713fd1b74737911e6568a059" },
          delay: { default: "0xa9239af676f6ebd62bd5125d2c97fb9ae49c93f1" },
        },
      },
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(
      out,
      /^  Governance \(43114\): default=0x1040\.\.\.a059 \| default=0xa923\.\.\.93f1$/m,
    );
  });

  it("silent when remote undefined", () => {
    const mv = mkMv(undefined);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Governance \(\d+\):/m.test(out), false);
  });

  it("silent when remote present but modifier missing for entry", () => {
    const mv = mkMv({
      "43114": { address: "0xremote" }, // no modifier
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Governance \(43114\):/m.test(out), false);
  });

  it("renders multi-chain remote independently per chain", () => {
    const mv = mkMv({
      "43114": {
        modifier: {
          roles: { default: "0x1040d6728da55813713fd1b74737911e6568a059" },
        },
      },
      "10": {
        modifier: {
          delay: { default: "0xa9239af676f6ebd62bd5125d2c97fb9ae49c93f1" },
        },
      },
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Governance \(43114\): default=0x1040\.\.\.a059 \| \(no delays\)$/m);
    assert.match(out, /^  Governance \(10\): \(no roles\) \| default=0xa923\.\.\.93f1$/m);
  });

  it("PR10a + PR10b render together, home line first, remote line(s) after", () => {
    const mv = mkMv(
      {
        "43114": {
          modifier: {
            roles: { default: "0x1040d6728da55813713fd1b74737911e6568a059" },
            delay: { default: "0xa9239af676f6ebd62bd5125d2c97fb9ae49c93f1" },
          },
        },
      },
      {
        roles: { default: "0x0ff57d8ffd6cf7084a55da7620ab96bc895ce4ba" },
        delay: { default: "0x4bfc00addb8d4ba5d1c35e7bee6d8e10bbb5fde5" },
      },
    );
    const out = formatMetavaultSummary(mv, "base");
    const lines = out.split("\n");
    const homeIdx = lines.findIndex((l) => /^  Governance: /.test(l));
    const remoteIdx = lines.findIndex((l) => /^  Governance \(43114\): /.test(l));
    assert.ok(homeIdx >= 0, "home Governance line must render");
    assert.ok(remoteIdx > homeIdx, "remote Governance line must follow home line");
  });
});

describe("TRANSACTION_QUEUE_KNOWN_KEYS — PR11 fixture-first gate (§7)", () => {
  it("contains the canonical 18 keys observed in gamisUSDC base fixture", () => {
    const expectedKeys = [
      "__typename", "operator", "queueNonce", "timelockedTransactionHash",
      "timestamp", "blockNumber", "to", "value", "data", "operation",
      "transactionHash", "delayModule", "chainId", "status",
      "executionMaxTimestamp", "cooldownEndTimestamp", "metavault", "actions",
    ];
    for (const k of expectedKeys) {
      assert.ok(TRANSACTION_QUEUE_KNOWN_KEYS.has(k), `KNOWN_KEYS must contain '${k}'`);
    }
    assert.equal(TRANSACTION_QUEUE_KNOWN_KEYS.size, expectedKeys.length);
  });

  it("snapshot — fixture entry's keys are all in KNOWN_KEYS (gamisUSDC base, chainId 43114)", () => {
    // Load live fixture and assert every key in the entry survives the
    // KNOWN_KEYS gate. When the API ships a new field, this fails LOUD with
    // the unknown-key list — exactly the §7 fixture-first contract.
    const __dirname_pr11 = dirname(fileURLToPath(import.meta.url));
    const fixturesDir = resolve(__dirname_pr11, "../test/fixtures");
    const data = JSON.parse(
      readFileSync(resolve(fixturesDir, "metavaults-base.json"), "utf8"),
    );
    const gami = data.find((m: any) => m.symbol === "gamisUSDC");
    assert.ok(gami, "gamisUSDC fixture missing");
    const queue = gami.transactionQueue?.["43114"];
    assert.ok(Array.isArray(queue) && queue.length > 0, "queue entry missing");

    for (const entry of queue) {
      const observedKeys = Object.keys(entry);
      const unknownKeys = observedKeys.filter((k) => !TRANSACTION_QUEUE_KNOWN_KEYS.has(k));
      assert.equal(
        unknownKeys.length,
        0,
        `[unsupported-shape: ${unknownKeys.join(",")}] — KNOWN_KEYS stale; re-inspect fixture + extend constant`,
      );
    }
  });
});

describe("formatMetavaultSummary — PR11 (transactionQueue rendering, fixture-first)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  function mkMv(transactionQueue: any): any {
    return {
      address: "0xa0",
      vault: "0xb0",
      chainId: 8453,
      decimals: 6,
      name: "TestVault",
      symbol: "TV",
      curator: { name: "Curator", addresses: ["0xabc"] },
      underlying: { address: "0x1", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      tvl: { usd: 1000, underlying: 1000 },
      liveApy: { total: 0.05 },
      positions: [],
      epochs: [],
      transactionQueue,
      createdAt: NOW - 100 * 86400,
    };
  }

  it("silent when transactionQueue undefined", () => {
    const mv = mkMv(undefined);
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Pending \(/m.test(out), false);
  });

  it("silent when transactionQueue is empty record {}", () => {
    const mv = mkMv({});
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Pending \(/m.test(out), false);
  });

  it("silent when transactionQueue.{chainId} is empty array", () => {
    const mv = mkMv({ "43114": [] });
    const out = formatMetavaultSummary(mv, "base");
    assert.equal(/^  Pending \(/m.test(out), false);
  });

  it("renders Pending line when queue populated with one action", () => {
    const mv = mkMv({
      "43114": [
        {
          __typename: "TimelockedTransactionAdded",
          operator: "0x9878aef8a193dbfcefa8a6ece3eb15f93ca31c9e",
          queueNonce: "4",
          timelockedTransactionHash: "0xacb6379c0f94ab5034d92f19d1441fe79f4d29fd956718c7efd86e9e579bb087",
          timestamp: "1776671630", // 2026-04-21
          blockNumber: "83410525",
          to: "0x9641d764fc13c8b624c04430c7356c1c7c8102e2",
          value: "0",
          data: "0x...",
          operation: 1,
          transactionHash: "0xa4b5b3862f54e6b1f52361bddd08fa2b68e3f6495816ac98db42626a86ac07da",
          delayModule: "0xa9239af676f6ebd62bd5125d2c97fb9ae49c93f1",
          chainId: 43114,
          status: "QUEUED",
          executionMaxTimestamp: "1777881230",
          cooldownEndTimestamp: "1777276430", // 2026-04-28
          metavault: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
          actions: [
            {
              functionName: "registerMarketAsMetavault",
              selector: "0x275fd665",
              signature: "registerMarketAsMetavault(address)",
            },
          ],
        },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    // Match the structural shape: chainId, selector, functionName, executable + queued ISO dates.
    assert.match(
      out,
      /^  Pending \(43114\): 0x275fd665 registerMarketAsMetavault → executable \d{4}-\d{2}-\d{2} \(queued \d{4}-\d{2}-\d{2}\)$/m,
    );
  });

  it("renders Pending line with [unsupported-shape] suffix when unknown keys present", () => {
    const mv = mkMv({
      "43114": [
        {
          __typename: "TimelockedTransactionAdded",
          timestamp: "1776671630",
          cooldownEndTimestamp: "1777276430",
          chainId: 43114,
          actions: [
            { selector: "0x275fd665", functionName: "registerMarketAsMetavault" },
          ],
          // Unknown future fields that the API might ship:
          newFutureField: "drift",
          anotherDriftKey: 42,
        },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    // Must contain unsupported-shape annotation listing both unknown keys.
    assert.match(out, /\[unsupported-shape: newFutureField,anotherDriftKey\]/);
    // Must STILL render the known-keys subset (no silent drop).
    assert.match(out, /Pending \(43114\): 0x275fd665 registerMarketAsMetavault/);
  });

  it("falls back to (unnamed) when actions[] is missing/empty", () => {
    const mv = mkMv({
      "43114": [
        {
          __typename: "TimelockedTransactionAdded",
          timestamp: "1776671630",
          cooldownEndTimestamp: "1777276430",
          chainId: 43114,
          // actions field intentionally absent
        },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(
      out,
      /^  Pending \(43114\): \(unnamed\) → executable \d{4}-\d{2}-\d{2} \(queued \d{4}-\d{2}-\d{2}\)$/m,
    );
  });

  it("skips non-QUEUED status entries (architect-inline-fix Phase 4 audit, Sonnet+soul + Diverger convergent)", () => {
    // Sonnet+soul depth lens caught: PR11 was rendering ALL transactionQueue
    // entries as "Pending" regardless of status. Diverger lens caught: gamisUSDC
    // fixture's QUEUED action becomes EXECUTED post-cooldown (this week);
    // unfiltered renderer would label executed actions as "Pending" — wrong on
    // realistic future input. Architect-inline-fix added filter:
    //   if (entry.status && entry.status !== "QUEUED") continue;
    // Defensive: missing status defaults to render (same render path).
    const mv = mkMv({
      "43114": [
        {
          __typename: "TimelockedTransactionAdded",
          timestamp: "1776671630",
          cooldownEndTimestamp: "1777276430",
          chainId: 43114,
          status: "EXECUTED", // post-execution state — must NOT render as Pending
          actions: [{ selector: "0x275fd665", functionName: "registerMarketAsMetavault" }],
        },
        {
          __typename: "TimelockedTransactionAdded",
          timestamp: "1776671630",
          cooldownEndTimestamp: "1777276430",
          chainId: 43114,
          status: "CANCELLED", // also not pending
          actions: [{ selector: "0xabc12345", functionName: "cancelledAction" }],
        },
        {
          __typename: "TimelockedTransactionAdded",
          timestamp: "1776671630",
          cooldownEndTimestamp: "1777276430",
          chainId: 43114,
          status: "QUEUED", // only this one renders
          actions: [{ selector: "0xdef00000", functionName: "actuallyPending" }],
        },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    // Only the QUEUED entry renders as Pending.
    assert.match(out, /Pending \(43114\): 0xdef00000 actuallyPending/);
    // Executed and cancelled entries must NOT render as Pending.
    assert.equal(out.includes("0x275fd665 registerMarketAsMetavault"), false);
    assert.equal(out.includes("0xabc12345 cancelledAction"), false);
    // No "Pending" line for non-QUEUED selectors.
    assert.equal((out.match(/^  Pending \(/gm) ?? []).length, 1);
  });

  it("renders entry when status field is absent (defensive: assumes QUEUED)", () => {
    // Schema permits status: undefined. Defensive render preserves the spec's
    // "pending-actions only" promise without silently dropping entries.
    const mv = mkMv({
      "43114": [
        {
          __typename: "TimelockedTransactionAdded",
          timestamp: "1776671630",
          cooldownEndTimestamp: "1777276430",
          chainId: 43114,
          // NO status field
          actions: [{ selector: "0x275fd665", functionName: "registerMarketAsMetavault" }],
        },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /Pending \(43114\): 0x275fd665 registerMarketAsMetavault/);
  });

  it("does NOT render actions[].args by default (verbose-flag deferred per round-3 audit)", () => {
    const mv = mkMv({
      "43114": [
        {
          __typename: "TimelockedTransactionAdded",
          timestamp: "1776671630",
          cooldownEndTimestamp: "1777276430",
          actions: [
            {
              selector: "0x275fd665",
              functionName: "registerMarketAsMetavault",
              args: ["0xaad365D97418452b4F9D046f4F2468349d680587"],
              argsNamed: { market: "0xaad365D97418452b4F9D046f4F2468349d680587" },
            },
          ],
        },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    // The default render must NOT include the 0xaad... args address.
    assert.equal(out.includes("0xaad365D97418452b4F9D046f4F2468349d680587"), false);
    // The args-included form would have included it — that's the verbose-flag work.
  });

  it("handles cooldownEndTimestamp missing / NaN gracefully (renders '(unknown)')", () => {
    const mv = mkMv({
      "43114": [
        {
          __typename: "TimelockedTransactionAdded",
          timestamp: "1776671630",
          // no cooldownEndTimestamp
          actions: [{ selector: "0x275fd665", functionName: "registerMarketAsMetavault" }],
        },
      ],
    });
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /executable \(unknown\)/);
  });
});

describe("formatMetavaultSummary — Phase 4 cross-PR fixture integration (gamisUSDC base)", () => {
  // gamisUSDC base is the only fixture that exercises ALL THREE Phase 4 PRs:
  //   - PR10a: home modifier populated (roles + delay)
  //   - PR10b: remote populated (chainId 43114 with modifier)
  //   - PR11: transactionQueue populated (one QUEUED action)
  //
  // This test guards the cross-PR layout invariant: home Governance →
  // remote Governance → Pending, in that order, within the formatter output.
  const __dirname_ph4 = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = resolve(__dirname_ph4, "../test/fixtures");
  function loadMvFixture(chain: string): any[] {
    return JSON.parse(readFileSync(resolve(fixturesDir, `metavaults-${chain}.json`), "utf8"));
  }

  it("Gami USDC: PR10a + PR10b + PR11 all render together, in spec §6 layout order", () => {
    const mv = loadMvFixture("base").find((m: any) => m.name === "Gami USDC");
    assert.ok(mv, "Gami USDC fixture missing from base chain");
    const out = formatMetavaultSummary(mv, "base");
    const lines = out.split("\n");

    const homeGovIdx = lines.findIndex((l) => /^  Governance: /.test(l));
    const remoteGovIdx = lines.findIndex((l) => /^  Governance \(43114\): /.test(l));
    const pendingIdx = lines.findIndex((l) => /^  Pending \(43114\): /.test(l));

    assert.ok(homeGovIdx >= 0, "PR10a home Governance line must render for gamisUSDC");
    assert.ok(remoteGovIdx > homeGovIdx, "PR10b remote Governance must follow home");
    assert.ok(pendingIdx > remoteGovIdx, "PR11 Pending must follow Governance per §6");
  });

  it("UltraWETH base: PR10a renders, PR10b renders (43114), PR11 silent (empty queue)", () => {
    const mv = loadMvFixture("base").find((m: any) => m.symbol === "UltraWETH");
    assert.ok(mv, "UltraWETH fixture missing from base chain");
    const out = formatMetavaultSummary(mv, "base");
    assert.match(out, /^  Governance: /m);
    assert.match(out, /^  Governance \(43114\): /m);
    assert.equal(/^  Pending \(/m.test(out), false);
  });

  it("gamisXRP flare: PR10a renders, PR10b silent (no remote), PR11 silent", () => {
    const mv = loadMvFixture("flare").find((m: any) => m.symbol === "gamisXRP");
    assert.ok(mv, "gamisXRP fixture missing from flare chain");
    const out = formatMetavaultSummary(mv, "flare");
    assert.match(out, /^  Governance: /m);
    assert.equal(/^  Governance \(\d+\): /m.test(out), false);
    assert.equal(/^  Pending \(/m.test(out), false);
  });
});

// =============================================================================
// PR-L: formatPointsMultipliers — shape-based tests against §5.5 render gallery
// =============================================================================
//
// Discipline (P7-BL-6 α of hardcode-vs-generalize-spec.md): tests assert
// against the SHAPE invariant, NOT against fixture-mirror literals like /40x/.
// Values are read from PROTOCOL_METADATA.avant.pointsMultipliers and composed
// into expected regexes — if Avant changes the program (40 → 45), the
// formatter still works and the test still passes (because the contract is
// shape, not value).
//
// The render gallery (spec §5.5) defines four contracts:
//   (a) position-active object form  → "lp [Avant points {LP_AMT}x] | yt [Avant points {YT_AMT}x]"
//   (b) position-active array form   → "Avant points {AMT}x"
//   (c) position-empty active        → "Avant points: lp {LP_AMT}x, yt {YT_AMT}x (from metadata)"
//   (d) position-empty expired       → "[REFERENCE-ONLY] Avant points: lp {LP_AMT}x, yt {YT_AMT}x — position expired/in-cooldown, points NOT accruing"
describe("formatPointsMultipliers — render gallery contracts (shape-based)", () => {
  // Reach into the registry instead of hardcoding 40 / 60 — when Avant changes
  // their program, this test stays correct.
  const avantMeta = (PROTOCOL_METADATA as any).avant;
  const avantPm = avantMeta.pointsMultipliers;
  const lpEntry = avantPm.find((p: any) => p.scope === "lp");
  const ytEntry = avantPm.find((p: any) => p.scope === "yt");
  const lpAmt = lpEntry.amount;
  const ytAmt = ytEntry.amount;
  const program = lpEntry.program;

  it("(a) position-active object form: renders both lp + yt with brackets", () => {
    const positionMultipliers = {
      lp: [{ name: program, amount: lpAmt }],
      yt: [{ name: program, amount: ytAmt }],
    };
    const out = formatPointsMultipliers(positionMultipliers, avantMeta, { isExpired: false, isInCooldown: false });
    assert.ok(out, "expected non-null render");
    // SHAPE: "lp [{program} {LP_AMT}x] | yt [{program} {YT_AMT}x]"
    assert.match(out!, new RegExp(`lp \\[${program} ${lpAmt}x\\] \\| yt \\[${program} ${ytAmt}x\\]`));
    // NOT mirror fixture: never assert /40x/ or /60x/ literally.
  });

  it("(b) position-active array form: renders inline", () => {
    const positionMultipliers = [{ name: program, amount: lpAmt }];
    const out = formatPointsMultipliers(positionMultipliers, avantMeta, { isExpired: false, isInCooldown: false });
    assert.ok(out, "expected non-null render");
    assert.match(out!, new RegExp(`${program} ${lpAmt}x`));
  });

  it("(c) position-empty active: falls back to metadata with '(from metadata)' suffix", () => {
    const out = formatPointsMultipliers(undefined, avantMeta, { isExpired: false, isInCooldown: false });
    assert.ok(out, "expected non-null render from metadata");
    // SHAPE: "{program}: lp {LP_AMT}x, yt {YT_AMT}x (from metadata)"
    assert.match(out!, new RegExp(`${program}: lp ${lpAmt}x, yt ${ytAmt}x \\(from metadata\\)`));
  });

  it("(d) position-empty expired: [REFERENCE-ONLY] prefix + accrual warning", () => {
    const out = formatPointsMultipliers(undefined, avantMeta, { isExpired: true, isInCooldown: false });
    assert.ok(out, "expected non-null render from metadata in expired branch");
    assert.match(out!, /^\[REFERENCE-ONLY\] /);
    assert.match(out!, new RegExp(`${program}: lp ${lpAmt}x, yt ${ytAmt}x`));
    assert.match(out!, /points NOT accruing/);
  });

  it("(d) position-empty in-cooldown: [REFERENCE-ONLY] prefix (same as expired)", () => {
    const out = formatPointsMultipliers(undefined, avantMeta, { isExpired: false, isInCooldown: true });
    assert.ok(out);
    assert.match(out!, /^\[REFERENCE-ONLY\] /);
    assert.match(out!, /points NOT accruing/);
  });

  it("position-active wins over metadata: object-form populated → no fallback", () => {
    const positionMultipliers = {
      lp: [{ name: program, amount: lpAmt }],
      yt: [{ name: program, amount: ytAmt }],
    };
    const out = formatPointsMultipliers(positionMultipliers, avantMeta, { isExpired: false, isInCooldown: false });
    // No metadata-fallback markers should appear when position data is present
    assert.ok(!out!.includes("(from metadata)"));
    assert.ok(!out!.includes("[REFERENCE-ONLY]"));
  });

  it("returns null for protocol with no metadata pointsMultipliers + no position data", () => {
    const pendleMeta = (PROTOCOL_METADATA as any).pendle;
    // Pendle metadata doesn't populate pointsMultipliers; with no position data → null
    const out = formatPointsMultipliers(undefined, pendleMeta, { isExpired: false, isInCooldown: false });
    assert.equal(out, null);
  });

  it("returns null for _unknown protocol with no position data", () => {
    const unknownMeta = (PROTOCOL_METADATA as any)._unknown;
    const out = formatPointsMultipliers(undefined, unknownMeta, { isExpired: false, isInCooldown: false });
    assert.equal(out, null);
  });

  it("staleness annotation: validUntil in the past appends [stale since X]", () => {
    // Synthetic meta with past validUntil — does NOT mutate registry
    const pastDate = "2024-01-01";
    const syntheticMeta: any = {
      ...avantMeta,
      pointsMultipliers: [
        { ...lpEntry, validUntil: pastDate },
        { ...ytEntry, validUntil: pastDate },
      ],
    };
    const out = formatPointsMultipliers(undefined, syntheticMeta, { isExpired: false, isInCooldown: false });
    assert.ok(out);
    assert.match(out!, /\[stale since \d{4}-\d{2}-\d{2}\]/);
  });
});
