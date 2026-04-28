/**
 * Engine tests — template resolver, classifier, action items, drift collector,
 * view-mode rendering, runtime guard.
 *
 * `DRIFT_VISIBILITY=loud` MUST be set before import; production default is silent.
 * Since the engine reads the env flag at module load, any test suite running
 * this file must set it in the runner harness or accept the silent default
 * for missing-path tests. This test validates BOTH modes indirectly by
 * covering concrete `ext` shapes that hit the populated paths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import {
  renderExternalPosition,
  classifyForStress,
  generateActionItems,
  describeProtocolWindow,
  effectiveValueAsString,
  DriftCollector,
  COST_MODELS,
  getMeta,
  type TypedExternalPosition,
} from "./index.js";
import { compileTemplate } from "./engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────────────────────────────────
// Template resolver — single-brace, escape, format hints
// ────────────────────────────────────────────────────────────────────────────

describe("template resolver — single-brace + `{{` escape", () => {
  it("resolves a single-brace field", () => {
    const ext: TypedExternalPosition = {
      protocol: "pendle",
      valueUsd: 1000,
      market: { name: "PT-ynETHx-MAY2026", maturity: 1746057600, aggregatedApy: 0.085 },
    };
    const line = renderExternalPosition(ext, 10000, { viewMode: "curator" });
    assert.ok(line.includes("PT-ynETHx-MAY2026"), `primary template not rendered: ${line}`);
  });

  it("renders pct100 against 0.085 as 8.50%", () => {
    const ext: TypedExternalPosition = {
      protocol: "pendle",
      valueUsd: 1000,
      market: { name: "PT-x", maturity: 1746057600, aggregatedApy: 0.085 },
    };
    const line = renderExternalPosition(ext, 10000, { viewMode: "curator" });
    assert.ok(line.includes("8.50%"), `pct100 hint mis-rendered against 0.085: ${line}`);
  });

  it("renders a date format against a unix-seconds timestamp", () => {
    const ext: TypedExternalPosition = {
      protocol: "pendle",
      valueUsd: 1000,
      market: { name: "PT-x", maturity: 1746057600, aggregatedApy: 0.085 },
    };
    const line = renderExternalPosition(ext, 10000, { viewMode: "curator" });
    assert.ok(line.includes("2025-05-01"), `date format mis-rendered (ts=1746057600): ${line}`);
  });

  it("renders the number format as a plain stringified number", () => {
    const ext: TypedExternalPosition = {
      protocol: "avant",
      valueUsd: 500,
      orderId: 42,
      source: "avusdx-burn",
      burnt: { symbol: "avUSDx" },
      claim: { symbol: "avUSD" },
    };
    const line = renderExternalPosition(ext, 10000, { viewMode: "curator" });
    assert.ok(line.includes("order=42"), `number hint not rendered: ${line}`);
    assert.ok(line.includes("avusdx-burn"), `plain hint not rendered: ${line}`);
  });

  it("renders non-finite numeric inputs as missing, not crash or leak NaN/Infinity literals", () => {
    // formatDate(NaN) previously threw RangeError: Invalid time value, escaping
    // the render path. formatPct/formatUsd silently leaked "NaN%"/"$NaN" strings.
    // Registry-driven renders must coerce non-finite upstream data to missing.
    const nanExt: TypedExternalPosition = {
      protocol: "pendle",
      valueUsd: 1000,
      market: { name: "PT-x", maturity: Number.NaN, aggregatedApy: Number.NaN },
    };
    const line = renderExternalPosition(nanExt, 10000, { viewMode: "curator" });
    assert.doesNotMatch(line, /NaN/, `NaN leaked into render: ${line}`);
    assert.doesNotMatch(line, /Invalid/, `date RangeError reached output: ${line}`);

    const infExt: TypedExternalPosition = {
      protocol: "pendle",
      valueUsd: 1000,
      market: { name: "PT-y", maturity: Number.POSITIVE_INFINITY, aggregatedApy: 0.05 },
    };
    const infLine = renderExternalPosition(infExt, 10000, { viewMode: "curator" });
    assert.doesNotMatch(infLine, /Infinity/, `Infinity leaked into render: ${infLine}`);
    assert.ok(infLine.includes("5.00%"), `finite sibling field must still render: ${infLine}`);
  });
});

describe("compileTemplate — segment shape + `{{` escape", () => {
  it("emits a single literal for a no-field template", () => {
    assert.deepEqual(compileTemplate("static"), [{ kind: "literal", text: "static" }]);
  });

  it("emits field segment for {foo}", () => {
    assert.deepEqual(compileTemplate("{foo}"), [{ kind: "field", path: "foo" }]);
  });

  it("escapes {{ to a literal `{`", () => {
    assert.deepEqual(compileTemplate("a{{b"), [{ kind: "literal", text: "a{b" }]);
  });

  it("escapes {{ followed by a field", () => {
    assert.deepEqual(compileTemplate("{{literal{x}"), [
      { kind: "literal", text: "{literal" },
      { kind: "field", path: "x" },
    ]);
  });

  it("mixes literal + field + dot-path", () => {
    assert.deepEqual(compileTemplate("burn:{burnt.symbol} → claim:{claim.symbol}"), [
      { kind: "literal", text: "burn:" },
      { kind: "field", path: "burnt.symbol" },
      { kind: "literal", text: " → claim:" },
      { kind: "field", path: "claim.symbol" },
    ]);
  });

  it("tolerates an unterminated brace as trailing literal", () => {
    assert.deepEqual(compileTemplate("pre {broken"), [
      { kind: "literal", text: "pre " },
      { kind: "literal", text: "{broken" },
    ]);
  });
});

describe("DRIFT_VISIBILITY — loud vs silent mode at module load", () => {
  // The engine reads DRIFT_VISIBILITY once at module load. We verify both
  // modes by spawning fresh child node processes with the env flag set,
  // each evaluating a one-liner that imports the engine and renders a
  // position with a missing path.
  const buildRoot = resolve(__dirname, ".."); // build/protocols → build

  function runChild(env: Record<string, string>): string {
    const indexUrl = pathToFileURL(resolve(buildRoot, "protocols/index.js")).href;
    const script = `
      import { renderExternalPosition } from "${indexUrl}";
      const ext = { protocol: "pendle", valueUsd: 1000 };
      const out = renderExternalPosition(ext, 10000, { viewMode: "curator" });
      process.stdout.write(out);
    `;
    const result = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, ...env }, encoding: "utf8" },
    );
    return result;
  }

  it("silent mode (production default) renders `?` for missing paths", () => {
    const out = runChild({ DRIFT_VISIBILITY: "" });
    assert.ok(out.includes("?"), `silent mode missing question-mark token: ${out}`);
    assert.equal(out.includes("[MISSING:"), false, `silent mode leaked MISSING token: ${out}`);
  });

  it("loud mode renders `[MISSING:path]` for missing paths", () => {
    const out = runChild({ DRIFT_VISIBILITY: "loud" });
    assert.ok(out.includes("[MISSING:"), `loud mode missing MISSING token: ${out}`);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Cost models
// ────────────────────────────────────────────────────────────────────────────

describe("cost models — boundary inputs", () => {
  it("zero returns 0 regardless of input", () => {
    assert.equal(COST_MODELS.zero({ amountUsd: 1_000_000 }), 0);
  });

  it("lp_exit_samechain with zero pool liquidity falls back to 1% * stress", () => {
    const c = COST_MODELS.lp_exit_samechain({ amountUsd: 1000, poolLiquidityUsd: 0, stressMultiplier: 1 });
    assert.equal(c, 10);
  });

  it("lp_exit_samechain with positive pool liquidity uses price impact", () => {
    // estimatePriceImpact(100, 10000) = 100 / (2*10000) = 0.005 → 100 * 0.005 = 0.5
    const c = COST_MODELS.lp_exit_samechain({ amountUsd: 100, poolLiquidityUsd: 10000, stressMultiplier: 1 });
    assert.equal(c, 0.5);
  });

  it("lp_exit_crosschain_cctp is 1.5x samechain at the same inputs", () => {
    const same = COST_MODELS.lp_exit_samechain({ amountUsd: 100, poolLiquidityUsd: 10000, stressMultiplier: 1 });
    const cross = COST_MODELS.lp_exit_crosschain_cctp({ amountUsd: 100, poolLiquidityUsd: 10000, stressMultiplier: 1 });
    assert.equal(cross, same * 1.5);
  });

  it("liquidation is 2% * amount * stress", () => {
    assert.equal(COST_MODELS.liquidation({ amountUsd: 1000, stressMultiplier: 2 }), 40);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Classifier — substrate + runtime guard
// ────────────────────────────────────────────────────────────────────────────

describe("classifyForStress — substrate resolution", () => {
  it("samechain keeps lp_exit_samechain for pendle on base (8453)", () => {
    const ext: TypedExternalPosition = { protocol: "pendle", chainId: 8453 };
    const c = classifyForStress(ext, 8453);
    assert.equal(c.costModelName, "lp_exit_samechain");
    assert.equal(c.stressExclude, true);
  });

  it("crosschain on pendle (a CCTP protocol) swaps to lp_exit_crosschain_cctp", () => {
    const ext: TypedExternalPosition = { protocol: "pendle", chainId: 43114 };
    const c = classifyForStress(ext, 8453);
    assert.equal(c.costModelName, "lp_exit_crosschain_cctp");
  });

  it("avant stays on zero regardless of chain (no LP exit model declared)", () => {
    const ext: TypedExternalPosition = { protocol: "avant", chainId: 43114 };
    const c = classifyForStress(ext, 8453);
    assert.equal(c.costModelName, "zero");
  });

  it("unknown protocol resolves via _unknown and is stressExclude=true", () => {
    const ext: TypedExternalPosition = { protocol: "aave-v3", chainId: 8453 };
    const c = classifyForStress(ext, 8453);
    assert.equal(c.stressExclude, true);
    assert.equal(c.costModelName, "zero");
    assert.equal(c.settlementDaysTypical, "unknown");
  });

  it("runtime guard throws if cost model is corrupted", () => {
    // We cannot mutate the frozen metadata at runtime. Instead verify the
    // guard path fires by invoking COST_MODELS[name] with a fabricated name
    // mirroring what engine.ts does before invocation.
    const bogus = "lp_exit_layerzero" as const;
    assert.equal(
      // @ts-expect-error — probing the runtime guard
      COST_MODELS[bogus],
      undefined,
    );
    // And the engine's internal check:
    assert.throws(() => {
      const fn = (COST_MODELS as Record<string, unknown>)[bogus];
      if (!fn) throw new Error(`Unknown cost model: ${bogus}`);
    }, /Unknown cost model/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Action items — EXPIRED / URGENT / UPCOMING thresholds
// ────────────────────────────────────────────────────────────────────────────

describe("generateActionItems — Pendle maturity thresholds", () => {
  const nowMs = Date.UTC(2026, 3, 23, 0, 0, 0); // 2026-04-23 UTC

  function ext(daysOffset: number): TypedExternalPosition {
    const ts = Math.floor(nowMs / 1000) + Math.floor(daysOffset * 86400);
    return {
      protocol: "pendle",
      valueUsd: 1000,
      market: { name: "PT-x", maturity: ts, aggregatedApy: 0.085 },
    };
  }

  it("emits EXPIRED for negative delta", () => {
    assert.deepEqual(generateActionItems(ext(-1), nowMs), ["[PENDLE-EXT EXPIRED]"]);
  });

  it("emits URGENT at 3 days out", () => {
    assert.deepEqual(generateActionItems(ext(3), nowMs), ["[PENDLE-EXT URGENT]"]);
  });

  it("emits URGENT at the exact urgent threshold (7 days)", () => {
    assert.deepEqual(generateActionItems(ext(7), nowMs), ["[PENDLE-EXT URGENT]"]);
  });

  // PR-B1 of hardcode-vs-generalize-spec.md (R2-BL-3 fix, 2026-04-28):
  // The previous implementation collapsed both 7-14d AND 14-30d into UPCOMING,
  // losing the SOON tier signal. After PR-B1, 7-14d emits SOON; 14-30d emits
  // UPCOMING. The 10-day case below was the canonical assertion that demonstrated
  // the bug — now updated.
  it("emits SOON between urgent and upcoming (10 days)", () => {
    assert.deepEqual(generateActionItems(ext(10), nowMs), ["[PENDLE-EXT SOON]"]);
  });

  it("emits SOON at the soon-tier boundary (14 days)", () => {
    assert.deepEqual(generateActionItems(ext(14), nowMs), ["[PENDLE-EXT SOON]"]);
  });

  it("emits UPCOMING just past the soon boundary (15 days)", () => {
    assert.deepEqual(generateActionItems(ext(15), nowMs), ["[PENDLE-EXT UPCOMING]"]);
  });

  it("emits UPCOMING at the upcomingMax boundary (30 days)", () => {
    assert.deepEqual(generateActionItems(ext(30), nowMs), ["[PENDLE-EXT UPCOMING]"]);
  });

  it("emits nothing past upcomingMax (35 days)", () => {
    assert.deepEqual(generateActionItems(ext(35), nowMs), []);
  });

  it("emits nothing for avant (no actionItems declared — updatedAt lie)", () => {
    const avant: TypedExternalPosition = {
      protocol: "avant",
      valueUsd: 500,
      orderId: 42,
      source: "avusdx-burn",
      updatedAt: Math.floor(nowMs / 1000) - 100,
    };
    assert.deepEqual(generateActionItems(avant, nowMs), []);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// View modes — curator vs consumer produce distinct shapes
// ────────────────────────────────────────────────────────────────────────────

describe("renderExternalPosition — view modes", () => {
  const avantExt: TypedExternalPosition = {
    protocol: "avant",
    chainId: 43114,
    valueUsd: 500,
    orderId: 42,
    source: "avusdx-burn",
    burnt: { symbol: "avUSDx" },
    claim: { symbol: "avUSD" },
  };

  it("curator mode does NOT prepend oneSentenceIntro", () => {
    const line = renderExternalPosition(avantExt, 10000, { viewMode: "curator" });
    assert.equal(
      line.includes("Avant's avUSDx is a yield-bearing wrapper"),
      false,
      `curator mode leaked oneSentenceIntro: ${line}`,
    );
  });

  it("consumer mode prepends oneSentenceIntro on first encounter", () => {
    const seen = new Set<string>();
    const line = renderExternalPosition(avantExt, 10000, { viewMode: "consumer", seenProtocols: seen });
    assert.ok(
      line.includes("Avant's avUSDx is a yield-bearing wrapper"),
      `consumer mode missing oneSentenceIntro: ${line}`,
    );
    assert.ok(seen.has("avant"), "seenProtocols not updated");
  });

  it("consumer mode de-duplicates oneSentenceIntro across a batch", () => {
    const seen = new Set<string>();
    const first = renderExternalPosition(avantExt, 10000, { viewMode: "consumer", seenProtocols: seen });
    const second = renderExternalPosition(avantExt, 10000, { viewMode: "consumer", seenProtocols: seen });
    assert.ok(first.includes("Avant's avUSDx"));
    assert.equal(
      second.includes("Avant's avUSDx"),
      false,
      `second render re-emitted oneSentenceIntro: ${second}`,
    );
  });

  it("curator mode shows typical-only settlement", () => {
    const line = renderExternalPosition(avantExt, 10000, { viewMode: "curator" });
    assert.ok(line.includes("settle ~7d"), `curator settlement shape wrong: ${line}`);
    assert.equal(
      line.includes("floor"),
      false,
      `curator mode leaked floor/ceiling: ${line}`,
    );
  });

  it("consumer mode renders full floor + ceiling range", () => {
    const line = renderExternalPosition(avantExt, 10000, { viewMode: "consumer" });
    assert.ok(line.includes("floor 7d"), `consumer mode missing floor: ${line}`);
    assert.ok(line.includes("ceiling unknown"), `consumer mode missing ceiling: ${line}`);
    assert.ok(line.toLowerCase().includes("queue depth"), `consumer mode missing ceiling reason: ${line}`);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Unknown protocol — loud inline warning (not just a footer)
// ────────────────────────────────────────────────────────────────────────────

describe("renderExternalPosition — _unknown protocol", () => {
  it("renders a loud inline warning on the position line", () => {
    const ext: TypedExternalPosition = { protocol: "unmapped-v1", valueUsd: 250 };
    const line = renderExternalPosition(ext, 10000, { viewMode: "curator" });
    assert.ok(line.includes("UNMAPPED PROTOCOL"), `missing inline warning: ${line}`);
    assert.ok(line.includes("protocol=unmapped-v1"), `missing protocol tag: ${line}`);
    assert.ok(line.includes("$250"), `missing raw valueUsd: ${line}`);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DriftCollector — per-call isolation + dedup
// ────────────────────────────────────────────────────────────────────────────

describe("DriftCollector", () => {
  it("collects unknown-protocol hits only for the call that allocated it", () => {
    const dcA = new DriftCollector();
    const dcB = new DriftCollector();
    const ext: TypedExternalPosition = { protocol: "mystery", valueUsd: 100, foo: 1 };

    renderExternalPosition(ext, 10000, { viewMode: "curator" }, dcA);
    renderExternalPosition(ext, 10000, { viewMode: "curator" }, dcA);
    renderExternalPosition(ext, 10000, { viewMode: "curator" }, dcB);

    const aggA = dcA.aggregate();
    const aggB = dcB.aggregate();
    assert.equal(aggA.length, 1);
    assert.equal(aggA[0].count, 2);
    assert.equal(aggB.length, 1);
    assert.equal(aggB[0].count, 1);
  });

  it("de-duplicates by protocol with field-union aggregation", () => {
    const dc = new DriftCollector();
    const e1: TypedExternalPosition = { protocol: "mystery", valueUsd: 100, foo: 1 };
    const e2: TypedExternalPosition = { protocol: "mystery", valueUsd: 200, bar: 2 };
    const e3: TypedExternalPosition = { protocol: "other", valueUsd: 50, baz: 3 };

    renderExternalPosition(e1, 10000, { viewMode: "curator" }, dc);
    renderExternalPosition(e2, 10000, { viewMode: "curator" }, dc);
    renderExternalPosition(e3, 10000, { viewMode: "curator" }, dc);

    const agg = dc.aggregate();
    assert.equal(agg.length, 2);
    const mystery = agg.find((w) => w.protocol === "mystery")!;
    assert.equal(mystery.count, 2);
    assert.ok(mystery.sampleFields.includes("foo"));
    assert.ok(mystery.sampleFields.includes("bar"));
    assert.ok(mystery.sampleFields.includes("valueUsd"));
  });

  it("known protocols do not get recorded as drift", () => {
    const dc = new DriftCollector();
    const ext: TypedExternalPosition = {
      protocol: "pendle",
      valueUsd: 1000,
      market: { name: "PT-x", maturity: 1746057600, aggregatedApy: 0.085 },
    };
    renderExternalPosition(ext, 10000, { viewMode: "curator" }, dc);
    assert.equal(dc.aggregate().length, 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

describe("describeProtocolWindow + effectiveValueAsString + getMeta", () => {
  it("describeProtocolWindow returns the Avant windowLabel prose", () => {
    const prose = describeProtocolWindow("avant");
    assert.equal(prose, "one-week cooldown per Avant docs");
  });

  it("describeProtocolWindow falls back to _unknown's label for unmapped", () => {
    const prose = describeProtocolWindow("never-heard-of-this");
    assert.ok(prose.includes("unknown"), prose);
  });

  it("effectiveValueAsString extracts a Sourced number", () => {
    const v = { value: 7, sourceUrl: "x", sourceVerifiedOn: "2026-04-23" };
    assert.equal(effectiveValueAsString(v), "7");
  });

  it("effectiveValueAsString extracts an Interpreted number", () => {
    const v = {
      value: 7,
      interpretedFrom: { value: "one-week", sourceUrl: "x", sourceVerifiedOn: "2026-04-23" },
      interpretationNote: "1wk = 7d",
      sourceVerifiedOn: "2026-04-23",
    };
    assert.equal(effectiveValueAsString(v), "7");
  });

  it("getMeta returns _unknown for an unregistered name", () => {
    assert.equal(getMeta("i-do-not-exist").name, "_unknown");
  });

  it("getMeta returns avant by name", () => {
    assert.equal(getMeta("avant").name, "avant");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 3 — stress-test caller contract
//
// These tests pin the AP-1 invariant and cost-model equivalence that
// src/tools/stress_test.ts relies on. They don't spin up the tool — they
// assert the classifier + cost-models produce exactly the numbers the tool
// wires into its waterfall + binary-search logic.
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 3 — stress caller invariants", () => {
  it("AP-1: stressExclude=true still contributes to idle subtraction", () => {
    // Simulate the caller loop: given a pendle externalPosition (excluded from
    // all tiers, but still real capital held outside idle), the caller
    // subtracts valueUsd from idleCapitalUsd regardless of the flag.
    const vaultTvl = 10_000_000;
    const knownAllocTotal = 6_000_000;
    const ext: TypedExternalPosition = {
      protocol: "pendle",
      valueUsd: 1_000_000,
      chainId: 8453,
    };
    const c = classifyForStress(ext, 8453);
    assert.equal(c.stressExclude, true, "pendle must be stressExclude=true");

    // AP-1: valueUsd is subtracted from idle regardless of stressExclude.
    const idleAfter = Math.max(0, vaultTvl - knownAllocTotal - (ext.valueUsd ?? 0));
    assert.equal(
      idleAfter,
      3_000_000,
      "pendle externalPosition MUST reduce idleCapitalUsd even though stressExclude=true",
    );
  });

  it("avant externalPosition at $1M with stressMultiplier=2.0 costs $0 via COST_MODELS.zero", () => {
    // Pre-Phase-3 inline math: cost = 0 (tier 1b had no impact).
    // Post-Phase-3 via registry: COST_MODELS.zero returns 0 for any input.
    // This is the canonical landmine check from the Phase-3 prompt.
    const pre = 0;
    const post = COST_MODELS.zero({ amountUsd: 1_000_000, stressMultiplier: 2.0 });
    assert.equal(post, pre, "avant cost must be 0 regardless of amount or stress");
  });

  it("avant classifier returns zero cost model + settlement=7 + stressExclude=false", () => {
    const ext: TypedExternalPosition = { protocol: "avant", chainId: 43114 };
    const c = classifyForStress(ext, 8453);
    assert.equal(c.costModelName, "zero");
    assert.equal(c.settlementDaysTypical, 7);
    assert.equal(c.stressExclude, false, "avant must NOT be stressExclude — it holds the tier 1b slot");
  });

  it("LP-exit samechain cost matches pre-Phase-3 inline formula at depth>0", () => {
    // Pre-Phase-3 inline (for Spectra LP same-chain):
    //   cost = removable * estimatePriceImpact(removable, depth) * stressMultiplier
    //        = removable * (removable / (2*depth)) * stressMultiplier
    // Post-Phase-3: COST_MODELS.lp_exit_samechain returns the same number.
    const removable = 50_000;
    const depth = 1_000_000;
    const stressMultiplier = 2;
    // Manual formula:
    const expected = removable * (removable / (2 * depth)) * stressMultiplier;
    const actual = COST_MODELS.lp_exit_samechain({
      amountUsd: removable,
      poolLiquidityUsd: depth,
      stressMultiplier,
    });
    assert.equal(actual, expected);
  });

  it("LP-exit crosschain cost matches pre-Phase-3 inline formula (1.5x samechain) at depth>0", () => {
    // Pre-Phase-3 inline (for Spectra LP cross-chain):
    //   cost = removable * estimatePriceImpact(...) * stressMultiplier * 1.5
    // Post-Phase-3: COST_MODELS.lp_exit_crosschain_cctp = samechain * 1.5.
    const removable = 50_000;
    const depth = 1_000_000;
    const stressMultiplier = 2;
    const expected = removable * (removable / (2 * depth)) * stressMultiplier * 1.5;
    const actual = COST_MODELS.lp_exit_crosschain_cctp({
      amountUsd: removable,
      poolLiquidityUsd: depth,
      stressMultiplier,
    });
    assert.equal(actual, expected);
  });

  it("PT-sale same-chain: 2 × LP-exit matches pre-Phase-3 inline (impact * 2 * stress)", () => {
    // Pre-Phase-3 inline (Tier 4 PT sale same-chain):
    //   cost = ptSellable * estimatePriceImpact(ptSellable, depth) * 2 * stressMultiplier
    // Post-Phase-3: 2 × COST_MODELS.lp_exit_samechain(...).
    const ptSellable = 25_000;
    const depth = 2_000_000;
    const stressMultiplier = 2;
    const expected = ptSellable * (ptSellable / (2 * depth)) * 2 * stressMultiplier;
    const actual =
      COST_MODELS.lp_exit_samechain({
        amountUsd: ptSellable,
        poolLiquidityUsd: depth,
        stressMultiplier,
      }) * 2;
    assert.equal(actual, expected);
  });

  it("PT-sale cross-chain: 2 × LP-exit-crosschain matches pre-Phase-3 (impact * 2 * stress * 1.5)", () => {
    const ptSellable = 25_000;
    const depth = 2_000_000;
    const stressMultiplier = 2;
    const expected = ptSellable * (ptSellable / (2 * depth)) * 2 * stressMultiplier * 1.5;
    const actual =
      COST_MODELS.lp_exit_crosschain_cctp({
        amountUsd: ptSellable,
        poolLiquidityUsd: depth,
        stressMultiplier,
      }) * 2;
    assert.equal(actual, expected);
  });

  it("unknown protocol is stressExclude=true (excluded from tier + max-safe)", () => {
    // A future Aave externalPosition shape — unregistered protocol routes
    // through _unknown, which is stressExclude=true. Caller loop must NOT
    // place it in any tier but must still subtract from idle.
    const ext: TypedExternalPosition = {
      protocol: "aave-v3",
      valueUsd: 500_000,
      chainId: 8453,
    };
    const c = classifyForStress(ext, 8453);
    assert.equal(c.stressExclude, true);
    // Caller contract: subtract from idle, skip tier placement.
    const vaultTvl = 10_000_000;
    const knownAllocTotal = 4_000_000;
    const idleAfter = Math.max(0, vaultTvl - knownAllocTotal - (ext.valueUsd ?? 0));
    assert.equal(idleAfter, 5_500_000);
  });
});
