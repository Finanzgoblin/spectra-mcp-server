# Phase 7 Stakeholder-Utility Convergent Findings — hardcode-vs-generalize-spec.md v3

**Reviewers**: Curator (Opus, soul), Trader (Opus, no soul), Protocol Owner (Opus, no soul), LP (Sonnet, soul), Cross-cut (Sonnet, soul)
**Verdicts**: All 5 said ITERATE (none SHIP, none REFRAME, none STOP)
**Date**: 2026-04-28
**Per methodology**: integrate spec-refining findings into v3-final. NOT ship/no-ship meta-framing.

---

## Convergence quality summary

| Pattern | Lenses | Type | Severity |
|---|---|---|---|
| **Render layer strips type discipline** | Curator + P-1 + P-3 + T-2 + T-3 + LP-2 | 6-lens, distinct framings | **STRONGEST signal of round** |
| **Absolute thresholds wrong axis** | C-4 + T-1 + LP-1 | 3-lens, distinct archetypes (vault-rel / order-rel / trend-rel) | **Multi-archetype ship-blocker** |
| **Render gallery missing as scope item** | P-6 + LP-2 implicit + Cross-cut composite-failure | 3-lens convergence on the same architectural fix | **Pivotal scope addition** |
| **Update cadence missing** | P-5 + T-2 | 2-lens (points multipliers + ytFeeRate staleness) | **Ship-blocker** |
| **`rolloverPolicy` taxonomy too narrow** | P-2 + Curator (implicit via cross-vault) | 1-lens architectural + 1-lens scope | **Architectural fix** |
| **Originating scar fires on spec itself** | Cross-cut alone, but pivotal | Self-referential | **Most consequential single finding** |

No false consensus detected. The 6-lens convergence on render-layer attribution-stripping is the strongest signal across the entire 3-round workflow.

---

## P7-BLOCKER findings (must address in v3-final)

### P7-BL-1: Render layer strips type discipline — 6-lens convergence

The most consequential convergent finding of the round. Six independent lenses identified that the spec's `SourcedValue / InterpretedValue / scope / staleness` discipline lives in the type system but DOES NOT reach the render layer.

**Specific instances**:
- **Curator hard-stop**: `MATURITY_TEMPLATES.expired["burn_no_rollover"]` emits `"Burn-to-underlying queue active (~7d cooldown)"` — discards `settlementWindow.ceiling: "unknown"` + `observationBoundaries.unobservable[]` (queue position relative to head orderId). Authority-laundering — same pattern as STAK API/chain divergence scar.
- **P-1**: rendered output for non-`SourcedValue` numerics MUST carry visible attribution flag (e.g., `~7d cooldown [interpreted from "one week"]`).
- **P-3**: `formatYTFeeLabel` returns `"5%"` without basis. Pendle's actual fee is YT-yield skim. Curator reads `[P] 5%` and thinks "fee on YT trade." Should render `"5% on YT yield"`.
- **T-2**: `formatYTFeeLabel` should annotate stale verification (`sourceVerifiedOn > 60d`) with asterisk + date — render `"5%* (verified 2026-04-28)"`.
- **T-3**: metadata-fallback render `"[program] [amount]x (from metadata)"` loses LP/YT scope distinction when both `lp` and `yt` PointsMultiplier entries exist. Should render `"Avant points: lp 40x, yt 60x (from metadata)"`.
- **LP-2 [close to HARD STOP]**: `scope: "lp" vs "yt"` survives data layer but spec NEVER shows what "dispatches separately" looks like in render output. The scope distinction could survive the data layer and collapse at the display layer — **architecturally correct but LP-invisible**.

**Resolution (single architectural fix that closes all 6)**:

Add **§5.5 — Render Gallery** that mandates literal rendered-string examples for every non-`_unknown` metadata entry, showing:
- Curator dashboard render
- Action-item render
- Maturity-prompt render
- Drift-footer render
- Metadata-fallback render (when position data empty)
- **Each carries explicit attribution flag, basis label, scope label, and staleness annotation** when applicable.

The render-gallery section becomes the contract. Implementation tests assert against the gallery output.

### P7-BL-2: Absolute thresholds wrong axis — 3-lens convergence

Three archetypes need three different size-aware companions to the absolute floor:

- **C-4 (Curator)**: vault-size-relative thresholds — gamisUSDC ($3M) vs $50M curator vault need different `IDLE_LIQUIDITY_WARN_PCT`. Web research finding: Pendle's [Pulse AgentFi](https://medium.com/@0xjacobzhao/pendle-yield-strategies-unveiled-pulses-agentfi-paradigm-e8c60bb0f6dc) uses size-adjusted thresholds.
- **T-1 (Trader)**: order-size-relative slippage — same $40K pool: $25K trade = 31% impact destroyed; $1K = 1.25% fine. Spec has `estimatePriceImpact` in `primitives.ts:43` already; not threaded through PR-K.
- **LP-1 (LP)**: trend-relative — pool dropping $1.2M → $400K over 72h is dangerous; $45K stable for 6 months is not. No trend architecture in spec.

