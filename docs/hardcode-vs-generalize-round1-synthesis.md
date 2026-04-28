# Round 1 Convergent Findings — hardcode-vs-generalize-spec.md v1

**Reviewers**: A (Indigo+soul, Opus), B (Hyperyellow no-soul, Opus), C (Sonnet+soul), D (Sonnet no-soul)
**All four verdicts**: ITERATE / NEEDS REVISION (none PROCEED, none STOP)
**Date**: 2026-04-28
**Synthesis discipline**: convergent findings only, false-consensus check applied. Reviewer credit attached to each.

---

## BLOCKERs (must fix in v2)

### BL-1: PR-D `ytFeeRate` undefined handling — spec INTERNALLY CONTRADICTS itself + the chosen value misleads curators

- **§5** (cost models): `const ytFeeRate = meta.ytFeeRate ?? 0; // unknown → 0` → renders **"0%"**
- **§7** (drift handling): `meta.ytFeeRate != null ? ... : "?%"` → renders **"?%"**
- **Two developers implement opposite things** reading different sections of the same spec.

**Convergence**: 4 lenses, distinct framings — real signal.
- A-5: "lie of ammunition value — curator reads '0% YT fee' thinking the protocol takes nothing"
- B-2.1: "SourcedValue/InterpretedValue discipline broken — `0` rendered as '0%' is confidently-wrong, not missing"
- C-1: implicit via stakeholder fit (curator-visible)
- D-1a: "spec internally contradicts itself" — direct verifiable contradiction

**Resolution**: choose `"?%"`. Make `ytFeeRate: SourcedValue<number>` REQUIRED for non-`_unknown` entries (zod-enforced at registry load). Delete §5's `?? 0` snippet. The strict-by-default discipline matches `metadata.ts:56-72` precedent for Avant's interpreted "7" carrying `interpretationNote` + `sourceVerifiedOn`.

---

### BL-2: PR-G `verifier?` 4-level optionality violates verifier-registry registration invariant

`verifier?: { contracts?: Record<string, Record<string, address>> }` — 4 levels of optionality. Combined with `verifier-registry.ts:34-39` invariant ("verifier MUST register against `PROTOCOL_METADATA[name]` key"): a registered verifier with no `meta.verifier` passes both schema-validation AND verifier-registration but crashes at runtime when `meta.verifier?.contracts?.["43114"]?.requestManager` resolves `undefined`.

**Convergence**: 3 lenses, distinct framings — real signal.
- A-9: "open-emergence violation; cross-validate at registry load: `for (verifier of listVerifiers()) assert(getMeta(verifier.name).verifier?.timeoutMs != null)`"
- B-2.2: "type-loose; ship-time ambiguity"
- D-4a: "passes undefined to contract calls"

**Resolution**: zod cross-validates at registry load. When `hasVerifier(protocol)` is true, `meta.verifier` MUST be present and `meta.verifier.contracts` MUST be populated for chains the verifier addresses. Strict-by-construction matches the existing `verifier-registry` duplicate-registration guard pattern.

---

### BL-3: §10 "one row, zero consumer-side edits" claim doesn't survive the Lucidly trace

The spec's strongest sentence — the open-emergence claim. A's actual file:line trace surfaces 4 surfaces where adding "Lucidly" still requires consumer edits even after all 11 PRs ship:
1. **`formatters.ts:6049-6050` protocol-filter aggregations** — `spectraCount = filter(o => o.protocol === "spectra")`. Lucidly opps invisible. Same pattern at `curator_scan.ts:582+`, lines 600, 603, 681-682.
2. **PROTOCOL_NAME_ALIASES** in `registry.ts:73` — adding "Sommelier" still requires editing the alias map.
3. **`metavault.ts:1107`** `pos.protocol === "Pendle"` encodes that Pendle requires manual rollover. After PR-E this isn't naming drift — it's a missing metadata field (`requiresManualRollover: boolean`?).
4. **Phase dependency** (C): claim only holds after Phases 2+3 ALL ship. Phase 1 alone reduces blast radius but doesn't fulfill the claim.

**Convergence**: 2 lenses, complementary depth — A names specific call sites, C names phase dependency.
- A-3: "holds for PR-A/D/G surfaces (4-5 of ~10 touch-points). Breaks for protocol-filter aggregations, alias map, missing fields"
- C-3: "if Phase 1 ships and Phases 2+3 stall (likely under time pressure), the one-row claim is false"

