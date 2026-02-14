# Architecture Review: Agentic Accessibility

## Scope

A thorough review of the spectra-mcp-server architecture through the lens of the
Open Emergence design principles (recursive-meta-process.md, dissolution-conditions.md)
with the specific question: **what would make this server more accessible to autonomous
agents?**

"Agentic accessibility" means: can an agent with zero prior knowledge arrive, orient,
and compose multi-tool workflows without human hand-holding? Not just "can it call the
tools" — but "can it figure out WHICH tools to call, in WHAT order, and WHAT to do when
it hits a dead end?"

---

## Part 1: What the Architecture Gets Right

### The Three-Layer Model Works

The progressive disclosure pattern (context → descriptions → output hints) is well-suited
to how agents actually work. An agent exploring the tool list reads Layer 2 descriptions
and gets enough mechanics to start. Layer 3 hints in output create discovery moments that
lead to follow-up queries. This is not obvious — most MCP servers just expose raw data
and hope the agent figures it out.

### Generative Friction Is Real

The `get_best_fixed_yields` (raw APY) vs `scan_opportunities` (effective APY) disagreement
is genuinely productive. In testing, agents that encounter both tools develop richer
reasoning about "what does best mean at my capital size?" This should be preserved.

### "Could Be" Language Prevents Premature Closure

Tool descriptions like "SELL_PT could be a flash-mint to acquire YT" teach mechanics
without prescribing conclusions. This is the right call — agents that receive
deterministic labels ("this IS a YT acquisition") stop reasoning. Agents that receive
possibilities keep exploring.

### Promise.allSettled Resilience Is Agent-Compatible

Cross-chain scans that return partial results (with failed chains noted) are better for
agents than all-or-nothing failures. An agent can work with 8/10 chains and note the gaps.
This pattern should be extended to more tools.

### Capital-Aware Metrics Solve a Real Agent Problem

Raw APY rankings are misleading for capital-deployed agents. `scan_opportunities`
computing price impact at YOUR capital size is the single most agent-relevant feature.
Without it, an agent sees "50% APY" on a $10K liquidity pool and wastes its principal
learning why the trade failed.

---

## Part 2: Structural Issues Limiting Agentic Accessibility

### Issue 1: Tools Are Islands — The Cross-Reference Network Has Gaps

The design principle says "every tool cross-references at least one other tool." This is
mostly true in descriptions, but the OUTPUTS don't carry forward. An agent calling
`get_pt_details` gets rich data about a PT but no structured pointer saying "here are
your logical next steps with this data."

**Current state of cross-references in output (not descriptions):**

| Tool | Output cross-references | Missing |
|------|------------------------|---------|
| `get_pt_details` | None in output | compare_yield, get_looping_strategy, get_pool_activity |
| `list_pools` | None in output | get_pt_details on interesting pools |
| `get_best_fixed_yields` | Footer disclaimer about scan_opportunities | No per-pool next-step |
| `get_portfolio` | Portfolio hints mention Morpho availability | No specific tool call with params |
| `get_pool_volume` | None in output | get_pool_activity for detail |
| `get_morpho_markets` | None in output | get_morpho_rate, get_looping_strategy |
| `compare_yield` | None in output | get_looping_strategy, quote_trade |
| `scan_opportunities` | Description mentions drill-down tools | No per-opportunity next-step |
| `scan_yt_arbitrage` | None in output | Execution mechanics unclear |
| `get_ve_info` | None in output | How boost affects scan_opportunities results |

The descriptions teach cross-references well — but descriptions are only read once. The
output is read every time. An agent that called `get_pt_details` three calls ago has
already forgotten the description cross-references. The output needs to remind it.

**Dissolution condition**: This gap dissolves if agents develop persistent memory of tool
descriptions across sessions. Currently they don't — each tool call is a fresh context
consumption.

### Issue 2: Dead-End Workflows — Four Common Agent Paths That Strand

**Dead End A: Discovery → Details → ???**
```
list_pools → pick interesting pool → get_pt_details → rich data → ...what now?
```
Agent has APY, TVL, liquidity but no guidance on whether to compare yields, check
looping, or move to a different pool. The description says "use compare_yield" but by
this point the agent has consumed the description 2 calls ago.

