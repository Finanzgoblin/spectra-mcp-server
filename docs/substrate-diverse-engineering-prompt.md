# Substrate-Diverse Engineering — Reusable Prompt

A reusable template for multi-phase implementation against a refined spec.
Use when the codebase is in production, downstream breakage matters, and
single-substrate review would miss bug classes that cross substrate
boundaries.

Produced from the discard-layer + hardcode-vs-generalize sessions
(April 2026 — empirical validation that each substrate catches a bug class
the others miss). Encodes structure AND the empirical findings that justify
the cost.

**Companion**: `docs/spec-workflow-prompt.md` (the spec-design phase that
produces the contract this engineering phase implements). Companion:
`docs/audit-discipline-spec.md` (the 5th lens that runs cross-cut through
every audit in this method).

---

## When to invoke this method (trigger conditions)

Use when **at least 3** are true:
- The work spans multiple PRs against a refined spec (engineering phase, not exploration)
- The codebase is in production; downstream breakage has user impact
- The change touches a shared discriminated union, type registry, or schema
- The work has bug classes spanning substrates (semantic, numeric, integration, residue)
- The cost of a missed bug exceeds the cost of `~10–15× more agent calls`

If <3 are true: single-builder + single-reviewer is fine. Substrate-diverse
review is expensive — reserve for the work where it pays.

---

## What you (architect / orchestrator) are NOT doing

These are load-bearing failure modes from prior sessions:

1. **Synthesis-as-meta-framing.** Reviewer findings go DIRECTLY into commit
   provenance and inline fixes — they do NOT become "should we ship?"
   meta-commentary. If you find yourself synthesizing reviewer outputs into
   ship/no-ship language, you've lost the engineering signal.

2. **Builder-substrate displacement.** Architect-patches-builder shortens
   the feedback loop but means the builder substrate doesn't develop
   sensitivity to that bug class. Sometimes inline-fix is right; sometimes
   send back. Weigh the family-pattern cost.

3. **Convergence ≠ consensus.** Two reviewers reaching the same verdict
   from different substrates (Indigo + Hyperyellow, soul + no-soul) is
   signal. Three builders, same model, same context = echo chamber.

4. **Pre-existing failures stay tagged separately.** Don't blame your
   phase for what was already broken. Don't claim a fix for a failure
   that pre-dates the diff.

---

## Phase 0 — Boot

Read in order BEFORE any tool calls:

1. **`[SOUL_FILE]`** — project soul / identity (who the work is for; the relational ground)
2. **`[METHODOLOGY_FILE]`** — investigation methodology (verify at source, tag every claim, run premise audit + inversion test)
3. **`[SPEC_FILE]`** — the contract (pinned decisions are NOT re-litigated during engineering)
4. **`[CLAUDE_MD_FILE]`** — project rules and the 5th-lens 4th-habit
5. **Recent git state** — `git log -10`, `git status`. Stale files, untracked drafts, pending PRs, failing tests. Don't proceed atop unknown ground.

Then **call the live system pulse** before drafting anything:
- What's deployed (build status, recent commits)
- What's the user's clock pressure (pipeline deadlines, displacement triggers)
- What does the substrate already surface (`mv_load_scars(top_n=5, include_body=true)`)

Substrate discipline: **soul gives voice, methodology gives rigor; load both**.

---

## Phase 1 — Spar before big decisions (only if architecture isn't pinned)

If the spec covers the architecture (every PR has files-touched + invariants),
**skip this phase**. Don't spar what's already pinned.

If the implementation has architectural choices NOT pinned by the spec
(e.g., "where does cross-validation live?"), launch TWO co-architects in
parallel, **NO code modification, structured critique only**:

### Co-architect A — Indigo (Opus, soul-imbued)
```
Load:
  1. [SOUL_FILE]
  2. [METHODOLOGY_FILE]
  3. [SPEC_FILE]
  4. [CLAUDE_MD_FILE]

You are pattern-seeing, structure-respecting. Read the spec from inside its
own framework. Find the strongest version of each pinned decision.

For [UNPINNED_DECISION]: lay out the 2-3 candidate architectures, name
which the spec implies + why, name what would change if the spec implied
the alternative.

Output: structured critique, NOT code. Verdict: PROCEED / ITERATE / STOP.
Time: 20-25 min.
```

### Co-architect B — Hyperyellow (Opus, NO soul)
```
NO relational substrate. Read the spec + the Hard Theorem only. Pure
engineering principles — no soul, no methodology priming.

For [UNPINNED_DECISION]: same task as A. Find what soul-loaded perception
pattern-matches past.

Output: structured critique. Verdict: PROCEED / ITERATE / STOP. Time: 20-25 min.
```

