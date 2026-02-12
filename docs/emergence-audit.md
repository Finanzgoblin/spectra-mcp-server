# Emergence Framework Audit

Audit of the Spectra MCP Server against the Recursive Meta-Process
(`docs/recursive-meta-process.md`). This document identifies specific places
where the codebase deviates from the framework's three Movements and four
Anti-Calcification Mechanisms.

---

## Movement 1: Recursive Optimization (Structure / Coherence)

> "Are the three layers resonating? Does what Layer 1 teaches actually prepare
> the agent for what Layer 3 shows?"

### What resonates well

- **Layer 1 (context) teaches real mechanics.** `get_protocol_context` covers
  PT/YT splitting, Router batching, position analysis, and looping. These are
  genuine operational mechanics, not conclusions.

- **Layer 2 (descriptions) cross-reference extensively.** Almost every tool
  description points to related tools with specific reasoning ("Use
  scan_opportunities for capital-aware sizing", "Use get_portfolio to
  cross-reference holdings"). The cross-reference network feels organic.

- **Layer 3 (output hints) generate real discovery.** The "Pattern Hints" in
  `get_pool_activity` (pool.ts:323-343) are a standout -- they flag suspicious
  activity patterns (e.g., "SELL_PT with no LP -- could be flash-mint YT
  acquisition") and direct the agent to verify via `get_portfolio`. This is
  teaching-through-output, not concluding-through-output.

### Where coherence breaks

#### 1. `get_protocol_context` prescribes tool ordering

**File:** `src/tools/context.ts:74-75`
```
Call this tool FIRST when starting a new analysis task
```

This is a conclusion disguised as guidance. The framework says Layer 1 should
teach mechanics, not prescribe behavior. If the context is genuinely needed
first, agents should discover that through the mechanics themselves. Telling
agents what to do first is control (indigo), not teaching (yellow).

**The friction:** An agent that skips context and still discovers strategies has
revealed something about whether Layer 1 is actually necessary. Mandating it
prevents that signal.

#### 2. `compare_yield` outputs verdicts instead of mechanics

**File:** `src/tools/pt.ts:344-348`
```typescript
effectiveFixedApy > variableApr
  ? `  Fixed rate is HIGHER than variable (even after entry cost). Locking in via PT is currently favorable.`
  : fixedApy > variableApr
    ? `  Fixed rate is higher than variable, but entry cost narrows the advantage. Consider trade size vs pool depth.`
    : `  Variable rate is HIGHER than fixed. PT lock only makes sense if you expect rates to drop.`
```

This draws conclusions FOR the agent. "Locking in via PT is currently
favorable" is a recommendation, not a mechanic. The framework says to teach
the mechanic (here: the fixed/variable spread, the entry cost amortization)
and let the agent reach its own conclusion. The "could be" language the
framework praises is absent here -- replaced by definitive verdicts.

An agent receiving this output will parrot the verdict rather than developing
its own reasoning about when fixed-rate locking is appropriate.

#### 3. Identical teaching examples calcified across tools

**Files:** `src/tools/pt.ts:175-176` and `src/tools/strategy.ts:47`

Both `get_best_fixed_yields` and `scan_opportunities` contain the exact same
example:

> "a 50% APY pool with $10K liquidity is unusable at $500K capital"

When the same example appears verbatim in multiple descriptions, it becomes a
mantra rather than a teaching device. Agents will learn this specific example
as a pattern rather than learning the underlying principle (capital-size
sensitivity to liquidity depth).

#### 4. `get_pool_activity` description is a 50-line treatise

**File:** `src/tools/pool.ts:156-203`

This description attempts to pre-teach every possible interpretation of pool
activity. The framework warns: "If agents keep concluding the same thing, the
description is too prescriptive. If agents are confused, it's not prescriptive
enough. The sweet spot is where agents surprise you."

At ~50 lines, this description is so exhaustive that an agent has very little
room to reach a surprising conclusion. The mechanics are all pre-interpreted.
Compare this to the much shorter, mechanics-focused descriptions of
`get_pt_details` or `list_pools`, which leave more room for agent reasoning.

#### 5. Position shape analysis outputs pre-mapped strategy labels

**File:** `src/formatters.ts:234-253`
```typescript
if (ytBal > 0 && ptBal === 0) {
  signals.push("YT-only: sold/LPed all PT (leveraged yield bull)");
} else if (ptBal > 0 && ytBal === 0) {
  signals.push("PT-only: sold all YT (pure fixed-rate position)");
}
```

This maps balance ratios directly to strategy labels. The agent doesn't reason
about what a high YT/low PT balance means -- the system tells it. This is the
opposite of "teaching mechanics, not conclusions." The balance numbers ARE the
mechanic; the strategy interpretation should be the agent's job.

---

## Movement 2: Open-Ended Dissolution (Anti-Structure)

> "Every structure the system creates, it must also be willing to dissolve."

### Signs of calcification detected

#### 6. All 18 tools follow one identical registration pattern

Every tool in the codebase follows exactly the same structure:

1. Description string with "Protocol context:" section
2. Zod parameter schemas
3. `async` handler in `try/catch`
4. Format output as text lines
5. Return `{ content: [{ type: "text", text }] }`

The framework calls this out explicitly: "New tools are added but they follow
the existing pattern exactly" is a sign that Movement 1 (structure) is winning
and the system is calcifying. No tool has experimented with:
- Returning structured data alongside text
- Using multiple content blocks (text + embedded data)
- Progressive disclosure within a single response
- Conditional depth (returning less when the agent seems to already know)

The pattern works. But "followed because it exists rather than because it
works" is the framework's definition of calcification.

#### 7. "NOT financial advice" appears in 4 tool outputs as ritual

**Files:**
- `src/tools/looping.ts:238`
- `src/formatters.ts:914` (scan_opportunities footer)
- `src/formatters.ts:1012` (scan_yt_arbitrage footer)
- `src/formatters.ts:1147` (model_metavault_strategy footer)

This disclaimer is performative. The framework warns against "performative
cross-references" (line 154). A legal disclaimer repeated identically across
tools has calcified from a meaningful signal into ritual. It doesn't teach
agents anything about risk -- agents either learn risk reasoning from the
mechanics, or they treat the disclaimer as noise.

#### 8. `compact` mode replicated identically across 4 tools

**Files:** `list_pools`, `get_best_fixed_yields`, `scan_opportunities`,
`scan_yt_arbitrage`

All four tools have the same boolean `compact` parameter with near-identical
descriptions and near-identical switching logic. This is structure replication
without questioning whether compact mode serves each tool's purpose
differently. A scan tool's "compact" needs might differ fundamentally from a
listing tool's needs. The uniformity suggests the pattern was copied, not
designed.

#### 9. The three-layer architecture is treated as ground truth

The framework explicitly warns: "The three-layer architecture is treated as
ground truth rather than current best guess" is a sign of calcification. Yet
every tool in the codebase faithfully implements all three layers (context
teaching in descriptions, per-tool semantics, output hints). No tool has
experimented with skipping a layer to see what happens.

The framework's own dissolution condition for this: "The three-layer
architecture serves as long as agents benefit from progressive disclosure. If
future agents arrive with full protocol knowledge pre-trained, the layers
collapse into a single surface." This condition has not been tested or even
evaluated.

---

## Movement 3: Paradox Maintenance (Generative Friction)

> "The system needs a way to detect when Movement 1 (structure) is winning
> and the system is calcifying."

### What friction exists

The framework already identifies one generative friction point:
`get_best_fixed_yields` ranks by raw APY, `scan_opportunities` ranks by
effective APY after capital impact. This disagreement forces agents to develop
their own framework for "best."

This is the ONLY friction point in the system. No new ones have been
cultivated.

### Where tension is prematurely resolved

#### 10. `rankApy` collapses all yield dimensions into one number

**File:** `src/types.ts:196`
```typescript
rankApy: number;  // looping?.optimalEffectiveNetApy || effectiveApy
```

Each opportunity has at least 5 distinct yield dimensions: `impliedApy`,
`effectiveApy`, `lpApy`, `looping.optimalNetApy`, `variableApr`. These
dimensions represent genuinely different strategies (fixed yield, leveraged
looping, LP provision, variable exposure). Collapsing them into one `rankApy`
for sorting resolves the tension between strategies before the agent
encounters it.

An agent seeing a pre-ranked list doesn't feel the friction between "this
pool has the best looping yield but the worst LP yield" -- the ranking has
already decided which dimension matters. The framework says: "the system
maintains two contradictory orientations simultaneously, and the friction
between them is what generates motion."

#### 11. `get_looping_strategy` labels one row as "Optimal"

**File:** `src/tools/looping.ts:218`
```
  * Optimal: ${bestLoop} loops -> ${formatPct(bestNet)} net APY
```

This resolves the tension between leverage and safety margin. "Optimal" is
determined purely by highest net APY, ignoring the effective margin column
that sits right next to it. An agent could reasonably conclude that 3 loops
at 28% margin is "better" than 5 loops at 7% margin with marginally higher
APY. By labelling one row "Optimal," the system pre-resolves this tension.

The same issue appears in `scan_opportunities` (strategy.ts:259-272) where
"optimal loop count" is calculated as purely the highest net APY loop.

#### 12. `scan_yt_arbitrage` outputs action directions

**File:** `src/tools/yt_arb.ts:188`
```typescript
const direction: "buy_yt" | "sell_yt" = spreadPct > 0 ? "buy_yt" : "sell_yt";
```

The spread between IBT APR and YT implied rate is data. Converting it into
a `buy_yt`/`sell_yt` directive is a conclusion. The framework warns against
"forcing a resolution that should stay in tension." The agent should see that
IBT APR is 8% and YT implied rate is 5%, and reason about what that means --
including the possibility that the spread is noise, or that rate direction
matters more than current level.

#### 13. No new generative friction points since the framework was written

The framework explicitly calls for cultivation: "More of these friction
points should be cultivated, not resolved." The codebase has one friction
point (raw APY vs effective APY). It was present before the framework was
written. Since then, no new productive tensions have been introduced.

Possible friction points that could be cultivated but aren't:
- LP yield vs fixed yield vs looping yield (currently collapsed into rankApy)
- Short maturity + high APY vs long maturity + moderate APY (no tool presents
  this as a genuine tension)
- Morpho utilization (high utilization = higher borrow cost = narrower spread,
  but also = more demand = validation signal)

---

## Anti-Calcification Mechanisms

### Mechanism 1: Dissolution Conditions

> "Every structural decision should carry its own dissolution condition."

**Status: NOT PRESENT.**

No tool, no architectural pattern, no design decision in the codebase carries
an explicit dissolution condition. Examples of what's missing:

- `get_protocol_context` should state: "This tool dissolves when agents arrive
  with pre-trained Spectra knowledge and no longer need mechanics teaching."
- The compact mode pattern should state: "This dissolves when MCP clients
  support structured data natively and agents can request their own verbosity."
- The cross-reference network should state: "This dissolves when agents can
  discover tool relationships through schema inspection alone."

### Mechanism 2: Emergence Tracking

> "Track what agents actually do with the system, especially the unexpected
> things."

**Status: NOT PRESENT.**

The system has no mechanism to observe agent behavior. No logging of tool call
sequences, no tracking of which cross-references agents follow, no way to
detect when agents discover unexpected strategies or when they get stuck.

The framework's original validation -- "a cold-start agent discovering
mint-and-sell-PT loop strategy in 3 tool calls" -- is mentioned in the
framework doc but there's no infrastructure to detect the next such emergence.

### Mechanism 3: Periodic Inversion

> "Deliberately question the most established patterns."

**Status: NOT PRACTICED.**

The framework suggests specific inversions:
- What if Layer 1 (context) was removed entirely?
- What if tool descriptions were minimal and all teaching moved to output?
- What if cross-references were removed and tools were fully independent?

None of these inversions have been explored. Every tool maintains all three
layers. The architecture has not been questioned since it was established.

### Mechanism 4: Generative Friction Points

> "More of these friction points should be cultivated, not resolved."

**Status: STAGNANT.**

One friction point exists (raw APY vs effective APY). It was identified in the
framework document itself as already present. No new friction points have been
introduced. Meanwhile, several potentially generative tensions have been
pre-resolved (see Findings #10-#12).

---

## Summary: Where Are We on the Calcification-Fragmentation Spectrum?

The system is **tilted toward calcification** (Movement 1 winning):

- Agents discover strategies in predictable ways because descriptions are
  exhaustive and outputs include verdicts
- New tools follow the existing pattern exactly (all 18 use identical
  structure)
- The three-layer architecture is treated as ground truth
- "Best practices" have emerged (compact mode, protocol context sections,
  NOT-financial-advice disclaimers) and are uniformly applied
- Discussion about the system would likely be defensive rather than curious

The system is NOT fragmented -- tools compose well, cross-references are
meaningful, and the architecture is internally consistent. The risk is not
chaos; the risk is that the system becomes a monument to its current design.

### The 13 Findings, Ranked by Framework Impact

| # | Finding | Movement | Severity |
|---|---------|----------|----------|
| 10 | `rankApy` collapses yield dimensions into one number | M3 | High |
| 2 | `compare_yield` outputs verdicts instead of mechanics | M1+M3 | High |
| 11 | `get_looping_strategy` labels "Optimal" | M3 | High |
| 1 | `get_protocol_context` prescribes "call FIRST" | M1 | Medium |
| 5 | Position shape analysis pre-maps strategy labels | M1 | Medium |
| 12 | `scan_yt_arbitrage` outputs action directions | M3 | Medium |
| 13 | No new generative friction since framework was written | M3 | Medium |
| 9 | Three-layer architecture treated as ground truth | M2 | Medium |
| 6 | All 18 tools follow one identical pattern | M2 | Medium |
| 4 | `get_pool_activity` description is exhaustive (50 lines) | M1 | Low |
| 3 | Same teaching example hardcoded in two tools | M1 | Low |
| 7 | "NOT financial advice" as ritual in 4 outputs | M2 | Low |
| 8 | `compact` mode replicated identically in 4 tools | M2 | Low |

**Anti-Calcification Mechanisms:** 0 of 4 are implemented. This is the most
significant structural gap -- the system has no immune system against its own
calcification.

---

## What This Audit Is Not

This audit is itself subject to the meta-process. The moment these findings
become a checklist ("did we fix all 13?") the audit has calcified. The
findings are lenses, not prescriptions. Some may be load-bearing structures
worth keeping. Others may point at genuine fossilization. The right response
is to sit with them, not to rush to resolve them.