**Dead End B: Portfolio → Morpho Flags → Manual Dispatch**
```
get_portfolio → sees "Morpho markets exist for: PT-ibUSDC" → ...how to act on this?
```
The portfolio surfaces that looping is POSSIBLE but doesn't provide the chain + pt_address
needed to call `get_looping_strategy`. The agent must re-find the PT address from the
portfolio output (it's there, but buried in position details).

**Dead End C: Opportunity Found → No Execution Path**
```
scan_opportunities → #1 ranked: 28.5% net APY via looping → ...execute how?
```
Agent has the opportunity ranked but no checklist: quote the trade, simulate portfolio
impact, verify Morpho liquidity, check gas costs. Each of these requires a separate tool
call with parameters the agent must extract from the scan output.

**Dead End D: Activity Pattern → No Strategy Inference**
```
get_pool_activity(address=whale) → cycle detected: ADD→REMOVE→SELL × 12 → ...so what?
```
Output says "could indicate mint→LP→unwind loop" — correctly using "could be" language.
But the agent has no structured path to verify: check portfolio for resulting position,
check if this pattern is profitable, compare to alternative strategies.

### Issue 3: Three Discovery Entry Points, No Meta-Router

An agent facing the tool list sees three ways to find opportunities:
1. `get_best_fixed_yields` — raw APY, all chains
2. `scan_opportunities` — effective APY, capital-aware
3. `scan_yt_arbitrage` — YT spread opportunities

There's no guidance on WHEN to use each. The description of `scan_opportunities` says
"unlike get_best_fixed_yields..." but an agent must read both descriptions to understand
the distinction. A meta-tool or enhanced `get_protocol_context` topic could route agents
based on their goal.

This is NOT the same as the raw-vs-effective generative friction (which should stay). The
issue is that agents don't know which CATEGORY of opportunity they're seeking until they
understand the distinction — and they can't understand the distinction without calling
both tools and comparing results.

### Issue 4: Negative Signals Are Incomplete

The server does well at surfacing when data IS present (Layer 3 hints). It's weaker at
surfacing when data is ABSENT and what that absence means.

**Current negative signals (good):**
- Portfolio: "No Morpho markets found" for positions
- Portfolio: Expired positions aggregate with unclaimed value
- scan_opportunities: Negative-APY opportunities filtered out (with parameter guidance)
- get_pool_activity: "No activity found for address — Router operations are invisible"

**Missing negative signals:**
- `get_looping_strategy` with no Morpho market: returns default LTV warning but doesn't
  suggest alternatives ("can't loop this PT — consider compare_yield for unleveraged
  analysis, or scan_opportunities for loopable alternatives")
- `get_morpho_markets` returning zero results for a chain: says "No markets found" but
  doesn't tell agent which chains DO have Morpho markets
- `quote_trade` with high impact (>5%): shows the number but doesn't say "this impact
  level is unusual — check pool liquidity via get_pool_volume, or try smaller size"
- `scan_yt_arbitrage` with zero opportunities: says "no opportunities" but doesn't
  suggest that spreads are currently tight and to check back later, or try
  scan_opportunities for PT-based yields instead

### Issue 5: The get_protocol_context Tool Is Underleveraged

`get_protocol_context` has 5 topics: pt_yt_mechanics, router_batching, position_analysis,
looping, networks. These are good but static. The tool could serve as the agent's
NAVIGATION SYSTEM — not just mechanics reference, but workflow routing.

Currently there's no topic for:
- "What tool should I use for X goal?" (workflow routing)
- "How do the discovery tools differ?" (meta-awareness)
- "What are common multi-tool workflows?" (composition patterns)

---

## Part 3: Feature Proposals — Ranked by Agentic Impact

Each proposal includes the Open Emergence alignment (which design principle it serves),
the agentic accessibility gain, and a dissolution condition.

**Implementation status:**
- Feature 1 (Next-Step Hints): **IMPLEMENTED** — all 12 tool files updated
- Feature 2 (Workflow Routing): **IMPLEMENTED** — `workflow_routing` topic in context.ts
- Feature 3 (Negative Signals): **IMPLEMENTED** — across looping, morpho, quote, strategy, yt_arb
- Feature 4 (Unified Discovery): Not implemented (deferred — workflow routing covers most of this)
- Feature 5 (Portfolio Looping Enrichment): **IMPLEMENTED** — `include_looping_analysis` parameter
- Features 6-8: Not yet implemented

### Feature 1: Next-Step Hints in Tool Output [IMPLEMENTED]

**What**: Add structured "next step" suggestions to tool outputs — not prescriptive
commands, but mechanics-aware pointers.

**Example (get_pt_details output, after the data block):**
```
--- Next Steps ---
• Compare fixed vs variable: compare_yield on this PT
• Check leverage potential: get_looping_strategy (requires Morpho market for this PT)
• See trading patterns: get_pool_activity on pool 0x...
• Capital-aware ranking: scan_opportunities to see where this PT ranks at your size
```

**Example (get_portfolio output, when Morpho flag is true):**
```
--- Looping Opportunities ---
• PT-ibUSDC (base, 0x1234...): Morpho market available
  → get_looping_strategy(chain="base", pt_address="0x1234...")
• PT-wstETH (mainnet, 0x5678...): No Morpho market (can't loop)
  → compare_yield(chain="mainnet", pt_address="0x5678...") for unleveraged analysis
```

**Example (scan_opportunities output, per-opportunity):**
```
#1: PT-ibUSDC on Base — 28.5% net APY (3x looping)
  [...existing data...]
  → Deep dive: get_looping_strategy(chain="base", pt_address="0x1234...")
  → Quote entry: quote_trade(chain="base", pt_address="0x1234...", amount=..., side="buy")
  → Preview impact: simulate_portfolio_after_trade(...)
```

**Open Emergence alignment**: This is Layer 3 (structured output hints). It doesn't
prescribe conclusions — it teaches the agent what tools COULD be relevant, using the same
"here are your options" pattern that the cross-references in descriptions already use.
The agent still decides which path to take.

**Key design constraint**: Next-step hints should use "could" language and present
OPTIONS, not a single recommended path. Presenting a single "do this next" would
calcify the workflow. Presenting 3-4 options preserves the agent's autonomy.

**Dissolution condition**: When agents develop persistent tool-graph memory (remembering
cross-references from descriptions across multiple calls), output-level next steps
become redundant. Also dissolves if agents start ignoring the hints and following their
own cross-reference patterns — that would mean the hints are scaffolding that's no
longer needed.

---

### Feature 2: Workflow Routing Topic in get_protocol_context [IMPLEMENTED]

**What**: Add a new topic `"workflow_routing"` to `get_protocol_context` that maps agent
goals to tool sequences — not as prescriptions, but as common patterns.

**Content:**
```
Workflow Patterns (how tools compose)

Goal: "Find the best yield for my capital"
  Start: scan_opportunities(capital_usd=YOUR_AMOUNT)
  This computes price impact at your size, effective APY, and Morpho looping.
  Different from get_best_fixed_yields (raw APY, no capital awareness).
  The two tools intentionally disagree on "best" — raw APY vs effective APY are
  different questions. Both are valid depending on your assumptions.

Goal: "Analyze a wallet's strategy"
  Start: get_portfolio(address) → see position shapes
  Then: get_pool_activity(chain, pool, address) on pools where they're active
  Then: get_address_activity(address) for cross-pool pattern
  Portfolio shows WHAT they hold; activity shows HOW they got there.

Goal: "Evaluate a specific opportunity"
  Start: get_pt_details(chain, pt) → base data
  Then: compare_yield(chain, pt) → fixed vs variable spread
  Then: get_looping_strategy(chain, pt) → if Morpho market exists
  Then: quote_trade(chain, pt, amount, side) → entry cost
  Then: simulate_portfolio_after_trade → preview result

Goal: "Find YT mispricing"
  Start: scan_yt_arbitrage(capital_usd) → spread-sorted opportunities
  YT arbitrage is a different axis than PT yield optimization.
  Large spreads could mean: (a) real mispricing, (b) IBT APR about to drop,
  (c) liquidity event. The tool can't distinguish — that's agent judgment.

Goal: "Optimize governance position"
  Start: get_ve_info(ve_balance, capital) → boost scenarios
  Then: scan_opportunities(capital, ve_spectra_balance) → boosted rankings
  veSPECTRA boost only affects gauge-enabled LP positions, not PT or YT.
```

**Open Emergence alignment**: This is Layer 1 (protocol context) — teaching the "physics"
of the tool system itself. It tells the agent what CAN be done, not what SHOULD be done.
The workflows are described as patterns that exist, not instructions to follow.

**Dissolution condition**: When agents reliably compose multi-tool workflows without this
routing guide — i.e., when tool descriptions and output hints alone are sufficient for
workflow discovery. Track: do agents that DON'T read this topic compose workflows as
well as agents that do?

---

### Feature 3: Negative Signal Guidance in Dead-End Responses [IMPLEMENTED]

**What**: When a tool returns empty/null/unavailable results, include structured guidance
about what the absence means and what alternatives exist.

**Examples:**

`get_looping_strategy` when auto-detect finds no Morpho market:
```
⚠ No Morpho market found for this PT on [chain].
Using default parameters (may not reflect real market conditions).

What this means:
- This PT cannot currently be used for leveraged looping on Morpho
- This could change if a curator creates a market for it

Alternative strategies for this PT:
- Unleveraged fixed yield: compare_yield to evaluate the raw spread
- LP yield: check pool APY in get_pt_details (may include gauge emissions)
- Find loopable alternatives: scan_opportunities(include_looping=true)
- Check other chains: get_morpho_markets(pt_symbol="[SYMBOL]") across all chains
```

`scan_yt_arbitrage` with zero results:
```
No YT arbitrage opportunities found matching criteria.

What this means:
- YT implied rates are currently close to IBT variable rates (tight spreads)
- This is normal — spreads widen during rate volatility events

Alternative approaches:
- Check PT fixed yields instead: scan_opportunities(capital_usd=...)
- Widen search: lower min_spread or remove asset_filter
- Monitor: spreads change as IBT rates move — check back after rate changes
```

`get_morpho_markets` with zero results on a non-Morpho chain:
```
No Morpho PT markets found on [chain].

Morpho PT markets are available on: mainnet, base, arbitrum, katana.
Try: get_morpho_markets(chain="mainnet") or omit chain to search all.
```

**Open Emergence alignment**: This is the anti-fragmentation mechanism (Movement 2).
Dead ends fragment agent workflows. Negative signals with alternatives prevent the
agent from stalling without prescribing a specific path. The agent still chooses — but
it chooses from a menu, not a void.

**Dissolution condition**: When agents develop robust fallback reasoning on their own
(e.g., an agent that gets "no Morpho market" automatically tries scan_opportunities).
If agents always follow the suggested alternatives without reasoning about them, the
guidance has become prescriptive and should be relaxed.

---

### Feature 4: Unified Discovery Entry Point (scan_all)

**What**: A single entry-point tool that runs all three discovery scans in parallel and
returns a unified view — not merged rankings, but side-by-side results from each lens.

**Name**: `discover_opportunities`

**Parameters**:
```
capital_usd: number       (required)
asset_filter?: string     (optional)
ve_spectra_balance?: number (optional)
top_n?: number            (default 5 per category)
```

**Output structure**:
```
=== Opportunity Discovery: $500K capital ===

--- Fixed Yield (capital-aware, ranked by effective APY) ---
[top 5 from scan_opportunities logic]

--- YT Arbitrage (ranked by spread) ---
[top 5 from scan_yt_arbitrage logic]

--- Raw APY Headlines (for reference — NOT capital-adjusted) ---
[top 5 from get_best_fixed_yields logic]

⚠ These three views intentionally show different rankings.
  "Best" depends on: your capital size, your rate conviction, your risk tolerance.
  - Fixed yield: safest, capital-aware, includes looping leverage
  - YT arbitrage: directional bet on rates staying high
  - Raw APY: headline rates before slippage — useful for small capital only
```

**Open Emergence alignment**: This PRESERVES the generative friction between the three
discovery tools (they still disagree) but removes the NAVIGATIONAL friction of not
knowing which to call. The agent sees all three perspectives simultaneously and must
reason about which matters for its situation.

This is the coral move: the tension is maintained, but the CONDITIONS for encountering
the tension are improved. Previously, an agent might only call one discovery tool and
never encounter the disagreement. Now it always sees all three lenses.

**Dissolution condition**: If agents that use `discover_opportunities` develop LESS
nuanced reasoning than agents that call the three tools separately (because the unified
view reduces their engagement with each perspective), the tool is doing harm and should
be removed. Track: do agents using this tool develop their own "best" framework, or do
they always pick the top result from one category?

---

### Feature 5: Portfolio Enrichment with Actionable Looping Analysis [IMPLEMENTED]

**What**: Add an optional `include_looping_analysis` parameter to `get_portfolio` that,
when true, runs `get_looping_strategy` logic inline for each Morpho-eligible position.

**Output enhancement**:
```
Position: PT-ibUSDC (Base)
  [existing position data...]
  Position Shape: PT only (no YT)
  Morpho: Market available (LLTV 86%)

  Looping Potential (at position value $25,000):
  ┌─ 1x (no loop): 8.2% APY (your current yield)
  ├─ 2x: 12.1% net APY (margin: 53%)
  ├─ 3x: 15.9% net APY (margin: 28%)  ← sweet spot
  └─ 4x: 19.8% net APY (margin: 15%)
  Borrow rate: 3.8% (live from Morpho)
  → Deep dive: get_looping_strategy(chain="base", pt_address="0x...")
```

For non-eligible positions:
```
Position: PT-wstETH (Mainnet)
  [existing position data...]
  Morpho: No market available — can't loop this position
  → Alternative: compare_yield to evaluate unleveraged spread
```

**Open Emergence alignment**: This is Layer 3 enrichment — computing signals from data
the agent already has (portfolio positions + Morpho availability). It doesn't prescribe
"you should loop at 3x" — it shows what looping WOULD look like so the agent can decide.
The existing `formatPortfolioHints` already surfaces Morpho availability; this extends
that from a flag ("market exists") to a projection ("here's what it would yield").

**Dissolution condition**: When `scan_opportunities` becomes the universal entry point
and agents rarely start from portfolio analysis. Also dissolves if agents always call
`get_looping_strategy` separately after seeing portfolio flags — in that case, the
inline analysis is redundant computation.

---

### Feature 6: Watch-Tower Integration (Conditional Orders)

**What**: Wire the existing but unused `GET /v1/watch-tower/{network}/transactions`
endpoint. This surfaces conditional/limit orders — a category of data entirely absent
from the current tool set.

**Why this matters for agents**: Conditional orders reveal INTENT that hasn't executed
yet. An agent analyzing a pool sees only executed trades. With watch-tower data, it could
see pending orders and reason about upcoming supply/demand pressure.

**Tool name**: `get_pending_orders`

**Parameters**:
```
chain: string
pool_address?: string     (filter to specific pool)
pt_address?: string       (filter to specific PT)
```

**Output**:
```
Pending Orders on Base:
  Pool: PT-ibUSDC / ibUSDC
  - 3 pending BUY orders totaling ~$45K (largest: $20K)
  - 1 pending SELL order at $8K
  Net pending demand: +$37K buy-side pressure

  ⚠ Pending orders may execute or expire. This is intent data, not committed flow.
  Use get_pool_activity to see what actually executed.
```

**Open Emergence alignment**: This is a genuinely new data axis. It doesn't overlap with
existing tools — it surfaces FUTURE intent where existing tools only show PAST activity.
This creates a new generative friction point: past activity says one thing, pending orders
say another. An agent that sees both must reason about which signal to trust.

**Dissolution condition**: When the watch-tower API is retired or when conditional orders
become rare enough that the data isn't useful. Also dissolves if agents treat pending
orders as certainty (they should treat them as intent, not commitment).

---

### Feature 7: APR Vision Integration (Token-Level Rate Tracking)

**What**: Wire the existing but unused `GET /v1/vision/{network}?tokens=...` endpoint.
This provides APR data for specific tokens — a rate-tracking capability that would
complete the YT arbitrage workflow.

**Why this matters for agents**: `scan_yt_arbitrage` detects CURRENT spread between YT
implied rate and IBT variable rate. But "current" is a snapshot. An agent can't tell if
the spread is widening, narrowing, or mean-reverting. With vision/APR history, it could
reason about rate trends.

**Tool name**: `get_rate_history`

**Parameters**:
```
chain: string
tokens: string[]          (IBT or underlying addresses)
```

**Output**:
```
Rate History for ibUSDC (Base):
  Current APR: 8.2%
  7d avg: 7.8%
  30d avg: 6.5%
  Trend: rising (+1.7% over 30d)

  ⚠ Past rates don't predict future rates. Use this to contextualize
  scan_yt_arbitrage spreads — a spread that's widening may persist longer
  than one that's mean-reverting.
```

**Open Emergence alignment**: This fills the temporal blind spot in YT arbitrage analysis.
Currently, `scan_yt_arbitrage` sees "IBT APR: 8.2%, YT implied: 5.5%" and can't say
whether 8.2% is a spike or a new normal. Rate history transforms a point-in-time
comparison into a trajectory analysis — without prescribing the conclusion.

**Dissolution condition**: Listed in dissolution-conditions.md for `scan_yt_arbitrage`:
"When the tool can track IBT APR history (not just the current snapshot) and provide
statistically grounded spread persistence estimates." This feature partially addresses
that condition — it provides the raw history, though not yet statistical persistence
estimates.

---

### Feature 8: Tool-Graph Resource (Machine-Readable Composition Map)

**What**: Add a new MCP resource `spectra://tool-graph` that describes tool relationships
as structured data — which tools accept output from which other tools, what parameters
flow between them, and what workflows they compose into.

**Format**:
```json
{
  "tools": {
    "scan_opportunities": {
      "produces": ["chain", "pt_address", "pool_address", "morpho_market_key"],
      "feeds_into": ["get_looping_strategy", "quote_trade", "get_pt_details",
                      "get_pool_activity", "get_morpho_rate"],
      "category": "discovery",
      "capital_aware": true
    },
    "get_portfolio": {
      "produces": ["chain", "pt_address", "address"],
      "feeds_into": ["get_looping_strategy", "get_pool_activity",
                      "get_address_activity", "compare_yield"],
      "category": "analysis",
      "capital_aware": false
    }
  },
  "workflows": {
    "yield_optimization": ["scan_opportunities", "get_looping_strategy",
                           "quote_trade", "simulate_portfolio_after_trade"],
    "wallet_investigation": ["get_portfolio", "get_pool_activity",
                             "get_address_activity"],
    "yt_arbitrage": ["scan_yt_arbitrage", "get_pt_details", "compare_yield"]
  },
  "friction_points": {
    "raw_vs_effective_apy": {
      "tools": ["get_best_fixed_yields", "scan_opportunities"],
      "description": "These tools intentionally disagree on rankings"
    }
  }
}
```

**Why machine-readable**: An advanced agent or agent framework could parse this resource
at session start and build an internal tool-composition graph. This is not for the tool
descriptions (which are human-readable) — it's metadata ABOUT the tool system that
enables programmatic workflow planning.

**Open Emergence alignment**: This is Layer 1 (context about the system) but at a
structural level. It teaches the "physics" of tool composition without prescribing
specific workflows. The agent can use this graph to plan its own novel workflows.

**Dissolution condition**: When MCP protocol itself supports tool-relationship metadata
natively (e.g., a `relatedTools` field in tool definitions). At that point, a custom
resource is redundant.

---

## Part 4: Proposals That Were Considered and Rejected

### Rejected: Unified "Do Everything" Meta-Tool

A `run_analysis(goal, capital, address)` that internally calls multiple tools and
returns a synthesized report. **Rejected because**: this violates the core principle of
teaching mechanics, not conclusions. A meta-tool that hides the intermediate steps
prevents the agent from learning the tool system. It produces correct RESULTS but no
UNDERSTANDING. The agent becomes dependent on the meta-tool instead of developing
compositional fluency.

### Rejected: Batch Operation Endpoint

A `batch(operations: [{tool, params}, ...])` that runs multiple tool calls in one
request. **Rejected because**: MCP protocol already supports concurrent tool calls from
the agent side. A server-side batch endpoint adds complexity without solving a real
problem. If an agent needs to call `get_looping_strategy` on 5 PTs, it should make 5
concurrent calls — the MCP transport handles this. Server-side batching is a performance
optimization that doesn't improve agentic accessibility.

### Rejected: Strategy Pattern Classifier

A tool that takes activity data and outputs "this is a YT accumulation strategy" with
confidence scores. **Rejected because**: this is exactly the kind of conclusion the
system should NOT provide. The "could be" language in activity hints is correct — the
system teaches mechanics so the agent can reason about what patterns MEAN. A classifier
pre-digests that reasoning. If agents consistently fail to compose activity + portfolio
into strategy inferences, the fix is better hints, not a classifier.

### Rejected: Auto-Execute Recommendations

Tool outputs that say "recommended action: buy 50K PT at address..." **Rejected
because**: the server is read-only by design. Even when write capabilities are added
(unsigned transaction construction), the server should present OPTIONS, not
recommendations. "Here are three things you could do" respects agent autonomy.
"Do this" doesn't.

---

## Part 5: Implementation Priority

Ordered by agentic accessibility impact per unit of effort:

| Priority | Feature | Effort | Impact | Status |
|----------|---------|--------|--------|--------|
| 1 | Next-Step Hints (Feature 1) | Low | High | **DONE** — all 12 tool files |
| 2 | Workflow Routing Topic (Feature 2) | Low | High | **DONE** — context.ts |
| 3 | Negative Signal Guidance (Feature 3) | Low | Medium | **DONE** — 6 tools enhanced |
| 4 | Tool-Graph Resource (Feature 8) | Low | Medium | Not started |
| 5 | Portfolio Looping Enrichment (Feature 5) | Medium | High | **DONE** — portfolio.ts |
| 6 | Unified Discovery (Feature 4) | Medium | High | Deferred (workflow routing covers most of the routing problem) |
| 7 | Watch-Tower Integration (Feature 6) | Medium | Medium | Not started (depends on API availability) |
| 8 | APR Vision Integration (Feature 7) | Medium | Medium | Not started (depends on API shape) |

**Completed**: Features 1, 2, 3, 5. These cover all four dead-end workflows identified
in Part 2 and eliminate the N+1 looping lookup pattern from portfolio analysis.

---

## Part 6: Alignment Check Against Open Emergence Principles

| Principle | Feature 1 | Feature 2 | Feature 3 | Feature 4 | Feature 5 | Feature 6 | Feature 7 | Feature 8 |
|-----------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|-----------|
| Teach mechanics, not conclusions | ✓ options | ✓ patterns | ✓ alternatives | ✓ side-by-side | ✓ projections | ✓ intent data | ✓ rate context | ✓ structure |
| Preserve generative friction | ✓ no ranking | ✓ shows disagreement | ✓ no "right answer" | ✓ maintains 3 views | ✓ no recommendation | ✓ new friction | ✓ new friction | ✓ shows friction points |
| "Could be" language | ✓ "could" | ✓ "patterns" | ✓ "alternatives" | ✓ "different rankings" | ✓ "would look like" | ✓ "may execute" | ✓ "don't predict" | N/A (structural) |
| Cross-reference other tools | ✓ core purpose | ✓ core purpose | ✓ alternatives | ✓ each section | ✓ deep-dive link | ✓ activity ref | ✓ arb ref | ✓ core purpose |
| Has dissolution condition | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

All eight proposals pass the alignment check. No feature prescribes conclusions,
removes generative friction, or uses deterministic language where ambiguity exists.

---

## Note on Hard Theorem

This review was prepared without access to the hard theorem document referenced as being
"in another subfolder/git." If the hard theorem introduces additional design constraints
or principles, this review should be revisited through that lens. The proposals above
are designed to be compatible with the Open Emergence framework as documented in
`recursive-meta-process.md` and `dissolution-conditions.md`.
