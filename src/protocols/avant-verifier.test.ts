/**
 * Tests for the Avant burn-order chain-truth verifier.
 *
 * Two layers:
 *   1. Unit (always-on): pure decoder + format primitives against synthetic
 *      hex inputs. Pins ABI semantics — selectors, tuple decoding, state
 *      enum range, address upper-byte zero guard, formatter glyph routing.
 *   2. Integration (gated on `INTEGRATION_TEST=1`): runs the full
 *      `verifyAvantPosition` against live Avalanche RPC for the three
 *      gamisUSDC requestIds verified at construction (779, 789, 796).
 *      Exercises RPC plumbing + timeouts + decode-then-format end-to-end.
 *
 * The integration block is `skip:`-gated so npm run test:unit stays
 * RPC-free and reproducible. Operators set INTEGRATION_TEST=1 to refresh
 * the verification calibration.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AVANT_AMOUNT_DRIFT_TOLERANCE_PPM,
  AVANT_REQUEST_STATE,
  AVANT_REQUESTS_MANAGER_AVAX,
  AVANT_SELECTORS,
  decodeBurnRequest,
  formatAvantVerification,
  isAmountDriftSignificant,
  verifyAvantPosition,
  type AvantVerification,
  type AvantVerificationOk,
} from "./avant-verifier.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — fixtures sourced from real RPC reads (see ts-doc atop verifier)
// ─────────────────────────────────────────────────────────────────────────────

// Result of burnRequests(796) read 2026-04-26.
// id=0x31c (796), provider=0x5e93…29b9a (gamisUSDC), state=0 (CREATED),
// amount=0x222309ff7bb8805cb3dc, token=0x24de87…0e346 (avUSD),
// minExpectedAmount=0x28a377bac9e4c1dcac0d.
const FIXTURE_REQUEST_796 =
  "0x" +
  // id
  "000000000000000000000000000000000000000000000000000000000000031c" +
  // provider (12-byte zero pad + 20-byte address)
  "0000000000000000000000005e93e1193a5e297cba0856e9b3f22b6e05429b9a" +
  // state CREATED=0
  "0000000000000000000000000000000000000000000000000000000000000000" +
  // amount
  "00000000000000000000000000000000000000000000222309ff7bb8805cb3dc" +
  // token (avUSD)
  "00000000000000000000000024de8771bc5ddb3362db529fc3358f2df3a0e346" +
  // minExpectedAmount
  "0000000000000000000000000000000000000000000028a377bac9e4c1dcac0d";

// Synthetic completed-state fixture (id=42, state=1).
const FIXTURE_REQUEST_COMPLETED =
  "0x" +
  "000000000000000000000000000000000000000000000000000000000000002a" +
  "0000000000000000000000005e93e1193a5e297cba0856e9b3f22b6e05429b9a" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000064" +
  "00000000000000000000000024de8771bc5ddb3362db529fc3358f2df3a0e346" +
  "0000000000000000000000000000000000000000000000000000000000000050";

// Synthetic cancelled-state fixture (id=43, state=2).
const FIXTURE_REQUEST_CANCELLED =
  "0x" +
  "000000000000000000000000000000000000000000000000000000000000002b" +
  "0000000000000000000000005e93e1193a5e297cba0856e9b3f22b6e05429b9a" +
  "0000000000000000000000000000000000000000000000000000000000000002" +
  "0000000000000000000000000000000000000000000000000000000000000050" +
  "00000000000000000000000024de8771bc5ddb3362db529fc3358f2df3a0e346" +
  "0000000000000000000000000000000000000000000000000000000000000040";

// All-zero result — RPC returned an empty mapping slot (request doesn't exist).
const FIXTURE_NONEXISTENT =
  "0x" + "00".repeat(192);

// Address with corrupted upper bytes (12-byte non-zero pad — must be rejected).
const FIXTURE_BAD_PROVIDER =
  "0x" +
  "000000000000000000000000000000000000000000000000000000000000031c" +
  // upper 12 bytes nonzero
  "ff00000000000000000000005e93e1193a5e297cba0856e9b3f22b6e05429b9a" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000024de8771bc5ddb3362db529fc3358f2df3a0e346" +
  "0000000000000000000000000000000000000000000000000000000000000000";

// Out-of-range state (=3 — not CREATED/COMPLETED/CANCELLED).
const FIXTURE_BAD_STATE =
  "0x" +
  "000000000000000000000000000000000000000000000000000000000000031c" +
  "0000000000000000000000005e93e1193a5e297cba0856e9b3f22b6e05429b9a" +
  "0000000000000000000000000000000000000000000000000000000000000003" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000024de8771bc5ddb3362db529fc3358f2df3a0e346" +
  "0000000000000000000000000000000000000000000000000000000000000000";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — selector + address shape
// ─────────────────────────────────────────────────────────────────────────────

describe("avant-verifier — constants", () => {
  it("contract address is checksum-stable lowercase", () => {
    assert.equal(AVANT_REQUESTS_MANAGER_AVAX.length, 42);
    assert.equal(AVANT_REQUESTS_MANAGER_AVAX, AVANT_REQUESTS_MANAGER_AVAX.toLowerCase());
    assert.match(AVANT_REQUESTS_MANAGER_AVAX, /^0x[0-9a-f]{40}$/);
  });

  it("selectors are 4-byte hex", () => {
    for (const sel of Object.values(AVANT_SELECTORS)) {
      assert.match(sel, /^0x[0-9a-f]{8}$/);
    }
  });

  it("state enum values are 0/1/2", () => {
    assert.equal(AVANT_REQUEST_STATE.CREATED, 0);
    assert.equal(AVANT_REQUEST_STATE.COMPLETED, 1);
    assert.equal(AVANT_REQUEST_STATE.CANCELLED, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decodeBurnRequest — pure ABI decode
// ─────────────────────────────────────────────────────────────────────────────

describe("decodeBurnRequest — happy path", () => {
  it("decodes the live request 796 fixture", () => {
    const r = decodeBurnRequest(FIXTURE_REQUEST_796);
    assert.notEqual(r, null);
    assert.equal(r!.id, 796n);
    assert.equal(r!.provider, "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a");
    assert.equal(r!.state, AVANT_REQUEST_STATE.CREATED);
    assert.equal(r!.amount, BigInt("0x222309ff7bb8805cb3dc"));
    assert.equal(r!.token, "0x24de8771bc5ddb3362db529fc3358f2df3a0e346");
    assert.equal(r!.minExpectedAmount, BigInt("0x28a377bac9e4c1dcac0d"));
  });

  it("decodes a COMPLETED state", () => {
    const r = decodeBurnRequest(FIXTURE_REQUEST_COMPLETED);
    assert.notEqual(r, null);
    assert.equal(r!.state, AVANT_REQUEST_STATE.COMPLETED);
  });

  it("decodes a CANCELLED state", () => {
    const r = decodeBurnRequest(FIXTURE_REQUEST_CANCELLED);
    assert.notEqual(r, null);
    assert.equal(r!.state, AVANT_REQUEST_STATE.CANCELLED);
  });
});

describe("decodeBurnRequest — failure modes", () => {
  it("rejects empty / missing input", () => {
    assert.equal(decodeBurnRequest(""), null);
    assert.equal(decodeBurnRequest("0x"), null);
    assert.equal(decodeBurnRequest("0x" + "00".repeat(100)), null);
  });

  it("rejects upper-byte-corrupted provider address", () => {
    // Defense against RPC returning a malformed uint256 that decodes as a
    // syntactically-valid address. The 12-byte zero guard catches it.
    assert.equal(decodeBurnRequest(FIXTURE_BAD_PROVIDER), null);
  });

  it("rejects out-of-range state enum value", () => {
    assert.equal(decodeBurnRequest(FIXTURE_BAD_STATE), null);
  });

  it("decodes all-zero tuple (mapping slot empty) — id becomes 0n", () => {
    // Note: all-zero is structurally valid (provider is zero-address, state=0,
    // amounts are 0). The verifier-level logic above this catches the
    // "request not found" case via decoded.id !== queriedId.
    const r = decodeBurnRequest(FIXTURE_NONEXISTENT);
    assert.notEqual(r, null);
    assert.equal(r!.id, 0n);
    assert.equal(r!.provider, "0x0000000000000000000000000000000000000000");
    assert.equal(r!.state, AVANT_REQUEST_STATE.CREATED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatAvantVerification — render layer
// ─────────────────────────────────────────────────────────────────────────────

function makeOk(overrides: Partial<AvantVerificationOk> = {}): AvantVerificationOk {
  return {
    kind: "ok",
    requestId: 796,
    state: AVANT_REQUEST_STATE.CREATED,
    provider: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
    amountWei: BigInt("0x222309ff7bb8805cb3dc"),
    token: "0x24de8771bc5ddb3362db529fc3358f2df3a0e346",
    minExpectedAmountWei: BigInt("0x28a377bac9e4c1dcac0d"),
    burnRequestsCounter: 839,
    ordersSubmittedAfter: 43,
    paused: false,
    blockRead: 83939127,
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    ...overrides,
  };
}

describe("formatAvantVerification — happy path", () => {
  it("renders ✓ glyph for clean CREATED state", () => {
    const out = formatAvantVerification(makeOk());
    assert.match(out, /\[chain-truth ✓ eligible\]/);
    assert.match(out, /state=CREATED/);
    assert.match(out, /counter=839/);
    assert.match(out, /43 after/);
    assert.match(out, /paused=false/);
    assert.match(out, /block 83939127/);
  });

  it("includes provider+amount match implicitly (no warnings)", () => {
    const out = formatAvantVerification(
      makeOk(),
      "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
      BigInt("0x222309ff7bb8805cb3dc"),
    );
    assert.match(out, /\[chain-truth ✓ eligible\]/);
    assert.doesNotMatch(out, /mismatch/);
    assert.doesNotMatch(out, /drift/);
  });
});

describe("formatAvantVerification — warning glyph routing", () => {
  it("emits ⚠ when state ≠ CREATED (API rendering stale)", () => {
    const out = formatAvantVerification(
      makeOk({ state: AVANT_REQUEST_STATE.COMPLETED }),
    );
    assert.match(out, /\[chain-truth ⚠\]/);
    assert.match(out, /state=COMPLETED on-chain/);
  });

  it("emits ⚠ when contract is paused", () => {
    const out = formatAvantVerification(makeOk({ paused: true }));
    assert.match(out, /\[chain-truth ⚠\]/);
    assert.match(out, /contract paused/);
  });

  it("emits ⚠ on provider mismatch", () => {
    const expected = "0x1111111111111111111111111111111111111111";
    const out = formatAvantVerification(makeOk(), expected);
    assert.match(out, /\[chain-truth ⚠\]/);
    assert.match(out, /provider mismatch/);
  });

  it("emits ⚠ on significant amount drift (>100 ppm)", () => {
    const out = formatAvantVerification(makeOk(), undefined, 999n);
    assert.match(out, /\[chain-truth ⚠\]/);
    assert.match(out, /amount drift/);
  });

  it("ignores sub-tolerance amount drift (≤100 ppm — API rounding)", () => {
    // gamisUSDC live state: API rounds burnt.balance to a smaller-precision
    // representation than on-chain. Observed delta ~10^11 wei on ~10^23 wei
    // amounts (≈1e-12 relative). 100 ppm = 1e-4 relative — must absorb the
    // rounding without flagging.
    const ok = makeOk({ amountWei: BigInt("161206816890645531898844") });
    const apiAmount = BigInt("161206816890645500000000"); // API rounding
    const out = formatAvantVerification(ok, undefined, apiAmount);
    assert.match(out, /\[chain-truth ✓ eligible\]/);
    assert.doesNotMatch(out, /drift/);
  });

  it("ignores provider check when expectedProvider undefined", () => {
    // Defensive: when the API didn't carry a provider we trust, a missing
    // expected MUST NOT cause a false ⚠. Same for amount.
    const out = formatAvantVerification(makeOk(), undefined, undefined);
    assert.match(out, /\[chain-truth ✓ eligible\]/);
  });

  it("provider check is case-insensitive", () => {
    const out = formatAvantVerification(
      makeOk(),
      "0x5E93E1193A5E297CBA0856E9B3F22B6E05429B9A",
    );
    assert.match(out, /\[chain-truth ✓ eligible\]/);
  });
});

describe("isAmountDriftSignificant — boundary calibration", () => {
  // Tolerance is 100 ppm. 100 ppm of 10^9 = 10^5 = 100_000.
  // Use denom = 1e9 so deltas in 100_000-step units are interpretable as
  // direct ppm counts: delta=100_000 ⇔ exactly 100 ppm.
  const DENOM = 1_000_000_000n;

  it("zero drift is never significant", () => {
    assert.equal(isAmountDriftSignificant(100n, 100n), false);
  });

  it("constant tolerance is 100 ppm", () => {
    assert.equal(AVANT_AMOUNT_DRIFT_TOLERANCE_PPM, 100n);
  });

  it("just under tolerance: 50 ppm = not significant", () => {
    const delta = 50_000n; // 50 ppm of 1e9
    assert.equal(isAmountDriftSignificant(DENOM + delta, DENOM), false);
  });

  it("just over tolerance: 200 ppm = significant", () => {
    const delta = 200_000n; // 200 ppm of 1e9
    assert.equal(isAmountDriftSignificant(DENOM + delta, DENOM), true);
  });

  it("exactly at tolerance: 100 ppm = NOT significant (strict-greater compare)", () => {
    const delta = 100_000n; // exactly 100 ppm of 1e9
    assert.equal(isAmountDriftSignificant(DENOM + delta, DENOM), false);
  });

  it("zero on-chain vs nonzero api is significant", () => {
    assert.equal(isAmountDriftSignificant(0n, 100n), true);
  });

  it("symmetric: chain<api triggers same as chain>api", () => {
    const delta = 200_000n;
    assert.equal(
      isAmountDriftSignificant(DENOM + delta, DENOM),
      isAmountDriftSignificant(DENOM, DENOM + delta),
    );
  });

  it("real gamisUSDC drift (~10^11 wei on ~10^23 wei) is NOT significant", () => {
    // 161,206,816,890,645,531,898,844 chain vs 161,206,816,890,645,500,000,000 api
    // delta = 31,898,844 wei on denom ≈ 1.6e23 wei → ~2e-13 relative ≪ 100 ppm
    const chain = BigInt("161206816890645531898844");
    const api = BigInt("161206816890645500000000");
    assert.equal(isAmountDriftSignificant(chain, api), false);
  });
});

describe("formatAvantVerification — failure rendering", () => {
  it("renders ✗ for failed verifications", () => {
    const v: AvantVerification = {
      kind: "failed",
      requestId: 796,
      error: "RPC HTTP 503",
    };
    const out = formatAvantVerification(v);
    assert.match(out, /\[chain-truth ✗\]/);
    assert.match(out, /RPC HTTP 503/);
  });

  it("renders ✗ for not-found result", () => {
    const v: AvantVerification = {
      kind: "failed",
      requestId: 99999,
      error: "request not found on-chain",
    };
    const out = formatAvantVerification(v);
    assert.match(out, /\[chain-truth ✗\]/);
    assert.match(out, /not found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyAvantPosition — input guards
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyAvantPosition — input validation", () => {
  it("rejects negative requestId", async () => {
    const r = await verifyAvantPosition(-1);
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") assert.match(r.error, /invalid requestId/);
  });

  it("rejects non-integer requestId", async () => {
    const r = await verifyAvantPosition(3.14);
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") assert.match(r.error, /invalid requestId/);
  });

  it("rejects NaN", async () => {
    const r = await verifyAvantPosition(NaN);
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") assert.match(r.error, /invalid requestId/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration — gated on INTEGRATION_TEST=1
// ─────────────────────────────────────────────────────────────────────────────

const RUN_INTEGRATION = process.env.INTEGRATION_TEST === "1";

describe(
  "verifyAvantPosition [integration] — live Avalanche RPC reads",
  { skip: !RUN_INTEGRATION },
  () => {
    // gamisUSDC vault, used as the expected provider for all three orders.
    const GAMI_VAULT = "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a";

    it("verifies request 796 (orderId 24258 in API)", async () => {
      const r = await verifyAvantPosition(796);
      assert.equal(r.kind, "ok", r.kind === "failed" ? r.error : "");
      if (r.kind !== "ok") return;
      assert.equal(r.requestId, 796);
      assert.equal(r.provider.toLowerCase(), GAMI_VAULT);
      assert.ok(r.burnRequestsCounter >= 796);
      assert.ok(r.blockRead > 0);
      // Production requires the position to still be CREATED. Could
      // legitimately become COMPLETED post-cooldown — soft-assert on the
      // structural invariants and let the operator interpret the state.
      assert.ok([0, 1, 2].includes(r.state));
    });

    it("verifies request 789 (orderId 24239 in API)", async () => {
      const r = await verifyAvantPosition(789);
      assert.equal(r.kind, "ok", r.kind === "failed" ? r.error : "");
      if (r.kind !== "ok") return;
      assert.equal(r.requestId, 789);
      assert.equal(r.provider.toLowerCase(), GAMI_VAULT);
    });

    it("verifies request 779 (orderId 24209 in API)", async () => {
      const r = await verifyAvantPosition(779);
      assert.equal(r.kind, "ok", r.kind === "failed" ? r.error : "");
      if (r.kind !== "ok") return;
      assert.equal(r.requestId, 779);
      assert.equal(r.provider.toLowerCase(), GAMI_VAULT);
    });

    it("returns failed for a request well above the counter", async () => {
      // 999_999 is far above any plausible counter; the verifier must fail
      // gracefully, not throw.
      const r = await verifyAvantPosition(999_999);
      assert.equal(r.kind, "failed");
    });
  },
);
