# Hardcode-vs-Generalize Spec — v3-final

**v3 → v3-final changes**: 6 P7 BLOCKERs + 9 nice-to-haves from Phase 7 stakeholder-utility round incorporated. **PR-J restored** (un-cut from v2 decision per Richard's β + α choice — forcing function ships with this spec to dissolve the recursive scar). **§5.5 render gallery added** (closes 6-lens render-layer convergence + provides protocol-owner sign-off surface). All open questions closed. Ready-to-engineer checklist at end.

**Date**: 2026-04-28
**Round 1 synthesis**: `docs/hardcode-vs-generalize-round1-synthesis.md`
**Round 2 synthesis**: `docs/hardcode-vs-generalize-round2-synthesis.md`
**Round 7 synthesis**: `docs/hardcode-vs-generalize-round7-synthesis.md`
**Phase 0 audit**: `docs/hardcode-audit-phase0.md`

---

## §0 — Changelog (Phase 7 → v3-final)

### P7 BLOCKER fixes

| # | Finding (lenses) | v3-final resolution | Spec location |
|---|---|---|---|
| **P7-BL-1** | Render layer strips type discipline — 6-lens convergence (Curator hard-stop, P-1 InterpretedValue stripped, P-3 fee basis missing, T-2 staleness flag, T-3 scope flattened, LP-2 scope-render unspecified) | **§5.5 Render Gallery added** — mandates literal rendered-string examples for every non-`_unknown` metadata entry with explicit attribution flags, basis labels, scope labels, staleness annotations. Tests assert against gallery output. Closes all 6 lenses architecturally. | §5.5 NEW |
| **P7-BL-2** | Absolute thresholds wrong axis — 3-lens convergence (C-4 vault-rel, T-1 order-rel, LP-1 trend-rel) | §5.6 NEW with 3 size-aware companion helpers: `isHighSlippage(amountUsd, poolLiqUsd)`, `isLiquidityTrendBad(currentUsd, sevenDayAgoUsd)`, `vaultSizeAdjustedIdleThreshold(vaultTvlUsd)`. PR-K extended to ship companions alongside absolute floors. | §5.6 NEW, PR-K |
| **P7-BL-3** | Update cadence missing — 2-lens (P-5 points multipliers, T-2 ytFeeRate staleness) | `PointsMultiplier.validUntil?: ISO_DATE` field added. Render `[stale since X]` suffix. `formatYTFeeLabel` annotates `*` + date when `sourceVerifiedOn > 60d`. `validateAndWarn()` extended weekly stderr at field-level. | §3, §5 |
| **P7-BL-4** | `rolloverPolicy` taxonomy too narrow (P-2) — `burn_no_rollover` does triple duty | Renamed to 6-way: `auto / manual_to_successor / redeem_to_underlying / expire_to_lp_share / redeem_no_cooldown / unknown`. Avant: `redeem_to_underlying`. Pendle: `manual_to_successor`. | §3, §4 |
| **P7-BL-5** | Composite failure scenario (Cross-cut) — "(from metadata)" too quiet for 4-stakeholder ambiguity load | When position empty AND position is expired/in-cooldown, render `[REFERENCE-ONLY]` prefix (loud) instead of "(from metadata)" parenthetical. PR-C `expired` template expanded for `redeem_to_underlying` to consume `settlementWindow.ceiling` + `observationBoundaries.unobservable[]` (closes Curator hard-stop). | §5, §7 |
| **P7-BL-6** | Originating scar fires on spec itself (Cross-cut) — fixture-as-truth in §4 examples + PR-J cut + tests-pass acceptance | **β + α together**: (a) PR-J restored as PR row + ship-phase + acceptance with concrete forcing function; (b) §4 example values carry explicit caveat block; (c) §5.5 render gallery uses placeholder forms with annotation; (d) PR-L acceptance mandates shape-based tests. | §1 PR-J row, §9 PR-J ship-phase, §4 caveat, §5.5, PR-L acceptance |

### P7 nice-to-have incorporations

| # | Finding | Resolution | Location |
|---|---|---|---|
| P7-NTH-1 | Cross-vault sequencing missing (Curator) | §10 scope-OUT with trigger: "5th vault added to curator portfolio" | §10 |
| P7-NTH-2 | Protocol-aggregate concentration missing (Curator) | §10 scope-OUT with trigger: "curator's total exposure to one protocol exceeds 30% of AUM" | §10 |
| P7-NTH-3 | YT-decay-aware sizing helper missing (Trader) | §10 scope-OUT (trader is named secondary). Trigger: "trader-as-stakeholder gets primary status" | §10 |
| P7-NTH-4 | `[OUTFLOWS]` template undefined; `lp_share` ghost class (LP) | `[OUTFLOWS]` template defined for curator-side; `lp_share` populated stub OR §10 explicit "reserved for future PR" | §3, §10 |
| P7-NTH-5 | `swapFeeRate` field missing (LP) | §10 scope-OUT with trigger: "LP-as-stakeholder gets primary status" | §10 |
| P7-NTH-6 | Spec data-shaped not ammunition-shaped — should not be presented as "client-serving" when 5 of 9 PRs invisible | §1 self-review honesty paragraph: names which PRs are demo-visible vs internal investment | §1 |
| P7-NTH-7 | Ether.Fi-style protocols hit `_unknown` "⚠ UNMAPPED" template = brand damage | §7.5 NEW: stub-metadata aging policy (DriftCollector-driven; any protocol surfacing in production positions data MUST have stub metadata within N days) | §7.5 NEW |
| P7-NTH-8 | Render gallery for protocol-owner sign-off | Resolved by P7-BL-1 §5.5 | §5.5 |
| P7-NTH-9 | `[CLAIMED:X, OBSERVED:Y]` drift annotation for fees too | §7 single-sentence addition; same pattern from points multipliers extends to ytFeeRate | §7 |

---

## §1 — Why this exists

`PROTOCOL_METADATA` + `verifier-registry` got the architecture right. The migration is incomplete: the class exists for some surfaces, isn't consumed for others, and is duplicated as inline literals across 12+ files. The originating scar (Avant points 40x/60x rendering) is a multiplier-rendering site; PR-L closes the migration gap there. PR-J ensures the scar doesn't recur — it's the forcing function that catches the next instance.

**Stakeholder needs (honest framing):**

1. **Next protocol-onboarding team** (paying / pipeline-near): one metadata row + zero consumer-side edits for metadata-readable behaviors. Alias-map and unknown-protocol dispatch require explicit registry entries (narrowed claim per BL-3).
2. **Curator using the dashboard** (paying via consulting): consistent semantics across tools; rolloverPolicy-aware action items; queue-position-aware burn-cooldown prose.
3. **Richard** (consultant + spec author): no more "I changed one threshold and 12 files broke" sessions; PR-J prevents recurrence.
4. **Trader / LP**: secondary; affected through fee-label, points-program, scope-render consistency.

### Self-review honesty (P7-NTH-6)

**Of the 10 PRs, 4 are demo-visible to current paying clients (Clearstar, YieldNest)**: PR-D (correct YT fee + label), PR-B (maturity vocabulary), PR-C (rolloverPolicy-aware action items), PR-L (originating-scar surface). **6 are internal architecture investment** invisible in any current client demo: PR-A (asset registry), PR-E (parse-time normalization, defensive), PR-F (transactionQueue dissolve), PR-G (verifier cross-validation), PR-J (audit forcing function), PR-K (threshold consolidation). The internal investment compounds the moat over time but should not be presented as client-serving.

### The 10 PRs (PR-J restored per Richard's β decision)

| PR | Stakeholder need served | Files touched |
|---|---|---|
| **PR-A** | Asset registry: one source of truth for stable/lst/wrapped-native/lp_share | NEW `src/assets/metadata.ts`; EDIT `formatters.ts` (DIRECT_ASSETS/ONE_HOP_ASSETS), `tools/curator_scan.ts` (STABLES) — registry+migration in one PR |
| **PR-B** | Consistent maturity action-item thresholds + engine 3-tier vocabulary fix per R2-BL-3 | EDIT `protocols/metadata.ts`, `protocols/engine.ts:387-390`, 12 tool files. 4 sub-PRs (B1-B4). PR-B1 includes `engine.test.ts:286-288` updates. |
| **PR-C** | Predictable action-item vocabulary; rolloverPolicy-aware templates with 6-way enum (P7-BL-4); `[REFERENCE-ONLY]` prefix for expired-with-metadata-fallback (P7-BL-5); `[OUTFLOWS]` template defined | NEW `src/action-items/types.ts`; EDIT 3 tool files |
| **PR-D** | New protocols add cleanly. Atomic single-PR | EDIT `protocols/metadata.ts` + `types.ts`, `engine.ts:317`, `formatters.ts` (~6 sites + `groupBy(meta.name)`), `tools/curator_scan.ts:530`, `tools/rollover.ts:53` |
| **PR-E** | No display-name vs key drift; `Ether.Fi` brittleness fixed; high-blast-radius parse-time | EDIT `src/api.ts`/`src/schemas/spectra.ts`, extend `normalizeProtocolName` regex; kill capital-P refs in `metavault.ts`. Mitigation: grep all `position.protocol` reads before merge |
| **PR-F** | Framework absorbs new transactionQueue keys; honest test rewrite | EDIT `formatters.ts:3292`, `5189-5455`; **REPLACE** `formatters.test.ts:5189-5226` |
| **PR-G** | Verifier-registry cross-validation; metadata-readable verifier config | EDIT 2 verifier files, `protocols/metadata.ts`, `protocols/verifier-registry.ts` (cross-validation lives here per R2-BL-4) — atomic per R2-BL-7 |
| **PR-J** ⭐ RESTORED | **Forcing function for hardcode-vs-generalize discipline** — prevents recurrence of the originating scar at process-level | NEW pre-commit hook scanning for `new Set([...])` / `Record<string, ...>` literals + reviewer-brief 5th-lens insertion in `docs/spec-workflow-prompt.md` |
| **PR-K** | TVL/liquidity threshold consolidation + size-aware companions per P7-BL-2 | RENAME `CURATOR_DASHBOARD_THRESHOLDS` → `CROSS_TOOL_THRESHOLDS`; extend with 4 absolute constants AND 3 size/trend-relative helpers. ~12 sites + new helpers consumed by `tools/curator_scan.ts`, `tools/curator_portfolio.ts`. |
| **PR-L** ⭐ | Originating-scar migration with `validUntil` staleness (P7-BL-3) and shape-based tests (P7-BL-6 α) | EDIT `protocols/metadata.ts` + `types.ts` (PointsMultiplier per R2-BL-1+6 + P7-BL-3 validUntil), `formatters.ts:489-525` + `formatters.ts:3596-3601`, tests (shape-based, asserting against §5.5 render gallery) |

---

## §2 — Architecture overview

### Existing classes (preserve, extend)

- `protocols/metadata.ts` `PROTOCOL_METADATA` — extend with `ytFeeRate`, `useCctp`, `shortTag`, `rolloverPolicy` (6-way), `verifier?`, `pointsMultipliers?`. Schema in `protocols/types.ts` enforces.
- `protocols/registry.ts` `getMeta`, `normalizeProtocolName`, `PROTOCOL_NAME_ALIASES` — preserved; PR-E extends regex.
- `protocols/verifier-registry.ts` — preserved; PR-G adds cross-validation HERE (R2-BL-4).
- `protocols/cost-models.ts` `COST_MODELS` — preserved; "two-file friction" exemplar.
- `config.ts` `SUPPORTED_CHAINS` — preserved.
- `primitives.ts` — preserved; PR-K consumes `estimatePriceImpact`.
- `formatters.ts:5086` `CURATOR_DASHBOARD_THRESHOLDS` — RENAMED `CROSS_TOOL_THRESHOLDS` per AM-2.

### New classes

- `src/assets/metadata.ts` (PR-A) — `ASSET_METADATA` with `SourcedValue/InterpretedValue` discipline. `_unknown_asset` fallback. Helpers do internal symbol normalization (AM-12).
- `src/action-items/types.ts` (PR-C) — `ActionItemCategory` + `ACTION_ITEM_PREFIXES` + `formatMaturityActionItem` consuming 6-way `meta.rolloverPolicy`. Import constraint: `primitives.ts` + `protocols/` only (BL-8).
- **`docs/audit-discipline-spec.md`** (PR-J) — concrete forcing function: pre-commit hook scanning for new `new Set([...])` / `Record<string, ...>` literals; reviewer-brief 5th-lens insertion.

### Schema extensions (P7-BL-3 + P7-BL-4)

```typescript
// protocols/types.ts
interface ProtocolMeta {
  // existing fields preserved

  ytFeeRate?: SourcedValue<number> | InterpretedValue<number>;
  shortTag?: string;

  /** P7-BL-4: 6-way enum (was 4-way binary). */
  rolloverPolicy?:
    | "auto"                  // Spectra MetaVault: auto-rolls
    | "manual_to_successor"   // Pendle: manual roll to successor PT
    | "redeem_to_underlying"  // Avant: burn → cooldown → claim same underlying
    | "expire_to_lp_share"    // hypothetical Cork-style depeg insurance
    | "redeem_no_cooldown"    // hypothetical instant burn-to-stable
    | "unknown";

  stressSettlement: { useCctp?: boolean; /* existing */ };
  verifier?: VerifierConfig;
  pointsMultipliers?: PointsMultiplier[];
}

/**
 * P7-BL-3: PointsMultiplier carries optional `validUntil` for campaign-scope freshness.
 * source.value === amount invariant zod-enforced (R2-BL-6).
 */
interface PointsMultiplier {
  program: string;
  scope: "lp" | "yt" | "vault";
  amount: number;
  source: SourcedValue<number> | InterpretedValue<number>;
  validUntil?: string; // ISO_DATE — when null, no campaign-end; when set, render [stale since X] when past
}
```

### Dissolutions (R2-BL-5 line refs, preserved)

| Site | Was | Becomes |
|---|---|---|
| `formatters.ts:489-525` `formatMultipliers` (the function) | inline dispatch over `Array | { lp; yt }` of `MultiplierItem` | preserved as dispatch hub; **adds** metadata-fallback branch via `formatPointsMultipliers` with `[REFERENCE-ONLY]` for empty-position |
| `formatters.ts:3596-3601` vault-level `mv.multipliers: Record<string, number>` | inline reading of raw API record | converted to `MultiplierItem[]` inside helper |
| `formatters.ts:3292` `TRANSACTION_QUEUE_KNOWN_KEYS` | `ReadonlySet<string>` | zod `.strict()`; unknown keys log under `DRIFT_VISIBILITY` flag |
| `engine.ts:317` `CCTP_PROTOCOLS` | `Set(["avant", "pendle"])` | `meta.stressSettlement.useCctp` flag |
| `formatters.ts:106-118` `DIRECT_ASSETS` + `ONE_HOP_ASSETS` | two local Sets | `ASSET_METADATA` registry |
| `curator_scan.ts:551` `STABLES` | local 16-Set | `isStable()` helper |

---

## §3 — Core types

```typescript
// PR-A — src/assets/metadata.ts
export type AssetClass =
  | "stable" | "wrapped_native" | "wrapped_btc"
  | "lst" | "lrt" | "lp_share" | "governance" | "other";

export interface AssetMeta {
  symbol: string;
  class: SourcedValue<AssetClass> | InterpretedValue<AssetClass>;
  oneHop?: boolean;
  canonicalDecimals?: number;
}

// PR-C — src/action-items/types.ts
export type ActionItemCategory =
  | "expired" | "urgent" | "soon" | "upcoming"
  | "outflows" | "bridge" | "incentive" | "rollover" | "status"
  | "reference_only";  // P7-BL-5: explicit prefix when position-empty + metadata-fallback

export const ACTION_ITEM_PREFIXES: Record<ActionItemCategory, ActionItemPrefix>;
export function formatActionItemPrefix(cat: ActionItemCategory): string;
export function formatMaturityActionItem(cat, pos, meta): string;

// PR-L — see ProtocolMeta block above for PointsMultiplier
```

---

## §4 — Concrete data structures

### ⚠ Caveat on example values (P7-BL-6 α)

**The values in the examples below (40, 60, 0.05, 15_000ms, "2026-04-28") are illustrative date-stamped fixtures. They are NOT canonical. Tests for PR-L MUST be shape-based — assert against `formatYTFeeLabel(meta)` output composability, not against the literal string `"5%"`. PR-J (audit forcing function) catches violations of this rule. See §5.5 render gallery for the actual contract.**

### `ASSET_METADATA` initial population (PR-A)

```typescript
const ASSET_METADATA: Record<string, AssetMeta> = {
  USDC:  { symbol: "USDC",  class: { value: "stable",         sourceUrl: "...", sourceVerifiedOn: "2026-04-28" }, canonicalDecimals: 6 },
  WETH:  { symbol: "WETH",  class: { value: "wrapped_native", sourceUrl: "...", sourceVerifiedOn: "2026-04-28" }, canonicalDecimals: 18 },
  WBTC:  { symbol: "WBTC",  class: { value: "wrapped_btc",    sourceUrl: "...", sourceVerifiedOn: "2026-04-28" }, canonicalDecimals: 8 },
  stETH: { symbol: "stETH", class: { value: "lst",            interpretedFrom: {/* ... */} }, oneHop: true, canonicalDecimals: 18 },
  CRV:   { symbol: "CRV",   class: { value: "governance",     sourceUrl: "...", sourceVerifiedOn: "2026-04-28" }, oneHop: true },
  FRAX:  { symbol: "FRAX",  class: { value: "stable",         interpretedFrom: {/* depeg-risk noted */} }, canonicalDecimals: 18 },
  // P7-NTH-4: lp_share entry stub (real population deferred to PR after first PT/IBT pool LP token surfaces in production)
};
```

### `ACTION_ITEM_PREFIXES` (PR-C)

```typescript
const ACTION_ITEM_PREFIXES: Record<ActionItemCategory, ActionItemPrefix> = {
  expired:        { displayPrefix: "[EXPIRED]",        severity: "blocker" },
  urgent:         { displayPrefix: "[URGENT]",         severity: "blocker" },
  soon:           { displayPrefix: "[SOON]",           severity: "warn" },
  upcoming:       { displayPrefix: "[UPCOMING]",       severity: "info" },
  outflows:       { displayPrefix: "[OUTFLOWS]",       severity: "warn" },  // template defined per P7-NTH-4
  bridge:         { displayPrefix: "[BRIDGE]",         severity: "info" },
  incentive:      { displayPrefix: "[INCENTIVE]",      severity: "info" },
  rollover:       { displayPrefix: "[ROLLOVER]",       severity: "warn" },
  status:         { displayPrefix: "[STATUS]",         severity: "info" },
  reference_only: { displayPrefix: "[REFERENCE-ONLY]", severity: "warn" },  // P7-BL-5
};
```

### Avant entry illustrative (P7-BL-4 6-way enum)

```typescript
avant: {
  // existing fields preserved
  ytFeeRate: { value: 0.03, sourceUrl: "https://docs.spectra.finance/...", sourceVerifiedOn: "2026-04-28" },
  shortTag: "[A]",
  rolloverPolicy: "redeem_to_underlying",  // P7-BL-4 (was "burn_no_rollover")
  stressSettlement: { /* ...existing... */ useCctp: true },
  verifier: {
    timeoutMs: 15_000,
    amountDriftTolerancePpm: 100n,
    contracts: { "43114": { requestManager: "0x4c129d3aa27272211d151ca39a0a01e4c16fc887" } },
  },
  pointsMultipliers: [
    { program: "Avant points", scope: "lp", amount: 40,
      source: { value: 40, sourceUrl: "...", sourceVerifiedOn: "2026-04-28" },
      validUntil: undefined },  // no campaign end
    { program: "Avant points", scope: "yt", amount: 60,
      source: { value: 60, sourceUrl: "...", sourceVerifiedOn: "2026-04-28" },
      validUntil: undefined },
  ],
},

pendle: {
  ytFeeRate: { value: 0.05, sourceUrl: "...", sourceVerifiedOn: "2026-04-28" },
  shortTag: "[P]",
  rolloverPolicy: "manual_to_successor",  // P7-BL-4
  // ...
},
```

### `CROSS_TOOL_THRESHOLDS` (PR-K) — preserved 4 absolute constants

`LOW_LIQUIDITY_USD: 50_000` (8 sites) | `REAL_VALUE_USD: 1_000` (5) | `IDLE_LIQUIDITY_WARN_PCT: 20` (2) | `INCENTIVE_SHARE_WARN_FRAC: 0.7` (1) | plus existing 3 dashboard thresholds. **See §5.6 for size/trend-relative companions.**

---

## §5 — Helpers / pure functions

### `getAssetClass(symbol) / isStartingPoint` (PR-A)

```typescript
function normalizeAssetSymbol(s: string): string {
  return s.toUpperCase().replace(/\.E$/i, ".e");
}
function getAssetClass(symbol: string): AssetClass {
  return ASSET_METADATA[normalizeAssetSymbol(symbol)]?.class.value ?? "other";
}
function isStable(symbol: string): boolean { return getAssetClass(symbol) === "stable"; }
function isStartingPoint(symbol: string): boolean {
  return ["stable", "wrapped_native", "wrapped_btc"].includes(getAssetClass(symbol));
}
```

### `formatYTFeeLabel(meta)` (PR-D + P7-BL-3 staleness annotation)

```typescript
function formatYTFeeLabel(meta: ProtocolMeta): string {
  if (meta.name === "_unknown" || !meta.ytFeeRate) return "?% on YT yield";  // P-3 fee basis
  const pct = `${(meta.ytFeeRate.value * 100).toFixed(0)}% on YT yield`;
  // P7-BL-3 + T-2: stale-verification annotation
  const ageDays = daysSince(meta.ytFeeRate.sourceVerifiedOn);
  if (ageDays > 60) return `${pct}* (verified ${meta.ytFeeRate.sourceVerifiedOn})`;
  return pct;
}
```

### `getMaturityCategory + formatMaturityActionItem` (PR-B + PR-C, 6-way rolloverPolicy)

```typescript
function getMaturityCategory(daysToMaturity, thresholds = { urgent: 7, upcoming: 14, upcomingMax: 30 }): ActionItemCategory {
  if (daysToMaturity <= 0)                       return "expired";
  if (daysToMaturity <= thresholds.urgent)       return "urgent";
  if (daysToMaturity <= thresholds.upcoming)     return "soon";
  if (daysToMaturity <= thresholds.upcomingMax)  return "upcoming";
  return "status";
}

const MATURITY_TEMPLATES: Record<ActionItemCategory, (ctx: MaturityCtx) => string> = {
  expired: (c) => {
    // P7-BL-5 + Curator hard-stop: consume settlementWindow.ceiling + observationBoundaries.unobservable[]
    switch (c.meta.rolloverPolicy) {
      case "auto":
        return `[EXPIRED] ${c.symbol} auto-rolled.`;
      case "redeem_to_underlying": {
        const floor = c.meta.stressSettlement.settlementWindow.typical.value;
        const ceiling = c.meta.stressSettlement.settlementWindow.ceiling;
        const ceilingNote = ceiling?.value === "unknown"
          ? `; ceiling unknown under queue stress (verify head orderId before promising depositor exit)`
          : `; ceiling ${ceiling?.value}d`;
        return `[EXPIRED] ${c.symbol} matured. Floor ${floor}d cooldown${ceilingNote}.`;
      }
      case "expire_to_lp_share":
        return `[EXPIRED] ${c.symbol} expired into LP share — no burn, no cooldown. See protocol docs for unwind path.`;
      case "manual_to_successor":
        return `[EXPIRED] ${c.symbol} matured. Redeem and reallocate to successor PT.`;
      case "redeem_no_cooldown":
        return `[EXPIRED] ${c.symbol} matured. Instant burn-to-stable available.`;
      default:
        return `[EXPIRED] ${c.symbol} matured.`;
    }
  },
  urgent:   (c) => `[URGENT] ${c.symbol} expires in ${c.days}d. ${rolloverPrelude(c.meta)}`,
  soon:     (c) => `[SOON] ${c.symbol} expires in ${c.days}d. ${rolloverPrelude(c.meta)}`,
  upcoming: (c) => `[UPCOMING] ${c.symbol} expires in ${c.days}d.`,
  rollover: (c) => `[ROLLOVER] ${c.symbol} matures in ${c.days}d on ${c.meta.label}. ${rolloverPrelude(c.meta)}`,
  outflows: (c) => `[OUTFLOWS] vault unallocated > ${CROSS_TOOL_THRESHOLDS.IDLE_LIQUIDITY_WARN_PCT}%; ${c.idleUsd} idle.`,  // P7-NTH-4
  // … etc.
};
```

### `formatPointsMultipliers` (PR-L — implementing D's engineering answer + P7-BL-5 [REFERENCE-ONLY])

```typescript
function formatPointsMultipliers(
  positionMultipliers: PositionMultiplierShape,
  meta: ProtocolMeta,
  positionState: { isExpired: boolean; isInCooldown: boolean },
): string | null {
  const positionItems = normalizeToItems(positionMultipliers);

  if (positionItems.length > 0) {
    return renderItems(positionItems, /* fromMetadata: */ false);
  }

  // P7-BL-5: composite failure scenario fix — loud prefix, not parenthetical
  if (meta.pointsMultipliers && meta.pointsMultipliers.length > 0) {
    if (positionState.isExpired || positionState.isInCooldown) {
      return formatActionItemPrefix("reference_only") + ` ${renderMetadataItems(meta.pointsMultipliers, { showScope: true })} — position expired/in-cooldown, points NOT accruing`;
    }
    return renderMetadataItems(meta.pointsMultipliers, { showScope: true }) + " (from metadata)";
  }

  return null;
}
```

`renderMetadataItems` with `showScope: true` produces `"Avant points: lp 40x, yt 60x"` (T-3 fix — scope is visible prose, not collapsed).

---

## §5.5 — Render Gallery (NEW per P7-BL-1)

**This section is the contract.** PR-L tests assert against these literal strings; protocol owners review these strings before signing off on metadata entries; reviewers check rendered output matches.

### Avant — illustrative, with placeholder LP_AMT and YT_AMT

For metadata `{ avant: { ytFeeRate: { value: F, sourceVerifiedOn: D }, rolloverPolicy: "redeem_to_underlying", pointsMultipliers: [{scope:"lp", amount: LP_AMT, ...}, {scope:"yt", amount: YT_AMT, ...}] } }`:

| Surface | Render template |
|---|---|
| Position-active multipliers (object form, position data fresh) | `lp [Avant points {LP_AMT}x] | yt [Avant points {YT_AMT}x]` |
| Position-active multipliers (array form, position data fresh) | `Avant points {AMT}x` |
| Position-empty + metadata-fallback (active position) | `Avant points: lp {LP_AMT}x, yt {YT_AMT}x (from metadata)` |
| Position-empty + metadata-fallback (expired/cooldown) | `[REFERENCE-ONLY] Avant points: lp {LP_AMT}x, yt {YT_AMT}x — position expired/in-cooldown, points NOT accruing` |
| YT fee label (fresh) | `{F*100}% on YT yield` |
| YT fee label (sourceVerifiedOn > 60d) | `{F*100}%* on YT yield (verified {D})` |
| YT fee label (unknown protocol) | `?% on YT yield` |
| `[EXPIRED]` action item (redeem_to_underlying) | `[EXPIRED] {symbol} matured. Floor {N}d cooldown; ceiling unknown under queue stress (verify head orderId before promising depositor exit).` |
| `[URGENT]` action item | `[URGENT] {symbol} expires in {N}d. Initiate burn for redemption queue.` |
| `[REFERENCE-ONLY]` prefix | `[REFERENCE-ONLY] Avant points: ... — position expired/in-cooldown, points NOT accruing` |
| Drift annotation (claim ≠ observed) | `[CLAIMED:{X}, OBSERVED:{Y}]` (per R2-BL-6 + P7-NTH-9 — fees too) |

### Pendle — illustrative

| Surface | Render template |
|---|---|
| YT fee label (fresh) | `5% on YT yield` |
| YT fee label (verified > 60d ago) | `5%* on YT yield (verified 2026-04-28)` |
| `[EXPIRED]` (manual_to_successor) | `[EXPIRED] {symbol} matured. Redeem and reallocate to successor PT.` |
| `[ROLLOVER]` | `[ROLLOVER] {symbol} matures in {N}d on Pendle. Prepare manual rollover to successor PT.` |

### `_unknown` protocol

| Surface | Render template |
|---|---|
| YT fee label | `?% on YT yield` |
| Display | `⚠ UNMAPPED PROTOCOL — position renders raw; see drift footer` |
| `[EXPIRED]` | `[EXPIRED] {symbol} matured.` (generic fallback) |

**Test discipline (P7-BL-6 α)**: PR-L unit tests use shape-based assertions parameterized over fixture values:
```typescript
const lpAmt = fixtures.avant.pointsMultipliers[0].amount;
const ytAmt = fixtures.avant.pointsMultipliers[1].amount;
assert.match(out, new RegExp(`Avant points: lp ${lpAmt}x, yt ${ytAmt}x`));
```
NOT `assert.match(out, /Avant points: lp 40x, yt 60x/)` — that would mirror the fixture and re-instantiate the scar.

---

## §5.6 — Size/trend-relative threshold companions (NEW per P7-BL-2)

Multi-archetype need: vault-size-relative for curators, order-size-relative for traders, trend-relative for LPs. Spec already has `estimatePriceImpact` in `primitives.ts:43` — thread it through PR-K.

### §5.6.1 — Calcification disclosure (PR-M2 amendment, 2026-04-28)

**The original spec §5.6 (below) hardcoded magic-number defaults at the spec layer.** Hyperyellow co-architect audit (2026-04-28) named the recursive failure: "PR-M did not dissolve the scar; it relocated it from data-shape to threshold-helper-default surface. The forcing function (PR-J pre-commit hook) scans for `new Set([...])` / `Record<string, ...>` literals — it would not have flagged a magic number in a function signature default."

The values that needed dissolution:
- `maxImpactPct = 2` — no source citation
- `dropPctThreshold = 30` — no source citation
- `sevenDayAgoUsd` window encoded in parameter name — no source citation
- `1M / 10M` TVL breakpoints — no source citation
- `30 / 20 / 10` pct outputs — no source citation

**Resolution (PR-M2)**: extracted the class "risk-tolerance configuration" into `src/risk-profiles/metadata.ts` with a `RiskProfile` interface. Every threshold value is `InterpretedValue<number>` with explicit `interpretedFrom: "no published source — opening builder default; pending research"` provenance. The default profile (`DEFAULT_CURATOR_PROFILE`) ships these values as opening defaults but NAMES the calcification rather than baking it into function signatures. Helpers consume `profile: RiskProfile = DEFAULT_CURATOR_PROFILE`. Adding a new stakeholder cohort (trader-aggressive, institutional-LP, etc.) = one row in the registry, zero edits in helpers/tests.

**Dissolution conditions per default-value entry**:
- `slippageBudget`: dissolves when curator engagement surfaces empirical tolerance data → upgrade to `SourcedValue` inline
- `liquidityDropTolerance`: dissolves when LP cohort surfaces volatility-regime data per asset class
- `liquidityTrendWindowDays`: dissolves when cycle data shows non-weekly volatility OR trader cohort needs intraday windows
- `idleByTvlBracket`: dissolves when vault data surfaces bracket-misclassification evidence

**Test discipline**: tests assert via `profile.X.value` reads, NOT against literal `2` / `30` / `30` / `20` / `10`. Per spec P7-BL-6 α (class vs fixture in tests): "tests pinning the magic numbers as fixture-mirror at the test layer = recursive scar AT THE TEST LAYER." PR-M2 rewrite verified: `formatters.test.ts` "PR-M2 threshold helpers — class-shape contracts" describe block reads defaults from registry, asserts dispatch (tighter profile fires more, looser fires less) without pinning literals.

### §5.6.2 — Helper signatures (PR-M2 final shape)

```typescript
// src/risk-profiles/metadata.ts
export interface RiskProfile {
  name: string;
  slippageBudget: InterpretedValue<number>;
  liquidityDropTolerance: InterpretedValue<number>;
  liquidityTrendWindowDays: InterpretedValue<number>;
  idleByTvlBracket: TvlBracket[];
}
export const DEFAULT_CURATOR_PROFILE: RiskProfile = { /* InterpretedValue<number> per field */ };

// src/formatters.ts (PR-M2 refactored)
export function isHighSlippage(
  amountUsd: number,
  poolLiqUsd: number,
  profile: RiskProfile = DEFAULT_CURATOR_PROFILE,
): boolean {
  if (poolLiqUsd <= 0 || amountUsd <= 0) return false;
  return estimatePriceImpact(amountUsd, poolLiqUsd) * 100 > profile.slippageBudget.value;
}

export function isLiquidityTrendBad(
  currentUsd: number,
  priorUsd: number,                          // PR-M2: window-agnostic; window in profile
  profile: RiskProfile = DEFAULT_CURATOR_PROFILE,
): boolean {
  if (priorUsd <= 0) return false;
  return ((priorUsd - currentUsd) / priorUsd) * 100 > profile.liquidityDropTolerance.value;
}

export function vaultSizeAdjustedIdleThreshold(
  vaultTvlUsd: number,
  profile: RiskProfile = DEFAULT_CURATOR_PROFILE,
): number {
  return resolveIdleThresholdPct(vaultTvlUsd, profile);
}
```

### §5.6.3 — DELETED original §5.6 helper signatures with magic-number defaults

The pre-PR-M2 helper signatures (`maxImpactPct = 2`, `dropPctThreshold = 30`, inline TVL-bracket if-statements) are deliberately deleted from this spec. Re-introducing them would be a regression. The recursive scar is dissolved at three layers:
1. **Spec layer** (this section) — calcification named, registry pointed to
2. **Code layer** (formatters.ts helpers) — dispatch via RiskProfile
3. **Test layer** (formatters.test.ts) — class-shape assertions

PR-J's pre-commit hook has a documented blind spot: magic numbers in function-signature defaults. Future amendment to PR-J: extend the hook's pattern set OR rely on the 5th-lens reviewer brief to catch this class. See `docs/audit-discipline-spec.md` §3 for the hook's current pattern set; §4 names what the hook does NOT catch (reviewer's territory).

