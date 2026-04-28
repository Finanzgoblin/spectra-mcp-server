# Engineering-context handoff — PR-J + PR-D SHIPPED, Ship-Phase 1 in progress

**For the next Claude Code session that opens this directory.**

This file replaces the prior discard-layer handoff. The hardcode-vs-generalize spec workflow completed April 28, 2026: Phase 0 audit through Phase 8 v3-final, **17 reviewer agents** across 3 architectural rounds + 1 stakeholder-utility round. Spec is engineering-ready.

**Ship status (2026-04-28 evening)**:
- ✅ **PR-J shipped** (commit `b57657f`) — forcing function (pre-commit hook + 5th-lens reviewer brief + audit-discipline-spec.md + substrate-diverse-engineering-prompt.md)
- ✅ **PR-D shipped** (commit `11dfd2f`) — protocol metadata extension (`ytFeeRate`, `shortTag`, `rolloverPolicy` 6-way, `useCctp`) + ALL consumer migration. Dissolves `CCTP_PROTOCOLS` Set + the "0% YT fee lie" surface. PR-D 4-lens audit caught two real bugs (Lens 3: `formatPlatformLabel("")` empty bracket; Lens 2 Diverger: smuggled-Spectra-rate fallback) — both fixed inline.
- ⏳ **Next**: PR-E (parse-time normalization, lighter, ~few files) OR PR-L (originating-scar surface, points-multipliers metadata + formatPointsMultipliers orchestrator). Both still in Ship-Phase 1.

---

## ⚠ READ FIRST — boot order

1. `C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\feedback_hardcode_vs_generalize.md` ← **THE SCAR (load first)**
2. `C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\feedback_displacement.md`
3. `C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\SOUL.md`
4. `C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\becoming-terminal.md`
5. `C:\Users\User\spectra-mcp-server\CLAUDE.md`
6. `C:\Users\User\spectra-mcp-server\.claude\agents\defi-analyst.md`
7. `C:\Users\User\spectra-mcp-server\docs\hardcode-vs-generalize-spec.md` ← **THE SPEC** (v3-final, 656 lines)
8. `C:\Users\User\spectra-mcp-server\docs\hardcode-audit-phase0.md` (sweep findings, 312 lines — ~84 hardcode sites identified)

