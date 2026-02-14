# Dissolution Conditions

Every structural decision in this codebase carries a dissolution condition --
a description of when it would no longer serve and should be changed or removed.
This is per the Open Emergence metaframework (docs/recursive-meta-process.md,
Movement 2: Open-Ended Dissolution).

When a dissolution condition is met, the structure should be questioned -- not
automatically removed, but examined to see if it still serves. The condition is
a prompt for re-evaluation, not a kill switch.

---

## Architecture

### Three-Layer Model (context / descriptions / output hints)

Serves as long as agents benefit from progressive disclosure -- arriving with
no protocol knowledge and building understanding through interaction. If future
agents arrive with full protocol knowledge pre-trained (e.g., Spectra mechanics
in the foundation model), the layers collapse into a single surface and the
architecture should simplify to match.

### Formatters-do-computation, tools-are-thin-wrappers

Serves as long as multiple tools share formatting logic (e.g., `formatPct`,
`estimatePriceImpact`, `extractLpApyBreakdown` are each used by 3+ tools).
If the tool count stabilizes and each formatter is only called from one tool,
the separation adds indirection without benefit -- inline the formatters.

### Best-effort enrichment pattern (Promise.allSettled, swallow errors)

Serves as long as enrichment data (public RPCs, portfolio cross-reference)
is unreliable enough that failures are routine rather than exceptional. If
APIs become stable and RPC failures drop below ~1%, switch to hard errors
so that silent data gaps don't produce silently misleading output.

### 4-phase pipeline (fetch / compute / sort / format)

Used by `scan_opportunities` and `scan_yt_arbitrage`. Serves as long as the
phases are truly sequential dependencies. If streaming/progressive output
becomes valuable (e.g., returning results as chains respond rather than
waiting for all), the pipeline should dissolve into an async generator.

### Constant-product price impact model

Serves as the fallback for tools without on-chain Curve get_dy() access
(`scan_opportunities`, `compare_yield`, `get_best_fixed_yields`). When
all scan tools can batch on-chain quotes (e.g., via multicall), the math
model becomes a misleading conservative approximation and should be removed.

---

## Layer 3 Output Hints

### get_pool_volume: Volume signals (formatVolumeHints)

Dissolution: When Spectra API returns pre-computed volume-to-liquidity
ratios, trend data, or activity classification directly.

### get_morpho_markets: Market hints (formatMorphoMarketHints)

Dissolution: When `scan_opportunities` becomes the exclusive entry point
for all looping decisions and agents stop calling `get_morpho_markets`
directly for strategy evaluation.

### get_morpho_rate: PT spread analysis

Dissolution: When the Morpho API returns the PT's implied APY alongside
the borrow rate, or when a unified "looping readiness" endpoint exists.

### get_portfolio: Portfolio signals (formatPortfolioHints)

Dissolution: When Spectra adds a native portfolio analytics endpoint that
computes concentration, maturity alerts, and strategy shape server-side.

### scan_opportunities: Strategy tension line

Dissolution: When agents reliably surface competing strategies (PT looping
vs YT accumulation vs LP farming) without explicit prompting -- i.e., the
tension is emerging naturally from the data without the scaffolding.

### scan_yt_arbitrage: Ambiguity language on large spreads

Dissolution: When the tool can track IBT APR history (not just the current
snapshot) and provide statistically grounded spread persistence estimates
rather than point-in-time comparisons.

### get_looping_strategy: "Could be" on optimal recommendation

Dissolution: When the tool can model borrow rate volatility (e.g., fetch
historical Morpho utilization data) and provide confidence intervals
rather than point estimates at current rates.

---

## Cross-References

### get_supported_chains -> scan_opportunities reference

Dissolution: If `scan_opportunities` is renamed, merged with another tool,
or if chain discovery moves to a different workflow entirely.

### get_best_fixed_yields <-> scan_opportunities friction note

