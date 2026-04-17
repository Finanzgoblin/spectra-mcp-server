/**
 * Schema tests for `/v1/{chain}/pools` and `/v1/{chain}/portfolio/{address}`.
 *
 * Both endpoints return bare arrays of PT objects (same element shape as
 * the /pt endpoint's inner payload, so the schema reuses PtSchema).
 *
 * Recapture fixtures with:
 *   curl -sSf https://app.spectra.finance/api/v1/base/pools       > test/fixtures/pools-base.json
 *   curl -sSf https://app.spectra.finance/api/v1/avalanche/pools  > test/fixtures/pools-avalanche.json
 *   curl -sSf https://app.spectra.finance/api/v1/katana/pools     > test/fixtures/pools-katana.json
 *   curl -sSf https://app.spectra.finance/api/v1/base/portfolio/0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a    > test/fixtures/portfolio-base-gamimv.json
 *   curl -sSf https://app.spectra.finance/api/v1/katana/portfolio/0xc2dec6328d9ef1ef2ee85901f9c1a8db8dd1c9c1  > test/fixtures/portfolio-katana-clearstarmv.json
 *   curl -sSf https://app.spectra.finance/api/v1/flare/portfolio/0x0c4f32c53d4b91a019c7c9d8da14af140295eef6   > test/fixtures/portfolio-flare-gamixrpmv.json
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  PoolsResponseSchema,
  PortfolioResponseSchema,
  PtSchema,
} from "./spectra.js";
import { isEmptyPortfolioError } from "../api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../test/fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, `${name}.json`), "utf8"));
}

const POOLS_FIXTURES = [
  "pools-base",
  "pools-avalanche",
  "pools-katana",
] as const;

const PORTFOLIO_FIXTURES = [
  "portfolio-base-gamimv",
  "portfolio-katana-clearstarmv",
  "portfolio-flare-gamixrpmv",
] as const;

describe("PoolsResponseSchema against live fixtures", () => {
  for (const name of POOLS_FIXTURES) {
    it(`parses every element of ${name}`, () => {
      const raw = loadFixture(name);
      assert.ok(Array.isArray(raw), `${name} must be an array`);
      const result = PoolsResponseSchema.safeParse(raw);
      if (!result.success) {
        const issues = result.error.issues
          .slice(0, 5)
          .map((iss) => `  ${iss.path.join(".")}: ${iss.message}`)
          .join("\n");
        assert.fail(`${name} failed validation:\n${issues}`);
      }
      // Sanity: every element has identity fields
      for (let i = 0; i < (raw as unknown[]).length; i++) {
        const single = PtSchema.safeParse((raw as unknown[])[i]);
        assert.equal(single.success, true, `${name}[${i}] must parse individually`);
      }
    });
  }
});

describe("PortfolioResponseSchema against live fixtures", () => {
  for (const name of PORTFOLIO_FIXTURES) {
    it(`parses every element of ${name}`, () => {
      const raw = loadFixture(name);
      assert.ok(Array.isArray(raw), `${name} must be an array`);
      const result = PortfolioResponseSchema.safeParse(raw);
      if (!result.success) {
        const issues = result.error.issues
          .slice(0, 5)
          .map((iss) => `  ${iss.path.join(".")}: ${iss.message}`)
          .join("\n");
        assert.fail(`${name} failed validation:\n${issues}`);
      }
    });
  }
});

describe("Pools/Portfolio schema shape guarantees", () => {
  it("accepts empty arrays (valid for freshly-launched chains)", () => {
    assert.equal(PoolsResponseSchema.safeParse([]).success, true);
    assert.equal(PortfolioResponseSchema.safeParse([]).success, true);
  });

  it("rejects non-array top level", () => {
    assert.equal(PoolsResponseSchema.safeParse({ data: [] }).success, false);
    assert.equal(PortfolioResponseSchema.safeParse(null).success, false);
  });

  it("drops no information — every element of pools-base parses with identity fields intact", () => {
    const raw = loadFixture("pools-base") as any[];
    for (const pt of raw) {
      const parsed = PtSchema.safeParse(pt);
      assert.equal(parsed.success, true);
      if (parsed.success) {
        assert.equal(parsed.data.address, pt.address, "address preserved");
        assert.equal(parsed.data.maturity, pt.maturity, "maturity preserved");
      }
    }
  });

  it("accepts portfolio entries with populated `balance` field (user holdings)", () => {
    const raw = loadFixture("portfolio-katana-clearstarmv") as any[];
    const withBalance = raw.filter((pt) => pt.balance !== undefined);
    assert.ok(withBalance.length > 0, "expected at least one position with balance");
    for (const pt of withBalance) {
      const result = PtSchema.safeParse(pt);
      assert.equal(result.success, true, "position with balance must parse");
    }
  });

  it("accepts unknown top-level fields on elements (passthrough)", () => {
    const raw = JSON.parse(JSON.stringify(loadFixture("pools-base"))) as any[];
    raw[0].someFieldSpectraAddsNextWeek = { any: "shape" };
    const result = PoolsResponseSchema.safeParse(raw);
    assert.equal(result.success, true, "passthrough must allow unknown fields");
  });
});

describe("isEmptyPortfolioError — portfolio no-positions 500 detection", () => {
  it("matches an Error whose message contains 500", () => {
    assert.equal(
      isEmptyPortfolioError(new Error("Spectra API error: 500 Internal Server Error")),
      true,
    );
  });

  it("matches the specific portfolioWithoutIbt form (commit 5fae77a)", () => {
    assert.equal(
      isEmptyPortfolioError(new Error("500 — portfolioWithoutIbt is undefined")),
      true,
    );
  });

  it("does NOT match 4xx errors", () => {
    assert.equal(isEmptyPortfolioError(new Error("404 Not Found")), false);
    assert.equal(isEmptyPortfolioError(new Error("429 Too Many Requests")), false);
  });

  it("does NOT match generic network errors (fetch failed, timeout)", () => {
    assert.equal(isEmptyPortfolioError(new Error("fetch failed")), false);
    assert.equal(isEmptyPortfolioError(new TypeError("Load failed")), false);
  });

  it("returns false for null / undefined / non-Error values", () => {
    assert.equal(isEmptyPortfolioError(null), false);
    assert.equal(isEmptyPortfolioError(undefined), false);
    assert.equal(isEmptyPortfolioError("500 as a string"), false); // not an Error shape
    assert.equal(isEmptyPortfolioError({ message: 42 }), false);   // message must be string
    assert.equal(isEmptyPortfolioError({}), false);
  });

  it("matches errors with 500 anywhere in the message (defensive)", () => {
    assert.equal(isEmptyPortfolioError(new Error("HTTP 500")), true);
    assert.equal(isEmptyPortfolioError(new Error("request returned status 500 unexpectedly")), true);
  });
});
