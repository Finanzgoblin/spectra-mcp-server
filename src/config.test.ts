/**
 * Unit tests for config.ts — chain resolution, Zod schemas, and constants.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveNetwork, resolveRpcUrlsWithFallbacks, CHAIN_ENUM, EVM_ADDRESS, SUPPORTED_CHAINS, API_NETWORKS, MORPHO_CHAIN_IDS, CHAIN_RPC_URLS, CHAIN_RPC_FALLBACKS } from "./config.js";

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
    const chains = ["mainnet", "base", "arbitrum", "optimism", "avalanche", "katana", "sonic", "flare", "bsc", "monad", "hemi", "hyperevm", "sei", "ethereum"];
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

  it("has 13 networks", () => {
    assert.equal(API_NETWORKS.length, 13);
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
  it("has 14 entries (13 chains + ethereum alias)", () => {
    assert.equal(Object.keys(SUPPORTED_CHAINS).length, 14);
  });

  it("mainnet and ethereum alias have the same chain ID", () => {
    assert.equal(SUPPORTED_CHAINS["mainnet"].id, SUPPORTED_CHAINS["ethereum"].id);
  });
});

// =============================================================================
// resolveRpcUrlsWithFallbacks
// =============================================================================

describe("resolveRpcUrlsWithFallbacks", () => {
  it("returns primary + fallbacks for mainnet", () => {
    const urls = resolveRpcUrlsWithFallbacks("mainnet");
    assert.ok(urls.length >= 2, `expected at least 2 URLs for mainnet, got ${urls.length}`);
    assert.equal(urls[0], CHAIN_RPC_URLS["mainnet"]);
    // Fallbacks should be in the list
    const fallbacks = CHAIN_RPC_FALLBACKS["mainnet"] || [];
    for (const fb of fallbacks) {
      assert.ok(urls.includes(fb), `missing fallback ${fb}`);
    }
  });

  it("returns only override when provided", () => {
    const urls = resolveRpcUrlsWithFallbacks("mainnet", "https://custom-rpc.example.com");
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://custom-rpc.example.com");
  });

  it("returns primary RPC for katana", () => {
    const urls = resolveRpcUrlsWithFallbacks("katana");
    assert.equal(urls.length, 1);
    assert.equal(urls[0], CHAIN_RPC_URLS["katana"]);
  });

  it("returns empty array for chains without RPCs", () => {
    const urls = resolveRpcUrlsWithFallbacks("monad");
    assert.equal(urls.length, 0);
  });

  it("returns primary + fallbacks for chains with fallbacks", () => {
    const urls = resolveRpcUrlsWithFallbacks("sonic");
    assert.ok(urls.length >= 1, "sonic should have at least 1 RPC URL");
    assert.equal(urls[0], CHAIN_RPC_URLS["sonic"]);
  });

  it("handles ethereum alias correctly", () => {
    const urls = resolveRpcUrlsWithFallbacks("ethereum");
    const mainnetUrls = resolveRpcUrlsWithFallbacks("mainnet");
    assert.deepEqual(urls, mainnetUrls);
  });
});