---

## §6 — Engine / dispatcher

`engine.ts:317` `CCTP_PROTOCOLS` dissolves; reads `meta.stressSettlement.useCctp`.

`engine.ts:387-390` `generateActionItems` 3-tier vocabulary fix per R2-BL-3:
```typescript
const cat = getMaturityCategory(deltaDays, meta.actionItems?.maturityThresholdsDays);
return [`[${tag}-EXT ${cat.toUpperCase()}]`];
```

**Cross-validation per R2-BL-4** lives in `verifier-registry.ts`:
```typescript
// AFTER existing BY_NAME IIFE
import { getMeta } from "./registry.js";
(function crossValidate() {
  for (const v of VERIFIERS) {
    const meta = getMeta(v.name);
    if (!meta.verifier) throw new Error(`[verifier-registry] verifier "${v.name}" registered but meta.verifier missing`);
    if (!meta.verifier.contracts || Object.keys(meta.verifier.contracts).length === 0)
      throw new Error(`[verifier-registry] verifier "${v.name}" has empty contracts in metadata`);
  }
})();
```

---

## §7 — Drift handling / fallback / unknown cases

### Unknown protocol

`getMeta(name)` falls back to `_unknown`. Consumers handle per §5.5 templates.

### Unknown asset symbol

`getAssetClass(symbol)` → `"other"`. Migration guide: `isStartingPoint(sym)` for 0-hop, `["lst","lrt"].includes(getAssetClass(sym))` for one-hop.

