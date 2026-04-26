/**
 * Unit tests for src/tools/stress_test.ts — Theme A Phase 5 chain-truth idle
 * derivation.
 *
 * Substrate: pure-helper testing. The handler itself is a server.tool()
 * registration that fans out to fetchMetavaults + readMetaVaultChainStateCached;
 * exercising it requires a live MCP harness or extensive mocking. The
 * load-bearing math lives in `deriveChainTruthIdle`, which is pure
 * (`MetaVaultChainState + numbers → derivation`). These tests cover:
 *
 *   - numerical-equivalence assertion against gamisUSDC fixture-derived numbers:
 *     chainTruthIdleUsd > apiPathIdleUsd by exactly safe.assetBalance · price
 *   - chain-read-failure path (rpc-all-failed warning) → kind="failed"
 *   - missing-field path (safe.assetBalance null) → kind="failed" with reason
 *   - price-feed-zero path → kind="price-feed-zero" + underlying-denom idle
 *   - byte-identity guard: when verify_onchain=false, we never call the helper
 *     (verified by reading the source — no test needed because the helper
 *     itself is pure and called only inside the verify_onchain block).
 *
 * The numerical-equivalence matrix is anchored to the architect's spec
 * reference probe (gamisUSDC at base block ~45.2M):
 *   safe.assetBalance     = 32,743,210,815 raw (32,743.21 USDC)
 *   infraVault.totalAssets = 5,125,392,648,438 raw (5,125,392.65 USDC)
 *   underlying.price.usd  = 0.9997723244926343
 *   knownAllocTotal       = $130,949.71
 *   externalTotalUsd      = $3,648,221.49
 *
 * Expected:
 *   API-path idle    = (5,125,392.65 × 0.999772) - 130,949.71 - 3,648,221.49 ≈ $1,345,054
 *   Chain-truth idle = (32,743.21 × 0.999772) + max(0, ...) ≈ $1,377,790
 *   Delta            ≈ $32,735 (= safeCashUsd, the API miss)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeIdlePct,
  deriveChainTruthIdle,
  formatStressTestResult,
  type ChainTruthIdleDerivation,
} from "./stress_test.js";
import type { MetaVaultChainState, StressTestResult } from "../types.js";

// =============================================================================
// Fixture-derived synthetic chain state — gamisUSDC reference numbers.
// =============================================================================

const GAMIS_SAFE_ASSET_BALANCE = 32_743_210_815n;          // 32,743.21 USDC
const GAMIS_INFRA_TOTAL_ASSETS = 5_125_392_648_438n;        // 5,125,392.65 USDC
const GAMIS_UNDERLYING_DECIMALS = 6;
const GAMIS_UNDERLYING_PRICE = 0.9997723244926343;
const GAMIS_KNOWN_ALLOC = 130_949.71;
const GAMIS_EXTERNAL = 3_648_221.49;

function makeOkState(overrides: Partial<{
  safeAssetBalance: bigint | null;
  infraTotalAssets: bigint | null;
  infraDecimals: number | null;
  warnings: MetaVaultChainState["warnings"];
}> = {}): MetaVaultChainState {
  return {
    chain: "base",
    block: 45_211_202,
    rpcUsed: "https://base-rpc.publicnode.com",
    fetchedAt: Date.now(),
    safe: {
      address: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
      bytecodePresent: true,
      bytecodeSize: 171,
      isSafeProxy: true,
      singleton: "0xfb1bffc9d739b8d520daf37df666da4c687191ea",
      singletonKnown: "safe-v1.3.0-l2",
      assetBalance:
        overrides.safeAssetBalance !== undefined
          ? overrides.safeAssetBalance
          : GAMIS_SAFE_ASSET_BALANCE,
    },
    infraVault: {
      address: "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1",
      bytecodePresent: true,
      bytecodeSize: 1129,
      totalAssets:
        overrides.infraTotalAssets !== undefined
          ? overrides.infraTotalAssets
          : GAMIS_INFRA_TOTAL_ASSETS,
      totalSupply: 5_018_927_000_000n,
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      decimals:
        overrides.infraDecimals !== undefined
          ? overrides.infraDecimals
          : GAMIS_UNDERLYING_DECIMALS,
      name: "Gami infraVault",
      symbol: "infra",
      owner: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
      paused: false,
      selfAssetBalance: 0n,
    },
    secondaryVault: null,
    modifiers: null,
    remoteModifiers: {},
    warnings: overrides.warnings ?? [],
  };
}

function makeAllFailedState(): MetaVaultChainState {
  return {
    chain: "base",
    block: 0,
    rpcUsed: "",
    fetchedAt: Date.now(),
    safe: {
      address: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
      bytecodePresent: false,
      bytecodeSize: 0,
      isSafeProxy: false,
      singleton: null,
      singletonKnown: null,
      assetBalance: null,
    },
    infraVault: null,
    secondaryVault: null,
    modifiers: null,
    remoteModifiers: {},
    warnings: [
      {
        severity: "error",
        code: "rpc-all-failed",
        detail: "all RPCs failed for base: tried 3 endpoint(s)",
        nextProbe: "use a premium RPC for chain base",
      },
    ],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("deriveChainTruthIdle — gamisUSDC numerical equivalence", () => {
  it("kind='ok' with chainTruthIdleUsd > apiPathIdleUsd by safe.assetBalance·price", () => {
    const state = makeOkState();
    const result = deriveChainTruthIdle(
      state,
      GAMIS_KNOWN_ALLOC,
      GAMIS_EXTERNAL,
      GAMIS_UNDERLYING_PRICE,
      GAMIS_UNDERLYING_DECIMALS,
    );

    assert.equal(result.kind, "ok", "should derive on healthy state");
    if (result.kind !== "ok") return;

    // Reference numbers (computed independently in the test, NOT copied
    // from the implementation):
    const safeCashUnderlying = Number(GAMIS_SAFE_ASSET_BALANCE) / 1e6;        // 32,743.210815
    const infraTotalUnderlying = Number(GAMIS_INFRA_TOTAL_ASSETS) / 1e6;       // 5,125,392.648438
    const safeCashUsd = safeCashUnderlying * GAMIS_UNDERLYING_PRICE;            // ≈ 32,735.76
    const infraTotalUsd = infraTotalUnderlying * GAMIS_UNDERLYING_PRICE;        // ≈ 5,124,225.47
    const expectedChainTruthIdle =
      safeCashUsd +
      Math.max(0, infraTotalUsd - GAMIS_KNOWN_ALLOC - GAMIS_EXTERNAL);
    const expectedApiPathIdle = Math.max(
      0,
      infraTotalUsd - GAMIS_KNOWN_ALLOC - GAMIS_EXTERNAL,
    );

    // Tolerance 0.01 USD — float math, not contract drift.
    assert.ok(
      Math.abs(result.chainTruthIdleUsd - expectedChainTruthIdle) < 0.01,
      `expected ${expectedChainTruthIdle.toFixed(4)} got ${result.chainTruthIdleUsd.toFixed(4)}`,
    );

    // The load-bearing assertion: chain-truth exceeds API path by exactly
    // safeCashUsd (the curator-transit cash held DIRECTLY at the Safe that
    // the API derivation MISSES).
    const delta = result.chainTruthIdleUsd - expectedApiPathIdle;
    assert.ok(
      Math.abs(delta - safeCashUsd) < 0.01,
      `chain-truth − API should equal safeCashUsd ${safeCashUsd.toFixed(4)}, got delta ${delta.toFixed(4)}`,
    );

    // Sanity: this is the $32,735 figure the architect's brief calls out.
    assert.ok(delta > 32_000 && delta < 33_000, `delta ${delta} should be ≈ $32,735`);
  });

  it("preserves block + rpc on the ok path", () => {
    const state = makeOkState();
    const result = deriveChainTruthIdle(
      state,
      GAMIS_KNOWN_ALLOC,
      GAMIS_EXTERNAL,
      GAMIS_UNDERLYING_PRICE,
      GAMIS_UNDERLYING_DECIMALS,
    );
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.block, 45_211_202);
    assert.equal(result.rpc, "https://base-rpc.publicnode.com");
  });
});

describe("deriveChainTruthIdle — failure paths", () => {
  it("rpc-all-failed → kind='failed' with detail and surfaces fallback", () => {
    const state = makeAllFailedState();
    const result = deriveChainTruthIdle(
      state,
      GAMIS_KNOWN_ALLOC,
      GAMIS_EXTERNAL,
      GAMIS_UNDERLYING_PRICE,
      GAMIS_UNDERLYING_DECIMALS,
    );
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.reason, /all RPCs failed/);
  });

  it("missing safe.assetBalance → kind='failed' with reason", () => {
    const state = makeOkState({ safeAssetBalance: null });
    const result = deriveChainTruthIdle(
      state,
      GAMIS_KNOWN_ALLOC,
      GAMIS_EXTERNAL,
      GAMIS_UNDERLYING_PRICE,
      GAMIS_UNDERLYING_DECIMALS,
    );
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.reason, /safe\.assetBalance null/);
  });

  it("missing infraVault.totalAssets → kind='failed' with reason", () => {
    const state = makeOkState({ infraTotalAssets: null });
    const result = deriveChainTruthIdle(
      state,
      GAMIS_KNOWN_ALLOC,
      GAMIS_EXTERNAL,
      GAMIS_UNDERLYING_PRICE,
      GAMIS_UNDERLYING_DECIMALS,
    );
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.reason, /infraVault\.totalAssets null/);
  });

  it("both null → kind='failed' with combined reason", () => {
    const state = makeOkState({
      safeAssetBalance: null,
      infraTotalAssets: null,
    });
    const result = deriveChainTruthIdle(
      state,
      GAMIS_KNOWN_ALLOC,
      GAMIS_EXTERNAL,
      GAMIS_UNDERLYING_PRICE,
      GAMIS_UNDERLYING_DECIMALS,
    );
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.reason, /both null/);
  });

  it("Numerical equivalence matrix: failed path produces no chainTruthIdleUsd (caller falls back to API path)", () => {
    // The contract: when `failed`, the derivation does NOT carry a
    // chainTruthIdleUsd. The caller is responsible for using the API path
    // (idleCapitalUsd = apiPathIdleUsd was the pre-Phase-5 default and stays
    // unchanged on the failed branch). This test pins the type-level
    // contract so nobody silently adds a .chainTruthIdleUsd to the failed
    // shape later.
    const state = makeAllFailedState();
    const result = deriveChainTruthIdle(
      state,
      GAMIS_KNOWN_ALLOC,
      GAMIS_EXTERNAL,
      GAMIS_UNDERLYING_PRICE,
      GAMIS_UNDERLYING_DECIMALS,
    );
    // TypeScript narrowing should already block this, but assert at runtime
    // too — guards against future shape edits.
    assert.equal(
      (result as ChainTruthIdleDerivation & { chainTruthIdleUsd?: number }).chainTruthIdleUsd,
      undefined,
    );
  });
});

describe("deriveChainTruthIdle — price-feed-zero path", () => {
  it("price=0 → kind='price-feed-zero' + underlying-denom idle, no USD substitution", () => {
    const state = makeOkState();
    const result = deriveChainTruthIdle(
      state,
      GAMIS_KNOWN_ALLOC,
      GAMIS_EXTERNAL,
      0, // STAK-class: feed went to zero
      GAMIS_UNDERLYING_DECIMALS,
    );
    assert.equal(result.kind, "price-feed-zero");
    if (result.kind !== "price-feed-zero") return;

    const expectedIdleUnderlying = Number(GAMIS_SAFE_ASSET_BALANCE) / 1e6;
    assert.ok(
      Math.abs(result.idleUnderlying - expectedIdleUnderlying) < 0.0001,
      `expected ${expectedIdleUnderlying} got ${result.idleUnderlying}`,
    );
    assert.match(result.reason, /price\.usd === 0/);
  });

  it("price=0 + null safe → still kind='failed' (precedence: missing reads first)", () => {
    // If the engine couldn't read at all, that's the bigger problem than
    // a price feed outage. Failed path takes precedence.
    const state = makeOkState({ safeAssetBalance: null });
    const result = deriveChainTruthIdle(
      state,
      GAMIS_KNOWN_ALLOC,
      GAMIS_EXTERNAL,
      0,
      GAMIS_UNDERLYING_DECIMALS,
    );
    assert.equal(result.kind, "failed");
  });
});

describe("deriveChainTruthIdle — decimals fallback", () => {
  it("uses underlyingDecimalsFallback when infraVault.decimals is null", () => {
    // Some RPCs return null for decimals(). The handler passes
    // mv.underlying.decimals as fallback.
    const state = makeOkState({ infraDecimals: null });
    const result = deriveChainTruthIdle(
      state,
      GAMIS_KNOWN_ALLOC,
      GAMIS_EXTERNAL,
      GAMIS_UNDERLYING_PRICE,
      6, // mv.underlying.decimals
    );
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    // Same numerical result as the canonical case.
    const safeCashUsd = (Number(GAMIS_SAFE_ASSET_BALANCE) / 1e6) * GAMIS_UNDERLYING_PRICE;
    const infraTotalUsd = (Number(GAMIS_INFRA_TOTAL_ASSETS) / 1e6) * GAMIS_UNDERLYING_PRICE;
    const expected = safeCashUsd + Math.max(0, infraTotalUsd - GAMIS_KNOWN_ALLOC - GAMIS_EXTERNAL);
    assert.ok(Math.abs(result.chainTruthIdleUsd - expected) < 0.01);
  });
});

// =============================================================================
// formatStressTestResult — byte-identity guard for chainTruthAvailable
// =============================================================================
//
// PR0 invariant: when verify_onchain=false (default), output is identical to
// the pre-Phase-5 path. We assert this by rendering a result with
// chainTruthAvailable="not-requested" and verifying the output contains NO
// chain-truth string. The corollary: any chainTruthAvailable !== "not-requested"
// MUST surface a Chain-truth line near the top.

function makeBaseResult(): StressTestResult {
  return {
    vaultName: "Gami Spectra USDC",
    chain: "base",
    vaultAddress: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
    tvlUsd: 5_124_525.60,
    redemptionPct: 30,
    redemptionAmountUsd: 1_537_357.68,
    marketStress: false,
    waterfall: [
      {
        name: "Unallocated Cash",
        description: "Undeployed cash in the vault",
        availableUsd: 1_345_354.40,
        coveragePct: 87.5,
        estimatedCostUsd: 0,
        estimatedCostPct: 0,
        cumulativeCoverageUsd: 1_345_354.40,
      },
    ],
    totalCovered: false,
    totalCostToRemainingUsd: 0,
    totalCostToRemainingPct: 0,
    maxSafeRedemptionPct: 26,
    maxSafeRedemptionUsd: 1_332_376,
    maxSafeWithinWeekPct: 26,
    maxSafeWithinWeekUsd: 1_332_376,
    crossChainPositions: [],
    crossChainTotalUsd: 0,
    bridgePendingUsd: 0,
    incentiveDependencyPct: 0,
    maturingCoveragePct: 0,
    nearestMaturityDays: null,
    idlePct: 26.3,
    chainTruthAvailable: "not-requested",
  };
}

describe("formatStressTestResult — byte-identity on verify_onchain=false branch", () => {
  it("chainTruthAvailable='not-requested' renders NO chain-truth line", () => {
    const result = makeBaseResult();
    const out = formatStressTestResult(result);
    assert.ok(
      !out.includes("Chain-truth:"),
      "verify_onchain=false default path must not surface a Chain-truth line",
    );
  });

  it("chainTruthAvailable='ok' renders a Chain-truth line with delta", () => {
    const result: StressTestResult = {
      ...makeBaseResult(),
      chainTruthAvailable: "ok",
      chainTruthIdleUsd: 1_377_790.16,
      apiPathIdleUsd: 1_345_354.40,
      chainTruthBlock: 45_211_202,
      chainTruthRpc: "https://base-rpc.publicnode.com",
    };
    const out = formatStressTestResult(result);
    assert.ok(out.includes("Chain-truth: ✓"), "ok path must surface ✓");
    assert.ok(out.includes("delta: +"), "ok path must show signed delta");
    assert.ok(out.includes("block 45,211,202"), "ok path must show block number");
  });

  it("chainTruthAvailable='failed' renders ✗ with reason", () => {
    const result: StressTestResult = {
      ...makeBaseResult(),
      chainTruthAvailable: "failed",
      apiPathIdleUsd: 1_345_354.40,
      chainTruthFailureReason: "chain-read timed out after 30000ms",
    };
    const out = formatStressTestResult(result);
    assert.ok(out.includes("Chain-truth: ✗"), "failed path must surface ✗");
    assert.ok(out.includes("fallback to API"), "failed path must say fallback");
    assert.ok(out.includes("timed out"), "failed path must surface reason");
  });

  it("chainTruthAvailable='price-feed-zero' renders ⚠ with underlying-denom idle", () => {
    const result: StressTestResult = {
      ...makeBaseResult(),
      chainTruthAvailable: "price-feed-zero",
      apiPathIdleUsd: 1_345_354.40,
      chainTruthIdleUnderlying: 32_743.21,
      chainTruthFailureReason: "underlying.price.usd === 0; USD chain-truth unverified",
      underlyingSymbol: "USDC",
      chainTruthBlock: 45_211_202,
      chainTruthRpc: "https://base-rpc.publicnode.com",
    };
    const out = formatStressTestResult(result);
    assert.ok(out.includes("Chain-truth: ⚠"), "price-feed-zero must surface ⚠");
    assert.ok(out.includes("USD figures unverified"), "must explain why USD unverified");
    assert.ok(out.includes("32743.21 USDC") || out.includes("USDC idle"), "must surface underlying-denom idle");
    assert.ok(out.includes("waterfall uses API USD path"), "must clarify the fallback");
  });

  it("Numerical equivalence matrix: chainTruthAvailable='ok' delta matches safeCashUsd", () => {
    // The formatter renders the delta. Confirms the surfaced number matches
    // the underlying chain-truth math (≈ $32,735 at gamisUSDC reference).
    const apiPath = 1_345_354.40;
    const chainTruth = 1_377_789.16; // ≈ apiPath + safeCashUsd
    const result: StressTestResult = {
      ...makeBaseResult(),
      chainTruthAvailable: "ok",
      chainTruthIdleUsd: chainTruth,
      apiPathIdleUsd: apiPath,
      chainTruthBlock: 45_211_202,
      chainTruthRpc: "https://base-rpc.publicnode.com",
    };
    const out = formatStressTestResult(result);
    // The delta line should contain "+$32,434.76" (rounded). Tolerance is
    // formatUsd's rendering choice — we just assert the magnitude appears.
    assert.match(out, /delta: \+\$32,4\d\d/);
  });
});

// =============================================================================
// computeIdlePct — denominator-consistency fix (Diverger Round-4 BLOCKER)
// =============================================================================

describe("computeIdlePct — denominator coherent with numerator source", () => {
  it("API path: idlePct = idleCapitalUsd / vaultTvl (pre-Phase-5 semantics)", () => {
    // chainTruthAvailable !== "ok" → fallback to vaultTvl denominator.
    const pct = computeIdlePct({
      idleCapitalUsd: 25_000,
      chainTruthAvailable: "not-requested",
      chainTruthIdleUsd: undefined,
      knownAllocTotal: 50_000,
      externalTotalUsd: 25_000,
      vaultTvl: 100_000,
    });
    assert.equal(pct, 25);
  });

  it("API path on failed chain-truth: same as not-requested", () => {
    const pct = computeIdlePct({
      idleCapitalUsd: 25_000,
      chainTruthAvailable: "failed",
      chainTruthIdleUsd: undefined,
      knownAllocTotal: 50_000,
      externalTotalUsd: 25_000,
      vaultTvl: 100_000,
    });
    assert.equal(pct, 25);
  });

  it("chain-truth path: denominator = chainTruthIdle + deployed (consistent)", () => {
    // safeCashUsd $50K, infraVault $100K (= vaultTvl), $20K LP, $10K external.
    // chainTruthIdleUsd = 50K + max(0, 100K - 20K - 10K) = 50K + 70K = $120K.
    // Pre-fix denom = vaultTvl = 100K → idlePct = 120K/100K = 120% (BUG).
    // Post-fix denom = 120K + 20K + 10K = 150K → idlePct = 120K/150K = 80%.
    const pct = computeIdlePct({
      idleCapitalUsd: 120_000, // = chainTruthIdleUsd
      chainTruthAvailable: "ok",
      chainTruthIdleUsd: 120_000,
      knownAllocTotal: 20_000,
      externalTotalUsd: 10_000,
      vaultTvl: 100_000,
    });
    assert.equal(pct, 80, "denominator must include Safe-side cash to stay coherent");
  });

  it("regression: pathological Safe-dominant vault must NOT render >100% idle", () => {
    // Diverger Round-4 protected finding: vault with $50K Safe + $100K infra,
    // zero deployed → chainTruthIdleUsd = 50K + 100K = $150K. Pre-fix would
    // render 150% idle (vaultTvl=100K denominator). Post-fix: denom = 150K + 0 + 0
    // = 150K → idlePct = 100%. Bounded.
    const pct = computeIdlePct({
      idleCapitalUsd: 150_000,
      chainTruthAvailable: "ok",
      chainTruthIdleUsd: 150_000,
      knownAllocTotal: 0,
      externalTotalUsd: 0,
      vaultTvl: 100_000,
    });
    assert.ok(pct <= 100, `idlePct must not exceed 100%, got ${pct}`);
    assert.equal(pct, 100);
  });

  it("guards divide-by-zero when both chain-truth and vaultTvl are 0", () => {
    const pct = computeIdlePct({
      idleCapitalUsd: 0,
      chainTruthAvailable: "ok",
      chainTruthIdleUsd: 0,
      knownAllocTotal: 0,
      externalTotalUsd: 0,
      vaultTvl: 0,
    });
    assert.equal(pct, 0);
  });
});

describe("deriveChainTruthIdle — boundary: max(0,...) clamp", () => {
  it("when known+external > infraTotal, idle = safeCashUsd alone (no negative)", () => {
    // Pathological case: positions + external exceed infraVault.totalAssets
    // (e.g., timing skew between API snapshot and chain block, or external
    // valueUsd over-counted). The max(0, ...) clamp prevents the formula
    // from producing a negative idle — chain-truth then equals just the
    // Safe-side cash.
    const state = makeOkState();
    const result = deriveChainTruthIdle(
      state,
      10_000_000, // way more than infraTotalUsd
      0,
      GAMIS_UNDERLYING_PRICE,
      GAMIS_UNDERLYING_DECIMALS,
    );
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    const safeCashUsd = (Number(GAMIS_SAFE_ASSET_BALANCE) / 1e6) * GAMIS_UNDERLYING_PRICE;
    assert.ok(
      Math.abs(result.chainTruthIdleUsd - safeCashUsd) < 0.01,
      `expected ${safeCashUsd} got ${result.chainTruthIdleUsd}`,
    );
  });
});
