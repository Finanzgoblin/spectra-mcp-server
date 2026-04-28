/**
 * Action-item types + prefix registry + maturity-template dispatcher.
 *
 * PR-C of `docs/hardcode-vs-generalize-spec.md` v3-final.
 *
 * IMPORT CONSTRAINT (BL-8): this module MAY import from `primitives.ts` and
 * `protocols/`. It MUST NOT import from `formatters.ts` or `tools/`. The
 * dependency direction is downward — consumers import action-items, not the
 * reverse. Violation triggers re-architecting.
 *
 * Why this exists: action-item rendering was inline-string-building scattered
 * across 4+ tool files. Each emit-site duplicated the prefix literal
 * (`[EXPIRED]`, `[URGENT]`, etc.) and the maturity-template prose. When the
 * vocabulary needed to evolve (e.g., R2-BL-3 3-tier expansion or P7-BL-4
 * 6-way rolloverPolicy), every consumer site needed editing. This module
 * centralizes the dispatch.
 *
 * Render gallery contracts (spec §5.5) — `expired` template consumes
 * `meta.rolloverPolicy` (6-way) + `meta.stressSettlement.settlementWindow`
 * (floor + ceiling) for rolloverPolicy-aware prose. Curator hard-stop fix
 * (P7-BL-5): `redeem_to_underlying` surfaces queue-stress concerns with
 * "verify head orderId before promising depositor exit" prose, not just
 * the floor cooldown number.
 *
 * Dissolution: when a 5th severity tier or 11th category arrives — extend
 * the union + add the prefix entry. Action-item rendering should never grow
 * a NEW frozen Set; this module's structure already accommodates new entries.
 */

import type { ProtocolMeta, RolloverPolicy } from "../protocols/types.js";

// ────────────────────────────────────────────────────────────────────────────
// Categories + prefixes
// ────────────────────────────────────────────────────────────────────────────

/**
 * Action-item categories. The vocabulary is closed-set; extensions trigger
 * the dissolution condition (10th category arrives → extend the union).
 */
export type ActionItemCategory =
  | "expired"
  | "urgent"
  | "soon"
  | "upcoming"
  | "outflows"
  | "bridge"
  | "incentive"
  | "rollover"
  | "status"
  | "reference_only"; // P7-BL-5: position-empty + metadata-fallback render mode

export type ActionItemSeverity = "blocker" | "warn" | "info";

export interface ActionItemPrefix {
  displayPrefix: string;
  severity: ActionItemSeverity;
}

/**
 * Single source of truth for action-item prefix labels + severity.
 *
 * Severity semantics:
 *   - `blocker`: the curator MUST act before the next epoch / rollover window.
 *   - `warn`: the curator SHOULD act soon; the line surfaces a tracked risk.
 *   - `info`: surface-only; the line surfaces a context fact.
 */
export const ACTION_ITEM_PREFIXES: Record<ActionItemCategory, ActionItemPrefix> = {
  expired:        { displayPrefix: "[EXPIRED]",        severity: "blocker" },
  urgent:         { displayPrefix: "[URGENT]",         severity: "blocker" },
  soon:           { displayPrefix: "[SOON]",           severity: "warn" },
  upcoming:       { displayPrefix: "[UPCOMING]",       severity: "info" },
  outflows:       { displayPrefix: "[OUTFLOWS]",       severity: "warn" },
  bridge:         { displayPrefix: "[BRIDGE]",         severity: "info" },
  incentive:      { displayPrefix: "[INCENTIVE]",      severity: "info" },
  rollover:       { displayPrefix: "[ROLLOVER]",       severity: "warn" },
  status:         { displayPrefix: "[STATUS]",         severity: "info" },
  reference_only: { displayPrefix: "[REFERENCE-ONLY]", severity: "warn" },
};

/**
 * Format an action-item prefix. Use at every action-item emission site to
 * dispatch via category instead of repeating the literal `"[EXPIRED]"` etc.
 */
export function formatActionItemPrefix(cat: ActionItemCategory): string {
  return ACTION_ITEM_PREFIXES[cat].displayPrefix;
}

/**
 * Severity for a category. Used when consumers need to sort or filter
 * action-items by severity.
 */
export function actionItemSeverity(cat: ActionItemCategory): ActionItemSeverity {
  return ACTION_ITEM_PREFIXES[cat].severity;
}

// ────────────────────────────────────────────────────────────────────────────
// Maturity-bucket categorization
// ────────────────────────────────────────────────────────────────────────────

export interface MaturityThresholds {
  /** Days-to-maturity below which `urgent` fires. Default 7. */
  urgent?: number;
  /** Days-to-maturity below which `soon` fires (between urgent + this). Default 14. */
  upcoming?: number;
  /** Days-to-maturity below which `upcoming` fires (between soon + this). Default 30. */
  upcomingMax?: number;
}

/**
 * Map days-to-maturity → action-item category. Returns `"status"` for
 * positions beyond the upcoming horizon (no action item rendered upstream).
 *
 * Per spec PR-B1 (R2-BL-3) 3-tier vocabulary fix: the previous engine.ts
 * implementation collapsed `soon` and `upcoming` into a single bucket; this
 * helper keeps them distinct.
 */
