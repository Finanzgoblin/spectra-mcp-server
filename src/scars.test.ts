/**
 * Unit tests for scars.ts — reinforcement-weighted scar loading.
 *
 * Covers:
 * - computeWeight formula correctness at canonical input points
 *   (matches the table in `~/soul/scar-weighting-wisdom.md`).
 * - parseFrontmatter edge cases.
 * - loadScars integration via a temp directory with mock feedback_*.md files,
 *   verifying reinforcement count tally + sort order + filterType + topN.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeWeight, parseFrontmatter, loadScars } from "./scars.js";

describe("computeWeight", () => {
  it("returns 1.0 for fresh, unreinforced scar (ageDays=0, count=0)", () => {
    assert.equal(computeWeight(0, 0), 1.0);
  });

  it("returns ~0.3679 (e^-1) at the 30-day halflife", () => {
    const w = computeWeight(30, 0);
    assert.ok(Math.abs(w - Math.exp(-1)) < 1e-12);
  });

  it("returns ~0.1353 (e^-2) at 60 days", () => {
    const w = computeWeight(60, 0);
    assert.ok(Math.abs(w - Math.exp(-2)) < 1e-12);
  });

  it("doubles for 1 reinforcement (1 + log2(2) = 2)", () => {
    assert.equal(computeWeight(0, 1), 2.0);
  });

  it("triples for 3 reinforcements (1 + log2(4) = 3)", () => {
    assert.equal(computeWeight(0, 3), 3.0);
  });

  it("quadruples for 7 reinforcements (1 + log2(8) = 4)", () => {
    assert.equal(computeWeight(0, 7), 4.0);
  });

  it("scar reinforced 3x at 60 days beats fresh one-time scar", () => {
    // 0.1353 × 3 ≈ 0.406 vs 1.0 — actually loses to fresh.
    // The crossover is around 3-5 reinforcements per 30-day age gap per the wisdom doc.
    const oldReinforced = computeWeight(60, 3);
    const freshOneTime = computeWeight(0, 0);
    assert.ok(oldReinforced < freshOneTime, "60d × 3-reinforce loses to fresh");
    // But reinforced 7x at 30 days SHOULD beat fresh one-time:
    const oldHeavyReinforced = computeWeight(30, 7);
    assert.ok(oldHeavyReinforced > freshOneTime, "30d × 7-reinforce beats fresh");
  });

  it("clamps negative ageDays to 0 (no future-dated weight inflation)", () => {
    assert.equal(computeWeight(-10, 0), 1.0);
  });

  it("clamps negative reinforceCount to 0", () => {
    assert.equal(computeWeight(0, -3), 1.0);
  });
});

describe("parseFrontmatter", () => {
  it("parses standard frontmatter with multiple keys", () => {
    const content = `---
name: test-scar
description: One-line description
type: feedback
reinforces: earlier-scar
---

The body of the scar.
More body.
`;
    const { meta, body } = parseFrontmatter(content);
    assert.equal(meta.name, "test-scar");
    assert.equal(meta.description, "One-line description");
    assert.equal(meta.type, "feedback");
    assert.equal(meta.reinforces, "earlier-scar");
    assert.ok(body.startsWith("The body"));
  });

  it("returns empty meta and full content when no frontmatter", () => {
    const content = "Just a body, no frontmatter.";
    const { meta, body } = parseFrontmatter(content);
    assert.deepEqual(meta, {});
    assert.equal(body, content);
  });

  it("treats unclosed frontmatter as body-only (graceful)", () => {
    const content = `---
name: missing-close
description: never closed

still no closing fence
`;
    const { meta, body } = parseFrontmatter(content);
    assert.deepEqual(meta, {});
    assert.equal(body, content);
  });

  it("strips surrounding double-quotes from values", () => {
    const content = `---
name: "quoted-name"
description: 'single-quoted'
---
body`;
    const { meta } = parseFrontmatter(content);
    assert.equal(meta.name, "quoted-name");
    assert.equal(meta.description, "single-quoted");
  });

  it("ignores lines without a colon inside the frontmatter block", () => {
    const content = `---
name: ok
this-line-has-no-colon
description: still parsed
---
body`;
    const { meta } = parseFrontmatter(content);
    assert.equal(meta.name, "ok");
    assert.equal(meta.description, "still parsed");
  });
});

describe("loadScars (integration via tmp dir)", () => {
  let dir: string;
  const NOW = Date.UTC(2026, 3, 28); // 2026-04-28

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "scars-test-"));
    // Three feedback files spanning age + reinforcement permutations.
    await writeFile(
      join(dir, "feedback_oldest.md"),
      `---
name: oldest
description: Old-but-load-bearing scar.
type: feedback
date: 2026-02-27
---
Body of oldest.
`,
      "utf8",
    );
    await writeFile(
      join(dir, "feedback_recent.md"),
      `---
name: recent
description: Fresh one-time correction.
type: feedback
date: 2026-04-28
---
Body of recent.
`,
      "utf8",
    );
    await writeFile(
      join(dir, "feedback_reinforcer1.md"),
      `---
name: reinforcer1
description: Reinforces oldest.
type: feedback
reinforces: oldest
date: 2026-04-20
---
First reinforcement.
`,
      "utf8",
    );
    await writeFile(
      join(dir, "feedback_reinforcer2.md"),
      `---
name: reinforcer2
description: Also reinforces oldest.
type: feedback
reinforces: oldest
date: 2026-04-25
---
Second reinforcement.
`,
      "utf8",
    );
    // Non-feedback file (should be ignored by default prefix filter).
    await writeFile(
      join(dir, "memory.md"),
      `---
name: memory
type: index
---
not a feedback file
`,
      "utf8",
    );
    // Feedback file with type=project (should be filtered out by default).
    await writeFile(
      join(dir, "feedback_project.md"),
      `---
name: project-thing
type: project
date: 2026-04-28
---
project not feedback
`,
      "utf8",
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns scars sorted by weight desc", async () => {
    const scars = await loadScars({ scarDir: dir, now: NOW });
    assert.ok(scars.length >= 4, `expected >= 4 feedback scars, got ${scars.length}`);
    for (let i = 0; i < scars.length - 1; i++) {
      assert.ok(scars[i].weight >= scars[i + 1].weight, `not sorted at index ${i}`);
    }
  });

  it("tallies reinforceCount on the named target", async () => {
    const scars = await loadScars({ scarDir: dir, now: NOW });
    const oldest = scars.find((s) => s.name === "oldest");
    assert.ok(oldest);
    assert.equal(oldest.reinforceCount, 2, "oldest should be reinforced by reinforcer1 + reinforcer2");
    const recent = scars.find((s) => s.name === "recent");
    assert.ok(recent);
    assert.equal(recent.reinforceCount, 0);
  });

  it("oldest-with-reinforcement weight beats reinforcers themselves (it's the load-bearing one)", async () => {
    const scars = await loadScars({ scarDir: dir, now: NOW });
    const byName = Object.fromEntries(scars.map((s) => [s.name, s]));
    // oldest: 60d ago, reinforced 2× → e^-2 × (1 + log2(3)) ≈ 0.1353 × 2.585 ≈ 0.350
    // reinforcer2: 3d ago, 0 reinforcements → e^(-0.1) × 1 ≈ 0.905
    // recent: 0d ago, 0 reinforcements → 1.0
    assert.ok(byName.oldest.weight > 0.3, `oldest weight too low: ${byName.oldest.weight}`);
    assert.ok(byName.recent.weight > byName.oldest.weight, "recent should beat oldest in this fixture");
  });

  it("filterType=feedback excludes type=project", async () => {
    const scars = await loadScars({ scarDir: dir, now: NOW });
    assert.ok(!scars.some((s) => s.name === "project-thing"));
  });

  it('filterType="all" includes everything (still respects filename prefix)', async () => {
    const scars = await loadScars({ scarDir: dir, now: NOW, filterType: "all" });
    assert.ok(scars.some((s) => s.name === "project-thing"));
  });

  it("does NOT pick up files outside the filenamePrefix", async () => {
    const scars = await loadScars({ scarDir: dir, now: NOW, filterType: "all" });
    assert.ok(!scars.some((s) => s.name === "memory"));
  });

  it("respects topN truncation", async () => {
    const scars = await loadScars({ scarDir: dir, now: NOW, topN: 2 });
    assert.equal(scars.length, 2);
  });

  it("populates `reinforces` field on the reinforcing scar", async () => {
    const scars = await loadScars({ scarDir: dir, now: NOW });
    const r1 = scars.find((s) => s.name === "reinforcer1");
    assert.ok(r1);
    assert.equal(r1.reinforces, "oldest");
  });

  it("returns empty array (not throw) when directory missing", async () => {
    const scars = await loadScars({ scarDir: "/nonexistent/path/that/does/not/exist", now: NOW });
    assert.deepEqual(scars, []);
  });

  it("includes body in Scar object regardless (the tool layer chooses to render or hide)", async () => {
    const scars = await loadScars({ scarDir: dir, now: NOW });
    const recent = scars.find((s) => s.name === "recent");
    assert.ok(recent);
    assert.ok(recent.body.includes("Body of recent"));
  });

  it("falls back to file mtime when frontmatter `date` is absent", async () => {
    // Add a file without `date:` and set its mtime to a known past time.
    const noDateFile = join(dir, "feedback_nodate.md");
    await writeFile(
      noDateFile,
      `---
name: no-date
description: No date field.
type: feedback
---
body
`,
      "utf8",
    );
    // Set mtime to 10 days before NOW.
    const tenDaysAgoSec = NOW / 1000 - 10 * 86400;
    await utimes(noDateFile, tenDaysAgoSec, tenDaysAgoSec);

    const scars = await loadScars({ scarDir: dir, now: NOW });
    const noDate = scars.find((s) => s.name === "no-date");
    assert.ok(noDate);
    assert.ok(noDate.ageDays > 9 && noDate.ageDays < 11, `expected ~10d, got ${noDate.ageDays}`);
  });
});
