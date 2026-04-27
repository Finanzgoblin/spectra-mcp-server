# Phase 0 — Baseline Measurements

**Captured**: 2026-04-27, against fixtures `test/fixtures/metavaults-{base,flare,katana,mainnet}.json` (snapshot of live API data)
**Purpose**: calibrate v3-final's dissolution triggers (per-MV >200 lines; aggregate >2500 lines) against measured baseline + verify spec's fixture-population claims before engineering.

---

## §1 — `tags` field semantic — verified against all 4 chain fixtures

The `tags` field carries **asset-class labels only**. Distinct values observed:

| Tag | Where it appears |
|---|---|
| `'stable'` | gamisUSDC vault, UltraUSDC vault, CSMVUSDC vault + 4 of its positions |
| `'eth'` | UltraWETH vault, CSfusionMVWETH vault, UltraWETH pos[0] |
| `[]` (empty) | gamisXRP vault — no tags populated |

**`points` does NOT appear in any `tags` field across all 4 chains.** PR4's original test ("when `position.tags` includes points-class string") was checking against a fictional convention.

The actual points-program semantic lives in `multipliers`. Distinct multiplier names observed:

| Multiplier name | Where it appears | rewards co-populated on the same position? |
|---|---|---|
| `'Avant points'` | gamisUSDC vault.multipliers + pos[3,4,5] | **NO** — attribution-creep fires |
| `'Aegis points'` | gamisUSDC pos[1] | **NO** — attribution-creep fires |
| `'Firelight points'` | gamisXRP pos[0,1] | **NO** — attribution-creep fires |
| `'Drops'` | CSMVUSDC pos[2] | NO — but `Drops` doesn't end in "points" so doesn't trigger /points$/i |
| `'InfiniFi points'` | CSMVUSDC pos[2] | **NO** — attribution-creep fires (corrected Lens 1 finding) |
| `'Fusion points'` | CSfusionMVWETH pos[0] | **NO** — attribution-creep fires |

**Verified-FIRING attribution-creep cases** (corrected per Lens 1 fixture cross-reference, full enumeration): gamisUSDC pos[1] (Aegis), gamisUSDC pos[3,4,5] (Avant), gamisXRP pos[0,1] (Firelight), CSMVUSDC pos[2] (InfiniFi), CSfusionMVWETH pos[0] (Fusion). **8 positions across 4 vaults.** PR4 implementation in Phase 1 must iterate all 8 cases.

**Verified-NOT-FIRING universe**: positions WITHOUT multipliers do not fire the flag. CSMVUSDC pos[0,1,3] have `rewards: {KAT App Rewards, KAT Base}` populated but NO multipliers at all; they sit outside the firing-or-silent universe. The flag's silent-on-clean discipline applies to positions that DO have multipliers AND DO have rewards — current fixture set has zero such positions.

**v1 transcription error fixed v3-final-patch**: original baseline doc claimed CSMVUSDC pos[2] had rewards co-populated alongside Drops + InfiniFi points multipliers. Lens 1 fixture cross-reference confirmed pos[2] has `rewards: undefined`; the populated-rewards positions are pos[0,1,3] which have NO multipliers. Two distinct rows were conflated.

---

## §2 — Schema fixture-population audit (15-position dataset)

Verified counts across all 4 chain fixtures (6 vaults, 15 positions total):

### Vault-level (n=6)

| Field | Population | Notes |
|---|---|---|
| `metavault.defaultIbt` | 1/6 (17%) | Only one vault populates; 5 silent |
| `metavault.metadata.shortDescription` | 0/6 (0%) | **All silent** — confirms PR3 priority inversion |
| `metavault.metadata.description` | 6/6 (100%) | The actual primary surface |
| `metavault.tags` | 5/6 non-empty (83%) | gamisXRP has `[]` (empty); others have `'stable'` or `'eth'` |
| `metavault.modifier` | 6/6 (100%) | Always populated; PR10a always has data |
| `metavault.remote` | 2/6 (33%) | Cross-chain only on gamisUSDC + UltraWETH |

### Position-level (n=15)

| Field | Population | Notes |
|---|---|---|
| `position.maturityValue.usd` | 15/15 (100%) | **CORRECTED v3-final** — was claimed 12/15; actual 15/15 |
| `position.createdAt` | 15/15 (100%) | PR14 always has data |
| `position.rate` | 15/15 (100%) | PR13 always has data |
| `position.ibt.protocol` | 15/15 (100%) | PR5 always renders something |
| `position.multipliers` | 8/15 (53%) | Union shape: 4 Array, 4 object form |
| `position.baseIbt` | 7/15 (47%) | sw-* wrappers — PR17 fires for these |
| `position.tags` | 5/15 (33%) | All 5 are 'stable' (CSMVUSDC) — only 1 vault's positions tag at all |

