/**
 * Zod schema tests for the protocols registry.
 *
 * Critical guarantee: `SourcedValue<number>` for Avant's interpreted 7 MUST
 * fail validation against the strict schema. The TS compiler accepts it
 * (it's just `{ value: 7, sourceUrl, sourceVerifiedOn }`) but the interpretation
 * chain is lost — that's exactly the attribution-creep bug SU-1 protects against.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  sourcedValueSchema,
  interpretedValueSchema,
  maybeInterpretedValueSchema,
  FormatHintSchema,
  FieldSpecSchema,
  CostModelNameSchema,
  settlementWindowSchema,
  RenderContextSchema,
  protocolMetaSchema,
} from "./types.js";
import { PROTOCOL_METADATA } from "./metadata.js";

describe("SourcedValue schema", () => {
  it("accepts a real URL + ISO date", () => {
    const parsed = sourcedValueSchema(z.number()).safeParse({
      value: 7,
      sourceUrl: "https://docs.avantprotocol.com/x",
      sourceVerifiedOn: "2026-04-23",
    });
    assert.equal(parsed.success, true);
  });

  it("rejects empty sourceUrl under strict schema", () => {
    const parsed = sourcedValueSchema(z.number()).safeParse({
      value: 7,
      sourceUrl: "",
      sourceVerifiedOn: "2026-04-23",
    });
    assert.equal(parsed.success, false);
  });

  it("rejects non-ISO date under strict schema", () => {
    const parsed = sourcedValueSchema(z.number()).safeParse({
      value: 7,
      sourceUrl: "https://docs.example.com/x",
      sourceVerifiedOn: "April 23, 2026",
    });
    assert.equal(parsed.success, false);
  });

  it("allows empty sourceUrl under allowEmptySource=true", () => {
    const parsed = sourcedValueSchema(z.number(), { allowEmptySource: true }).safeParse({
      value: 0,
      sourceUrl: "",
      sourceVerifiedOn: "2026-04-23",
    });
    assert.equal(parsed.success, true);
  });
});

describe("InterpretedValue schema", () => {
  it("accepts a well-formed interpretation chain", () => {
    const parsed = interpretedValueSchema(z.number()).safeParse({
      value: 7,
      interpretedFrom: {
        value: "one-week cooldown",
        sourceUrl: "https://docs.avantprotocol.com/x",
        sourceVerifiedOn: "2026-04-23",
      },
      interpretationNote: "One week as 7 calendar days.",
      sourceVerifiedOn: "2026-04-23",
    });
    assert.equal(parsed.success, true);
  });

  it("rejects when interpretationNote is empty", () => {
    const parsed = interpretedValueSchema(z.number()).safeParse({
      value: 7,
      interpretedFrom: {
        value: "one-week cooldown",
        sourceUrl: "https://docs.avantprotocol.com/x",
        sourceVerifiedOn: "2026-04-23",
      },
      interpretationNote: "",
      sourceVerifiedOn: "2026-04-23",
    });
    assert.equal(parsed.success, false);
  });

  it("rejects when interpretedFrom.sourceUrl is missing", () => {
    const parsed = interpretedValueSchema(z.number()).safeParse({
      value: 7,
      interpretedFrom: {
        value: "one-week cooldown",
        sourceUrl: "",
        sourceVerifiedOn: "2026-04-23",
      },
      interpretationNote: "One week as 7 calendar days.",
      sourceVerifiedOn: "2026-04-23",
    });
    assert.equal(parsed.success, false);
  });
});

describe("MaybeInterpretedValue — the attribution-creep guard (SU-1)", () => {
  it("accepts a legitimate SourcedValue<number> (verbatim source)", () => {
    // Pendle's settlementWindow.typical IS a SourcedValue<number>: the docs
    // literally state "instant AMM exit" (0 days). This shape is correct.
    const sourced = {
      value: 0,
      sourceUrl: "https://docs.pendle.finance/ProtocolMechanics/Mechanisms/AMM",
      sourceVerifiedOn: "2026-04-23",
    };
    const parsed = maybeInterpretedValueSchema(z.number()).safeParse(sourced);
    assert.equal(parsed.success, true);
  });

  it("accepts a legitimate InterpretedValue<number> (derived from prose)", () => {
    // Avant's settlementWindow.typical IS an InterpretedValue<number>: the
    // docs say "one-week cooldown" (prose). 7 is derived.
    const interpreted = {
      value: 7,
      interpretedFrom: {
        value: "requires a burn request, which initiates a one-week cooldown period",
        sourceUrl: "https://docs.avantprotocol.com/overview/core-tokens#avusdx",
        sourceVerifiedOn: "2026-04-23",
      },
      interpretationNote: "One week interpreted as 7 calendar days.",
      sourceVerifiedOn: "2026-04-23",
    };
    const parsed = maybeInterpretedValueSchema(z.number()).safeParse(interpreted);
    assert.equal(parsed.success, true);
  });

  it("refuses Avant's interpreted 7 typed as bare SourcedValue (missing source attribution)", () => {
    // THE critical test: the concrete failure mode is a registry author
    // stripping `interpretedFrom` + `interpretationNote` to "simplify" the
    // avant entry. The remaining shape `{value: 7, sourceVerifiedOn}` lacks
    // `sourceUrl` (which had lived inside `interpretedFrom`), so the strict
    // union rejects both branches. The 2d→1w class of bug is prevented
    // because the shape cannot be typed as SourcedValue without adding a
    // URL directly attributing 7 to Avant — which their docs don't state.
    const strippedInterpretation = {
      value: 7,
      sourceVerifiedOn: "2026-04-23",
    };
    const parsed = maybeInterpretedValueSchema(z.number()).safeParse(strippedInterpretation);
    assert.equal(parsed.success, false);
  });

  it("refuses a SourcedValue with extra interpretation fields (strict mode)", () => {
    // If a registry author tries to dual-type (SourcedValue + interpretation
    // fields stapled on), strict zod rejects it at BOTH branches of the union.
    const frankenstein = {
      value: 7,
      sourceUrl: "",
      sourceVerifiedOn: "2026-04-23",
      interpretationNote: "half-attributed",
    };
    const parsed = maybeInterpretedValueSchema(z.number()).safeParse(frankenstein);
    assert.equal(parsed.success, false);
  });
});

describe("FormatHintSchema", () => {
  it("accepts all 6 hints", () => {
    for (const h of ["pct100", "pct1", "usd", "date", "number", "plain"]) {
      assert.equal(FormatHintSchema.safeParse(h).success, true);
    }
  });

  it("rejects unknown hint", () => {
    assert.equal(FormatHintSchema.safeParse("currency").success, false);
  });
});

describe("FieldSpecSchema", () => {
  it("accepts minimum shape", () => {
    const parsed = FieldSpecSchema.safeParse({ path: "x", format: "plain" });
    assert.equal(parsed.success, true);
  });

  it("accepts label", () => {
    const parsed = FieldSpecSchema.safeParse({ path: "x", label: "X", format: "number" });
    assert.equal(parsed.success, true);
  });

  it("rejects extra fields", () => {
    const parsed = FieldSpecSchema.safeParse({ path: "x", format: "plain", formatter: "f" });
    assert.equal(parsed.success, false);
  });
});

describe("CostModelNameSchema", () => {
  it("accepts the four canonical names", () => {
    for (const n of ["zero", "lp_exit_samechain", "lp_exit_crosschain_cctp", "liquidation"]) {
      assert.equal(CostModelNameSchema.safeParse(n).success, true);
    }
  });

  it("rejects an arbitrary cost model name", () => {
    assert.equal(CostModelNameSchema.safeParse("lp_exit_layerzero").success, false);
  });
});

describe("SettlementWindow schema", () => {
  it("accepts typical-only shape", () => {
    const parsed = settlementWindowSchema().safeParse({
      typical: {
        value: 0,
        sourceUrl: "https://docs.example.com/x",
        sourceVerifiedOn: "2026-04-23",
      },
    });
    assert.equal(parsed.success, true);
  });

  it("accepts typical + floor + ceiling", () => {
    const parsed = settlementWindowSchema().safeParse({
      typical: {
        value: 7,
        interpretedFrom: {
          value: "one-week",
          sourceUrl: "https://docs.example.com/x",
          sourceVerifiedOn: "2026-04-23",
        },
        interpretationNote: "1wk ≈ 7d",
        sourceVerifiedOn: "2026-04-23",
      },
      floor: {
        value: 7,
        sourceUrl: "https://docs.example.com/x",
        sourceVerifiedOn: "2026-04-23",
      },
      ceiling: {
        value: "unknown",
        reason: "queue depth unobserved",
      },
    });
    assert.equal(parsed.success, true);
  });

  it("rejects ceiling without a reason", () => {
    const parsed = settlementWindowSchema().safeParse({
      typical: {
        value: 0,
        sourceUrl: "https://docs.example.com/x",
        sourceVerifiedOn: "2026-04-23",
      },
      ceiling: { value: "unknown", reason: "" },
    });
    assert.equal(parsed.success, false);
  });
});

describe("RenderContext schema", () => {
  it("accepts curator mode without seenProtocols", () => {
    const parsed = RenderContextSchema.safeParse({ viewMode: "curator" });
    assert.equal(parsed.success, true);
  });

  it("accepts consumer mode with a Set", () => {
    const parsed = RenderContextSchema.safeParse({
      viewMode: "consumer",
      seenProtocols: new Set<string>(["avant"]),
    });
    assert.equal(parsed.success, true);
  });

  it("rejects an unknown viewMode", () => {
    const parsed = RenderContextSchema.safeParse({ viewMode: "protocol-owner" });
    assert.equal(parsed.success, false);
  });
});

describe("ProtocolMeta schema — registry entries parse", () => {
  it("avant parses under strict schema", () => {
    const parsed = protocolMetaSchema().safeParse(PROTOCOL_METADATA.avant);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.format(), null, 2));
  });

  it("pendle parses under strict schema", () => {
    const parsed = protocolMetaSchema().safeParse(PROTOCOL_METADATA.pendle);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.format(), null, 2));
  });

  it("_unknown parses under relaxed schema", () => {
    const parsed = protocolMetaSchema({ allowEmptySource: true }).safeParse(PROTOCOL_METADATA._unknown);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.format(), null, 2));
  });

  it("_unknown is REJECTED by the strict schema (empty sourceUrl)", () => {
    const parsed = protocolMetaSchema().safeParse(PROTOCOL_METADATA._unknown);
    assert.equal(parsed.success, false);
  });
});
