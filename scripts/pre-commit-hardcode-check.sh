#!/bin/bash
# pre-commit hook — hardcode-vs-generalize forcing function (PR-J)
#
# Spec:        docs/audit-discipline-spec.md
# Scar:        memory/feedback_hardcode_vs_generalize.md
# Originating: docs/hardcode-vs-generalize-spec.md (v3-final, PR-J row)
#
# Behavior:
#   - Default: ADVISORY (prints warning, allows commit)
#   - HARDCODE_CHECK=strict in env: BLOCKING (exits 1 on findings)
#   - HARDCODE_CHECK=skip in env: SKIPPED (no scan)
#
# What it scans:
#   Staged additions only (`git diff --cached`), looking for fingerprint
#   patterns that suggest fixture-mirror code rather than class-shape code.
#
# What it does NOT catch (reviewer's territory):
#   - Test fixture-mirrors as raw regex literals
#   - Class-shape hidden inside named functions
#   - JSDoc enumerations of instances of a class
#   - Spec docs whose render examples are mirrored into tests
#   See docs/audit-discipline-spec.md §4.

set -u

# Normalize HARDCODE_CHECK to lowercase to avoid silent-degradation
# (case-sensitive comparison previously meant `HARDCODE_CHECK=STRICT` ran advisory).
# Caught by Lens 3 audit (Sonnet + soul, depth) on 2026-04-28.
HARDCODE_CHECK_NORM=$(echo "${HARDCODE_CHECK:-}" | tr '[:upper:]' '[:lower:]')

# Skip on user request
if [ "$HARDCODE_CHECK_NORM" = "skip" ]; then
  exit 0
fi

# Capture staged additions only (lines starting with '+', excluding diff headers).
# -U0 minimizes context lines so we don't false-positive on unchanged code.
DIFF=$(git diff --cached --no-color -U0 2>/dev/null | grep '^+' | grep -v '^+++' || true)

if [ -z "$DIFF" ]; then
  exit 0
fi

# Fingerprint patterns. The CLASS is "TS literal that captures a moment-in-time
# mapping from string keys to constants." The three patterns below are the
# CURRENT INSTANCES of that class observed in this codebase as of 2026-04-28.
#
# To extend (when a 4th idiom emerges, e.g. tuple-literal types in TS5.x):
# add a new pattern + description; no other code shape changes.
#
# Source: feedback_hardcode_vs_generalize.md §"Specific instances",
# audit-discipline-spec.md §3.
#
# The reviewer-brief 5th-lens (cross-cut in spec-workflow-prompt.md Phase 3+5)
# handles the open class — patterns the mechanical scanner can't pin down.
PATTERNS=(
  'new Set\(\['
  'Record<string,'
  'as const'
)
DESCRIPTIONS=(
  "frozen Set literal (consider: function-with-rules or zod schema)"
  "Record<string, T> literal (consider: discriminated union)"
  "as const narrow-typed literal (consider: schema validation with drift handling)"
)

FOUND_ANY=0
i=0
while [ $i -lt "${#PATTERNS[@]}" ]; do
  pattern="${PATTERNS[$i]}"
  desc="${DESCRIPTIONS[$i]}"

  if echo "$DIFF" | grep -qE "$pattern" 2>/dev/null; then
    if [ "$FOUND_ANY" -eq 0 ]; then
      echo ""
      echo "═══════════════════════════════════════════════════════════════════"
      echo "  hardcode-vs-generalize check (PR-J 5th-lens forcing function)"
      echo "═══════════════════════════════════════════════════════════════════"
      FOUND_ANY=1
    fi
    echo ""
    echo "  Pattern: ${desc}"
    echo "  Found in staged additions:"
    echo "$DIFF" | grep -E "$pattern" 2>/dev/null | head -3 | sed 's/^/    /'
  fi
  i=$((i + 1))
done

if [ "$FOUND_ANY" -eq 1 ]; then
  cat <<'EOF'

  ─────────────────────────────────────────────────────────────────
  Pause and answer (audit-discipline-spec.md §2):

    1. What is the CLASS beneath this fixture? Name it explicitly.
    2. What shape does the class produce? Code against the shape.
    3. Does the test assert SHAPE or VALUE? If VALUE, why?
    4. Will this require a code edit when the API ships a new instance?
       If yes, the abstraction is wrong.

  Sometimes the literal IS correct (closed enumerations, hot paths, type
  narrowing). Document inline if so — see audit-discipline-spec.md §6.

  References:
    • docs/audit-discipline-spec.md
    • memory/feedback_hardcode_vs_generalize.md
    • docs/spec-workflow-prompt.md (5th lens: Class-vs-Fixture)

  Advisory by default. To enforce: export HARDCODE_CHECK=strict
  To skip:                          export HARDCODE_CHECK=skip
  ═══════════════════════════════════════════════════════════════════

EOF

  if [ "$HARDCODE_CHECK_NORM" = "strict" ]; then
    echo "  HARDCODE_CHECK=strict → commit blocked. Refactor or override."
    echo ""
    exit 1
  fi
fi

exit 0
