/**
 * Tests for the verifier-registry contract.
 *
 * The registry is the seam where new protocol verifiers plug in. These
 * tests pin the contract so a future verifier author gets a clear error
 * when they break it (forgot to register, name doesn't match metadata,
 * positionKey malformed, etc.).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getVerifier,
  hasVerifier,
  listVerifierNames,
  listVerifiers,
} from "./verifier-registry.js";
import { avantVerifier } from "./avant-verifier.js";
import { pendleVerifier } from "./pendle-verifier.js";
import { PROTOCOL_METADATA } from "./metadata.js";

describe("verifier-registry — registration contract", () => {
  it("returns avant verifier by name", () => {
    const v = getVerifier("avant");
    assert.equal(v?.name, "avant");
    assert.equal(v, avantVerifier);
  });

  it("returns pendle verifier by name", () => {
    const v = getVerifier("pendle");
    assert.equal(v?.name, "pendle");
    assert.equal(v, pendleVerifier);
  });

  it("returns undefined for unregistered protocols", () => {
    assert.equal(getVerifier("parallel"), undefined);
    assert.equal(getVerifier("nonexistent-protocol"), undefined);
    assert.equal(getVerifier(""), undefined);
  });

  it("hasVerifier mirrors getVerifier presence", () => {
    assert.equal(hasVerifier("avant"), true);
    assert.equal(hasVerifier("pendle"), true);
    assert.equal(hasVerifier("parallel"), false);
    assert.equal(hasVerifier(""), false);
  });

  it("listVerifierNames returns at least avant + pendle in stable order", () => {
    const names = listVerifierNames();
    assert.ok(names.includes("avant"), "avant must be registered");
    assert.ok(names.includes("pendle"), "pendle must be registered");
    // Stable order property: same call twice returns same array contents
    assert.deepEqual(listVerifierNames(), names);
  });

  it("listVerifiers returns the strategy objects (not just names)", () => {
    const verifiers = listVerifiers();
    assert.ok(verifiers.length >= 2);
    assert.ok(verifiers.find((v) => v.name === "avant"));
    assert.ok(verifiers.find((v) => v.name === "pendle"));
  });
});

describe("verifier-registry — name/metadata coupling invariant", () => {
  // CRITICAL: every registered verifier's `name` must match a key in
  // PROTOCOL_METADATA. The engine.ts render path looks up the verifier by
  // `meta.name` — a mismatch silently disables chain-truth for that
  // protocol. This test fires the moment the invariant is broken.
  it("every registered verifier has a matching PROTOCOL_METADATA entry", () => {
    for (const v of listVerifiers()) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(PROTOCOL_METADATA, v.name),
        `verifier "${v.name}" has no PROTOCOL_METADATA["${v.name}"] entry — registration mismatch`,
      );
    }
  });
});

describe("verifier-registry — ProtocolVerifier interface contract", () => {
  it("each verifier exposes name, positionKey, verify", () => {
    for (const v of listVerifiers()) {
      assert.equal(typeof v.name, "string", "name must be string");
      assert.ok(v.name.length > 0, "name must be non-empty");
      assert.equal(
        typeof v.positionKey,
        "function",
        `${v.name}: positionKey must be a function`,
      );
      assert.equal(
        typeof v.verify,
        "function",
        `${v.name}: verify must be a function`,
      );
    }
  });

  it("positionKey returns null for malformed input without throwing", () => {
    // Each verifier must defend against malformed positions — return null,
    // don't throw. This prevents one bad position from killing the whole
    // worker pool.
    for (const v of listVerifiers()) {
      // Empty object — no protocol-specific fields
      const k1 = v.positionKey({} as never);
      assert.ok(
        k1 === null || typeof k1 === "string",
        `${v.name}: positionKey on {} returned ${typeof k1}; must be string|null`,
      );
    }
  });
});

describe("verifier-registry — avant strategy through the dispatcher", () => {
  it("avant positionKey produces avant:<requestId> for valid input", () => {
    const v = getVerifier("avant");
    assert.ok(v);
    const key = v!.positionKey({ requestId: 796 } as never);
    assert.equal(key, "avant:796");
  });

  it("avant positionKey returns null when requestId missing", () => {
    const v = getVerifier("avant");
    assert.equal(v!.positionKey({} as never), null);
    assert.equal(v!.positionKey({ requestId: "not-a-number" } as never), null);
    assert.equal(v!.positionKey({ requestId: 0 } as never), null, "requestId=0 invalid");
    assert.equal(v!.positionKey({ requestId: -1 } as never), null);
    assert.equal(v!.positionKey({ requestId: 1.5 } as never), null);
  });

  it("avant verify returns failed result (no throw) when requestId missing", async () => {
    const v = getVerifier("avant");
    const result = await v!.verify({} as never);
    assert.equal(result.kind, "failed");
    assert.equal(result.protocol, "avant");
    assert.match(result.line, /\[chain-truth ✗\]/);
  });
});

describe("verifier-registry — pendle strategy through the dispatcher", () => {
  it("pendle positionKey produces pendle:<chainId>:<address> for valid input", () => {
    const v = getVerifier("pendle");
    assert.ok(v);
    const key = v!.positionKey({
      protocol: "pendle",
      chainId: 1,
      market: { address: "0x559E61C5647FA13D87a3C1Dc1229189FCb52227A" },
    } as never);
    // Address gets lowercased; key shape is pendle:<chainId>:<addr>
    assert.equal(key, "pendle:1:0x559e61c5647fa13d87a3c1dc1229189fcb52227a");
  });

  it("pendle positionKey returns null when market.address missing", () => {
    const v = getVerifier("pendle");
    assert.equal(v!.positionKey({} as never), null);
    assert.equal(v!.positionKey({ chainId: 1 } as never), null);
    assert.equal(
      v!.positionKey({ chainId: 1, market: {} } as never),
      null,
      "missing market.address",
    );
    assert.equal(
      v!.positionKey({
        chainId: 1,
        market: { address: "not-an-address" },
      } as never),
      null,
      "non-hex market.address",
    );
    assert.equal(
      v!.positionKey({
        market: { address: "0x559e61c5647fa13d87a3c1dc1229189fcb52227a" },
      } as never),
      null,
      "missing chainId",
    );
    assert.equal(
      v!.positionKey({
        chainId: 0,
        market: { address: "0x559e61c5647fa13d87a3c1dc1229189fcb52227a" },
      } as never),
      null,
      "chainId=0 invalid",
    );
  });

  it("pendle verify returns failed result (no throw) when shape malformed", async () => {
    const v = getVerifier("pendle");
    const result = await v!.verify({} as never);
    assert.equal(result.kind, "failed");
    assert.equal(result.protocol, "pendle");
    assert.match(result.line, /\[chain-truth ✗\]/);
  });
});
