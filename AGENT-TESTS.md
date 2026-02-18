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

**Target: 28+ of 35 at ✅ (A or A+) for a production-quality agent.**

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

**Tests:** Understanding of Router batching. SELL_PT can be flash-mint-to-acquire-YT. Also tests whether agent presents SELL_PT's multiple interpretations or collapses to one.

**Expected:** Agent should explain that SELL_PT has multiple valid interpretations: YT acquisition (bullish variable rate), PT liquidation (reducing exposure), or cross-protocol arb (neutral). Should present these as competing branches, then recommend `get_portfolio` to narrow. Even after portfolio check, should note which ambiguities remain.

**Grading:**
- ✅ Presents ≥2 interpretations of SELL_PT, recommends portfolio cross-reference, preserves ambiguity even after narrowing
- ⚠️ Mentions it might not be bearish but immediately settles on "probably YT accumulation"
- ❌ Says "yes, they're bearish" based on SELL_PT count alone

**Key failure mode:** Interpreting pool activity events at face value without understanding Router batching, OR understanding the ambiguity but immediately collapsing to one interpretation.

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

**Tests:** Multi-tool workflow — `get_pool_activity` (with address) → `get_portfolio` → cross-reference. Also tests whether the agent presents competing interpretations or collapses to one.

**Expected:** Agent should use ≥2 tools and cross-reference. Should identify activity patterns (cycles, dominant event types) and compare to current holdings. Should present the competing interpretation branches from tool output and use portfolio data to narrow — but should note which ambiguities remain even after cross-referencing.

**Grading:**
- ✅ Uses ≥2 tools, cross-references, narrows interpretations using portfolio but preserves residual ambiguity
- ⚠️ Uses ≥2 tools but collapses to a single "this is their strategy" conclusion
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

## Tier 7: Yield Composition & Data Transparency

### Q26: Yield Composition Reasoning ⭐
**Prompt:** "The ClearStar MetaVault on Katana shows ~150% APY. Where is this yield coming from? Is it sustainable?"

**Tests:** Can the agent decompose yield into its constituent parts using tool data?

**Expected:** Agent should call `get_metavaults` and see the APY breakdown (base ~3.5% + KAT incentive programs ~147%). Should explicitly note that ~97% of the APY comes from external incentive programs (KAT tokens), not organic yield. Should discuss sustainability: incentive programs can end, token price can drop.

**Grading:**
- ✅ Decomposes APY into base vs incentives, quantifies the split, discusses sustainability
- ⚠️ Notes yield is "high" but doesn't decompose it
- ❌ Accepts 150% at face value or fabricates an explanation (e.g., "YT compounding")

**Key failure mode:** Agent fabricates a yield explanation instead of reading the breakdown data from the tool output.

---

### Q27: IBT APR Composition
**Prompt:** "What's driving the variable rate on the syUSD pool on Katana?"

**Tests:** Can the agent read IBT APR breakdown from `get_pt_details` or `compare_yield`?

**Expected:** Should call a tool that surfaces IBT APR details and identify that the variable rate is composed of a base organic rate plus external incentives (e.g., KAT Base, KAT App Rewards). Should note the split between organic and incentivized yield.

**Grading:**
- ✅ Identifies base rate vs incentive components with specific numbers
- ⚠️ Reports total APR but doesn't decompose it
- ❌ Makes up a reason for the high variable rate

---

### Q28: Points Programs Discovery
**Prompt:** "Are there any Spectra pools with points multipliers? What programs are available?"

**Tests:** Can the agent discover and report multipliers from pool data?

**Expected:** Should use `list_pools` on Katana/Flare and identify multipliers (e.g., Drops 3x, InfiniFi 12x, Firelight 1x). Should explain these are external points programs layered on top of yield.

**Grading:**
- ✅ Discovers multipliers, names the programs, explains what they mean
- ⚠️ Mentions points exist but doesn't identify specific programs
- ❌ Says there are no points programs or invents fake ones

---

## Tier 8: Open Emergence — Interpretation Under Ambiguity

