/**
 * Risk-tolerance configuration registry.
 *
 * PR-M2 of `docs/hardcode-vs-generalize-spec.md` v3-final (recursive-scar
 * dissolution after Hyperyellow audit, 2026-04-28).
 *
 * Why this file exists:
 *   PR-K shipped three threshold helpers (`isHighSlippage`,
 *   `isLiquidityTrendBad`, `vaultSizeAdjustedIdleThreshold`) with magic-
 *   number defaults baked into function signatures. Spec §5.6 itself
 *   hardcoded those values (2%, 30%, 7-day window, 1M/10M brackets,
 *   30/20/10 pct outputs) without external citation. PR-M attempted to
 *   close audit findings but RELOCATED the scar to the helper-default
 *   surface — same shape, different layer. Hyperyellow's follow-up audit
 *   named the recursive failure: "PR-M did not dissolve the scar; it
 *   relocated it from data-shape to threshold-helper-default surface."
 *
 *   This file extracts the CLASS: "risk-tolerance configuration."
 *   Instances are stakeholder cohorts (curator default, hypothetical
 *   trader-aggressive profile, institutional-LP profile, etc.). Adding a
 *   new cohort = one row in this registry. Helpers dispatch through the
 *   profile, not through magic-number defaults.
 *
 * Provenance discipline (per protocols-metadata-spec SU-1):
 *   Every threshold value is `InterpretedValue<number>`. The current
 *   default profile uses `interpretedFrom.value = "no published source —
 *   opening builder default; pending research"` — naming the calcification
 *   instead of hiding it. When a curator engagement, protocol-team
 *   pushback, or empirical study surfaces real tolerance data, upgrade
 *   the entry to `SourcedValue` with citation.
 *
 * Import constraint (mirrors action-items/types.ts BL-8):
 *   MAY import from `protocols/types.js` (for InterpretedValue/SourcedValue).
 *   MUST NOT import from `formatters.ts` or `tools/`. Consumers import
 *   risk-profiles, not the reverse.
 *
 * Dissolution conditions:
 *   - Each `interpretedFrom: "no source"` entry dissolves when research
 *     surfaces a real source — replace with SourcedValue inline.
 *   - The default profile dissolves when a 2nd cohort ships (then this
 *     becomes one row of a multi-cohort registry; helpers gain a cohort
 *     selector or per-vault profile lookup).
 *   - The TVL-bracket shape dissolves when a 4th bracket arrives (then
 *     the bracket array itself becomes a sub-registry).
 */

import type { InterpretedValue } from "../protocols/types.js";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** A single TVL → idle-threshold-pct bracket. */
export interface TvlBracket {
  /** Inclusive lower bound for vault TVL (USD). */
  minTvlUsd: number;
  /** Idle threshold in pct (0-100) for vaults at or above this bracket. */
  idleThresholdPct: InterpretedValue<number>;
}

/**
 * Risk-tolerance configuration. The CLASS the threshold helpers consume.
 *
 * - `slippageBudget`: max acceptable price-impact pct for an entry/exit at
 *   the curator's intended scale.
 * - `liquidityDropTolerance`: pct decline in pool liquidity over the
 *   trend-window before the position is considered bleeding.
 * - `liquidityTrendWindowDays`: window for the trend comparison (e.g., 7d).
 * - `idleByTvlBracket`: ordered array of TVL→idle-threshold breakpoints.
 *   Helper returns the threshold of the LARGEST bracket whose minTvlUsd ≤
 *   vaultTvlUsd. Adding a new bracket = one row.
 */
export interface RiskProfile {
  name: string;
  slippageBudget: InterpretedValue<number>;
  liquidityDropTolerance: InterpretedValue<number>;
  liquidityTrendWindowDays: InterpretedValue<number>;
  idleByTvlBracket: TvlBracket[];
}

// ────────────────────────────────────────────────────────────────────────────
// Default profile — every numeric value tagged InterpretedValue with explicit
// "no source" provenance. Naming the calcification instead of hiding it.
// ────────────────────────────────────────────────────────────────────────────

const VERIFIED_ON = "2026-04-28";

/**
 * Sentinel sourceUrl for "no external source" interpretations. Distinct from
 * the empty-string convention used by `_unknown` in PROTOCOL_METADATA so a
 * future `validateAndWarn`-style checker can flag pending-research entries.
 */
const NO_SOURCE_SENTINEL = "pending-research://risk-profile";

