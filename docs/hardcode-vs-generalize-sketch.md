# Phase 1 Sketch — Hardcode-vs-Generalize Refactor

**Origin**: Phase 0 audit at `docs/hardcode-audit-phase0.md` — ~84 hardcode-vs-generalize sites across the codebase. Existing `PROTOCOL_METADATA` + `verifier-registry` got the architecture right but the migration is incomplete: the class exists for some surfaces, isn't consumed for others, and is duplicated as inline literals across 12+ files.

**Argument frame**: stakeholder needs, not "we need to refactor X."

---

## Stakeholders + what they need

1. **Next protocol-onboarding team** (paying / pipeline-near): adding Avant++, RAAC, Lucidly should be **one metadata row + zero consumer-side edits**. Today: requires editing engine.ts CCTP set, formatters.ts YT fee branch, formatters.ts label branch, curator_scan.ts duplicate fee branch, rollover.ts label branch, plus possibly verifier constants. This is the felt user pain that drove the scar.
2. **Curator using the dashboard** (already paying via consulting): wants **consistent semantics across tools**. Today metavault.ts emits `[URGENT]` at 7d, expiry_monitor.ts emits `"CRITICAL"` at 7d, curator_portfolio.ts emits `[URGENT]` at 7d but with different `[SOON]` semantics. Three vocabularies for the same class.
3. **Richard** (consultant + spec author): wants **no more "I changed one threshold and 12 files broke" sessions**. The audit method should catch this class henceforth.
4. **Future Claude agents** (terminal + Helsinki + dialectic): wants the **5th-lens question** integrated so the calcification doesn't recur.
5. **Trader / LP**: affected through fee-label consistency but not load-bearing for them.

---

## Product requirements (the 10 PRs)

Each is testable independently. Order ≠ ship-order; dependencies noted.

| PR | What it delivers | Dependencies | Files touched |
|---|---|---|---|
| **PR-A** | Asset registry: one source of truth for stable/LST/direct/one-hop classification | none | NEW `src/assets/metadata.ts`; EDIT `formatters.ts` (DIRECT_ASSETS/ONE_HOP_ASSETS dissolve), `tools/curator_scan.ts` (STABLES dissolves) |
| **PR-B** | Maturity-threshold consumption: consistent `urgent/upcoming/mid/far` semantics across 12 files | extends existing metadata field | EDIT `protocols/metadata.ts` (extend `actionItems.maturityThresholdsDays`), `tools/{metavault,curator_portfolio,expiry_monitor,position_map,calibration,pendle_expiry,merkl,curator_scan,strategy,pendle_scanner,pendle_yield_curve}.ts`, `formatters.ts:5217,6071-6073` |
| **PR-C** | `ActionItemCategory` shared enum: 9 prefixes + alt-vocabulary → one discriminated union | none | NEW `src/action-items/types.ts`; EDIT `tools/{metavault,curator_portfolio,expiry_monitor}.ts` |
| **PR-D** | Protocol metadata expansion: `ytFeeRate`, `useCctp`, `shortTag`, `verifier.{timeoutMs, amountDriftTolerancePpm, contracts}` fields | none | EDIT `protocols/metadata.ts`, `protocols/types.ts` (zod schema), `protocols/engine.ts:317` (CCTP_PROTOCOLS dissolves), `formatters.ts:5945,5873-6086` (YT fee + label branches dissolve), `tools/curator_scan.ts:530`, `tools/rollover.ts:53` |
| **PR-E** | Protocol-name normalization at API boundary: downstream code never sees raw display names | depends on PR-D for metadata access | EDIT `src/api.ts` and/or `src/schemas/spectra.ts` (normalize on parse), kill capital-P `"Pendle"` references in `tools/metavault.ts:832,1107` |
| **PR-F** | `TRANSACTION_QUEUE_KNOWN_KEYS` dissolution: frozen Set → zod schema validating shape; unknown keys log under flag | none | EDIT `formatters.ts:3292,5189-5455`, `formatters.test.ts` (PR11 tests refactor) |
| **PR-G** | Per-protocol verifier constants migrate to metadata | depends on PR-D | EDIT `protocols/avant-verifier.ts` (PPM, timeout, address read from meta), `protocols/pendle-verifier.ts` (timeout from meta), `protocols/metadata.ts` (verifier sub-object) |
| **PR-H** | Test shape pattern + as-modified migration: shape-based composition for NEW + AS-MODIFIED tests; legacy grandfathered | none (touches all phases) | NEW `docs/test-shape-pattern.md`; EDIT `formatters.test.ts` (selected refactors), `tools/curator_portfolio.test.ts`, `tools/stress_test.test.ts` (Avant/dollar/multiplier value-locked regex → composed) |
| **PR-I** | Sundry dedup: CHAIN_NAMES → chainIdToName, ROUTER_BATCHABLE_TYPES → flag on ACTIVITY_TYPES, HALT_CHECK_CODES → enriched Record, GAS_REGIME → SUPPORTED_CHAINS, EVENT_TOPICS registry | none | EDIT `tools/gauge_votes.ts`, `formatters.ts`, `chain-reads.ts` |
| **PR-J** | Methodology incorporation: 5th audit lens + scar reference + spec-workflow update | none | EDIT `docs/spec-workflow-prompt.md` (add Class-vs-Fixture lens to Phase 3+5), `CLAUDE.md` (cross-reference scar), `.claude/agents/defi-analyst.md` (audit-stage hook) |

