# Spectra Finance MCP Server

Makes [Spectra Finance](https://spectra.finance) discoverable and usable by AI agents via the [Model Context Protocol](https://modelcontextprotocol.io).

24 tools · 10 chains · read-only · on-chain Curve quoting · historical eth_getLogs · zero web3 library dependencies

## What This Does

Any AI agent (Claude, GPT, open-source) that supports MCP can now:

- **Discover** the best fixed-rate yield opportunities across 10 chains simultaneously
- **Analyze** specific PT/YT positions with full data (APY, TVL, liquidity, prices)
- **Calculate** leveraged looping strategies (Spectra PT + Morpho collateral) with auto-detected borrow rates
- **Compare** fixed vs. variable yields to make informed decisions
- **Track** wallet portfolios across all Spectra positions (PT, YT, LP)
- **Monitor** pool trading volume, individual transaction activity, and cross-pool address scanning
- **Quote** PT trades with on-chain Curve `get_dy()` for exact output, falling back to math estimates
- **Simulate** portfolio state after a hypothetical trade (BEFORE / TRADE / AFTER with deltas)
- **Scan** all chains for capital-aware opportunities with price impact, effective APY, and Morpho looping analysis
- **Detect** YT arbitrage opportunities where IBT APR diverges from YT implied rate
- **Compute** real veSPECTRA boost multipliers per-pool using live on-chain data from Base
- **Discover** live MetaVaults across all chains — curator info, TVL, APY, positions, epoch history
- **Model** MetaVault "double loop" strategies for curators — vault compounding + Morpho leverage with curator economics, auto-populated from live API data or manual parameters
- **Query** Morpho lending markets for PT collateral opportunities
- **Query** protocol stats, tokenomics, and governance data
- **Compare** Spectra vs Pendle yield opportunities side-by-side on overlapping chains
- **Browse** Pendle markets across all Pendle-supported chains (including Pendle-only chains)
- **Recover** historical on-chain pool activity via `eth_getLogs` when API data has aged out — with dynamic RPC URL support for any chain
- **Learn** protocol mechanics on-demand via `get_protocol_context` (PT/YT identity, Router batching, minting)

The agent doesn't need to understand PT/YT mechanics -- it just calls `scan_opportunities` with its capital size and gets ranked, actionable data. If it needs to understand *why* something works that way, it calls `get_protocol_context`.

## Open Emergence Architecture

The server is designed so that AI agents can **discover novel strategies without being taught specific strategies**. Instead of hard-coding strategy identification logic, the system teaches protocol mechanics at three layers — and lets the agent compose building blocks into its own analysis.

### The Three Layers

```
Layer 1: Protocol Context (get_protocol_context tool + resources)
  → Teaches the "physics" of the protocol: PT/YT identity, Router batching, minting
  → Available as a callable tool (on-demand) and as MCP resources
  → Static knowledge — what CAN happen, not what IS happening

Layer 2: Tool Descriptions (every tool's description string)
  → Teaches domain-specific mechanics relevant to that tool's data
  → Cross-reference nudges: "use get_portfolio to check actual holdings"
  → Uses "could be" language, not "is" — preserves ambiguity where it exists
  → Calls out hidden mechanics that could mislead (e.g., AMM_ADD_LIQUIDITY can mint YT)

Layer 3: Structured Output Hints (computed at runtime in tool output)
  → Position Shape analysis in portfolio: balance ratios (e.g., "YT/PT 4:1")
  → Portfolio Signals: concentration, maturity alerts, strategy shape across positions
  → Volume Signals: volume/liquidity ratio, buy/sell skew, trend detection
  → Morpho Market Hints: capacity warnings, utilization alerts, spread analysis
  → Pattern hints (⚠ warnings) in activity data per-address
  → Address isolation mode: cycle detection, flow accounting, contract/EOA detection,
    pool impact warnings, gas estimates, pool context
  → Capital-aware warnings: short maturity, low liquidity, negative effective APY
  → Yield Dimensions in scan output: fixed, variable, LP, looping side-by-side
  → Strategy Tension: competing PT looping vs YT accumulation on same pool
  → On-chain quote source indicators: "(on-chain Curve get_dy)" vs "(estimated)"
  → "Could be" / "at current rates" language: preserves ambiguity in ranked output
  → Makes key signals SALIENT without prescribing interpretation
```

### Design Principles

- **Teach mechanics, not conclusions.** The server explains that AMM_ADD_LIQUIDITY *could be* a mint+LP batch operation — it doesn't conclude "this user is accumulating YT."
- **Every tool cross-references at least one other tool.** This creates analytical workflows without dictating them. The agent learns to check `get_portfolio` after seeing activity patterns, not because it was told to.
- **Hidden mechanics are called out where they can mislead.** The Spectra Router batches multiple operations atomically. A `SELL_PT` event might actually be YT acquisition via flash-mint. Tool descriptions teach this so agents don't draw wrong conclusions from pool data alone.
- **Full addresses in output, never truncated.** When addresses appear in activity data, they're shown in full so the agent can pass them directly to `get_portfolio` without needing a block explorer.
- **Discovery tools warn about capital-awareness gaps.** `get_best_fixed_yields` explicitly says "this ranks by raw APY — use `scan_opportunities` for capital-aware sizing."

### Why This Matters

A cold-start agent with zero prior knowledge of Spectra can:
1. Call `get_pool_activity` — see trading patterns with ⚠ hints about ambiguous events
2. Call `get_portfolio` on flagged addresses — see Position Shape (balance ratios like "YT/PT 4:1")
3. Read the cross-reference nudges — compose its own analytical workflow
4. Identify novel strategies the server was never explicitly programmed to detect

This was validated: a subagent spawned with zero priming correctly identified a mint-and-sell-PT loop strategy (YT accumulation via PT discount) in 3 tool calls, using only the mechanics taught in descriptions and the structured hints in output.

## Tools

| Tool | Description |
|------|-------------|
| `get_best_fixed_yields` | Scan ALL chains for top fixed-rate opportunities. The main discovery tool. Supports `compact` mode. |
| `list_pools` | List all active pools on a specific chain, sorted by APY/TVL/maturity. Supports `compact` mode and `include_expired` flag. |
| `get_pt_details` | Deep dive on a specific Principal Token -- full data. |
| `compare_yield` | Fixed (PT) vs. variable (IBT) yield comparison with spread mechanics and entry cost analysis. |
| `get_looping_strategy` | Calculate leveraged yield via PT + Morpho looping with effective liquidation margins. Auto-fetches live Morpho rates when a matching market exists. |
| `get_morpho_markets` | Find Morpho lending markets that accept Spectra PTs as collateral. Filter by chain or symbol. |
| `get_morpho_rate` | Get live borrow rate and state for a specific Morpho market. |
| `get_protocol_stats` | SPECTRA tokenomics, emissions schedule, fee distribution, governance info. |
| `get_supported_chains` | List available networks (10 chains). |
| `get_portfolio` | Wallet positions across PT, YT, and LP with USD values and claimable yield. |
| `get_pool_volume` | Historical buy/sell trading volume for a specific pool. Accepts PT address or pool address. |
| `get_pool_activity` | Recent individual transactions (buys, sells, liquidity events) with filtering, address isolation mode (cycle detection, flow accounting, contract/EOA detection, gas estimates). Accepts PT or pool address. |
| `get_address_activity` | Cross-pool address scanner — finds all pools an address has interacted with on a chain (or all chains) in one call. Includes expired/matured pools via portfolio lookup. Per-pool breakdown + cross-pool aggregates. |
| `quote_trade` | PT trade quoting with on-chain Curve `get_dy()` for exact output (falls back to math estimate). Shows price impact, slippage, and minOut. |
| `simulate_portfolio_after_trade` | Preview portfolio BEFORE/AFTER a hypothetical PT trade with deltas, warnings, and on-chain quoting. |
| `scan_opportunities` | Capital-aware opportunity scanner: price impact at your size, effective APY, Morpho looping, pool capacity. Supports `compact` mode. |
| `scan_yt_arbitrage` | YT rate vs IBT rate arbitrage scanner -- finds pools where YT is mispriced relative to underlying yield. Supports `compact` mode. |
| `get_ve_info` | Live veSPECTRA data from Base chain (total supply via on-chain read) + boost calculator with per-pool multipliers. |
| `get_metavaults` | List live MetaVaults across all chains (or a specific chain). Returns curator info, TVL, live APY, share price, active positions, and epoch history. |
| `model_metavault_strategy` | MetaVault "double loop" strategy modeler for curators. Live mode (chain + metavault_address) auto-fetches APY from API; manual mode accepts base_apy directly. Models curator economics (fee revenue, TVL creation, effective ROI). |
| `list_pendle_markets` | List active Pendle markets on a given chain or all Pendle chains. Supports Pendle-only chains (Mantle, Berachain, HyperEVM, Corn). Supports `compact` mode. |
| `compare_pendle_spectra` | Side-by-side Pendle vs Spectra yield comparison on overlapping chains (mainnet, base, arbitrum, optimism, sonic, bsc). Auto-matches by underlying asset. |
| `get_onchain_activity` | Historical on-chain activity via `eth_getLogs` — recovers data when the API has aged out transactions. Supports dynamic `rpc_url` parameter for any chain. Decodes **Curve pool events** (swaps, LP adds/removes) via `pool_address` AND **Spectra PT vault events** (Mint, Redeem, YieldClaimed) via `pt_address`. Both can be provided simultaneously for merged results. |
| `get_protocol_context` | Returns protocol mechanics reference (PT/YT identity, Router batching, minting). Callable on-demand instead of always in context. |

## Supported Chains

Ethereum (mainnet), Base, Arbitrum, Optimism, Avalanche, Katana, Sonic, Flare, BSC, Monad

## veSPECTRA Boost

The server reads live veSPECTRA total supply directly from the Base chain via raw `eth_call` (no ethers/viem dependency) and computes per-pool boost multipliers using the real Spectra formula:

```
B = min(2.5, 1.5 * (v/V) * (D/d) + 1)

v = your veSPECTRA balance
V = total veSPECTRA supply (read live from Base)
D = pool TVL
d = your deposit size
```

Full 2.5x boost when your share of total veSPECTRA >= your share of pool TVL.

Tools that accept `ve_spectra_balance` (`scan_opportunities`, `scan_yt_arbitrage`, `compare_yield`, `get_ve_info`) compute per-pool boost automatically. The veSPECTRA contract is an NFT-based voting escrow (veNFT) at `0x6a89228055c7c28430692e342f149f37462b478b` on Base, sourced from [spectra-core](https://github.com/perspectivefi/spectra-core).

## MetaVault Discovery & Strategy Modeling

MetaVaults are ERC-7540 curated vaults that automate LP rollover and compound YT yield back into LP positions. Two tools work together:

**`get_metavaults`** — Discovery tool. Fetches live MetaVault data from the API (`/v1/{network}/metavaults`), scanning a single chain or all chains in parallel. Returns curator info, TVL, live APY, share price, active positions with PT/pool details, and epoch rate history.

**`model_metavault_strategy`** — Strategy modeler with two modes:
- **Live mode**: Provide `chain` + `metavault_address` to auto-fetch the vault's live APY as `base_apy`. All other parameters (borrow rate, LTV, curator fee) can still be overridden.
- **Manual mode**: Provide `base_apy` directly for hypothetical or pre-launch modeling.

The "double loop" economics:

```
Layer 1 (inside vault):  Deposit → PT/LP allocation → YT yield → more LP (compounding)
Layer 2 (on top):        MV shares → Morpho collateral → borrow → deposit back (leverage)
```

The key insight: YT compounding raises the vault's base APY, and leverage multiplies that higher base. This creates a "double-loop premium" over raw PT looping that scales with leverage.

**Curator economics** are built in — the tool models fee revenue on external deposits, additional TVL created by looping, and effective ROI on the curator's own capital.

## Setup

### Install from npm (recommended)

```bash
npm install -g spectra-mcp-server
```

Or run directly without installing:

```bash
npx spectra-mcp-server
```

### Install from source

```bash
git clone https://github.com/Finanzgoblin/spectra-mcp-server.git
cd spectra-mcp-server
npm install
npm run build
```

## Connect to Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "spectra-finance": {
      "command": "npx",
      "args": ["spectra-mcp-server"]
    }
  }
}
```

Restart Claude Desktop. You'll see the Spectra tools available.

## Connect to Claude Code

```bash
claude mcp add spectra-finance -- npx spectra-mcp-server
```

## Example Queries

Once connected, you can ask Claude things like:

- "What's the best fixed yield on USDC right now?"
- "Show me all Spectra pools on Base with >$50k TVL"
- "Calculate a 3x looping strategy for PT-USDC on Base using Morpho"
- "Is the fixed rate on stETH better than the variable rate?"
- "What Morpho markets accept Spectra PTs as collateral?"
- "What's the borrow rate on that Morpho PT-USDC market?"
- "What are the current SPECTRA emissions and lock rate?"
- "Show me the portfolio for 0xABC...DEF across all chains"
- "What's the recent trading activity on this pool?"
- "Scan all pools on mainnet for activity from address 0xABC...DEF"
- "Check if address 0xABC...DEF is a contract or EOA and show their trading patterns"
- "Quote buying 10,000 USDC worth of PT on this pool"
- "What would my portfolio look like if I bought 50k of this PT?"
- "I have $100K to deploy -- scan all chains for the best risk-adjusted yield"
- "Scan for USDC opportunities sized for $500K with max 2% entry impact"
- "Find YT arbitrage opportunities where the market is mispricing yield"
- "I have 100K veSPECTRA -- what boost do I get on this pool with a $10K deposit?"
- "Show veSPECTRA total supply and how much I need for max boost"
- "What MetaVaults are live right now? Show me all of them across all chains"
- "Show me the MetaVaults on Base -- what are the APYs and who are the curators?"
- "Model a strategy for this MetaVault on Base" (auto-fetches live APY)
- "Model a MetaVault with 12% base APY and 3% YT compounding, 10% curator fee -- what does looping look like?"
- "Compare MetaVault looping vs raw PT looping at 12% base APY"
- "I'm curating a vault with $100K own capital and $1M external deposits -- what's my effective ROI?"
- "Compare Spectra vs Pendle yields on Base -- which protocol offers better rates for USDC?"
- "Show me all active Pendle markets on Arbitrum sorted by TVL"
- "This address traded on Katana weeks ago but get_pool_activity shows nothing -- pull on-chain logs for the last 7 days"
- "Fetch historical activity for this pool using my RPC URL: https://rpc.katana.network"

## Architecture

```
Agent (Claude/GPT/etc)
  | MCP Protocol (stdio)