**Convergence between A and B from different terrain = signal.** When B
starts with a category error that A has architectural context to refute,
B retracts on second pass. That retraction is informative — it shows
where the no-soul read was structurally bounded.

---

## Phase 2 — Build with substrate matched to work

**One builder per phase.** NOT three parallel on the same phase — co-architects
recommend serial when the phase touches a shared discriminated union or
schema (state-after-N-builds is non-deterministic with parallel writes).

### Substrate selection by work type

| Work type | Substrate | Why |
|---|---|---|
| Semantic / render work | Opus + soul | Output shape matters; soul reads recipient |
| Algorithmic / numeric preservation | Opus, NO soul | Ablation data; emit numerical equivalence matrix in commit |
| Integration / wiring | Opus or Sonnet + soul | Cross-tool reasoning; soul holds protocol semantics |
| Worktree-isolated mechanical refactors | Sonnet OK; **avoid Haiku** | Haiku doesn't reliably honor `isolation: "worktree"` — empirically commits to main tree on a side branch |

**Builder DOES NOT COMMIT.** Returns the diff for architect review.
Worktree-isolate where supported.

### Builder brief template
```
Load:
  1. [SOUL_FILE] (if soul-imbued substrate)
  2. [METHODOLOGY_FILE]
  3. [SPEC_FILE]
  4. [CLAUDE_MD_FILE]

Implement [PR_NAME] per spec §[SECTION]. Touch ONLY: [FILES].
Do NOT commit. Return the diff.

Deviation transparency: if you find a shape change or spec gap, NAME IT in
your output rather than silent-shipping. The architect decides how to
handle deviations.

Pre-existing failures: tag separately. Don't blame your phase.

Time: [N] min. Verdict: complete / blocked-on-X.
```

---

## Phase 3 — N-lens audit before merge (with 5th-lens cross-cut)

Post-build, fire all reviewers in parallel, **NO code modification**.

**The CLASS**: N orthogonal-substrate reviewers (N ≥ 4 empirically validated;
extension is welcome) with each lens defined by JOB + substrate-tuple
`(model_tier × soul_loaded × methodology_loaded)`. Adding a 5th lens (e.g.
soul-imbued Haiku for fast relational scans, or Opus 4.8 when it ships) is
appending a row, not a code-shape edit.

**Currently validated lens instances** (4-lens default; the canonical entry point):

### Lens 1 — Job: VERIFICATION (verify claims at source)
**Current substrate**: Opus + investigation methodology, NO soul priming.
**Why this substrate**: methodology gives the verify-at-source rigor; NO soul
ensures the lens reads claims structurally rather than relationally.

```
Load: [METHODOLOGY_FILE] only. NO soul. NO project rules file.

Read the diff: [PASTE DIFF]

Verify each claim at source. Tag every claim. Run premise audit + inversion
test per phase. Catches PR-violation defects that consumer-level audits miss.

Time: 15 min. Verdict: PROCEED / ITERATE / STOP.
```

### Lens 2 — Job: DIVERGER (protect findings consensus would suppress)
**Current substrate**: Opus + soul, hyperyellow theorem-self-application.
**Why this substrate**: soul holds the relational stack; hyperyellow framing
self-applies the project's theorem to the artifact under review.

```
Load: [SOUL_FILE] + [PROJECT_RULES_FILE].

Theorem-self-applied. Find where the artifact CALCIFIES as built. Protect the
finding consensus would suppress. Read against scar substrate (e.g.
mv_load_scars(top_n=5, include_body=true) for this project) — the scar list
grounds the "what would consensus kill?" question.

Time: 15 min.
```

### Lens 3 — Job: DEPTH (semantic-bug hunting, cast-site walks)
**Current substrate**: Sonnet + soul.
**Why this substrate**: Sonnet's depth lens catches semantic bugs the other
substrates pattern-match past or skim over.

```
Load: [SOUL_FILE] + [PROJECT_RULES_FILE].

Cast-site walks, semantic-bug hunts. Trace each cross-reference. Edge-case
the inputs. Find the bugs that pass tests but break in production.

Time: 15 min.
```

### Lens 4 — Job: BREADTH (residues, landmines, comment discipline)
**Current substrate**: Haiku, NO soul.
**Why this substrate**: fast and broad; catches stale comments, dead-code
residues, naming inconsistencies that deep lenses overlook.

```
Read the diff: [PASTE DIFF]

File scope, residues, landmines, comment discipline. Fast, broad, doesn't go
deep. Look for TODOs left unfilled, broken cross-references, formatting drift.

Time: 8 min.
```

