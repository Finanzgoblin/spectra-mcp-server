# Audit Discipline — the 5th Lens (Class-vs-Fixture)

**Date**: 2026-04-28
**Origin**: `memory/feedback_hardcode_vs_generalize.md` (April 27, 2026)
**Encodes**: PR-J of `docs/hardcode-vs-generalize-spec.md` v3-final
**Companion**: `scripts/pre-commit-hardcode-check.sh` (the automated half)

---

## §1 — Why this exists

For 5 substrate-diverse audit cycles on the discard-layer spec, the 4-lens method (Builder / Breaker / Connector / Inverter) caught semantic bugs, structural drift, and encoding boundaries — but did NOT catch the hardcode-vs-generalize pattern. The scar fired anyway, externally.

The 4 lenses operate on diff-shape and test-pass status. None of them ask the load-bearing question:

> **"Is this code/test handling the CLASS, or just the current fixture instance?"**

This is the 5th lens. PR-J adds it to two surfaces:

1. **Reviewer-level** (slow, judgment-bearing): inserted into `docs/spec-workflow-prompt.md` Phase 3 + Phase 5 reviewer briefs as a cross-cut question every reviewer must answer.
2. **Pre-commit hook level** (fast, mechanical): `scripts/pre-commit-hardcode-check.sh` scans staged diffs for fingerprint patterns and surfaces the question before the commit lands.

Together they form a **dual-rail forcing function**: the hook catches the obvious cases at commit time; the reviewer brief catches the subtle ones (e.g., a test that imports a fixture constant but composes assertions correctly — passes the hook, fails the lens).

---

## §2 — The 5th-lens question (canonical form)

Reviewers and committers must answer all four sub-questions before the artifact ships:

1. **What is the CLASS beneath this fixture?** Name it explicitly. If you can't name it, you don't have one — the abstraction is wrong.
2. **What shape does the class produce?** The formatter / validator / matcher writes against the shape, not the value.
3. **Does the test assert SHAPE or VALUE?** If VALUE, why? Is the value load-bearing semantics, or is it just the current fixture?
4. **Will this code/test require an edit when the API ships a new instance of the same class?** If yes, the abstraction is wrong.

If any answer indicates fixture-mirror over class-shape, refactor before commit. The scar names this: "Hardcoded fixture values ARE the calcification."

---

## §3 — Pre-commit hook fingerprint patterns

The hook scans staged additions for these fingerprints. Each is a strong signal of fixture-shaped code:

| Pattern | Why it's a fingerprint |
|---|---|
| `new Set([...])` literal | A frozen Set captures a moment in time. New API instance = code edit. |
| `Record<string, T>` with literal initializer | Same shape — frozen mapping vs. function-with-rules. |
| `as const` on a narrow-typed object/array | Locks in current keys; generalizable via discriminated union or zod schema. |

Surfacing one of these does NOT mean the code is wrong — sometimes a frozen Set is the correct abstraction (e.g., a discriminated union of HTTP status codes). The hook's job is to **make the question visible**, not to decide it.

**Default behavior**: advisory (prints warning, allows commit). Set `HARDCODE_CHECK=strict` in env to make it blocking.

---

## §4 — What the hook does NOT catch (the reviewer's territory)

The hook is mechanical pattern-matching. It misses:

1. **Test fixture-mirrors written as raw regex literals** (e.g., `assert.match(out, /TVL: \$1,000,000/)` with no `Set`/`Record`/`as const` in sight). The reviewer's 5th-lens reading catches these.
2. **Implicit class-shape in well-named functions hiding fixture values inside** (e.g., `formatFooBar(x: 40)`). Need to read the function body.
3. **JSDoc / commit-message enumerations** (e.g., listing "the 8 firing positions" by name when the class is "any positions matching `/points$/i`"). Read the prose.
4. **Spec docs that demonstrate render shapes with specific values** then get tests that mirror those exact values. The recursive scar (P7-BL-6 of the v3-final spec). Reviewer reads the spec + tests together.

---