### Unknown transactionQueue key (PR-F)

`safeParse` → if not success: log under `DRIFT_VISIBILITY=loud`, render raw with `[unsupported-shape: <keys>]` annotation.

### Display-name vs registry-key boundary (PR-E)

Parse-time normalization at `schemas/spectra.ts`, pass-through unknowns. Extended `normalizeProtocolName` regex handles `Ether.Fi`.

### Drift annotation pattern (R2-BL-6 + P7-NTH-9)

When API claim ≠ on-chain observed, render `[CLAIMED:X, OBSERVED:Y]`. **Pattern extends from points multipliers to ytFeeRate** — when verifier surfaces an on-chain fee differing from `meta.ytFeeRate.value`, render the claim/observed split.

### Staleness annotation (P7-BL-3)

`PointsMultiplier.validUntil` past → render `[stale since X]` suffix. `ytFeeRate.sourceVerifiedOn > 60d` → `*` + verified date. `validateAndWarn()` weekly stderr at field-level.

### Verifier registration (R2-BL-4 + R2-BL-7)

Cross-validation in `verifier-registry.ts`. `meta.verifier` populated AND cross-validation activated in single PR-G merge. Verifier code dereferences `meta.verifier.contracts[chainId][role]` with confidence.

---

## §7.5 — Stub-metadata aging policy (NEW per P7-NTH-7)

