/**
 * Unit tests for primitives.ts — pure formatters.
 *
 * Covers Phase 0 additions for the discard-layer spec
 * (docs/discard-layer-spec.md §5): shortenAddress, formatSecondsAsDuration,
 * truncateDescription, formatRoleRecord, formatDelayRecord.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shortenAddress,
  formatSecondsAsDuration,
  truncateDescription,
  formatRoleRecord,
  formatDelayRecord,
} from "./primitives.js";

describe("shortenAddress", () => {
  it("formats a typical 0x-prefixed 40-char EVM address", () => {
    assert.equal(
      shortenAddress("0xabcdef1234567890abcdef1234567890abcdef12"),
      "0xabcd...ef12",
    );
  });

  it("returns short input unchanged (length < 11)", () => {
    assert.equal(shortenAddress("0x1234"), "0x1234");
  });

  it("coerces empty string to empty string", () => {
    assert.equal(shortenAddress(""), "");
  });

  it("uses three-dot ASCII separator (matching existing inline duplications)", () => {
    const out = shortenAddress("0xabcdef1234567890abcdef1234567890abcdef12");
    assert.ok(out.includes("..."), "must contain three-dot ASCII separator");
    assert.ok(!out.includes("…"), "must not contain U+2026 ellipsis character");
  });
});

describe("formatSecondsAsDuration", () => {
  it("renders sub-minute as seconds", () => {
    assert.equal(formatSecondsAsDuration("45"), "45s");
  });

  it("renders sub-hour as minutes", () => {
    assert.equal(formatSecondsAsDuration("300"), "5m");
  });

  it("renders sub-day as hours", () => {
    assert.equal(formatSecondsAsDuration("86399"), "24h");
    assert.equal(formatSecondsAsDuration("3600"), "1h");
  });

  it("renders day-and-up as days", () => {
    assert.equal(formatSecondsAsDuration("86400"), "1d");
    assert.equal(formatSecondsAsDuration("172800"), "2d");
  });

  it("renders unparseable input as bracketed fallback", () => {
    assert.equal(formatSecondsAsDuration("abc"), "[unparsed:abc]");
  });

  it("renders empty string as bracketed fallback", () => {
    // parseInt("") returns NaN — should hit the unparsed branch.
    assert.equal(formatSecondsAsDuration(""), "[unparsed:]");
  });

  it("truncates fractional input via parseInt (known precision gap)", () => {
    // "1.5h" parses as 1 (parseInt truncates at non-digit). Spec accepts this.
    assert.equal(formatSecondsAsDuration("1.5"), "1s");
  });
});

describe("truncateDescription", () => {
  it("returns null for undefined input", () => {
    assert.equal(truncateDescription(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.equal(truncateDescription(""), null);
  });

  it("returns the input unchanged when within max length", () => {
    assert.equal(truncateDescription("Short text", 140), "Short text");
  });

  it("takes the first paragraph when separator present", () => {
    const input = "First paragraph.\n\nSecond paragraph.";
    assert.equal(truncateDescription(input, 140), "First paragraph.");
  });

  it("truncates and appends single-char ellipsis when over max", () => {
    const long = "a".repeat(200);
    const out = truncateDescription(long, 140);
    assert.ok(out !== null, "must not be null");
    assert.equal(out!.length, 140, "must be exactly max chars (139 + ellipsis)");
    assert.ok(out!.endsWith("…"), "must end with U+2026 ellipsis");
  });

  it("uses default max=140 when no max provided", () => {
    const long = "x".repeat(200);
    const out = truncateDescription(long);
    assert.ok(out !== null);
    assert.equal(out!.length, 140);
  });
});

describe("formatRoleRecord", () => {
  it("returns null for undefined input", () => {
    assert.equal(formatRoleRecord(undefined), null);
  });

  it("returns null for empty record", () => {
    assert.equal(formatRoleRecord({}), null);
  });

  it("formats roles as role=shortAddress, comma-separated", () => {
    const out = formatRoleRecord({
      proposer: "0xabcdef1234567890abcdef1234567890abcdef12",
      executor: "0x1111111111111111111111111111111111112222",
    });
    assert.equal(out, "proposer=0xabcd...ef12, executor=0x1111...2222");
  });
});

describe("formatDelayRecord", () => {
  it("returns null for undefined input", () => {
    assert.equal(formatDelayRecord(undefined), null);
  });

  it("returns null for empty record", () => {
    assert.equal(formatDelayRecord({}), null);
  });

  it("formats delays via formatSecondsAsDuration", () => {
    const out = formatDelayRecord({
      proposer: "86400",
      executor: "172800",
    });
    assert.equal(out, "proposer 1d, executor 2d");
  });

  it("propagates unparsed seconds through to render", () => {
    const out = formatDelayRecord({ proposer: "garbage" });
    assert.equal(out, "proposer [unparsed:garbage]");
  });
});
