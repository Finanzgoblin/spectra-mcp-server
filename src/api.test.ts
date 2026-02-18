/**
 * Unit tests for api.ts — sanitization and non-network helpers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeGraphQL, MORPHO_MARKET_FIELDS, extractPoolAddressFromReasonKey, parseWei, parseMerklRewards } from "./api.js";

// =============================================================================
// sanitizeGraphQL
// =============================================================================

describe("sanitizeGraphQL", () => {
  it("passes through clean addresses", () => {
    const addr = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    assert.equal(sanitizeGraphQL(addr), addr);
  });

  it("passes through alphanumeric strings", () => {
    assert.equal(sanitizeGraphQL("hello123"), "hello123");
  });

  it("strips backslashes", () => {
    assert.equal(sanitizeGraphQL('hello\\world'), "helloworld");
  });

  it("strips double quotes", () => {
    assert.equal(sanitizeGraphQL('hello"world'), "helloworld");
  });

  it("strips newlines and tabs", () => {
    assert.equal(sanitizeGraphQL("hello\nworld\r\t"), "helloworld");
  });

  it("strips curly braces", () => {
    assert.equal(sanitizeGraphQL("hello{world}"), "helloworld");
  });

  it("strips parentheses", () => {
    assert.equal(sanitizeGraphQL("hello(world)"), "helloworld");
  });

  it("strips square brackets", () => {
    assert.equal(sanitizeGraphQL("hello[world]"), "helloworld");
  });

  it("strips hash comments", () => {
    assert.equal(sanitizeGraphQL("hello#comment"), "hellocomment");
  });

  it("preserves colons (valid in identifiers)", () => {
    assert.equal(sanitizeGraphQL("a:b"), "a:b");
  });

  it("handles empty string", () => {
    assert.equal(sanitizeGraphQL(""), "");
  });

  it("handles string with only special chars", () => {
    assert.equal(sanitizeGraphQL('"\\{}()[]#\n\r\t'), "");
  });

  it("blocks GraphQL injection attempt", () => {
    const malicious = '0x1234"} ) { markets { items { uniqueKey } } }#';
    const sanitized = sanitizeGraphQL(malicious);
    assert.ok(!sanitized.includes("{"));
    assert.ok(!sanitized.includes("}"));
    assert.ok(!sanitized.includes('"'));
    assert.ok(!sanitized.includes("#"));
  });
});

// =============================================================================
// MORPHO_MARKET_FIELDS
// =============================================================================

describe("MORPHO_MARKET_FIELDS", () => {
  it("is a non-empty string", () => {
    assert.ok(MORPHO_MARKET_FIELDS.length > 0);
  });

  it("includes essential field names", () => {
    assert.ok(MORPHO_MARKET_FIELDS.includes("uniqueKey"));
    assert.ok(MORPHO_MARKET_FIELDS.includes("lltv"));
    assert.ok(MORPHO_MARKET_FIELDS.includes("collateralAsset"));
    assert.ok(MORPHO_MARKET_FIELDS.includes("loanAsset"));
    assert.ok(MORPHO_MARKET_FIELDS.includes("borrowApy"));
    assert.ok(MORPHO_MARKET_FIELDS.includes("supplyApy"));
    assert.ok(MORPHO_MARKET_FIELDS.includes("liquidityAssetsUsd"));
  });
});

// =============================================================================
// extractPoolAddressFromReasonKey
// =============================================================================

describe("extractPoolAddressFromReasonKey", () => {
  it("extracts address from ERC20 prefix", () => {
    const result = extractPoolAddressFromReasonKey("ERC20_0x09B1D5860E50a67ce46788813892F7028cAa64AE");
    assert.equal(result, "0x09B1D5860E50a67ce46788813892F7028cAa64AE");
  });

  it("extracts address from Aave_Supply prefix", () => {
    const result = extractPoolAddressFromReasonKey("Aave_Supply_0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c");
    assert.equal(result, "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c");
  });

  it("returns null for key without address", () => {
    assert.equal(extractPoolAddressFromReasonKey("base"), null);
  });

  it("returns last address when multiple present", () => {
    const result = extractPoolAddressFromReasonKey(
      "MultiLogProcessor_0x1111111111111111111111111111111111111111_ERC20_0x2222222222222222222222222222222222222222"
    );
    assert.equal(result, "0x2222222222222222222222222222222222222222");
  });

  it("returns null for empty string", () => {
    assert.equal(extractPoolAddressFromReasonKey(""), null);
  });

  it("handles lowercase addresses", () => {
    const result = extractPoolAddressFromReasonKey("ERC20_0xabcdef1234567890abcdef1234567890abcdef12");
    assert.equal(result, "0xabcdef1234567890abcdef1234567890abcdef12");
  });
});

// =============================================================================
// parseWei
// =============================================================================

describe("parseWei", () => {
  it("converts 18-decimal wei string to human number", () => {
    const result = parseWei("15883841175689438027536", 18);
    assert.ok(Math.abs(result - 15883.84) < 0.01, `Expected ~15883.84, got ${result}`);
  });

  it("returns 0 for '0'", () => {
    assert.equal(parseWei("0", 18), 0);
  });

  it("returns 0 for null", () => {
    assert.equal(parseWei(null, 18), 0);
  });

  it("returns 0 for undefined", () => {
    assert.equal(parseWei(undefined, 18), 0);
  });

  it("returns 0 for invalid string", () => {
    assert.equal(parseWei("not_a_number", 18), 0);
  });

  it("handles 6-decimal tokens (e.g., USDC)", () => {
    const result = parseWei("1000000", 6);
    assert.equal(result, 1);
  });

  it("handles 0-decimal tokens", () => {
    const result = parseWei("42", 0);
    assert.equal(result, 42);
  });

  it("handles large numbers", () => {
    // 1 million tokens with 18 decimals
    const result = parseWei("1000000000000000000000000", 18);
    assert.equal(result, 1000000);
  });
});

// =============================================================================
// parseMerklRewards
// =============================================================================

describe("parseMerklRewards", () => {
  const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const TOKEN_SPECTRA = "0x6a89228055c7c28430692e342f149f37462b478b";

  it("matches rewards to known pool addresses", () => {
    const raw = {
      [TOKEN_SPECTRA]: {
        symbol: "SPECTRA",
        decimals: 18,
        accumulated: "1000000000000000000000",
        unclaimed: "500000000000000000000",
        pending: "100000000000000000000",
        reasons: {
          [`ERC20_${POOL_A}`]: {
            accumulated: "1000000000000000000000",
            unclaimed: "500000000000000000000",
            pending: "100000000000000000000",
          },
        },
      },
    };
    const known = new Set([POOL_A]);
    const result = parseMerklRewards(raw, known, "mainnet");

    assert.equal(result.chain, "mainnet");
    assert.equal(result.matched.size, 1);
    assert.ok(result.matched.has(POOL_A));
    const rewards = result.matched.get(POOL_A)!;
    assert.equal(rewards.length, 1);
    assert.equal(rewards[0].symbol, "SPECTRA");
    assert.ok(Math.abs(rewards[0].accumulated - 1000) < 0.01);
    assert.ok(Math.abs(rewards[0].unclaimed - 500) < 0.01);
    assert.equal(result.unmatched.length, 0);
  });

  it("puts unknown pools in unmatched", () => {
    const raw = {
      [TOKEN_SPECTRA]: {
        symbol: "SPECTRA",
        decimals: 18,
        accumulated: "1000000000000000000000",
        unclaimed: "500000000000000000000",
        pending: "0",
        reasons: {
          [`ERC20_${POOL_B}`]: {
            accumulated: "1000000000000000000000",
            unclaimed: "500000000000000000000",
            pending: "0",
          },
        },
      },
    };
    const known = new Set([POOL_A]);
    const result = parseMerklRewards(raw, known, "mainnet");

    assert.equal(result.matched.size, 0);
    assert.equal(result.unmatched.length, 1);
    assert.equal(result.unmatched[0].symbol, "SPECTRA");
  });

  it("returns empty for empty response", () => {
    const result = parseMerklRewards({}, new Set([POOL_A]), "mainnet");
    assert.equal(result.matched.size, 0);
    assert.equal(result.unmatched.length, 0);
  });

  it("filters out zero-value entries", () => {
    const raw = {
      [TOKEN_SPECTRA]: {
        symbol: "SPECTRA",
        decimals: 18,
        accumulated: "0",
        unclaimed: "0",
        pending: "0",
        reasons: {
          [`ERC20_${POOL_A}`]: {
            accumulated: "0",
            unclaimed: "0",
            pending: "0",
          },
        },
      },
    };
    const result = parseMerklRewards(raw, new Set([POOL_A]), "mainnet");
    assert.equal(result.matched.size, 0);
  });

  it("collects multiple tokens for same pool", () => {
    const TOKEN_ARB = "0xcccccccccccccccccccccccccccccccccccccccc";
    const raw = {
      [TOKEN_SPECTRA]: {
        symbol: "SPECTRA",
        decimals: 18,
        accumulated: "1000000000000000000000",
        unclaimed: "1000000000000000000000",
        pending: "0",
        reasons: {
          [`ERC20_${POOL_A}`]: {
            accumulated: "1000000000000000000000",
            unclaimed: "1000000000000000000000",
            pending: "0",
          },
        },
      },
      [TOKEN_ARB]: {
        symbol: "ARB",
        decimals: 18,
        accumulated: "500000000000000000000",
        unclaimed: "500000000000000000000",
        pending: "0",
        reasons: {
          [`ERC20_${POOL_A}`]: {
            accumulated: "500000000000000000000",
            unclaimed: "500000000000000000000",
            pending: "0",
          },
        },
      },
    };
    const result = parseMerklRewards(raw, new Set([POOL_A]), "mainnet");
    const rewards = result.matched.get(POOL_A)!;
    assert.equal(rewards.length, 2);
    const symbols = rewards.map(r => r.symbol).sort();
    assert.deepEqual(symbols, ["ARB", "SPECTRA"]);
  });

  it("aggregates amounts from multiple reasons to same pool", () => {
    const raw = {
      [TOKEN_SPECTRA]: {
        symbol: "SPECTRA",
        decimals: 18,
        accumulated: "2000000000000000000000",
        unclaimed: "2000000000000000000000",
        pending: "0",
        reasons: {
          [`ERC20_${POOL_A}`]: {
            accumulated: "1000000000000000000000",
            unclaimed: "1000000000000000000000",
            pending: "0",
          },
          [`Gauge_${POOL_A}`]: {
            accumulated: "1000000000000000000000",
            unclaimed: "1000000000000000000000",
            pending: "0",
          },
        },
      },
    };
    const result = parseMerklRewards(raw, new Set([POOL_A]), "mainnet");
    const rewards = result.matched.get(POOL_A)!;
    assert.equal(rewards.length, 1);
    assert.ok(Math.abs(rewards[0].accumulated - 2000) < 0.01);
  });
});
