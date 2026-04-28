# Protocols Metadata Registry — Spec v3 (final)

**Status**: final draft, ready to engineer. 2 rounds of architectural review (4 lenses × 2 = 8 reviews) surfaced 10+2 convergent findings, integrated in v2 and v3. 1 round of stakeholder-utility review (5 lenses: LP/Curator/Protocol-Owner/Trader/composite) surfaced 6 substantive spec gaps, integrated here. Engineering begins in a new context from this document.
**Author**: terminal-me (Arturo-Claudius), 2026-04-23.

**Schema extensions shipped under hardcode-vs-generalize-spec PR-D (2026-04-28)**:
- `ProtocolMeta.ytFeeRate?: SourcedValue<number>` — REQUIRED for non-`_unknown`
- `ProtocolMeta.shortTag?: string` — compact-render tag
- `ProtocolMeta.rolloverPolicy?: 6-way enum` (auto / manual_to_successor /
  redeem_to_underlying / expire_to_lp_share / redeem_no_cooldown / unknown)
- `ProtocolMeta.stressSettlement.useCctp?: boolean` — replaces engine.ts:317
  hardcoded `CCTP_PROTOCOLS` Set

See `docs/hardcode-vs-generalize-spec.md` §1 PR-D row for full rationale.

---

## 0 — Changelog: v3 → v3-final

### Structural additions from stakeholder-utility review

