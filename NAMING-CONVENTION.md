# MetaVault MCP — Tool Naming Convention

## Protocol Prefixes

Every tool gets exactly one prefix indicating which protocol it belongs to:

| Prefix | Scope | Examples |
|--------|-------|---------|
| `spectra_` | Spectra Finance — PT/YT, pools, portfolios, gauges, MetaVaults | `spectra_list_pools`, `spectra_get_pt_details` |
| `morpho_` | Morpho Blue — lending markets, positions, vaults, rates | `morpho_list_markets`, `morpho_get_rate` |
| `pendle_` | Pendle Finance — markets, YT pricing | `pendle_list_markets` |
| `mv_` | Cross-protocol / MetaVault-level — tools that span 2+ protocols | `mv_compare_yield`, `mv_get_protocol_context` |

### When to use `mv_`

Use `mv_` when the tool:
- Queries or compares data from multiple protocols (e.g., Spectra + Pendle)
- Provides protocol-agnostic functionality (e.g., IBT health check works on any ERC-4626)
- Operates at the MetaVault level across protocols (e.g., curator portfolio aggregation)

If a tool is primarily about one protocol but has a minor cross-protocol aspect, use the primary protocol's prefix.

## Verb Conventions

| Verb | Meaning | Examples |
|------|---------|---------|
| `list_` | Browse a collection (pools, markets, vaults, chains) | `spectra_list_pools`, `morpho_list_markets` |
| `get_` | Fetch specific details, data, or computed analysis | `spectra_get_pt_details`, `morpho_get_rate` |
| `scan_` | Capital-aware multi-chain scanning with price impact | `spectra_scan_opportunities`, `mv_scan_curator_opportunities` |
| `compare_` | Head-to-head comparison between options | `spectra_compare_yield`, `mv_compare_yield` |
| `check_` | Health or risk assessment with verdict | `mv_check_ibt_health` |
| `quote_` | Price/trade quoting | `spectra_quote_trade` |
| `simulate_` | Hypothetical scenario modeling | `spectra_simulate_trade` |
| `model_` | Strategy modeling with parameters | `spectra_model_metavault` |
| `plan_` | Action planning (rollover, migration) | `mv_plan_rollover` |
| `stress_test_` | Stress scenario simulation | `spectra_stress_test_vault` |
| `monitor_` | Ongoing risk/health monitoring | `morpho_monitor_risk` |

### `list_` vs `get_`

- `list_` = "show me everything" — returns a collection, often filterable
- `get_` = "show me this specific thing" — takes an identifier or computes a result

## Naming a New Tool

1. **Pick the prefix**: Which protocol does this tool primarily serve?
2. **Pick the verb**: What action does the user conceptually perform?
3. **Pick the noun**: What entity is being acted on?
4. **Compose**: `{prefix}_{verb}_{noun}`

Example: A tool that lists all Pendle vaults → `pendle_list_vaults`
Example: A tool that checks Morpho position health → `morpho_check_health`
Example: A tool comparing yields across Spectra, Pendle, and Aave → `mv_compare_yields`

## Current Tool Inventory (38 tools)

### Spectra (`spectra_`) — 24 tools
| Tool | Verb | Description |
|------|------|-------------|
| `spectra_list_pools` | list | Active pools on a chain |
| `spectra_list_chains` | list | Supported networks |
| `spectra_list_metavaults` | list | Live MetaVaults |
| `spectra_list_expiring_pools` | list | Pools approaching maturity |
| `spectra_get_pt_details` | get | Deep dive on a PT |
| `spectra_get_best_fixed_yields` | get | Top fixed-rate yields across chains |
| `spectra_get_pool_volume` | get | Historical trading volume |
| `spectra_get_pool_activity` | get | Recent transactions with analysis |
| `spectra_get_address_activity` | get | Cross-pool address scanner |
| `spectra_get_portfolio` | get | Wallet positions (PT, YT, LP) |
| `spectra_get_protocol_stats` | get | SPECTRA tokenomics |
| `spectra_get_ve_info` | get | veSPECTRA data and boost |
| `spectra_get_pool_capacity` | get | Multi-size capacity curve |
| `spectra_get_yield_curve` | get | Term structure across chains |
| `spectra_get_curator_dashboard` | get | MetaVault operational dashboard |
| `spectra_get_looping_strategy` | get | Leveraged yield via PT + Morpho |
| `spectra_get_onchain_activity` | get | Historical on-chain via eth_getLogs |
| `spectra_compare_yield` | compare | Fixed vs variable yield |
| `spectra_scan_opportunities` | scan | Capital-aware opportunity scanner |
| `spectra_scan_yt_arbitrage` | scan | YT arbitrage scanner |
| `spectra_quote_trade` | quote | PT trade quoting (on-chain Curve) |
| `spectra_simulate_trade` | simulate | Portfolio before/after trade |
| `spectra_model_metavault` | model | MetaVault double-loop modeler |
| `spectra_stress_test_vault` | stress_test | Withdrawal liquidity waterfall |

### Morpho (`morpho_`) — 7 tools
| Tool | Verb | Description |
|------|------|-------------|
| `morpho_list_markets` | list | PT lending markets |
| `morpho_list_vaults` | list | Curated vaults on a chain |
| `morpho_get_rate` | get | Live borrow rate |
| `morpho_get_market_suppliers` | get | Supply-side analysis |
| `morpho_get_positions` | get | User positions with health |
| `morpho_get_history` | get | Historical rate trends |
| `morpho_monitor_risk` | monitor | Liquidation risk monitor |

### Pendle (`pendle_`) — 1 tool
| Tool | Verb | Description |
|------|------|-------------|
| `pendle_list_markets` | list | Active Pendle markets |

### Cross-protocol (`mv_`) — 6 tools
| Tool | Verb | Description |
|------|------|-------------|
| `mv_compare_yield` | compare | Pendle vs Spectra side-by-side |
| `mv_scan_curator_opportunities` | scan | Cross-protocol capital-aware scanner |
| `mv_get_protocol_context` | get | Protocol mechanics explainer |
| `mv_check_ibt_health` | check | Multi-signal IBT health assessment |
| `mv_plan_rollover` | plan | Expiring position rollover planner |
| `mv_get_curator_portfolio` | get | Multi-vault curator aggregation |