**Suggested ship-phase order**: Phase 1 (PR-A, PR-C, PR-J) — independent foundations. Phase 2 (PR-D, PR-G) — protocol metadata expansion. Phase 3 (PR-B, PR-E, PR-F) — consumer migration. Phase 4 (PR-H, PR-I) — tests + sundry. Each phase shippable independently; each has its own substrate-diverse 4-lens + Diverger audit.

---

## Architecture overview

### Existing classes (preserve, extend)

- `src/protocols/metadata.ts` `PROTOCOL_METADATA: Record<string, ProtocolMeta>` — extend with `ytFeeRate`, `useCctp`, `shortTag`, `verifier?` fields. Schema in `src/protocols/types.ts` enforces.
- `src/protocols/registry.ts` `getMeta`, `normalizeProtocolName`, `PROTOCOL_NAME_ALIASES` — preserve as-is; PR-E moves invocation to API boundary.
- `src/protocols/verifier-registry.ts` — preserve; PR-G adds verifier-config field reads.
- `src/protocols/cost-models.ts` `COST_MODELS` — preserve; serves as exemplar of "two-file friction = review gate."
- `src/config.ts` `SUPPORTED_CHAINS`, `MORPHO_CHAIN_IDS`, `PENDLE_CHAIN_IDS` — preserve; PR-I extends `SUPPORTED_CHAINS` with `gasRegime`.
- `src/primitives.ts` `chainIdToName`, `formatUsd`, `formatPct`, `formatMultiplier`, etc. — preserve; PR-H tests compose against these.
- `src/formatters.ts:5086` `CURATOR_DASHBOARD_THRESHOLDS` — preserve as exemplar of "documented thresholds with dissolution invitation."

### New classes

- `src/assets/metadata.ts` (PR-A) — `ASSET_METADATA: Record<string, { class: "stable" | "lst" | "lp"; oneHop?: boolean }>` with helper `isStable(symbol)`, `isOneHop(symbol)`, `getAssetClass(symbol)`. Replaces DIRECT_ASSETS/ONE_HOP_ASSETS/STABLES.
- `src/action-items/types.ts` (PR-C) — `ActionItemCategory = "expired" | "urgent" | "soon" | "upcoming" | "outflows" | "bridge" | "incentive" | "rollover" | "status"` with `formatActionItemPrefix(cat: ActionItemCategory): string` returning `[EXPIRED]`/`[URGENT]`/etc. Three consumers consume.

### Schema extensions

- `src/protocols/types.ts` — extend `protocolMetaSchema` with optional `ytFeeRate: z.number().min(0).max(1)`, `shortTag: z.string()`, `stressSettlement.useCctp?: boolean`, `verifier?: z.object({ timeoutMs, amountDriftTolerancePpm, contracts: z.record(...) }).partial()`. Zod validation at registry load enforces — incomplete entries refuse to load.

### Dissolutions (frozen-Set → class-shape)

