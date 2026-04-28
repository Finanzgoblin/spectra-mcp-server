# Hardcode-vs-Generalize Audit — Phase 0 Findings

**Date**: 2026-04-27
**Origin**: Richard's critique at end of discard-layer 5-phase session — "the avant points 40 and 60 hardcoded — why isn't this a generalizeable class of type AVANT? You keep doing this error... there are also so many cases hardcoded."
**Method**: grep-audit across `src/**`, supplemented by background Explore-agent breadth pass.
**Scar reference**: `memory/feedback_hardcode_vs_generalize.md`

---

## Test surface (the "many more tests" question)

| File | `it(` count | `assert.match` | `assert.equal` |
|---|---|---|---|
| formatters.test.ts | **378** | 141 | 258 |
| chain-reads.test.ts | 86 | 3 | 124 |
| protocols/engine.test.ts | 53 | — | 41 |
| protocols/pendle-verifier.test.ts | 38 | 38 | 38 |
| protocols/avant-verifier.test.ts | 36 | 27 | 42 |
| api.test.ts | 35 | — | 37 |
| config.test.ts | 29 | — | 27 |
| protocols/types.test.ts | 28 | — | 28 |
| primitives.test.ts | 24 | — | 25 |
| tools/curator_portfolio.test.ts | 24 | 5 | 21 |
| tools/stress_test.test.ts | 21 | 6 | 18 |
| protocols/registry.test.ts | 20 | — | 22 |
| schemas/spectra.test.ts | 18 | — | 22 |
| performance.test.ts | 18 | 15 | 16 |
| protocols/verifier-registry.test.ts | 15 | 2 | 31 |
| schemas/spectra.pt.test.ts | 14 | — | 14 |
| schemas/spectra.pools.test.ts | 13 | — | 23 |
| tools/context.test.ts | 10 | — | 1 |
| investigations/oql-residual-holders.test.ts | 5 | — | 15 |
| **Total (19 files)** | **865** | **237** | **803** |

**Headline:** 865 tests across 19 files. **`assert.match` ratio: 237/865 = 27%** — a quarter of all tests are regex-matching against rendered output. Of those, an unknown fraction are matching against literal fixture values vs class-shape outputs. **Feels-into**: formatters.test.ts alone has 378 tests (44% of the total) — the bulk of test investment is in render-shape verification, and most of those tests assert against the specific values the fixture happens to ship today.

**Test surface vs production surface:**
- 55 MCP tools (per CLAUDE.md), 19 test files
- 28 tool files in `src/tools/` — most without unit tests (only stress_test, curator_portfolio, context have unit tests)
- The integration test (`test.cjs`) covers most tools end-to-end, but the unit-test surface is concentrated in formatters/schemas/protocols, not in tools/

**Richard's read is correct:** there should be more tests in the per-tool sense, AND the existing tests are over-weighted toward fixture-mirror assertions.

---

## Hardcode violations — by category

### Category A — Protocol-specific branching that should be metadata reads

These are `if (protocol === "X")` chains where the spec already has `getMeta(name)` but the consumer reads the literal name instead:

| Location | Pattern | Should be |
|---|---|---|
| `engine.ts:317` | `CCTP_PROTOCOLS = new Set(["avant", "pendle"])` | `meta.stressSettlement.useCctp: boolean` flag |
| `formatters.ts:5945` | `opp.protocol === "pendle" ? "5%" : "3%"` (YT fee) | `meta.ytFeeRate` field |
| `tools/curator_scan.ts:530` | `opp.protocol === "pendle" ? 0.05 : 0.03` (YT fee, **DUPLICATE** of above) | Same `meta.ytFeeRate` — single source |
| `formatters.ts:5873, 5897, 5905, 6002` | `opp.protocol === "spectra" ? "[S]"/"Spectra" : "[P]"/"Pendle"` | `meta.label` (already exists in metadata.ts) + `meta.shortTag` |
| `tools/rollover.ts:53` | `c.protocol === "spectra" ? "[Spectra]" : "[Pendle]"` | Same |
| `formatters.ts:6049-6050, 6085-6086` | `.filter(o => o.protocol === "spectra")` aggregation | Generalized `groupBy(meta.name)` |
| `tools/curator_scan.ts:582, 600, 603, 681-682` | Same protocol-filter + aggregation pattern | Same |
| `tools/metavault.ts:832, 1107` | `p.protocol === "Pendle"` (note: **capital P**, not lowercase key) | `normalizeProtocolName(p.protocol) === "pendle"` — and the upstream caller should already normalize |

