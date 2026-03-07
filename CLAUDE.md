# MetaVault MCP - Agent Context

## Project Structure
- Main repo: `C:\Users\User\metavault-mcp`
- Must `git pull origin main && npm run build` in main repo for MCP server to pick up changes
- MCP server process must restart after rebuild
- Worktrees are under `.claude/worktrees/`
- Source code in `src/`, tools in `src/tools/`, shared helpers in `src/api.ts`, `src/formatters.ts`, `src/config.ts`, `src/types.ts`
- Tests: `npm test` (405 integration tests), `npm run test:unit` (191 unit tests), `npm run test:agent` (82 agent reasoning assertions), `npm run test:subjective` (38 LLM-graded questions)
- Agent test suite in `test-agent.cjs` — multi-tool workflow validation (cross-tool consistency, Router mechanics, anomaly detection)
- Subjective test harness in `test-subjective.cjs` — automated: parses AGENT-TESTS.md, calls MCP tools, sends to Claude for answering + grading. Requires `ANTHROPIC_API_KEY`. Supports `--tier N`, `--question N`, `--dry-run`
- Subjective rubrics in `AGENT-TESTS.md` — 38 questions across 11 tiers (open emergence, coverage, newcomer comprehension)
- TypeScript project — check types with `npx tsc --noEmit`

## Key Tool Files
- `src/tools/pt.ts` — `spectra_list_pools`, `spectra_get_pt_details`, `spectra_get_best_fixed_yields`, `spectra_compare_yield`
- `src/tools/pool.ts` — `spectra_get_pool_activity`, `spectra_get_pool_volume`, `spectra_get_address_activity`
- `src/tools/portfolio.ts` — `spectra_get_portfolio`
- `src/tools/onchain.ts` — `spectra_get_onchain_activity` (direct RPC/eth_getLogs)
- `src/tools/strategy.ts` — `spectra_scan_opportunities` (capital-aware, batch Morpho, negative-APY filtering)
- `src/tools/yt_arb.ts` — `spectra_scan_yt_arbitrage` (YT execution mechanics, flash-mint/flash-redeem)
- `src/tools/morpho.ts` — `morpho_list_markets`, `morpho_get_rate`, `morpho_get_market_suppliers`, `morpho_list_vaults`
- `src/tools/looping.ts` — `spectra_get_looping_strategy` (borrow rate sensitivity, break-even period, failure scenarios)
- `src/tools/quote.ts` — `spectra_quote_trade` (on-chain Curve get_dy() with math fallback), exports `tryOnChainQuote` shared by simulate.ts
- `src/tools/simulate.ts` — `spectra_simulate_trade` (imports tryOnChainQuote from quote.ts)
- `src/tools/pendle.ts` — `pendle_list_markets`, `mv_compare_yield` (maturity-aware matching)
- `src/tools/pendle_details.ts` — `pendle_get_market_details` (single Pendle market deep-dive)
- `src/tools/pendle_yields.ts` — `pendle_get_best_fixed_yields` (multi-chain best fixed rates)
- `src/tools/pendle_portfolio.ts` — `pendle_get_portfolio` (wallet positions across Pendle chains)
- `src/tools/pendle_scanner.ts` — `pendle_scan_opportunities` (capital-aware Pendle scanner with Morpho looping)
- `src/tools/pendle_capacity.ts` — `pendle_get_market_capacity` (multi-size impact curve using logit AMM model)
- `src/tools/pendle_yield_curve.ts` — `pendle_get_yield_curve` (term structure for a given underlying across Pendle chains)
- `src/tools/pendle_expiry.ts` — `pendle_list_expiring_markets` (scan for markets approaching maturity, urgency grouping)
- `src/tools/pendle_yt_arb.ts` — `pendle_scan_yt_arbitrage` (YT mispricing scanner, direct AMM execution)
- `src/tools/pendle_stats.ts` — `pendle_get_protocol_stats` (aggregate TVL, market count, volume across all chains)
- `src/tools/pendle_looping.ts` — `pendle_get_looping_strategy` (leveraged PT + Morpho looping, borrow rate risk analysis)
- `src/tools/pendle_quote.ts` — `pendle_quote_trade` (PT trade quote with logit AMM impact estimation)
- `src/tools/pendle_simulate.ts` — `pendle_simulate_trade` (portfolio impact simulation for PT trades)
- `src/tools/curator_scan.ts` — `mv_scan_curator_opportunities` (cross-protocol Spectra + Pendle capital-aware scanner)
- `src/tools/metavault.ts` — `spectra_list_metavaults`, `spectra_model_metavault`, `spectra_get_curator_dashboard`
- `src/tools/protocol.ts` — `spectra_get_protocol_stats`, `spectra_list_chains`
- `src/tools/ve.ts` — `spectra_get_ve_info` (live veSPECTRA data from Base chain)
- `src/tools/context.ts` — `mv_get_protocol_context` (Layer 1 protocol mechanics, deposit paths, glossary, callable on-demand)
- `src/tools/capacity.ts` — `spectra_get_pool_capacity` (multi-size quote ladder, sweet spot / exhaustion detection)
- `src/tools/ibt_health.ts` — `mv_check_ibt_health` (ERC-4626 conversion rate, APR composition, pool balance, verdict; supports direct ibt_address param for Pendle SY or any ERC-4626 vault)
- `src/tools/yield_curve.ts` — `spectra_get_yield_curve` (term structure for a given underlying across all chains)
- `src/tools/risk_monitor.ts` — `morpho_monitor_risk` (liquidation distance, health factor, borrow rate drift, alert levels)
- `src/tools/stress_test.ts` — `spectra_stress_test_vault` (withdrawal liquidity waterfall, market stress simulation)
- `src/tools/rollover.ts` — `mv_plan_rollover` (expiring position rollover planner with cross-protocol candidates)
- `src/tools/curator_portfolio.ts` — `mv_get_curator_portfolio` (multi-vault aggregation, AUM, blended APY, concentration)
- `src/tools/expiry_monitor.ts` — `spectra_list_expiring_pools` (scan all chains for pools approaching maturity, urgency grouping, successor pool cross-reference, gauge status via governance API, readiness assessment)

