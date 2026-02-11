/**
 * Unit tests for config.ts — chain resolution, Zod schemas, and constants.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveNetwork, CHAIN_ENUM, EVM_ADDRESS, SUPPORTED_CHAINS, API_NETWORKS, MORPHO_CHAIN_IDS } from "./config.js";

// =============================================================================
// resolveNetwork
// =============================================================================

describe("resolveNetwork", () => {
  it("maps 'ethereum' to 'mainnet'", () => {
    assert.equal(resolveNetwork("ethereum"), "mainnet");
  });

  it("passes 'mainnet' through unchanged", () => {
    assert.equal(resolveNetwork("mainnet"), "mainnet");
  });

  it("passes other chains through unchanged", () => {
    assert.equal(resolveNetwork("base"), "base");
    assert.equal(resolveNetwork("arbitrum"), "arbitrum");
    assert.equal(resolveNetwork("sonic"), "sonic");
  });
});

// =============================================================================
// CHAIN_ENUM (Zod schema)
// =============================================================================

describe("CHAIN_ENUM", () => {
  it("accepts all supported chains", () => {
    const chains = ["mainnet", "base", "arbitrum", "optimism", "avalanche", "katana", "sonic", "flare", "bsc", "monad", "ethereum"];
    for (const chain of chains) {
      const result = CHAIN_ENUM.safeParse(chain);
      assert.ok(result.success, `Expected '${chain}' to be valid`);
    }
  });

  it("rejects unknown chains", () => {
    const result = CHAIN_ENUM.safeParse("polygon");
    assert.equal(result.success, false);
  });

  it("rejects empty string", () => {
    const result = CHAIN_ENUM.safeParse("");
    assert.equal(result.success, false);
  });

  it("rejects non-string input", () => {
    const result = CHAIN_ENUM.safeParse(42);
    assert.equal(result.success, false);
  });
});

// =============================================================================
// EVM_ADDRESS (Zod schema)
// =============================================================================

describe("EVM_ADDRESS", () => {
  it("accepts valid checksummed address", () => {
    const result = EVM_ADDRESS.safeParse("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    assert.ok(result.success);
  });

  it("accepts valid lowercase address", () => {
    const result = EVM_ADDRESS.safeParse("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    assert.ok(result.success);
  });

  it("rejects address without 0x prefix", () => {
    const result = EVM_ADDRESS.safeParse("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    assert.equal(result.success, false);
  });

  it("rejects address with wrong length (too short)", () => {
    const result = EVM_ADDRESS.safeParse("0xa0b86991c6218b36c1d19d");
    assert.equal(result.success, false);
  });

  it("rejects address with wrong length (too long)", () => {
    const result = EVM_ADDRESS.safeParse("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48ff");
    assert.equal(result.success, false);
  });

  it("rejects address with non-hex characters", () => {
    const result = EVM_ADDRESS.safeParse("0xZZb86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    assert.equal(result.success, false);
  });

  it("rejects empty string", () => {
    const result = EVM_ADDRESS.safeParse("");
    assert.equal(result.success, false);
  });
});

// =============================================================================
// API_NETWORKS
// =============================================================================

describe("API_NETWORKS", () => {
  it("excludes the 'ethereum' alias", () => {
    assert.ok(!API_NETWORKS.includes("ethereum"));
  });

  it("includes 'mainnet'", () => {
    assert.ok(API_NETWORKS.includes("mainnet"));
  });

  it("has 10 networks", () => {
    assert.equal(API_NETWORKS.length, 10);
  });
});

// =============================================================================
// MORPHO_CHAIN_IDS
// =============================================================================

describe("MORPHO_CHAIN_IDS", () => {
  it("maps mainnet to chain ID 1", () => {
    assert.equal(MORPHO_CHAIN_IDS["mainnet"], 1);
  });

  it("maps base to chain ID 8453", () => {
    assert.equal(MORPHO_CHAIN_IDS["base"], 8453);
  });

  it("does not include chains without Morpho PT markets", () => {
    assert.equal(MORPHO_CHAIN_IDS["sonic"], undefined);
    assert.equal(MORPHO_CHAIN_IDS["flare"], undefined);
  });
});

// =============================================================================
// SUPPORTED_CHAINS
// =============================================================================

describe("SUPPORTED_CHAINS", () => {
  it("has 11 entries (10 chains + ethereum alias)", () => {
    assert.equal(Object.keys(SUPPORTED_CHAINS).length, 11);
  });

  it("mainnet and ethereum alias have the same chain ID", () => {
    assert.equal(SUPPORTED_CHAINS["mainnet"].id, SUPPORTED_CHAINS["ethereum"].id);
  });
});