**Resolution**: PR-K extends with three companion helpers:
```typescript
function isHighSlippage(amountUsd: number, poolLiqUsd: number, maxImpactPct = 2): boolean;
function isLiquidityTrendBad(currentUsd: number, sevenDayAgoUsd: number, dropPctThreshold = 30): boolean;
function vaultSizeAdjustedIdleThreshold(vaultTvlUsd: number): number;
```

§10 dissolution updated: "PR-K thresholds are absolute today; size/order/trend-relative companions ship as PR-K2 trigger when 2nd archetype consumer needs them."

### P7-BL-3: Update cadence missing — 2-lens convergence

- **P-5**: Avant runs 4-week boost (LP=60x/YT=90x); dashboard shows static 40x/60x. Curator shorts themselves on actual rewards OR over-allocates when boost ends.
- **T-2**: Pendle governance can vote fee bumps (5% → 7%); cached `sourceVerifiedOn` predates the change.

**Resolution**:
1. `PointsMultiplier` adds optional `validUntil?: ISO_DATE`. Render `[stale since X]` suffix when expired.
2. Same pattern for `ytFeeRate.sourceVerifiedOn > 60d` → render `"5%* (verified 2026-04-28)"`.
3. `validateAndWarn()` extended: weekly stderr warning when any field's `sourceVerifiedOn > 60d` (already does 180d for protocol-level — extend to field-level for high-frequency-changing fields).

### P7-BL-4: `rolloverPolicy` taxonomy flattens distinct semantics

**P-2 finding**: `burn_no_rollover` does triple duty in DeFi landscape:
- Avant: burn → cooldown → claim same underlying
- Cork-style depeg insurance: expire-into-LP-share, no burn
- Stable-redemption variants: burn-to-stable, no cooldown

Curator scans `burn_no_rollover` next to `manual_to_successor` and reads it as "less mature" — actually deliberately different architecture.

**Resolution**: rename for positive semantic:
```typescript
rolloverPolicy?:
  | "auto"                     // Spectra MetaVault auto-rolls
  | "manual_to_successor"      // Pendle: roll to successor PT
  | "redeem_to_underlying"     // Avant: burn → cooldown → claim same underlying
  | "expire_to_lp_share"       // hypothetical Cork-style depeg insurance
  | "redeem_no_cooldown"       // hypothetical instant burn-to-stable
  | "unknown";
```

Avant: `redeem_to_underlying`. Pendle: `manual_to_successor`. Existing `manual_to_successor` and `auto` preserved.

### P7-BL-5: Composite failure scenario — presentation-layer ambiguity

**Cross-cut finding**: Avant position at day 6 post-expiry shows "60x YT (from metadata)" — Pendle BD reads as competing data; curator reads `[EXPIRED] redeem and reallocate` and tries to redeem (wrong — Avant burns); trader sees "60x" as buy signal (wrong — expired); LP reads same "60x" for live LP pool. **Four stakeholders see "60x" with four different meanings from one number.** "(from metadata)" parenthetical too quiet for the load.

**Resolution**:
1. When position empty AND metadata non-empty AND position is expired/in-cooldown, render: `"[REFERENCE-ONLY] Avant points: lp 40x, yt 60x — position expired, points NOT accruing"`. The `[REFERENCE-ONLY]` prefix is loud; the "(from metadata)" parenthetical was too quiet.
2. PR-C templates expand `expired` for `redeem_to_underlying` (formerly `burn_no_rollover`) to consume `settlementWindow.ceiling` AND surface `observationBoundaries.unobservable[]` per Curator hard-stop:
```
[EXPIRED] avUSDx matured. Order=4289. Floor 7d cooldown; ceiling unknown
under queue stress. Verify head orderId before promising depositor exit.
```

### P7-BL-6 [PIVOTAL]: Originating scar fires on the spec itself

**Cross-cut finding**: The spec was written to prevent hardcoded fixture values. Yet:
1. **Fixture-as-truth at doc level**: §4 example uses `40, 60, 15_000ms, 2026-04-28` — every reviewer mentally locked to "40" as canonical
2. **Tests-pass-as-criterion**: PR-L acceptance says "unit + integration tests" without specifying shape-based
3. **Spec-as-specifier causing fixture-mirror**: developer implementing PR-L will mirror these values into tests
4. **PR-J cut**: forcing function deferred — nothing prevents recurrence

> "The spec that was written to prevent hardcoding contains the seeds of the next hardcoded test assertion."

**Three options for v3-final** (Richard-decision):