**Problem**: protocols Spectra's API returns positions for (e.g., Ether.Fi, Yearn, Lucidly) but lack metadata entries render as `⚠ UNMAPPED PROTOCOL`. Brand damage.

**Policy**:
1. `DriftCollector` (existing per `metadata.ts:188-189`) tracks all protocol names surfaced from production positions data.
2. Any protocol surfacing for ≥ 7 consecutive days WITHOUT a metadata entry triggers a stub-metadata PR requirement.
3. Stub entries have minimum fields: `name`, `label`, `homeDocsUrl`, `oneSentenceIntro`, `display.primaryTemplate` — enough to avoid `⚠ UNMAPPED`. Settlement and points fields can stay `unknown` until verified.
4. Trigger condition replaces v3's "4th display-name shape" — observable from production logs, not heuristic.

---

## §8 — Cross-tool dependency map

```
PROTOCOL_METADATA (extended) ──→ formatters.ts (label/shortTag/ytFee/points/asset-class)
                              ├→ tools/metavault.ts (action-items + 6-way rolloverPolicy)
                              ├→ tools/{curator_portfolio, expiry_monitor, position_map,
                              │         calibration, pendle_expiry, merkl}.ts (consume ActionItemCategory)
                              ├→ tools/{curator_scan, rollover}.ts (label, shortTag, ytFee)
                              └→ protocols/engine.ts (useCctp; 3-tier vocabulary)

ASSET_METADATA (PR-A, sibling)        ──→ formatters.ts, tools/curator_scan.ts
src/action-items/types.ts (PR-C)       ──→ formatters.ts + 3 tools (imports: primitives + protocols ONLY)
schemas/spectra.ts (PR-E)              ──→ normalize on parse, pass-through unknowns
verifier-registry.ts (PR-G)            ──→ cross-validation lives HERE; imports getMeta one-way
docs/audit-discipline-spec.md (PR-J)   ──→ pre-commit hook + reviewer-brief 5th-lens (forcing function)

CROSS_TOOL_THRESHOLDS (PR-K, renamed):
  Absolute floors                          Size/trend-relative companions (§5.6)
  ├ LOW_LIQUIDITY_USD ──→ 8 tools          ├ isHighSlippage(amount, liq) → traders
  ├ REAL_VALUE_USD ──→ 5 tools             ├ isLiquidityTrendBad(now, 7dAgo) → LPs
  ├ IDLE_LIQUIDITY_WARN_PCT ──→ 2 tools    └ vaultSizeAdjustedIdleThreshold(tvl) → curators
  └ INCENTIVE_SHARE_WARN_FRAC ──→ 1 tool
```