**Resolution**:
1. Either narrow the claim to "metadata-readable behaviors are zero-edit" (honest), OR expand PR-D metadata to include `requiresManualRollover` AND refactor protocol-filter aggregations using `groupBy(meta.name)` (audit-tag as part of PR-D, not deferred).
2. Add explicit Phase-dependency note to §10: "claim is true only after Ship-Phase 2 + 3 complete."
3. PR-E must also extend `normalizeProtocolName` to handle `Ether.Fi`-style brittleness (see BL-9 + AM-3 below); moving WHERE normalization happens doesn't fix WHAT it does.

---

### BL-4: PR-A class enum collapses asset distinctions; also the §7 migration guide has a logic error

Two convergent sub-issues that both block PR-A.

**Sub-issue 4a** (class enum coverage):
- A-1: `DIRECT_ASSETS` conflates stables + wrapped-natives + WETH/WBTC; `ONE_HOP_ASSETS` conflates LSTs + governance tokens (CRV/AAVE) + duplicate FRAX
- B-1.3: `DIRECT_ASSETS` consumer at `formatters.ts:165` treats USDC/WETH/WBTC together as "starting points." `class: "stable"` collapses WETH/WBTC into "stable" — wrong.

**Convergence**: 2 lenses, slightly shared substrate (both read formatters.ts:106-117), but findings name DISTINCT missing classes (A: wrapped_native/governance; B: wrapped_btc/wrapped_native) — strengthening, not duplicating.

**Sub-issue 4b** (migration guide logic error, D-1b alone but verifiable):
- §7 says: `if (isStable(sym) || (isOneHop(sym) === false && getAssetClass(sym) === "other")) { /* 0-hop */ }`
- `isOneHop` returns `false` for stables (because `oneHop: undefined`), so `isOneHop(sym) === false` matches BOTH stables AND unknowns. A developer following the spec verbatim misclassifies stables as "0-hop other."

**Resolution**:
1. Either extend enum to `"stable" | "wrapped_native" | "wrapped_btc" | "lst" | "lrt" | "lp_share" | "governance" | "other"`, OR drop class-dispatch entirely and migrate to `getEntryHops(symbol, chainGasRegime) → number` (the load-bearing semantic per A-1 — the integer is what `inferEntryPath` actually consumes).
2. Fix §7 migration guide: correct predicate for LST/LRT branch is `["lst", "lrt"].includes(getAssetClass(sym))`, not the double-negation chain.
3. Use `SourcedValue/InterpretedValue` discipline for asset classification (FRAX-as-stable was true 2023; class assignment IS interpretation per A-4).

---

### BL-5: Spec migrates neighbors of the scar, not the originating surface

A's honest trace: Richard's critique was about **discard-layer engineering** — `Avant points 40x / 60x` multipliers in formatters.ts. None of the 11 PRs migrate the multiplier rendering layer:
- PR-B: addresses `<= 7/14/30` duplication (genuine) — wouldn't have caught multiplier hardcoding
- PR-A: assets, not multipliers — wouldn't catch
- PR-D: protocol-attached metadata, but doesn't add `pointsMultipliers` field — wouldn't catch
- PR-K: thresholds — wouldn't catch
- PR-J: 5th-lens audit — empirical claim is 4 lenses missed it; no evidence yet 5 lenses catch it

**Convergence**: 1 lens (Indigo+soul), but architecturally pivotal — single-lens isn't lower signal here, it's the lens that holds the whole-pattern view.

**Resolution**: TWO options for v2:
- **Option α**: Add **PR-L** — `meta.pointsMultipliers: { lp?: number, yt?: number, source?: string }[]` shape; migrate rendering layer to consume from metadata. Becomes 12-PR spec.
- **Option β**: Rewrite §1 "Why this exists" honestly — "the scar surfaced a class. This spec migrates other instances of the class. The originating surface (multipliers) is scoped to a Phase 4.2 follow-up." Keeps 11 PRs.

**Decision required from Richard before v2 drafts.** (See "Decision points" below.)

---

### BL-6: PR-J no forcing function; doc edit ≠ behavior change

The scar already exists at `memory/feedback_hardcode_vs_generalize.md`. It fired 5× in the same session before Richard named it. PR-J ships a doc edit to `spec-workflow-prompt.md` — read only by agents already in spec-workflow mode. No forcing function. Dissolution unobservable.