**Severity: HIGH.** The spec for protocols-metadata already exists; consumers route around it. The naming-drift sub-issue (capital "Pendle"/"Avant" in metavault.ts vs lowercase "pendle"/"avant" in engine/registry) is itself a hardcode-vs-class symptom — two ways to spell the protocol name flow through the codebase.

---

### Category B — Frozen Sets/Maps mirroring class instances

| Location | Hardcoded data | Class-shape fix |
|---|---|---|
| `formatters.ts:3292` `TRANSACTION_QUEUE_KNOWN_KEYS` | 18 keys captured from gamisUSDC fixture | Discriminated zod schema validating shape; unknown keys logged under flag, not snapshot-fail |
| `formatters.ts:106-118` `DIRECT_ASSETS` + `ONE_HOP_ASSETS` | ~30 stable + LST symbols | `assetMetadata[symbol].class: "stable" | "lst" | "lp"` registry |
| `tools/curator_scan.ts:551` `STABLES` | 16 hardcoded stable names — **DUPLICATE** of DIRECT_ASSETS | Read from same registry |
| `formatters.ts:120` `GAS_REGIME` | chain → high/medium/low gas regime | Property on `SUPPORTED_CHAINS` or `CHAIN_GAS_ESTIMATES` |
| `tools/gauge_votes.ts:60` `CHAIN_NAMES` | Record<number, string> | **DUPLICATE** of `chainIdToName` in primitives.ts |
| `formatters.ts:1418` `ROUTER_BATCHABLE_TYPES` | Set of 3 activity types | Flag on `ACTIVITY_TYPES` entries (`{ label, routerBatchable }`) |
| `formatters.ts:3265` `HALT_CHECK_CODES` | Set of safety check codes | Per-check `{ code, severity, displayLabel }` records |
| `protocols/engine.ts:317` `CCTP_PROTOCOLS` | `Set(["avant", "pendle"])` (**duplicates Category A**) | Same metadata flag |
| `protocols/registry.ts:73` `PROTOCOL_NAME_ALIASES` | 9 hardcoded display→key mappings | Function with normalization rules + fallback chain (the file's own JSDoc admits brittleness on `Ether.Fi` → `ether_fi`) |

**Severity: HIGH.** `TRANSACTION_QUEUE_KNOWN_KEYS` is the one Richard called out by name. `DIRECT_ASSETS`/`ONE_HOP_ASSETS`/`STABLES` triplication is structurally the same scar three times.

---

### Category C — Per-protocol constants that should be metadata fields

| Location | Constant | Should be |
|---|---|---|
| `protocols/avant-verifier.ts:513` | `AVANT_AMOUNT_DRIFT_TOLERANCE_PPM = 100n` | `meta.verifier.amountDriftTolerancePpm` field |
| `protocols/avant-verifier.ts:115` | `AVANT_VERIFY_TIMEOUT_MS = 15_000` | Default + per-protocol override in verifier metadata |
| `protocols/pendle-verifier.ts:115` | `PENDLE_VERIFY_TIMEOUT_MS = 15_000` (**DUPLICATE** value) | Same |
| `protocols/avant-verifier.ts:96` | `AVANT_REQUESTS_MANAGER_AVAX = "0x4c129..." as const` (single chain) | `meta.contracts: { [chainId]: { requestManager: "0x..." } }` (multi-chain ready) |
| `protocols/avant-verifier.ts:488` `STATE_NAMES` | Avant request state → name mapping | Either lives in avant-verifier (acceptable per-protocol detail) OR in `meta.protocolStates` if other consumers need it |
| `protocols/metadata.ts:33-34` | `AVANT_COOLDOWN_DOCS` + `PENDLE_AMM_DOCS` | These are inline metadata helpers — **fine pattern**, not a violation |

**Severity: MEDIUM-HIGH.** Adding a third verifier (already in scope per Theme E continuation) means writing a third `XYZ_VERIFY_TIMEOUT_MS = 15_000` — calcified by construction.

---

### Category D — Generalized class exists but consumers ignore it

This is the most painful pattern: the metadata.ts already has the right shape, but production code still hardcodes its own thresholds.

`metadata.ts:135` — Pendle has:
```typescript
maturityThresholdsDays: { urgent: 7, upcoming: 14, upcomingMax: 30 }
```

…yet across the codebase:

| Location | Hardcoded | Should consume |
|---|---|---|
| `formatters.ts:5217` | `daysToMaturity <= 14 ? "!!!" : <= 30 ? "!!" : ""` | `getMeta(p.protocol).actionItems?.maturityThresholdsDays` |
| `formatters.ts:6071-6073` | `<= 30, 30-90, > 90` (near/mid/far) | Same — extend metadata for "midMaturity" tier |
| `tools/metavault.ts:1066-1070` | `<= 7, <= 14, <= 30` chain — **identical to Pendle metadata!** | Same — direct copy of the existing class as inline literals |
| `tools/curator_scan.ts:697` | `< 21` (custom threshold) | Custom or metadata? Choice point |
| `tools/pendle_scanner.ts:422` | `< 21` | Same |
| `tools/strategy.ts:493` | `< 21` | Same |

**Severity: HIGH.** Class exists, isn't consumed. This is the worst calcification mode — the right abstraction was built and then the codebase routes around it.

---

### Category E — Tests asserting literal values (fixture-mirror)

These are the tests Richard called out directly. Counting from `formatters.test.ts`:

| Pattern | Count | Example |
|---|---|---|
| `/Avant points 40x/` style multiplier | 39+ | `assert.match(out, /lp \[Avant points 40x\] \| yt \[Avant points 60x\]/)` |
| Literal dollar values in regex | 7+ | `/\$128,000\.00 \(\+\$2,000\.00 vs TVL\)/`, `/\$120,000\.00 \(-\$6,000\.00 vs TVL\)/`, `/\$100,000\.00 \(\+\$3,000\.00 vs TVL\)/`, `/\$150,000\.00 total/`, `/\$75,000\.00 pending/`, `/\$25,000\.00/` |
| Decimal-locked values | 1+ in stress_test | `/delta: \+\$32,4\d\d/` (partial wildcard but still 5-digit-prefix locked) |

**The double-hardcode pattern**: tests have `tvl: { usd: 1_000_000 }` in fixture AND `/TVL: \$1,000,000\.00/` in regex. Both bound to the same value. Refactoring the fixture requires hand-editing 5+ test regex strings.

**Class-shape fix**: assertions compose against formatter outputs:
```typescript
const tvlUsd = 1_000_000;
const out = formatMetavaultSummary({ tvl: { usd: tvlUsd } });
assert.match(out, new RegExp(`TVL: ${escapeRegex(formatUsd(tvlUsd))}`));
```

**Severity: HIGH.** Fixture-mirror tests pass deterministically AND test nothing about the class. They prove the formatter handles the specific value, not whatever value a future API ships.

---

### Category F — Doc/comment enumeration that should describe a class

JSDoc comments and commit messages enumerate the specific protocols/multipliers ("Avant/Aegis/Firelight/InfiniFi/Fusion as the 8 firing positions") instead of describing the class ("points-suffixed multipliers without on-chain rewards-attribution"). The CODE generalized via `/points$/i`; the DOCS calcified the specific cases.

**Severity: MEDIUM.** Cosmetic, but reinforces fixture-as-truth at the documentation layer — when a new protocol arrives (e.g. "Lucidly points"), the doc lies until edited.

---

### Category G — Naming/casing drift

`metavault.ts:832, 1107` uses capital-P `"Pendle"` while engine/registry use lowercase `"pendle"`. The display-name vs registry-key boundary is unclear. `normalizeProtocolName` exists in registry.ts:112 but isn't called at every entry point.

**Severity: MEDIUM.** Latent bug — adding a `protocol === "Pendle"` check anywhere inside the lowercase-protocol part of the codebase silently fails.

---

## Things that are NOT violations (good patterns to preserve)

These appeared in the sweep but are actually correct shape:

- `protocols/metadata.ts` `PROTOCOL_METADATA` — well-shaped registry with zod validation, staleness warnings, `_unknown` fallback. The class.
- `protocols/verifier-registry.ts` — strategy dispatch with `BY_NAME` lookup + duplicate-registration guard. The pattern.
- `formatters.ts:5086` `CURATOR_DASHBOARD_THRESHOLDS` — three threshold constants with rationale comments + open-emergence note explicitly inviting threshold revision. **Best example of "hardcoded value with clear dissolution invitation"** — preserve and emulate.
- `protocols/cost-models.ts` `COST_MODELS` — Record<CostModelName, CostFn> indexed by union type. Adding a cost model touches two files (union + function), which is the design's review gate.
- `config.ts` `MORPHO_CHAIN_IDS`, `PENDLE_CHAIN_IDS`, `SUPPORTED_CHAINS_INTERNAL`, `CHAIN_RPC_URLS` — chain registry, fine pattern.
- `config.ts:413` `CONFIG_VERIFIED_DATES` + `STALENESS_THRESHOLD_DAYS` — verification audit trail with auto-warning, good pattern.
- `chain-reads.ts:90` `KNOWN_SAFE_SINGLETONS` — closed set of audited Safe multisig singletons; closed-by-design, good.
- `formatters.ts:1402` `ACTIVITY_TYPES` Record — closed set of API-defined types; needs minor extension (router-batchable flag) not redesign.

---

## Inversion test

If we negate "the codebase has a hardcode-vs-generalize problem":
- Counter-evidence: PROTOCOL_METADATA + verifier-registry + zod validation **do** exist and **are** well-shaped.
- The pattern Richard caught is **partial adoption** — the class exists for some surfaces (settlement window, cost model, label) but not for others (YT fee, CCTP flag, alias normalization, contract addresses, verifier timeouts, action-item thresholds).
- **The finding survives the inversion**: the spec workflow that landed `protocols-metadata-spec` v3-final got the architecture right but didn't migrate ALL hardcoded protocol-specific code to consume it. A bunch of `if (protocol === "X")` survives in tools/ and formatters/ that should be reading from `getMeta(name)`.

So the framing is: **the class exists; the migration is incomplete.** This is a less ambitious refactor than "build the abstraction" — it's "extend the abstraction by ~5 fields and migrate ~30 call-sites."

---

## What this means for the spec

The spec must address:

1. **Metadata fields to add**: `cctp` flag, `ytFeeRate`, `verifier.{timeoutMs, amountDriftTolerancePpm}`, `contracts: { [chainId]: {...} }`, `actionItems.maturityThresholdsDays` (extend with `mid`, `far` tiers if Category D needs them).
2. **Frozen-Set-to-class refactors**: TRANSACTION_QUEUE_KNOWN_KEYS (zod schema), DIRECT_ASSETS/ONE_HOP_ASSETS/STABLES (asset registry), CHAIN_NAMES dedup, GAS_REGIME flag-on-chain.
3. **Test refactor pattern**: shape-based assertions composing against `formatUsd`/`formatPct`/`formatMultiplier`/etc. with parameterized inputs, NOT literal regex against fixture values.
4. **Naming normalization**: `normalizeProtocolName` at every entry point + decision on display-name-vs-key boundary.
5. **Migration plan**: phased, each shippable, with which call-sites to touch in which order. Probably: metadata fields first → consumers migrate → tests refactor → frozen-Sets dissolve.
6. **5th-lens audit check**: every diff henceforth audited for "is this code/test against the class or the fixture?" before commit.

---

## Open questions for spec workflow

(These will be resolved in the spec drafting; logged here for traceability.)

1. **Asset registry** — does a stable/LST/LP classification belong in `src/protocols/metadata.ts` (alongside protocols), in a new `src/assets/metadata.ts`, or as an annotation on `SUPPORTED_CHAINS`? The class is "asset" not "protocol," so likely a sibling file.
2. **Display-name vs registry-key boundary** — should we move ALL display name handling through `normalizeProtocolName` at API boundary (in `src/api.ts` / `src/schemas/spectra.ts`)? That's the cleanest.
3. **`maturityThresholdsDays` extension** — current Pendle metadata has 3 tiers (urgent/upcoming/upcomingMax = 7/14/30). Some consumers need near/mid/far at 30/90 boundary, and curator_scan uses < 21. Do we extend the metadata class to N tiers, or scope the metadata to "alarm thresholds" vs leave display-bucketing as consumer concern?
4. **Test refactor scope** — should the spec require migrating ALL ~141 `assert.match` instances in formatters.test.ts to shape-based, or scope to NEW tests + new code, with an "as-modified" rule for legacy?
5. **Naming inconsistency in metavault.ts** — is `p.protocol === "Pendle"` (capital) bug-or-design? Need to grep upstream where `p.protocol` is set; if the source uses display-name, the fix is to normalize at parse-time.

---

## Phase 0 verdict

**Trigger conditions** (per `docs/spec-workflow-prompt.md`):
- ✅ Touches >3 files structurally (~30 files)
- ✅ Creates new abstractions future code lives on (asset registry, extended protocol metadata)
- ✅ Multi-stakeholder (curators, traders, protocol owners — anyone reading the dashboard)
- ✅ Protocol semantics — fee rates, settlement flags affect protocol presentation
- ✅ Affects code already pinned by prior dialectic (5 phases of discard-layer just shipped)
- ✅ Calcification risk if shipped without review (the entire scar IS that we calcified)

**6/6 conditions met. Spec workflow warranted.**

**Sweep complete.** Ready for Phase 1 first-pass thinking.

---

## Background-agent breadth findings (incorporated 2026-04-27)

The Explore agent's wider sweep found **68 additional patterns** across 8 categories beyond the 16 in my initial pass. **Total scope: ~84 hardcode-vs-generalize violations.** Severity: 30 HIGH, 28 MEDIUM, 10 LOW (agent's tally).

