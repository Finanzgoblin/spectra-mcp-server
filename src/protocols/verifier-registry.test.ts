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
import { PROTOCOL_METADATA } from "./metadata.js";

describe("verifier-registry — registration contract", () => {
  it("returns avant verifier by name", () => {
    const v = getVerifier("avant");
    assert.equal(v?.name, "avant");
    assert.equal(v, avantVerifier);
  });

  it("returns undefined for unregistered protocols", () => {
    assert.equal(getVerifier("pendle"), undefined);
    assert.equal(getVerifier("parallel"), undefined);
    assert.equal(getVerifier("nonexistent-protocol"), undefined);
    assert.equal(getVerifier(""), undefined);
  });

  it("hasVerifier mirrors getVerifier presence", () => {
    assert.equal(hasVerifier("avant"), true);
    assert.equal(hasVerifier("pendle"), false);
    assert.equal(hasVerifier(""), false);
  });

  it("listVerifierNames returns at least avant in stable order", () => {
    const names = listVerifierNames();
    assert.ok(names.includes("avant"), "avant must be registered");
    // Stable order property: same call twice returns same array contents
    assert.deepEqual(listVerifierNames(), names);
  });

  it("listVerifiers returns the strategy objects (not just names)", () => {
    const verifiers = listVerifiers();
    assert.ok(verifiers.length >= 1);
    assert.ok(verifiers.find((v) => v.name === "avant"));
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
