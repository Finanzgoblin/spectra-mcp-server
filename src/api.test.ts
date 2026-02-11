/**
 * Unit tests for api.ts — sanitization and non-network helpers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeGraphQL, MORPHO_MARKET_FIELDS } from "./api.js";

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