The most consequential expansions:

### E-expanded — Maturity-threshold duplication is the BIGGEST class

Same `<= 7 / <= 14 / <= 30` thresholds repeated **across 12 files**, 16 sites total:

- `tools/metavault.ts:1066-1071` (4 sites)
- `tools/expiry_monitor.ts:88-95` (CRITICAL=7, WARNING=14 — its own enum naming, same values)
- `tools/curator_portfolio.ts:78-83` (duplicate of metavault)
- `tools/position_map.ts:139, 186` (`maturity <= 14`)
- `tools/calibration.ts:522, 529` (`<= 30`, `<= 7`)
- `tools/pendle_expiry.ts:116-117` (duplicate 7/14)
- `tools/merkl.ts:154-172` (campaign expiry: 7d, 30d)
- `tools/pendle_yield_curve.ts:229` (`dayGap <= 7`)
- `tools/curator_scan.ts:697`, `tools/strategy.ts:493`, `tools/pendle_scanner.ts:422` (`< 21` — different threshold but same class)
- `formatters.ts:5217, 6071-6073` (already noted)

**The Pendle metadata at `metadata.ts:135` already declares `{ urgent: 7, upcoming: 14, upcomingMax: 30 }` — and 12 files ignore it.** This is the class that exists and isn't consumed, at industrial scale.