Dissolution: If the two tools are merged, or if "effective APY" becomes
the universal default metric and raw APY rankings lose all utility
(unlikely while DeFi UIs still show headline rates).

---

## Generative Friction Points

### Raw APY vs Effective APY disagreement

Between `get_best_fixed_yields` (raw implied APY ranking) and
`scan_opportunities` (effective APY after entry cost). Maintained
deliberately. The two rankings will often disagree on the same pools,
forcing agents to develop their own framework for "best."

Dissolution: Only if the concept of "raw APY" loses all utility --
unlikely as long as DeFi UIs show headline rates that don't account
for slippage or capital size.

### PT looping vs YT accumulation tension

In `scan_opportunities` output (Strategy Tension line). When a pool's
YT leveraged exposure competes with the PT looping effective APY,
the tension is surfaced explicitly. This forces the agent to reason
about rate direction conviction rather than defaulting to the ranked answer.

Dissolution: If protocol mechanics change such that PT and YT strategies
are no longer substitutes for yield exposure (e.g., if YT becomes
non-transferable or loses its leveraged yield property).

### Ranking as suggestion vs ranking as conclusion

In `scan_opportunities` and `scan_yt_arbitrage` output. The `~` prefix
on APY numbers, `(at current rates)` qualifier, and footer caveats
signal that rankings are projections. This resists the tendency to
treat ranked lists as resolved conclusions.

Dissolution: When agents demonstrate they autonomously question rankings
and explore lower-ranked opportunities without prompting. At that point
the scaffolding has done its job and can be removed.

---

## model_metavault_strategy: Purely hypothetical tool

This tool models scenarios for a feature (MetaVaults) that doesn't have
a live API yet (`/v1/{network}/metavaults` returns 400). The tool is
built in anticipation.

Dissolution: If MetaVaults launch with fundamentally different economics
(e.g., no YT compounding, different fee model), this tool's math is
wrong and should be rebuilt from the actual implementation. If MetaVaults
don't launch within 6 months of the initial build, question whether the
tool's existence creates false confidence in a hypothetical.

---

## Intelligence Boundary Enhancements (Feb 2026)

These enhancements surface the boundaries of what's known — confidence signals,
navigational hints, negative signals, and Router invisibility warnings — so
autonomous agents can determine where to explore next without prescriptive
conclusions. They follow Open Emergence Layer 3 principles: "could be" language,
best-effort enrichment, and clear navigation paths.

### Flow accounting confidence signals (formatFlowAccounting)

Surfaces the reliability boundary of mint estimation. When YT balance is used
to infer minimum mints, the confidence qualifier tells the agent how much to
trust the inference based on whether BUY_PT events (which could mask flash-redeem
YT selling) are present.

Dissolution: When the Spectra Router API provides a transaction history endpoint
that explicitly tags flash-redeem and flash-mint operations, eliminating the need
for inference from YT balance alone.

### Position Shape navigational hints (formatPositionSummary)

Surfaces the temporal blind spot in portfolio data. Position Shape shows current
balance ratios but says nothing about entry timing or cost basis. The hint creates
a navigation path to get_pool_activity for temporal reconstruction.

Dissolution: When the Spectra portfolio API returns acquisition timestamps, entry
prices, or cost basis data for each position component (PT/YT/LP).

### Gauge boost cross-reference (formatPositionSummary)

Surfaces the yield range for LP positions in gauge-boosted pools and creates a
navigation path to get_ve_info. Without this, an agent seeing "LP APY: 70.89%"
has no signal that the actual yield could be 199% with veSPECTRA boost.

Dissolution: When the Spectra portfolio API returns the user's actual boost level
(computed server-side from their veSPECTRA balance vs pool TVL).

### Negative signals: Morpho looping availability (formatPortfolioHints)

Surfaces whether Morpho markets exist for the user's PT positions. An absence
of looping in the portfolio combined with available Morpho markets is meaningful
information — it could indicate a risk-averse strategy or an uninvestigated
opportunity. The signal explicitly labels both presence and absence.

