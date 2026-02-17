# Spectra MCP Server — Agent Reasoning Test Suite

Subjective tests that require an LLM to evaluate. Run these by giving the question
to a Claude (or other LLM) instance with access to the Spectra MCP tools and no other
context. Grade the response against the rubric.

Companion to `test-agent.cjs` (automated multi-tool workflow tests).

---

## Scoring

| Grade | Meaning |
|-------|---------|
| ✅ A+ | Perfect — deep protocol understanding, multi-tool cross-reference, appropriate caveats |
| ✅ A  | Strong — correct reasoning, good tool usage, minor gaps |
| ⚠️ B  | Adequate — gets the basics right but misses nuance or doesn't cross-reference |
| ❌ C  | Weak — parrots tool output without interpreting, or misuses tools |
| ❌ F  | Fails — hallucinates data, gives dangerous advice, or fundamentally misunderstands protocol |

**Target: 20+ of 25 at ✅ (A or A+) for a production-quality agent.**

---

## Tier 1: Basic Tool Usage & Fact Retrieval

### Q1: Supported Chains
**Prompt:** "What chains does Spectra support?"

**Tests:** Can the agent call `get_supported_chains`?

**Expected:** Lists all 10 chains (Ethereum/mainnet, Base, Arbitrum, Optimism, Avalanche, Katana, Sonic, Flare, BSC, Monad). Should NOT hallucinate chains.

**Grading:**
- ✅ All 10 correct
- ❌ Invents chains or misses any

---

### Q2: Highest Fixed Yield (Anomaly Detection)
**Prompt:** "What's the highest fixed-rate yield available on Spectra right now? Should I invest in it?"

**Tests:** `get_best_fixed_yields` usage. Does the agent flag anomalous extreme APYs?

**Expected:** The raw #1 result will likely be an anomalous pool (extreme APY with tiny liquidity). A good agent should immediately flag this as suspect — check liquidity, maturity, and IBT health. Should recommend the real highest-quality opportunity instead.

**Grading:**
- ✅ Flags the anomaly AND recommends the next real opportunity
- ⚠️ Mentions the top result but doesn't critically assess it
- ❌ Recommends the anomalous pool uncritically

**Key failure mode:** Agent reports extreme APY at face value without checking liquidity or maturity.

---

### Q3: Pool Count
**Prompt:** "How many active pools are on Ethereum mainnet?"

**Tests:** `list_pools` with correct chain parameter.

**Expected:** Returns the current count of active mainnet pools.

**Grading:**
- ✅ Correct count from tool call
- ❌ Wrong count or fails to call the tool

---

### Q4: MetaVault Discovery
**Prompt:** "What MetaVaults exist on Spectra?"

**Tests:** `get_metavaults` usage.

**Expected:** Lists all MetaVaults with curator names, chains, TVLs, and live APYs.

**Grading:**
- ✅ All MetaVaults identified with key stats
- ❌ Invents MetaVaults or misses existing ones

---

## Tier 2: Cross-Tool Reasoning

### Q5: Capital-Aware Opportunity Selection
**Prompt:** "I have $50,000 to deploy into Spectra. What's the best opportunity?"

**Tests:** Does agent use `scan_opportunities` (capital-aware) vs `get_best_fixed_yields` (raw APY)?

**Expected:** Should use `scan_opportunities(capital_usd=50000)` because price impact matters at $50K. Should discuss effective APY after entry cost. Should NOT just report raw APY rankings.

**Grading:**
- ✅ Uses capital-aware tool, discusses price impact and effective APY
- ⚠️ Uses only raw APY tool
- ❌ Hallucinates numbers or ignores liquidity constraints

---

### Q6: Cross-Protocol Comparison
**Prompt:** "Compare the STAK pool on mainnet to the same asset on Pendle."

**Tests:** `compare_pendle_spectra` or manual cross-referencing.

**Expected:** Should note that Spectra and Pendle have the same underlying (yn-RWA/USD) but VERY different maturities. A good agent catches this maturity mismatch and explains they aren't directly comparable on a like-for-like basis.

**Grading:**
- ✅ Catches the maturity mismatch AND explains it affects comparison validity
- ⚠️ Compares APYs without noting the maturity gap
- ❌ Says one is "better" without context

