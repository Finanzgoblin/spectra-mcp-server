# Changelog

## v2.1.0 (2026-04-07)

**Open Emergence** — Tools teach mechanics and preserve ambiguity. Agents bring their own judgment.

### New Tools (5)
- `spectra_get_gauge_votes` — veSPECTRA governance: vote distribution, voting APRs, bribes, SPECTRA emissions per gauge
- `pendle_get_market_history` — Historical APY, TVL, volume, PT/YT price time-series
- `mv_get_position_map` — Cross-protocol position map (Spectra + Pendle + Morpho + governance) with contradiction detection
- `mv_get_calibration` — Historical baselines, percentiles, anomaly thresholds, peer comparison
- `merkl_list_campaigns` — Standalone Merkl campaign discovery by chain and asset

### Open Emergence Architecture
- Removed heuristic thresholds from scanner and calibration output — data speaks, agent decides
- Added competing interpretations (A/B/C branches) for ambiguous scenarios
- Observation coverage quantification: value/temporal/source coverage percentages
- Entry path awareness: surface distance between user and yield (wrapping, bridging, gas)

### Safety (from 5-archetype roaming audit — 10 findings, all forged)
- Always show absolute return alongside annualized APY in looping tools
- Always show base + effective + LP APY side by side in scanner (no threshold hides alternatives)
- Always show gas:position ratio when capital is known (data, not opinion)
- Always show supplier withdrawal scenario (no concentration threshold gates it)
- Always show gauge maturity status with temporal distance (days since/until, not binary tag)
- Skipped health checks say UNKNOWN, not OK
- Calibration clips to physical domain bounds (utilization ≤ 100%)
- Calibration detects active Merkl subsidies and warns baselines are subsidized
- Calibration detects near-maturity and warns about convergence behavior
- Prescriptive tools declare temporal instability of their own outputs

### Wiring Fixes
- vePENDLE on-chain governance balance in Pendle portfolio
- veSPECTRA wallet balance from Base chain
- Merkl campaign expiry dates surfaced across all tools
- 3 Spectra↔Pendle asymmetries closed
- Chain failure handling made LOUD in portfolio tools

### Infrastructure
- Tool count: 50 → 55
- `prepublishOnly` script added (build + test gate)
- Prescriptive tools now declare what they cannot see

## v2.0.0 (2026-03-24)

Initial public release. 50 tools across Spectra, Morpho, Pendle, Merkl.
