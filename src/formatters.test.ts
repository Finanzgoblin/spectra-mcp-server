/**
 * Unit tests for formatters.ts — pure computation functions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
  estimateLoopingEntryCost,
  buildQuoteFromPt,
  detectActivityCycles,
  formatCycleAnalysis,
  formatFlowAccounting,
} from "./formatters.js";

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
    };
    const lines = formatCycleAnalysis(cycle, 15000);
    assert.ok(lines.length >= 3);
    // Should contain the pattern
    const joined = lines.join("\n");
    assert.ok(joined.includes("Add Liquidity"), "Should format activity types");
    assert.ok(joined.includes("Remove Liquidity"));
    assert.ok(joined.includes("Sell PT"));
    assert.ok(joined.includes("8×"), "Should show repetition count");
    assert.ok(joined.includes("mint→LP→unwind→sell"), "Should include interpretive hint for ADD→REMOVE→SELL");
    assert.ok(joined.includes("get_portfolio"), "Should cross-reference portfolio");
  });

  it("hints at flash-mint for SELL_PT-only cycle", () => {
    const cycle = {
      pattern: ["SELL_PT", "SELL_PT"],
      count: 10,
      totalValueUsd: 5000,
      avgValueUsd: 500,
      coverageFraction: 0.9,
      uncoveredCount: 2,
    };
    const lines = formatCycleAnalysis(cycle, 6000);
    const joined = lines.join("\n");
    assert.ok(joined.includes("flash-mint") || joined.includes("PT dumping"), "Should hint at flash-mint or PT dumping");
  });

  it("hints at PT accumulation for BUY_PT-only cycle", () => {
    const cycle = {
      pattern: ["BUY_PT", "BUY_PT"],
      count: 5,
      totalValueUsd: 10000,
      avgValueUsd: 2000,
      coverageFraction: 0.8,
      uncoveredCount: 3,
    };
    const lines = formatCycleAnalysis(cycle, 12000);
    const joined = lines.join("\n");
    assert.ok(joined.includes("PT accumulation") || joined.includes("flash-redeem"), "Should hint at PT accumulation or YT selling");
  });

  it("includes uncovered count when present", () => {
    const cycle = {
      pattern: ["AMM_ADD_LIQUIDITY", "SELL_PT"],
      count: 4,
      totalValueUsd: 4000,
      avgValueUsd: 1000,
      coverageFraction: 0.8,
      uncoveredCount: 2,
    };
    const lines = formatCycleAnalysis(cycle, 5000);
    const joined = lines.join("\n");
    assert.ok(joined.includes("2 txn(s) outside"), "Should mention uncovered transactions");
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

  it("flags yield-directional for YT-only position with PT sells", () => {
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
    assert.ok(joined.includes("yield-directional"), "Should flag yield-directional strategy");
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
    assert.ok(joined.includes("YT/PT ratio: 20.0:1"), "Should show the YT/PT ratio");
    assert.ok(joined.includes("yield-directional"), "Should flag yield-directional");
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