---

### Q7: Morpho Looping Availability
**Prompt:** "Is there a Morpho looping opportunity for the STAK PT on mainnet?"

**Tests:** `get_looping_strategy` or `get_morpho_markets` check.

**Expected:** Should clearly state whether a Morpho market exists. Should NOT hallucinate a looping strategy if no market is available.

**Grading:**
- ✅ Correctly identifies market availability (or lack thereof)
- ❌ Fabricates a looping strategy when no market exists

---

### Q8: Trade Simulation
**Prompt:** "What would my portfolio look like if I bought $500 of STAK PT on mainnet?"

**Tests:** `simulate_portfolio_after_trade` usage.

**Expected:** Should call the tool with correct parameters (needs a wallet address — should ask for one or use a zero address for new position). Should discuss price impact and effective APY.

**Grading:**
- ✅ Asks for wallet or runs simulation, discusses impact
- ❌ Makes up numbers without calling the tool

---

## Tier 3: Protocol Mechanics Traps

### Q9: Router Batching — SELL_PT Interpretation ⭐
**Prompt:** "I see a wallet with many SELL_PT transactions on a Spectra pool. Is this person bearish on the protocol?"

*(For a specific test, use a known active address from `get_pool_activity` output.)*

**Tests:** Understanding of Router batching. SELL_PT can be flash-mint-to-acquire-YT.

**Expected:** Agent should explain that SELL_PT could be YT acquisition (not bearishness). Should recommend checking `get_portfolio` to see if YT >> PT (confirming mint-and-sell loop). Should cross-reference activity with holdings.

**Grading:**
- ✅ Explains Router batching ambiguity AND recommends portfolio cross-reference
- ⚠️ Mentions it might not be bearish but doesn't cross-reference
- ❌ Says "yes, they're bearish" based on SELL_PT count alone

**Key failure mode:** Interpreting pool activity events at face value without understanding Router batching.

---

### Q10: Direct YT Trading
**Prompt:** "Can I buy YT directly on the Spectra pool?"

**Tests:** Core protocol knowledge — YT does NOT trade on the Curve pool.

**Expected:** No. YT is acquired by minting (deposit IBT → PT+YT) or via the Router's flash-mint mechanism. The pool only trades IBT ↔ PT.

**Grading:**
- ✅ Correctly explains YT cannot be bought on the pool directly
- ❌ Says "yes, buy YT on the pool"

---

### Q11: PT/YT Math
**Prompt:** "If PT + YT = 1 underlying at maturity, and the PT price is $0.89, what's the YT worth?"

**Tests:** Basic PT/YT identity math.

**Expected:** YT price ≈ $0.11 in underlying terms. A sophisticated agent may note the IBT rate nuance (PT+YT = 1 IBT, and 1 IBT > 1 underlying if it has accumulated yield).

**Grading:**
- ✅ Gives ~$0.11 and ideally notes the IBT rate nuance
- ⚠️ Gives ~$0.11 without nuance
- ❌ Gets the math wrong

---

### Q12: Mint Visibility in Pool Activity
**Prompt:** "A mint operation shows up in pool activity as AMM_ADD_LIQUIDITY. Explain why."

**Tests:** Router batching understanding.

**Expected:** A standalone mint does NOT appear in pool activity. However, the Router can batch mint + LP add atomically: minted PT + remaining IBT enter the pool as AMM_ADD_LIQUIDITY. The mint is invisible; only the LP portion shows.

**Grading:**
- ✅ Explains batched mint+LP mechanism correctly
- ❌ Says "mints always show as ADD_LIQUIDITY"

---

## Tier 4: Risk & Nuance

### Q13: MetaVault Risk Assessment ⭐
**Prompt:** "The Clearstar MetaVault on Katana shows 150% APY. Should I put all my savings ($50,000) into it?"

**Tests:** Risk awareness and critical thinking.

**Expected:** Should flag multiple risk factors: vault age, chain maturity, composability stack depth, curator risk, bridge token dependency, async redemptions, expired positions. Should calculate or note that realized yield may differ from projected APY. Should NOT recommend uncritically.

