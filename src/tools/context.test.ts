/**
 * Unit tests for tools/context.ts — external_protocols topic rendering.
 *
 * The topic text is precomputed at module load from PROTOCOL_METADATA. These
 * tests assert the rendered string surfaces the anchors an agent needs to
 * reason about exit timing, cost, and observation boundaries:
 *   - every registered protocol (except `_unknown`) shows up by name
 *   - Avant's "one-week cooldown" window label is visible verbatim
 *   - InterpretedValue numerics render with their "interpreted from" source
 *     prose (so agents see the interpretation, not a bare 7)
 *   - observation boundaries + mitigations + editability note are surfaced
 *   - the fallback `_unknown` is NOT listed (it's internal, not a protocol)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXTERNAL_PROTOCOLS_TEXT } from "./context.js";

describe("external_protocols topic — content anchors", () => {
  it("is a non-empty string", () => {
    assert.equal(typeof EXTERNAL_PROTOCOLS_TEXT, "string");
    assert.ok(EXTERNAL_PROTOCOLS_TEXT.length > 0, "rendered topic should be non-empty");
  });

  it("lists every registered protocol by name (avant + pendle)", () => {
    assert.ok(EXTERNAL_PROTOCOLS_TEXT.includes("avant"), "avant must be listed");
    assert.ok(EXTERNAL_PROTOCOLS_TEXT.includes("pendle"), "pendle must be listed");
  });

  it("surfaces Avant's 'one-week cooldown' window label verbatim from docs", () => {
    // This is the load-bearing anchor: the tool's value to an agent reasoning
    // about stress-settlement timing comes from the docs-prose being visible,
    // not a bare numeric "7" that loses its interpretation chain.
    assert.ok(
      EXTERNAL_PROTOCOLS_TEXT.includes("one-week cooldown"),
      "Avant's 'one-week cooldown' prose must survive the render",
    );
  });

  it("renders interpreted numeric window with its 'interpreted from' provenance", () => {
    // `typical: 7 days` for Avant is an InterpretedValue — the render should
    // show the interpretation trail, not just the number.
    assert.ok(
      EXTERNAL_PROTOCOLS_TEXT.includes("interpreted from"),
      "InterpretedValue should render with 'interpreted from: ...' provenance",
    );
  });

  it("surfaces observation boundaries sections (unobservable + mitigations)", () => {
    assert.ok(EXTERNAL_PROTOCOLS_TEXT.includes("unobservable"), "unobservable section expected");
    assert.ok(EXTERNAL_PROTOCOLS_TEXT.includes("mitigations"), "mitigations section expected");
    assert.ok(EXTERNAL_PROTOCOLS_TEXT.includes("dissolution"), "dissolution section expected");
  });

  it("notes the registry is editable and points at metadata.ts", () => {
    assert.ok(
      EXTERNAL_PROTOCOLS_TEXT.includes("src/protocols/metadata.ts"),
      "editability note must point at metadata.ts",
    );
  });

  it("does NOT list the `_unknown` fallback as a protocol entry", () => {
    // `_unknown` is a fallback, not a protocol — listing it would be noise.
    // We allow the phrase "unmapped" / "fallback" in the body, but the bare
    // "_unknown" header should not appear.
    assert.ok(
      !EXTERNAL_PROTOCOLS_TEXT.includes("—  _unknown"),
      "_unknown should not appear as a listed protocol entry",
    );
  });

  it("surfaces a freshness footer with at least one ISO date", () => {
    assert.ok(
      /sourceVerifiedOn.*=\s*\d{4}-\d{2}-\d{2}/.test(EXTERNAL_PROTOCOLS_TEXT),
      "freshness footer should include a YYYY-MM-DD date",
    );
  });

  it("surfaces Pendle's instant-AMM-exit window label", () => {
    assert.ok(
      EXTERNAL_PROTOCOLS_TEXT.includes("instant AMM exit"),
      "Pendle window label should be rendered",
    );
  });

  it("names the out-of-scope layers (Merkl + Spectra-native) so agents know the scope", () => {
    // Scope complementarity — spec PR7. An agent reading this topic should
    // know it's seeing 1/3 of the yield/risk picture.
    assert.ok(
      EXTERNAL_PROTOCOLS_TEXT.includes("merkl_list_campaigns"),
      "Merkl tool should be named as the other incentive layer",
    );
    assert.ok(
      EXTERNAL_PROTOCOLS_TEXT.includes("spectra_list_pools"),
      "Spectra-native tool should be named as the other AMM-state layer",
    );
  });
});