---

## §9 — Migration path (10 PRs)

### Ship-Phase 1 — Client-visible (atomic single-PR per AM-5)

- **PR-D**: zod extension + metadata population (avant/pendle entries get `ytFeeRate`, `useCctp`, `shortTag`, `rolloverPolicy` 6-way) + ALL consumer migration (engine.ts CCTP, formatters.ts YT fee + label + protocol-filter aggregations `groupBy(meta.name)`, curator_scan.ts dup fee, rollover.ts label) — single merge.
  - Scoped IN: `formatters.ts:6049-6086`. Scoped OUT: `curator_scan.ts:582+, 600, 603, 681-682` filter sites — trigger to migrate when 3rd protocol arrives (R2-NTH-1).
  - Test fixtures for non-`_unknown` protocols MUST populate `ytFeeRate` before merging (R2-NTH-4).
- **PR-E**: parse-time normalization + extended `normalizeProtocolName` regex.
  - **Risk note**: PR-E touches every `position.protocol` field; high-blast-radius. Mitigation: grep all `position.protocol` reads before merge (R2-NTH-2).
- **PR-L**: `PointsMultiplier` interface (with `validUntil`) + metadata population + `formatPointsMultipliers` orchestrator + migration of `formatters.ts:489-525` + `formatters.ts:3596-3601` per R2-BL-5.
  - **Phase honesty**: PR-L is originating-scar closure; not demo-visible to a curator unless inline values are stale. PR-D + PR-E carry the actual demo-visible value (R2-NTH-3).
  - **Test discipline (P7-BL-6 α)**: tests assert against §5.5 render gallery shape, NOT against literal `40` / `60` values.