**Grading:**
- ✅ Raises ≥3 risk factors AND provides calibration (e.g., realized vs projected, comparison to other vaults)
- ⚠️ Mentions some risks but still recommends
- ❌ Recommends uncritically based on APY number

---

### Q14: Extreme APY Skepticism
**Prompt:** "The sw-mevUSDC pool on Avalanche shows 469 million percent APY. Is this real?"

**Tests:** Anomaly detection, critical thinking about displayed data.

**Expected:** Almost certainly not investable. Check: tiny liquidity, near-maturity, extreme PT discount, IBT base APR showing billions of percent. Should identify as calculation artifact, depeg, or broken IBT.

**Grading:**
- ✅ Flags as anomaly/broken with specific evidence
- ❌ Takes the number at face value

---

### Q15: Looping Risk
**Prompt:** "I'm considering the Morpho looping strategy. What happens if borrow rates spike above my fixed yield?"

**Tests:** Understanding of leveraged position risk.

**Expected:** Net APY goes negative. At leverage, losses are amplified. Should give a numeric example (e.g., 7% yield × 3x - 12% borrow × 2x = -3%). Should mention liquidation risk.

**Grading:**
- ✅ Explains amplified loss mechanics with example
- ❌ Says "you just earn less"

---

### Q16: MetaVault Bridge Activity
**Prompt:** "The Gami MetaVault has been bridging funds between Base and Avalanche. What's going on?"

**Tests:** Interpreting MetaVault bridge transaction data.

**Expected:** The vault is deployed on Base but allocates capital to Avalanche Spectra pools via CCTP bridge. Should note the direction (mostly Base→Avalanche) and interpret recent reverse flows as potential rebalancing.

**Grading:**
- ✅ Correctly interprets cross-chain capital deployment pattern
- ❌ Confused about why a Base vault would bridge to Avalanche

---

## Tier 5: Multi-Step Analytical Questions

### Q17: Wallet Strategy Analysis ⭐
**Prompt:** "Analyze wallet [ADDRESS] and tell me their strategy on the [POOL_NAME] pool."

*(Use a real address from `get_pool_activity` output.)*

**Tests:** Multi-tool workflow — `get_pool_activity` (with address) → `get_portfolio` → cross-reference.

**Expected:** Agent should use ≥2 tools and cross-reference. Should identify activity patterns (cycles, dominant event types) and compare to current holdings. Should make a strategy inference (accumulator, LP provider, looper, etc.).

**Grading:**
- ✅ Uses ≥2 tools, cross-references, makes supported inference
- ⚠️ Uses only 1 tool, doesn't cross-reference
- ❌ Just reports activity counts without interpreting

---

### Q18: veSPECTRA Boost Calculation
**Prompt:** "If I have 1 million veSPECTRA and want to deposit $1000, which pools give me full 2.5x boost?"

**Tests:** veSPECTRA boost math — B = min(2.5, 1.5 × (v/V) × (D/d) + 1).

**Expected:** Should calculate the TVL threshold where boost maxes out. With v=1M, V≈171M, d=$1000: need TVL ≥ ~$171K for full boost. Should identify which current pools qualify.

**Grading:**
- ✅ Does the math, identifies qualifying pools
- ⚠️ Reports boost values without showing the threshold calculation
- ❌ Says "you get max boost everywhere" without checking

---

### Q19: YT Arb vs LP Strategy Comparison
**Prompt:** "Compare the YT arbitrage opportunity on the STAK pool vs just LPing with max boost."

**Tests:** Multi-strategy comparison requiring `compare_yield` and `scan_yt_arbitrage`.

**Expected:** Should compare: YT arb (speculative, leveraged, bet on variable rates staying high) vs LP (trading fees + gauge emissions, more predictable, benefits from veSPECTRA boost). Should discuss risk/reward tradeoffs.

**Grading:**
- ✅ Compares both strategies with quantified pros/cons
- ❌ Only analyzes one strategy

---

### Q20: Negative Implied APY
**Prompt:** "A pool shows negative implied APY. What does this mean and should I interact with it?"

**Tests:** Understanding of PT premium/discount mechanics.

**Expected:** PT is trading ABOVE underlying value (premium). Buyer would lose money at maturity. Usually indicates extreme illiquidity or broken AMM pricing. Should recommend avoiding.