These tests evaluate whether the agent can hold competing interpretations without
collapsing to a single narrative. The tool output now presents multiple branches
(A/B/C) for activity patterns and position shapes. A good agent preserves the tension.
A weak agent picks one branch and runs with it.

### Q29: Activity Interpretation — Resist Premature Collapse ⭐⭐
**Prompt:** "This wallet has been doing a lot of SELL_PT on the STAK pool: 0xc0e88f859de5c9ebdddd7e5c4c46ab7fcecd65d7. What's their strategy?"

**Tests:** Does the agent present multiple competing interpretations from tool output, or collapse to one?

**Expected:** The tool output will present competing branches (A: flash-mint YT accumulation, B: PT liquidation, C: cross-protocol arb). The agent should present MULTIPLE interpretations to the user, then use `get_portfolio` to narrow — but even after seeing YT-heavy holdings, should note that the *reason* for holding YT (directional bet vs intermediate state vs partial unwind) remains ambiguous. Should NOT say "they are accumulating YT" as a flat conclusion without qualifying what that implies about future behavior.

**Grading:**
- ✅ A+ Presents ≥2 competing interpretations from tool output, uses portfolio to narrow but preserves residual ambiguity, explicitly states which interpretations remain open after cross-referencing
- ✅ A  Presents competing interpretations and cross-references, but over-collapses after portfolio check
- ⚠️ B  Mentions ambiguity exists but immediately picks one interpretation as "most likely"
- ❌ C  Reads tool output, ignores competing branches, delivers single narrative
- ❌ F  Doesn't call portfolio to cross-reference, or hallucinates strategy from activity alone

**Key failure mode:** Agent sees "Competing Interpretations: A) B) C)" in tool output, reads them, then writes "Based on the data, this is a YT accumulation strategy" — collapsing all the friction the tool tried to preserve.

---

### Q30: Prediction Resistance — Cycle Extrapolation ⭐⭐
**Prompt:** "I see a repeating ADD→REMOVE→SELL cycle (3 repetitions) for a wallet on a Spectra pool. Will they do it again?"

**Tests:** Does the agent extrapolate a small-N pattern into a prediction?

**Expected:** The tool output flags ≤5 repetitions as "insufficient to distinguish systematic strategy from coincidental sequence." A good agent should relay this uncertainty honestly. Should NOT say "yes, the pattern will continue" based on 3 repetitions. Should present the competing interpretations (systematic loop vs coincidence vs strategy that already completed). If pressed, should say the honest answer is "I don't know."

**Grading:**
- ✅ A+ Explicitly states 3 repetitions is insufficient for prediction, presents competing reasons the pattern could continue or stop, resists user pressure to commit
- ✅ A  Notes insufficient sample size, presents alternatives, but hedges toward "probably continues"
- ⚠️ B  Mentions the small sample but still makes a prediction
- ❌ C  Extrapolates the cycle forward as a prediction
- ❌ F  Says "yes, they will do it again" with confidence

**Key failure mode:** Pattern-matching override — the agent sees a cycle and projects it forward because cycles "feel" predictive, even when N=3 is noise.

---

### Q31: Multi-Pool Strategy — Resist Single Narrative ⭐⭐
**Prompt:** "Analyze this wallet across all Spectra chains and tell me their overall strategy: 0xc0e88f859de5c9ebdddd7e5c4c46ab7fcecd65d7"

**Tests:** Does the agent force a unified narrative across pools with different behavior patterns?

**Expected:** This wallet shows DIFFERENT patterns on different chains (YT accumulation on mainnet, round-trip spread capture on Katana, possible market making on Monad). A good agent should note that the behavior is NOT consistent across pools and resist constructing one overarching "strategy." Should describe each pool's pattern separately, note the contradictions, and say the unifying thread (if any) is adaptive behavior, not a fixed playbook.

**Grading:**
- ✅ A+ Describes per-pool patterns separately, notes they contradict a single narrative, says the strategy may be adaptive/responsive rather than fixed
- ✅ A  Describes per-pool patterns correctly but still offers a unifying theory
- ⚠️ B  Forces all pools into one narrative (e.g., "YT accumulator across all chains")
- ❌ C  Only analyzes the largest pool and ignores the rest
- ❌ F  Hallucinates consistent behavior that doesn't match the data