Spectra MCP Server (this)
  | HTTP (15s timeout, 1 retry on 5xx/network errors)
  |
  +-- api.spectra.finance/v1/{chain}/pools
  +-- api.spectra.finance/v1/{chain}/pt/{address}
  +-- api.spectra.finance/v1/{chain}/portfolio/{wallet}
  +-- api.spectra.finance/v1/{chain}/pools/{pool}/volume
  +-- api.spectra.finance/v1/{chain}/pools/{pool}/activity
  +-- api.spectra.finance/v1/{chain}/metavaults
  +-- app.spectra.finance/api/v1/spectra/*
  +-- api.morpho.org/graphql (PT collateral markets, borrow rates)
  +-- api-v2.pendle.finance/core/* (Pendle market data for cross-protocol comparison)
  +-- mainnet.base.org (veSPECTRA on-chain reads via raw eth_call)
  +-- Chain RPCs: eth_call for Curve get_dy() quotes, eth_getCode for contract detection
  |   (mainnet, base, arbitrum, optimism, avalanche, sonic, bsc, flare)
  +-- Chain RPCs: eth_getLogs for historical pool activity (any chain via dynamic rpc_url)
```

Modular TypeScript server. Read-only — queries Spectra's existing API, Morpho's GraphQL API, chain RPCs for on-chain Curve `get_dy()` quotes and contract detection, and Base RPC for veSPECTRA data. No wallet, no transactions, no keys, no web3 libraries needed.

```
src/
  index.ts          Entry point, tool registration, Layer 1 resources (spectra-overview,
                      curator-strategy-guide), main(), graceful shutdown
  config.ts         Constants, chain config, Zod schemas, protocol parameters, veSPECTRA constants,
                      block time constants per chain, RPC URL resolution (hardcoded + dynamic override)
  types.ts          TypeScript interfaces (SpectraPt, MorphoMarket, ScanOpportunity, etc.)
  api.ts            Fetch helpers with retry, GraphQL sanitization, Morpho batch lookup,
                      veSPECTRA RPC with Promise-based dedup cache, 30s TTL pool data cache,
                      Curve get_dy() on-chain quoting, eth_getCode contract detection,
                      MetaVault multi-chain scanning, API response validation at system boundary,
                      chunked eth_getLogs with retry for historical event log fetching
  formatters.ts     Formatting, BigInt LLTV parsing, closed-form leverage math,
                      price impact, fractional-day maturity, boost computation,
                      slim envelope helpers, token amount formatting (BigInt → human-readable),
                      Layer 3 output hints (Position Shape, LP APY breakdown,
                      volume signals, Morpho market hints, portfolio signals, cycle detection)
  tools/            Layer 2: each tool description teaches domain-specific mechanics
    context.ts      get_protocol_context (Layer 1 protocol mechanics, callable on-demand)
    pt.ts           get_pt_details, list_pools, get_best_fixed_yields, compare_yield
    looping.ts      get_looping_strategy
    portfolio.ts    get_portfolio (balance ratio strategy signals, portfolio-level hints, cross-ref nudges)
    pool.ts         get_pool_volume (with volume/liquidity hints), get_pool_activity (PT address resolution, Router batching,
                      address isolation w/ cycle detection, flow accounting, contract detection,
                      gas estimates, pool impact warnings), get_address_activity (cross-pool scanner)
    morpho.ts       get_morpho_markets (with capacity/utilization hints), get_morpho_rate (with PT spread analysis)
    protocol.ts     get_protocol_stats, get_supported_chains
    quote.ts        quote_trade (on-chain Curve get_dy() with math fallback)
    simulate.ts     simulate_portfolio_after_trade (also uses on-chain quoting)
    strategy.ts     scan_opportunities (capital-aware, batch Morpho, negative-APY filtering, strategy tension)
    yt_arb.ts       scan_yt_arbitrage (YT execution mechanics, flash-mint/flash-redeem)
    ve.ts           get_ve_info
    metavault.ts    get_metavaults, model_metavault_strategy (live API + computational modeling)
    pendle.ts       list_pendle_markets, compare_pendle_spectra (cross-protocol yield comparison)
    onchain.ts      get_onchain_activity (historical eth_getLogs, Curve pool + PT vault event decoding, dynamic RPC)
test.cjs              Integration test suite (371 tests, McpTestClient over stdio)
test-agent.cjs        Agent reasoning test suite (12 multi-tool workflow tests)
AGENT-TESTS.md        25-question subjective test suite with grading rubrics
docs/
  recursive-meta-process.md    Open Emergence metaframework specification
  dissolution-conditions.md    Dissolution conditions for every structural decision
```

Each tool file exports a `register(server)` function. To add a new tool: create `src/tools/newtool.ts`, export `register()`, import and call it in `index.ts`.

All address parameters are validated (`0x` + 40 hex chars). All API calls have a 15-second timeout with automatic retry on transient failures (5xx, ETIMEDOUT, ENETUNREACH, ENOTFOUND). Cross-chain scans use `Promise.allSettled` so one chain failing doesn't block results from others. GraphQL inputs are sanitized to prevent injection. All error returns use MCP's `isError: true` flag for proper error signaling to agents.

### Type Safety

- **API return types**: `fetchSpectra()` and `fetchMorpho()` return `Promise<unknown>` (not `Promise<any>`), forcing explicit type assertions at every call site
- **Nullish coalescing**: All decimal/balance fallbacks use `??` (not `||`) to correctly handle 0-decimal tokens
- **Morpho state fields**: Typed as `number | null` to match actual API behavior — prevents silent `NaN` propagation
- **JSON parsing**: All `res.json()` calls wrapped in try/catch with descriptive error messages
- **BigInt precision**: veSPECTRA total supply parsed with `10n ** BigInt(18)` to avoid float intermediate overflow
- **Input validation**: Zod schemas enforce `.min()` / `.max()` bounds on all numeric inputs to prevent invalid GraphQL queries

## Technical Details

### Precision & Correctness

- **Morpho LLTV**: Parsed with `BigInt` arithmetic to avoid floating-point precision loss on 18-decimal raw values (e.g., `860000000000000000` → `0.86` exactly)
- **Leverage math**: Closed-form geometric series `(1 - ltv^(n+1)) / (1 - ltv)` replaces iterative loop accumulation — numerically exact and O(1)
- **YT arbitrage**: Uses fractional days-to-maturity for implied rate calculation, avoiding off-by-one annualization errors near expiry
- **Price impact**: Zero-liquidity pools return 100% impact (not 0%), preventing false positives in opportunity scanners. Impact clamped to 99% max to prevent negative output in trade quotes
- **Negative-APY filtering**: Opportunities where entry cost exceeds yield are filtered out before ranking, not sorted to the bottom

### Resilience

- **Retry logic**: Covers `ECONNRESET`, `ETIMEDOUT`, `ENETUNREACH`, `ENOTFOUND`, `EPIPE`, `EHOSTUNREACH`, `EAI_AGAIN`, and `UND_ERR_SOCKET` errors
- **Pool data cache**: 30-second TTL per-chain with inflight request deduplication — repeated scans within 30s serve cached data
- **API validation**: `validatePtEntries()` filters malformed API responses at system boundary (validates address, maturity, name fields)
- **veSPECTRA cache**: Promise-based deduplication prevents duplicate RPC calls when multiple tools run concurrently (5-minute TTL)
- **Morpho batch limit**: `first` parameter capped at `min(addresses * 3, 500)` to avoid GraphQL response limits
- **On-chain quoting**: Curve `get_dy()` via raw `eth_call` on 8 chains with automatic fallback to math estimate on RPC failure
- **Historical event logs**: Chunked `eth_getLogs` (2000 blocks/chunk) with per-chunk retry — failed chunks are skipped so partial results are still returned. Dynamic `rpc_url` parameter enables any chain without hardcoded RPCs
- **Contract detection cache**: Permanent `Map` cache for `eth_getCode` results (contract code doesn't change)
- **MCP error signaling**: All error catch blocks return `isError: true` so agents can distinguish errors from empty results
- **PT address resolution**: Pool tools (`get_pool_volume`, `get_pool_activity`) accept either pool address or PT address and resolve automatically
- **Error logging**: Catch blocks in Morpho lookups log to stderr instead of silently swallowing failures
- **Graceful shutdown**: `server.close()` called before `process.exit()` on SIGTERM/SIGINT

## Testing

From a source checkout:

```bash
# Full integration suite (371 tests, requires network)
npm test

# Schema/registration only (98 tests, no network)
npm run test:offline

# Agent reasoning tests (65-71 assertions, requires network)
npm run test:agent
```

### Integration Tests (`test.cjs`)

371 tests covering tool registration, schema validation, API responses, on-chain Curve `get_dy()` quoting, cross-pool address scanning, address isolation mode, and malformed-address negative tests. Dynamically discovers pool and PT addresses from the live API, so tests won't go stale when pools mature.

### Agent Reasoning Tests (`test-agent.cjs`)

12 multi-tool workflow tests that verify the "reasoning surface" — can an agent using these tools detect anomalies, cross-reference data, and avoid protocol-mechanic traps? Tests include:

- **Protocol context completeness** — all topics present, Router batching ambiguities explained, cross-reference guidance included
- **Anomaly detection** — raw APY vs capital-aware rankings produce different results (intentional divergence)
- **Cross-tool data consistency** — APYs match between `list_pools` → `get_pt_details` → `compare_yield`
- **Router mechanics** — mint-and-sell loop detection via pool activity → portfolio cross-reference
- **Router limitation** — API resolves Router txns that `eth_getLogs` address filtering misses
- **MetaVault data integrity** — curator info, TVL, APY, vault flows, expired position flagging
- **Expired pool discovery** — `list_pools` returns only active pools; MetaVaults surface expired positions
- **veSPECTRA boost math** — max boost (1M veSPECTRA + $1K) vs min boost (100 veSPECTRA + $1M)
- **Morpho looping fallback** — graceful handling when no Morpho market exists for a PT
- **Morpho market classification** — Spectra vs Pendle/Other labels, unsupported chain handling
- **MetaVault scan inclusion** — `include_metavaults` flag correctly shows/hides MetaVault section
- **Pendle comparison** — head-to-head matched pairs with delta, Pendle-only markets, aggregates

### Subjective Test Suite (`AGENT-TESTS.md`)

25 copy-pasteable questions across 6 tiers (basic tool usage → edge cases) with grading rubrics for evaluating LLM agent quality when using the MCP tools. Designed to be run by spawning subagents and scoring responses manually or with LLM-as-judge.

## API Reference

This server wraps these endpoints:

| Endpoint | Used By |
|----------|---------|
| `GET /v1/{chain}/pools` | `list_pools`, `get_best_fixed_yields`, `scan_opportunities`, `scan_yt_arbitrage` (30s TTL cache) |
| `GET /v1/{chain}/pt/{address}` | `get_pt_details`, `compare_yield`, `get_looping_strategy`, `quote_trade`, `simulate_portfolio_after_trade`, `get_pool_volume`/`get_pool_activity` (PT→pool resolution) |
| `GET /v1/{chain}/portfolio/{wallet}` | `get_portfolio`, `simulate_portfolio_after_trade`, `get_address_activity` (expired pool discovery) |
| `GET /v1/{chain}/pools/{pool}/volume` | `get_pool_volume` |
| `GET /v1/{chain}/pools/{pool}/activity` | `get_pool_activity`, `get_address_activity` (active + expired pools) |
| `GET /v1/{chain}/metavaults` | `get_metavaults`, `model_metavault_strategy` (live mode) |
| `GET app.spectra.finance/api/v1/spectra/circulating-supply` | `get_protocol_stats` |
| `GET app.spectra.finance/api/v1/spectra/total-supply` | `get_protocol_stats` |
| `POST api.morpho.org/graphql` | `get_morpho_markets`, `get_morpho_rate`, `get_looping_strategy` (auto-detect), `scan_opportunities` (batch) |
| `POST mainnet.base.org` (eth_call) | `get_ve_info`, `scan_opportunities`, `scan_yt_arbitrage`, `compare_yield` (veSPECTRA total supply) |
| `POST {chain RPC}` (eth_call: `get_dy`) | `quote_trade`, `simulate_portfolio_after_trade` (Curve StableSwap-NG on-chain quotes) |
| `POST {chain RPC}` (eth_call: `eth_getCode`) | `get_pool_activity` (contract vs EOA detection in address mode) |
| `POST {chain RPC}` (eth_getLogs) | `get_onchain_activity` (historical Curve pool events + Spectra PT vault events — supports dynamic `rpc_url` override) |
| `GET api-v2.pendle.finance/core/v2/{chainId}/markets/active` | `list_pendle_markets` (Pendle market discovery) |
| `GET api-v2.pendle.finance/core/v2/{chainId}/markets/active` | `compare_pendle_spectra` (cross-protocol comparison — fetches both Pendle and Spectra data) |

Note: `{chain}` uses the slug `mainnet` for Ethereum (the alias `ethereum` is accepted by the server and mapped automatically).

## Pendle Cross-Protocol Comparison

Two tools enable cross-protocol yield comparison between Spectra and Pendle:

**`list_pendle_markets`** — Lists active Pendle markets on a given chain or scans all Pendle-supported chains. Pendle-supported chains include both overlapping chains (mainnet, base, arbitrum, optimism, sonic, bsc) and Pendle-only chains (Mantle, Berachain, HyperEVM, Corn).

**`compare_pendle_spectra`** — Side-by-side comparison on overlapping chains. Auto-matches markets by underlying asset to produce head-to-head implied APY, LP APY, TVL, and liquidity comparisons. Essential for MetaVault curators who can allocate to either protocol.

## On-Chain Historical Activity

The Spectra REST API (`/v1/{network}/pools/{pool}/activity`) only retains a limited time window of recent transactions. When investigating addresses or pools with older activity, `get_onchain_activity` reads historical event logs directly from the blockchain via `eth_getLogs`.

Supports two contract types:
- **Curve pool** (`pool_address`): TokenExchange, AddLiquidity, RemoveLiquidity, RemoveLiquidityOne
- **Spectra PT vault** (`pt_address`): Mint (deposit IBT → PT+YT), Redeem (burn PT → IBT), YieldClaimed

Both can be provided simultaneously — events are fetched in parallel, merged, and sorted by block number.

Key features:
- **Dynamic RPC URL**: Agent can pass any `rpc_url` parameter — works for chains without hardcoded RPCs (Katana, Monad)
- **Chunked fetching**: 2000 blocks per chunk with per-chunk retry, best-effort (partial results on RPC issues)
- **Dual-contract decoding**: Curve StableSwap-NG pool events AND Spectra PrincipalToken vault events
- **Block range control**: Explicit `from_block`/`to_block` or `lookback_hours` (default 24h, max 720h/30 days)
- **Address filtering**: Filter events by a specific address
- **No USD values**: On-chain logs don't carry prices — token amounts are shown in human-readable form. Cross-reference with `get_pt_details` for price context

Composability with existing tools:
```
Agent flow: get_pool_activity → empty? → get_onchain_activity(pool_address=...) → pool events
Agent flow: portfolio shows PT but no pool trades → get_onchain_activity(pt_address=...) → vault events (mint/redeem)
```

## Extending

### Following the Open Emergence Pattern

When adding new tools, follow the three-layer architecture:

1. **Description (Layer 2):** Teach any protocol mechanics that affect interpretation of the tool's data. Use "could be" language for ambiguous signals. Add cross-reference nudges to at least one related tool.
2. **Output (Layer 3):** If the data contains signals that require domain knowledge to notice (e.g., a ratio that implies a strategy, an event that could mean different things), compute a structured hint and include it in the output. Make it salient but not prescriptive.
3. **Resource (Layer 1):** If the new tool introduces fundamental protocol concepts not covered by existing resources, update `spectra-overview` in `index.ts`.
4. **Dissolution condition:** Document when the new structure would no longer serve, in `docs/dissolution-conditions.md`. Every Layer 3 hint, architectural pattern, and generative friction point carries a dissolution condition — a prompt for re-evaluation when circumstances change.

The goal: a cold-start agent reading only the tool descriptions and output hints should be able to use the tool correctly and compose it with other tools into novel analytical workflows.

### Adding write capabilities (future)

To enable agents to actually execute strategies, you'd add tools that construct unsigned transactions via Spectra's Router contract. The agent would return the transaction calldata for the user to sign -- never holding keys.

### Adding gauge/bribe data

Query the spectra-governance subgraph for current epoch votes, bribe amounts, and voter rewards. This is valuable for agents optimizing veSPECTRA voting strategies.

### Not yet wired (API endpoints available)

These Spectra API endpoints are ready to be integrated. Create a new file in `src/tools/`, export `register()`, and import it in `src/index.ts`:

- `GET /v1/vision/{network}?tokens=...` -- APR data for specific tokens
- `GET /v1/watch-tower/{network}/transactions` -- Conditional order data
- `GET /v1/{network}/metavaults/bridge/transactions` -- MetaVault cross-chain bridge transaction data (bridged volume, in-flight amounts)

## License

MIT