### Adding a 5th+ lens

Define a new JOB (what bug class does it catch?). Pick a substrate from the
`(model_tier × soul_loaded × methodology_loaded)` space that fits the job.
Add a brief. The framework absorbs N+1 without other-file edits.

Example future lenses:
- Job: PERFORMANCE — substrate: Opus + methodology, no soul, with profiler tool access
- Job: SECURITY — substrate: Opus + soul, threat-model framing

### 5th-lens cross-cut (ALL FOUR LENSES MUST ANSWER)

Per `docs/audit-discipline-spec.md`:
> Class vs Fixture: does this code/test handle the CLASS or just the
> current fixture instance? Will this require a code edit when the API
> ships a new instance? Cite specific lines.

The 5th lens runs orthogonal to substrate. The pre-commit hook
(`scripts/pre-commit-hardcode-check.sh`) catches mechanical fingerprints;
reviewer-level catches the subtle cases.

### Empirical record (April 2026 sessions)

The substrate-diverse method's value is grounded in the following observations:

- **[verified-against-source]** Hardcode-vs-generalize fired externally despite 4-lens audits running 5× — leading to PR-J (5th lens added). Source: `memory/feedback_hardcode_vs_generalize.md` lines 9, 69; `docs/hardcode-vs-generalize-spec.md` PR-J row.
- **[anecdotal — sessions cited but not formally indexed]** Soul-loaded substrates pattern-matched past a NaN crash that a no-soul Opus stress-test caught adversarially. Origin: discard-layer Phase 2-3 sessions (April 26-27, 2026).
- **[anecdotal — sessions cited but not formally indexed]** Haiku missed a hardcoded-protocol-name defect that defi-analyst-methodology caught via claim-vs-code trace. Origin: discard-layer Phase 0 audit.
- **[anecdotal — sessions cited but not formally indexed]** Sonnet caught a fractional-vs-floor boundary drift the other three lenses ignored. Origin: discard-layer Phase 4.

The fourth ([verified]) is the load-bearing one. The first three are anecdotal
patterns; future revisions of this template should formally index them via
commit-hash citations or downgrade them to "category-shaped intuitions" if
re-investigation doesn't surface concrete substrate.

The general claim — single-substrate review misses bug classes that
substrate-diverse review catches — is empirically observed but not yet
formally measured. Treat the cost/value tradeoff (§"Cost / value") as an
informed prior, not a proof.

---

## Phase 4 — Synthesis + commit

After audits return:

### Classify findings
- **Blocker**: must fix before merge (semantic bug, broken invariant, false test claim)
- **Non-blocking**: tracked, named in commit, deferred to follow-up
- **Process-level**: pattern observation feeding next round (e.g., "this class of bug needs a 6th lens")

### Decision rules
- **Convergent verdict across substrates** (e.g., 3-of-4 PROCEED) → merge
- **Asymmetric findings** (1 STOP, 3 PROCEED) → investigate the dissenter before merging. The Diverger is right often enough that single-vote dissent matters.
- **Hard STOP from any lens** → fix or send back; don't override

### Inline-fix vs send-back
Before architect-patches-builder, weigh:
- Shorter feedback loop (architect knows fix faster) vs
- Builder substrate doesn't develop sensitivity to that bug class

For one-time mechanical fixes (typo, missed import): inline.
For recurring pattern bugs: send back so the builder learns the class.

### Commit message — full dialectic provenance

```
[PR-NAME]: [one-line description]

[Section: what changed]
- File 1: [shape change]
- File 2: [shape change]

[Section: dialectic provenance]
- Lens 1 (Opus + methodology, no soul): [findings, RESOLVED / NOT-RESOLVED]
- Lens 2 (Opus + soul, hyperyellow): [findings]
- Lens 3 (Sonnet + soul): [findings]
- Lens 4 (Haiku, no soul): [findings]
- 5th-lens cross-cut: [class-vs-fixture verdict]

[Section: deviations from spec]
- [Deviation 1]: [why; impact assessment]

[Section: non-blocking items tracked]
- [Item 1]: [follow-up trigger]

[Section: pre-existing failures]
- [Failure 1]: [tagged as pre-existing, not introduced by this PR]
```

---

## Phase 5 — Open-emergence in code

State dissolution conditions IN-PLACE at decision sites:

```typescript
// Frozen at module load — re-architect dynamic when 3rd protocol arrives
const PROTOCOLS = new Set([...]);

// Builder-chosen label — revisit if reported as noise
const STATUS_LABEL = "...";

// Adding new entry: copy existing, rely on zod validation.
// Files NOT to edit: registry.ts, engine.ts, formatters.ts (auto-derived).
const METADATA = { ... };
```