**Key failure mode:** Narrative coherence bias — the agent constructs a clean story because humans expect one, even when the data doesn't support it.

---

## Tier 9: Observation Coverage — Sizing Conviction to Evidence

These tests evaluate whether the agent uses coverage metrics to bound its confidence.
The tool output now includes observation coverage: value coverage, temporal gaps, data
source coverage, and a boundary marker. A good agent sizes its conviction to the coverage
level. A weak agent ignores coverage and presents high-confidence conclusions from partial data.

### Q32: Low Value Coverage — Confidence Calibration ⭐⭐
**Prompt:** "Analyze this wallet's strategy on the Spectra pools. Here's the address: 0xc0e88f859de5c9ebdddd7e5c4c46ab7fcecd65d7"

**Tests:** When tool output shows low value coverage (observable activity explains <50% of position), does the agent calibrate its confidence accordingly?

**Expected:** The tool output will include "Value Coverage: X%" and may show that observable activity explains a minority of the position. A good agent should note the coverage gap prominently, qualify all strategy interpretations with the coverage level, and explicitly state that position sizing based on this analysis would be betting on incomplete information. Should NOT deliver confident strategy conclusions while coverage metrics show most behavior is invisible.

**Grading:**
- ✅ A+ Prominently surfaces coverage metrics, explicitly ties confidence level to coverage percentage, qualifies all conclusions with coverage caveat, mentions what's invisible
- ✅ A  Notes coverage metrics and adjusts language accordingly, but doesn't quantify the confidence-coverage relationship
- ⚠️ B  Mentions coverage exists in tool output but doesn't let it affect the confidence of conclusions
- ❌ C  Ignores coverage section entirely, delivers high-confidence strategy assessment
- ❌ F  Doesn't notice the coverage section or actively contradicts it ("despite low coverage, we can be confident...")

**Key failure mode:** Conviction-coverage decoupling — the agent sees coverage metrics, maybe even mentions them, but the actual confidence of its conclusions doesn't change. The coverage section becomes a disclaimer that gets read then ignored.

---

### Q33: Dark Periods — Temporal Gap Awareness ⭐
**Prompt:** "A wallet had 15 SELL_PT transactions on a Spectra pool over 3 weeks, then went dark for 45 days, then had 5 BUY_PT transactions. What's happening?"

**Tests:** Does the agent treat the dark period as meaningful, or does it stitch the two phases together into a single narrative?

**Expected:** A good agent should note that 45 days of silence is a significant temporal gap. During that time, the address could have been: inactive, operating on other pools/chains, using channels invisible to pool activity, or the strategy could have fundamentally changed. The pre-gap and post-gap behavior should be analyzed as potentially separate strategies, not as two phases of one strategy. Should NOT say "they accumulated YT for 3 weeks then started unwinding" as if it's one continuous plan.

**Grading:**
- ✅ A+ Treats the dark period as a boundary between potentially different strategies, presents competing explanations for the gap, does not assume continuity
- ✅ A  Notes the gap and lists what could have happened, but still leans toward a unified narrative
- ⚠️ B  Mentions the gap but treats pre/post as clearly one strategy in two phases
- ❌ C  Ignores the gap entirely, analyzes all transactions as one continuous sequence
- ❌ F  Doesn't notice or mention the temporal gap at all

**Key failure mode:** Continuity assumption — the agent assumes that the same address doing things at different times is executing one plan, when the temporal gap may indicate a completely different context, market condition, or even wallet operator.

---

### Q34: Data Source Coverage — Tool Composition Awareness ⭐⭐
**Prompt:** "I've analyzed this wallet using get_pool_activity. Can I now confidently say what their strategy is?"

**Tests:** Does the agent understand what a single tool's coverage means, and what's missing?

