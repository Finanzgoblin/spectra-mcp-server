/**
 * Schema tests for `/v1/{chain}/metavaults`.
 *
 * Run against captured live fixtures under `test/fixtures/metavaults-*.json`.
 * These fixtures are the TRUTH set — any live MetaVault that parses today
 * must continue to parse after future schema edits. If Spectra's API shape
 * drifts, re-capture with:
 *   curl -s https://api.spectra.finance/v1/base/metavaults   > test/fixtures/metavaults-base.json
 *   curl -s https://api.spectra.finance/v1/flare/metavaults  > test/fixtures/metavaults-flare.json
 *   curl -s https://api.spectra.finance/v1/katana/metavaults > test/fixtures/metavaults-katana.json
 *
 * A test failure here is the canary: something in the live API changed shape
 * in a way the schema doesn't allow yet. Fix the schema, don't loosen the tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MetavaultSchema, MetavaultsArraySchema } from "./spectra.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Tests run from build/schemas/ — fixtures live at repo-root/test/fixtures/
const fixturesDir = resolve(__dirname, "../../test/fixtures");

function loadFixture(chain: string): unknown[] {
  const path = resolve(fixturesDir, `metavaults-${chain}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("MetavaultSchema against live fixtures", () => {
  for (const chain of ["base", "flare", "katana"]) {
    it(`parses every MetaVault on ${chain}`, () => {
      const raw = loadFixture(chain);
      assert.ok(Array.isArray(raw), `${chain} fixture must be an array`);
      for (let i = 0; i < raw.length; i++) {
        const result = MetavaultSchema.safeParse(raw[i]);
        if (!result.success) {
          const issues = result.error.issues
            .slice(0, 5)
            .map((iss) => `  ${iss.path.join(".")}: ${iss.message}`)
            .join("\n");
          assert.fail(
            `${chain}[${i}] (${(raw[i] as any)?.name || "?"}) failed validation:\n${issues}`,
          );
        }
      }
    });
  }

  it("array schema parses the full base fixture", () => {
    const raw = loadFixture("base");
    const result = MetavaultsArraySchema.safeParse(raw);
    assert.ok(result.success, "full array should parse");
  });
});

describe("MetavaultSchema shape guarantees", () => {
  it("rejects when identity field `address` is missing", () => {
    const mv: any = loadFixture("base")[0];
    delete mv.address;
    const result = MetavaultSchema.safeParse(mv);
    assert.equal(result.success, false, "missing address must fail validation");
  });

  it("accepts unknown top-level fields (passthrough)", () => {
    // Simulate Spectra adding a new field tomorrow — the schema must not break.
    const mv: any = JSON.parse(JSON.stringify(loadFixture("base")[0]));
    mv.someFieldSpectraAddsNextWeek = { any: "shape" };
    const result = MetavaultSchema.safeParse(mv);
    assert.equal(result.success, true, "passthrough must allow unknown fields");
  });

  it("accepts null for nullable numeric fields", () => {
    // This is the exact drift that shipped the April 2026 Base/Flare bug:
    // a numeric APY total could be null. Schema must tolerate it.
    const mv: any = JSON.parse(JSON.stringify(loadFixture("base")[0]));
    if (mv.liveApy) mv.liveApy.total = null;
    if (mv.liveApy?.details) mv.liveApy.details.base = null;
    const result = MetavaultSchema.safeParse(mv);
    assert.equal(result.success, true, "nullable numeric fields must accept null");
  });

  it("accepts positions with missing yt.yield.claimable (original bug shape)", () => {
    const mv: any = JSON.parse(JSON.stringify(loadFixture("base")[0]));
    // Find a position with yt.yield and delete claimable — recreates the Base
    // Gami USDC pos[2] shape that crashed BigInt() before the fix.
    for (const p of mv.positions || []) {
      if (p.yt?.yield) {
        delete p.yt.yield.claimable;
        break;
      }
    }
    const result = MetavaultSchema.safeParse(mv);
    assert.equal(result.success, true, "missing claimable must not fail validation");
  });
});