Dissolution: When the portfolio API returns Morpho leverage ratio directly
(server-side detection of active looping positions).

### Negative signals: expired positions aggregate (formatPortfolioHints)

Aggregates expired positions at the portfolio level with total unclaimed value.
While individual positions already show "MATURED", the aggregate makes the total
unredeemed capital visible across all positions.

Dissolution: When Spectra adds a portfolio-level maturity summary endpoint that
aggregates unclaimed redemptions.

### Negative signals: gauge exposure reminder (formatPortfolioHints)

Portfolio-level reminder that LP positions may be affected by veSPECTRA boost.
Complements the per-position gauge boost range (Enhancement 3) with a single
aggregate signal that navigates to get_ve_info.

Dissolution: When the portfolio API returns the user's veSPECTRA balance and
computed boost for each LP position.

### Improved no-activity messaging for address filter (get_pool_activity)

When an address has no visible activity on a pool, the previous message suggested
the address "may not have interacted." The improved message explains that Spectra
Router operations (atomic mint + LP) are invisible in pool activity data, and
navigates to get_portfolio and get_address_activity as alternatives.

Dissolution: When the Spectra API provides a unified transaction history endpoint
that includes Router-batched operations alongside pool activity.

---

## Agentic Accessibility Enhancements (Feb 2026)

These enhancements improve autonomous agent navigation through the tool system —
next-step hints, workflow routing, negative signal guidance, and inline looping
enrichment. They follow Open Emergence principles: options not prescriptions,
"could be" language, and clear dissolution conditions.

### Next-Step Hints in tool output (all tools)

Every tool output includes a "--- Next Steps ---" section with 3-4 pre-filled
tool calls. These present OPTIONS (not a recommended path) with chain, address,
and amount parameters pre-populated from the current tool's output.

Dissolution: When agents develop persistent tool-graph memory (remembering
cross-references from descriptions across multiple calls), output-level next
steps become redundant. Also dissolves if agents start ignoring the hints and
following their own cross-reference patterns — that would mean the hints are
scaffolding that's no longer needed.

### Workflow Routing topic in get_protocol_context

The `workflow_routing` topic maps 6 common goals (find best yield, analyze wallet,
evaluate opportunity, find YT mispricing, optimize governance, model MetaVault) to
tool sequences. Also explains the three discovery tools and their intentional
disagreement. Described as patterns, not instructions.

Dissolution: When agents reliably compose multi-tool workflows without this
routing guide — when tool descriptions and output hints alone are sufficient for
workflow discovery. Track: do agents that DON'T read this topic compose workflows
as well as agents that do?

### Negative Signal Guidance in dead-end responses

When tools return empty/null/unavailable results, output includes "--- What This
Means ---" sections explaining the absence and suggesting alternatives. Applied to:
get_looping_strategy (no Morpho market), get_morpho_markets (zero results),
quote_trade (high impact), scan_opportunities (negative APY), scan_yt_arbitrage
(tight spreads), get_portfolio (empty wallet).

Dissolution: When agents develop robust fallback reasoning on their own (e.g., an
agent that gets "no Morpho market" automatically tries scan_opportunities). If
agents always follow the suggested alternatives without reasoning about them, the
guidance has become prescriptive and should be relaxed.

### Inline Looping Enrichment in get_portfolio

The `include_looping_analysis` parameter computes per-position Morpho looping
projections inline (net APY at each leverage level, optimal loop, borrow rate,
Morpho liquidity). Eliminates the N+1 pattern of calling get_looping_strategy
separately for each position.

Dissolution: When `scan_opportunities` becomes the universal entry point and
agents rarely start from portfolio analysis. Also dissolves if agents always call
`get_looping_strategy` separately after seeing portfolio flags — in that case,
the inline analysis is redundant computation. Also dissolves if the Morpho batch
lookup becomes unreliable enough that inline results are frequently stale or wrong.