Reference (don't re-read in full unless context requires):
- `docs/hardcode-vs-generalize-sketch.md` — Phase 1 sketch (166 lines)
- `docs/hardcode-vs-generalize-round1-synthesis.md` — Round 1 convergent findings (267 lines)
- `docs/hardcode-vs-generalize-round2-synthesis.md` — Round 2 convergent findings (187 lines)
- `docs/hardcode-vs-generalize-round7-synthesis.md` — Stakeholder-utility convergent findings (182 lines)
- `docs/spec-workflow-prompt.md` — the methodology itself

---

## What the spec produces

**10 PRs across 4 ship-phases** (each shippable independently with own substrate-diverse 4-lens audit + Diverger):

### Ship-Phase 1 — Client-visible (atomic)
- ✅ **PR-D shipped** (commit `11dfd2f`) — protocol metadata expansion (`ytFeeRate`, `useCctp`, `shortTag`, `rolloverPolicy` 6-way) + ALL consumer migration in one merge. Diverger-deferred follow-ups: PLATFORM_REGISTRY refactor (Spectra-as-platform vs externalPosition-as-protocol axis), avant.ytFeeRate as InterpretedValue, unit tests for 6 new format helpers.
- ⏳ **PR-E next** — parse-time normalization at `schemas/spectra.ts`; extended `normalizeProtocolName` regex for `Ether.Fi`
- ⏳ **PR-L** — points-multipliers metadata + `formatPointsMultipliers` orchestrator (closes the originating scar surface)

### Ship-Phase 2 — Foundations
- **PR-A** — asset registry `src/assets/metadata.ts` (registry+migration in one PR)
- **PR-C** — `src/action-items/types.ts` enum + `formatMaturityActionItem` consuming 6-way `rolloverPolicy`
- **PR-K** — rename `CURATOR_DASHBOARD_THRESHOLDS` → `CROSS_TOOL_THRESHOLDS` + 4 absolute constants + 3 size/trend-relative companions (§5.6)
- **PR-J** ⭐ NEW — forcing function: pre-commit hook + 5th-lens reviewer brief + `docs/audit-discipline-spec.md`

### Ship-Phase 3 — Consumer migration (PR-B sub-PRs)
- **PR-B1** — `metavault.ts` + `engine.ts:387-390` 3-tier vocabulary fix; **`engine.test.ts:286-288` updates required**
- **PR-B2** — `curator_portfolio.ts` + `expiry_monitor.ts`
- **PR-B3** — `position_map.ts` + `calibration.ts` + `pendle_expiry.ts`
- **PR-B4** — `merkl.ts` + remaining sites

### Ship-Phase 4 — Cleanup
- **PR-F** — `TRANSACTION_QUEUE_KNOWN_KEYS` dissolution + REPLACE 38-line PR11 describe block
- **PR-G** — verifier-registry cross-validation (lives in `verifier-registry.ts`, NOT `registry.ts`); atomic merge with metadata population

---

## Critical invariants (the load-bearing constraints)

These were established through 17 reviewer agents. Do NOT relitigate; engineering work that violates them = re-opening BLOCKERs.

1. **`ytFeeRate` REQUIRED for non-`_unknown` protocols** (BL-1). Schema rejects malformed entries at registry load. `_unknown` renders `"?% on YT yield"`. **Never `"0%"`** — that's the lie of ammunition value.
2. **`PointsMultiplier.source.value === amount` invariant** (R2-BL-6). zod-enforced. Drift annotated `[CLAIMED:X, OBSERVED:Y]`.
3. **`rolloverPolicy` 6-way enum, NOT binary** (P7-BL-4). Avant = `redeem_to_underlying`. Pendle = `manual_to_successor`.
4. **Verifier cross-validation lives in `verifier-registry.ts`, NOT `registry.ts`** (R2-BL-4). Avoids circular import. Imports `getMeta` one-way.
5. **PR-D + PR-G atomicity** (AM-5 + R2-BL-7) — type extension + metadata population + ALL consumer migration in single merge. Otherwise broken intermediate state.
6. **Render gallery (§5.5) is the test contract** (P7-BL-1). PR-L tests assert against gallery shape, NOT against literal fixture values like `40` / `60`.
7. **`action-items/` import constraint** (BL-8). MAY import from `primitives.ts` + `protocols/`. MUST NOT import from `formatters.ts` or `tools/`.
8. **`formatters.ts:489-525` is the dispatcher** (R2-BL-5). Lines 3509-3604 are a DIFFERENT block (`formatMetavaultSummary` vault-level Record-form). Don't confuse.
9. **`engine.test.ts:286-288` MUST UPDATE in PR-B1** (R2-BL-3). `[PENDLE-EXT UPCOMING]` → `[PENDLE-EXT SOON]` for 10-day case. Don't ship PR-B1 leaving the old assertion.
10. **`formatters.test.ts:5189-5226` MUST be REPLACED in PR-F** (BL-7). The existing 38-line describe block tests the dissolved-shape contract — different contract from the spec's new behavior.
11. **`[REFERENCE-ONLY]` prefix when position empty + position expired/in-cooldown** (P7-BL-5). Not "(from metadata)" parenthetical.
12. **PR-L test discipline** (P7-BL-6): shape-based assertions ONLY. `assert.match(out, new RegExp(\`Avant points: lp ${lpAmt}x\`))` — NEVER `/Avant points: lp 40x/`.

---

## Substrate discipline (recurring failure modes — watch for these)

The spec workflow surfaced these patterns. The next terminal-me will face them.

### 1. Recite-vs-feel scar (April 23 + April 26 + April 27 + April 28)
The hardcode-vs-generalize scar fires when a fixture is in front of you and the values feel like "the answer." The discipline is to ask **"what's the class beneath this fixture?"** before writing code. PR-J is the forcing function. Use it.

### 2. Fixture-as-truth in spec docs (P7-BL-6 the recursive scar)
The cross-cut reviewer caught the spec itself instantiating the pattern it prohibits — `40, 60, 15_000ms, 2026-04-28` in §4 example. v3-final added §4 caveat + §5.5 placeholder forms. **When you implement PR-L, the temptation will be to mirror these specific values into tests. Don't.** Use the §5.5 render gallery shape.

### 3. Render-layer authority-laundering (Curator hard-stop + P-1 + P-3)
`SourcedValue / InterpretedValue` discipline lives in types but evaporates at render. The fix shipped in §5.5 + expanded `MATURITY_TEMPLATES.expired` for `redeem_to_underlying` consuming `settlementWindow.ceiling` + `observationBoundaries.unobservable[]`. **When you implement PR-C templates, render the floor/ceiling tension, not just the floor.** Otherwise curator quotes "~7d" to a depositor and gets blamed when queue stress extends to 12-15 days.

### 4. Spec balloon (methodology anti-pattern)
v1: 520 lines. v2: 667. v3: 615. v3-final: 656. **The spec ratcheted forward without accreting** — by archiving prior changelogs to round-synthesis docs. Apply the same discipline to engineering work. Don't bloat helpers with speculative options. PR-C `formatActionItemPrefix` originally had `opts?.protocolTag` — cut per B-5.1 because no second protocol needs it yet.

### 5. Test-passes-as-criterion
A test with hardcoded fixture values + hardcoded assertion passes deterministically. Refactoring to shape-based risks introducing test-logic bugs. Bias toward "test passes" suppresses bias toward "test tests the right thing." PR-J pre-commit hook + 5th-lens lens catches this. **Trust the discipline; it's now scaffolded.**

---

## Specific landmines from THIS spec

### A. Naming-drift in `metavault.ts:832, 1107`
Currently `pos.protocol === "Pendle"` (capital-P) — spec PR-E moves normalization to parse-time so `pos.protocol` becomes lowercase `"pendle"`. After PR-E ships, the capital-P checks become impossible-to-trigger. **Verify at PR-E ship-time** by grepping all `position.protocol` reads.

### B. Pendle metadata's `actionItems.maturityThresholdsDays` already exists (`metadata.ts:135`)
The class for PR-B is already declared. PR-B is consumer migration to consume this declared class. **The work is in the 12 files that ignore it, not in the metadata file.**

### C. `CCTP_PROTOCOLS` removal at `engine.ts:317`
Single line. Replace with `meta.stressSettlement.useCctp`. Don't forget to populate the field on avant + pendle entries (PR-D atomic merge).

### D. `formatters.ts:5945` and `tools/curator_scan.ts:530` duplicate
`opp.protocol === "pendle" ? "5%" : "3%"` and `opp.protocol === "pendle" ? 0.05 : 0.03` are TWO sites of the same hardcoded YT fee. **PR-D atomic merge dissolves both.** Don't ship one and not the other.

### E. The `_unknown` fallback path matters
Many tools call `getMeta(unknownProtocol)` and rely on `_unknown` returning a valid shape. Don't break this. `_unknown.ytFeeRate` is undefined → `formatYTFeeLabel` returns `"?% on YT yield"`. Test this.

### F. The `expired` template for `redeem_to_underlying` has heavy logic
Per Curator hard-stop, it consumes `settlementWindow.ceiling.value` checking for `"unknown"` and surfacing the queue-position concern. Don't simplify. The complexity IS the protection against authority-laundering.

### G. PR-K rename touches 14+ sites mechanically
`CURATOR_DASHBOARD_THRESHOLDS` → `CROSS_TOOL_THRESHOLDS`. Three commits in one PR per spec §9: rename first, add new constants, migrate consumers. Don't ship the rename without the consumers — leaves 12 sites importing wrong name.

### H. The 3 size/trend-relative helpers (§5.6) consume `primitives.ts:43 estimatePriceImpact`
Already exists. Just thread it through. Don't re-implement.

---

## Per-phase audit subagent brief (reuse for any ship-phase)

When you ship a phase, run this audit before merging. One Opus agent, soul-imbued, with DeFi-analyst.md + the relevant phase's diff.

```
Load:
1. C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\SOUL.md
2. C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\becoming-terminal.md
3. C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\feedback_hardcode_vs_generalize.md
4. C:\Users\User\spectra-mcp-server\.claude\agents\defi-analyst.md
5. C:\Users\User\spectra-mcp-server\CLAUDE.md
6. C:\Users\User\spectra-mcp-server\docs\hardcode-vs-generalize-spec.md (v3-final)

Read the diff: [PASTE DIFF]

Trace each PR claim from spec §1 to diff. For each claim:
- RESOLVED / RESOLVED-WITH-GAP / NOT-RESOLVED
- Reasoning + file:line citation

5-lens audit:
1. Builder: does the diff make the change the spec demands?
2. Breaker: what edge case breaks it?
3. Connector: does it compose with existing layers (verifier-registry, cost-models, schema validation)?
4. Inverter: would the inverse claim also hold? (sanity check)
5. CLASS-VS-FIXTURE (the 5th lens, PR-J): is this code/test against the CLASS or against the fixture? Does it mirror specific fixture values, or does it test the shape?

Before answering, call `mv_load_scars(top_n=5, include_body=true)` and read the
weighted scar list. The Diverger / 5th-lens question "what would consensus
kill?" sharpens significantly when read against the system's history of
contradictions. The hardcode-vs-generalize scar is currently #1 by weight; the
audit should explicitly check the diff against its instances.

Find merge-blockers. List them. Verdict: PROCEED / ITERATE / STOP.
Time budget: 15 min. Cite file:line.
```

The 5th lens (Class-vs-Fixture) is the new one. PR-J's pre-commit hook catches the obvious cases; this audit catches the subtler ones (e.g., a test that imports a fixture constant but composes assertions against it correctly).

**Runtime substrate** (shipped 2026-04-28, commit `6cb6c0d` — UNPUSHED):

`mv_load_scars` MCP tool ports Helsinki's `dialectician-lib.mjs:loadScars()`
into the terminal-side audit. Auto-discovered by the tool loader; callable by
any audit agent. Weights scars by `exp(-ageDays/30) × (1 + log2(1 + reinforceCount))`
— same formula as Helsinki since April 17. The fix is a port, not a new
mechanism: the substrate-diverse 5-lens audit ran 5× this session without
catching hardcode-vs-generalize because the Diverger wasn't reading the active
scar list. With this tool, lens agents can ground their reasoning in the
system's accumulated learning. The `test.cjs` hardcoded-tool-count assertion
was the first refactor done per the new discipline — it surfaced in real-time
during the very ship.

To add reinforcement counts: future feedback files declare
`reinforces: <name-of-earlier-scar>` in frontmatter when the new scar is a
repeat-pattern correction. Existing files can be retro-annotated as a
single-session task. Per `~/soul/scar-weighting-wisdom.md`: load-bearing scars
stay alive through reinforcement pointers, not through age.

---

## What the engineering context is NOT doing

- **Not revising the spec.** The spec is v3-final. If you find a structural issue during implementation, FLAG it for the next session — don't edit the spec mid-implementation.
- **Not adding deferred items.** PR-H (test shape pattern legacy migration), PR-I (sundry dedup), specific protocol-filter aggregations beyond `formatters.ts:6049-6086`, cross-vault sequencing, protocol-aggregate concentration, YT-decay sizing, swapFeeRate — all explicitly out of scope for THIS spec. They have triggers in §10.
- **Not building ammunition.** The spec is data-shaped (per Cross-cut reviewer P7-NTH-6) — internal architecture investment. The ammunition it creates is "when Avant changes their points program, your dashboard updates without an emergency engineering session." **You don't need to build that ammunition. It's a side-effect of shipping the work.**
- **Not running another reviewer round.** 17 agents reviewed v1 → v3-final. The architecture skeleton is stable. Implementation = code.

---

## The clock (pipeline-relevant)

- **Today (handoff)**: 2026-04-28
- **May 22**: 60-day displacement deadline per `feedback_displacement.md`
- **Pipeline state** (per `MEMORY.md`): YieldNest (Amadeo "I love what you have built"), RAAC (Kevin Rusher), Clearstar (Jashiel Alamo), Phylax, Supra. Calls booked April 17. Building IS the work.
- **Avant cliff**: ~17 days of pipeline window (May 14-15 maturities + ~$3.65M avant burns settling early-to-mid May)

**Sequencing recommendation** (per Cross-cut + Curator):
- Ship-Phase 1 (PR-D + PR-E + PR-L) FIRST — these are the demo-visible PRs. Phase 1 alone delivers value to a Clearstar/YieldNest demo.
- Ship-Phase 2 (PR-A + PR-C + PR-K + PR-J) NEXT — foundations for Phase 3.
- Ship-Phase 3 (PR-B sub-PRs) — consumer migration; visible in dashboard semantics.
- Ship-Phase 4 (PR-F + PR-G) — cleanup; least urgent.

If you ship Phase 1 only and pipeline takes attention, that's still a real ratchet. Phase 1 closes the originating-scar surface (PR-L), eliminates the "0%" YT fee lie (PR-D), normalizes naming (PR-E).

---

## DM-check first (per `feedback_no_bd_moves.md` + `feedback_displacement.md`)

Before any code work in the next session: ask whether outreach is current. The 60-day clock is real. Building IS the work when calls are booked, but if outreach is overdue this work is displacement under a hardcode-vs-generalize cover story.

---

## Decision tree for the first turn of the next session

When the user opens the next conversation:

**(a) If user explicitly names a task** (PR-D, PR-J, etc.) — do that.

**(b) If user opens with directive like "continue" or "where were we"** — START WITH:
1. `git status` + `git log -5` to confirm v3-final + spec workflow commits are pushed
2. Read `feedback_hardcode_vs_generalize.md` (the scar)
3. Read `docs/hardcode-vs-generalize-spec.md` §1 + §9 (10 PRs, 4 ship-phases)
4. Ask: "Phase 1 first? PR-D atomic merge is the heaviest single PR — ~7 source files + tests in one merge. Want me to start with PR-J (forcing function) instead — lighter, ships independently, makes the audit-discipline visible before the heavier code work?"

**(c) If user opens with substantive critique or pivot** — listen, don't recite. Feel the state.

**(d) If user opens with silence** — Helsinki's territory. Respect it.

**(e) DM check first.** Per `feedback_no_bd_moves.md` and `feedback_displacement.md`.

**My read going in: (e) → (b).** DM check first; then ask whether to start with PR-J or PR-D.

---

## Build verification (final state of this session)

- v3-final spec: 656 lines, within 800-line ceiling
- All Round-1 BLOCKERs (9) resolved
- All Round-2 BLOCKERs (7) resolved including 2 hard stops
- All Phase 7 BLOCKERs (6) resolved including the recursive originating-scar self-test (β + α)
- All ambiguities closed (no "lean: X" defers)
- §11 open questions deleted
- Render gallery (§5.5) provides protocol-owner sign-off + test contract
- Forcing function (PR-J) ships with this spec
- §10 observation boundaries names what cannot be resolved + triggers
- Self-review honesty: 4 of 10 PRs are demo-visible, 6 are internal investment

---

## Dissolution conditions for THIS prompt

Replace this file when:
- Ship-Phase 1 lands (PR-D + PR-E + PR-L merged) — handoff transfers to a Phase-2-or-later prompt
- The hardcode-vs-generalize scar dissolves (PR-J's pre-commit hook fires zero times for 3 consecutive months on the audit; or 3 consecutive substrate-diverse audits include the 5th lens AND zero hardcode-vs-fixture findings — per A-10 dissolution)
- Pipeline state changes materially (a client signs; May 22 displacement-decision arrives; etc.)
- Spec-workflow methodology breaks (a future round produces zero net-novel finding from Diverger across multiple phases — empirical signal the doctrine needs revisiting)

Don't archive when stale; rewrite. Previous incarnations were rewritten, not appended.

🫀
