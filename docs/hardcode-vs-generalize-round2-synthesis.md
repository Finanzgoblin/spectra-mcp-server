# Round 2 Convergent Findings — hardcode-vs-generalize-spec.md v2

**Reviewers**: A (Indigo+soul, Opus), B (Hyperyellow no-soul, Opus), C (Sonnet+soul), D (Sonnet no-soul)
**Verdicts**: A = ITERATE; B = STRUCTURALLY SOUND with minor revision; C = SHIP with 2 gaps; D = NEEDS REVISION (targeted)
**Date**: 2026-04-28
**Architecture skeleton**: STABLE (no reviewer flagged fundamental rethink — v3 trigger met per methodology)

---

## Resolution map across all 4 lenses

**Round-1 findings traced**: 40 distinct findings across A+B+C+D's lists. Resolution status:
- 36 RESOLVED outright
- 4 RESOLVED-WITH-GAP (A-3 protocol-filter scope, A-8 helper body stub, B-2.2 cross-validation location, B-7.1 PR-D atomicity wording, C-4 forcing function deferred, D-3 PR-E risk surface)

**All 3 Round-1 MERGE-BLOCKERs (B-2.2, B-3.2, B-6.1) RESOLVED.**
**All 9 Round-1 BLOCKERs (BL-1 through BL-9) RESOLVED.**

This is a real ratchet from v1.

---

## Round-2 BLOCKERs (must fix in v3)

### R2-BL-1: PointsMultiplier shape — 3-lens convergence on the same architectural gap

The spec adds `PointsMultiplier` interface in PR-L but doesn't specify how it interacts with three existing data shapes that the codebase carries.

**Convergence**: 3 lenses, distinct framings.
- **A-NEW-1**: existing `MultipliersSchema` is `z.union([z.array(MultiplierItem), z.object({lp?, yt?})])`. New `PointsMultiplier[]` flat-array-with-scope can't reconstruct `"lp [Avant points 40x] | yt [Avant points 60x]"` from object form without source-shape metadata.
- **B-NEW-3**: a THIRD shape — `Record<string, number>` from `mv.multipliers` (raw API) at `formatters.ts:3596-3601` — is not addressed by the spec's `Array | { lp; yt }` union.
- **D-G-1 + D-G-3**: `formatPointsMultipliers` body is `// ...` stub; merge rule between position-data and metadata is unspecified. Plus: existing `MultiplierItem = { name, amount }` shape (API-supplied) doesn't match new `PointsMultiplier = { program, scope, amount, source? }`. Translation layer missing.
- **C-Trap-1**: `source?` field optional without zod enforcement — discipline becomes theater if unpopulated.

