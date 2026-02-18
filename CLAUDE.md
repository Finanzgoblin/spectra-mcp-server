# Spectra MCP Server - Agent Context

## Project Structure
- Main repo: `C:\Users\User\spectra-mcp-server`
- Must `git pull origin main && npm run build` in main repo for MCP server to pick up changes
- MCP server process must restart after rebuild
- Worktrees are under `.claude/worktrees/`
- Source code in `src/`, tools in `src/tools/`, shared helpers in `src/api.ts`, `src/formatters.ts`, `src/config.ts`, `src/types.ts`
- Tests: `npm test` (371 integration tests), `npm run test:unit` (165 unit tests), `npm run test:agent` (88 agent reasoning assertions)
- Agent test suite in `test-agent.cjs` — multi-tool workflow validation (cross-tool consistency, Router mechanics, anomaly detection)
- Subjective test suite in `AGENT-TESTS.md` — 25 questions with grading rubrics for LLM evaluation
- TypeScript project — check types with `npx tsc --noEmit`

## Key Tool Files
- `src/tools/pt.ts` — `list_pools`, `get_pt_details`, `get_best_fixed_yields`
- `src/tools/pool.ts` — `get_pool_activity`, `get_pool_volume`, `get_address_activity`
- `src/tools/portfolio.ts` — `get_portfolio`
- `src/tools/onchain.ts` — `get_onchain_activity` (direct RPC/eth_getLogs)
- `src/tools/yield.ts` — `compare_yield`, `scan_opportunities`, `scan_yt_arbitrage`
- `src/tools/morpho.ts` — `get_morpho_markets`, `get_morpho_rate`, `get_looping_strategy`
- `src/tools/trade.ts` — `quote_trade`, `simulate_portfolio_after_trade`
- `src/tools/pendle.ts` — `list_pendle_markets`, `compare_pendle_spectra`
- `src/tools/metavault.ts` — `get_metavaults`, `model_metavault_strategy`
- `src/tools/protocol.ts` — `get_protocol_stats`, `get_supported_chains`, `get_ve_info`, `get_protocol_context`

## Router-Mediated Transactions & eth_getLogs
Most user interactions go through the **Spectra Router** (flash-mints, flash-redeems, batched mint+LP). The Router is `msg.sender` on underlying contracts, so event `topics[1]` stores the Router address, NOT the user. This is a fundamental EVM constraint, not a bug.

### What works for user-specific activity:
- `get_pool_activity` (API-based) — Spectra indexes by tx.origin, resolves back to user
- `get_onchain_activity` WITHOUT address filter — fetches all events, manually inspect
- `get_onchain_activity` WITH address filter — only catches **direct** calls (YieldClaimed, manual mint/redeem)

### What doesn't work:
- `eth_getLogs` topic filtering by user address for Router-batched operations
- This means: Mint, Redeem, TokenExchange events from Router-batched txns won't match user address in topics[1]

### Workaround for historical data beyond API retention:
1. Use `get_onchain_activity` without address filter on specific block ranges
2. Or find the Router address and filter by that, then cross-reference tx hashes
3. For recent activity, always prefer `get_pool_activity` (API-based, resolves Router txns)

## Expired Pools
- The Spectra API `/v1/{network}/pools` only returns **active** pools. Matured pools vanish entirely.
- `get_address_activity` now also fetches the portfolio endpoint (`/v1/{network}/portfolio/{address}`) to discover expired pool addresses. This is the only way to find matured pools a wallet interacted with.
- `list_pools` has `include_expired` flag but the underlying API doesn't return expired pools, so the flag mainly prevents the client-side maturity filter from double-filtering.
- The portfolio endpoint `/v1/{network}/portfolio/{address}` DOES return expired positions.
- Individual PT details can be fetched via `/v1/{network}/pt/{address}` even for expired PTs if you know the address.

## RPC-Level Address Filtering in get_onchain_activity
- `get_onchain_activity` supports an `address` parameter that filters at the RPC level via `topics[1]`
- Address is padded to 32 bytes: `"0x" + "0".repeat(24) + address.slice(2).toLowerCase()`
- When address-filtered, block range cap is increased 5x (2.5M blocks) since results are sparse
- All Curve events (TokenExchange, AddLiquidity, RemoveLiquidity, RemoveLiquidityOne) and PT vault events (Mint, Redeem, YieldClaimed) have the user/caller as first indexed parameter
- BUT: Router-batched txns have Router as `topics[1]`, not end user — see Router section above

## Merkl Rewards Integration
- `get_portfolio` fetches Merkl rewards **in parallel** with portfolio data (no added latency)
- Merkl API: `GET https://api.merkl.xyz/v3/userRewards?user={address}&chainId={chainId}&proof=false`
- Chain IDs come from `SUPPORTED_CHAINS[net].id` (already in config.ts)
- Rewards matched to portfolio positions via pool address extraction from Merkl reason keys (format: `ERC20_0xPoolAddr`)
- Best-effort: Merkl API failure does NOT block portfolio display
- Unmatched rewards (from exited positions) shown in a separate section with claim link
- No USD conversion for reward tokens — shows symbol + amount only

## Chain-Specific Notes
- **Katana**: No default RPC in the server. Use `rpc_url="https://rpc.katana.network"` parameter.
- **Monad**: No default RPC. Requires `rpc_url` parameter.
- Most other chains (mainnet, base, arbitrum, sonic, etc.) have hardcoded public RPCs.
- Morpho looping markets exist on: mainnet, base, arbitrum, katana.

## API Architecture
- `src/api.ts` contains `fetchSpectra()` for Spectra API calls, `findMorphoMarketsForPts()` for Morpho market lookups, and `fetchMerkl()`/`parseMerklRewards()` for Merkl reward integration
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
- After merge, pull changes in main repo: `cd C:\Users\User\spectra-mcp-server && git pull origin main && npm run build`
- Restart MCP server process for changes to take effect
