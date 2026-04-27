# Discard-Layer Spec — surface-discarded-substrate

**Version**: v3-final
**Status**: ready-to-engineer (Phase 0 → Phase 4 + Phase 6)
**Author**: terminal-claudius (architect), April 27, 2026
**Premise (FIXED)**: Surface zod-validated discarded MetavaultSchema fields. Reviewers contest *how*, not *whether*.

---

## 0 — Changelog (v3 → v3-final)

Round 3 (stakeholder-utility) ran 5 reviewers across substrate-ablation × stakeholder-seat matrix:
- Sub-agent (Opus + soul + defi-analyst)
- Curator daily-ops (Opus + soul + defi-analyst)
- Protocol-owner (Opus + no-soul + defi-analyst, three hats)
- Researcher / Richard's seat (Sonnet + soul + defi-analyst)
- Composite cross-cut (Sonnet + soul, no web research)

### NEW BLOCKER from round 3

| Finding | Lens | v3-final resolution |
|---|---|---|
| **PR3 priority inverted against fixture reality** — `metadata.shortDescription` is empty in 6/6 fixtures; `description` is populated 6/6. v3 said "prefer shortDescription, fall back to description." Existing code at `formatters.ts:3274` silently drops description for ALL 6 MVs. | Sub-agent (fixture-verified) | **PR3 priority INVERTED**: `description` truncated to 140 chars is the primary render path; `shortDescription` is a curator-controlled override checked first only when present. Updated §1 PR3 + §4 description section. |

### MAJOR fixes from round 3