---

## §3 — Distinct `position.ibt.protocol` values (PR5 alias-map calibration)

Verified across all 4 chain fixtures:

```
['Aegis', 'Avant', 'Ether.fi', 'Firelight', 'IPOR Fusion', 'Lucidly', 'Parallel Protocol', 'Yearn']
```

Registry today maps `avant`, `pendle`, `_unknown`. Without the Phase 0 alias map, **6 of 8 protocols would render `(registry: pending — author entry)` on day 1**:

- Aegis → `aegis` (alias-mapped Phase 0)
- Avant → `avant` (alias-mapped Phase 0; matches registry)
- Ether.fi → `ether_fi` (alias-mapped Phase 0)
- Firelight → `firelight` (alias-mapped Phase 0)
- IPOR Fusion → `ipor_fusion` (alias-mapped Phase 0)
- Lucidly → `lucidly` (alias-mapped Phase 0)
- Parallel Protocol → `parallel` (alias-mapped Phase 0)
- Yearn → `yearn` (alias-mapped Phase 0)

After Phase 0: 1 of 8 protocols matches a registry entry (`avant`); 7 of 8 render `(registry: pending — author entry)` until metadata.ts entries are authored (Phase 6+ work, separate spec for each new protocol per protocols-metadata-spec).

---

## §4 — Line-count baselines for dissolution-trigger calibration

Captured from live `spectra_list_metavaults` output (this session, 2026-04-27, no chain filter):

Approximate line counts per MV (counting from `-- <name> --` to last line of vault block, including chain-truth footer + vault flows):

| MV | Positions | External positions | Bridge txns | Vault flows shown | Approx total lines |
|---|---|---|---|---|---|
| gamisUSDC | 4 active + dust | 3 avant burns | 7 | 30 | ~85-95 |
| gamisXRP | 1 active | 0 | 0 | 30 | ~50-55 |
| CSMVUSDC | 2 | 0 | 0 | 30 | ~55-60 |
| UltraWETH | 1 | 1 pendle | 0 | 30 | ~45-50 |
| CSfusionMVWETH | 0 active (dust) | 1 pendle | 0 | 4 | ~20-25 |
| UltraUSDC | 0 | 0 | 0 | 0 | ~5 |

**Aggregate today** (all 4 chains, 6 MVs): ~265-290 lines. Lower than v3-final §10 estimate of ~330. Headroom against >2500 aggregate trigger: ~9x.

**90th-percentile MV today**: gamisUSDC at ~85-95 lines. Headroom against >200 per-MV trigger: ~2-2.4x.

**Post-v3 projection** (adding ~15-18 lines per MV for full PR1-19 coverage when populated):
- gamisUSDC: ~100-113 lines (still under 200; ~1.8x headroom)
- aggregate at 6 MVs: ~355-400 lines (still well under 2500)

**Estimated trigger-fire curator counts**:
- Per-MV >200 fires when: a single Gami-class MV adds another ~85 lines worth of positions/flows. Roughly: doubling Gami's position count or expanding its bridge-tx history beyond 7 entries.
- Aggregate >2500 fires when: ~38-42 MVs of average 60 lines each. Today's curator-count is 3 brands × 1-2 MVs each = 6 MVs. Trigger fires at ~7x current ecosystem size.

The spec's stated calibration (per-MV primary, aggregate secondary) holds against measured data. Per-MV is the binding constraint under realistic curator growth.

---

## §5 — Phase 0 deliverables status

- [x] `tags` fixture-string convention verified — PR4 needs reframe (multiplier-not-tag) — **patched in v3-final**
- [x] `position.maturityValue.usd` population corrected to 100% — patched in v3-final §13
- [x] `position.ibt.protocol` distinct values captured — alias map populated correctly
- [x] Line-count baselines captured for dissolution-trigger calibration
- [ ] Builder primitives (in progress; awaiting return for 4-lens audit)

---

## Dissolution conditions for this baseline doc

This baseline holds while:
- Spectra API returns the field shapes documented above (no MetaVault schema V2)
- Fixture files at `test/fixtures/metavaults-*.json` reflect representative live data
- The 6 MVs measured here remain the production set (no major new MVs)

Re-capture when:
- A new chain fixture is added (extends 4-chain coverage)
- Spectra API ships a new field surface (re-audit §13 population)
- A new curator brand launches a Gami-class MV (per-MV trigger calibration may shift)
- The dissolution trigger fires in production (informs whether thresholds were correctly calibrated)