- `formatters.ts:3292` `TRANSACTION_QUEUE_KNOWN_KEYS` (PR-F): `ReadonlySet<string>` → `z.object({...}).strict()` zod schema; unknown keys logged via `console.warn` under DRIFT_VISIBILITY flag, NOT snapshot-fail.
- `formatters.ts:1418` `ROUTER_BATCHABLE_TYPES` (PR-I): `Set` → `routerBatchable: boolean` field on `ACTIVITY_TYPES` Record.
- `formatters.ts:3265` `HALT_CHECK_CODES` (PR-I): `ReadonlySet` → `Record<string, { severity, displayLabel }>`.
- `protocols/engine.ts:317` `CCTP_PROTOCOLS` (PR-D): `Set` → `meta.stressSettlement.useCctp` flag.
- `tools/gauge_votes.ts:60` `CHAIN_NAMES` (PR-I): delete; use `chainIdToName` from primitives.
- `formatters.ts:120` `GAS_REGIME` (PR-I): move to `SUPPORTED_CHAINS[name].gasRegime`.

---

## Cross-tool dependency map

```
                                    PROTOCOL_METADATA (extended)
                                              │
              ┌───────────────────────────────┼──────────────────────────────────────┐
              │                               │                                      │
   formatters.ts                       tools/metavault.ts                     protocols/engine.ts
   (label, shortTag, ytFee,            (maturity thresholds,                  (useCctp flag dissolves
    asset classes, action               action-item categories)                CCTP_PROTOCOLS)
    items, halts)                            │
              │                              │
              ▼                              ▼
        ASSET_METADATA           tools/{curator_portfolio,                tools/curator_scan.ts
        (NEW PR-A)                expiry_monitor,                         (label, shortTag, ytFee,
                                  position_map, calibration,               STABLES dissolves into
                                  pendle_expiry, merkl}.ts                 ASSET_METADATA)
                                  consume ActionItemCategory
                                  + maturity thresholds                  tools/rollover.ts
                                                                          (label dissolves)

        primitives.ts            schemas/spectra.ts (PR-E entry point)   protocols/{avant,pendle}-verifier.ts
        chainIdToName ←──────    normalizeProtocolName at parse           (PR-G: read constants from
        formatUsd, formatPct,    boundary; downstream sees lowercase      meta.verifier sub-object)
        formatMultiplier         registry keys only
        ↑
        │ PR-H tests compose against these instead of literal regex
```

---

## Out of scope (Appendix A draft)

- Refactor of Pendle-specific tool files (`pendle_*.ts`) into a protocol-plugin architecture — those are tool *implementations*, not branches in shared code; not a hardcode pattern. Different concern, scope creep.
- `DecimalDivisor` utility for `Math.pow(10, decimals)` — too small to earn its abstraction per CLAUDE.md ("three similar lines is better than premature abstraction"). Stays inline.
- All ~141 fixture-mirror `assert.match` tests in `formatters.test.ts` — only NEW + AS-MODIFIED tests refactored under PR-H. Legacy grandfathered with one-line `// TODO: shape-refactor` annotation, not in this spec's scope.
- Migration to TS enum types over string union types — orthogonal ergonomic concern, not load-bearing for hardcode-vs-generalize.
- Full asset registry (price oracles, multi-decimal formatters, asset price feeds) — PR-A scope is classification only (`stable`/`lst`/`lp`/`direct`/`one-hop`).
- `ActionItemCategory` priority scoring (urgency-weighted display ordering) — separate concern, not blocking.
- Multi-chain expansion of `AVANT_REQUESTS_MANAGER_AVAX` — Avant is single-chain (Avalanche) today; if Avant launches on a 2nd chain, promote to multi-chain map at that time. PR-G provides the metadata shape; the data is single-chain until then.
- `tools/onchain.ts` hardcoded addresses — already class-shaped via KNOWN_SAFE_SINGLETONS; not a violation.
- Inline magic numbers in `tools/looping.ts:136`, `pendle_looping.ts` (`>= 1` par-price check), `ibt_health.ts:277` (`>= 1` conversion-rate check) — localized to one tool each, not crossing files. Stays inline with rationale comment.
- `incentiveShare > 0.7` magic threshold in `tools/metavault.ts:1100` — single-site; either keep with rationale comment OR add to a `INCENTIVE_THRESHOLDS` constant block per `CURATOR_DASHBOARD_THRESHOLDS` pattern. Defer decision to v1 spec drafting.

