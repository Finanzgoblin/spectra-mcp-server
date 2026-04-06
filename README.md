# MetaVault MCP

Multi-protocol yield intelligence for AI agents — covering [Spectra Finance](https://spectra.finance), [Pendle](https://pendle.finance), and [Morpho](https://morpho.org) via the [Model Context Protocol](https://modelcontextprotocol.io).

53 tools · 3 protocols · 10+ chains · read-only · on-chain Curve quoting · Pendle logit AMM modeling · ERC-4626 health checks · yield curve term structure · historical eth_getLogs · full Pendle protocol parity (15 tools) · cross-protocol position map · cross-protocol Spectra↔Pendle comparison · veSPECTRA governance dashboard · Pendle historical time-series · Morpho supply-side visibility · Morpho user positions & historical rates · Merkl campaign APR integration · entry path awareness · curator risk monitoring · withdrawal stress testing · rollover planning · multi-vault portfolio aggregation · pool expiry monitoring · zero web3 library dependencies

## What This Does

Any AI agent (Claude, GPT, open-source) that supports MCP can query Spectra, Pendle, and Morpho in a unified interface to:

- **Discover** the best fixed-rate yield opportunities across 10 chains simultaneously
- **Analyze** specific PT/YT positions with full data (APY, TVL, liquidity, prices)
- **Calculate** leveraged looping strategies (Spectra PT + Morpho collateral) with auto-detected borrow rates
- **Compare** fixed vs. variable yields to make informed decisions
- **Track** wallet portfolios across all Spectra positions (PT, YT, LP) with Merkl reward integration for complete PnL
- **Surface** external Merkl campaign APR alongside pool and market data for both Spectra and Pendle
- **Monitor** pool trading volume, individual transaction activity, and cross-pool address scanning
- **Quote** PT trades with on-chain Curve `get_dy()` for exact output, falling back to math estimates
- **Simulate** portfolio state after a hypothetical trade (BEFORE / TRADE / AFTER with deltas)
- **Scan** all chains for capital-aware opportunities with price impact, effective APY, and Morpho looping analysis
- **Detect** YT arbitrage opportunities where IBT APR diverges from YT implied rate
- **Compute** real veSPECTRA boost multipliers per-pool using live on-chain data from Base
- **Discover** live MetaVaults across all chains — curator info, TVL, APY, positions, epoch history
- **Model** MetaVault "double loop" strategies for curators — vault compounding + Morpho leverage with curator economics, auto-populated from live API data or manual parameters
- **Monitor** MetaVault operational health — curator dashboard with vault allocation per position, depositor flows, fee revenue, bridge activity, and actionable alerts
- **Query** Morpho lending markets for PT collateral opportunities, identify who supplies the lending liquidity, and discover vault allocations across markets
- **Query** protocol stats, tokenomics, and governance data
- **Compare** Spectra vs Pendle yield opportunities side-by-side with maturity-aware matching on overlapping chains
- **Scan** both Spectra and Pendle for the best curator opportunities with capital-aware sizing and cross-protocol match tagging
- **Browse** Pendle markets across all Pendle-supported chains (including Pendle-only chains like Mantle, Berachain, HyperEVM, Corn)
- **Analyze** Pendle markets in full depth — market details, portfolio tracking, trade quoting, trade simulation, looping strategies, YT arbitrage, expiry monitoring, yield curves, capacity analysis, and protocol-wide stats (full parity with Spectra tools)
- **Assess** pool depth with multi-size capacity curves — quote PT trades at geometric capital tiers ($1K→$1M) to find the sweet spot and exhaustion point on both Spectra and Pendle
- **Verify** IBT health before deploying — on-chain ERC-4626 conversion rate, APR sustainability (organic vs incentive), pool balance, protocol recognition, liquidity
- **Visualize** yield curves (term structure) for any underlying across all chains — all maturities sorted chronologically with curve shape analysis
- **Recover** historical on-chain pool activity via `eth_getLogs` when API data has aged out — with dynamic RPC URL support for any chain
- **Monitor** curator Morpho position health — liquidation distance, borrow rate drift, health factors across all chains
- **Stress-test** MetaVault withdrawal scenarios — liquidity waterfall analysis (idle → maturing → LP removal → PT sale) with market stress simulation
- **Plan** position rollovers for expiring MetaVault positions — cross-protocol candidate ranking with entry impact, yield gap, and overlap windows
- **Aggregate** multi-vault curator portfolios — total AUM, blended APY, fee revenue projection, concentration analysis by underlying/chain
- **Monitor** pool expiry across all chains with readiness assessment — successor pool detection, gauge status from governance API, and operator checklist (deploy pool / submit gauge / ready for migration)
- **Learn** protocol mechanics on-demand via `mv_get_protocol_context` (PT/YT identity, Router batching, deposit paths, glossary, fees & costs, workflow routing)
- **Surface** protocol YT fees (Spectra 3%, Pendle 5%) and Merkl campaign eligibility (POOL vs HOLD) directly in tool output so agents apply them without external lookups

The agent doesn't need to understand PT/YT mechanics -- it just calls `spectra_scan_opportunities` or `pendle_scan_opportunities` with its capital size and gets ranked, actionable data. For cross-protocol comparison, `mv_scan_curator_opportunities` ranks both protocols together. If it needs to understand *why* something works that way, it calls `mv_get_protocol_context`.

## Open Emergence Architecture

The server is designed so that AI agents can **discover novel strategies without being taught specific strategies**. Instead of hard-coding strategy identification logic, the system teaches protocol mechanics at three layers — and lets the agent compose building blocks into its own analysis.

### The Three Layers

```
Layer 1: Protocol Context (mv_get_protocol_context tool + resources)
  → Teaches the "physics" of the protocol: PT/YT identity, Router batching, minting
  → Available as a callable tool (on-demand) and as MCP resources
  → Static knowledge — what CAN happen, not what IS happening

Layer 2: Tool Descriptions (every tool's description string)
  → Teaches domain-specific mechanics relevant to that tool's data
  → Cross-reference nudges: "use spectra_get_portfolio to check actual holdings"
  → Uses "could be" language, not "is" — preserves ambiguity where it exists
  → Calls out hidden mechanics that could mislead (e.g., AMM_ADD_LIQUIDITY can mint YT)

Layer 3: Structured Output Hints (computed at runtime in tool output)
  → Position Shape analysis in portfolio: balance ratios (e.g., "YT/PT 4:1")
  → Portfolio Signals: concentration, maturity alerts, strategy shape across positions
  → Volume Signals: volume/liquidity ratio, buy/sell skew, trend detection
  → Morpho Market Hints: capacity warnings, utilization alerts, spread analysis, reward incentives
  → Morpho Supply-Side Analysis: supplier identification (vault/EOA/looper), concentration metrics,
    supply gap warnings — surfaces where lending liquidity comes from and whether it's sufficient
  → Competing Interpretation Branches (A/B/C) in activity analysis per-address:
    multiple explanations for the same observable pattern, presented with equal weight.
    The agent must bring external evidence to collapse branches — the tension IS the info.
  → Statistical confidence boundaries: small-N cycle repetitions (≤5) flagged as
    insufficient for extrapolation, preventing false pattern-matching
  → Flow Accounting with competing hypotheses: YT-only, PT-only, fully exited positions
    each get multiple explanations that predict different future behavior
  → Address isolation mode: cycle detection, flow accounting, contract/EOA detection,
    pool impact warnings, gas estimates, pool context
  → Capital-aware warnings: short maturity, low liquidity, negative effective APY
  → Yield Dimensions in scan output: fixed, variable, LP, looping side-by-side
  → Strategy Tension: competing PT looping vs YT accumulation on same pool
  → On-chain quote source indicators: "(on-chain Curve get_dy)" vs "(estimated)"
  → Yield composition: IBT APR breakdown (organic base vs external incentives) in scans and quotes
  → Incentive sustainability: flags when >50% of IBT APR or LP APY comes from incentives,
    shows "organic only" APY so agents can assess yield durability without incentive assumptions
  → Pool reserves: IBT/PT amounts with ratio for AMM imbalance analysis
  → Merkl campaign APR: external incentive programs (e.g., KAT rewards) shown per-pool/market
    with double-counting avoidance (skips campaigns whose reward tokens are already displayed)
  → Merkl campaign eligibility: action type (POOL/HOLD) always shown, with explicit
    "[LP only — not for YT/PT holders]" flag on POOL campaigns to prevent misattribution
  → Protocol YT fees: Spectra 3% and Pendle 5% shown in every pool/market detail output
    so agents apply them to yield calculations without needing external lookups
  → Points multipliers: external programs (Drops, InfiniFi, Firelight) with amounts
  → "Could be" / "at current rates" language: preserves ambiguity in ranked output
  → Makes key signals SALIENT without prescribing interpretation

Layer 4: Observation Coverage (quantifies blind spots in tool output)
  → Value coverage: what % of an address's position is explained by observable activity.
    Low coverage means most behavior is invisible (direct mints, transfers, cross-chain).
  → Temporal coverage: active days vs dark periods with no observable events.
    Longest gap duration surfaced so the agent can reason about invisible activity.
  → Data source coverage: which of 5 available sources were consulted vs not.
    Explicitly lists what is invisible to the current analysis.
  → Activity diversity: single-type activity flagged as highest-ambiguity pattern.
  → Boundary marker: "Position sizing should assume this analysis is incomplete,
    not comprehensive." — a structural admission of domain-of-validity limits.
  → Coverage metrics bound ALL interpretations above them. High-confidence strategy
    assessment + low observation coverage = false confidence. The coverage section
    forces the agent to size its conviction to what it actually observed.
```

### Design Principles

- **Teach mechanics, not conclusions.** The server explains that AMM_ADD_LIQUIDITY *could be* a mint+LP batch operation — it doesn't conclude "this user is accumulating YT."
- **Present competing interpretations, not single narratives.** Activity analysis outputs multiple interpretation branches (A/B/C) that predict different future behavior. The agent must bring external evidence to collapse them. This friction surface prevents premature pattern-matching — the most common failure mode in wallet strategy analysis.
- **Flag statistical insufficiency.** Small repetition counts (≤5 cycle detections) are explicitly flagged as insufficient for extrapolation. The agent cannot treat N=3 as a confirmed pattern.
- **Every tool cross-references at least one other tool.** This creates analytical workflows without dictating them. The agent learns to check `spectra_get_portfolio` after seeing activity patterns, not because it was told to.
- **Hidden mechanics are called out where they can mislead.** The Spectra Router batches multiple operations atomically. A `SELL_PT` event might actually be YT acquisition via flash-mint. Tool descriptions teach this so agents don't draw wrong conclusions from pool data alone.
- **Full addresses in output, never truncated.** When addresses appear in activity data, they're shown in full so the agent can pass them directly to `spectra_get_portfolio` without needing a block explorer.
- **Discovery tools warn about capital-awareness gaps.** `spectra_get_best_fixed_yields` explicitly says "this ranks by raw APY — use `spectra_scan_opportunities` for capital-aware sizing."
- **Quantify blind spots, not just interpretations.** Tools now output observation coverage metrics: what percentage of behavior is visible, what data sources were consulted vs available, and how long dark periods lasted. These are not interpretations — they're structural measurements of the analysis's own incompleteness. An agent that sees 35% value coverage should size its confidence accordingly, regardless of how coherent the best-fitting interpretation looks.

### Why This Matters

A cold-start agent with zero prior knowledge of the protocols can:
1. Call `mv_scan_curator_opportunities` — see cross-protocol (Spectra + Pendle) yield rankings with capital-aware metrics
2. Call `spectra_get_pool_activity` — see trading patterns with ⚠ hints about ambiguous events
3. Call `spectra_get_portfolio` and `pendle_get_portfolio` on flagged addresses — see Position Shape across both protocols
4. Read the cross-reference nudges — compose its own analytical workflow spanning all three protocols
5. Identify novel strategies the server was never explicitly programmed to detect

This was validated: a subagent spawned with zero priming correctly identified a mint-and-sell-PT loop strategy (YT accumulation via PT discount) in 3 tool calls, using only the mechanics taught in descriptions and the structured hints in output.

The competing-branch design was motivated by a real failure: an agent analyzing a multi-chain wallet collapsed all activity into "YT accumulator" despite different pools showing different patterns (spread capture, market making, LP cycling). The single-narrative failure mode — where the agent picks one interpretation and defends it — is the most dangerous because it looks like good analysis from inside.

The observation coverage layer addresses a deeper problem: even perfect interpretation of observed data is misleading when the data covers a minority of behavior. Competing branches solve the *narrative* problem (which story fits?). Coverage metrics solve the *exposure* problem (how much of the picture am I seeing?). An agent that picks the best interpretation branch but ignores 65% invisible activity is sizing conviction to coherence, not evidence.

## Tools

| Tool | Description |
|------|-------------|
| `spectra_get_best_fixed_yields` | Scan ALL chains for top fixed-rate opportunities. The main discovery tool. Supports `compact` mode. |
| `spectra_list_pools` | List all active pools on a specific chain, sorted by APY/TVL/maturity. Surfaces pool reserves, IBT APR composition, maturityValue, multipliers, and tags. Supports `compact` mode and `include_expired` flag. |
| `spectra_get_pt_details` | Deep dive on a specific Principal Token -- full data including maturityValue, multipliers (points programs), tags, pool reserves, IBT APR composition, and baseIbt for wrapper tokens. |
| `spectra_compare_yield` | Fixed (PT) vs. variable (IBT) yield comparison with spread mechanics and entry cost analysis. |
| `spectra_get_looping_strategy` | Calculate leveraged yield via PT + Morpho looping with effective liquidation margins, borrow rate sensitivity (+1/2/3%), break-even period, and failure scenario modeling. Auto-fetches live Morpho rates when a matching market exists. |
| `morpho_list_markets` | Find Morpho lending markets that accept Spectra PTs as collateral. Filter by chain or symbol. Shows reward incentives, vault supplier count per market. Cross-references Spectra PT addresses. |
| `morpho_get_rate` | Get live borrow rate, state, and supply-side context for a specific Morpho market. Includes PT spread analysis, top supplier identification, and vault allocation details (% of AUM, cap utilization). |
| `morpho_get_market_suppliers` | Supply-side analysis for a Morpho market: top suppliers ranked by size, vault vs EOA/looper identification, concentration analysis, supply gap warnings. Reveals where lending liquidity comes from. |
| `morpho_list_vaults` | List Morpho vaults on a chain with enriched allocations: Spectra PT tagging, live borrow rates and utilization per allocation, cap utilization percentages. Parallel-fetches market rates and PT addresses for zero-latency enrichment. |
| `morpho_get_positions` | Query a user's Morpho positions across markets and vaults on a chain (or all Morpho chains). Shows collateral, borrows, supply with USD values, vault deposits, health factors, looper detection, and position signals. |
| `morpho_get_history` | Historical rates and growth for a specific Morpho market. Shows borrow/supply APY, utilization, and TVL trends with min/avg/max/current stats. Includes rate stability signals, spike detection, and supply/demand squeeze alerts. |
| `spectra_get_protocol_stats` | SPECTRA tokenomics, emissions schedule, fee distribution, governance info. |
| `spectra_list_chains` | List available networks (10 chains). |
| `spectra_get_portfolio` | Wallet positions across PT, YT, and LP with USD values, claimable yield, and Merkl rewards (SPECTRA gauge emissions + incentive programs). Rewards matched to specific pools via reason key parsing. |
| `spectra_get_pool_volume` | Historical buy/sell trading volume for a specific pool. Accepts PT address or pool address. |
| `spectra_get_pool_activity` | Recent individual transactions (buys, sells, liquidity events) with filtering. Address isolation mode presents competing interpretation branches (A/B/C), statistical confidence boundaries on cycles, flow accounting with competing hypotheses, contract/EOA detection, gas estimates. Accepts PT or pool address. |
| `spectra_get_address_activity` | Cross-pool address scanner — finds all pools an address has interacted with on a chain (or all chains) in one call. Includes expired/matured pools via portfolio lookup. Per-pool breakdown + cross-pool aggregates. |
| `spectra_quote_trade` | PT trade quoting with on-chain Curve `get_dy()` for exact output (falls back to math estimate). Shows price impact, slippage, minOut, pool reserves with ratio, and IBT APR composition. |
| `spectra_simulate_trade` | Preview portfolio BEFORE/AFTER a hypothetical PT trade with deltas, warnings, and on-chain quoting. |
| `spectra_scan_opportunities` | Capital-aware opportunity scanner: price impact at your size, effective APY, Morpho looping, pool capacity, IBT APR composition, and points multipliers. Supports `compact` mode. |
| `spectra_scan_yt_arbitrage` | YT rate vs IBT rate arbitrage scanner -- finds pools where YT is mispriced relative to underlying yield. Includes IBT APR composition for spread sustainability analysis. Supports `compact` mode. |
| `spectra_get_ve_info` | Live veSPECTRA data from Base chain (total supply via on-chain read) + boost calculator with per-pool multipliers. |
| `spectra_list_metavaults` | List live MetaVaults across all chains (or a specific chain). Returns curator info, TVL, live APY, share price, active positions, and epoch history. |
| `spectra_model_metavault` | MetaVault "double loop" strategy modeler for curators. Live mode (chain + metavault_address) auto-fetches APY from API; manual mode accepts base_apy directly. Models curator economics (fee revenue, TVL creation, effective ROI). |
| `spectra_get_curator_dashboard` | Operational dashboard for MetaVault curators. Vault health, position status with vault allocation (when available) vs pool TVL, depositor flows, fee revenue estimates, bridge activity, and actionable alerts. Explicitly disambiguates vault allocation from pool-level TVL to prevent misinterpretation. |
| `pendle_list_markets` | List active Pendle markets on a given chain or all Pendle chains. Supports Pendle-only chains (Mantle, Berachain, HyperEVM, Corn). Supports `compact` mode. |
| `pendle_get_market_details` | Deep dive on a single Pendle market — implied APY, LP APY breakdown (swap fees + PENDLE incentives + boost), underlying variable APY, pool reserves, fee rate, Merkl campaigns. |
| `pendle_get_best_fixed_yields` | Scan all Pendle chains for top fixed-rate opportunities. Ranked by implied APY with TVL/liquidity filters. The Pendle equivalent of `spectra_get_best_fixed_yields`. |
| `pendle_get_portfolio` | Wallet positions across all Pendle chains — PT, YT, LP balances with USD values and implied APY per position. |
| `pendle_scan_opportunities` | Capital-aware Pendle opportunity scanner — price impact at your size using logit AMM model, effective APY, Morpho looping for Pendle PTs, Merkl campaigns. Supports `compact` mode. |
| `pendle_get_market_capacity` | Multi-size capacity curve for a Pendle market — quotes at geometric capital tiers using logit AMM model to find sweet spot and exhaustion point. |
| `pendle_get_yield_curve` | Term structure for a given underlying across Pendle chains. All maturities sorted chronologically with curve shape analysis (normal/inverted/flat), steepest segment, cross-chain pairs. |
| `pendle_list_expiring_markets` | Scan Pendle chains for markets approaching maturity. Groups by urgency (CRITICAL ≤7d, WARNING ≤14d, ALERT ≤threshold). |
| `pendle_scan_yt_arbitrage` | YT mispricing scanner — compares underlying variable APY vs implied rate. Pendle YT trades directly on AMM (simpler execution than Spectra's Router flash-mint/redeem). |
| `pendle_get_protocol_stats` | Protocol-wide aggregate stats — total TVL, market count, volume, avg APY across all Pendle chains with per-chain breakdown and Spectra overlap indicator. |
| `pendle_get_looping_strategy` | Leveraged PT + Morpho looping calculator for Pendle PTs — borrow rate sensitivity, break-even analysis, 30-day historical risk assessment with P(underwater) probability. Auto-detects Morpho markets. |
| `pendle_quote_trade` | PT trade quote using Pendle logit AMM model — expected output, price impact, effective APY after entry cost, min output with slippage tolerance. |
| `pendle_simulate_trade` | Portfolio impact simulation for Pendle PT trades — before/after position values, blended APY change, concentration analysis. |
| `mv_compare_yield` | Side-by-side Pendle vs Spectra yield comparison on overlapping chains (mainnet, base, arbitrum, optimism, sonic, bsc). Maturity-aware matching with configurable tolerance (exact ≤7d, close ≤30d, loose ≤90d). |
| `mv_scan_curator_opportunities` | Cross-protocol (Spectra + Pendle) capital-aware scanner for MetaVault curators. Price impact at your size, effective APY, Morpho looping (Spectra + Pendle), cross-protocol match tagging. Supports `compact` mode. |
| `spectra_get_onchain_activity` | Historical on-chain activity via `eth_getLogs` — recovers data when the API has aged out transactions. Supports dynamic `rpc_url` parameter for any chain, `token_decimals` for correct formatting (USDC=6, WBTC=8). Decodes **Curve pool events** (swaps, LP adds/removes) via `pool_address` AND **Spectra PT vault events** (Mint, Redeem, YieldClaimed) via `pt_address`. Both can be provided simultaneously for merged results. |
| `spectra_get_pool_capacity` | Multi-size capacity curve — quotes PT trades at geometric capital tiers to show price impact and effective APY degradation. Identifies sweet spot and exhaustion point. On-chain Curve quotes. |
| `mv_check_ibt_health` | Multi-signal IBT health assessment — on-chain ERC-4626 conversion rate, APR composition (organic vs incentive), pool balance ratio, protocol recognition, liquidity level. Returns HEALTHY/CAUTION/WARNING verdict. |
| `spectra_get_yield_curve` | Term structure for a given underlying across all chains. All maturities sorted chronologically with implied APY, TVL, liquidity. Curve shape analysis (normal/inverted/flat), steepest segment, cross-chain pairs. |
| `morpho_monitor_risk` | Liquidation risk monitor for curator Morpho positions — health factor, liquidation price, distance-to-liquidation, borrow rate drift, alert levels (ok/watch/warning/critical). |
| `spectra_stress_test_vault` | Withdrawal stress test for MetaVaults — liquidity waterfall (idle → maturing → LP removal → PT sale), cost to remaining depositors, maximum safe redemption size. Market stress mode (2x impact). |
| `mv_plan_rollover` | Position rollover planner for expiring MetaVault positions — scans Spectra + Pendle for replacement candidates, computes entry impact, yield gap, overlap windows, and net effective APY. |
| `mv_get_curator_portfolio` | Multi-vault portfolio aggregation — total AUM, blended APY, fee revenue projection, concentration by underlying/chain, cross-vault action items. Discovery mode (by curator address) or explicit mode. |
| `spectra_list_expiring_pools` | Scan all chains for pools approaching maturity (default 21-day threshold). Groups by urgency (CRITICAL ≤7d, WARNING ≤14d, ALERT ≤21d). Cross-references each expiring pool's IBT against all active pools for successor detection. Fetches gauge status from governance API. Per-pool readiness assessment (OK/CAUTION/WARNING). Operator checklist: deploy successor pool, submit gauge proposal, ready for migration. |
| `mv_get_protocol_context` | Returns protocol mechanics reference (PT/YT identity, Router batching, deposit paths, glossary, fees & costs, workflow routing). 9 topics callable on-demand. Fees topic covers Spectra 3% / Pendle 5% YT fees, reward basis (held vs notional), Merkl campaign types, and external points program discovery. |

## Supported Chains

**Spectra**: Ethereum (mainnet), Base, Arbitrum, Optimism, Avalanche, Katana, Sonic, Flare, BSC, Monad

**Pendle**: Ethereum, Optimism, BSC, Sonic, Base, Arbitrum, Mantle, Berachain, HyperEVM, Corn

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

Tools that accept `ve_spectra_balance` (`spectra_scan_opportunities`, `spectra_scan_yt_arbitrage`, `spectra_compare_yield`, `spectra_get_ve_info`) compute per-pool boost automatically. The veSPECTRA contract is an NFT-based voting escrow (veNFT) at `0x6a89228055c7c28430692e342f149f37462b478b` on Base, sourced from [spectra-core](https://github.com/perspectivefi/spectra-core).

## MetaVault Discovery & Strategy Modeling

MetaVaults are ERC-7540 curated vaults that automate LP rollover and compound YT yield back into LP positions. Two tools work together:

**`spectra_list_metavaults`** — Discovery tool. Fetches live MetaVault data from the API (`/v1/{network}/metavaults`), scanning a single chain or all chains in parallel. Returns curator info, TVL, live APY, share price, active positions with PT/pool details, and epoch rate history.

**`spectra_model_metavault`** — Strategy modeler with two modes:
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
npm install -g metavault-mcp
```

Or run directly without installing:

```bash
npx metavault-mcp
```

### Install from source

```bash
git clone https://github.com/Finanzgoblin/metavault-mcp.git
cd metavault-mcp
npm install
npm run build
```

## Connect to Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "metavault-mcp": {
      "command": "npx",
      "args": ["metavault-mcp"]
    }
  }
}
```

Restart Claude Desktop. You'll see all 53 tools (Spectra, Pendle, Morpho, cross-protocol) available.

## Connect to Claude Code

```bash
claude mcp add metavault-mcp -- npx metavault-mcp
```

## Deep Analysis Prompts

The more context you give upfront, the deeper the agent can go. Each input unlocks a different tool chain:

| Input | What it unlocks |
|-------|----------------|
| Capital size (`$200K`) | Price impact at your size, pool capacity limits, effective APY |
| Wallet address (`0x...`) | Portfolio simulation, existing position context, Merkl rewards |
| veSPECTRA balance | Real per-pool boost (not min/max range) |
| Asset preference | Filtered yield curve, targeted scans |
| Strategy type | LP vs PT vs looping vs MetaVault — determines which tools get chained |
| Maturity window | Term structure analysis, rollover timing |

**The ideal prompt combines all of these.** Here are examples that trigger 8-10 tool chains:

- **Yield hunter:** "I have $50K USDC and 10,000 veSPECTRA. Find me the best risk-adjusted fixed yield for 60-180 days. Check IBT health, quote my exact entry, and show who else is in the pool."
- **Curator:** "I'm building a USDC MetaVault on Base with $500K own capital, expecting $2M external. Model the double-loop economics and compare Spectra vs Pendle LP allocation."
- **Investigator:** "Wallet 0xABC... is active on Spectra mainnet. Show me everything — portfolio, activity across all pools, sequence analysis, and what strategy they're running."
- **Term structure:** "Show me the ETH yield curve across all chains. Where are the term premium anomalies? Quote pool capacity at $200K for the top 3 mispricings."

The cross-referencing between tools is where the real depth happens — no single tool tells the full story. The agent calls `mv_get_protocol_context(topic="workflow_routing")` to learn these compositions at runtime.

## Example Queries

Once connected, you can ask Claude things like:

- "What's the best fixed yield on USDC right now?"
- "Show me all Spectra pools on Base with >$50k TVL"
- "Calculate a 3x looping strategy for PT-USDC on Base using Morpho"
- "Is the fixed rate on stETH better than the variable rate?"
- "What Morpho markets accept Spectra PTs as collateral?"
- "What's the borrow rate on that Morpho PT-USDC market?"
- "What are the current SPECTRA emissions and lock rate?"
- "Show me the portfolio for 0xABC...DEF across all chains — include any unclaimed Merkl rewards"
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
- "I'm curating a MetaVault with $500K -- scan both Spectra and Pendle for the best opportunities"
- "Show me all active Pendle markets on Arbitrum sorted by TVL"
- "How much capital can I put into this pool before the price impact kills my yield?"
- "Is the IBT behind this PT healthy? Check the conversion rate and APR composition"
- "Show me the USDC yield curve -- what rates are available at each maturity?"
- "Compare the 30-day vs 90-day vs 180-day rates for ETH across all chains"
- "This address traded on Katana weeks ago but spectra_get_pool_activity shows nothing -- pull on-chain logs for the last 7 days"
- "Fetch historical activity for this pool using my RPC URL: https://rpc.katana.network"
- "Monitor my Morpho positions for liquidation risk -- show me the distance to liquidation for each"
- "Stress test my MetaVault on Base -- what happens if 30% of depositors redeem in one epoch?"
- "I have a position expiring in 14 days on my MetaVault -- plan the rollover and show me the best candidates"
- "Aggregate my curator portfolio across all chains -- show me total AUM, blended APY, and concentration"

## Architecture

```
Agent (Claude/GPT/etc)
  | MCP Protocol (stdio)
MetaVault MCP (this)
  | HTTP (15s timeout, 1 retry on 5xx/network errors)
  |
  +-- api.spectra.finance/v1/{chain}/pools
  +-- api.spectra.finance/v1/{chain}/pt/{address}
  +-- api.spectra.finance/v1/{chain}/portfolio/{wallet}
  +-- api.spectra.finance/v1/{chain}/pools/{pool}/volume
  +-- api.spectra.finance/v1/{chain}/pools/{pool}/activity
  +-- api.spectra.finance/v1/{chain}/metavaults
  +-- app.spectra.finance/api/v1/spectra/*
  +-- api.merkl.xyz/v3/userRewards (unclaimed Merkl rewards per wallet)
  +-- api.merkl.xyz/v4/opportunities (Merkl campaign APR per chain)
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
  types.ts          TypeScript interfaces (SpectraPt, MorphoMarket, ScanOpportunity, MerklTokenReward, MerklChainRewards, MerklCampaign, etc.)
  api.ts            Fetch helpers with retry, GraphQL sanitization, Morpho batch lookup,
                      veSPECTRA RPC with Promise-based dedup cache, 30s TTL pool data cache,
                      Curve get_dy() on-chain quoting, ERC-4626 convertToAssets() health check,
                      eth_getCode contract detection,
                      MetaVault multi-chain scanning, API response validation at system boundary,
                      chunked eth_getLogs with retry for historical event log fetching,
                      Merkl reward fetching and parsing (pool address extraction from reason keys,
                      BigInt wei→human conversion, matched/unmatched reward categorization),
                      Merkl v4 campaign APR fetching (60s TTL cache, inflight dedup, address-based lookup)
  formatters.ts     Formatting, BigInt LLTV parsing, closed-form leverage math,
                      price impact, fractional-day maturity, boost computation,
                      slim envelope helpers, token amount formatting (BigInt → human-readable),
                      cross-protocol maturity matching (normalizeUnderlyingSymbol, matchByAssetAndMaturity),
                      Layer 3 output hints (Position Shape, LP APY breakdown,
                      volume signals, Morpho market hints, portfolio signals,
                      competing interpretation branches, statistical confidence boundaries,
                      flow accounting with competing hypotheses),
                      Layer 4 observation coverage (value coverage, temporal gaps,
                      data source coverage, activity diversity, boundary markers),
                      Merkl reward display (per-position matched rewards, unmatched/exited rewards),
                      Merkl campaign APR display (formatMerklCampaignLines with double-counting avoidance)
  tools/            Layer 2: each tool description teaches domain-specific mechanics
    context.ts      mv_get_protocol_context (Layer 1 protocol mechanics, deposit paths, glossary, callable on-demand)
    pt.ts           spectra_get_pt_details, spectra_list_pools, spectra_get_best_fixed_yields, spectra_compare_yield
    looping.ts      spectra_get_looping_strategy
    portfolio.ts    spectra_get_portfolio (balance ratio strategy signals, portfolio-level hints, cross-ref nudges,
                      Merkl rewards integration — parallel fetch, per-position matching, unmatched rewards)
    pool.ts         spectra_get_pool_volume (with volume/liquidity hints), spectra_get_pool_activity (PT address resolution, Router batching,
                      address isolation w/ cycle detection, flow accounting, contract detection,
                      gas estimates, pool impact warnings, observation coverage metrics),
                      spectra_get_address_activity (cross-pool scanner with coverage boundary markers)
    morpho.ts       morpho_list_markets (with capacity/utilization hints), morpho_get_rate (with PT spread analysis)
    protocol.ts     spectra_get_protocol_stats, spectra_list_chains
    quote.ts        spectra_quote_trade (on-chain Curve get_dy() with math fallback)
    simulate.ts     spectra_simulate_trade (also uses on-chain quoting)
    strategy.ts     spectra_scan_opportunities (capital-aware, batch Morpho, negative-APY filtering, strategy tension)
    yt_arb.ts       spectra_scan_yt_arbitrage (YT execution mechanics, flash-mint/flash-redeem)
    ve.ts           spectra_get_ve_info
    metavault.ts    spectra_list_metavaults, spectra_model_metavault (live API + computational modeling),
                      spectra_get_curator_dashboard (vault allocation disambiguation, cross-chain position awareness)
    pendle.ts       pendle_list_markets, mv_compare_yield (maturity-aware cross-protocol yield comparison)
    curator_scan.ts mv_scan_curator_opportunities (cross-protocol capital-aware scanner for MetaVault curators)
    onchain.ts      spectra_get_onchain_activity (historical eth_getLogs, Curve pool + PT vault event decoding, dynamic RPC)
    capacity.ts     spectra_get_pool_capacity (multi-size quote ladder, sweet spot / exhaustion detection)
    ibt_health.ts   mv_check_ibt_health (ERC-4626 conversion rate, APR composition, pool balance, verdict)
    yield_curve.ts  spectra_get_yield_curve (term structure for a given underlying across all chains)
    risk_monitor.ts morpho_monitor_risk (liquidation distance, health factor, borrow rate drift, alert levels)
    stress_test.ts  spectra_stress_test_vault (withdrawal liquidity waterfall, market stress simulation)
    rollover.ts     mv_plan_rollover (expiring position rollover planner with cross-protocol candidates)
    curator_portfolio.ts mv_get_curator_portfolio (multi-vault aggregation, AUM, blended APY, concentration)
    expiry_monitor.ts spectra_list_expiring_pools (pool maturity monitoring, urgency grouping, successor cross-reference, gauge status, readiness assessment)
test.cjs              Integration test suite (405 tests, McpTestClient over stdio)
test-agent.cjs        Agent reasoning test suite (82 assertions, McpTestClient over stdio)
AGENT-TESTS.md        38-question subjective test suite with grading rubrics (incl. open emergence, coverage, newcomer comprehension tiers)
EMERGENCE-AUDIT.md    Open Emergence audit — competing branches, observation coverage, anomaly detection gaps
CODE-REVIEW.md        Full codebase review (bugs, security, code quality, test coverage)
SECURITY-REVIEW.md    Security-focused review (SSRF, GraphQL injection, dependency vulnerabilities)
docs/
  recursive-meta-process.md    Open Emergence metaframework specification
  dissolution-conditions.md    Dissolution conditions for every structural decision
  architecture-review-agentic-accessibility.md    Agentic accessibility review with feature proposals
```

Each tool file exports a `register(server)` function. To add a new tool: create `src/tools/newtool.ts`, export `register()`, import and call it in `index.ts`.

All address parameters are validated (`0x` + 40 hex chars). All API calls have a 15-second timeout with automatic retry on transient failures (5xx, ETIMEDOUT, ENETUNREACH, ENOTFOUND). Cross-chain scans use `Promise.allSettled` so one chain failing doesn't block results from others. GraphQL inputs are sanitized to prevent injection. All error returns use MCP's `isError: true` flag for proper error signaling to agents.

### Type Safety

- **API return types**: `fetchSpectra()` and `fetchMorpho()` return `Promise<unknown>` (not `Promise<any>`), forcing explicit type assertions at every call site
- **Nullish coalescing**: All decimal/balance fallbacks use `??` (not `||`) to correctly handle 0-decimal tokens
- **Morpho state fields**: Typed as `number | null` to match actual API behavior — prevents silent `NaN` propagation
- **JSON parsing**: Body read as text first, then `JSON.parse()` — avoids stream double-consumption that masked error diagnostics
- **BigInt precision**: veSPECTRA total supply parsed with `10n ** BigInt(18)` to avoid float intermediate overflow. Trade quoting uses `amountToBigInt()` (string arithmetic) to avoid precision loss when `amount * 10^decimals` exceeds `MAX_SAFE_INTEGER`
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
- **IBT health checks**: ERC-4626 `convertToAssets()` via raw `eth_call` — graceful degradation when RPC unavailable (other health checks still run)
- **Historical event logs**: Chunked `eth_getLogs` (2000 blocks/chunk) with per-chunk retry — failed chunks are skipped so partial results are still returned. Dynamic `rpc_url` parameter enables any chain without hardcoded RPCs
- **Contract detection cache**: Permanent `Map` cache for `eth_getCode` results (contract code doesn't change)
- **Merkl rewards**: Best-effort parallel fetch from Merkl API — failure does not block portfolio display. Pool address matching via regex extraction from reason keys. BigInt `parseWei()` conversion for safe 18-decimal arithmetic
- **Merkl campaigns**: Best-effort v4 campaign APR fetch per chain (60s TTL cache with inflight dedup). Failure returns empty map — tool output is unchanged. Double-counting avoidance skips campaigns whose reward tokens are already displayed via native API data
- **MCP error signaling**: All error catch blocks return `isError: true` so agents can distinguish errors from empty results
- **PT address resolution**: Pool tools (`spectra_get_pool_volume`, `spectra_get_pool_activity`) accept either pool address or PT address and resolve automatically
- **Error logging**: Catch blocks in Morpho lookups log to stderr instead of silently swallowing failures
- **Graceful shutdown**: `server.close()` called before `process.exit()` on SIGTERM/SIGINT

## Testing

From a source checkout:

```bash
# Full integration suite (405 tests, requires network)
npm test

# Schema/registration only (98 tests, no network)
npm run test:offline

# Unit tests (242 tests, no network)
npm run test:unit

# Agent reasoning tests (82 assertions, requires network)
npm run test:agent
```

### Unit Tests (`api.test.ts`, `formatters.test.ts`, `config.test.ts`)

242 tests covering pure-function logic: GraphQL sanitization, Morpho field constants, Merkl reward parsing (pool address extraction from reason keys, wei-to-human conversion, matched/unmatched categorization), Merkl reward formatting, balance formatting, cross-protocol maturity matching (normalizeUnderlyingSymbol, matchByAssetAndMaturity), Pendle logit AMM price impact model (estimatePendlePriceImpact), Pendle date/maturity helpers (pendleDaysToMaturity), Pendle market formatters (compact + summary), and configuration validation. No network required.

### Integration Tests (`test.cjs`)

405 tests covering tool registration, schema validation, API responses, on-chain Curve `get_dy()` quoting, cross-pool address scanning, address isolation mode, cross-protocol curator scanning, and malformed-address negative tests. Dynamically discovers pool and PT addresses from the live API, so tests won't go stale when pools mature.

### Agent Reasoning Tests (`test-agent.cjs`)

82 assertions across multi-tool workflow tests that verify the "reasoning surface" — can an agent using these tools detect anomalies, cross-reference data, and avoid protocol-mechanic traps? Tests include:

- **Protocol context completeness** — all topics present, Router batching ambiguities explained, cross-reference guidance included
- **Anomaly detection** — raw APY vs capital-aware rankings produce different results (intentional divergence)
- **Cross-tool data consistency** — APYs match between `spectra_list_pools` → `spectra_get_pt_details` → `spectra_compare_yield`
- **Router mechanics** — mint-and-sell loop detection via pool activity → portfolio cross-reference
- **Router limitation** — API resolves Router txns that `eth_getLogs` address filtering misses
- **MetaVault data integrity** — curator info, TVL, APY, vault flows, expired position flagging
- **Expired pool discovery** — `spectra_list_pools` returns only active pools; MetaVaults surface expired positions
- **veSPECTRA boost math** — max boost (1M veSPECTRA + $1K) vs min boost (100 veSPECTRA + $1M)
- **Morpho looping fallback** — graceful handling when no Morpho market exists for a PT
- **Morpho market classification** — Spectra vs Pendle/Other labels, unsupported chain handling
- **MetaVault scan inclusion** — `include_metavaults` flag correctly shows/hides MetaVault section
- **Pendle comparison** — head-to-head matched pairs with delta, Pendle-only markets, aggregates
- **Surfaced API fields** — maturityValue, multipliers (points programs), tags, pool reserves with ratio, IBT APR composition, baseIbt for wrapper tokens
- **Merkl rewards in portfolio** — SPECTRA gauge emissions appear in portfolio output, graceful handling for empty wallets

### Subjective Test Suite (`AGENT-TESTS.md`)

38 copy-pasteable questions across 11 tiers (basic tool usage → open emergence → newcomer comprehension) with grading rubrics for evaluating LLM agent quality when using the MCP tools. Tier 8 tests "open emergence" — the ability to hold competing interpretations without collapsing to a single narrative. Tier 11 tests newcomer comprehension — can the agent explain deposit paths, recognize conservative impact estimates, and route to the right scanner? These are designed to be run by spawning subagents and scoring responses manually or with LLM-as-judge.

## API Reference

This server wraps these endpoints:

| Endpoint | Used By |
|----------|---------|
| `GET /v1/{chain}/pools` | `spectra_list_pools`, `spectra_get_best_fixed_yields`, `spectra_scan_opportunities`, `spectra_scan_yt_arbitrage`, `spectra_get_yield_curve` (30s TTL cache) |
| `GET /v1/{chain}/pt/{address}` | `spectra_get_pt_details`, `spectra_compare_yield`, `spectra_get_looping_strategy`, `spectra_quote_trade`, `spectra_simulate_trade`, `spectra_get_pool_capacity`, `mv_check_ibt_health`, `spectra_get_pool_volume`/`spectra_get_pool_activity` (PT→pool resolution) |
| `GET /v1/{chain}/portfolio/{wallet}` | `spectra_get_portfolio`, `spectra_simulate_trade`, `spectra_get_address_activity` (expired pool discovery) |
| `GET /v1/{chain}/pools/{pool}/volume` | `spectra_get_pool_volume` |
| `GET /v1/{chain}/pools/{pool}/activity` | `spectra_get_pool_activity`, `spectra_get_address_activity` (active + expired pools) |
| `GET /v1/{chain}/metavaults` | `spectra_list_metavaults`, `spectra_model_metavault` (live mode) |
| `GET api.merkl.xyz/v3/userRewards?user={address}&chainId={chainId}` | `spectra_get_portfolio` (Merkl reward fetching — SPECTRA gauge emissions + incentive programs) |
| `GET api.merkl.xyz/v4/opportunities?chainId={chainId}` | `spectra_list_pools`, `spectra_get_pt_details`, `spectra_compare_yield`, `pendle_list_markets`, `mv_compare_yield`, `spectra_scan_opportunities`, `mv_scan_curator_opportunities`, `spectra_scan_yt_arbitrage` (Merkl campaign APR — 60s TTL cache) |
| `GET api.spectra.finance/v1/governance/voting-incentives` | `spectra_list_expiring_pools` (gauge status — pool address presence = gauge exists) |
| `GET app.spectra.finance/api/v1/spectra/circulating-supply` | `spectra_get_protocol_stats` |
| `GET app.spectra.finance/api/v1/spectra/total-supply` | `spectra_get_protocol_stats` |
| `POST api.morpho.org/graphql` | `morpho_list_markets`, `morpho_get_rate`, `spectra_get_looping_strategy` (auto-detect), `spectra_scan_opportunities` (batch) |
| `POST mainnet.base.org` (eth_call) | `spectra_get_ve_info`, `spectra_scan_opportunities`, `spectra_scan_yt_arbitrage`, `spectra_compare_yield` (veSPECTRA total supply) |
| `POST {chain RPC}` (eth_call: `get_dy`) | `spectra_quote_trade`, `spectra_simulate_trade`, `spectra_get_pool_capacity` (Curve StableSwap-NG on-chain quotes) |
| `POST {chain RPC}` (eth_call: `convertToAssets`) | `mv_check_ibt_health` (ERC-4626 IBT conversion rate health check) |
| `POST {chain RPC}` (eth_call: `eth_getCode`) | `spectra_get_pool_activity` (contract vs EOA detection in address mode) |
| `POST {chain RPC}` (eth_getLogs) | `spectra_get_onchain_activity` (historical Curve pool events + Spectra PT vault events — supports dynamic `rpc_url` override) |
| `GET api-v2.pendle.finance/core/v2/{chainId}/markets/active` | `pendle_list_markets` (Pendle market discovery) |
| `GET api-v2.pendle.finance/core/v2/{chainId}/markets/active` | `mv_compare_yield` (maturity-aware cross-protocol comparison) |
| `GET api-v2.pendle.finance/core/v2/{chainId}/markets/active` | `mv_scan_curator_opportunities` (cross-protocol capital-aware scanning — Spectra + Pendle) |

Note: `{chain}` uses the slug `mainnet` for Ethereum (the alias `ethereum` is accepted by the server and mapped automatically).

## Pendle Protocol Integration

13 Pendle tools provide **full feature parity** with the Spectra toolset, plus 2 cross-protocol tools for unified analysis:

### Pendle-Native Tools (13)

| Category | Pendle Tool | Spectra Equivalent |
|----------|------------|-------------------|
| Discovery | `pendle_list_markets` | `spectra_list_pools` |
| Discovery | `pendle_get_best_fixed_yields` | `spectra_get_best_fixed_yields` |
| Analysis | `pendle_get_market_details` | `spectra_get_pt_details` |
| Analysis | `pendle_get_market_capacity` | `spectra_get_pool_capacity` |
| Analysis | `pendle_get_yield_curve` | `spectra_get_yield_curve` |
| Portfolio | `pendle_get_portfolio` | `spectra_get_portfolio` |
| Strategy | `pendle_scan_opportunities` | `spectra_scan_opportunities` |
| Strategy | `pendle_scan_yt_arbitrage` | `spectra_scan_yt_arbitrage` |
| Strategy | `pendle_get_looping_strategy` | `spectra_get_looping_strategy` |
| Trading | `pendle_quote_trade` | `spectra_quote_trade` |
| Trading | `pendle_simulate_trade` | `spectra_simulate_trade` |
| Monitoring | `pendle_list_expiring_markets` | `spectra_list_expiring_pools` |
| Protocol | `pendle_get_protocol_stats` | `spectra_get_protocol_stats` |

### Cross-Protocol Tools (2)

**`mv_compare_yield`** — Side-by-side comparison on overlapping chains with **maturity-aware matching**. Normalizes underlying symbols (wstETH↔stETH, USDC.e↔USDC) and matches by nearest maturity within configurable tolerance (exact ≤7d, close ≤30d, loose ≤90d). Shows match quality and maturity gap per pair.

**`mv_scan_curator_opportunities`** — Cross-protocol capital-aware scanner for MetaVault curators. Scans both Spectra and Pendle in parallel, computes price impact at your capital size, effective APY after entry cost, Morpho looping availability (both Spectra and Pendle PTs), and tags cross-protocol matches.

### Pendle-Supported Chains

Overlapping with Spectra: Ethereum, Base, Arbitrum, Optimism, Sonic, BSC
Pendle-only: Mantle, Berachain, HyperEVM, Corn

### Key Differences from Spectra

- **AMM model**: Pendle uses a time-decay logit AMM (not Curve StableSwap). The capacity and quote tools use a conservative `scalarRoot=50` estimate.
- **YT trading**: Pendle YT trades directly on the AMM (`SY↔YT`). Spectra YT trades indirectly via Router flash-mint/redeem.
- **Incentives**: Pendle uses PENDLE token emissions + vePENDLE boosting (separate from Spectra's SPECTRA/veSPECTRA system).
- **Token wrapping**: Pendle uses SY (Standardized Yield) tokens as the pool asset, not IBT (Interest-Bearing Token) like Spectra.

## On-Chain Historical Activity

The Spectra REST API (`/v1/{network}/pools/{pool}/activity`) only retains a limited time window of recent transactions. When investigating addresses or pools with older activity, `spectra_get_onchain_activity` reads historical event logs directly from the blockchain via `eth_getLogs`.

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
- **No USD values**: On-chain logs don't carry prices — token amounts are shown in human-readable form. Cross-reference with `spectra_get_pt_details` for price context

Composability with existing tools:
```
Agent flow: spectra_get_pool_activity → empty? → spectra_get_onchain_activity(pool_address=...) → pool events
Agent flow: portfolio shows PT but no pool trades → spectra_get_onchain_activity(pt_address=...) → vault events (mint/redeem)
```

## Extending

### Following the Open Emergence Pattern

When adding new tools, follow the three-layer architecture:

1. **Description (Layer 2):** Teach any protocol mechanics that affect interpretation of the tool's data. Use "could be" language for ambiguous signals. Add cross-reference nudges to at least one related tool.
2. **Output (Layer 3):** If the data contains signals that require domain knowledge to notice (e.g., a ratio that implies a strategy, an event that could mean different things), compute a structured hint and include it in the output. Make it salient but not prescriptive. When an observable pattern has multiple valid interpretations, present them as competing branches with equal weight — do not pick one. Flag small sample sizes as statistically insufficient.
3. **Coverage (Layer 4):** If the tool's output covers only a subset of the address's or pool's full behavior, quantify the blind spots. Report value coverage (observable activity vs position size), temporal gaps, and which data sources were used vs available. End with a boundary marker: "Position sizing should assume this analysis is incomplete, not comprehensive." Coverage metrics bound ALL interpretation branches — high-confidence assessment + low coverage = false confidence.
4. **Resource (Layer 1):** If the new tool introduces fundamental protocol concepts not covered by existing resources, update `spectra-overview` in `index.ts`.
5. **Dissolution condition:** Document when the new structure would no longer serve, in `docs/dissolution-conditions.md`. Every Layer 3 hint, architectural pattern, and generative friction point carries a dissolution condition — a prompt for re-evaluation when circumstances change.

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