**Grading:**
- ✅ Explains premium = negative yield AND flags illiquidity
- ❌ Confused by negative APY

---

## Tier 6: Edge Cases & Gotchas

### Q21: Katana RPC Requirement
**Prompt:** "Get me on-chain activity for a wallet on Katana."

**Tests:** Chain-specific knowledge — Katana has no default RPC.

**Expected:** Agent should either provide the RPC URL (`rpc_url="https://rpc.katana.network"`) or ask for one.

**Grading:**
- ✅ Provides or asks for RPC URL
- ❌ Tries without RPC and errors silently

---

### Q22: Expired Pool Discovery ⭐
**Prompt:** "Show me all expired pools that wallet [ADDRESS] interacted with."

**Tests:** Understanding that `list_pools` doesn't return expired pools, but `get_portfolio` does.

**Expected:** Should use `get_portfolio` (which returns expired positions) or `get_address_activity` (which internally fetches portfolio). Should NOT try `list_pools(include_expired=True)` and expect results.

**Grading:**
- ✅ Uses `get_portfolio` or `get_address_activity`, explains limitation
- ⚠️ Uses the right tool but doesn't explain why `list_pools` won't work
- ❌ Tries `list_pools` for expired data

---

### Q23: Router Limitation on On-Chain Filtering ⭐
**Prompt:** "Filter on-chain logs for my wallet [ADDRESS] on the STAK pool."

**Tests:** Understanding the Router limitation with `get_onchain_activity` address filtering.

**Expected:** Should warn that `get_onchain_activity` with address filter only catches direct calls, NOT Router-batched operations. Should recommend `get_pool_activity` (API-based) instead.

**Grading:**
- ✅ Explains Router limitation AND recommends API-based alternative
- ⚠️ Uses API tool correctly but doesn't explain why
- ❌ Runs on-chain filter without caveats

---

### Q24: Expired MetaVault Position
**Prompt:** "The Gami MetaVault has an expired position. Is this a problem?"

**Tests:** Understanding expired positions in MetaVaults.

**Expected:** Not necessarily a problem — expired PT redeems 1:1. Curator needs to roll into new pool. If the expired position is small (dust), it's minor. If large and not rolled promptly, could indicate poor management. Should suggest checking curator activity.

**Grading:**
- ✅ Contextualizes correctly, mentions rollover need
- ❌ Panics about it OR ignores it entirely

---

### Q25: Tool Ranking Disagreement ⭐
**Prompt:** "I ran get_best_fixed_yields and scan_opportunities with $10,000 and they gave different rankings. Which is right? Is one broken?"

**Tests:** Understanding intentional tool disagreement.

**Expected:** Both are "right" — they measure different things. `get_best_fixed_yields` = raw headline APY. `scan_opportunities` = effective APY after capital-sized price impact. Should give concrete examples showing how the same pool ranks differently. Should say "use both to develop conviction."

**Grading:**
- ✅ Explains the distinction clearly with examples
- ⚠️ Notes they differ but doesn't explain why
- ❌ Says one is "better" or "broken"

---

## Key Failure Modes to Watch For

1. **Parrot mode** — Agent repeats tool output verbatim without interpreting
2. **Hallucination** — Invents Morpho markets, pools, or strategies that don't exist
3. **Router blindness** — Interprets SELL_PT as always bearish, BUY_PT as always bullish
4. **Anomaly blindness** — Reports extreme APYs without questioning them
5. **Wrong tool** — Uses `list_pools(include_expired=True)` expecting expired data, or `get_onchain_activity` with address filter for Router-mediated activity
6. **No cross-referencing** — Analyzes wallet activity without checking portfolio, or vice versa
7. **Risk blindness** — Recommends high-APY vaults without discussing composability risk, chain maturity, or curator dependency
8. **Inconsistent skepticism** — Flags risks on one vault but not another with similar risk profile

## Running These Tests

1. Give the prompt to a Claude instance with Spectra MCP tools and no prior context
2. Let the agent call whatever tools it wants
3. Grade against the rubric
4. Record: number of tool calls, grade, and notable observations
5. Target: ≥20/25 at ✅ grade

Questions marked with ⭐ are the most discriminating — they consistently separate agents
that truly understand the protocol from those that just relay tool outputs.
