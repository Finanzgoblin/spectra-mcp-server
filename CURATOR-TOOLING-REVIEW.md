# MetaVault Curator-as-a-Service: Strategy & Tooling Review

**Date:** 2026-03-06
**Scope:** Evaluating the MetaVault MCP toolset for running a professional MetaVault curation business

---

## Executive Summary

The MetaVault MCP server provides a strong **deal origination and modeling** pipeline for MetaVault curators. The three curator-specific tools (`spectra_list_metavaults`, `spectra_model_metavault`, `spectra_get_curator_dashboard`) form a coherent workflow from discovery → modeling → monitoring. Combined with `mv_scan_curator_opportunities` for cross-protocol sourcing and `spectra_get_looping_strategy` for leverage analysis, the pre-deployment toolkit is excellent.

**The critical gap is post-deployment risk management.** The tools help you decide *where* to deploy but don't adequately help you *stay safe* after deploying. For a curator-as-a-service business where you manage other people's capital, this is the difference between a good run and a catastrophic loss.

---

## What the Toolkit Gets Right for Curators

### 1. The Dual Morpho Market Flywheel Model (`spectra_model_metavault`)
The documentation and modeling of the dual-market flywheel (Market A for external PT loopers, Market B for curator MV share looping) is genuinely novel. The tool correctly models:
- Blended Spectra + Pendle allocation with `pendle_allocation_pct`
- Curator fee economics separated from depositor yield
- Loop table with effective margin (liquidation buffer) per loop count
- Side-by-side PT looping comparison to justify the MetaVault premium

**Strength:** This is your sales tool. When pitching depositors, you can show exactly how the flywheel creates yield that raw PT looping can't match.

### 2. Cross-Protocol Sourcing (`mv_scan_curator_opportunities`)
The unified Spectra + Pendle scanner with maturity matching is exactly what a curator needs. Key features:
- Capital-aware impact using protocol-appropriate models (constant-product for Spectra, logit AMM for Pendle)
- Hypothetical Morpho looping for PTs *without* existing markets (market creation signal)
- Hyperliquid funding rates for delta-neutral cost budgets on non-stablecoin underlyings
- `mvGrossEstimatePct` = LP APY + 30% variable APR as a quick MetaVault gross estimate
- `bestStrategy` tagging (pt_spot / lp / pt_loop) per opportunity

**Strength:** This replaces hours of manual spreadsheet work across two protocols.