export function getMaturityCategory(
  daysToMaturity: number,
  thresholds: MaturityThresholds = { urgent: 7, upcoming: 14, upcomingMax: 30 },
): ActionItemCategory {
  const urgent = thresholds.urgent ?? 7;
  const upcoming = thresholds.upcoming ?? 14;
  const upcomingMax = thresholds.upcomingMax ?? 30;
  if (daysToMaturity <= 0) return "expired";
  if (daysToMaturity <= urgent) return "urgent";
  if (daysToMaturity <= upcoming) return "soon";
  if (daysToMaturity <= upcomingMax) return "upcoming";
  return "status";
}

// ────────────────────────────────────────────────────────────────────────────
// Maturity-template rendering (rolloverPolicy-aware)
// ────────────────────────────────────────────────────────────────────────────

export interface MaturityCtx {
  symbol: string;
  daysToMaturity: number;
  meta: ProtocolMeta;
  /** Optional vault-side fields consumed by `outflows` / future templates. */
  idleUsd?: number;
  idlePct?: number;
}

/**
 * Compose a rollover-strategy hint based on `meta.rolloverPolicy`. Used by
 * `urgent` / `soon` templates to suffix action-items with protocol-aware
 * prose ("Prepare manual rollover to successor PT" vs "Initiate burn for
 * redemption queue").
 */
function rolloverPrelude(meta: ProtocolMeta): string {
  const policy: RolloverPolicy | undefined = meta.rolloverPolicy;
  switch (policy) {
    case "auto":
      return "Auto-rolls — no curator action required.";
    case "manual_to_successor":
      return "Prepare manual rollover to successor PT.";
    case "redeem_to_underlying":
      return "Initiate burn for redemption queue.";
    case "expire_to_lp_share":
      return "Will expire into LP share; consult protocol docs for unwind path.";
    case "redeem_no_cooldown":
      return "Instant burn-to-stable available.";
    case "unknown":
    default:
      return "Rollover path unknown — verify before action.";
  }
}

/**
 * Render the full action-item line for a maturity-driven category.
 *
 * `expired` template (P7-BL-5 + Curator hard-stop): consumes
 * `settlementWindow.ceiling` + `observationBoundaries.unobservable[]` for
 * `redeem_to_underlying` to surface queue-stress concerns. The complexity is
 * the protection against authority-laundering — without the ceiling note,
 * curators quote "~7d" to depositors and get blamed when queue stress
 * extends to 12-15 days.
 */
export function formatMaturityActionItem(
  cat: ActionItemCategory,
  ctx: MaturityCtx,
): string {
  const prefix = formatActionItemPrefix(cat);
  const { symbol, daysToMaturity, meta } = ctx;

  switch (cat) {
    case "expired": {
      const policy = meta.rolloverPolicy;
      switch (policy) {
        case "auto":
          return `${prefix} ${symbol} auto-rolled.`;
        case "redeem_to_underlying": {
          // PR-M (B4 fix): use `floor.value` when present (strict minimum cooldown
          // per protocols-metadata-spec SU-2 SettlementWindow semantics). Fall back
          // to `typical.value` (interpreted nominal-path) when no floor declared.
          // Pre-PR-M used typical unconditionally — currently safe because Avant's
          // typical=floor=7, but latent bug if a future protocol declares
          // `typical: InterpretedValue<10>` over `floor: SourcedValue<7>`.
          const sw = meta.stressSettlement.settlementWindow;
          const cooldownDays = sw.floor?.value ?? sw.typical.value;
          const ceiling = sw.ceiling;
          const ceilingNote = ceiling?.value === "unknown"
            ? `; ceiling unknown under queue stress (verify head orderId before promising depositor exit)`
            : ``;
          return `${prefix} ${symbol} matured. Floor ${cooldownDays}d cooldown${ceilingNote}.`;
        }
        case "manual_to_successor":
          return `${prefix} ${symbol} matured. Redeem and reallocate to successor PT.`;
        case "expire_to_lp_share":
          return `${prefix} ${symbol} expired into LP share — no burn, no cooldown. See protocol docs for unwind path.`;
        case "redeem_no_cooldown":
          return `${prefix} ${symbol} matured. Instant burn-to-stable available.`;
        default:
          return `${prefix} ${symbol} has matured.`;
      }
    }
    case "urgent":
      return `${prefix} ${symbol} expires in ${daysToMaturity}d. ${rolloverPrelude(meta)}`;
    case "soon":
      return `${prefix} ${symbol} expires in ${daysToMaturity}d. ${rolloverPrelude(meta)}`;
    case "upcoming":
      return `${prefix} ${symbol} expires in ${daysToMaturity}d.`;
    case "outflows": {
      // PR-M (A4 fix): closes the spec §5 gap — `[OUTFLOWS]` was declared in
      // ACTION_ITEM_PREFIXES but had no template body, so consumers fell through
      // to the default `${prefix} ${symbol}` rendering. Per spec example: vault
      // unallocated ≥ IDLE_LIQUIDITY_WARN_PCT → emit pct + idle USD prose.
      // ctx.idleUsd / ctx.idlePct are optional inputs; render gracefully when absent.
      const pctPart = ctx.idlePct !== undefined ? `${ctx.idlePct.toFixed(0)}% ` : "";
      const usdPart = ctx.idleUsd !== undefined ? `(${ctx.idleUsd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} idle)` : "";
      const body = pctPart || usdPart
        ? `vault unallocated ${pctPart}${usdPart}`.trim()
        : `vault unallocated capital threshold exceeded`;
      return `${prefix} ${body}; review depositor retention.`;
    }
    default:
      return `${prefix} ${symbol}`;
  }
}