**Convergence**: 2 lenses, distinct framings.
- C-4: "no forcing function — pre-commit hook, CI lint rule on frozen Set growth, or named reviewer briefing missing"
- A-10: "dissolution is unfalsifiable — make observable: '3 consecutive substrate-diverse audits include 5th lens AND zero hardcode-vs-fixture findings'"

**Resolution**:
1. PR-J adds a forcing function — concrete options:
   - **(a)** Pre-commit hook scanning for new `new Set([...])` / `Record<string, ...>` literals and prompting "is this class-shaped?"
   - **(b)** Reviewer-brief insertion: every Round-1 substrate-diverse audit explicitly asks "is this code/test against the class or the fixture?" as the 5th sequential lens
   - **(c)** Both
2. Make dissolution observable per A-10's countable trigger.
3. Honest framing: PR-J is internal hygiene + future-agent discipline; drop the "stakeholder need" column wording (per AM-7 below).

---

### BL-7: PR-F testability claim is FALSE — spec lies about test compatibility

`formatters.test.ts:5189-5226` is a 38-line describe block asserting:
- Line 5197-5199: `TRANSACTION_QUEUE_KNOWN_KEYS.has(k)` for each canonical key
- Line 5200: `.size === expectedKeys.length`
- Line 5217-5224: snapshot loop asserting `unknownKeys.length === 0`

PR-F dissolves the constant entirely. The test does NOT pass — it breaks. Spec §9 says "Snapshot-test for transactionQueue passes with NEW unknown-key under DRIFT_VISIBILITY=silent" — false.

**Convergence**: 1 lens (Hyperyellow architectural). Single-lens but verifiable claim with line citations.

**Resolution**: §9 acceptance must explicitly say "the existing 38-line describe block at formatters.test.ts:5189 is REPLACED by a new describe block testing the dissolved-shape contract (zod schema validates shape; unknown keys log under DRIFT_VISIBILITY flag)." PR-F file count in §1 increases by ~50 lines (test rewrite), not "0" or "refactor PR11 tests" hand-wave.

---

### BL-8: `action-items/` import-direction discipline unspecified