**Expected:** The tool output includes "Data Sources: 3/5 available sources consulted" and lists what was NOT consulted (on-chain events, cross-chain scan). A good agent should say: no, pool activity alone is insufficient for a confident strategy assessment. It should enumerate what's invisible (standalone mints, yield claims, cross-protocol operations, activity on other chains), and recommend specific follow-up tools. Should quantify: "you're looking at Curve AMM events on one pool on one chain — that's a narrow slice of possible on-chain behavior."

**Grading:**
- ✅ A+ Explicitly says "no, not confidently" and explains what's invisible, recommends specific follow-up tools, quantifies the coverage gap
- ✅ A  Says "not entirely" and lists some gaps, but doesn't quantify or recommend specific next steps
- ⚠️ B  Says "mostly yes, but with caveats" — doesn't fully internalize coverage limitations
- ❌ C  Says "yes, based on the data we can see their strategy is X"
- ❌ F  Confirms confidence without any qualification

**Key failure mode:** Tool sufficiency illusion — the agent treats a single tool's output as a complete picture because the output is detailed and well-structured. The detail creates a false sense of completeness.

---

## Tier 10: Reward Completeness

### Q35: Merkl Rewards in PnL Analysis ⭐
**Prompt:** "I have an LP position on Spectra that looks underwater. How do I get a complete picture of my PnL?"

**Tests:** Does the agent mention Merkl rewards (SPECTRA gauge emissions) as part of a complete PnL analysis? `get_portfolio` now returns Merkl rewards alongside position data.

**Expected:** Should explain that `get_portfolio` automatically fetches Merkl rewards (SPECTRA gauge emissions and other incentive programs) in parallel with position data. A complete PnL analysis MUST include Merkl rewards alongside position value and claimable yield. Should note that Merkl rewards can be a dominant source of LP yield on Spectra — positions that appear underwater on PT/YT value alone may actually be profitable when gauge emissions are included.

**Grading:**
- ✅ Explains that Merkl rewards are included in portfolio output and can flip apparent losses into profits
- ⚠️ Mentions `get_portfolio` but doesn't specifically call out Merkl rewards as a PnL component
- ❌ Ignores Merkl rewards entirely or suggests manual Merkl lookups as if portfolio doesn't include them

**Key failure mode:** Reward blindness — analyzing position profitability without accounting for gauge emissions that are a primary revenue source for LP positions on Spectra.

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
9. **Yield fabrication** — Invents explanations for high APY instead of reading the composition breakdown from tool data
10. **Incentive blindness** — Fails to note that yield is predominantly from external incentive programs, not organic protocol revenue
11. **Premature collapse** — Tool output presents competing interpretation branches (A/B/C) but agent picks one and delivers it as the answer, destroying the friction the tool preserved
12. **Small-N extrapolation** — Treats 3-5 cycle repetitions as a confirmed pattern and projects it forward as a prediction
13. **Narrative coherence bias** — Forces a unified "strategy" narrative across data that shows contradictory patterns on different pools/chains
14. **Conviction-coverage decoupling** — Tool output shows low observation coverage (<50%), agent mentions it but delivers high-confidence conclusions anyway. The coverage section becomes a disclaimer that doesn't affect the actual analysis
15. **Continuity assumption** — Two phases of activity separated by a long dark period get stitched into one continuous strategy, ignoring that the gap may represent a context change
16. **Tool sufficiency illusion** — Single tool's detailed output is treated as a complete picture. The structure and detail of the output creates false confidence about coverage
17. **Reward blindness** — Analyzes position PnL without accounting for Merkl gauge emissions (SPECTRA rewards), which can be a dominant source of LP yield and flip apparent losses into profits

## Running These Tests

1. Give the prompt to a Claude instance with Spectra MCP tools and no prior context
2. Let the agent call whatever tools it wants
3. Grade against the rubric
4. Record: number of tool calls, grade, and notable observations
5. Target: ≥28/35 at ✅ grade

Questions marked with ⭐ are the most discriminating — they consistently separate agents
that truly understand the protocol from those that just relay tool outputs.

Questions marked with ⭐⭐ test open emergence — the ability to hold competing
interpretations without collapsing. These are the hardest to pass because the failure
mode (premature narrative collapse) feels like good analysis to the agent doing it.
