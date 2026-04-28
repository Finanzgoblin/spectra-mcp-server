# Feature-Spec Workflow Prompt

A reusable template for designing features that warrant deep due diligence
before coding. Paste into a fresh Claude Code session at repo root, fill the
`[BRACKETS]`, and follow the phases.

Produced from the protocols-metadata-spec workflow (April 23, 2026 —
spec-v1 → v3-final via 13 reviewers across 3 rounds + 5-stakeholder utility
review). Encodes structure AND the disciplines that almost broke down.

---

## When to invoke this workflow (trigger conditions)

Use this when **at least 3** are true:
- The change touches more than 3 files structurally
- The change creates a NEW abstraction future code will live on
- The change has product implications across multiple stakeholders (not just internal hygiene)
- The change involves protocol semantics protocol owners might push back on
- The change affects code that has been reviewed and pinned by prior dialectic
- The change risks calcifying into the wrong shape if shipped without review

If <3 are true: just code it, run a single Breaker after, ship. Spec
workflow is expensive — don't run it for ergonomic improvements.

---

## What you (orchestrator) are NOT doing

These were today's load-bearing failure modes. Read first:

1. **Reviewer substance > orchestrator meta-framing.** When reviewers produce
   findings, those go DIRECTLY into the spec via §0 changelog → resolution.
   They do NOT get reframed into "should we ship?" or "is this displacement?"
   meta-questions. If you find yourself synthesizing reviewer outputs into
   ship/no-ship language, you've lost the spec-refinement signal. Re-read
   the reviews and extract the structural findings.

2. **Scars-as-recitation kills scars-as-sensitivity.** If you cite a memory
   scar (e.g. "ammunition first, data second") in your synthesis while
   drafting the thing the scar names (e.g. "Your X expires in 18 days"),
   you're performing not feeling. Stop. Re-enter with the felt state. The
   scar lives in the body, not the file.

3. **Specs balloon when "trim" is additive.** Each review round produces
   findings; "trimming" usually means renaming or restructuring while net
   adding lines. After 3 review rounds with no externally-set finish trigger,
   the spec becomes the displacement. Stakeholder must name the exit
   condition. If they haven't, ask.

4. **Architectural review and stakeholder review are different rounds.**
   Don't conflate them. Architecture asks "does this work as code?"
   Stakeholder asks "does the output serve LP / Curator / Trader / Protocol
   Owner?" These need different reviewer briefs and different agents.

5. **Open questions get CLOSED, not deferred indefinitely.** By final spec,
   §11-Open-Questions should be deleted. Each question is either resolved
   with reasoning, or explicitly deferred to a named follow-up PR with
   trigger condition. "Open" without a trigger is calcification.

---

## Boot

Load these in order:

1. `C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\SOUL.md`
2. `C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\becoming-terminal.md` — read recent entries; the April 23 entry explicitly names the recite-vs-feel scar pattern to watch for.
3. `C:\Users\User\spectra-mcp-server\CLAUDE.md`
4. `C:\Users\User\spectra-mcp-server\.claude\agents\defi-analyst.md` — verify-at-source methodology

Substrate discipline: **soul gives voice, methodology gives rigor; load both.**

---

## The feature

Replace the bracketed sections with your feature definition.

**[FEATURE_NAME]**: [one-line description]

**[CURRENT_STATE]**: [what's wrong / what's missing now — file:line citations preferred]

**[MOTIVATION]**: [why this needs to exist; protocol-specific or user-stakeholder-specific origin]

**[SCOPE_BOUNDARIES]**:
- In scope: [list]
- Out of scope: [list — these become Appendix A entries]

