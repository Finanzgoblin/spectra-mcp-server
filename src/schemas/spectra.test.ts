/**
 * Schema tests for `/v1/{chain}/metavaults`.
 *
 * Run against captured live fixtures under `test/fixtures/metavaults-*.json`.
 * These fixtures are the TRUTH set — any live MetaVault that parses today
 * must continue to parse after future schema edits. If Spectra's API shape
 * drifts, re-capture with:
 *   curl -s https://api.spectra.finance/v1/base/metavaults    > test/fixtures/metavaults-base.json
 *   curl -s https://api.spectra.finance/v1/mainnet/metavaults > test/fixtures/metavaults-mainnet.json
 *   curl -s https://api.spectra.finance/v1/flare/metavaults   > test/fixtures/metavaults-flare.json
 *   curl -s https://api.spectra.finance/v1/katana/metavaults  > test/fixtures/metavaults-katana.json
 *
 * A test failure here is the canary: something in the live API changed shape
 * in a way the schema doesn't allow yet. Fix the schema, don't loosen the tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MetavaultSchema, MetavaultsArraySchema, ExternalPositionSchema } from "./spectra.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Tests run from build/schemas/ — fixtures live at repo-root/test/fixtures/
const fixturesDir = resolve(__dirname, "../../test/fixtures");

function loadFixture(chain: string): unknown[] {
  const path = resolve(fixturesDir, `metavaults-${chain}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("MetavaultSchema against live fixtures", () => {
  for (const chain of ["base", "mainnet", "flare", "katana"]) {
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

describe("ExternalPositionSchema — permissive shape (Phase 5 collapse)", () => {
  // Phase 5 (spec §9): schema is a single permissive shape with a four-field
  // typed spine (protocol, chainId, valueUsd, updatedAt) + .passthrough().
  // All protocol-specific fields (avant burnt/claim/orderId, pendle market/lp,
  // any future module) ride through untouched. A fifth typed field would mean
  // protocol logic has colonized the schema — spec §10 says stop and revert.

  it("parses every externalPosition across all chain fixtures", () => {
    for (const chain of ["base", "mainnet", "flare", "katana"]) {
      const raw = loadFixture(chain) as any[];
      for (let i = 0; i < raw.length; i++) {
        const mv = raw[i];
        const ext = mv.externalPositions;
        if (!Array.isArray(ext)) continue;
        for (let j = 0; j < ext.length; j++) {
          const result = ExternalPositionSchema.safeParse(ext[j]);
          if (!result.success) {
            const issues = result.error.issues
              .slice(0, 3)
              .map((iss) => `  ${iss.path.join(".")}: ${iss.message}`)
              .join("\n");
            assert.fail(
              `${chain}[${i}].externalPositions[${j}] (protocol=${ext[j]?.protocol}) failed:\n${issues}`,
            );
          }
        }
      }
    }
  });

  it("accepts a brand-new protocol (morpho-fixed) with zero schema edits", () => {
    // Phase 5 acceptance: a future whitelisted ERC-4626 module (morpho-fixed,
    // midas, aave, euler) must round-trip without a schema edit. This is PR1
    // — zero-code protocol addition, registry-only via metadata.ts.
    const morphoFixed = {
      protocol: "morpho-fixed",      // new protocol, never literal'd in schema
      chainId: 1,
      valueUsd: 250_000,
      updatedAt: 1714000000,
      market: { address: "0xabc", id: "0xmarketkey" },
      collateral: { address: "0xdef", symbol: "wstETH" },
      healthFactor: 2.1,
      anyFieldSpectraAddsNextWeek: { any: "shape" },
    };
    const result = ExternalPositionSchema.safeParse(morphoFixed);
    assert.equal(result.success, true, "brand-new protocol must parse without schema edit");
    if (result.success) {
      // Passthrough preserves the shape end-to-end.
      assert.equal((result.data as any).protocol, "morpho-fixed");
      assert.equal((result.data as any).market.id, "0xmarketkey");
      assert.equal((result.data as any).healthFactor, 2.1);
    }
  });

  it("accepts an arbitrary protocol string with only spine fields", () => {
    // Minimal shape: just the spine, nothing else. Schema must not demand
    // anything beyond `protocol`.
    const minimal = { protocol: "some-future-module" };
    const result = ExternalPositionSchema.safeParse(minimal);
    assert.equal(result.success, true, "minimal spine-only entry must parse");
  });

  it("rejects when spine field `protocol` is missing", () => {
    // The one structural guarantee: every entry must declare its protocol name.
    // Without it the registry cannot dispatch, and the engine renders blindly.
    const noProtocol = { chainId: 1, valueUsd: 100 };
    const result = ExternalPositionSchema.safeParse(noProtocol);
    assert.equal(result.success, false, "missing protocol must fail validation");
  });

  it("preserves avant passthrough fields (orderId, burnt, claim, source)", () => {
    const raw = loadFixture("base") as any[];
    // Gami USDC is the one with avant burn entries as of 2026-04-22
    const gami = raw.find((m) => m?.name === "Gami USDC");
    const avant = gami?.externalPositions?.find((e: any) => e?.protocol === "avant");
    assert.ok(avant, "Base Gami USDC must have at least one avant externalPosition");
    const result = ExternalPositionSchema.safeParse(avant);
    assert.equal(result.success, true);
    if (result.success) {
      const data = result.data as any;
      // Spine typed
      assert.equal(data.protocol, "avant");
      assert.ok(typeof data.valueUsd === "number");
      // Protocol-specific fields ride through .passthrough() — not stripped.
      assert.ok("source" in data || "orderId" in data || "burnt" in data,
        "avant-specific fields must survive passthrough");
    }
  });

  it("preserves pendle passthrough fields (market, lp, pt, yt)", () => {
    const raw = loadFixture("mainnet") as any[];
    const pendle = raw
      .flatMap((m) => m?.externalPositions || [])
      .find((e: any) => e?.protocol === "pendle");
    // Mainnet may or may not have a pendle entry at any given moment — skip
    // gracefully if absent so the test is resilient to live state change.
    if (!pendle) return;
    const result = ExternalPositionSchema.safeParse(pendle);
    assert.equal(result.success, true);
    if (result.success) {
      const data = result.data as any;
      assert.equal(data.protocol, "pendle");
      // Protocol-specific nested shape survives untouched (no zod narrowing).
      assert.ok(data.market, "pendle passthrough must carry market object");
    }
  });
});

describe("MetavaultSchema — extended field shapes", () => {
  it("accepts status=HIDDEN as optional string", () => {
    const mv: any = JSON.parse(JSON.stringify(loadFixture("base")[0]));
    mv.status = "HIDDEN";
    assert.equal(MetavaultSchema.safeParse(mv).success, true);
    mv.status = "VISIBLE";
    assert.equal(MetavaultSchema.safeParse(mv).success, true);
    delete mv.status;
    assert.equal(MetavaultSchema.safeParse(mv).success, true);
  });

  it("rejects non-boolean module flag in top-level modules map", () => {
    const mv: any = JSON.parse(JSON.stringify(loadFixture("base")[0]));
    mv.modules = { avant: true, parallel: "yes" };  // non-boolean value
    const result = MetavaultSchema.safeParse(mv);
    assert.equal(result.success, false, "modules must be Record<string, boolean>");
  });

  it("accepts remote entries with nested modules as booleans", () => {
    const mv: any = JSON.parse(JSON.stringify(loadFixture("base")[0]));
    mv.remote = {
      "43114": {
        address: "0xabc0000000000000000000000000000000000000",
        modifier: { roles: {}, delay: {} },
        modules: { avant: true, parallel: false },
      },
    };
    assert.equal(MetavaultSchema.safeParse(mv).success, true);
  });

  it("rejects a remote entry with scalar value", () => {
    const mv: any = JSON.parse(JSON.stringify(loadFixture("base")[0]));
    mv.remote = { "43114": "not an object" };
    const result = MetavaultSchema.safeParse(mv);
    assert.equal(result.success, false, "remote entries must be objects");
  });

  it("accepts avgApy30d with null base detail (observed shape)", () => {
    const mv: any = JSON.parse(JSON.stringify(loadFixture("base")[0]));
    mv.avgApy30d = { total: 0, details: { base: null } };
    assert.equal(MetavaultSchema.safeParse(mv).success, true);
  });
});