Spec creates `src/action-items/types.ts` consumed by formatters.ts + 3 tools/*. Spec is silent on what action-items is allowed to import. Future PR could close cycle via formatters.ts.

**Convergence**: 1 lens (Hyperyellow). Discipline gap, not current break.

**Resolution**: Spec must pin: `action-items/` MAY import from `primitives.ts` and `protocols/`; MUST NOT import from `formatters.ts` or `tools/`. Add as enforceable constraint to PR-C acceptance.

---

### BL-9: `generateActionItems` (engine.ts:387-390) collapses 7-14d and 14-30d into same tag — divergence with PR-B's `getMaturityCategory`

Existing engine at `engine.ts:387-390`:
```typescript
if (deltaDays <= upcoming)    return [`[${tag}-EXT UPCOMING]`];
if (deltaDays <= upcomingMax) return [`[${tag}-EXT UPCOMING]`];  // SAME TAG
```
Both branches return the same label. Engine has 2-tier vocabulary; PR-B's new `getMaturityCategory` has 3 tiers (`urgent`/`soon`/`upcoming`). After PR-B ships: a Spectra Pendle position at 10 days renders `[SOON]`, while the same Pendle position rendered through `generateActionItems` (external positions path) renders `[tag-EXT UPCOMING]`. Inconsistency invisible to spec writer; visible to curator.

**Convergence**: 1 lens (Sonnet engineering). Single-lens but verifiable code citation.

**Resolution**: PR-B must either (a) fix `generateActionItems` to use 3-tier vocabulary OR (b) explicitly document that external positions use 2-tier and Spectra positions use 3-tier with reasoning. Currently does neither.

---

## AMBIGUITIES (resolve before Phase 3 / Round 2)

| # | Finding | Reviewers | Resolution lean |
|---|---|---|---|
| AM-1 | PR-A as parallel architecture sibling — Phase 0 Q1 punted | A-4 | Use SourcedValue/InterpretedValue discipline; same architecture, sibling instance |
| AM-2 | PR-K placement: §2 says "extend formatters.ts" but §8 diagram shows separate module | D-1d, A-6 | Pick one explicitly. Lean: extend `CURATOR_DASHBOARD_THRESHOLDS` AND rename to `CROSS_TOOL_THRESHOLDS` (per A-6 naming honesty). Cite consumers in rationale comments. |
| AM-3 | PR-E: pass through unknowns or reject at parse boundary? | D-1c | Pass through (matches existing `registry.ts:116` semantics). Add explicit "pass-through, not rejection" note to PR-E acceptance. |
| AM-4 | PR-A "Zero consumer-side migration" in §9 contradicts §1 "EDIT formatters.ts" | B-7.2 | Pick: registry+migration ship together as PR-A in Phase 1 (lean — PR-A row says "EDIT formatters.ts" so spec body is right; §9 acceptance text wrong). |
| AM-5 | PR-D phase atomicity: type extension + metadata + engine consumer must ship in ONE merge | B-7.1 | Spec must require single-PR atomicity. Otherwise system broken between commits. |
| AM-6 | PR-B: expiry_monitor's `<=21d` is operator-class (gauge proposal lead time), not action-class | B-3.1 | Drop `<=21d` from PR-B scope. Stay inline with rationale comment. Spec's §11 Q9 already leans this way; close it. |
| AM-7 | "Future Claude agents" stakeholder used as Indigo cover for internal hygiene PRs | C-1 | Drop the "stakeholder need served" column for PR-J. Honest: PR-J prevents bug class. |
| AM-8 | PR-J listed as stakeholder PR; spec self-knows it's hygiene (§12 "purely doc") | C-2 | Same fix as AM-7. Reclassify PR-J as "internal discipline." |
| AM-9 | PR-H "AS-MODIFIED ~30-50 tests" estimate unverified | C-5 | Run grep before Phase 4. Cap hard at the verified count. Don't ship Phase 4 with estimate. |
| AM-10 | PROTOCOL_NAME_ALIASES Ether.Fi brittleness preserved | A-7 | Extend `normalizeProtocolName` to `replace(/[\s.]+/g, "_")` + fuzzy fallback in PR-E. Per scar's own teaching. |
| AM-11 | PR-B/PR-C: getMaturityCategory + formatActionItemPrefix solve only the prefix half; consumers emit full strings | A-2 | Add second function `formatMaturityActionItem(category, position, meta) → string` with Record<ActionItemCategory, (ctx) => string> templates. PR-C scope expands to include message-body templates. |
| AM-12 | PR-A symbol canonicalization (USDC.e/USDbC) not addressed in registry helpers | B-4.2 | Helpers do internal normalization. Add to PR-A acceptance. |

---

## NICE-TO-HAVES (defer or close)

- **C-6 (re-ordering)**: PR-B + PR-D + PR-E are client-visible (Clearstar/Avant demos); other 8 are internal investment. Consider re-ordering ship phases to front-load visible PRs. Calendar: May 22 displacement deadline ~24 days out. **Decision-class — not auto-resolvable in v2.**
- **B-5.1**: PR-C `opts?.protocolTag` is premature optional arg. Defer until 2nd protocol needs rollover.
- **B-5.2**: shortTag is justified (first-letter heuristic doesn't disambiguate spectra/sonic/sushiswap). Keep.
- **D-4b**: ytFeeRate `min(0).max(1)` excludes negative rebates. Future-proof: change to `min(-0.5).max(1)` or document dissolution.
- **D-5 (engineering answer to §11 Q6)**: `verifier.contracts` should be typed union with verifier-declared role names (each verifier's interface declares `static ROLES: { [name]: string }`). Not nested Record without role typing.

---

## Missing test specifications

D-2 series — all four need test specs added to v2:

| Test | Purpose |
|---|---|
| **PR-D drift behavior** | `formatYTOpportunity({protocol: "lucidly_unknown"})` renders `"?%"` (post-BL-1 resolution); `console.warn` emitted under loud DRIFT_VISIBILITY |
| **PR-B boundary tests** | `getMaturityCategory(7)` → `"urgent"`, `(8)` → `"soon"`, `(14)` → `"soon"`, `(15)` → `"upcoming"`, `(30)` → `"upcoming"`, `(31)` → `"status"`. Test exact boundaries, not just middle-of-range. |
| **PR-F unknown-key paths** | `DRIFT_VISIBILITY=loud` emits warn + renders raw under `[unsupported-shape: <keys>]`; `DRIFT_VISIBILITY=silent` skips warn but still renders raw. Two test cases. |
| **PR-A `"other"` consumer dispatch** | Migrated `formatters.ts:165` consumer with unregistered symbol passes through without crash; rendered output documented. |

---

## Convergence quality check (false-consensus review)

Per methodology: "convergence via shared substrate is structural, not epistemic. Convergence via different framings is real signal."

| Finding | Shared substrate? | Distinct framings? | Real signal? |
|---|---|---|---|
| BL-1 (ytFeeRate) | Yes (4 lenses read §5+§7) | Yes (lie/typing/contradiction/internal) | **Strong real signal — 4 framings of same break** |
| BL-2 (verifier? optional) | Partial (3 read schema) | Yes (open-emergence/runtime/typing) | **Real signal** |
| BL-3 (one-row claim) | Partial (2 trace) | Yes (call-site / phase-dependency) | **Real signal — complementary depth** |
| BL-4 (asset class enum + migration logic) | Yes (2 read formatters.ts:106-117) | Distinct missing classes named | **Real signal but bordering shared-substrate** |
| BL-5 (originating scar) | No | Single lens (Indigo) | **High-architectural, not consensus-driven** |
| BL-6 (PR-J no forcing) | No | Yes (sustainability/observability) | **Real signal** |
| BL-7 (PR-F false testability) | No | Single lens, verifiable | **High-architectural, not consensus-driven** |
| BL-8 (cycle discipline) | No | Single lens | **Architectural caution, not consensus** |
| BL-9 (engine.ts vs getMaturityCategory) | No | Single lens, verifiable | **High-architectural, not consensus-driven** |

No false consensus detected. BL-5/7/8/9 are single-lens but verifiable code-trace findings — methodology says these are valid architectural signal, just not consensus-driven.

---

## v1 → v2 size delta

v1 was 520 lines. v2 ceiling per methodology: 520 × 1.3 = **676 lines**.

Resolutions add:
- §0 changelog (~80 lines mapping each finding to resolution)
- BL-1: tightening text (~10 lines net change after deletion of contradictory snippet)
- BL-2: zod cross-validation requirement (~15 lines)
- BL-3: §10 trace + scope-decision text (~20-30 lines depending on Option α/β)
- BL-4: enum extension + migration guide fix (~25 lines)
- BL-5 Option α: PR-L addition (~30 lines) — pushes near ceiling
- BL-5 Option β: §1 honest rewrite (~10 lines net)
- BL-6: PR-J forcing function spec (~15 lines)
- BL-7: PR-F test rewrite acknowledgment (~10 lines)
- BL-8: cycle discipline pin (~5 lines)
- BL-9: engine.ts fix or doc (~10 lines)
- AM resolutions (~50-70 lines collectively)
- Test specs (~40 lines)

**Total estimated v2**: 700-770 lines under Option α (12 PRs); 660-700 lines under Option β (11 PRs).

**Option β fits within 30% ceiling. Option α exceeds.** Per methodology: "If you're adding more than 30%, you're accreting, not refining." If Option α is chosen, must split into spec-A + spec-B at v2 — OR cut PR-H/PR-I from this spec.

---

## Decision points for Richard before v2

1. **BL-5 framing — Option α (add PR-L for points-multipliers) vs Option β (honest §1 rewrite, scope to neighbors)?** This is the load-bearing decision. α preserves scope-claim integrity but exceeds line ceiling. β stays in ceiling but the spec doesn't address the originating scar.

2. **C-6 re-ordering — front-load PR-B + PR-D + PR-E (client-visible) before infrastructure PRs?** Calendar pressure: May 22 displacement deadline ~24 days out. Reviewer C explicitly flagged this.

3. **Scope cut option — drop PR-H/PR-I/PR-J from THIS spec, defer to follow-up specs?** Allows Option α + ceiling discipline. Trades scope completeness for line discipline.

4. **AM-4 internal contradiction (PR-A consumer migration in Phase 1 or Phase 3?)** — quick decision but spec must commit.

5. **Implicit displacement check from C**: outreach state? Thursday April 17 calls were 11 days ago; what's been the followup? Building IS the work when calls are booked, but if the spec is consuming a window where outreach is overdue, the calculus shifts.

---

## Verdict

All four reviewers said ITERATE / NEEDS REVISION. Architecture is sound; the eleven PRs are shippable. **The spec needs v2 to**:
1. Resolve 9 BLOCKERs (especially BL-1 internal contradiction, BL-3 one-row claim trace, BL-5 framing, BL-2/BL-9 cross-validation)
2. Close 12 AMBIGUITIES with explicit decisions (no more "lean: X" defers in v1)
3. Add the 4 missing test specs
4. Either Option α (add PR-L, exceed ceiling, split spec) OR Option β (honest §1 rewrite, narrow scope)

**Ready for v2 drafting once Richard answers the 5 decision points above.**