## Router-Mediated Transactions & eth_getLogs
Most user interactions go through the **Spectra Router** (flash-mints, flash-redeems, batched mint+LP). The Router is `msg.sender` on underlying contracts, so event `topics[1]` stores the Router address, NOT the user. This is a fundamental EVM constraint, not a bug.

### What works for user-specific activity:
- `spectra_get_pool_activity` (API-based) — Spectra indexes by tx.origin, resolves back to user
- `spectra_get_onchain_activity` WITHOUT address filter — fetches all events, manually inspect
- `spectra_get_onchain_activity` WITH address filter — only catches **direct** calls (YieldClaimed, manual mint/redeem)

### What doesn't work:
- `eth_getLogs` topic filtering by user address for Router-batched operations
- This means: Mint, Redeem, TokenExchange events from Router-batched txns won't match user address in topics[1]

### Workaround for historical data beyond API retention:
1. Use `spectra_get_onchain_activity` without address filter on specific block ranges
2. Or find the Router address and filter by that, then cross-reference tx hashes
3. For recent activity, always prefer `spectra_get_pool_activity` (API-based, resolves Router txns)

## Expired Pools
- The Spectra API `/v1/{network}/pools` only returns **active** pools. Matured pools vanish entirely.
- `spectra_get_address_activity` now also fetches the portfolio endpoint (`/v1/{network}/portfolio/{address}`) to discover expired pool addresses. This is the only way to find matured pools a wallet interacted with.
- `spectra_list_pools` has `include_expired` flag but the underlying API doesn't return expired pools, so the flag mainly prevents the client-side maturity filter from double-filtering.
- The portfolio endpoint `/v1/{network}/portfolio/{address}` DOES return expired positions.
- Individual PT details can be fetched via `/v1/{network}/pt/{address}` even for expired PTs if you know the address.

## RPC-Level Address Filtering in spectra_get_onchain_activity
- `spectra_get_onchain_activity` supports an `address` parameter that filters at the RPC level via `topics[1]`
- Address is padded to 32 bytes: `"0x" + "0".repeat(24) + address.slice(2).toLowerCase()`
- When address-filtered, block range cap is increased 5x (2.5M blocks) since results are sparse
- All Curve events (TokenExchange, AddLiquidity, RemoveLiquidity, RemoveLiquidityOne) and PT vault events (Mint, Redeem, YieldClaimed) have the user/caller as first indexed parameter
- BUT: Router-batched txns have Router as `topics[1]`, not end user — see Router section above

## Merkl Rewards Integration
- `spectra_get_portfolio` fetches Merkl rewards **in parallel** with portfolio data (no added latency)
- Merkl API: `GET https://api.merkl.xyz/v3/userRewards?user={address}&chainId={chainId}&proof=false`
- Chain IDs come from `SUPPORTED_CHAINS[net].id` (already in config.ts)
- Rewards matched to portfolio positions via pool address extraction from Merkl reason keys (format: `ERC20_0xPoolAddr`)
- Best-effort: Merkl API failure does NOT block portfolio display
- Unmatched rewards (from exited positions) shown in a separate section with claim link
- No USD conversion for reward tokens — shows symbol + amount only

## Chain-Specific Notes
- **Katana**: Has a default RPC (`https://rpc.katana.network`) hardcoded in `config.ts`.
- **Monad**: No default RPC. Requires `rpc_url` parameter.
- Most other chains (mainnet, base, arbitrum, sonic, etc.) have hardcoded public RPCs.
- Morpho looping markets exist on: mainnet, base, arbitrum, katana.

## API Architecture
- `src/api.ts` contains `fetchSpectra()` for Spectra API calls, `findMorphoMarketsForPts()` for Morpho market lookups, `fetchMerkl()`/`parseMerklRewards()` for Merkl reward integration, and `amountToBigInt()` for safe float→BigInt conversion
- Spectra API base: `https://app.spectra.finance/api/v1/`
- Network names in API: `ethereum`, `base`, `arbitrum`, `optimism`, `avalanche`, `katana`, `sonic`, `flare`, `bsc`, `monad`
- `resolveNetwork()` maps user-facing chain names to API network names (e.g., "mainnet" → "ethereum")

## Common Patterns
- Pool activity types: `BUY_PT`, `SELL_PT`, `AMM_ADD_LIQUIDITY`, `AMM_REMOVE_LIQUIDITY`
- There is NO `BUY_YT` or `SELL_YT` event — YT doesn't trade on the Curve pool directly
- YT selling via Router flash-redeem shows up as `BUY_PT` in pool activity
- YT buying via Router flash-mint shows up as `SELL_PT` in pool activity
- A standalone mint (deposit IBT → PT+YT) does NOT appear in pool activity at all
- Mint-and-sell loop (YT accumulation): mint PT+YT → sell PT on pool → repeat. Shows as repeated SELL_PT events.

## PR Workflow
- Create feature branch, push, create PR with `gh pr create`
- After merge, pull changes in main repo: `cd C:\Users\User\metavault-mcp && git pull origin main && npm run build`
- Restart MCP server process for changes to take effect