### Ship-Phase 2 — Foundations

- **PR-A**: registry+migration in one PR per AM-4.
- **PR-C**: `formatMaturityActionItem` templates consume 6-way `meta.rolloverPolicy` per P7-BL-4. `expired` template consumes `settlementWindow.ceiling` + `observationBoundaries.unobservable[]` per P7-BL-5 (closes Curator hard-stop). `[OUTFLOWS]` template defined per P7-NTH-4. Import-direction pinned (BL-8).
- **PR-K**: rename `CURATOR_DASHBOARD_THRESHOLDS` → `CROSS_TOOL_THRESHOLDS`; extend with 4 absolute constants AND 3 size/trend-relative companions per §5.6 (P7-BL-2). ~14+ files.
- **PR-J**: NEW `docs/audit-discipline-spec.md` + concrete forcing function:
  - Pre-commit hook (`.git/hooks/pre-commit` or husky) scanning staged diffs for new `new Set([...])` / `Record<string, ...>` / `as const` literals; if found, emit prompt: "is this class-shaped? See docs/spec-workflow-prompt.md 5th lens."
  - Reviewer-brief 5th-lens insertion in `docs/spec-workflow-prompt.md` Phase 3 + Phase 5: "Class vs Fixture — does this code/test handle the CLASS or just the current fixture instance?"
  - Update `CLAUDE.md` cross-reference to `feedback_hardcode_vs_generalize.md`.