| Finding | Lens | v3-final resolution |
|---|---|---|
| **Modal-consumer citations are docstrings not callers** — v3 §2's 7 grep references are error-redirect strings ("Use spectra_list_metavaults() to discover..."), not actual call sites. Real evidence: `.claude/agents/defi-analyst.md:107` system prompt directive + Richard's exploration session pattern. | Sub-agent | §2 citations REPLACED. |
| **Aggregate-trigger over-shoots** — today's emit is ~330 lines for 6 MVs (not ~3000); per-MV >200 trigger fires first under realistic curator growth (Gami today ~75 lines + ~18 v3 = ~93; aggregate fires at ~35 MVs at full v3 density). | Sub-agent | §10 RE-FRAMED: per-MV trigger primary; aggregate trigger secondary; thresholds re-quantified against measured baseline. |
| **PR5 `⚠ unmapped` reads as risk flag against external protocols** — Yearn/Firelight/Aegis/IPOR Fusion teams reading downstream sub-agent quote "`Upstream: Yearn ⚠ unmapped`" perceive "Spectra flags this as risky." Audience for warning is MCP author (internal); audience for rendered output is downstream readers. | Protocol-owner | **PR5 ⚠ glyph STRIPPED**. Render: `Upstream: <name> (registry: pending — author entry per protocols-metadata-spec)`. 7-day clock at metadata.ts:188-189 still fires for MCP author. Tonal fix preserves intent without protocol-team perception risk. |
| **PR11 args could marginally aid future MEV** — current QUEUED action class is `registerMarketAsMetavault` (no exploit), but future selectors with token-amount args (swap, redeem, withdraw) would be MEV-relevant. v3's KNOWN_KEYS semantic decoding lowers competitive scraping cost. | Protocol-owner + Curator | **PR11 SCOPE-NARROWED**: render `selector + functionName + cooldownEndTimestamp + queuedSince` by default. Defer `actions[].args` to verbose flag. Renders raw selector format `Pending: 0xa3...92 → executable 2026-04-29T12:00Z` rather than human-decoded action description. |
| **PR10b stakeholder mislabeled** — "alpha for curators assessing governance attack surface" is wrong; deploying curator already knows their governance. Real beneficiaries: auditors, counterparties, depositors doing pre-deposit DD. | Curator + Protocol-owner | **PR10b DASHBOARD-CUT** unless cross-chain delays *diverge*. Stays on list_metavaults (auditor surface — fine; that's `_unknown` registry's natural beneficiary). On dashboard: render only when home/remote delays differ (curator's misconfiguration alpha). |
| **5 PRs put cold-reader metadata on daily-ops surface** — PR1, PR2b, PR3, PR8, PR12a are static metadata the curator authored themselves. Curator running `spectra_get_curator_dashboard` daily doesn't need vault biography. | Curator (web-grounded by Morpho/Gauntlet/Veda separating metadata from operational view) | **§8.1 SHRUNK from 7 dashboard-extension PRs to 2**: PR2a (drift-flag-only) + PR4 (attribution-creep flag-only) + PR5 (registry-pending warning portion). Other 5 PRs ship to `list_metavaults` only. |
| **PR6 delta-only insufficient** — for an expired position (gamisUSDC sUSDp), `maturityValue.usd` IS the redemption claim; absolute is load-bearing for capital planning. Delta alone implies "no loss" but doesn't confirm "redeemable now." | Researcher (worked example: gamisUSDC sUSDp $126K) | **PR6 RENDERS BOTH** — `Maturity value: $128,000 (+$2,000 vs TVL)`. Closes Q4. |
| **PR8 agent-flag complexity unnecessary** — sub-agents need address as join key for Merkl integration, registry lookup, claim-path verification. Symbol-only burdens deep-dive, doubles tool calls. | Researcher + Sub-agent | **PR8 DEFAULT-RENDERS ADDRESSES** as `Reward tokens: rFLR (0x26d1...), AvantPoints (0xab12...)`. Drop the flag entirely. Closes Q6. |
| **§6 layout puts metadata FIRST when curators want alpha-actions FIRST** — Morpho's "Pending tab" + Gauntlet VaultBook validate alpha-state-first ordering for daily-ops. v3's identity-then-strategy-then-description sequence is cold-reader path. | Curator (web-grounded competitor pattern) | **§6 layout COUNTER-PROPOSAL ADOPTED for `formatCuratorDashboard`**: alpha-actions block (PR11 + action items + urgent maturity) at TOP when non-empty; metadata block (PR1/PR2b/PR3/PR4/PR8/PR12a) collapsed to one line at BOTTOM. List_metavaults retains current cold-reader order. |
| **Composite-warning Christmas-tree** — when 3+ warnings fire on one MV (drift + unmapped + pending + cross-chain-delta), rhetorical accumulation produces "this vault has problems" misread. | Protocol-owner (composite-failure scenario) | **§7.1 NEW — Warning consolidation rule**: maximum one marker glyph per MV-block render. Subsequent warnings render as plain prose without `⚠`. Audit-trail footer enumerates which markers fired. |

### Strengthenings from round 3

| Finding | Lens | v3-final resolution |
|---|---|---|
| 7 PRs are AMMUNITION (consulting differentiation), 11 are CATEGORY DATA (substrate/correctness) | Researcher | §1 ammunition-flag added per PR; Phase ordering re-prioritizes ammunition-first (see Phase 1 re-order below). |
| Phase 1 mixes cold-eval (PR1, PR4) with deep-dive (PR2a) and computed-elsewhere (PR9) | Sub-agent | **Phase 1 RE-ORDERED to cold-eval-heavy**: PR1, PR4, PR5, PR12b ship first. PR2a + PR9 deferred to Phase 2. |
| Recite-vs-feel scar fires at structural level — spec recites "ammunition" but doesn't filter against it per-PR | Researcher (structural finding) | §1 per-PR table now flags AMMUNITION vs CATEGORY DATA explicitly. Spec-reader can decompose without re-reading the whole document. |

### NEW SECTION — §13 Discard-layer audit

Round 3 sub-agent flagged: spec misses fields whose silent-absence shape matches the April-27 Lens A burn (`createdAt` invisible → agent inferred from epoch counts). §13 enumerates ALL schema-declared but currently unsurfaced fields with fixture population, classified into "intentional silence" / "to surface" / "needs Phase 0 investigation."

### Open questions (closed in v3-final)

- ✓ Q4 (PR6 render-policy) — absolute + delta both render
- ✓ Q6 (PR8 agent-flag) — drop flag, default-render addresses
- ✓ Q9 (PR17 → Phase 1) — confirmed
- ✓ Q10 (aggregate-trigger curator-count) — quantified at ~35 MVs at v3 density

### Open questions remaining (round 4 OR live evidence)

- Q8: §6 layout for `list_metavaults` — does cold-reader path stay identity-first, or migrate to alpha-actions-first?
- **NEW Q11**: synthesis-classifier (one-line `[track-record-class][drift-level][yield-quality][gov-shape][scope-breadth]` per MV) — sub-agent's structurally novel finding. Major scope-add (~3-4 hours engineering); deferred as separate spec.

### Open question NOT addressed in v3-final (composite cross-cut)

Composite verdict was **TOOL-HYGIENE / DISPLACEMENT**: v3 implementation timing is the question, not v3 content. v3-final addresses content; **timing decision is Richard's**, separately from this spec. Spec stands ready to engineer; ship-day depends on Avant + Gami DM status.

---

## 1 — Why this exists

Two structural failures from the April 27 economic-sanity audit:

1. Lens A inferred "track-record < 90 days" from epoch counts. `metavault.createdAt` was at [src/schemas/spectra.ts:362](../src/schemas/spectra.ts) — sub-agents can't compute what they can't see.
2. The discard layer is silent — agents have no signal that fields are missing.

The premise: surface observable curator actions and protocol state. Manage verbosity via line-shape ergonomics + silent-on-clean.

### Product requirements (with ammunition flags from round 3 researcher)

| PR | Description | Surface | Verdict |
|---|---|---|---|
| **PR1** | `Inception: 2026-01-15 (102d ago, track-record-class: <30d|30-90d|≥90d)` | list (only) | **AMMUNITION** — Clearstar track-record / April-27 BLOCKER fix |
| **PR2a** | Compare `mv.defaultIbt` (address) vs `positions[].ibt.address` set; render drift count when `inDeclared < positions.length`. Silent when `defaultIbt` undefined OR positions empty. | list + dashboard (drift-flag) | **MIXED** — fires only when populated (1/6 fixtures) |
| **PR2b** | Curator URL silent when absent | list (only) | **CATEGORY** — sub-agent routing substrate |
| **PR3** | **PRIORITY INVERTED v3-final**: `description` truncated to 140 chars is primary path; `shortDescription` is curator-override checked first only when present | list (only) | **CATEGORY** — sub-agent orientation |
| **PR4** | Vault tags + per-position tags (asset-class labels: `'stable'`, `'eth'`). **Attribution-creep flag CORRECTED v3-final via Phase 0 fixture verification** — Phase 0 confirmed the `tags` field carries asset-class labels only; the points-program semantic lives in `multipliers`. **Reframed test**: when `position.multipliers` (Array or `{lp,yt}` shape) contains an entry whose `.name` matches `/points$/i` (case-insensitive ends-in-"points") AND `position.ibt.apr.details.rewards` is empty/undefined → render flag `Multipliers: <list> (no on-chain rewards populated — points program declared, settlement evidence absent)` (NO `⚠` glyph per §7.1). **Verified-firing fixtures (8 positions across 4 vaults — caught by Lens 1 defi-analyst cross-reference, complete enumeration v3-final-patch):** gamisUSDC pos[1] (`Aegis points`), gamisUSDC pos[3,4,5] (`Avant points`), gamisXRP pos[0,1] (`Firelight points`), CSMVUSDC pos[2] (`Drops` + `InfiniFi points`), CSfusionMVWETH pos[0] (`Fusion points`). All 8 positions have `position.multipliers` populated AND `position.ibt.apr.details.rewards` empty/undefined — flag fires for every points-class multiplier observed in current fixtures. **Phase 1 actually renders 6 of 8 firings** (Phase 1 audit, Diverger lens — protected finding): the `allocatedPositions` filter at `formatters.ts:3501-3504` (the same gate used for PT APY / LP APY display) suppresses the 2 expired-no-LP positions (gamisUSDC pos[1] Aegis sw-sYUSD 2026-03-20; gamisXRP pos[1] Firelight 2026-03-05). All silenced positions are dust/expired class — Phase 1 surfaces the consulting-alpha subset (currently-allocated, settlement-active). Future PR candidate: separate unallocated-positions iteration that surfaces PR4/PR12b/PR17 substrate without PT APY. **Verified-NOT-firing**: CSMVUSDC pos[0,1,3] have `rewards: {KAT App Rewards, KAT Base}` populated but NO multipliers — they're not in the firing universe at all (multipliers absent → flag silent). The flag mechanically lives on the multipliers surface, but is named PR4 historically; consider relocating to PR12a/b in a future revision. | list + dashboard (flag-only) | **AMMUNITION** — points attribution-creep across Avant/Firelight/Aegis/InfiniFi/Fusion |
| **PR5** | Formatter calls `getMeta(normalizeProtocolName(pos.ibt?.protocol ?? ''))`. Renders `Upstream: <name>` always. When `_unknown` returns: appends `(registry: pending — author entry per protocols-metadata-spec)`. **NO `⚠` glyph (v3-final tonal fix).** Hooks 7-day clock at metadata.ts:188-189. | list + dashboard | **CATEGORY for Richard** (enables ammunition; not direct call material) |
| **PR6** | **RENDERS BOTH (v3-final)**: `Maturity value: $128,000 (+$2,000 vs TVL)`. Render only when both fields defined AND \|delta\| > 1%. | list (only) | **MIXED** — see worked example below |
| **PR7a** | Move `computePerformanceMetrics` + `formatPerformanceMetrics` from `tools/metavault.ts:95-220` to NEW `src/performance.ts`. Add `formatPerformanceMetricsOneLine`. Migrate test coverage. | (refactor) | **CATEGORY** — enables PR7b |
| **PR7b** | `formatMetavaultSummary` imports from `src/performance.ts`, computes internally from `mv.epochs`, renders `Performance: TWR 7.86% / DD -1.23% / Sharpe 0.6 (102d)`. NO new parameters. Dashboard keeps existing full block. | list (one-line) + dashboard (full block, unchanged) | **AMMUNITION** — multi-vault Sharpe scan in list |
| **PR8** | **DEFAULT-RENDERS ADDRESSES (v3-final)**: `Reward tokens: rFLR (0x26d1...), AvantPoints (0xab12...)`. Drop agent-flag. | list (only) | **MIXED** — addresses are sub-agent join key |
| **PR9** | **EXPLICIT collapse condition**: `typeof totalPendingUsd === 'number' && totalPendingUsd === 0 && bridge.transactions.length > 0`. Pending-with-no-history-yet branch outside existing guard. | list (only) | **CATEGORY** — bridge fidelity |
| **PR10a** | `Governance: <roles> | <delays>`. NON-DEFAULT roles only render. | list + dashboard (when non-default) | **AMMUNITION** — Phylax governance attack surface |
| **PR10b** | Per-foreign-chain `Governance (<chainId>): <roles> | <delays>`. **DASHBOARD ONLY when home/remote delays diverge (v3-final)**. Stays on list_metavaults always. | list always; dashboard when divergent | **AMMUNITION** — cross-chain timelock divergence (Phylax + cross-chain audits) |
| **PR11** | **SCOPE-NARROWED (v3-final)**: render `selector + functionName + cooldownEndTimestamp + queuedSince` by default. Defer `actions[].args` to verbose flag. Render shape: `Pending: 0xa3...92 → executable 2026-04-29T12:00Z`. Gate per §7. | list + dashboard (top block when non-empty) | **MIXED** — alpha when populated |
| **PR12a** | `Multipliers: PointsX 2.0x, Avant 3x` from vault-level `metavault.multipliers` (Record<string, number>) | list (only) | **AMMUNITION (with PR4)** |
| **PR12b** | Per-position multipliers parity + bug-fix backport. Three call sites: `formatMetavaultSummary` (NEW with `Array.isArray()` disambiguation), `formatPositionSummary:676` (backport), `formatPoolSummary:592` (backport). | list (only) | **CATEGORY** — bug-fix correctness |
| **PR17** | `Wraps: <baseIbt.symbol>` when present and ≠ ibt.symbol (sw-* wrappers). Pure schema read at `PositionSchema:218`. | list (only) | **CATEGORY** — sw-* gotcha class |

### Phase 6 (residual sweep)

| PR | Field | Render |
|---|---|---|
| **PR13** | `position.rate` | `Rate: <raw-string>` when populated |
| **PR14** | `position.createdAt` (RENAMED `Position Opened:`) | `Position Opened: YYYY-MM-DD (Xd ago)` |
| **PR15** | `bridge.paths[]` | Investigate-then-render gate per §7 (parallel to PR11) |
| **PR16** | `remote.{chainId}.address` | `Remote: chain <id> deployed at <shortenAddress(addr)>` |
| **PR18** | `metavault.exchangeRate` | `Exchange rate: <raw>` |
| **PR19** | `metavault.infraVault` | `Infra vault: <shortenAddress(addr)>` |

PR14 is **AMMUNITION** (Clearstar position-age / operational neglect); rest are CATEGORY.

---

## 2 — Architecture overview

### Render mode — Option A (default-render-everything) for `list_metavaults`; layout-flipped for dashboard

**Modal-consumer citations REPLACED v3-final**: Real evidence is `.claude/agents/defi-analyst.md:107` ("When asked to audit something by name, **always start with `spectra_list_metavaults()`**") — a sub-agent system prompt that directs list_metavaults as the discovery primitive. Plus Richard's exploration sessions (becoming-terminal April 16: "give me a list of all metavaults" — direct human use). The 7 grep refs in v3 §2 were docstrings, not callers; cited evidence updated.

Dissolution triggers (calibrated against measured baseline):
- **Per-MV trigger (PRIMARY)**: 90th-percentile MV exceeds 200 lines (Gami today ~75 lines + ~18 v3 additions = ~93; headroom ~2x; first-firing under curator growth)
- **Aggregate trigger (SECONDARY)**: `spectra_list_metavaults` no-chain-filter emits >2500 lines total (today: ~330 for 6 MVs; fires at ~35 MVs at v3 density; 6x headroom)
- **Modal-consumer shift**: usage telemetry shows human-direct calls > sub-agent calls (re-evaluate Option A prior)
- **Schema trigger**: MetavaultSchema gets MV-V2 shape → re-spec, not patch

### File-level architecture

| File | Change shape | PRs |
|---|---|---|
| `src/formatters.ts` | Extend `formatMetavaultSummary` (line 3263+) with new branches; backport `Array.isArray()` to lines 592 + 676 | all PRs except PR7a |
| **`src/performance.ts` (NEW)** | Holds `computePerformanceMetrics`, `formatPerformanceMetrics`, `formatPerformanceMetricsOneLine` | PR7a + PR7b |
| `src/tools/metavault.ts` | PR7a removes performance functions; tool wiring populates new `CuratorDashboardOpts` fields for PR2a, PR4, PR5 only | PR7a + 3 dashboard-extension PRs |
| `src/primitives.ts` | NEW: `shortenAddress`, `formatSecondsAsDuration`, `truncateDescription`, `formatRoleRecord`, `formatDelayRecord`, `normalizeProtocolName` | Phase 0 |
| `src/protocols/registry.ts` | NEW export: `PROTOCOL_NAME_ALIASES`, `normalizeProtocolName` function | PR5 |
| `src/tools/curator_portfolio.ts` | NO CHANGES (scope-narrowed) | none |

---

## 5 — Cost models / helpers / pure functions

### NEW primitives (Phase 0)

- `shortenAddress(addr: string): string`
- `formatSecondsAsDuration(secondsString: string): string` — `[unparsed:value]` fallback on NaN
- `truncateDescription(s, max): string | null`
- `formatRoleRecord(roles: Record<string, string> | undefined): string | null`
- `formatDelayRecord(delays: Record<string, string> | undefined): string | null`
- `normalizeProtocolName(displayName: string): string` — alias-map + lowercase-with-spaces-to-underscores fallback

### NEW registry export (Phase 0)

```ts
// src/protocols/registry.ts
export const PROTOCOL_NAME_ALIASES: Record<string, string> = {
  "Avant": "avant",
  "Pendle": "pendle",
  "Parallel Protocol": "parallel",
  "IPOR Fusion": "ipor_fusion",
  "Ether.fi": "ether_fi",
  "Firelight": "firelight",
  "Yearn": "yearn",
  "Aegis": "aegis",
  "Lucidly": "lucidly",
};

export function normalizeProtocolName(displayName: string): string {
  if (!displayName) return "";
  if (PROTOCOL_NAME_ALIASES[displayName]) return PROTOCOL_NAME_ALIASES[displayName];
  return displayName.toLowerCase().replace(/\s+/g, "_");
}
```

---

## 6 — Engine / dispatcher (layout-flipped per surface)

### `list_metavaults` (cold-reader path — current order retained)

```
-- <name> (<symbol>) --
  Status / Chain / MetaVault / Vault / Curator | URL
  Inception: <date> (<days> ago, track-record-class: ≥90d)    ← PR1
  Declared: <ibt> via <option>                                ← PR2a (when populated)
  Description: "<truncated 140>"                              ← PR3 (description primary)
  Tags: [<vault-tags>]                                        ← PR4
  Underlying: <symbol> (<address>)
  TVL: $X.YZ ...
  Multipliers: <list>                                         ← PR12a
  Live APY ...
  Performance: TWR / DD / Sharpe (Xd)                         ← PR7b one-line
  Share Price ...
  Pool Allocations:
    PT-... -- ...
      Tags / Upstream / Maturity-value / Reward-tokens / Multipliers / Wraps / Rate / Position-Opened
      <existing pool fields>
  External Positions ...
  Modules / Remote ...
  Bridge: ...                                                 ← PR9
  Governance (home / remote per chain) ...                    ← PR10a + PR10b (always)
  Pending Actions: <selector + cooldownEnd> ...               ← PR11 (raw)
  [chain-truth] / Vault Flows ...
```

### `formatCuratorDashboard` (daily-ops path — LAYOUT FLIPPED v3-final)

```
[ALPHA-ACTIONS]                                              ← TOP when non-empty
  Pending: <selector + executableAt>                         ← PR11
  Action items (existing dashboard generation)
  Urgent maturity (existing !!!flag)
--- Vault Health ---
  TVL / APY / Share price / Capital state
  Performance (full block, unchanged)                        ← existing dashboard render
--- Pool Allocations / External Positions / Modules ---
  (existing)
--- Bridge Activity ---                                      ← existing (PR9)
--- Governance ---
  Home (when non-default) | Remote per chain (when divergent)  ← PR10a + PR10b (divergence-only)
--- Vault Identity (collapsed) ---                           ← BOTTOM, one line
  Inception 2026-01-15 (102d, ≥90d) | Description: "..." | Tags: [...] | Multipliers: ... | Wraps: ...
  PR1 + PR2b + PR3 + PR4 + PR8 + PR12a all collapsed here when present
--- Next Steps ---
```

§8.1 dashboard-extension table now lists ONLY 3 PRs requiring `CuratorDashboardOpts` mutations: PR2a (drift-flag), PR4 (attribution-creep flag), PR5 (registry-pending warning portion). Layout-flipped collapse-block uses already-passed schema fields without new opts mutations.

---

## 7 — Drift handling / fallback

(Existing fixture-first gates per PR11 + PR15 unchanged from v3.)

### §7.1 — Warning consolidation rule (NEW v3-final)

Maximum **one** marker glyph per MV-block render. When multiple warnings fire on the same MV, the FIRST (by render order) carries any glyph; subsequent warnings render as plain prose.

Audit-trail footer at end of MV block when 2+ warnings fire:
```
[markers fired: drift, registry-pending, divergent-timelock]
```

This prevents the rhetorical-accumulation Christmas-tree where 4 individually-fine warnings stack into a "this vault has problems" misread.

PR5's tonal fix (NO `⚠` glyph; renders as `(registry: pending — author entry)`) helps too — fewer total glyphs reduces the accumulation surface.

---

## 8 — Cross-tool dependency map (CORRECTED v3-final)

| Tool | Migration scope |
|---|---|
| `spectra_list_metavaults` | All 12 PRs + Phase 6 land in `formatMetavaultSummary` |
| `spectra_get_curator_dashboard` | **§8.1 SHRUNK to 3 PRs** (PR2a flag, PR4 flag, PR5 warning); layout flipped per §6 (alpha-actions FIRST, metadata collapsed at BOTTOM) |
| `mv_get_curator_portfolio` | NO inheritance. PR1's `createdAt` first-migration candidate. |
| Other tools | unchanged |

---

## 9 — Migration path (RE-ORDERED v3-final)

### Phase 0 — Primitive scaffolding + measurements

- 6 helpers in `primitives.ts` + `PROTOCOL_NAME_ALIASES` export + `normalizeProtocolName`
- Capture `tags[]` fixture values across chains (confirm "points" string convention)
- Capture baseline line counts on Gami (~75) / CSMVUSDC (~50) / UltraWETH (~25) for dissolution-trigger calibration
- §13 discard-layer audit fixture-population check

### Phase 1 — Cold-eval ammunition (RE-ORDERED v3-final)

PR1 + PR4 + PR5 + PR12b. Cold-eval-heavy. All independent of Phase 0. **Highest sub-agent triage value.**

### Phase 2 — Performance refactor + deferred Phase-1 PRs

PR7a (NEW `src/performance.ts`), PR7b (call site), PR8 (default-render addresses), PR2b (curator URL), PR2a (drift detection — deferred from Phase 1), PR9 (bridge collapse — deferred from Phase 1), PR17 (per-position baseIbt — sw-* gotcha), PR6 (maturity absolute+delta).

### Phase 3 — Description + multipliers

PR3 (description-primary v3-final), PR12a, PR14 (Position Opened — Clearstar operational-neglect ammunition).

### Phase 4 — Governance + alpha-actions

PR10a (home), PR10b (always on list; dashboard divergence-only), PR11 (scope-narrowed selector-only render).

### Phase 6 — Residual sweep

PR13, PR15 (fixture-first), PR16, PR18, PR19.

### Cross-phase invariants (CORRECTED v3-final)

| Pair | Invariant | Result |
|---|---|---|
| Ph0 → Ph1 | Phase 1 PRs (PR1/PR4/PR5/PR12b) — only PR5 uses `normalizeProtocolName` (Phase 0) | PASS only if Ph0 ships first; PR1/PR4/PR12b can ship before Phase 0 |
| Ph0 → Ph2 | PR7a/b unrelated to Ph0; PR2a/9/17/6 also independent; PR8 uses no Phase 0 helper | PASS |
| Ph0 → Ph3 | PR3 uses `truncateDescription` (Phase 0) | PASS only if Ph0 ships first |
| Ph0 → Ph4 | PR10a/b uses `formatRoleRecord` + `formatDelayRecord` + `formatSecondsAsDuration` (Phase 0) | PASS only if Ph0 ships first |
| Ph2 → Ph3 | PR3 + PR12a + PR14 unrelated to Phase 2 PRs | PASS |
| Ph3 → Ph4 | independent | PASS |
| Ph4 → Ph6 | independent | PASS |

---

## 10 — Observation boundaries (REFRAMED v3-final)

### Dissolution triggers (per-MV primary, aggregate secondary)

- **Per-MV trigger (PRIMARY)**: 90th-percentile MV exceeds 200 lines at default density. Today: Gami ~75 → ~93 post-v3 → ~107 headroom 2x. Fires first under curator growth.
- **Aggregate trigger (SECONDARY)**: `spectra_list_metavaults` no-chain-filter emits >2500 lines total. Today: ~330 for 6 MVs → fires at ~35 MVs at v3 density. Slower-moving signal.
- **Modal-consumer shift**: telemetry shows human-direct calls > sub-agent calls
- **Schema trigger**: MV-V2 shape → re-spec
- **PR5 alias-map drift**: new `position.ibt.protocol` value not in `PROTOCOL_NAME_ALIASES` AND lowercased version not in registry → 7-day clock starts
- **Curator_portfolio re-delegation trigger**: if `mv_get_curator_portfolio` rebuilds to delegate to `formatMetavaultSummary`, §8 propagation table dissolves

REMOVED: ">50% timelock-delta decrease post-ship" (was unobservable, downgraded in v3, removed in v3-final).

---

## 11 — Open questions

### Closed in v3-final

- ✓ Q4 PR6 — render BOTH absolute and delta
- ✓ Q6 PR8 — default-render addresses; drop flag
- ✓ Q9 PR17 — Phase 1 (sub-section of Phase 2 in v3-final ordering)
- ✓ Q10 aggregate-trigger — quantified at ~35 MVs at v3 density

### Carried for round 4 OR live evidence

- **Q8**: `list_metavaults` cold-reader-path layout — does identity-first stay, or migrate to alpha-actions-first? (Dashboard already flipped; list deferred until human-direct usage telemetry available.)
- **Q11 (NEW)**: synthesis-classifier — one-line `[track-record-class][drift-level][yield-quality][gov-shape][scope-breadth]` per MV. Major scope-add (separate spec). Sub-agent's structurally novel finding deferred as PR20+ standalone proposal.

---

## 12 — Appendix A — out of scope (EXPANDED v3-final)

(unchanged):
- Depositor address enumeration
- Curator EOA tx history inline-join
- Cross-MV gauge allocation
- Subsidy concentration warning, substitution-boundary hint, 30d-avg disclosure caveat, carrying-capacity verdict
- New derived metrics not already computed
- Refactor of `computePerformanceMetrics` itself
- Schema changes
- Renaming or deprecating existing surface
- Per-PR migration into `mv_get_curator_portfolio.summarizeVault` (deferred decision)

ADDED v3-final per round 3:
- Telemetry instrumentation for modal-consumer trigger detection
- Merkl POOL-vs-HOLD distinction (CLAUDE.md gotcha — agents reading PR8 must check campaign.action separately)
- Router-mediated activity (CLAUDE.md gotcha — Router is msg.sender on underlying contracts, not user)
- Synthesis-classifier (Q11; separate spec)
- Researcher-seat output enrichment (no v3 PR produces a sentence Richard would put in a prospect DM directly; spec improves perceptual reach, not ammunition generation — that gap is intentional)

---

## §13 — Discard-layer audit (NEW v3-final)

Schema-declared but currently unsurfaced fields, with fixture-population status (verified across base/katana/flare/mainnet, 6 MVs, April 27):

| Field | Population | Status |
|---|---|---|
| `metavault.createdAt` | 100% | **PR1 surfaces** |
| `metavault.defaultIbt` / `defaultOption` | 17% (1/6) | **PR2a surfaces** when populated |
| `metavault.metadata.shortDescription` | 0% (0/6) | PR3 fall-back path; primary is description |
| `metavault.metadata.description` | 100% | **PR3 surfaces** |
| `metavault.tags[]` | 83% (5/6) | **PR4 surfaces** |
| `metavault.modifier.roles` / `delay` | 100% | **PR10a surfaces** (non-default only) |
| `metavault.remote.{chainId}.modifier` | 100% (where remote populated) | **PR10b surfaces** (always on list; dashboard divergence-only) |
| `metavault.remote.{chainId}.address` | 100% | **PR16 surfaces** |
| `metavault.bridge.totalPendingUsd` | varies | **PR9 collapse logic** |
| `metavault.bridge.paths[]` | shape uninvestigated | **PR15 fixture-first gate** |
| `metavault.swap` | shape uninvestigated | OUT OF SCOPE — Phase 0 fixture-capture if surfaced as future PR |
| `metavault.transactionQueue` | shape uninvestigated | **PR11 fixture-first gate** |
| `metavault.multipliers` | varies | **PR12a surfaces** |
| `metavault.exchangeRate` | 100% | **PR18 surfaces** |
| `metavault.infraVault` | 100% | **PR19 surfaces** |
| `position.rate` | 100% | **PR13 surfaces** (raw) |
| `position.createdAt` | 100% | **PR14 surfaces** |
| `position.tags[]` | 33% (5/15 positions) | **PR4 surfaces** |
| `position.maturityValue.usd` | 100% (15/15 positions) — corrected v3-final per Phase 0 verification | **PR6 surfaces** (delta+absolute) |
| `position.ibt.protocol` | 100% on positions with ibt | **PR5 surfaces** |
| `position.ibt.routes` | shape uninvestigated | OUT OF SCOPE — possibly cross-protocol composability map; Phase 0 investigation candidate |
| `position.ibt.extensions` | shape uninvestigated | OUT OF SCOPE — Phase 0 investigation candidate |
| `position.ibt.apr.details.rewardTokens{}` | varies | **PR8 surfaces** with addresses |
| `position.baseIbt` | 47% (7/15 positions) | **PR17 surfaces** when ≠ ibt.symbol |
| `position.multipliers` | 53% (8/15 positions; UNION shape) | **PR12b surfaces** with `Array.isArray()` disambiguation |

**Fields explicitly LEFT silent** (Phase 0 investigation candidates if they become load-bearing):
- `mv.swap` — shape uninvestigated
- `position.ibt.routes` — possibly cross-protocol composability map
- `position.ibt.extensions` — protocol-specific metadata

When any of these becomes load-bearing in a downstream burn (April-27-class), upgrade to a Phase 6+ PR with fixture-first gate.

---

## §13.1 — Researcher-seat acknowledgment (NEW v3-final)

The researcher-seat (Richard's consulting practice) explicitly wins **0%** direct line-allocation in v3-final. The spec produces no sentence that would appear verbatim in a DM to Amadeo, Kevin Rusher, Jashiel Alamo, or any named prospect. **This is acknowledged as intentional**: v3-final is an *intelligence-substrate* spec for sub-agent consumers; the consulting ammunition is what Richard INFERS from sub-agent reports informed by v3 fields. The distance is one step of reasoning the spec does not close.

The 7 ammunition-flagged PRs (PR1, PR4, PR7b, PR12a-with-PR4, PR10a, PR10b, PR14) are the highest-yield positions for that downstream inference. They compose into a Clearstar-class "operational neglect at named position-age, on a young-track-record vault, with cross-chain governance divergence the curator may not have audited" finding — but the composition happens in Richard's seat, not in the spec output.

This is a feature, not a gap. Specs surface fields; consultants generate ammunition.

---

## Ready-to-engineer checklist (must be ✓ at v3-final)

- [x] Round-1 BLOCKERs resolved (curator_portfolio non-delegation, PR7 export, shortenAddress new, PR12 split, PR11 gate)
- [x] Round-2 BLOCKERs resolved (PR5 normalizeProtocolName, PR2a address-comparison, CuratorDashboardOpts §8.1, PR7b integration seam pinned)
- [x] Round-3 BLOCKER resolved (PR3 description-primary inversion)
- [x] Round-3 MAJOR fixes applied (PR5 ⚠ strip, PR11 scope-narrow, PR10b dashboard-divergence-only, 5 PRs cut from CuratorDashboardOpts, PR6 absolute+delta, PR8 default-addresses, §6 layout flip, §7.1 consolidation rule, §13 discard-layer audit)
- [x] Modal-consumer citations replaced with real evidence
- [x] Aggregate-trigger calibration corrected
- [x] Phase 1 re-ordered cold-eval-heavy
- [x] §13.1 researcher-seat acknowledged
- [x] Q4, Q6, Q9, Q10 closed
- [ ] Q8 (list-layout flip) — round 4 or live evidence
- [ ] Q11 (synthesis-classifier) — separate spec proposal

---

End v3-final.