### F — ActionItemCategory enum missing entirely

`tools/metavault.ts:1021, 1065-1108` enumerates 9 category prefixes inline:
`[EXPIRED]`, `[URGENT]`, `[SOON]`, `[UPCOMING]`, `[OUTFLOWS]`, `[BRIDGE]`, `[INCENTIVE]`, `[PENDLE ROLLOVER]`, `[STATUS]`

`tools/curator_portfolio.ts:77-83` re-implements 4 of them (`[EXPIRED]`, `[URGENT]`, `[SOON]`, `[UPCOMING]`).

`tools/expiry_monitor.ts:88, 94, 110, 125` has its OWN urgency labels (`"CRITICAL"`, `"WARNING"`) plus emoji (`"!!!"`, `"!!"`) — third place asking the same categorization question with a third vocabulary.

**Three categorization vocabularies, no shared class.** Severity: HIGH.

### G-expanded — HALT_CHECK_CODES is a 15-code registry, not a 7-code Set

`formatters.ts:3265` has 15 hardcoded halt-check codes. New codes (which arrive when chain-truth verification adds checks) require code edits in two places. Should be `Record<HaltCode, { severity: "blocker" | "warn" | "info"; displayLabel: string }>` so dispatch + display are class-shaped.

### B-expanded — Topic hashes for Deposit/Withdraw/Transfer