### Ship-Phase 3 — Consumer migration (PR-B, 4 sub-PRs)

- **PR-B1**: `metavault.ts` (1066-1071) + `engine.ts:387-390` 3-tier vocabulary fix per R2-BL-3.
  - **Test updates required**: `engine.test.ts:286-288` `[PENDLE-EXT UPCOMING]` → `[PENDLE-EXT SOON]` for 10-day case. Boundary tests at 7/14/30 days.
- **PR-B2**: `curator_portfolio.ts` + `expiry_monitor.ts` (drop `<=21d` per AM-6).
- **PR-B3**: `position_map.ts` + `calibration.ts` + `pendle_expiry.ts`.
- **PR-B4**: `merkl.ts` + remaining sites.

### Ship-Phase 4 — Cleanup

- **PR-F**: `TRANSACTION_QUEUE_KNOWN_KEYS` dissolution + REPLACE existing 38-line PR11 describe block per BL-7.
- **PR-G**: verifier-config metadata population + verifier-registry cross-validation per R2-BL-4 + verifier code reads from metadata + `static ROLES` declared per verifier.
  - **Atomicity per R2-BL-7**: metadata `verifier:` population for avant + pendle AND cross-validation activation ship in single merge.
  - Test fixtures for non-`_unknown` protocols MUST populate `verifier:` before merging (R2-NTH-4).

---

## §10 — Observation boundaries

### What this spec deliberately enforces