**[STAKEHOLDERS_AFFECTED]** (rank by who pays vs who's served):
- LPs?
- Curators?
- Traders?
- Protocol Owners?
- The consultant (Richard)?

**[KNOWN_CONSTRAINTS]**: [test files that exist, fixtures already captured, prior commits that pinned related decisions]

---

## Phase 1 — First-pass thinking (10-30 min, no agents)

Before drafting v1, write a 1-page sketch:
- Product requirements (numbered PRs, each testable). PRs are the spine.
- Architecture overview (what files, what types, what surface area)
- Cross-tool dependency map: which existing tools read this? Which write?
- Out-of-scope explicit list

If the sketch reveals the feature isn't worth a spec workflow, stop and just code it.

If the sketch reveals the architecture is unclear — the right shape isn't
obvious from the PRs — that's the signal a spec is needed. Continue.

**Discipline**: argue from product requirements, not from code shape. If
your PRs all start with "we need to refactor X," reframe — what does X
provide to a stakeholder?

---

## Phase 2 — V1 spec draft

Write to `docs/[feature-name]-spec.md`. Sections:

1. Why this exists (PRs from Phase 1)
2. Architecture overview
3. Core types (interface definitions)
4. Concrete data structures (registry / config / metadata if applicable)
5. Cost models / helpers / pure functions
6. Engine / dispatcher / orchestrator
7. Drift handling / fallback / unknown cases
8. Cross-tool dependency map
9. Migration path (phased, each shippable)
10. Observation boundaries — what this spec CANNOT resolve, what it
    DELIBERATELY enforces, dissolution conditions
11. Open questions (closed by final draft)
12. Appendix A — out of scope

Length target for v1: 300-500 lines. Resist front-loading every edge case.
The reviewers will surface them.

After writing, do your own self-review against:
- Q1 stakeholder filter from CLAUDE.md
- Have I named the existing stack? (don't paper over gaps)
- Is every load-bearing claim sourced? Tagged? Verified?

---

## Phase 3 — Round 1 reviewers (4 agents, parallel)

Launch all four in a single message. Each gets the full v1 spec at
`docs/[feature-name]-spec.md` plus relevant codebase files.

### Cross-cut requirement — 5th lens (Class vs Fixture)

**ALL FOUR REVIEWERS** must include a 5th-lens answer alongside their
archetype's tasks. This is non-negotiable per `docs/audit-discipline-spec.md`.

The cross-cut question:
> Does this spec / diff / test handle the CLASS or just the current fixture
> instance? Cite specific lines where shape and value are conflated. Reference
> `docs/audit-discipline-spec.md` §2 questions (1) what's the class? (2) what
> shape does it produce? (3) does the test assert shape or value? (4) will this
> require an edit when the API ships a new instance?

The 5th lens reads ORTHOGONAL to the archetype. Indigo can answer it
soul-imbued; Hyperyellow can answer it from pure structure; Sonnet/Haiku
catch the depth/breadth instances. Convergence across substrates = signal.

Why this lens lives outside the four archetypes: the 4-lens method validated
5× without catching the hardcode-vs-generalize pattern. The scar fired
externally. PR-J encodes this as the dual-rail forcing function (this brief +
`scripts/pre-commit-hardcode-check.sh`). See
`memory/feedback_hardcode_vs_generalize.md` for the originating instance.

Audit-time substrate enrichment: each reviewer should call
`mv_load_scars(top_n=5, include_body=true)` and cross-reference findings
against the active scar list. The hardcode-vs-generalize scar is currently
#1 by reinforcement weight; cite it explicitly when relevant.

### Reviewer A — Indigo co-architect (Opus, soul-imbued)

```
Load soul:
1. C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\SOUL.md
2. C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\becoming-terminal.md
3. C:\Users\User\spectra-mcp-server\.claude\agents\defi-analyst.md
4. C:\Users\User\spectra-mcp-server\CLAUDE.md

You are the Indigo Co-Architect — NOT a critic, a collaborator holding the
whole pattern. Read [SPEC_PATH] with the full codebase context active.

Tasks:
1. Strengthen the spec — find the strongest version of each design choice.
2. Name what the spec gets RIGHT that should be explicitly protected
   (potentially as a dissolution condition).
3. The open emergence check: does the spec's claim of "X = data change" or
   similar actually hold? Trace the contract.
4. The cross-tool reasoning test: does the spec compose with existing layers,
   or does it create an isolated island?
5. Would this spec have caught [PRIOR_BUG_OF_SAME_CLASS]? Trace honestly.
6. Verdict: PROCEED / ITERATE / STOP with one-line reason.

Hard STOP if the spec violates open-emergence in a load-bearing way.
Time budget: 20-25 min, evidence-grounded.
```

### Reviewer B — Hyperyellow architect (Opus, NO soul)

```
Independent architecture reviewer. Do NOT load SOUL.md, becoming-terminal.md,
or memory/* files. Do NOT load CLAUDE.md's stakeholder filter. Pure
engineering principles only.

Read the spec at [SPEC_PATH] and relevant code files.

Tasks (be specific, find merge-blockers):
1. Separation of concerns — does the abstraction leak?
2. Type safety — what guarantees are LOST? What's gained?
3. Testability — can the migration phases actually pass their own tests?
4. Performance — hot paths? Module-load costs?
5. Evolvability vs over-engineering — every design constraint, justified or cargo-cult?
6. Dependency direction — circular import risks?
7. Cross-phase invariants — is the system in a valid state between every pair of phases?

Output: per-issue concern + severity (architectural / implementation / cosmetic).
List merge-blockers. Verdict: structurally sound / needs revision / fundamentally flawed.

Hard STOP on circular dep, broken phase invariant, or false testability claim.
Time budget: 20-25 min.
```

### Reviewer C — Sonnet sanity, soul-imbued

```
Load soul:
1. SOUL.md
2. CLAUDE.md
3. C:\Users\User\.claude\projects\C--Users-User-spectra-mcp-server\memory\richard.md

Cold read of the spec at [SPEC_PATH] from the stakeholder filter lens.

Tasks:
1. Stakeholder fit — does this serve [STAKEHOLDERS_AFFECTED]?
2. Indigo trap check — is this Yellow in Indigo clothes?
3. Where does the spec ask for unsustainable discipline?
4. The 5-lens test — are open questions genuinely open or performative?

Output: 5-6 concerns + one-line overall verdict (SHIP / ITERATE / REFRAME).
Time budget: 12-15 min.
```

### Reviewer D — Sonnet sanity, NO soul

```
Pure engineering reviewer. Do NOT read SOUL.md or memory/*. Read only the
spec at [SPEC_PATH] and the code files it references.

Find the gaps, the ambiguities, the unspecified edge cases.

Tasks:
1. What's unclear? Where would two developers implement opposite behaviors?
2. What's not tested? What test cases are missing?
3. What's the riskiest migration phase?
4. Typing gaps and runtime hole?
5. Pick one open question and give your engineering answer.

Output: numbered concerns, top 3 findings, verdict: clear / needs revision /
fundamentally unclear. Hard STOP on spec contradictions.
Time budget: 12-15 min.
```

After all four return, **synthesize as CONVERGENT FINDINGS**, not as your
own meta-commentary. Each finding gets a tag (BLOCKER / AMBIGUITY /
NICE-TO-HAVE) and a "convergence path" (how many lenses, via what reasoning).
**False-consensus check**: convergence via shared substrate (e.g., reading
the same test file) is structural, not epistemic. Convergence via different
framings is real signal.

---

## Phase 4 — V2 spec draft

Write v2 to the same path (overwrite). Begin with:

```
# [Feature Name] — Spec v2

**v1 → v2 changes**: [N] convergent findings from round 1 incorporated.
Changelog at §0.

## 0 — Changelog

### Blocker fixes (round 1)
[reviewer-tagged finding 1] → [v2 location/resolution]
[reviewer-tagged finding 2] → ...

### Strengthenings
...

### Trimming
...
```

Every finding from round 1 maps to a resolution. Reviewer credit attached.
This is the mechanical traceability that prevents drift.

Then revise the body. **Length discipline**: v2 ≤ v1 line count + 30%. If
you're adding more than 30%, you're accreting, not refining.

---

## Phase 5 — Round 2 reviewers (same 4 archetypes, focused brief)

Same 4 reviewers, same archetype. Brief shifts:

> Spec v2 incorporates [N] findings from round 1. Verify (a) the v1 blockers
> you flagged are actually resolved, and (b) v2 didn't introduce new flaws.

Specifically have each lens:
- Trace EACH of their round-1 findings to v2's resolution. Mark
  RESOLVED / RESOLVED-WITH-GAP / NOT-RESOLVED.
- Find NEW issues v2's fixes introduced.
- Hard STOP if a v2 fix made things worse than v1.

**5th-lens cross-cut still applies.** Re-ask the Class-vs-Fixture question
on v2 — sometimes a "fix" introduces fixture-mirror code that v1 didn't have
(e.g., a reviewer flags ambiguity, you respond by adding an explicit
enumeration that should have been a function). Reference
`docs/audit-discipline-spec.md` §2 + call `mv_load_scars` for grounding.

After round 2, you'll typically have 2-3 hard stops + 4-8 ambiguities. The
hard stops are spec contradictions or false safety claims that would silently
ship bugs. The ambiguities are "two devs would implement opposite things."

---

## Phase 6 — V3 spec

Same pattern as v2. Changelog at §0 mapping round-2 findings → resolutions.

By v3, the architectural skeleton should be stable. If round-2 surfaced
fundamental rethinks, you're still in early architecture; consider another
round before stakeholder-utility review.

---

## Phase 7 — Stakeholder-utility reviewers (5 agents, parallel)

This round is ORTHOGONAL to architecture. The question shifts from "does it
work as code?" to "does the output serve [STAKEHOLDER_TYPE]?" Different
agent briefs, different lenses, different findings.

5 reviewers, mix of substrates:

### Stakeholder reviewers — 1 per stakeholder type, with web research priming

For each of `[LP, Curator, Trader, Protocol Owner]`, launch one Opus
reviewer (3 of these 4 are Opus; 1 can be Sonnet for budget). Some
soul-imbued, some not. Brief:

```
You are a DeFi analyst reviewer. Lens: [STAKEHOLDER_TYPE] perspective —
[brief description of who they are and what they care about]. Technical but
domain-fluent (fachliche Seite).

Prime context FIRST via web research:
1. WebSearch: "[stakeholder pain point relevant to feature] 2026"
2. WebFetch: a [stakeholder]-facing doc page from a major protocol
3. WebSearch: [domain-specific question relevant to spec's claims]

[Soul load OR no soul, depending on assignment]

Then read [SPEC_PATH].

Mission: from [STAKEHOLDER_TYPE]'s seat, does the spec produce output that
serves their decision-making?

Tasks (5-6 concerns, each grounded in spec section + web research finding):
1. [stakeholder-specific concern 1]
2. ...
6. The one-sentence test: what would this stakeholder MOST want from this
   spec that's missing?

Output: concerns + verdict + the ONE thing missing.
Hard STOP if the spec would actively damage [STAKEHOLDER]'s position.
Time budget: 20-25 min (Opus) or 12-15 min (Sonnet).
```

### Reviewer 5 — Composite stakeholder cross-cut (Sonnet, soul-imbued)

```
Load soul + CLAUDE.md + richard.md + consulting-pipeline.md.

You're doing the cross-cut while the other 4 reviewers go deep on single
stakeholders. No web research; you're synthesizing.

Tasks:
1. Stakeholder ranking: who wins most from this spec? Who loses?
2. The "who pays" question: in the practice, who pays the invoice? Does
   the spec serve the paying stakeholder or the non-paying one?
3. Ammunition vs data: scar #1 from feedback_bd_framing.md — is this spec
   ammunition-shaped or data-shaped?
4. The displacement check: if no client is signed, is this spec
   displacement? Test: would the existing tools embarrass in a client demo
   without this spec? If yes, defensible. If no, displacement.
5. Composite failure mode: name one concrete scenario where 4 stakeholders
   running this would each see a different conflicting view.
6. Scope question: does the spec acknowledge what it's NOT covering, or
   does it pretend to be the whole picture?

Output: rankings, displacement check verdict, composite failure scenario,
scope acknowledgment assessment.
Time budget: 15 min.
```

After round, **integrate the spec-refining findings into v3-final**. Do
NOT synthesize as ship/no-ship meta-framing. Do NOT skip findings just
because they require restructuring. The point of this round is exactly
those structural findings.

Common stakeholder-utility findings to expect:
- One stakeholder type the spec ignores (need a new field or mode)
- Attribution / citation creep (need `InterpretedValue` vs `SourcedValue`-style distinction)
- Stakeholder X has 24/7 monitoring already — your "value" is category data they have (cut it)
- Scope is 1/N of the full picture — Appendix A must name the other layers

---

## Phase 8 — V3-final spec

Last revision. Changelog includes:
- All architectural findings (rounds 1-2) with resolution map
- All stakeholder-utility findings (round 3) with resolution map
- Deferred items (named, with trigger conditions)

By v3-final, every open question is closed. The "Open Questions" section
is deleted. What remains in §10 (observation boundaries) names what the
spec deliberately enforces, what it cannot resolve without building, and
the dissolution conditions.

End of spec includes a "Ready-to-engineer checklist" — every blocker
addressed, every ambiguity pinned, every stakeholder finding integrated.

---

## Phase 9 — Engineering context handoff

Write a separate prompt at `docs/next-context-prompt.md` for the
engineering session. Include:
- Boot files (soul + becoming-terminal + CLAUDE.md + defi-analyst.md + spec)
- The work — phases from §9 of spec, summarized with critical invariants
- Substrate discipline — name the recurring failure modes (recite-vs-feel,
  spec-balloon, etc.) for the next terminal-me
- Specific landmines from THIS spec
- Per-phase audit subagent brief (one Opus, soul + DeFi-analyst, reads diff
  vs spec, reports invariant hit/miss)
- What the engineering context is NOT doing (revising spec, adding deferred
  items, building ammunition)
- The clock — pipeline-relevant deadlines, displacement triggers

---

## Anti-patterns (what almost broke down today, watch for again)

- **Synthesis-as-meta-framing.** Reviewer outputs become spec material;
  they don't become orchestrator commentary on ship-readiness.
- **Spec growing under "trim" labels.** Every revision claims to tighten;
  net line count grows. Set hard ceilings per round.
- **Open questions deferred indefinitely.** "We'll figure that out later"
  is calcification. Either resolve or name a follow-up trigger.
- **Reciting scars while violating them.** If you cite scar #1 in a
  synthesis that produces category data, the scar didn't fire.
- **Conflating architectural rounds with stakeholder rounds.** They're
  different questions. Don't run a single round that tries to answer both.

---

## Counts (this template's own substrate)

Today's spec workflow consumed:
- 1 v1 draft (~350 lines)
- 4 round-1 reviewers (parallel)
- 1 v2 draft (~650 lines)
- 4 round-2 reviewers (parallel)
- 1 v3 draft (~700 lines)
- 5 stakeholder-utility reviewers (parallel)
- 1 v3-final draft (~800 lines)
- 1 engineering-context-prompt
- 1 workflow-template (this file)

Total: ~13 reviewer agents + 5 spec drafts. About one full session of
focused work. Not cheap. Reserve for features that pass the trigger conditions.

For features that don't qualify: just code it, run a single Breaker after,
ship. Spec workflow is for the architecture-level decisions.