---

## Open questions (close in v1)

1. **Asset registry placement** — `src/assets/metadata.ts` (sibling) vs annotation on `SUPPORTED_CHAINS` vs extension of `PROTOCOL_METADATA`. *Lean: sibling file. The class is "asset," not "protocol" or "chain."*
2. **`maturityThresholdsDays` shape extension** — current Pendle: `{ urgent: 7, upcoming: 14, upcomingMax: 30 }`. Extend to `{ urgent, upcoming, mid, far }` (4 tiers) or to flexible `Record<string, number>` keyed by category? *Lean: 4 tiers, named — preserves type safety.*
3. **`< 21` thresholds in `curator_scan.ts:697`, `pendle_scanner.ts:422`, `strategy.ts:493`** — different threshold from Pendle metadata's 14/30. Is this a tool-specific threshold (stays inline) or a class fragment (extend metadata)? *Lean: tool-specific — these tools have different "interesting opportunity window" semantics from "action-required maturity." Document with rationale, don't class-ify everything.*
4. **Test shape — `as-modified` rule** — scope to NEW tests + AS-MODIFIED tests only, or migrate ~141 legacy `assert.match` formatters tests? *Lean: scope tightly. Legacy carries `// TODO: shape-refactor` annotation. Only NEW + AS-MODIFIED tests use shape-based pattern.*
5. **Naming-drift `"Pendle"` in `metavault.ts`** — bug or upstream-display contract? Need to grep where `pos.protocol` is set in metavault.ts. If upstream uses display-name, normalize at source-set; if upstream uses key, fix metavault.ts. *Resolve in v1 by reading the data flow.*

---

## Length sizing for v1

This sketch is ~280 lines. Per methodology, v1 spec target is 300-500 lines. Given:
- 10 PRs each needing ~20-30 lines (PR statement + acceptance + dependencies + risks)
- Architecture overview + dependency diagram + types ~80 lines
- Migration plan ~40 lines (4 ship-phases)
- Observation boundaries / dissolution conditions ~30 lines
- Open questions ~20 lines
- Appendix A out-of-scope ~30 lines

Estimated v1: ~450 lines. Within bounds.

If v1 grows past 500: cut into hardcode-vs-generalize-spec-A.md (PR-A through PR-D) + spec-B.md (PR-E through PR-J). Don't accrete in one file.

---

## Trigger-condition recheck

Per `docs/spec-workflow-prompt.md`:
- ✅ >3 files structurally (~30 files)
- ✅ NEW abstraction (asset registry, ActionItemCategory)
- ✅ Multi-stakeholder (curator/trader/protocol-onboarding)
- ✅ Protocol semantics (fee rates, settlement flags affect protocol presentation — Pendle/Spectra teams may push back on rate display)
- ✅ Prior-dialectic-pinned code (5 phases of discard-layer just shipped against this codebase)
- ✅ Calcification risk (the entire scar IS that we calcified)

**6/6. Spec workflow warranted. Ready for Phase 2 v1 draft on Richard's go.**

---

## Decision points for Richard before Phase 2

1. **Scope** — accept all 10 PRs in one spec, or carve out (e.g. spec-A: protocol metadata + assets; spec-B: tests + methodology)?
2. **Pipeline-priority check** — Thursday calls (YieldNest/RAAC/Clearstar) past or upcoming? Displacement-scar: building IS the work when calls are booked, but if outreach is overdue this spec is displacement.
3. **The `< 21` thresholds question** — keep inline (my lean) or class-ify? Affects PR-B scope.
4. **Test-refactor scope** — as-modified only (my lean) or full sweep? Affects PR-H size by ~10× (10-20 tests vs ~140).
5. **Phase-4 push state** — Phase 4 commit `7f56f6b` is local-only. Push before starting this spec? (clean slate)

The Phase 0 audit is at `docs/hardcode-audit-phase0.md`; this sketch is at `docs/hardcode-vs-generalize-sketch.md`. Both are ready to inform v1 drafting.