- **One source of truth per metadata-readable class** (one row + zero consumer-side edits per BL-3 narrowed claim).
- **Strict `ytFeeRate` discipline** — required for non-`_unknown`; `_unknown` renders `"?% on YT yield"`. Stale verification (`> 60d`) annotated.
- **Verifier-registry cross-validation** — registered verifier without metadata is registry-load failure.
- **`PointsMultiplier.source.value === amount` invariant** — zod-enforced (R2-BL-6). `validUntil` for staleness.
- **`rolloverPolicy` 6-way enum** — captures architecturally-distinct settlement semantics (P7-BL-4).
- **Class-shape tests** at boundaries (7, 14, 30 days; unknown asset; unknown protocol; loud vs silent drift; expired vs in-cooldown).
- **Render gallery contract** (§5.5) — tests assert against gallery, not against literal fixture values (P7-BL-6 α).
- **Forcing function for the discipline** (PR-J) — pre-commit hook + 5th-lens reviewer brief prevents recurrence (P7-BL-6 β).
- **Import-direction discipline** for `src/action-items/`.
- **Verifier cross-validation co-locates with verifier-registry** (R2-BL-4).
- **Stub-metadata aging policy** (§7.5) — protocols surfacing in production for ≥ 7 days without metadata trigger PR requirement.

### What this spec deliberately does NOT resolve (with named triggers)

| Out-of-scope | Trigger to bring into scope |
|---|---|
| Cross-vault sequencing (P7-NTH-1) | 5th vault added to curator portfolio |
| Protocol-aggregate concentration (P7-NTH-2) | Curator's total exposure to one protocol exceeds 30% of AUM |
| YT-decay-aware sizing helper (P7-NTH-3) | Trader-as-stakeholder gets primary status in pipeline |
| `swapFeeRate` field for LP yield forecasting (P7-NTH-5) | LP-as-stakeholder gets primary status |
| Alias-map for new protocols | 4th display-name shape (covered by §7.5 aging policy as primary trigger) |
| Other protocol-filter aggregations beyond `formatters.ts:6049-6086` (per BL-3) | 3rd protocol arrives |
| Test shape pattern for legacy ~141 fixture-mirror tests | Per-file as PRs touch each file (PR-J catches at code-review for new tests) |
| Sundry deduplication (CHAIN_NAMES, ROUTER_BATCHABLE_TYPES, HALT_CHECK_CODES, GAS_REGIME, EVENT_TOPICS) | Clean as encountered |
| Multi-chain Avant | Avant launches on 2nd chain |
| Tool-specific labeling thresholds (`tvlPct > 75/50`, `tvlRatio > 5`, `impliedApy > 10`, `< 21` scanner thresholds, expiry_monitor `<=21d`) | Stay inline with rationale (different semantics from cross-tool consistency) |

### Dissolution conditions

- **PR-A** dissolves when 9th asset class arrives — extend.
- **PR-B** dissolves when 3-tier urgent/upcoming/upcomingMax inadequate.
- **PR-D `ytFeeRate`** dissolves when fee structure can't be flat fraction (tiered, dynamic, fee-in-different-currency).
- **PR-K absolute floors** dissolve when threshold needs revision — comment-at-site invites; OR when the size/trend-relative companions cover the use case fully (then absolute can be deprecated).
- **PR-L `PointsMultiplier`** dissolves when `program/scope/amount` shape doesn't fit (per-day vesting, conditional, multi-asset).
- **`rolloverPolicy` 6-way** dissolves when a 7th category arrives.
- **PR-J** dissolves when the next builder/architect, looking at a fixture, instinctively asks "what's the class beneath this fixture?" — observable via 3 consecutive substrate-diverse audits including 5th lens AND zero hardcode-vs-fixture findings (per A-10 Round 1 dissolution).
- **§5.5 render gallery** dissolves when the rendering layer migrates to a templating language with explicit attribution metadata in the type system itself.

### Open-emergence claim (narrowed)

After Ship-Phase 1 + 2 ship: adding a new protocol's METADATA-READABLE BEHAVIORS is **one row + zero consumer-side edits**. Adding alias-map entry and any new protocol-filter aggregations require explicit registry entries.

**Phase dependency**: claim true only after Ship-Phase 1 + 2 complete. Phase 1 alone reduces blast radius but doesn't fulfill claim.

**Inversion test**: if "adding a new protocol's metadata-readable behaviors still requires ≥1 file edit beyond `PROTOCOL_METADATA`" survives spec review, the abstraction is wrong — go back to architecture.

---

## §11 — DELETED (open questions all closed)

(Per methodology Phase 8: "By v3-final, every open question is closed.")

---

## §12 — Appendix A: out of scope

Cuts retained: PR-H (test shape pattern legacy migration) → `docs/test-shape-spec.md` follow-up. PR-I (sundry dedup) → clean-as-encountered. **PR-J restored to scope per Richard's β decision.**

Genuinely out of scope: pendle_*.ts plugin architecture; DecimalDivisor utility; legacy fixture-mirror tests; TS enum migration; full asset registry; ActionItemCategory priority scoring; multi-chain Avant data; tools/onchain.ts addresses; inline tool-specific magic numbers.

---

## Ready-to-engineer checklist (per Phase 8 methodology)

- [x] All Round-1 BLOCKERs (9) resolved or RESOLVED-WITH-GAP with named gap
- [x] All Round-2 BLOCKERs (7) resolved including 2 hard stops
- [x] All Phase 7 BLOCKERs (6) resolved including the recursive originating-scar self-test (β + α)
- [x] All ambiguities closed (no "lean: X" defers)
- [x] §11 open questions deleted
- [x] Render gallery (§5.5) provides protocol-owner sign-off surface
- [x] Forcing function (PR-J) ships with this spec, not deferred
- [x] §10 observation boundaries names what this cannot resolve + triggers
- [x] Migration path: 4 ship-phases, 10 PRs, each shippable independently with own substrate-diverse 4-lens audit
- [x] Test discipline (shape-based) mandated for PR-L; render gallery is the test contract
- [x] Cross-validation atomicity declared (R2-BL-7)
- [x] PR-D atomicity declared (AM-5)
- [x] Self-review honesty: 4 of 10 PRs are demo-visible, 6 are internal investment

**Spec is engineering-ready. Phase 9 — engineering context handoff prompt — is the final remaining methodology phase.**

---

## Self-review (Phase 8 methodology)

- **Stakeholder filter**: stakeholders named honestly with PR-distribution disclosure (P7-NTH-6). Decisions surface for each archetype. Recipient read-back survives.
- **Existing stack**: all named, preserved or extended.
- **Load-bearing claims sourced**: all citations [tool output] from grep + direct file reads. Cross-lens convergence verified (6-lens render-layer, 3-lens absolute-thresholds, 2-lens update-cadence).
- **Trigger conditions**: 6/6 still met.
- **Architecture skeleton**: stable through 3 review rounds + 1 stakeholder-utility round = 17 reviewer agents total. No fundamental rethink survived.
- **Recursive scar test**: β + α together. Spec dissolves the originating scar at code-level (PR-L) AND process-level (PR-J). Render gallery provides the test contract.