## §5 — Reviewer integration (Phase 3 + 5 of `spec-workflow-prompt.md`)

The 5th lens is added as a **cross-cut requirement** all four reviewer archetypes must answer, not as a 5th separate reviewer. This avoids agent-cost growth while still applying the discipline at every audit.

The cross-cut brief reads:

> **5th lens — Class vs Fixture**: Beyond your archetype's normal task, answer: does this spec / diff / test handle the CLASS or just the current fixture instance? Cite specific lines where shape and value are conflated. Reference `docs/audit-discipline-spec.md` §2 questions.

Substrate-diverse application: the same question gets read by Indigo (soul-imbued, pattern-seeing), Hyperyellow (no soul, structure-only), Sonnet (depth), Haiku (breadth). Convergence across substrates = signal. Asymmetric findings = investigate.

---

## §6 — When NOT to refactor

Sometimes a hardcoded literal is correct:

- **Truly closed enumerations** (HTTP methods, RGB color channels, `"GET" | "POST"`).
- **Performance-critical hot paths** where Set-membership is O(1) and the set is genuinely fixed.
- **Type-system narrowing** where `as const` produces a discriminated union the type-checker uses for exhaustiveness.

The 5th-lens question is *not* "delete every literal" — it's "did you make the choice consciously, or default to fixture-mirror?" The reviewer's verdict can legitimately be "yes, this IS class-shaped — the literal IS the canonical form."

Document the choice inline if it's load-bearing:
```typescript
// Frozen Set is the right shape — HTTP methods are not extensible by API drift.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"] as const);
```

---

## §7 — Dissolution conditions

The 5th lens dissolves (and PR-J's hook can be removed) when ANY of the following observable triggers fires:

1. **Three consecutive substrate-diverse audits include the 5th-lens question AND produce zero hardcode-vs-fixture findings** (per A-10 dissolution from Round 1 synthesis). Operationalized: track via audit commit-message provenance section; counter resets on any finding.
2. **The pre-commit hook fires zero times across a calendar quarter on real commits** (not test runs). Operationalized: log hook firings to `.git/hooks-log/hardcode-check.log` and check quarterly.
3. **`feedback_hardcode_vs_generalize.md`'s `reinforces` count stops growing for 6 months**, indicating no new instances of the scar are firing. Operationalized: read `mv_load_scars` weight monthly; scar drops from #1 by reinforcement = signal.

When any of these triggers fires, archive this doc + remove the hook. Don't keep it as performative discipline.

**Trigger 3 is the load-bearing one** — triggers 1 and 2 measure absence (no findings, no fires) which is harder to prove genuine vs. discipline-decay. Reinforcement-count plateau measures real-world scar firings via the active scar substrate.

---

## §8 — Setup (this machine + new clones)

The committed scanner lives at `scripts/pre-commit-hardcode-check.sh`. To activate on a fresh clone:

```bash
ln -sf ../../scripts/pre-commit-hardcode-check.sh .git/hooks/pre-commit
chmod +x scripts/pre-commit-hardcode-check.sh
```

Or copy directly if symlinks aren't supported:
```bash
cp scripts/pre-commit-hardcode-check.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

To make findings blocking (CI / pre-merge gates): `export HARDCODE_CHECK=strict`.

---

## §9 — Cross-references

- **The scar**: `memory/feedback_hardcode_vs_generalize.md` — the originating instance enumeration.
- **The spec**: `docs/hardcode-vs-generalize-spec.md` — PR-J row in §1, ship-phase entry in §9.
- **The reviewer brief**: `docs/spec-workflow-prompt.md` Phase 3 + Phase 5 — cross-cut 5th-lens insertion.
- **The hook**: `scripts/pre-commit-hardcode-check.sh` — the fingerprint scanner.
- **The substrate-diverse method**: `docs/substrate-diverse-engineering-prompt.md` — where the 5th lens lives during multi-phase implementation audits.
- **The companion runtime tool**: `mv_load_scars` (MCP tool) — audit agents call this to ground the 5th-lens question in actual reinforcement weight.