| Option | Action | Trade-off |
|---|---|---|
| **α (light)** | §4 caveat + §5.5 render gallery with placeholder values + test-discipline note for PR-L | Stays in scope; ~30 lines; doesn't restore forcing function |
| **β (re-introduce PR-J)** | Un-cut PR-J as part of THIS spec; concretize forcing function (pre-commit hook OR named reviewer-brief 5th-lens) | Goes back on v2 cut decision; ~50-80 lines; forcing function ships with spec |
| **γ (self-aware)** | Acknowledge scar firing on author-level explicitly + accept PR-J defers + ship with documented caveat | Honest; cheapest; scar persists structurally |

**My recommendation**: **β + α together**. The 6-lens render-layer convergence ALREADY mandates §5.5 render gallery. Restoring PR-J adds 30-50 lines for the forcing function. Together they close the recursive scar — the spec dissolves the pattern at both code-level (PR-L) and process-level (PR-J).

---

## P7 nice-to-have findings (incorporate or defer)

| # | Finding | Lens | Action |
|---|---|---|---|
| P7-NTH-1 | Cross-vault sequencing missing — curator runs 3 vaults across 4 chains; spec gives 3 independent dashboards | Curator | §10 scope-OUT with named trigger: "when curator portfolio expands beyond 1 vault per chain, surface cross-vault calendar." Trigger: 5th vault added |
| P7-NTH-2 | Protocol-aggregate concentration missing — $1.6M in Avant burns across 2 vaults = single-queue exposure | Curator | §10 scope-OUT with trigger: "when curator's total exposure to one protocol exceeds 30% of AUM" |
| P7-NTH-3 | YT-decay-aware sizing helper missing — trader sizing 14-day points farm on 90-day YT eats ~15% theta | Trader | §10 scope-OUT (trader is named secondary). Trigger: "when trader-as-stakeholder gets primary status in pipeline" |
| P7-NTH-4 | `[OUTFLOWS]` template undefined; `lp_share` ghost class | LP | Spec-internal gap. Either define template/populate class OR explicitly mark "curator-only no LP consumer" + "lp_share reserved for future PR" |
| P7-NTH-5 | `swapFeeRate` field missing — LP yield core source | LP | §10 scope-OUT with trigger: "when LP-as-stakeholder gets primary status" |
| P7-NTH-6 | Spec is data-shaped, not ammunition-shaped — should not be presented as "client-serving" when 5 of 9 PRs invisible to clients | Cross-cut | Self-review honesty: §1 stakeholder section adds: "5 of 9 PRs (A, E, F, G, K) are internal architecture investment invisible to current clients. Phase 1 PRs (D, E, L) carry the demo-visible value." |
| P7-NTH-7 | Ether.Fi-style protocols hit `_unknown` template "⚠ UNMAPPED" = brand damage; trigger should be "any protocol Spectra's API returns positions for" not "4th display-name shape" | P-4 | Add §7.5: stub-metadata aging policy (DriftCollector-driven) |
| P7-NTH-8 | Render-gallery for protocol-owner sign-off (the ONE thing missing) | P-6 | Resolved by P7-BL-1 §5.5 |
| P7-NTH-9 | Verifier `[CLAIMED:X, OBSERVED:Y]` drift annotation pattern from points should extend to fees | T-5 | §7 single-sentence addition |

---

## Length budget for v3-final

v3 was 615 lines. Methodology Phase 8: "By v3-final, every open question is closed. The 'Open Questions' section is deleted. What remains in §10 (observation boundaries) names what the spec deliberately enforces, what it cannot resolve without building, and the dissolution conditions. End of spec includes a 'Ready-to-engineer checklist'."

**Estimated v3-final additions**:
- §0 P7 changelog (~50 lines)
- §5.5 render gallery (~40-60 lines)
- §3/§4 rolloverPolicy 6-way enum + value-update (~5 lines)
- §3 PointsMultiplier `validUntil?` field (~3 lines)
- §5 helpers updates (formatYTFeeLabel staleness, formatPointsMultipliers REFERENCE-ONLY, isHighSlippage etc.) (~15-20 lines)
- §7 expanded drift handling (~10 lines)
- §10 scope-OUT additions for 5 nice-to-haves (~20 lines)
- §1 self-review honesty about PR distribution (~5 lines)
- Ready-to-engineer checklist (~15 lines)

**If Option β (restore PR-J)**: +30-50 lines for forcing function design
**If Option α only**: above estimate stands

**Estimated v3-final**:
- Option α only: ~720 lines (within v3 × 1.3 = 800)
- Option β + α: ~770 lines (still within ceiling)

Both viable.

---

## Decision required from Richard for v3-final

1. **P7-BL-6**: Option α / β / γ for the originating-scar self-test? (Lean: β + α)

All other P7 BLOCKERs and nice-to-haves I'll integrate without further decision per methodology Phase 7 ("integrate the spec-refining findings into v3-final").

Awaiting decision then drafting v3-final.
