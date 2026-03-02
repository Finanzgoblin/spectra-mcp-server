# Next Steps: Cross-Protocol Curator Tooling (Phases 2-3)

## What Was Completed (Phase 1)

Phase 1 shipped the cross-protocol scanner and maturity matching infrastructure:

- **`scan_curator_opportunities`** — New tool in `src/tools/curator_scan.ts`. Scans both Spectra and Pendle in parallel with capital-aware metrics (price impact, effective APY, Morpho looping for Spectra PTs). Tags cross-protocol matches by normalized underlying + maturity proximity.
- **Maturity-aware matching** — `normalizeUnderlyingSymbol()` and `matchByAssetAndMaturity()` in `src/formatters.ts`. Handles wstETH↔stETH, USDC.e↔USDC, WETH↔ETH variants. Match quality: exact (≤7d), close (≤30d), loose (≤90d).
- **Upgraded `compare_pendle_spectra`** — Now uses maturity-aware matching with configurable `maturity_tolerance_days` parameter. Shows match quality and maturity gap per pair.
- **Protocol context** — `workflow_routing` in `src/tools/context.ts` updated with cross-protocol curator workflows and four-tool discovery taxonomy.
- **Tests** — 15 new unit tests (normalizeUnderlyingSymbol + matchByAssetAndMaturity), 7 new integration tests for the scanner. All 180 unit and 395 integration tests pass.

## Phase 2: Blended MetaVault Modeling + Dashboard Protocol Tags

**Goal**: Let curators model MetaVaults that allocate across both Spectra and Pendle.

### 2A. Upgrade `model_metavault_strategy` (in `src/tools/metavault.ts`)
Add two backward-compatible parameters:
- `pendle_allocation_pct` (0-100, default 0) — percentage of vault capital in Pendle LP
- `pendle_lp_apy` (required when allocation > 0) — Pendle LP APY for blended calculation

When `pendle_allocation_pct > 0`: compute blended base APY = `spectraApy * (1 - alloc/100) + pendleLpApy * (alloc/100)`, use as `grossVaultApy` in looping table. Add "Allocation Model" section to output. Add warnings about manual Pendle rollover and operational complexity. When 0: identical behavior to today.

### 2B. Upgrade `get_curator_dashboard` (in `src/tools/metavault.ts`)
Prepare for Pendle positions in MetaVault API data. Add protocol detection heuristic on positions (when Spectra API starts returning Pendle data). Tag positions `[Spectra]`/`[Pendle]`/`[Unknown]`. Flag Pendle positions approaching maturity as needing manual rollover. Graceful degradation: if API doesn't return Pendle positions yet, output is unchanged.

### 2C. Cross-protocol pointer in `scan_opportunities` (in `src/tools/strategy.ts`)
Add a light footer after MetaVault alternatives: "Pendle markets may also offer competitive yields. Use `scan_curator_opportunities(capital_usd=X)` for unified ranking." Teaches agents the cross-protocol tool exists without mixing Pendle into the Spectra-focused scanner.

## Phase 3: Pendle Morpho Looping (Defer Until Confirmed Demand)

**Only implement when confirmed Morpho markets exist for Pendle PTs.** Changes:
- `src/api.ts` — Add `findMorphoMarketsForPendlePts()`
- `src/tools/curator_scan.ts` — Include Pendle PTs in Morpho batch lookups
- `src/tools/looping.ts` — Add optional `protocol` parameter to `get_looping_strategy`; when `protocol="pendle"`, fetch PT data from Pendle API (math is identical, only data source changes)

## Full Plan Reference

The complete specification with file-by-file changes, type definitions, and test plans is in `.claude/plans/rippling-stargazing-cookie.md`.

## Verification Checklist

After each phase: `npx tsc --noEmit` (types), `npm run build` (compile), `npm test` (integration), `npm run test:unit` (unit), `npm run test:agent` (agent reasoning).
