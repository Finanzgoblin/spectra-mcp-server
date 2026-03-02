# Next Steps: Cross-Protocol Curator Tooling (Phase 3)

## What Was Completed (Phase 1)

Phase 1 shipped the cross-protocol scanner and maturity matching infrastructure:

- **`scan_curator_opportunities`** — New tool in `src/tools/curator_scan.ts`. Scans both Spectra and Pendle in parallel with capital-aware metrics (price impact, effective APY, Morpho looping for Spectra PTs). Tags cross-protocol matches by normalized underlying + maturity proximity.
- **Maturity-aware matching** — `normalizeUnderlyingSymbol()` and `matchByAssetAndMaturity()` in `src/formatters.ts`. Handles wstETH↔stETH, USDC.e↔USDC, WETH↔ETH variants. Match quality: exact (≤7d), close (≤30d), loose (≤90d).
- **Upgraded `compare_pendle_spectra`** — Now uses maturity-aware matching with configurable `maturity_tolerance_days` parameter. Shows match quality and maturity gap per pair.
- **Protocol context** — `workflow_routing` in `src/tools/context.ts` updated with cross-protocol curator workflows and four-tool discovery taxonomy.
- **Tests** — 15 new unit tests (normalizeUnderlyingSymbol + matchByAssetAndMaturity), 7 new integration tests for the scanner.

## What Was Completed (Phase 2)

Phase 2 shipped blended MetaVault modeling, dashboard protocol tags, and cross-protocol discovery pointers:

- **Blended allocation in `model_metavault_strategy`** — Two new params: `pendle_allocation_pct` (0-100, default 0) and `pendle_lp_apy`. When allocation > 0, computes blended base APY and shows an "Allocation Model" section with Spectra/Pendle split and manual rollover warnings. Zero allocation = identical to pre-Phase-2 behavior.
- **Protocol tags in `get_curator_dashboard`** — Positions tagged `[Spectra]`/`[Pendle]`/`[Unknown]` with heuristic detection (lpt data = Spectra, symbol-based fallback for Pendle). Pendle positions approaching maturity (≤30d) generate `[PENDLE ROLLOVER]` action items. Graceful: all current API positions are Spectra, so tags are ready when Pendle data arrives.
- **Cross-protocol pointer in `scan_opportunities`** — Next Steps section now includes `scan_curator_opportunities` pointer, teaching agents the cross-protocol tool exists.
- **Cross-protocol pointers in `model_metavault_strategy` and `get_curator_dashboard`** — Both tools' Next Steps sections now reference `scan_curator_opportunities`.
- **Tests** — 6 new unit tests (formatMetavaultStrategy blended + formatCuratorDashboard protocol tags), 14 new integration tests. All 186 unit and 405 integration tests pass.

## Phase 3: Pendle Morpho Looping (Defer Until Confirmed Demand)

**Only implement when confirmed Morpho markets exist for Pendle PTs.** Changes:
- `src/api.ts` — Add `findMorphoMarketsForPendlePts()`
- `src/tools/curator_scan.ts` — Include Pendle PTs in Morpho batch lookups
- `src/tools/looping.ts` — Add optional `protocol` parameter to `get_looping_strategy`; when `protocol="pendle"`, fetch PT data from Pendle API (math is identical, only data source changes)

## Verification Checklist

After each phase: `npx tsc --noEmit` (types), `npm run build` (compile), `npm test` (integration), `npm run test:unit` (unit), `npm run test:agent` (agent reasoning).
