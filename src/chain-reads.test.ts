/**
 * Unit tests for src/chain-reads.ts (Theme A Phase 1 engine).
 *
 * NOTE on location: the spec/handoff prompts said `tests/chain-reads.test.ts`,
 * but the existing project test runner (`npm run test:unit`) builds via tsc
 * (rootDir=./src) and runs node --test against `build/*.test.js`. Placing the
 * file under `src/` keeps it inside the existing build pipeline; the fixture
 * JSONs themselves live at `tests/fixtures/` per the spec, and are loaded
 * here via filesystem path.
 *
 * Coverage goals (Phase 1 landmines from the engineering brief):
 *   - decoder semantics: `0x` → null vs `0x0000...` → 0n
 *   - decodeAddress upper-12-byte guard
 *   - decodeString length cap
 *   - pre-onboarding heuristic uses `> 0n` (not `!== 0n`) — null safety
 *   - isSafeProxyBytecode requires both length AND masterCopy substring
 *   - wrapper-signature classifier
 *   - tvl-divergence classifier (none / small / large / unverifiable)
 *   - projectChainReadInput maps SpectraMetavault → ChainReadInput slice
 *   - Fixture-driven dry-run via simulated batch results: pre-onboarding
 *     (CSfusionMVWETH) and fully-loaded wrapper (gamisUSDC).
 *
 * The fully-loaded engine path is exercised via the integration mode
 * (gated by INTEGRATION_TEST=1), which calls `readMetaVaultChainState` against
 * live RPCs. The unit tests stay fixture-bound to avoid flakiness.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KNOWN_SAFE_SINGLETONS,
  RpcAllFailedError,
  classifyTvlDivergence,
  decodeAddress,
  decodeBool,
  decodeString,
  decodeUint256,
  decodeUint8,
  detectPriceFeedZero,
  isSafeProxyBytecode,
  isWrapperSignatureBroken,
  projectChainReadInput,
  readMetaVaultChainState,
} from "./chain-reads.js";
import type { SpectraMetavault } from "./types.js";

// =============================================================================
// Fixture loading
// =============================================================================

// Test files are compiled to build/, but fixtures live at the repo root
// under tests/fixtures/. Resolve relative to this file's runtime location.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "..", "tests", "fixtures");

interface RawResult {
  result?: string;
  error?: { code?: number; message?: string };
}

interface Fixture {
  name: string;
  chain: "mainnet" | "base";
  block: number | null;
  blockPinned: boolean;
  rpcUsed: string;
  input: {
    address: string;
    vault: string;
    infraVault: string;
    underlying: { address: string; decimals: number; symbol: string };
  };
  results: RawResult[];
  recordedAt: string;
}

function loadFixture(name: string): Fixture {
  const path = resolve(FIXTURE_DIR, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

// =============================================================================
// decoders
// =============================================================================

describe("decodeUint256", () => {
  it("returns null for empty / short / undefined", () => {
    assert.equal(decodeUint256(undefined), null);
    assert.equal(decodeUint256(""), null);
    assert.equal(decodeUint256("0x"), null);
    assert.equal(decodeUint256("0x00"), null);
  });

  it("returns 0n for canonical zero word (NOT null) — load-bearing for pre-onboarding heuristic", () => {
    const zeroWord = "0x" + "0".repeat(64);
    assert.equal(decodeUint256(zeroWord), 0n);
  });

  it("returns the integer value for non-zero word", () => {
    // 1e18 = 0xde0b6b3a7640000
    const word = "0x" + "0".repeat(48) + "0de0b6b3a7640000";
    assert.equal(decodeUint256(word), 1000000000000000000n);
  });

  it("returns max-uint256 for ff..ff", () => {
    const word = "0x" + "f".repeat(64);
    assert.equal(decodeUint256(word), (1n << 256n) - 1n);
  });
});

describe("decodeAddress", () => {
  it("returns null for empty / short", () => {
    assert.equal(decodeAddress(undefined), null);
    assert.equal(decodeAddress("0x"), null);
    assert.equal(decodeAddress("0x00"), null);
  });

  it("decodes a properly-padded address", () => {
    const word =
      "0x" + "0".repeat(24) + "abcdef0123456789abcdef0123456789abcdef01";
    assert.equal(decodeAddress(word), "0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("returns null when upper 12 bytes are non-zero (silent corruption guard)", () => {
    // Upper byte is 0x01 — bogus address word
    const word =
      "0x" + "01" + "0".repeat(22) + "abcdef0123456789abcdef0123456789abcdef01";
    assert.equal(decodeAddress(word), null);
  });

  it("returns null when length is not 66", () => {
    assert.equal(decodeAddress("0x" + "0".repeat(60)), null);
  });
});

describe("decodeUint8", () => {
  it("returns null for empty input", () => {
    assert.equal(decodeUint8("0x"), null);
  });

  it("decodes 18 (canonical decimals)", () => {
    const word = "0x" + "0".repeat(62) + "12";
    assert.equal(decodeUint8(word), 18);
  });

  it("returns null when value > 255", () => {
    const word = "0x" + "0".repeat(60) + "0100";
    assert.equal(decodeUint8(word), null);
  });
});

describe("decodeBool", () => {
  it("returns false for zero", () => {
    assert.equal(decodeBool("0x" + "0".repeat(64)), false);
  });
  it("returns true for non-zero", () => {
    assert.equal(decodeBool("0x" + "0".repeat(63) + "1"), true);
  });
  it("returns null for empty", () => {
    assert.equal(decodeBool("0x"), null);
  });
});

describe("decodeString", () => {
  it("decodes an ABI-encoded string", () => {
    // offset (32) + length (3) + "abc" + padding
    const offset = "0".repeat(62) + "20";
    const len = "0".repeat(62) + "03";
    const data = Buffer.from("abc", "utf8").toString("hex").padEnd(64, "0");
    const result = "0x" + offset + len + data;
    assert.equal(decodeString(result), "abc");
  });

  it("returns null for length > 1024 (DoS / precision-loss guard)", () => {
    // length = 0x401 = 1025
    const offset = "0".repeat(62) + "20";
    const len = "0".repeat(60) + "0401";
    const data = "0".repeat(2050);
    const result = "0x" + offset + len + data;
    assert.equal(decodeString(result), null);
  });

  it("returns null for length 0", () => {
    const offset = "0".repeat(62) + "20";
    const len = "0".repeat(64);
    const result = "0x" + offset + len;
    assert.equal(decodeString(result), null);
  });
});

// =============================================================================
// isSafeProxyBytecode
// =============================================================================

describe("isSafeProxyBytecode", () => {
  it("returns true for canonical Gnosis Safe Proxy bytecode (171 bytes)", () => {
    // Real CSfusionMVWETH safe bytecode from fixture
    const code =
      "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033";
    assert.equal(code.length, 344);
    assert.equal(isSafeProxyBytecode(code), true);
  });

  it("returns false for null / 0x / empty", () => {
    assert.equal(isSafeProxyBytecode(null), false);
    assert.equal(isSafeProxyBytecode(undefined), false);
    assert.equal(isSafeProxyBytecode("0x"), false);
    assert.equal(isSafeProxyBytecode(""), false);
  });

  it("returns false for bytecode missing the masterCopy selector", () => {
    // Same length (344) but no a619486e substring
    const code = "0x" + "00".repeat(171);
    assert.equal(code.length, 344);
    assert.equal(isSafeProxyBytecode(code), false);
  });

  it("returns false for arbitrary contract bytecode (1129 bytes)", () => {
    // Real infraVault bytecode size — should NOT be flagged as Safe Proxy
    const code = "0x" + "00".repeat(1129);
    assert.equal(isSafeProxyBytecode(code), false);
  });
});

// =============================================================================
// classifyTvlDivergence
// =============================================================================

describe("classifyTvlDivergence", () => {
  it("returns 'none' for matching values", () => {
    const r = classifyTvlDivergence(3.006398, 3006398000000000000n, 18);
    assert.equal(r.code, "none");
    assert.ok(Math.abs(r.chainValue - 3.006398) < 1e-9);
  });

  it("returns 'tvl-divergence-small' for 0.5%–5%", () => {
    // chain reports 1% lower than API
    const r = classifyTvlDivergence(100, 99000000000000000000n, 18);
    assert.equal(r.code, "tvl-divergence-small");
  });

  it("returns 'tvl-divergence-large' for >5%", () => {
    const r = classifyTvlDivergence(100, 90000000000000000000n, 18);
    assert.equal(r.code, "tvl-divergence-large");
  });

  it("returns 'unverifiable' when chain value is null", () => {
    const r = classifyTvlDivergence(100, null, 18);
    assert.equal(r.code, "unverifiable");
  });

  it("returns 'unverifiable' when api value is null/undefined", () => {
    const r = classifyTvlDivergence(undefined, 100n, 18);
    assert.equal(r.code, "unverifiable");
  });
});

describe("detectPriceFeedZero", () => {
  it("flags 0 as STAK-class", () => {
    assert.equal(detectPriceFeedZero(0), true);
  });
  it("does NOT flag positive values", () => {
    assert.equal(detectPriceFeedZero(2500), false);
  });
  it("does NOT flag undefined", () => {
    assert.equal(detectPriceFeedZero(undefined), false);
    assert.equal(detectPriceFeedZero(null), false);
  });
});

// =============================================================================
// isWrapperSignatureBroken
// =============================================================================

describe("isWrapperSignatureBroken", () => {
  it("returns false when wrapper holds 99%+", () => {
    const supply = 1000n;
    const balance = 998n;
    assert.equal(isWrapperSignatureBroken(balance, supply), false);
  });

  it("returns true when wrapper holds < 50%", () => {
    const supply = 1000n;
    const balance = 400n;
    assert.equal(isWrapperSignatureBroken(balance, supply), true);
  });

  it("returns false when supply is null/zero", () => {
    assert.equal(isWrapperSignatureBroken(100n, null), false);
    assert.equal(isWrapperSignatureBroken(100n, 0n), false);
  });

  it("returns false when balance is null", () => {
    assert.equal(isWrapperSignatureBroken(null, 1000n), false);
  });
});

// =============================================================================
// projectChainReadInput
// =============================================================================

describe("projectChainReadInput", () => {
  it("projects the relevant slice from SpectraMetavault", () => {
    const mv: SpectraMetavault = {
      address: "0x3b1913e474c37cbcf375e644d1af51589d8e44ea",
      vault: "0xefda9a1d6b5f4a0279c05b616924776c4d9dc13d",
      infraVault: "0x2151c851c1808c6609f24535dd77d8216f17118f",
      chainId: 1,
      name: "CSfusionMVWETH",
      symbol: "CSfusionMVWETH",
      decimals: 18,
      curator: { name: "test", addresses: [] },
      underlying: {
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        symbol: "WETH",
        decimals: 18,
        price: { usd: 2500 },
      },
      metadata: { title: "test", shortDescription: "" },
      positions: [],
      epochs: [],
      tvl: { underlying: 3.006398, usd: 7515 },
      liveApy: { total: 0 },
      modifier: {
        roles: { default: "0xaaaa", pool: "0xbbbb" },
        delay: { default: "0xcccc" },
      },
      remote: {
        "43114": {
          address: "0xdddd",
          modifier: { roles: { default: "0xeeee" }, delay: {} },
        },
      },
      exchangeRate: "0",
      price: { underlying: 1, usd: 2500 },
    };
    const projected = projectChainReadInput(mv);
    assert.equal(projected.address, mv.address);
    assert.equal(projected.vault, mv.vault);
    assert.equal(projected.infraVault, mv.infraVault);
    assert.equal(projected.underlying.address, mv.underlying.address);
    assert.equal(projected.underlying.decimals, 18);
    assert.equal(projected.underlying.symbol, "WETH");
    assert.deepEqual(projected.modifier, mv.modifier);
    assert.deepEqual(projected.remote, {
      "43114": { modifier: { roles: { default: "0xeeee" }, delay: {} } },
    });
  });

  it("handles missing infraVault / modifier / remote gracefully", () => {
    const mv: SpectraMetavault = {
      address: "0x0000000000000000000000000000000000000001",
      vault: "0x0000000000000000000000000000000000000002",
      chainId: 8453,
      name: "x",
      symbol: "x",
      decimals: 6,
      curator: { name: "x", addresses: [] },
      underlying: { address: "0x0000000000000000000000000000000000000003", symbol: "USDC", decimals: 6, price: { usd: 1 } },
      metadata: { title: "x", shortDescription: "" },
      positions: [],
      epochs: [],
      tvl: { underlying: 0, usd: 0 },
      liveApy: { total: 0 },
      exchangeRate: "0",
      price: { underlying: 1, usd: 1 },
    };
    const projected = projectChainReadInput(mv);
    assert.equal(projected.infraVault, undefined);
    assert.equal(projected.modifier, undefined);
    assert.equal(projected.remote, undefined);
  });
});

// =============================================================================
// Safe singleton registry
// =============================================================================

describe("KNOWN_SAFE_SINGLETONS", () => {
  it("includes Safe v1.4.1 (mainnet canonical)", () => {
    assert.equal(
      KNOWN_SAFE_SINGLETONS["0x41675c099f32341bf84bfc5382af534df5c7461a"],
      "safe-v1.4.1",
    );
  });

  it("includes Safe v1.3.0-l2 (Base canonical)", () => {
    assert.equal(
      KNOWN_SAFE_SINGLETONS["0xfb1bffc9d739b8d520daf37df666da4c687191ea"],
      "safe-v1.3.0-l2",
    );
  });

  it("includes Safe v1.3.0", () => {
    assert.equal(
      KNOWN_SAFE_SINGLETONS["0xd9db270c1b5e3bd161e8c8503c55ceabee709552"],
      "safe-v1.3.0",
    );
  });
});

// =============================================================================
// RpcAllFailedError
// =============================================================================

describe("RpcAllFailedError", () => {
  it("constructs with chain + attemptedUrls + cause", () => {
    const inner = new Error("timeout");
    const e = new RpcAllFailedError("mainnet", ["url1", "url2"], inner);
    assert.equal(e.name, "RpcAllFailedError");
    assert.equal(e.chain, "mainnet");
    assert.deepEqual(e.attemptedUrls, ["url1", "url2"]);
    assert.equal((e as { cause?: unknown }).cause, inner);
    assert.match(e.message, /mainnet/);
    assert.match(e.message, /2 endpoint/);
  });

  it("constructs without cause", () => {
    const e = new RpcAllFailedError("base", []);
    assert.equal(e.attemptedUrls.length, 0);
  });
});

// =============================================================================
// Fixture-driven verification of decoded chain state
// =============================================================================
//
// These tests don't run the full engine (which requires live RPC) — they
// exercise the decoder + classifier paths against the recorded raw RPC
// responses, asserting that what the engine WOULD compose from those raw
// results is correct. This catches regressions in the stable indexing
// contract between `record-chain-state.ts` and `readMetaVaultChainState`
// without flaky network dependence.

describe("CSfusionMVWETH fixture (mainnet, pre-onboarding state)", () => {
  const f = loadFixture("csfusionmvweth-mainnet-24962385");
  const r = f.results;

  it("fixture is block-pinned (recording succeeded at the spec'd block)", () => {
    assert.equal(f.blockPinned, true);
    assert.equal(f.block, 24962385);
  });

  it("Safe bytecode passes Safe Proxy detection", () => {
    const code = r[0].result;
    assert.equal(code && code !== "0x", true);
    assert.equal(code!.length, 344);
    assert.equal(isSafeProxyBytecode(code), true);
  });

  it("masterCopy decodes to the safe-v1.4.1 mainnet canonical", () => {
    const masterCopy = decodeAddress(r[1].result);
    assert.equal(masterCopy, "0x41675c099f32341bf84bfc5382af534df5c7461a");
    assert.equal(KNOWN_SAFE_SINGLETONS[masterCopy!], "safe-v1.4.1");
  });

  it("Safe asset balance is non-zero (WETH curator seed)", () => {
    const bal = decodeUint256(r[2].result);
    assert.notEqual(bal, null);
    assert.ok(bal! > 0n, "expected non-zero curator seed");
    // Approximately 3 WETH
    const eth = Number(bal!) / 1e18;
    assert.ok(eth >= 2.99 && eth <= 3.01, `expected ~3 WETH, got ${eth}`);
  });

  it("Safe.totalAssets() reverts (which is correct — Safe doesn't implement ERC-4626)", () => {
    // The error path of the totalAssets() call at the Safe address — this is
    // important for the role-inversion-detected logic (it should NOT fire here
    // because the call reverts and the Safe Proxy check passes).
    assert.ok(r[3].error !== undefined, "expected revert error at the Safe address");
  });

  it("infraVault.totalAssets > 0 and exceeds the Safe asset balance (capital is deployed)", () => {
    const infraTotalAssets = decodeUint256(r[5].result);
    const safeAssetBalance = decodeUint256(r[2].result);
    assert.notEqual(infraTotalAssets, null);
    assert.ok(infraTotalAssets! > safeAssetBalance!);
  });

  it("infraVault.totalSupply > 0 (vault has been seeded)", () => {
    const supply = decodeUint256(r[6].result);
    assert.ok(supply !== null && supply > 0n);
  });

  it("infraVault.asset matches input.underlying (WETH)", () => {
    const asset = decodeAddress(r[7].result);
    assert.equal(asset, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  });

  it("infraVault.decimals = 18", () => {
    assert.equal(decodeUint8(r[8].result), 18);
  });

  it("infraVault.owner == Safe address (canonical topology)", () => {
    const owner = decodeAddress(r[11].result);
    assert.equal(owner, "0x3b1913e474c37cbcf375e644d1af51589d8e44ea");
  });

  it("infraVault.paused = false", () => {
    assert.equal(decodeBool(r[12].result), false);
  });

  it("secondaryVault.totalSupply = 0 (pre-onboarding)", () => {
    const supply = decodeUint256(r[16].result);
    assert.equal(supply, 0n);
  });

  it("pre-onboarding heuristic fires using > 0n (NOT !== 0n) — null safety", () => {
    // The actual heuristic the engine uses, replicated here for assertion.
    const safeBytecodePresent = (r[0].result?.length ?? 0) > 2;
    const secondaryTotalSupply = decodeUint256(r[16].result);
    const infraTotalSupply = decodeUint256(r[6].result);
    const isPreOnboarding =
      safeBytecodePresent &&
      secondaryTotalSupply === 0n &&
      infraTotalSupply !== null &&
      infraTotalSupply > 0n;
    assert.equal(isPreOnboarding, true);

    // CRITICAL: the same heuristic with !== 0n would be wrong for null
    const nullVsZeroNotEq = null !== 0n; // true — would falsely trigger
    assert.equal(nullVsZeroNotEq, true);
    const nullVsZeroGt = (null as bigint | null) === null ? false : (null as unknown as bigint) > 0n;
    assert.equal(nullVsZeroGt, false);
  });

  it("wrapper-signature is mechanically zero (covered by pre-onboarding, not separately flagged)", () => {
    const sig = decodeUint256(r[22].result);
    const supply = decodeUint256(r[6].result);
    assert.equal(sig, 0n);
    // isWrapperSignatureBroken returns true here, BUT the engine suppresses
    // the broken warning under pre-onboarding (more-informative finding).
    assert.equal(isWrapperSignatureBroken(sig, supply), true);
  });
});

describe("gamisUSDC fixture (Base, fully-loaded wrapper)", () => {
  const f = loadFixture("gamisusdc-base-45197827");
  const r = f.results;

  it("fixture is block-pinned at 45197827", () => {
    assert.equal(f.blockPinned, true);
    assert.equal(f.block, 45197827);
  });

  it("Safe bytecode passes Safe Proxy detection", () => {
    assert.equal(isSafeProxyBytecode(r[0].result), true);
  });

  it("masterCopy decodes to safe-v1.3.0-l2 (Base canonical)", () => {
    const masterCopy = decodeAddress(r[1].result);
    assert.equal(masterCopy, "0xfb1bffc9d739b8d520daf37df666da4c687191ea");
    assert.equal(KNOWN_SAFE_SINGLETONS[masterCopy!], "safe-v1.3.0-l2");
  });

  it("infraVault.totalAssets is large (~$5.12M)", () => {
    const ta = decodeUint256(r[5].result);
    assert.notEqual(ta, null);
    const usd = Number(ta!) / 1e6;
    assert.ok(usd > 5_000_000 && usd < 5_500_000, `expected ~$5.12M, got $${usd}`);
  });

  it("infraVault.asset matches USDC on Base", () => {
    const asset = decodeAddress(r[7].result);
    assert.equal(asset, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  });

  it("infraVault.owner == Safe address", () => {
    const owner = decodeAddress(r[11].result);
    assert.equal(owner, "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a");
  });

  it("secondaryVault.totalSupply > 0 (fully-loaded, NOT pre-onboarding)", () => {
    const supply = decodeUint256(r[16].result);
    assert.ok(supply !== null && supply > 0n);
  });

  it("secondaryVault.totalAssets ≈ $2.96M (user-entitlement scope — DO NOT reconcile against api.tvl.underlying)", () => {
    const ta = decodeUint256(r[15].result);
    const usd = Number(ta!) / 1e6;
    assert.ok(usd > 2_500_000 && usd < 3_500_000, `expected ~$2.96M, got $${usd}`);
  });

  it("wrapper-signature is healthy (≥99% of infraVault.totalSupply held by secondaryVault)", () => {
    const sig = decodeUint256(r[22].result);
    const supply = decodeUint256(r[6].result);
    assert.equal(isWrapperSignatureBroken(sig, supply), false);
    const pct = Number(sig!) / Number(supply!);
    assert.ok(pct >= 0.99, `expected ≥99% wrapper signature, got ${(pct * 100).toFixed(2)}%`);
  });

  it("pre-onboarding heuristic does NOT fire (secondaryVault has supply)", () => {
    const safeBytecodePresent = (r[0].result?.length ?? 0) > 2;
    const secondaryTotalSupply = decodeUint256(r[16].result);
    const infraTotalSupply = decodeUint256(r[6].result);
    const isPreOnboarding =
      safeBytecodePresent &&
      secondaryTotalSupply === 0n &&
      infraTotalSupply !== null &&
      infraTotalSupply > 0n;
    assert.equal(isPreOnboarding, false);
  });
});

// =============================================================================
// Engine integration test (gated)
// =============================================================================
//
// Runs the actual `readMetaVaultChainState` against live RPCs. Skipped
// unless `INTEGRATION_TEST=1`. The fixture-driven tests above are the
// merge-gate; this is a deeper end-to-end sanity check the operator can run
// when refreshing fixtures.

const RUN_INTEGRATION = process.env.INTEGRATION_TEST === "1";

describe("readMetaVaultChainState [integration]", { skip: !RUN_INTEGRATION }, () => {
  it("gamisUSDC on Base returns a healthy fully-loaded state", async () => {
    const state = await readMetaVaultChainState("base", {
      address: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
      vault: "0x776f95321a0285f8bcde149e3264d16dc08da69a",
      infraVault: "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1",
      underlying: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC" },
    });
    assert.equal(state.chain, "base");
    assert.ok(state.block > 45_000_000);
    assert.ok(state.safe.bytecodePresent);
    assert.equal(state.safe.singletonKnown, "safe-v1.3.0-l2");
    assert.ok(state.infraVault !== null);
    assert.ok(state.infraVault!.totalAssets! > 1_000_000n);
    // Should emit secondaryvault-reasoning-prohibited info at minimum
    const codes = state.warnings.map((w) => w.code);
    assert.ok(
      codes.includes("secondaryvault-reasoning-prohibited") ||
        codes.includes("wrapper-signature-broken") ||
        codes.includes("pre-onboarding-state"),
      `expected secondaryvault advisory, got: ${codes.join(", ")}`,
    );
  });
});
