/**
 * Tests for the Pendle market chain-truth verifier.
 *
 * Two layers (mirroring avant-verifier.test.ts):
 *   1. Unit (always-on): pure decoder + format primitives + chain-id slug
 *      resolution against synthetic hex inputs. Pins ABI semantics —
 *      selectors, MarketState tuple decoding, expiry-mismatch refusal,
 *      formatter glyph routing.
 *   2. Integration (gated on `INTEGRATION_TEST=1`): runs the full
 *      `verifyPendlePosition` against live mainnet RPC for the CSfusionMVWETH
 *      MetaVault's pendle:fusnstETH external position
 *      (market 0x559e61c5647fa13d87a3c1dc1229189fcb52227a). Exercises RPC
 *      plumbing + timeouts + decode-then-format end-to-end.
 *
 * The integration block is `skip:`-gated so npm run test:unit stays
 * RPC-free and reproducible. Operators set INTEGRATION_TEST=1 to refresh
 * the verification calibration.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PENDLE_MARKET_SELECTORS,
  chainIdToSlug,
  decodePendleMarketState,
  formatPendleVerification,
  pendleVerifier,
  verifyPendlePosition,
  type PendleVerification,
  type PendleVerificationOk,
} from "./pendle-verifier.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — fixtures sourced from real RPC reads (see ts-doc atop verifier)
// ─────────────────────────────────────────────────────────────────────────────

// Result of readState(0x0) on the fusnstETH market, mainnet, 2026-04-26.
//
// Decoded:
//   totalPt   = 17,197,506,831,518,892,769  (≈17.198 PT)
//   totalSy   = 473,454,840,997,049,442,132 (raw wei; SY decimals=20 here)
//   totalLp   = 105,360,456,515,903,885,206 (≈105.36 LP)
//   treasury  = 0x8270400d528c34e1596ef367eedec99080a1b592
//   scalarRoot= 46,191,797,082,621,759,290
//   expiry    = 1777507200 = 2026-04-30T00:00:00Z
//   lnFee     = 4,788,516,731,797,177
//   reserveFee= 80
//   lastLnImp = 93,619,595,635,982,479
const FIXTURE_READSTATE_FUSNSTETH =
  "0x" +
  "000000000000000000000000000000000000000000000000eea9d158d30982e1" + // totalPt
  "000000000000000000000000000000000000000000000019aa817d6a622e9f54" + // totalSy
  "000000000000000000000000000000000000000000000005b62b88fa43710f96" + // totalLp
  "0000000000000000000000008270400d528c34e1596ef367eedec99080a1b592" + // treasury
  "000000000000000000000000000000000000000000000002810a3ab646984f3a" + // scalarRoot
  "0000000000000000000000000000000000000000000000000000000069f29b80" + // expiry
  "000000000000000000000000000000000000000000000000001103216eccbeb9" + // lnFeeRoot
  "0000000000000000000000000000000000000000000000000000000000000050" + // reserveFee
  "000000000000000000000000000000000000000000000000014c9a86b5e6008f"; // lastLnImp

// All-zero MarketState — unmaterialized contract.
const FIXTURE_READSTATE_ZERO = "0x" + "00".repeat(288);

// Truncated (8 slots instead of 9) — should fail length check.
const FIXTURE_READSTATE_TRUNC = "0x" + "00".repeat(256);

// Single 32-byte words for expiry / isExpired / counter
const FIXTURE_EXPIRY_2026_04_30 =
  "0x" + "0000000000000000000000000000000000000000000000000000000069f29b80";
const FIXTURE_EXPIRY_OTHER =
  "0x" + "0000000000000000000000000000000000000000000000000000000060000000";
const FIXTURE_BOOL_TRUE =
  "0x" + "0000000000000000000000000000000000000000000000000000000000000001";
const FIXTURE_BOOL_FALSE =
  "0x" + "0000000000000000000000000000000000000000000000000000000000000000";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — selector shape
// ─────────────────────────────────────────────────────────────────────────────

describe("pendle-verifier — constants", () => {
  it("selectors are 4-byte hex", () => {
    for (const sel of Object.values(PENDLE_MARKET_SELECTORS)) {
      assert.match(sel, /^0x[0-9a-f]{8}$/);
    }
  });

  it("expiry selector matches independently-computed keccak256", () => {
    // keccak256("expiry()") first 4 bytes — verified against the
    // node `keccak` package and against the live fusnstETH market on
    // mainnet (block 25,096,224, 2026-04-26).
    assert.equal(PENDLE_MARKET_SELECTORS.expiry, "0xe184c9be");
  });

  it("isExpired selector matches independently-computed keccak256", () => {
    assert.equal(PENDLE_MARKET_SELECTORS.isExpired, "0x2f13b60c");
  });

  it("readState selector matches independently-computed keccak256", () => {
    assert.equal(PENDLE_MARKET_SELECTORS.readState, "0x794052f3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chainIdToSlug — chain resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("chainIdToSlug — chain resolution", () => {
  it("mainnet=1", () => {
    assert.equal(chainIdToSlug(1), "mainnet");
  });

  it("base=8453", () => {
    assert.equal(chainIdToSlug(8453), "base");
  });

  it("arbitrum=42161", () => {
    assert.equal(chainIdToSlug(42161), "arbitrum");
  });

  it("returns null for chains we don't have RPC config for", () => {
    // Pendle deploys on chains Spectra doesn't (e.g., mantle=5000). The
    // verifier MUST refuse rather than guess.
    assert.equal(chainIdToSlug(5000), null);
    assert.equal(chainIdToSlug(999_999_999), null);
  });

  it("returns 'mainnet' (NOT 'ethereum' alias) for chainId 1", () => {
    // The "ethereum" key is an alias kept for user-facing CLI input —
    // resolveRpcUrlsWithFallbacks expects the canonical "mainnet" slug.
    // Surfacing "ethereum" here would silently break the RPC lookup
    // because CHAIN_RPC_URLS doesn't have a "ethereum" key.
    assert.equal(chainIdToSlug(1), "mainnet");
    assert.notEqual(chainIdToSlug(1), "ethereum");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decodePendleMarketState — pure ABI decode
// ─────────────────────────────────────────────────────────────────────────────

describe("decodePendleMarketState — happy path", () => {
  it("decodes the live fusnstETH readState fixture", () => {
    const r = decodePendleMarketState(FIXTURE_READSTATE_FUSNSTETH);
    assert.notEqual(r, null);
    assert.equal(r!.totalPt, BigInt("0xeea9d158d30982e1"));
    assert.equal(r!.totalSy, BigInt("0x19aa817d6a622e9f54"));
    assert.equal(r!.totalLp, BigInt("0x5b62b88fa43710f96"));
    assert.equal(r!.expiry, 1777507200n);
  });

  it("decodes the all-zero state without crashing (zero values)", () => {
    const r = decodePendleMarketState(FIXTURE_READSTATE_ZERO);
    assert.notEqual(r, null);
    assert.equal(r!.totalPt, 0n);
    assert.equal(r!.totalSy, 0n);
    assert.equal(r!.totalLp, 0n);
    assert.equal(r!.expiry, 0n);
  });
});

describe("decodePendleMarketState — failure modes", () => {
  it("rejects empty / missing input", () => {
    assert.equal(decodePendleMarketState(""), null);
    assert.equal(decodePendleMarketState("0x"), null);
  });

  it("rejects truncated input (<9 slots)", () => {
    assert.equal(decodePendleMarketState(FIXTURE_READSTATE_TRUNC), null);
  });

  it("rejects non-hex prefix", () => {
    assert.equal(decodePendleMarketState("not-hex-at-all"), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatPendleVerification — render layer
// ─────────────────────────────────────────────────────────────────────────────

function makeOk(overrides: Partial<PendleVerificationOk> = {}): PendleVerificationOk {
  return {
    kind: "ok",
    marketAddress: "0x559e61c5647fa13d87a3c1dc1229189fcb52227a",
    chainSlug: "mainnet",
    chainId: 1,
    expirySec: 1777507200, // 2026-04-30
    isExpired: false,
    totalPtWei: BigInt("0xeea9d158d30982e1"),
    totalSyWei: BigInt("0x19aa817d6a622e9f54"),
    totalLpWei: BigInt("0x5b62b88fa43710f96"),
    blockRead: 25_096_224,
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    ...overrides,
  };
}

describe("formatPendleVerification — happy path", () => {
  it("renders ✓ glyph for clean active market", () => {
    const out = formatPendleVerification(makeOk());
    assert.match(out, /\[chain-truth ✓\]/);
    assert.match(out, /expiry=2026-04-30/);
    assert.match(out, /isExpired=false/);
    assert.match(out, /LP=105\.3604/);
    assert.match(out, /PT=17\.1975/);
    assert.match(out, /SY-wei=473454840997049442132/);
    assert.match(out, /block 25096224/);
  });

  it("does NOT carry the avant 'eligible' qualifier", () => {
    // Pendle exits are truly instant via AMM; the verifier confirms a swap
    // can transact NOW (no operational cooldown). The 'eligible' qualifier
    // is avant-specific (SERVICE_ROLE-gated settlement) and would be
    // misleading here.
    const out = formatPendleVerification(makeOk());
    assert.match(out, /\[chain-truth ✓\]/);
    assert.doesNotMatch(out, /eligible/);
  });

  it("absorbs missing expectedExpirySec (no warning, plain ✓)", () => {
    const out = formatPendleVerification(makeOk(), undefined);
    assert.match(out, /\[chain-truth ✓\]/);
    assert.doesNotMatch(out, /drift/);
  });

  it("absorbs matching expectedExpirySec", () => {
    const out = formatPendleVerification(makeOk(), 1777507200);
    assert.match(out, /\[chain-truth ✓\]/);
    assert.doesNotMatch(out, /drift/);
  });
});

describe("formatPendleVerification — warning glyph routing", () => {
  it("emits ⚠ when on-chain expiry differs from API expiry", () => {
    // 1777507200 chain vs 1700000000 API — pure indexer drift.
    const out = formatPendleVerification(makeOk(), 1700000000);
    assert.match(out, /\[chain-truth ⚠\]/);
    assert.match(out, /expiry drift/);
    assert.match(out, /chain=1777507200/);
    assert.match(out, /api=1700000000/);
  });

  it("emits ⚠ when contract reports isExpired=true", () => {
    // Post-maturity state — AMM is closed, only redeem() works.
    const out = formatPendleVerification(makeOk({ isExpired: true }));
    assert.match(out, /\[chain-truth ⚠\]/);
    assert.match(out, /isExpired=true/);
    assert.match(out, /AMM closed/);
  });

  it("emits ⚠ when totalLp=0 (market structurally dry)", () => {
    const out = formatPendleVerification(makeOk({ totalLpWei: 0n }));
    assert.match(out, /\[chain-truth ⚠\]/);
    assert.match(out, /totalLp=0/);
  });

  it("renders multiple warnings concatenated when several conditions fire", () => {
    const out = formatPendleVerification(
      makeOk({ isExpired: true, totalLpWei: 0n }),
      1700000000,
    );
    assert.match(out, /\[chain-truth ⚠\]/);
    assert.match(out, /expiry drift/);
    assert.match(out, /AMM closed/);
    assert.match(out, /totalLp=0/);
  });

  it("ignores expectedExpirySec when undefined or non-finite", () => {
    // Defensive: a missing API maturity must NOT cause a false ⚠.
    const out1 = formatPendleVerification(makeOk(), undefined);
    assert.match(out1, /\[chain-truth ✓\]/);
    const out2 = formatPendleVerification(makeOk(), Number.NaN);
    assert.match(out2, /\[chain-truth ✓\]/);
    const out3 = formatPendleVerification(makeOk(), Number.POSITIVE_INFINITY);
    assert.match(out3, /\[chain-truth ✓\]/);
  });
});

describe("formatPendleVerification — failure rendering", () => {
  it("renders ✗ for failed verifications", () => {
    const v: PendleVerification = {
      kind: "failed",
      marketAddress: "0x559e61c5647fa13d87a3c1dc1229189fcb52227a",
      chainSlug: "mainnet",
      error: "RPC HTTP 503",
    };
    const out = formatPendleVerification(v);
    assert.match(out, /\[chain-truth ✗\]/);
    assert.match(out, /RPC HTTP 503/);
  });

  it("renders ✗ for decode failure", () => {
    const v: PendleVerification = {
      kind: "failed",
      marketAddress: "0x559e61c5647fa13d87a3c1dc1229189fcb52227a",
      chainSlug: "mainnet",
      error: "readState decode failed (length mismatch)",
    };
    const out = formatPendleVerification(v);
    assert.match(out, /\[chain-truth ✗\]/);
    assert.match(out, /decode failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyPendlePosition — input guards
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyPendlePosition — input validation", () => {
  it("rejects malformed marketAddress", async () => {
    const r = await verifyPendlePosition("not-an-address", 1);
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") assert.match(r.error, /invalid marketAddress/);
  });

  it("rejects empty marketAddress", async () => {
    const r = await verifyPendlePosition("", 1);
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") assert.match(r.error, /invalid marketAddress/);
  });

  it("rejects negative chainId", async () => {
    const r = await verifyPendlePosition(
      "0x559e61c5647fa13d87a3c1dc1229189fcb52227a",
      -1,
    );
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") assert.match(r.error, /invalid chainId/);
  });

  it("rejects non-integer chainId", async () => {
    const r = await verifyPendlePosition(
      "0x559e61c5647fa13d87a3c1dc1229189fcb52227a",
      3.14,
    );
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") assert.match(r.error, /invalid chainId/);
  });

  it("rejects unsupported chainId (no RPC config)", async () => {
    const r = await verifyPendlePosition(
      "0x559e61c5647fa13d87a3c1dc1229189fcb52227a",
      999_999_999,
    );
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") assert.match(r.error, /unsupported chainId/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pendleVerifier — dispatch contract
// ─────────────────────────────────────────────────────────────────────────────

describe("pendleVerifier — strategy dispatch", () => {
  it("name is 'pendle'", () => {
    assert.equal(pendleVerifier.name, "pendle");
  });

  it("positionKey produces stable key for valid input", () => {
    const k = pendleVerifier.positionKey({
      protocol: "pendle",
      chainId: 1,
      market: { address: "0x559e61c5647fa13d87a3c1dc1229189fcb52227a" },
    } as never);
    assert.equal(
      k,
      "pendle:1:0x559e61c5647fa13d87a3c1dc1229189fcb52227a",
    );
  });

  it("positionKey lowercases address for stable key", () => {
    const k = pendleVerifier.positionKey({
      chainId: 1,
      market: { address: "0x559E61C5647FA13D87A3C1DC1229189FCB52227A" },
    } as never);
    assert.equal(
      k,
      "pendle:1:0x559e61c5647fa13d87a3c1dc1229189fcb52227a",
    );
  });

  it("positionKey is collision-proof across chains (chainId in key)", () => {
    const a = pendleVerifier.positionKey({
      chainId: 1,
      market: { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    } as never);
    const b = pendleVerifier.positionKey({
      chainId: 8453,
      market: { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    } as never);
    // Same address, different chains → different keys.
    assert.notEqual(a, b);
  });

  it("verify on malformed position returns failed without throwing", async () => {
    const r = await pendleVerifier.verify({} as never);
    assert.equal(r.kind, "failed");
    assert.equal(r.protocol, "pendle");
    assert.match(r.line, /\[chain-truth ✗\]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration — gated on INTEGRATION_TEST=1
// ─────────────────────────────────────────────────────────────────────────────

const RUN_INTEGRATION = process.env.INTEGRATION_TEST === "1";

describe(
  "verifyPendlePosition [integration] — live mainnet RPC reads",
  { skip: !RUN_INTEGRATION },
  () => {
    // CSfusionMVWETH (mainnet) MetaVault holds this Pendle external position.
    // Market address is also the LP token address (Pendle V2 invariant).
    const FUSNSTETH_MARKET = "0x559e61c5647fa13d87a3c1dc1229189fcb52227a";
    const MAINNET_CHAIN_ID = 1;

    it("verifies fusnstETH market on mainnet", async () => {
      const r = await verifyPendlePosition(FUSNSTETH_MARKET, MAINNET_CHAIN_ID);
      assert.equal(r.kind, "ok", r.kind === "failed" ? r.error : "");
      if (r.kind !== "ok") return;
      assert.equal(r.marketAddress, FUSNSTETH_MARKET);
      assert.equal(r.chainSlug, "mainnet");
      assert.equal(r.chainId, MAINNET_CHAIN_ID);
      // expiry should match the API's market.maturity exactly.
      assert.equal(r.expirySec, 1777507200);
      // Pre/post maturity is time-dependent — soft-assert on the structural
      // invariant (expiry is in the past) rather than the bool's value.
      // 2026-04-30 has passed by the time integration runs in production,
      // so isExpired could legitimately be either true or false depending
      // on when Pendle's keeper toggled the flag.
      assert.equal(typeof r.isExpired, "boolean");
      assert.ok(r.totalLpWei >= 0n);
      assert.ok(r.totalPtWei >= 0n);
      assert.ok(r.totalSyWei >= 0n);
      assert.ok(r.blockRead > 0);
    });

    it("formats the live verification as ✓ or ⚠ (never ✗)", async () => {
      const r = await verifyPendlePosition(FUSNSTETH_MARKET, MAINNET_CHAIN_ID);
      const line = formatPendleVerification(r, 1777507200);
      assert.doesNotMatch(line, /\[chain-truth ✗\]/, "live read must not fail");
      assert.match(line, /\[chain-truth (✓|⚠)\]/);
    });

    it("returns failed for a non-contract address (no bytecode)", async () => {
      // 0xdead…dead — well-known burn address; eth_call to it will revert
      // because there's no contract code. The verifier must surface this
      // gracefully as a failed result, not crash.
      const r = await verifyPendlePosition(
        "0x000000000000000000000000000000000000dead",
        MAINNET_CHAIN_ID,
      );
      assert.equal(r.kind, "failed");
    });
  },
);