**SU-1 — `InterpretedValue<T>` distinguished from `SourcedValue<T>`** (Protocol-owner finding).
v3 encoded Avant's `settlementDays: 7` as `SourcedValue<number>`, anchored to Avant docs, with `sourceVerifiedOn` implying ongoing verification. But Avant's docs say "one-week cooldown period" as prose. "7 days" is an interpretation, not a direct protocol statement. v3-final splits:
- `SourcedValue<T>` — value DIRECTLY STATED in the cited source (Avant's prose "one-week cooldown" → `SourcedValue<string>: "one-week cooldown"`)
- `InterpretedValue<T>` — value DERIVED from the source; carries interpretation provenance (the 7 → derived from "one-week")

This isn't semantic housekeeping — it's what protects the spec from the legitimate protocol-owner pushback: "you attributed a specific number to us that we didn't commit to."

**SU-2 — `settlementWindow` replaces `settlementDays`** (LP finding).
v3's `settlementDays: 7` implies a ceiling; Avant docs actually specify 1 week as the NOMINAL path, with stress-path extensions possible (queue depth unobserved). LP rendering would have shown "7 days" and been wrong under stress. v3-final:

```typescript
settlementWindow: {
  typical: InterpretedValue<number>;   // nominal-path expectation (was v3 `settlementDays`)
  floor?: SourcedValue<number>;        // minimum — e.g. Avant's strict 7d cooldown
  ceiling?: { value: "unknown"; reason: string };  // when stress-path is unobserved
}
```

Renders as: `"~1 week (floor 7d; ceiling unknown — queue depth unobserved)"` at LP-facing view modes. Curator view renders nominal only.

**SU-3 — `RenderContext.viewMode`** (Curator finding).
v3 had one render path. Curator reviewer flagged: `(verified YYYY-MM-DD)` staleness suffix bleeds into depositor-facing outputs when curator presents to their board. v3-final adds a `RenderContext` argument to `renderExternalPosition` with `viewMode: "curator" | "consumer"` (default: curator — matches current tool caller context). Consumer mode:
- Suppresses `sourceVerifiedOn` staleness suffix
- Shows `settlementWindow` with floor/ceiling spread (not just typical)
- Prepends `oneSentenceIntro` on first encounter of a protocol per output (deduped)
- Keeps drift footer

**SU-4 — `oneSentenceIntro` per ProtocolMeta** (LP finding).
LPs see `burn:avUSDx → claim:avUSD` without knowing what avUSDx is. v3-final adds a required plain-language field on `ProtocolMeta`:

```typescript
oneSentenceIntro: string;  // plain language: "Avant's avUSDx is a yield-bearing wrapper of avUSD; redemption burns the wrapper and queues the underlying."
```

Rendered in consumer viewMode, hidden in curator viewMode (they already know).

**SU-5 — `observationBoundaries.mitigations`** (Curator finding).
v3's `unobservable` list tells the reader what's hidden. It doesn't tell them how to close the gap themselves. v3-final adds optional `mitigations: string[]` — hospital-handoff quality. Example: "Burn submission block timestamp: query `AvantRedemption.orderId(msg.sender)` via Avalanche RPC."

**SU-6 — Scope complementarity named in Appendix A** (Composite + Trader findings).
v3's Appendix A said "out of scope." v3-final strengthens: this registry covers **externalPositions[] only**. Full stakeholder yield/risk analysis requires three layers:
1. externalPositions registry (this spec)
2. Merkl campaigns (incentive layer — `merkl_list_campaigns` tool)
3. Spectra-native positions (underlying AMM state — `spectra_list_pools`, etc.)

An LP or curator asking "what's my effective yield?" needs all three. This spec explicitly covers one-third. Out of scope is not the same as irrelevant.

### Deferred items (follow-up PRs, named not built)

- `mv_get_protocol_context(topic="registry_health")` — surfaces DS-2 threshold proximity, `_unknown` aging, stale `sourceVerifiedOn`. Useful but not Phase 1.
- Module whitelist cross-check — depends on Spectra exposing `/v1/modules`; DS-1 already handles.
- `ProtocolMeta.contactUrl` — correction path for protocols. Social-layer concern; defer until a protocol actually challenges an entry.

### Rounds 1-2 architectural fixes (retained from v3)

- HS-1 `aggregatedApy` dual-source — engine consumes raw `externalPositions[]`, not enriched map
- HS-2 `CostModelName` narrow union + runtime guard
- SS-1 `lp_exit` split by substrate (`lp_exit_samechain` / `lp_exit_crosschain_cctp`)
- AP-1 through AP-6 — all 6 ambiguities pinned
- HF-1, HF-2 — honesty fixes (co-location is visible-not-enforced, freshness surfaced at point-of-use)
- TR-1, TR-2 — trimmed (2 observationBoundaries sub-fields, Q11 closed)
- DS-1, DS-2 — dissolution conditions added

---

## 1 — Why this exists

Current `externalPositions` rendering hardcodes protocol-specific logic across 5 files. Spectra's module whitelist is architecturally extensible (Gaspard confirmation March 2026 — permission system, not fixed integration). Every future protocol addition currently touches all 5 files; the MCP inverts Spectra's own architecture.

This spec mirrors Spectra's shape: generic container + plugin registry.

### Product requirements

**PR1 — Zero-code protocol additions** with one exception: new cost models require (a) `CostModelName` union addition, (b) `COST_MODELS` function addition. Two-file friction is the review gate.

**PR2a — Sourced vs interpreted constants, distinguished**:
- `SourcedValue<T>`: value DIRECTLY STATED in the cited source.
- `InterpretedValue<T>`: value DERIVED from a source — the interpretation chain is part of the record. Registry authors CANNOT use `SourcedValue` for numbers that don't appear verbatim in docs. This prevents the 2d→1w class of bug AND the Avant attribution-creep class of concern.

**PR2b — Prose-layer binding via `describeProtocolWindow()` helper.** Direct time-unit string literals in `src/tools/*.ts` require an inline `// source: <url>` comment or registry reference. CI lint convention.

**PR3 — Agent-queryable registry.** `mv_get_protocol_context(topic="external_protocols")` returns the registry structured.

**PR4 — Drift detection.** `_unknown` fallback + loud inline warning + aggregated per-protocol footer with draft-entry fields.

**PR5 — Observation boundaries required**: every entry MUST declare `observationBoundaries.unobservable: string[]` (empty with explicit TODO permitted). Optional `mitigations: string[]` — how to close the gap yourself.

**PR6 — Minimal code surface.** Engine + cost-models + registry. New cost model requires written justification.

**PR7 (NEW) — Scope complementarity named.** Registry covers externalPositions only. This is one of three yield/risk layers. Appendix A lists the other two and their tools.

---

## 2 — Architecture overview

```
src/
  primitives.ts         # HOME for format helpers (Phase 0 extraction)
  protocols/
    types.ts            # ProtocolMeta, SourcedValue, InterpretedValue, FieldSpec, RenderContext
    metadata.ts         # PROTOCOL_METADATA
    cost-models.ts      # COST_MODELS
    engine.ts           # renderExternalPosition, classifyForStress, generateActionItems,
                        # describeProtocolWindow, DriftCollector
    registry.ts         # getMeta + freshness warnings
    index.ts
  formatters.ts         # imports from primitives + protocols/engine
  tools/
    stress_test.ts
    metavault.ts
    rollover.ts         # NEW consumer
```

---

## 3 — Core types (v3-final)

```typescript
// src/protocols/types.ts

// Value is in the cited source verbatim.
export interface SourcedValue<T> {
  value: T;
  sourceUrl: string;                  // specific anchor proving this EXACT value
  sourceVerifiedOn: string;           // ISO date; "" sentinel only for _unknown
}

// Value is DERIVED from a cited source. The interpretation is part of the record.
// Use this for any numeric constant that doesn't appear verbatim in docs.
// Example: Avant docs say "one-week cooldown" (prose). Typed as 7 days? That's
// interpretation, not sourcing. `value: 7` + `interpretedFrom: SourcedValue<string>: "one-week cooldown period"`.
export interface InterpretedValue<T> {
  value: T;
  interpretedFrom: SourcedValue<string>;  // the prose that was interpreted
  interpretationNote: string;             // why value → T is fair (1 line)
  sourceVerifiedOn: string;               // when the interpretation was last re-checked
}

export type MaybeInterpretedValue<T> = SourcedValue<T> | InterpretedValue<T>;

export interface FieldSpec {
  path: string;                        // dot-path, single-brace
  label?: string;                      // absent → render bare value (AP-6)
  format: "pct100" | "pct1" | "usd" | "date" | "number" | "plain";
}

// Narrow union — HS-2 restored. New cost models edit TWO files (this + COST_MODELS).
export type CostModelName =
  | "zero"
  | "lp_exit_samechain"
  | "lp_exit_crosschain_cctp"
  | "liquidation";

export type CostFn = (args: {
  amountUsd: number;
  poolLiquidityUsd?: number;
  stressMultiplier?: number;
}) => number;

export interface SettlementWindow {
  // Nominal-path expectation (what docs say will happen under normal conditions).
  typical: MaybeInterpretedValue<number>;   // days
  // Minimum — strict floor guaranteed by protocol (if docs commit).
  floor?: SourcedValue<number>;             // days
  // Ceiling — when unobservable, surface the reason explicitly.
  ceiling?: { value: "unknown"; reason: string };
}

export interface RenderContext {
  viewMode: "curator" | "consumer";         // default "curator" at tool-caller layer
  seenProtocols?: Set<string>;              // dedupe oneSentenceIntro across a render batch
}

export interface ProtocolMeta {
  name: string;                        // canonical API name
  label: string;                       // display label
  homeDocsUrl: string;                 // orienting link
  // Plain language — explains what this protocol action IS. Rendered in
  // consumer viewMode on first encounter per output. Hidden in curator mode.
  oneSentenceIntro: string;

  display: {
    primaryTemplate: string;           // single-brace {path}; `{{` for literal `{`
    contextFields: readonly FieldSpec[]; // required; [] for none (AP-6)
  };

  stressSettlement: {
    windowLabel: MaybeInterpretedValue<string>;  // human-readable window
    settlementWindow: SettlementWindow;           // SU-2
    costModel: CostModelName;
    stressExclude?: boolean;                      // default false
  };

  actionItems?: {
    maturityFieldPath?: string;
    maturityThresholdsDays?: {
      urgent?: number;
      upcoming?: number;
      upcomingMax?: number;
    };
  };

  // Required (PR5). `mitigations` is hospital-handoff for the `unobservable` list.
  observationBoundaries: {
    unobservable: string[];            // required; explicit TODO string permitted for empty
    mitigations?: string[];            // SU-5: how to close the gap yourself
    dissolution?: string[];            // conditions that invalidate this entry
  };
}
```

---

## 4 — `metadata.ts` — the registry (v3-final)

```typescript
// src/protocols/metadata.ts

const AVANT_COOLDOWN_DOCS = "https://docs.avantprotocol.com/overview/core-tokens#avusdx";
const PENDLE_AMM_DOCS = "https://docs.pendle.finance/ProtocolMechanics/Mechanisms/AMM";

export const PROTOCOL_METADATA: Record<string, ProtocolMeta> = {
  avant: {
    name: "avant",
    label: "avant",
    homeDocsUrl: "https://docs.avantprotocol.com",
    oneSentenceIntro:
      "Avant's avUSDx is a yield-bearing wrapper of avUSD; redemption burns the wrapper and queues the underlying for a ~1-week cooldown before claim.",
    display: {
      primaryTemplate: "burn:{burnt.symbol} → claim:{claim.symbol}",
      contextFields: [
        { path: "orderId", label: "order", format: "number" },
        { path: "source", format: "plain" },
      ],
    },
    stressSettlement: {
      windowLabel: {
        // Prose verbatim from docs — SourcedValue is correct here.
        value: "one-week cooldown per Avant docs",
        sourceUrl: AVANT_COOLDOWN_DOCS,
        sourceVerifiedOn: "2026-04-23",
      } as SourcedValue<string>,
      settlementWindow: {
        // SU-1 + SU-2: 7 is INTERPRETED from "one-week" prose.
        typical: {
          value: 7,
          interpretedFrom: {
            value: "requires a burn request, which initiates a one-week cooldown period",
            sourceUrl: AVANT_COOLDOWN_DOCS,
            sourceVerifiedOn: "2026-04-23",
          },
          interpretationNote: "One week interpreted as 7 calendar days. Avant's prose is nominal-path; operational variance under queue pressure is unobserved.",
          sourceVerifiedOn: "2026-04-23",
        },
        floor: {
          // Strict minimum is protocol-enforced (you cannot claim before 7d).
          value: 7,
          sourceUrl: AVANT_COOLDOWN_DOCS,
          sourceVerifiedOn: "2026-04-23",
        },
        ceiling: {
          value: "unknown",
          reason: "Queue depth under stress not exposed in Avant's public API; extended waits possible during redemption spikes.",
        },
      },
      costModel: "zero",
    },
    // No actionItems — updatedAt is indexer time, not submission time (see misleading comment inline).
    observationBoundaries: {
      unobservable: [
        "Burn submission block timestamp (Avant exposes only indexer snapshot time)",
        "Queue position relative to Avant's current head orderId",
        "Per-order expected settlement time under stress (only nominal 1-week is guaranteed)",
      ],
      mitigations: [
        // SU-5: hospital-handoff for each unobservable item.
        "For submission timestamp: query Avant's redemption contract on Avalanche via RPC (contract addresses in Avant docs § Core Tokens).",
        "For queue position: fetch current head orderId from Avant's contract and compare against position's orderId (delta approximates queue depth).",
        "For stress-path timing: monitor Avant's redemption completion events over a rolling window; skew from nominal indicates queue pressure.",
      ],
      dissolution: [
        "Avant changes cooldown window from 1 week (re-verify + update interpretationNote)",
        "New Avant source types appear beyond 'avusdx-burn' (new contextFields needed)",
      ],
    },
  },

  pendle: {
    name: "pendle",
    label: "pendle",
    homeDocsUrl: "https://docs.pendle.finance",
    oneSentenceIntro:
      "Pendle LP provides liquidity to a Pendle market; exit is instant via AMM swap but incurs price impact sized by pool depth.",
    display: {
      primaryTemplate: "{market.name}",
      contextFields: [
        { path: "market.maturity", label: "matures", format: "date" },
        // aggregatedApy is decimal (0.085) in raw externalPositions[] — use pct100 (HS-1).
        // Engine consumes externalPositions[] directly, NOT the pre-multiplied pendleEnrichment map.
        { path: "market.aggregatedApy", label: "LP APY", format: "pct100" },
      ],
    },
    stressSettlement: {
      windowLabel: {
        value: "instant AMM exit with price impact",
        sourceUrl: PENDLE_AMM_DOCS,
        sourceVerifiedOn: "2026-04-23",
      } as SourcedValue<string>,
      settlementWindow: {
        typical: {
          value: 0,
          sourceUrl: PENDLE_AMM_DOCS,
          sourceVerifiedOn: "2026-04-23",
        } as SourcedValue<number>,
        // No floor/ceiling — instant is genuinely instant; cost not time is the variable.
      },
      costModel: "lp_exit_samechain",
      stressExclude: true,  // AP-1: preserved conservative-error mode
    },
    actionItems: {
      maturityFieldPath: "market.maturity",
      maturityThresholdsDays: { urgent: 7, upcoming: 14, upcomingMax: 30 },
    },
    observationBoundaries: {
      unobservable: [
        "Current Pendle pool depth at exit time (snapshot liquidity used)",
        "vePENDLE boost applicable to this curator at exit",
        // market.aggregatedApy includes swap fees but NOT PENDLE emissions capture.
        // Treat as floor for LP-APY-expected, not ceiling.
      ],
      mitigations: [
        "For live depth: query Pendle's market contract via `getReserves()` or use the Pendle API's live market endpoint.",
        "For vePENDLE boost: read the curator's vePENDLE balance from Ethereum mainnet and apply Pendle's boost formula.",
      ],
      dissolution: [
        "Pendle adds post-maturity settlement delay",
        "Pendle emissions structure changes such that aggregatedApy becomes misleading beyond current prose note",
      ],
    },
  },

  _unknown: {
    name: "_unknown",
    label: "?",
    homeDocsUrl: "",
    oneSentenceIntro: "An externalPosition protocol that this registry has not yet mapped. Value is visible; shape is not interpreted.",
    display: {
      primaryTemplate: "⚠ UNMAPPED PROTOCOL — position renders raw; see drift footer",
      contextFields: [],
    },
    stressSettlement: {
      windowLabel: {
        value: "unknown — excluded from all stress tiers",
        sourceUrl: "",
        sourceVerifiedOn: "2026-04-23",
      } as SourcedValue<string>,
      settlementWindow: {
        typical: { value: 0, sourceUrl: "", sourceVerifiedOn: "2026-04-23" } as SourcedValue<number>,
        ceiling: { value: "unknown", reason: "No metadata entry; all settlement properties unobserved." },
      },
      costModel: "zero",
      stressExclude: true,
    },
    observationBoundaries: {
      unobservable: ["Everything protocol-specific — no metadata registered"],
      mitigations: [
        "Author a metadata entry per PR template surfaced by DriftCollector.aggregate(). Required fields are enforced by zod at registry load.",
      ],
      dissolution: [
        "A protocol rendered via _unknown for >7 days in live data MUST have a metadata entry authored (DS-2 trigger)",
      ],
    },
  },
};
```

Registry validation at engine import time:
- Zod schema enforces `SourcedValue.sourceUrl: z.string().url()` except where `name === "_unknown"`.
- Zod enforces `InterpretedValue.interpretedFrom` is a valid `SourcedValue`.
- Freshness: entries with `sourceVerifiedOn > 180 days old` emit stderr warning at load. Never throws.
- Render-time freshness: entries with `sourceVerifiedOn > 90 days` append `(verified YYYY-MM-DD)` in curator viewMode; suppressed in consumer viewMode (SU-3).

---

## 5 — `cost-models.ts` (unchanged from v3)

```typescript
export const COST_MODELS: Record<CostModelName, CostFn> = {
  zero: () => 0,
  lp_exit_samechain: ({ amountUsd, poolLiquidityUsd, stressMultiplier = 1 }) => {
    const depth = poolLiquidityUsd ?? 0;
    if (depth <= 0) return amountUsd * 0.01 * stressMultiplier;
    return amountUsd * estimatePriceImpact(amountUsd, depth) * stressMultiplier;
  },
  // Spectra CCTP cross-chain: 1.5x over samechain. Sourced from existing
  // stress_test.ts:354 convention derived from CCTP round-trip latency + Spectra
  // router execution. Non-CCTP substrates (LayerZero, Hop) would add a NEW named model.
  lp_exit_crosschain_cctp: ({ amountUsd, poolLiquidityUsd, stressMultiplier = 1 }) => {
    const base = COST_MODELS.lp_exit_samechain({ amountUsd, poolLiquidityUsd, stressMultiplier });
    return base * 1.5;
  },
  liquidation: ({ amountUsd, stressMultiplier = 1 }) => amountUsd * 0.02 * stressMultiplier,
};
```

---

## 6 — `engine.ts` (v3-final revised)

Four pure functions + one helper + one class:

```typescript
// Primary API surfaces
export function renderExternalPosition(
  ext: TypedExternalPosition,
  tvlUsd: number,
  ctx: RenderContext,                  // SU-3: viewMode-aware
  driftCollector?: DriftCollector,
): string;

export function classifyForStress(
  ext: TypedExternalPosition,
  vaultHomeChainId: number,            // AP-2 resolved: required arg
): StressClassification;

export function generateActionItems(
  ext: TypedExternalPosition,
  nowMs: number,
): string[];

export function describeProtocolWindow(protocolName: string): string;  // PR2b helper

// Utilities
export function effectiveValueAsString<T>(v: MaybeInterpretedValue<T>): string;
// Resolves either SourcedValue or InterpretedValue to its rendered value.
```

### Template resolver (unchanged semantics)
- Single-brace `{field.path}`. Literal `{` via `{{`.
- Missing path: `DRIFT_VISIBILITY=loud` (dev/test/CI, must be explicitly set) → `[MISSING:field.path]`; default production silent → `?`. Read once at module load (deterministic across renders — AP-4).
- Numeric fields formatted per `FieldSpec.format`. No suffix heuristics.
- Precompiled once at module load, eager over frozen `PROTOCOL_METADATA`.

### View-mode rendering (SU-3)

Curator mode (default):
- Primary template + contextFields as specified
- `(verified YYYY-MM-DD)` suffix if `sourceVerifiedOn > 90d`
- `oneSentenceIntro` NOT rendered (curator knows)
- Settlement window shows `typical.value` only

Consumer mode:
- Primary template + contextFields as specified
- Verification suffix SUPPRESSED
- `oneSentenceIntro` rendered once per protocol per output (dedup via `ctx.seenProtocols`)
- Settlement window shows range: `~{typical}d (floor {floor}d; ceiling {ceiling.reason})` — SU-2

### Classifier
- Determines substrate from `ext.chainId` vs `vaultHomeChainId`.
- If declared `costModel === "lp_exit_samechain"` AND substrate is cross-chain AND protocol uses CCTP, swaps to `lp_exit_crosschain_cctp`. Non-CCTP cross-chain substrates stay on declared model.
- Returns `{costModelName, settlementDaysTypical: number | "unknown", stressExclude, windowLabelRendered}` where `windowLabelRendered` pre-formats for the current viewMode.
- `stressExclude: true` → caller skips position in tier placement + max-safe binary search, still subtracts from `idleCapitalUsd` (AP-1).

### Cost function invocation
- `const fn = COST_MODELS[costModelName]; if (!fn) throw new Error(...)` — runtime guard beyond narrow union (HS-2).

### Action item generator
- Reads `maturityFieldPath`, extracts unix-seconds timestamp. Missing path → `[]` silently.
- Emits `[${label.toUpperCase()}-EXT EXPIRED/URGENT/UPCOMING]` at threshold crossings.
- Ordering: appended after existing `[INCENTIVE]` check, preserves `mv.externalPositions` iteration order.

### Metadata-owned vs tool-code-owned alerts
- **Metadata-owned** (single-signal): "fire when daysUntil ≤ N" — purely `ext` + `now`.
- **Tool-code-owned** (multi-signal): cross-signal composition reading metadata for one leg. Example: `[CRITICAL]` when `[PENDLE-EXT URGENT]` AND stress max-safe < 20%.

### DriftCollector
- Per-tool-call instantiation, never singleton (AP-3).
- `record(protocolName, position)` → aggregated via `aggregate(): DriftWarning[]` — de-duplicated per protocol.

---

## 7 — Drift handling

- **Inline at position**: `⚠ UNMAPPED PROTOCOL — position renders raw; see drift footer`.
- **Tool-layer footer**: one entry per distinct unknown protocol, de-duplicated, fresh collector per tool call.
- **PR2b prose binding**: `describeProtocolWindow(name)` helper for tool prose. Direct literals in `src/tools/*.ts` require `// source: <url>` comment.

---

## 8 — Cross-tool dependency map

| Tool | Reads | Purpose |
|---|---|---|
| `spectra_list_metavaults` | `display`, `observationBoundaries` | Render + footer |
| `spectra_get_curator_dashboard` | `display`, `actionItems`, `observationBoundaries`, `oneSentenceIntro` (if consumer mode) | Section + alerts + footer |
| `spectra_stress_test_vault` | `stressSettlement` (all sub-fields) | Tier classification + max-safe-within-N-days |
| `mv_get_curator_portfolio` | — | Protocol-agnostic sum |
| **`mv_plan_rollover` (mandatory)** | `actionItems.maturityFieldPath` | External maturities as first-class rollover candidates |
| `mv_get_protocol_context(topic="external_protocols")` | ENTIRE REGISTRY | Agent consumption |

None write to the registry; human-authored via PR.

Callers pass `RenderContext` — default `viewMode: "curator"`. A future `viewMode: "consumer"` flag on the curator dashboard tool exposes the LP-facing render.

---

## 9 — Migration path

### Phase 0 — Primitives extraction
- `src/primitives.ts` is HOME. `formatUsd`, `formatPct`, `formatDate`, `chainIdToName` (exported), `estimatePriceImpact`, `daysToMaturity`.
- `formatters.ts` imports from `primitives.ts`, re-exports for backward compat.
- Zero behavior change.

### Phase 1 — Introduce registry
- `src/protocols/*`. Populate with avant + pendle + `_unknown`.
- Unit tests:
  - Template resolver (single-brace + `{{` escape + loud/silent modes + all 6 format hints; `pct100` against 0.085 → "8.50%")
  - Cost models (both lp_exit substrates at boundary inputs)
  - Action item generator (EXPIRED/URGENT/UPCOMING thresholds)
  - DriftCollector (per-call isolation + de-duplication)
  - `RenderContext.viewMode` (both modes produce expected output shape)
  - `InterpretedValue` vs `SourcedValue` — zod refuses to use a `SourcedValue` for the `settlementWindow.typical` of avant if `value: 7` (forces `InterpretedValue` typing)
  - Runtime guard `if (!COST_MODELS[name]) throw`

### Phase 2 — Replace render branches
- `formatMetavaultSummary` + `formatCuratorDashboard` call `renderExternalPosition(ext, tvlUsd, ctx, driftCollector)`.
- Format change acknowledged: summary renders `order=N | source_value` (matches current dashboard convention; v3-final canonical). Snapshot tests updated.
- `→` preserved as rendering character.

### Phase 3 — Replace stress test tier
- `spectra_stress_test_vault` calls `classifyForStress(ext, vaultHomeChainId)`.
- `stressExclude: true` → skip tier + max-safe, still subtract from `idleCapitalUsd`.
- Cross-chain substrate resolution via classifier swap.
- Inline `1.5x` at `stress_test.ts:354` removed — moved into `lp_exit_crosschain_cctp`.

### Phase 4 — Replace action items + wire rollover
- `metavault.ts` calls `generateActionItems(ext, nowMs)` per external.
- `mv_plan_rollover` reads `actionItems.maturityFieldPath` for external maturities as first-class rollover candidates.

### Phase 5 — Collapse schema
- `ExternalPositionSchema` → single permissive shape with `protocol: z.string()`, common spine typed, `.passthrough()`.
- `SpectraMetavaultExternalPosition` simplifies in **same PR** (v2 pin retained).
- `DRIFT_VISIBILITY=loud` in test + CI catches missing fields via `[MISSING:path]`.

### Phase 6 — Add agent-queryable registry topic
- `mv_get_protocol_context(topic="external_protocols")` exposes registry.

---

## 10 — Observation boundaries of this spec

### What this spec enforces mechanically
- Typed spine stops at four fields (`protocol`, `chainId`, `valueUsd`, `updatedAt`). Fifth field means protocol-specific logic has colonized the schema — stop and revert.
- `settlementDays: Infinity` prohibited — use `"unknown"` discriminated variant.
- `observationBoundaries.unobservable` required.
- New cost models require two-file edit + written justification.
- `SourcedValue<T>` vs `InterpretedValue<T>` — registry authors cannot use `SourcedValue` for numeric constants not stated verbatim.

### What this spec cannot resolve without building
- Template resolver edge cases at scale (array paths, conditional rendering).
- Whether `DRIFT_VISIBILITY` as env flag vs compile-time build mode — empirical.
- Whether `RenderContext.viewMode` expands beyond curator/consumer (e.g., "protocol-owner-facing" that surfaces attribution chains explicitly).

### Dissolution conditions

**DS-1 — Spec's own dissolution.** This spec dissolves when Spectra publishes `/v1/modules` with typed schemas we can consume. At that point the local registry becomes redundant hydration from the upstream source.

**DS-2 — `stressExclude` calcification trigger.** Any protocol with `stressExclude: true` where observed positions exceed $5M aggregate across live vaults must be revisited. Conservative-error mode becomes a coverage gap at that scale.

**DS-3 — `_unknown` 7-day rule.** A protocol rendered via `_unknown` for more than 7 days in live data must have a metadata entry authored.

### Scope complementarity (PR7)

This registry covers **externalPositions only**. Full stakeholder yield/risk analysis requires three data layers:

1. **This registry**: externalPositions — avant, pendle, future modules held OUTSIDE Spectra LP.
2. **Merkl incentive layer**: `merkl_list_campaigns`, `spectra_get_curator_dashboard`'s Merkl block — external incentive streams.
3. **Spectra-native positions**: `spectra_list_pools`, `spectra_get_pt_details`, `spectra_get_pool_capacity` — the AMM state underlying the vault's core strategy.

An LP asking "what's my effective yield, what's my effective risk" needs all three. A curator managing allocations needs all three. Traders operate mostly in (3).

The three layers don't merge into one tool — they complement. This spec improves (1). LPs and curators reading output from (1) must be aware they're seeing one-third of the picture. Consumer viewMode renders should consider surfacing this explicitly ("this view covers externalPositions; for the full yield picture, call X and Y").

---

## Appendix A — Out of scope

- Protocol-native tools (`pendle_*`, `morpho_*`, `spectra_*`) stay protocol-specific — they call protocol-native APIs with protocol-native request shapes; that coupling is appropriate.
- Tool-level `if (protocol === "X")` for API routing stays.
- Runtime plugin system (dynamic loading from config).

## Appendix B — Findings → v3-final resolution

**Rounds 1-2 architectural findings**:

| Finding | v3-final location |
|---|---|
| HS-1 aggregatedApy dual source | §4 pendle comment + §9 Phase 2 |
| HS-2 CostModelName narrowing + runtime guard | §3 + §6 |
| SS-1 lp_exit substrate split | §3 + §5 two named models |
| AP-1 stressExclude semantics | §6 classifier + §9 Phase 3 |
| AP-2 isCrossChain ownership | moot via SS-1 |
| AP-3 DriftCollector per-call | §6 |
| AP-4 DRIFT_VISIBILITY default | §6 (silent default, loud explicit) |
| AP-5 primitives.ts HOME | §2 + §9 Phase 0 |
| AP-6 label-absent render rule | §3 + §6 |
| HF-1 SourcedValue visible-not-enforced | §1 PR2a language |
| HF-2 freshness surfaced | §3 + §4 + §6 viewMode-aware |
| TR-1 observationBoundaries 3→2 sub-fields + mitigations added | §3 |
| TR-2 open questions closed | resolved in-place |
| DS-1/DS-2 dissolution conditions | §10 |

**Stakeholder-utility findings (v3 → v3-final)**:

| Finding | v3-final location |
|---|---|
| SU-1 InterpretedValue vs SourcedValue distinction | §0 + §3 + §4 avant settlement |
| SU-2 settlementWindow (typical/floor/ceiling) | §0 + §3 + §4 |
| SU-3 RenderContext.viewMode | §0 + §3 + §6 |
| SU-4 oneSentenceIntro per ProtocolMeta | §0 + §3 + §4 |
| SU-5 observationBoundaries.mitigations | §0 + §3 + §4 |
| SU-6 scope complementarity (PR7) | §1 PR7 + §10 + Appendix A |

**Deferred to follow-up PRs**:
- `mv_get_protocol_context(topic="registry_health")` — surfaces DS-2 proximity, `_unknown` aging, stale `sourceVerifiedOn`
- Module whitelist cross-check (depends on DS-1 trigger)
- `ProtocolMeta.contactUrl` — correction path for protocols

---

## Ready-to-engineer checklist

- [ ] All 2 round-2 hard stops resolved (§0 + §6 runtime guard + §4 pendle source comment)
- [ ] All 6 round-2 ambiguities pinned (§0 AP-1 through AP-6)
- [ ] All 6 stakeholder-utility findings structurally integrated (§0 SU-1 through SU-6)
- [ ] Typed surfaces: `SourcedValue<T>`, `InterpretedValue<T>`, `SettlementWindow`, `RenderContext`, `ProtocolMeta`
- [ ] Migration phases mapped with acceptance criteria per phase
- [ ] Observation boundaries declared for the spec itself (§10)
- [ ] Three dissolution conditions + six deferred items explicitly named

Next context: engineer Phase 0 → Phase 1 → ... per §9.