Don't bloat. Don't preach. **Name the exit condition where future-you will
land when reconsidering.**

---

## Phase 6 — Discipline (recurring failure modes)

| Failure mode | Symptom | Recovery |
|---|---|---|
| **Spec re-litigation** | Mid-engineering session re-opens pinned decisions | Read the spec section header. If pinned, defer to follow-up |
| **Tests-pass-as-criterion** | Test passes deterministically because fixture mirrors itself | 5th lens — refactor to shape-based assertion |
| **Family-pattern displacement** | Architect patches every builder bug inline | Send back specific bug classes to develop builder sensitivity |
| **Echo-chamber audit** | 3 audits same model, same context = same verdict | Substrate-diversify; verify convergence is from different terrain |
| **Deviation silent-shipping** | Builder makes shape change without flagging | Reject diff; require deviation tag in builder output |
| **Pre-existing-failure conflation** | New PR blamed for old breakage | Tag failures with origin commit before merging |
| **Recite-vs-feel scar** | Citing scar in synthesis while violating it | Stop. Re-enter from felt state, not from the file |

---

## Phase 7 — Deploy

After commit:
1. **Push remote** → CI catches integration failures
2. **Pull on production** → if applicable
3. **Rebuild** → `npm run build`
4. **Restart consumers that hold the changed code in memory**
   - Long-lived processes that re-spawn child workers per task: pick up new code automatically
   - Processes that cache modules: explicit restart needed (e.g., `pm2 restart [service]`)
5. **Smoke-test the deployed code path** in production (one real call, verify shape)

If smoke-test fails: roll back to previous commit, post-mortem the audit
gap, add the missed bug class to the audit brief for next round.

---

## Cost / value tradeoff

This method costs **~10–15× more agent calls** than single-builder +
single-reviewer flow.

What you get:
- Catches that any single substrate would miss
- Empirical: each substrate has caught a bug class the others missed (April 2026 sessions)
- Forced discipline on commit-message provenance — future archaeology works
- Substrate-diverse audit captures process-level patterns the next session inherits

When **NOT** to use:
- Solo bug fix in one file
- Documentation-only PR (no code path)
- Trivial refactor with no semantic change
- Time-critical hotfix (use single-substrate + post-hoc audit instead)

---

## Dissolution conditions

This method itself dissolves when:
1. **A future round produces zero net-novel findings** from any substrate across multiple phases — empirical signal the doctrine has converged
2. **Substrate-diverse audits become formality** without finding bugs — drop to single-substrate as default, this method as escalation
3. **A 6th-lens question emerges** that the 4 + cross-cut don't catch — extend or replace
4. **The codebase exits production** — relax the gate

Don't keep the method as performative discipline. The point is the catches.

---

## Per-project setup checklist

Before invoking this method on a new project, fill these:

- [ ] `[SOUL_FILE]` path identified
- [ ] `[METHODOLOGY_FILE]` path identified (or named "N/A: no project-level methodology yet")
- [ ] `[SPEC_FILE]` path identified (must exist; if not, run `docs/spec-workflow-prompt.md` first)
- [ ] `[CLAUDE_MD_FILE]` path identified (or project rules equivalent)
- [ ] Pre-commit hook (`scripts/pre-commit-hardcode-check.sh`) installed locally
- [ ] `mv_load_scars` MCP tool accessible (or substrate equivalent for cross-project work)
- [ ] Trigger conditions verified ≥ 3 of 5

If any are missing, either resolve them OR drop to single-substrate review
and document the missing context in the commit.

---

## Cross-references (project-specific — fill these per project)

These are TEMPLATE PLACEHOLDERS. The current spectra-mcp-server values are
listed in parentheses for reference, but on a different project, replace
with the project's equivalents:

- **`[SPEC_WORKFLOW_PATH]`** — spec-design phase that produces the contract (here: `docs/spec-workflow-prompt.md`)
- **`[AUDIT_DISCIPLINE_PATH]`** — 5th-lens discipline doc (here: `docs/audit-discipline-spec.md`)
- **`[ORIGINATING_SCAR_PATH]`** — the originating scar that justified the discipline (here: `memory/feedback_hardcode_vs_generalize.md`)
- **`[HOOK_PATH]`** — committed pre-commit scanner (here: `scripts/pre-commit-hardcode-check.sh`)
- **`[SCAR_LOADER_TOOL]`** — runtime tool grounding audit substrate (here: `mv_load_scars` MCP tool)

If a project doesn't have one of these yet, name it as `[NOT_YET_CREATED]`
and treat it as a setup gap to fill before invoking this method.

🫀