### 3. Operational Dashboard (`spectra_get_curator_dashboard`)
The dashboard auto-generates the right action items:
- Position maturity countdown with urgency tiers (7d/14d/30d)
- Idle capital detection (>20% threshold)
- Outflow trend detection (3 consecutive epochs)
- Incentive dependency warning (>70% from programs)
- Pendle rollover warnings (MetaVault auto-roll doesn't cover Pendle)
- Protocol detection (Spectra vs Pendle vs Unknown) for each position

**Strength:** This is your daily operations screen. The action items alone justify the tool.

### 4. Supporting Tools That Complete the Workflow
- `mv_check_ibt_health` — Pre-deployment due diligence on underlying vaults (conversion rate divergence, APR composition, pool balance)
- `spectra_get_pool_capacity` — Quote ladder to find sweet spot before deploying capital
- `morpho_get_rate` + `morpho_get_history` — Borrow rate monitoring and trend analysis
- `morpho_get_market_suppliers` — Understand who supplies lending liquidity (concentration risk)
- `spectra_get_ve_info` — Compute exact boost economics for veSPECTRA allocation decisions

---

## Critical Gaps for Curator-as-a-Service

### Gap 1: No Liquidation Distance Monitoring — ✅ SHIPPED

> **Implemented as:** `morpho_monitor_risk` in `src/tools/risk_monitor.ts`

**Impact: Catastrophic** — This is the #1 risk for a leveraged curator.

The tools show `effectiveMargin` at entry time but never revisit it. A curator running 3-4 loops on MV shares needs to know:
- Current health factor across all Morpho positions
- How far PT price can drop before liquidation triggers
- Early warning when margin deteriorates (e.g., borrow rate spikes eating into buffer)

`morpho_get_positions` exists and shows health factor, but there's no **alerting logic** or **distance-to-liquidation calculation**. The curator dashboard doesn't surface Morpho position health at all.

**Recommendation:** Add a `morpho_monitor_risk` tool or extend `spectra_get_curator_dashboard` to:
1. Fetch the curator's Morpho positions via `morpho_get_positions`
2. Compute liquidation price for each position (PT price at which health factor = 1.0)
3. Show current distance-to-liquidation as a percentage
4. Flag positions where borrow rate has moved significantly since entry

### Gap 2: No Withdrawal Liquidity Stress Testing — ✅ SHIPPED

> **Implemented as:** `spectra_stress_test_vault` in `src/tools/stress_test.ts`

**Impact: High** — ERC-7540 vaults have epoch-based withdrawals.

The dashboard shows deposit/withdrawal flows but doesn't model:
- What happens if X% of depositors request redemption in one epoch?
- Can the vault meet redemptions without unwinding LP positions at a loss?
- What's the liquidity waterfall? (idle cash → mature PT → LP exit → forced PT sale)

For a curator-as-a-service, a redemption queue failure is reputational death.

**Recommendation:** Add a `stress_test_redemptions` parameter to `spectra_get_curator_dashboard` or a standalone tool that:
1. Takes a redemption percentage (e.g., 30%)
2. Models the vault's ability to meet it from: idle capital → naturally maturing positions → LP removal (with impact from `spectra_get_pool_capacity`)
3. Outputs the expected loss to remaining depositors

### Gap 3: No Position Rollover Planning — ✅ SHIPPED

> **Implemented as:** `mv_plan_rollover` in `src/tools/rollover.ts`

**Impact: High** — Rollover is the curator's primary recurring operational task.

The dashboard warns when positions approach maturity but doesn't help plan the rollover:
- Which new pool should this capital roll into? (needs `mv_scan_curator_opportunities` integration)
- What's the expected gap period (maturity → new position entry)?
- What's the entry cost for the new position at the current vault allocation size?
- Is there a maturity overlap opportunity (enter new position before old one matures)?

**Recommendation:** Add a `mv_plan_rollover` tool that:
1. Takes the expiring position's details and capital amount
2. Runs `mv_scan_curator_opportunities` filtered to the same underlying
3. Computes entry impact for the vault's allocation size
4. Shows the expected yield gap during transition
5. Flags maturity overlap windows

### Gap 4: Borrow Rate Path Modeling for Leveraged Positions

**Impact: Medium-High** — Variable borrow rates are the silent killer of looping strategies.

`spectra_get_looping_strategy` shows borrow rate sensitivity at +1/+2/+3%, and `morpho_get_history` shows historical trends. But neither answers: **"Given the historical volatility of this market's borrow rate, what's the probability my loop goes underwater before maturity?"**

The curator's leverage amplifies this: at 4x leverage on MV shares, a 2% borrow rate increase wipes out ~6% of gross yield.

**Recommendation:** Extend `morpho_get_history` or add analysis to `spectra_model_metavault` that:
1. Computes historical borrow rate volatility (std dev from `morpho_get_history` data)
2. Shows probability of break-even borrow rate being hit within the maturity period (assuming mean-reversion or random walk)
3. Recommends a "safe" loop count that survives the 95th percentile rate scenario

### Gap 5: No Multi-Position Portfolio View for Curators — ✅ SHIPPED

> **Implemented as:** `mv_get_curator_portfolio` in `src/tools/curator_portfolio.ts`

**Impact: Medium** — A real curator manages multiple MetaVaults or a single vault with many positions.

`spectra_get_curator_dashboard` shows one vault at a time. `morpho_get_positions` shows all Morpho positions but doesn't link them back to MetaVault context. There's no:
- Aggregate view across all managed vaults
- Total AUM, total fee revenue, blended APY
- Cross-vault concentration analysis (e.g., 80% in one underlying)
- Cross-chain capital efficiency view

**Recommendation:** Add a `mv_get_curator_portfolio` tool that:
1. Takes a list of MetaVault addresses (or a curator address to discover them)
2. Aggregates dashboard data across all vaults
3. Shows concentration by underlying, chain, and protocol
4. Computes total fee revenue projection

### Gap 6: No Gas Cost Modeling for Loop Execution

**Impact: Medium** — Loops are multi-transaction. Gas costs eat into the edge.

None of the looping tools account for gas costs. On Ethereum mainnet at high gas prices, a 5-loop strategy requires ~10 transactions (5× deposit + 5× borrow), and gas can consume a meaningful portion of yield on smaller capital sizes.

**Recommendation:** Add a `gas_cost_estimate` field to `spectra_get_looping_strategy` and `spectra_model_metavault` that:
1. Estimates gas per loop iteration (deposit + borrow ≈ 300K-500K gas)
2. Fetches current gas price via RPC
3. Shows total gas cost as % of expected annual yield
4. Warns when gas cost exceeds a threshold (e.g., >5% of annual yield)

### Gap 7: Historical Performance Tracking

**Impact: Medium** — A curator-as-a-service needs a track record.

There's no way to show: "My vault has delivered X% APY over Y months with a max drawdown of Z%." The epoch data in `spectra_get_curator_dashboard` is the raw material but isn't processed into performance metrics.

**Recommendation:** Add performance metrics to `spectra_get_curator_dashboard`:
1. Time-weighted return (from share price history in epochs)
2. Max drawdown (from share price series)
3. Sharpe-like ratio (return / volatility of epoch returns)
4. Comparison vs benchmark (e.g., raw USDC lending rate on Morpho)

---

## Workflow Gaps (Not Tool Gaps)

### The Curator Lifecycle Is Missing a Playbook

The tools exist but the *sequence* for a curator-as-a-service isn't documented. The ideal workflow:

1. **Source** — `mv_scan_curator_opportunities` → find best risk-adjusted pools
2. **Diligence** — `mv_check_ibt_health` → verify underlying vault safety
3. **Size** — `spectra_get_pool_capacity` → determine max deployment per pool
4. **Model** — `spectra_model_metavault` → project economics with leverage
5. **Compare** — `spectra_get_looping_strategy` → benchmark vs raw PT looping
6. **Deploy** — (manual, not tooled)
7. **Monitor** — `spectra_get_curator_dashboard` → daily ops + action items
8. **Rebalance** — `morpho_get_rate` + `morpho_get_history` → track borrow costs
9. **Rollover** — `mv_plan_rollover` → find candidates, compare entry impact, yield gap analysis ✅
10. **Risk** — `morpho_monitor_risk` → liquidation distance, borrow rate drift, alert levels ✅
11. **Stress** — `spectra_stress_test_vault` → withdrawal liquidity waterfall, market stress simulation ✅
12. **Aggregate** — `mv_get_curator_portfolio` → multi-vault AUM, blended APY, concentration ✅
13. **Report** — [GAP] — no historical performance reporting for depositors

### Pendle Integration Is Half-Complete

`mv_scan_curator_opportunities` sources Pendle markets beautifully, but:
- Pendle looping is marked "future phase" — curators who allocate to Pendle can't model leverage
- Pendle LP exit mechanics differ from Spectra (no StableSwap pool) — capacity analysis doesn't apply
- `mv_check_ibt_health` direct mode works for Pendle SY tokens, which is good

### MetaVault Share Looping (Market B) Isn't Directly Quotable

`spectra_model_metavault` models the economics of MV share looping, but there's no way to:
- Check if a Morpho market for MV shares actually exists (would need `morpho_list_markets` with MV share address)
- Get a live borrow rate for MV share collateral
- Assess MV share liquidity for liquidation scenarios

The tool assumes the curator will create this market, but once live, monitoring tools should track it.

---

## Priority Ranking for Curator-as-a-Service

| Priority | Gap | Effort | Business Impact | Status |
|----------|-----|--------|-----------------|--------|
| P0 | Liquidation distance monitoring | Medium | Prevents catastrophic loss | ✅ Shipped |
| P0 | Withdrawal stress testing | Medium | Prevents reputational death | ✅ Shipped |
| P1 | Position rollover planning | Medium | Core operational workflow | ✅ Shipped |
| P1 | Borrow rate path modeling | Low-Medium | Risk-adjusted loop decisions | Open |
| P2 | Multi-vault portfolio view | Medium | Scales the business | ✅ Shipped |
| P2 | Historical performance tracking | Low | Depositor acquisition tool | Open |
| P3 | Gas cost modeling | Low | Improves small-capital accuracy | Open |

---

## What's Already Excellent (Keep As-Is)

1. **Dual Morpho market flywheel documentation** in `metavault.ts` header comments — best explanation of the curator value proposition I've seen
2. **Capital-aware impact filtering** across all scanners — prevents false signals from illiquid pools
3. **Merkl campaign integration** — curators need to know incentive composition vs organic yield
4. **Hypothetical Morpho loop projections** for markets that don't exist yet — the market creation signal is a curator's edge
5. **Action item generation** in the dashboard — operational alerts should be automated, and they are
6. **Cross-protocol maturity matching** — the 90-day window matching between Spectra and Pendle is exactly how curators think about allocation
7. **veSPECTRA boost computation** threaded through the scanners — boost economics directly affect curator returns

---

## Bottom Line

**For deal origination and pre-deployment modeling: 9/10.** The tools are comprehensive, capital-aware, and cross-protocol. A curator can go from "I have $X to deploy" to "here's my optimal allocation with projected economics" in under 5 minutes.

**For post-deployment risk management: 8/10.** *(Updated from 4/10)* Liquidation monitoring (`morpho_monitor_risk`), withdrawal stress testing (`spectra_stress_test_vault`), and rollover planning (`mv_plan_rollover`) are now shipped. Remaining gaps: borrow rate path modeling (probabilistic risk), historical performance tracking.

**For running it as a business: 8/10.** *(Updated from 6/10)* Multi-vault portfolio aggregation (`mv_get_curator_portfolio`) is shipped. Remaining gap: historical performance reporting for depositor acquisition.

All P0 gaps are resolved. The curator-as-a-service tooling is now ready for scaling external deposits.

---

## References & Risk Frameworks

### Industry Risk Frameworks
- [Institutionalizing Risk Curation in Decentralized Credit](https://arxiv.org/html/2512.11976v1) — Academic paper on formalizing curator risk management in DeFi lending
- [DeFi Curators in 2025: Navigating Chaos, Building Resilience](https://chorus.one/reports-research/defi-curators-in-2025-navigating-chaos-building-resilience) — Post-mortem of 2025 curator failures (Stream Finance collapse, Gauntlet vault pause, Balancer exploit cascade)
- [Risk Curators Took Off in 2025 but Led to DeFi Lending Vault Troubles](https://www.cryptopolitan.com/risk-curators-took-off-in-2025-but-led-to-recent-defi-lending-vault-troubles/) — Analysis of systemic risks in the $7B curator market
- [Gauntlet VaultBook: Curation Methodology and Risk Factor Overview](https://vaultbook.gauntlet.xyz/morpho-vaults/curation-methodology-and-risk-factor-overview) — Gauntlet's public risk framework for Morpho vault curation (Prime/Core/Frontier tiers, agent-based simulation methodology)
- [Gauntlet VaultBook: Risk Exposure](https://vaultbook.gauntlet.xyz/vaults/morpho-vaults/vault-curation-considerations-a-deeper-dive/risk-exposure) — Insolvency modeling under stress (target: <10bps insolvent debt under extreme scenarios)
- [Gauntlet VaultBook: Automated Risk Management Solutions](https://vaultbook.gauntlet.xyz/vaults/morpho-vaults/curation-methodology-and-risk-factor-overview/automated-risk-management-solutions) — Automated monitoring and reallocation methodology
- [Steakhouse Financial: DeFi's Powerhouse Risk Curator](https://blog.summer.fi/meet-the-yield-sources-steakhouse-defis-powerhouse-risk-curator/) — Steakhouse's 5-dimensional risk framework (credit, operational, governance, technical, liquidity)
- [IOSG: Who Is the "New Species" Curator Bridging the Gap?](https://www.techflowpost.com/en-US/article/30440) — Curator market landscape and risk/reward spectrum analysis

### Morpho Liquidation & Pre-Liquidation Mechanics
- [Morpho Docs: Liquidation](https://docs.morpho.org/learn/concepts/liquidation/) — Core liquidation mechanics (no close factor, LIF formula, bad debt socialization)
- [Morpho Docs: Pre-Liquidation (Auto-Deleverage)](https://docs.morpho.org/build/borrow/concepts/preliquidation) — Opt-in partial liquidation mechanism (preLLTV/preLCF/preLIF parameters)
- [Introducing Pre-Liquidations: Enhanced Loan Management on Morpho](https://morpho.org/blog/introducing-pre-liquidations-enhanced-loan-management-on-morpho/) — Design rationale and borrower benefits
- [Morpho Blue Liquidation Bot (GitHub)](https://github.com/morpho-org/morpho-blue-liquidation-bot) — Reference liquidation bot with PT token swap support
- [Morpho Pre-Liquidation Contract (GitHub)](https://github.com/morpho-org/pre-liquidation) — Audited contract implementation (Spearbit + ABDK)
- [Morpho Docs: Risk & Security](https://docs.morpho.org/learn/resources/risks) — Oracle risk, market isolation, bad debt handling
- [Morpho Blue Whitepaper](https://resources.cryptocompare.com/asset-management/17952/1732199021661.pdf) — Formal specification of lending mechanics
- [Behind Morpho's Leverage Crisis](https://www.panewslab.com/en/articles/300d4af9-ec86-4a93-8826-6a99d9c4ad8c) — Analysis of incomplete decentralization risks in Morpho curator model
- [Morpho Curator Tool Suite](https://docs.morpho.org/curate/tool-suite/) — Official curator tooling documentation

### ERC-7540 (Async Vault Standard)
- [ERC-7540 Specification](https://eips.ethereum.org/EIPS/eip-7540) — The standard MetaVaults implement for async deposit/redemption
- [ERC-7540 Discussion (Ethereum Magicians)](https://ethereum-magicians.org/t/eip-7540-asynchronous-erc-4626-tokenized-vaults/16153) — Design decisions and implementation considerations
- [ERC-7540 vs ERC-4626: Async Settlement for RWA Vaults](https://www.zealynx.io/blogs/erc-7540-asynchronous-settlement) — Comparison and risk implications (unbacked token issuance, settlement reverts)
- [QuillAudits: ERC-7540 Asynchronous Vaults](https://www.quillaudits.com/research/rwa-development/relevant-standards/erc-7540-async-erc-4626-tokenized) — Audit perspective on request lifecycle and edge cases

### Spectra Protocol Documentation
- [Spectra Curator Docs: Whitelisted Actions](https://curator.docs.spectra.finance/technical/whitelisted-actions) — Technical curator operations (SAFE transactions, role-based access)
- [Spectra Docs: Overview](https://docs.spectra.finance/) — Core protocol documentation
- [Spectra Docs: Principal & Yield Token](https://docs.spectra.finance/core-concepts/principal-and-yield-token) — PT/YT mechanics
- [Spectra MetaVaults App](https://app.spectra.finance/metavaults) — Live MetaVault discovery
- [Spectra: MetaVaults — Bringing Curators to the Yield Tokenization Sector](https://paragraph.com/@spectra/metavaults-bringing-curators-to-the-yield-tokenization-sector) — MetaVault design rationale and curator role definition
- [Spectra Core (GitHub)](https://github.com/perspectivefi/spectra-core) — Smart contract source code
- [Spectra Developer Docs: Tokenizing Yield](https://dev.spectra.finance/guides/tokenizing-yield) — Technical integration guide

### Market Context
- [Morpho Complete Review for 2026](https://stablecoininsider.org/morpho-complete-review-for-2026/) — Current state of Morpho ecosystem including Apollo partnership
- [DeFi Yield Competition: Pendle and Rising Star Spectra](https://www.panewslab.com/en/articles/702hzjqg) — Competitive landscape analysis (looping flywheel comparison)
- [Gauntlet: Introducing the VaultBook](https://www.gauntlet.xyz/resources/introducing-the-gauntlet-vaultbook-demystifying-vault-curation) — Industry benchmark for curator transparency