**Resolution (D's engineering answer adopted)**:
1. **Merge precedence**: position-supplied multipliers are RUNTIME source; metadata is REFERENCE.
2. **Render rule**:
   - Position non-empty → render via existing dispatch (Array form OR object `{lp; yt}` form). Metadata `pointsMultipliers` is reference-only, not rendered.
   - Position empty + metadata non-empty → render metadata as `"[program] [amount]x (from metadata)"` to distinguish from position-verified.
   - Both empty → no Multipliers line.
3. **Three-shape union**: `formatPointsMultipliers(positionMultipliers, meta)` accepts `MultiplierItem[] | { lp?: MultiplierItem[]; yt?: MultiplierItem[] } | Record<string, number> | undefined` for position data. The new `PointsMultiplier[]` shape lives ONLY in metadata (where the schema layer can enforce `program`, `scope`, `amount`, `source`).
4. **`source` field zod-enforce**: required for non-`_unknown` protocols. Same discipline as `ytFeeRate`. Closes Trap-1.

### R2-BL-2: `requiresManualRollover: boolean` — 2-lens convergence on the binary collapse

The spec's binary `requiresManualRollover` is the scar firing on its own author — the same shape A-1 demanded the spec extend, but on a different axis.

**Convergence**: 2 lenses.
- **A-NEW-2**: three categories collapse: Pendle = manual_to_successor, Avant = burn_no_rollover (no rollover at all!), Spectra MetaVault = auto. Binary `requiresManualRollover: true/false` makes Avant indistinguishable from Pendle.
- **C-Trap-4**: `expired` maturity template ignores `meta` — has fixed `"Redeem and reallocate"` prose regardless of protocol. Avant's expired positions can't be freely "redeemed" — they're queued for ~1-week cooldown then claimed.

**Resolution**:
1. Replace `requiresManualRollover?: boolean` with:
```typescript
rolloverPolicy?: "auto" | "manual_to_successor" | "burn_no_rollover" | "unknown";
```
2. Update Avant entry: `rolloverPolicy: "burn_no_rollover"`.
3. Update Pendle entry: `rolloverPolicy: "manual_to_successor"`.
4. Update `MATURITY_TEMPLATES.expired` to read `meta.rolloverPolicy` — emit `"[EXPIRED] X has matured. Redeem and reallocate."` only when `rolloverPolicy === "manual_to_successor"`. For `"burn_no_rollover"`: `"[EXPIRED] X has matured. Burn-to-underlying queue: ${cooldown_days}d."`. For `"auto"`: `"[EXPIRED] X auto-rolled."`.
5. Same fix for `rollover` template (already partial).

### R2-BL-3: `engine.test.ts:286-292` will break — same blind-spot pattern as Round-1 BL-7

**Lens**: A-NEW-3 alone but verifiable.
- A traced the existing tests:
  - `it("emits UPCOMING between urgent and upcoming (10 days)", ...)` — currently asserts `[PENDLE-EXT UPCOMING]`
  - After PR-B1 ships 3-tier vocabulary: `ext(10)` returns `[PENDLE-EXT SOON]` ❌
- Same blind-spot as Round-1 BL-7 (PR-F false test claim).

**Resolution**: PR-B1 acceptance must explicitly list the test assertion updates:
- `engine.test.ts:286-288`: `[PENDLE-EXT UPCOMING]` → `[PENDLE-EXT SOON]` for the 10-day case.
- 30-day case still `[PENDLE-EXT UPCOMING]`.
- Add boundary tests at exactly 7, 14, 30 days (per Round-1 D-2b).

### R2-BL-4: Cross-validation location — circular-import risk

**Lens**: B-NEW-1 alone but architectural.
- Spec §6 places verifier cross-validation in `registry.ts validateAndWarn()`. This creates new import edge `registry.ts → verifier-registry.ts → avant-verifier.ts → engine.ts → ...`.
- B's path-of-least-resistance: put cross-validation IN `verifier-registry.ts` itself (already has duplicate-registration guard at lines 32-43; natural site). Imports `getMeta` from registry — one-way edge, leaf-side.

**Resolution**: §6 cross-validation moves to `verifier-registry.ts`. Pseudocode:
```typescript
// in verifier-registry.ts, AFTER BY_NAME IIFE
import { getMeta } from "./registry.js";

(function crossValidate() {
  for (const v of VERIFIERS) {
    const meta = getMeta(v.name);
    if (!meta.verifier) {
      throw new Error(`[verifier-registry] verifier "${v.name}" has no metadata.verifier`);
    }
    if (!meta.verifier.contracts || Object.keys(meta.verifier.contracts).length === 0) {
      throw new Error(`[verifier-registry] verifier "${v.name}" has empty contracts in metadata`);
    }
  }
})();
```

### R2-BL-5: HARD STOP — §2 dissolution table line reference WRONG

**Lens**: D HARD STOP-1.
- Spec §2 dissolution table cites `formatters.ts:3509-3604 formatMultipliers inline`.
- Verified: `formatMultipliers` lives at `formatters.ts:489`. Lines 3509-3604 are `formatMetavaultSummary`'s vault-level multipliers block with DIFFERENT data path (`mv.multipliers: Record<string, number>` raw API).
- A dev following the spec line reference would edit the wrong block and miss 9 call sites of `formatMultipliers`.

**Resolution**: Fix line references in §2:
- `formatters.ts:489-525` (the actual `formatMultipliers` function)
- `formatters.ts:3596-3601` (the vault-level `mv.multipliers` consumption — separate dissolution target with `Record<string, number>` shape)
- Both sites need PR-L migration; the vault-level site uses the third shape from R2-BL-1.

### R2-BL-6: HARD STOP — `PointsMultiplier.source.value` vs `amount` redundancy

**Lens**: D HARD STOP-2.
- v2 §3 declares `source?: SourcedValue<number>` where `value: number` duplicates `amount: number`.
- §4 Avant entry: `{ program: "Avant points", scope: "lp", amount: 40, source: { value: 40, sourceUrl, sourceVerifiedOn } }`.
- If `source.value !== amount`, which wins? Spec silent.

**Resolution**: Pin invariant — `source.value === amount` MUST hold; zod schema enforces. The `source` field exists for attribution metadata (sourceUrl + sourceVerifiedOn), NOT to disagree with `amount`. If the API later ships a multiplier where source-claim differs from on-chain-observed, that's a drift signal; render with `[CLAIMED:X, OBSERVED:Y]` annotation, but the canonical `amount` field reflects observed. Document this in §3 PointsMultiplier JSDoc.

### R2-BL-7: PR-G atomicity not declared explicitly

**Lens**: B-NEW-1 (cross-phase invariant gap).
- Spec §9 PR-G says "metadata population + cross-validation activation" but doesn't declare single-merge atomicity.
- If `meta.verifier` is added in commit-1 and cross-validation activated in commit-2, the intermediate state is fine. If cross-validation activates first (commit-1) before metadata populated (commit-2), all `npm test` runs that import `registry.ts` break.

**Resolution**: §9 PR-G acceptance text adds: "metadata `verifier:` population for avant + pendle AND cross-validation activation in `verifier-registry.ts` ship in single merge — atomic."

---

## Round-2 nice-to-haves (incorporate or defer)

| # | Finding | Lens | Action |
|---|---|---|---|
| R2-NTH-1 | A-NEW-4: BL-3 "fully resolved" too strong; `curator_scan.ts:582+, 600, 603, 681-682` filter sites scoped OUT of PR-D | A | Add explicit "scoped IN: formatters.ts:6049-6086. Scoped OUT: curator_scan.ts:582+ (trigger when 3rd protocol arrives)" to v3 §0 BL-3 row |
| R2-NTH-2 | D-3 RESOLVED-WITH-GAP: PR-E risk surface not named explicitly | D | Add "PR-E touches every `position.protocol` field in API responses; parse-time normalization is high-blast-radius" to §9 Ship-Phase 1 risk note |
| R2-NTH-3 | C-Gap-1: PR-L phase placement honesty (Phase 1 labeled "client-visible" but PR-L is maintenance, not demo-visible) | C | Add note to PR-L row: "originating-scar closure; not demo-visible (curator output identical unless inline values were stale)" |
| R2-NTH-4 | D-G-2: registry-load throw test infrastructure impact | D | Document in §9 PR-D + PR-G: "test fixtures for non-`_unknown` protocols MUST populate `ytFeeRate` (PR-D) and `verifier:` (PR-G) before merging" |
| R2-NTH-5 | D-G-4: PR-G cross-validation sequencing trap | D | Resolved by R2-BL-7 atomicity declaration |

---

## Convergence quality check

Per methodology: "Convergence via shared substrate is structural, not epistemic. Convergence via different framings is real signal."

| Finding | Shared substrate? | Distinct framings? | Real signal? |
|---|---|---|---|
| R2-BL-1 (PointsMultiplier shape) | Partial (3 read formatters.ts) | Yes — A: union, B: 3rd shape, D: stub-body, C: optional source | **Strong real signal — 3 lenses, distinct architectural gaps** |
| R2-BL-2 (rolloverPolicy enum) | Partial (2 read metadata.ts + tools/metavault.ts) | A: enum needed; C: template ignores meta | **Real signal — same axis, different angles** |
| R2-BL-3 (engine.test.ts) | No | A alone, verifiable | **High-confidence single-lens** |
| R2-BL-4 (cross-validation location) | No | B alone, architectural | **High-confidence single-lens** |
| R2-BL-5 (HARD STOP line ref) | No | D alone, verifiable | **HARD STOP — verifiable code error** |
| R2-BL-6 (HARD STOP source/amount) | No | D alone, structural | **HARD STOP — silent on invariant** |
| R2-BL-7 (PR-G atomicity) | No | B alone, structural | **High-confidence cross-phase** |

No false consensus. R2-BL-1 is the strongest convergent signal of the round.

---

## v3 plan

Per methodology Phase 6: "By v3, the architectural skeleton should be stable. If round-2 surfaced fundamental rethinks, you're still in early architecture; consider another round before stakeholder-utility review."

**Architecture is stable.** No reviewer flagged fundamental rethink. v3 incorporates:

1. **R2-BL-1**: PointsMultiplier shape — adopt D's engineering answer (position = RUNTIME, metadata = REFERENCE; 3-shape union for position data; new shape only in metadata; source zod-enforced).
2. **R2-BL-2**: replace `requiresManualRollover: boolean` with `rolloverPolicy: 4-way enum`. Update templates.
3. **R2-BL-3**: PR-B1 acceptance lists `engine.test.ts:286-288` assertion updates explicitly.
4. **R2-BL-4**: cross-validation moves to `verifier-registry.ts`.
5. **R2-BL-5 (HARD STOP)**: fix line references in §2 dissolution table — `formatters.ts:489-525` for the function, separate entry for `formatters.ts:3596-3601` vault-level Record-form path.
6. **R2-BL-6 (HARD STOP)**: pin `source.value === amount` invariant; document drift behavior.
7. **R2-BL-7**: §9 PR-G declare atomicity.
8. **R2-NTH-1 through 4**: incorporated as small notes.

**Length budget**: v2 was 667 lines. v3 ceiling per methodology is v2 + 30% = 867 lines. Conservative target: ~720-750 lines (the changes are tight refinements, not architectural additions).

**Cuts to make room**:
- §0 v1→v2 changelog can be archived (already in round1-synthesis.md).
- Replace with concise §0 v2→v3 changelog mapping each R2 finding to resolution.

**Decision required from Richard before v3 → Phase 7 (stakeholder-utility round)**:

Phase 7 is 5 parallel reviewer agents (4 stakeholder + 1 cross-cut). Cost-similar to Round 1 + Round 2 combined. The methodology says architectural rounds and stakeholder rounds answer different questions. After v3 (architectural skeleton stable), Phase 7 asks "does the output serve LP/Curator/Trader/Protocol Owner?"

Architecture is now solid enough that Phase 7 will produce useful structural findings (per methodology: "common stakeholder-utility findings to expect: one stakeholder type the spec ignores; attribution/citation creep; stakeholder X has 24/7 monitoring already").

**Recommended next step**: Draft v3 incorporating all R2 findings. Then ask Richard's go before Phase 7.
