/**
 * Schema tests for `/v1/{chain}/pt/{address}`.
 *
 * Run against captured live fixtures under `test/fixtures/pt-*.json`.
 * These are the TRUTH set — any live PT that parses today must continue
 * to parse after future schema edits. Recapture with:
 *
 *   curl -sSf https://app.spectra.finance/api/v1/avalanche/pt/0xb66a5502ab560a672aa2f1d38dad5670200d14c8 > test/fixtures/pt-avalanche-sw-avUSDx.json
 *   curl -sSf https://app.spectra.finance/api/v1/katana/pt/0x1cd92bd766466972d393e0f751b29a005ed13e97   > test/fixtures/pt-katana-sw-syUSD.json
 *   curl -sSf https://app.spectra.finance/api/v1/flare/pt/0x04304b039ae6c02acd9830e1bb0e8f529cb9a2a6    > test/fixtures/pt-flare-stXRP.json
 *
 * A failure here is the canary: the live API shape changed in a way the
 * schema doesn't allow yet. Fix the schema, don't loosen the tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PtSchema, PtResponseSchema } from "./spectra.js";
import { extractPtFromResponse } from "../api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../test/fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, `${name}.json`), "utf8"));
}

const FIXTURES = [
  "pt-avalanche-sw-avUSDx",
  "pt-katana-sw-syUSD",
  "pt-flare-stXRP",
] as const;

describe("PtResponseSchema against live fixtures", () => {
  for (const name of FIXTURES) {
    it(`parses ${name}`, () => {
      const raw = loadFixture(name);
      const result = PtResponseSchema.safeParse(raw);
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

describe("PtSchema against unwrapped fixtures", () => {
  for (const name of FIXTURES) {
    it(`parses inner PT from ${name}`, () => {
      const raw = loadFixture(name) as { data: unknown };
      const pt = Array.isArray(raw.data) ? raw.data[0] : raw.data;
      assert.ok(pt, `${name} must have inner PT`);
      const result = PtSchema.safeParse(pt);
      if (!result.success) {
        const issues = result.error.issues
          .slice(0, 5)
          .map((iss) => `  ${iss.path.join(".")}: ${iss.message}`)
          .join("\n");
        assert.fail(`${name} inner PT failed validation:\n${issues}`);
      }
    });
  }
});

describe("PtResponseSchema shape guarantees", () => {
  it("accepts the empty-data response (PT not found on this chain)", () => {
    // Real shape returned when the PT address doesn't exist on the queried chain.
    // Observed calling /base/pt/<avalanche-PT-address> during audit.
    const result = PtResponseSchema.safeParse({ data: [] });
    assert.equal(result.success, true, "empty data array must parse");
  });

  it("accepts absent data field", () => {
    const result = PtResponseSchema.safeParse({});
    assert.equal(result.success, true, "missing data field must parse");
  });

  it("accepts a single-object data shape (legacy)", () => {
    const raw = loadFixture("pt-avalanche-sw-avUSDx") as { data: unknown[] };
    const pt = raw.data[0];
    const result = PtResponseSchema.safeParse({ data: pt });
    assert.equal(result.success, true, "single-object data must parse");
  });

  it("accepts unknown top-level fields (passthrough)", () => {
    const raw = JSON.parse(
      JSON.stringify(loadFixture("pt-avalanche-sw-avUSDx")),
    );
    raw.someFieldSpectraAddsNextWeek = { any: "shape" };
    const result = PtResponseSchema.safeParse(raw);
    assert.equal(result.success, true, "passthrough must allow unknown fields");
  });

  it("rejects when identity field `address` is missing from inner PT", () => {
    const raw = loadFixture("pt-avalanche-sw-avUSDx") as { data: any[] };
    const pt: any = JSON.parse(JSON.stringify(raw.data[0]));
    delete pt.address;
    const result = PtSchema.safeParse(pt);
    assert.equal(result.success, false, "missing address must fail validation");
  });

  it("accepts null for nullable APY fields (same class as Base/Flare bug)", () => {
    const raw = loadFixture("pt-avalanche-sw-avUSDx") as { data: any[] };
    const pt: any = JSON.parse(JSON.stringify(raw.data[0]));
    if (pt.ibt?.apr) pt.ibt.apr.total = null;
    if (pt.ibt?.apr?.details) pt.ibt.apr.details.base = null;
    const result = PtSchema.safeParse(pt);
    assert.equal(result.success, true, "nullable numeric fields must accept null");
  });
});

describe("extractPtFromResponse unwrap logic", () => {
  // Separated from schema parsing so the fetcher's wrap/unwrap step gets
  // independent coverage — schema tests prove the shape parses; these prove
  // the extraction picks the right element.

  it("extracts the first element from a wrapped array", () => {
    const raw = loadFixture("pt-avalanche-sw-avUSDx") as { data: any[] };
    const pt = extractPtFromResponse(raw);
    assert.ok(pt, "expected a PT");
    assert.equal(pt!.address, raw.data[0].address);
    assert.equal(pt!.maturity, raw.data[0].maturity);
  });

  it("extracts from a single-object data shape (legacy)", () => {
    const raw = loadFixture("pt-avalanche-sw-avUSDx") as { data: any[] };
    const wrapped: any = { data: raw.data[0] };
    const pt = extractPtFromResponse(wrapped);
    assert.ok(pt, "expected a PT");
    assert.equal(pt!.address, raw.data[0].address);
  });

  it("returns undefined for an empty data array (PT not on this chain)", () => {
    assert.equal(extractPtFromResponse({ data: [] }), undefined);
  });

  it("returns undefined when data field is absent", () => {
    assert.equal(extractPtFromResponse({}), undefined);
  });

  it("returns undefined when wrapper itself is null/undefined", () => {
    assert.equal(extractPtFromResponse(null), undefined);
    assert.equal(extractPtFromResponse(undefined), undefined);
  });

  it("returns the first of a multi-element array (defensive — API currently always returns ≤1)", () => {
    const raw = loadFixture("pt-avalanche-sw-avUSDx") as { data: any[] };
    const first = raw.data[0];
    const second = { ...first, address: "0xdead" };
    const pt = extractPtFromResponse({ data: [first, second] } as any);
    assert.equal(pt?.address, first.address, "must pick the first element, not the last");
  });
});