`chain-reads.ts:126, 128, 130` hardcodes three event topic hashes. These are well-known constants (keccak256 of canonical signatures), not arbitrary — but they should live in a `EVENT_TOPICS` registry that other consumers can use, not inline in chain-reads.ts.

### Bonus — `incentiveShare > 0.7` magic threshold

`tools/metavault.ts:1100` uses `0.7` as the cutoff for `[INCENTIVE]` flag. Single magic number, but representative of the broader pattern: thresholds inline, no rationale, no dissolution condition.

### Patterns I'd push back on from the agent's report

For full transparency, two of the agent's findings are weaker:
- **"ProtocolPlugin architecture for 7 pendle*.ts tool files"** — those are tool *implementations*, not branches in shared code. Different concern; not a hardcode violation.
- **"DecimalDivisor utility for Math.pow(10, decimals)"** — true DRY but the abstraction (~1 line saved per call site) may not earn its place per CLAUDE.md's "three similar lines is better than premature abstraction."

These don't make the spec.

---

## Updated scope summary for the spec

| Category | Site count | Severity | Refactor shape |
|---|---|---|---|
| Protocol-specific branching (`if protocol === ...`) | ~25 sites in 8 files | HIGH | `getMeta(name).{ytFeeRate, label, shortTag, useCctp}` + extend metadata schema |
| Maturity-threshold duplication | 16 sites in 12 files | HIGH | Consume existing `meta.actionItems.maturityThresholdsDays`, extend with mid/far tiers if needed |
| ActionItemCategory missing | 9 prefixes + 4 duplicates + 4 alt-vocabulary = 17 sites | HIGH | New `ActionItemCategory` enum/discriminated union shared across 3 tools |
| Asset classification triplication (DIRECT_ASSETS / ONE_HOP_ASSETS / STABLES) | 3 places | HIGH | New `src/assets/metadata.ts` registry with `class` field |
| TRANSACTION_QUEUE_KNOWN_KEYS | 1 frozen 18-key Set | HIGH | Zod schema validating shape |
| Per-protocol verifier constants (PPM, timeout, addresses) | 4 constants in 2 files | HIGH | Extend `meta.verifier.*` fields |
| HALT_CHECK_CODES | 1 frozen 15-code Set | MEDIUM | `Record<HaltCode, {severity, displayLabel}>` |
| CHAIN_NAMES duplicate | 1 redundant constant | MEDIUM | Use existing `chainIdToName` |
| GAS_REGIME on chain | 1 constant | MEDIUM | Property on `SUPPORTED_CHAINS` |
| ROUTER_BATCHABLE_TYPES | 1 frozen 3-Set | LOW | Flag on `ACTIVITY_TYPES` |
| Naming-drift `"Pendle"` vs `"pendle"` | 2+ sites in metavault.ts | MEDIUM | Normalize at boundary in `src/api.ts`/`src/schemas/spectra.ts` |
| Test fixture-mirror assertions | ~141 `assert.match` (formatters.test.ts), ~50 in tools tests | HIGH | Shape-based composition; scope: NEW + as-modified |
| Topic-hash registry | 3 inline | LOW | New `EVENT_TOPICS` |
| `incentiveShare > 0.7` magic threshold | 1 site | LOW | Either keep with rationale comment OR move to `INCENTIVE_THRESHOLDS` constant block per `CURATOR_DASHBOARD_THRESHOLDS` pattern |

**Roughly 30-50 call-sites to migrate, 5-7 new metadata fields, 1-2 new registries, ~150-200 tests to consider for shape-refactor.**

This is **not** "build a new abstraction" — it's "extend the existing abstraction by N fields and migrate K call-sites that route around it." The framing matters for scope sizing.

---

## End of Phase 0

