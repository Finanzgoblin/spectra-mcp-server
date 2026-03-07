# Next Steps: Spectra MCP Server

## What Has Been Shipped

### Pendle Integration (Phases 1-2)

Phase 1 shipped the cross-protocol scanner and maturity matching infrastructure:

- **`pendle_list_markets`** — List active Pendle markets on any chain or all Pendle chains.
- **`mv_compare_yield`** — Side-by-side yield comparison with maturity-aware matching.
- **`mv_scan_curator_opportunities`** — Cross-protocol (Spectra + Pendle) capital-aware scanner.
- **Maturity-aware matching** — `normalizeUnderlyingSymbol()` and `matchByAssetAndMaturity()` in `src/formatters.ts`.
- **Blended allocation in `spectra_model_metavault`** — `pendle_allocation_pct` and `pendle_lp_apy` params.
- **Protocol tags in `spectra_get_curator_dashboard`** — `[Spectra]`/`[Pendle]`/`[Unknown]` position tags.

### Curator Risk Management Layer (P0 + P1 + P2)

All items from the ARCHITECT-BRIEF have been shipped:

- **`morpho_monitor_risk`** (`src/tools/risk_monitor.ts`) — Liquidation distance monitoring, health factor, borrow rate drift, alert levels (ok/watch/warning/critical). Scans all Morpho-capable chains.
- **`spectra_stress_test_vault`** (`src/tools/stress_test.ts`) — Withdrawal stress test with liquidity waterfall (idle → maturing → LP removal → PT sale). Market stress mode (2x impact). Maximum safe redemption calculation.
- **`mv_plan_rollover`** (`src/tools/rollover.ts`) — Position rollover planner for expiring MetaVault positions. Scans Spectra + Pendle for candidates, computes entry impact, yield gap, overlap windows.
- **`mv_get_curator_portfolio`** (`src/tools/curator_portfolio.ts`) — Multi-vault portfolio aggregation. Discovery mode (by curator address) or explicit mode. Total AUM, blended APY, fee revenue projection, concentration analysis.

## What Remains Open

### Pendle Phase 3: Pendle Morpho Looping (Defer Until Confirmed Demand)

**Only implement when confirmed Morpho markets exist for Pendle PTs.** Changes:
- `src/api.ts` — Add `findMorphoMarketsForPendlePts()`
- `src/tools/curator_scan.ts` — Include Pendle PTs in Morpho batch lookups
- `src/tools/looping.ts` — Add optional `protocol` parameter to `spectra_get_looping_strategy`

### P1-B: Borrow Rate Risk Analyzer

Extend `morpho_get_history` or `spectra_model_metavault` with probabilistic risk assessment:
- Historical borrow rate volatility (std dev)
- Probability of break-even being hit (normal approximation)
- "Safe loop count" that survives 95th percentile rate scenario

### P2-B: Historical Performance Metrics

Add performance reporting to `spectra_get_curator_dashboard`:
- Time-weighted return from share price history
- Max drawdown from share price series
- Sharpe-like ratio vs Morpho USDC supply benchmark

### P3: Gas Cost Estimation

Add `gas_estimate` section to `spectra_get_looping_strategy` and `spectra_model_metavault`:
- Estimate gas per loop iteration (~500-600K gas)
- Fetch current gas price via RPC
- Show total gas cost as % of annual yield

## Verification Checklist

After each phase: `npx tsc --noEmit` (types), `npm run build` (compile), `npm test` (integration), `npm run test:unit` (unit), `npm run test:agent` (agent reasoning).