/** Helper to construct an opening-default InterpretedValue with the calcification disclosure. */
function pendingResearchInterpretation(
  value: number,
  pendingNote: string,
  dissolutionTrigger: string,
): InterpretedValue<number> {
  return {
    value,
    interpretedFrom: {
      value: "no published source — opening builder default; pending research",
      sourceUrl: NO_SOURCE_SENTINEL,
      sourceVerifiedOn: VERIFIED_ON,
    },
    interpretationNote: `${pendingNote} | Dissolution: ${dissolutionTrigger}`,
    sourceVerifiedOn: VERIFIED_ON,
  };
}

/**
 * Default curator-cohort risk profile.
 *
 * Every value is opening builder intuition pending research. Hyperyellow
 * audit (2026-04-28): "PR-M relocated the scar from data-shape to
 * threshold-helper-default surface." This profile makes the calcification
 * VISIBLE rather than baking it into function signatures.
 */
export const DEFAULT_CURATOR_PROFILE: RiskProfile = {
  name: "curator_default",
  slippageBudget: pendingResearchInterpretation(
    2,
    "2% impact-tolerance was inherited from spec §5.6 line 406-407 unsourced default",
    "curator engagement surfaces empirical tolerance data; replace with SourcedValue",
  ),
  liquidityDropTolerance: pendingResearchInterpretation(
    30,
    "30% trend-drop threshold was inherited from spec §5.6 line 410-413 unsourced default",
    "LP cohort surfaces volatility regime data; replace with SourcedValue per asset class",
  ),
  liquidityTrendWindowDays: pendingResearchInterpretation(
    7,
    "7-day trend window was hardcoded into the prior parameter name `sevenDayAgoUsd` — calendar-week convention, not sourced",
    "cycle data shows non-weekly volatility patterns OR trader cohort needs intraday windows",
  ),
  idleByTvlBracket: [
    {
      minTvlUsd: 0,
      idleThresholdPct: pendingResearchInterpretation(
        30,
        "Small-vault tolerance — operational drag (gas, rebalance latency) hits proportionally harder at low AUM",
        "small-vault curator surfaces evidence of misclassification",
      ),
    },
    {
      minTvlUsd: 1_000_000,
      idleThresholdPct: pendingResearchInterpretation(
        20,
        "Mid-vault default — matches IDLE_LIQUIDITY_WARN_PCT absolute floor",
        "vault data shows the 1M/10M boundaries misclassify",
      ),
    },
    {
      minTvlUsd: 10_000_000,
      idleThresholdPct: pendingResearchInterpretation(
        10,
        "Institutional-scale tolerance — dollar cost of idle compounds",
        "institutional curator surfaces evidence the 10% target is unrealistic",
      ),
    },
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// Registry shape — currently single-cohort. The shape lets a future PR add
// new cohorts as one row without touching consumer logic.
// ────────────────────────────────────────────────────────────────────────────

export const RISK_PROFILES: Record<string, RiskProfile> = {
  curator_default: DEFAULT_CURATOR_PROFILE,
};

/** Resolve a risk profile by cohort name. Falls back to `curator_default`. */
export function getRiskProfile(name: string = "curator_default"): RiskProfile {
  return RISK_PROFILES[name] ?? DEFAULT_CURATOR_PROFILE;
}

/**
 * Resolve the idle threshold (pct) for a vault of `vaultTvlUsd` against the
 * given profile's TVL brackets. Returns the threshold of the LARGEST bracket
 * whose `minTvlUsd` ≤ `vaultTvlUsd`.
 *
 * Defensive default when `idleByTvlBracket` is empty: returns the profile's
 * `liquidityDropTolerance.value` (a related-class threshold) rather than a
 * magic number — keeps the dispatch consistent.
 */
export function resolveIdleThresholdPct(
  vaultTvlUsd: number,
  profile: RiskProfile = DEFAULT_CURATOR_PROFILE,
): number {
  if (profile.idleByTvlBracket.length === 0) {
    return profile.liquidityDropTolerance.value;
  }
  let result = profile.idleByTvlBracket[0].idleThresholdPct.value;
  for (const b of profile.idleByTvlBracket) {
    if (vaultTvlUsd >= b.minTvlUsd) {
      result = b.idleThresholdPct.value;
    }
  }
  return result;
}

/** Sentinel exported for tests + future "pending research" auditing. */
export { NO_SOURCE_SENTINEL };
