/**
 * Primitive formatters and numeric helpers.
 *
 * HOME for the small, leaf-level utilities that were previously colocated in
 * formatters.ts. Keeping them in a dependency-shallow module (config.ts only)
 * lets the protocols registry (src/protocols/*) consume them without importing
 * the full formatters surface, which avoids a circular import graph once the
 * registry feeds back into formatters.ts.
 *
 * Spec: docs/protocols-metadata-spec.md §9 Phase 0 (§2 import map).
 */

import { SUPPORTED_CHAINS } from "./config.js";

export function formatUsd(val: number): string {
  return `$${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPct(val: number): string {
  return `${(val ?? 0).toFixed(2)}%`;
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toISOString().split("T")[0];
}

export function daysToMaturity(timestamp: number): number {
  const now = Date.now() / 1000;
  return Math.max(0, Math.round((timestamp - now) / 86400));
}

/**
 * Estimate price impact for a Curve-style AMM trade.
 *
 * Uses the simplified constant-product approximation:
 *   priceImpact ≈ amountUsd / (2 * poolLiquidityUsd)
 *
 * Real Curve StableSwap-NG pools are more capital-efficient than x*y=k,
 * so this is a conservative upper bound. For small trades relative to pool
 * liquidity the estimate is very close; for large trades it overstates impact.
 */
export function estimatePriceImpact(amountUsd: number, poolLiquidityUsd: number): number {
  if (poolLiquidityUsd <= 0) return 1; // 100% impact — no liquidity means no trade
  return amountUsd / (2 * poolLiquidityUsd);
}

/** Map chain ID → human-readable name for bridge display. */
export function chainIdToName(id: number): string {
  for (const info of Object.values(SUPPORTED_CHAINS)) {
    if (info.id === id) return info.name;
  }
  return `Chain ${id}`;
}

/**
 * Shorten an EVM address for display: `0xabcd12...3456`.
 *
 * Pattern matches existing inline duplications at formatters.ts:1039, 2586, 5315
 * (three-dot ASCII `...`, not the U+2026 ellipsis character). Strings shorter than
 * 11 chars are returned unchanged — no point shortening. Empty/undefined inputs
 * are coerced to `""` defensively even though the type signature is `string`.
 */
export function shortenAddress(addr: string): string {
  const a = addr ?? "";
  if (a.length < 11) return a;
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

/**
 * Render an integer-second string as a coarse duration (s / m / h / d).
 *
 * Input is a STRING because modifier.delay values are zod-typed
 * `z.record(z.string(), z.string())`. NaN renders as `[unparsed:<input>]` with
 * the literal square-bracket prefix (so consumers can see the raw value that
 * failed to parse). `parseInt` truncation means "1.5h" → "1s" — this is an
 * accepted spec gap for now (discard-layer-spec §5).
 */
export function formatSecondsAsDuration(secondsString: string): string {
  const n = parseInt(secondsString, 10);
  if (Number.isNaN(n)) return `[unparsed:${secondsString}]`;
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.round(n / 60)}m`;
  if (n < 86400) return `${Math.round(n / 3600)}h`;
  return `${Math.round(n / 86400)}d`;
}

/**
 * Truncate a description to its first paragraph, capped at `max` characters.
 *
 * Returns `null` for falsy input (undefined / null / empty string) so callers
 * can `if (truncated)` and skip rendering. The `max - 1` slice leaves room for
 * the appended single-character ellipsis `…` (U+2026).
 */
export function truncateDescription(s: string | undefined, max: number = 140): string | null {
  if (!s) return null;
  const firstPara = s.split(/\n\n+/)[0];
  if (firstPara.length <= max) return firstPara;
  return firstPara.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Format `Record<role, address>` as `proposer=0xabcd...1234, executor=0x1111...2222`.
 *
 * Returns `null` when the record is undefined or empty so callers can skip
 * rendering the line entirely.
 */
export function formatRoleRecord(roles: Record<string, string> | undefined): string | null {
  if (!roles || Object.keys(roles).length === 0) return null;
  return Object.entries(roles)
    .map(([role, addr]) => `${role}=${shortenAddress(addr)}`)
    .join(", ");
}

/**
 * Format `Record<role, secondsString>` as `proposer 24h, executor 48h`.
 *
 * Returns `null` when the record is undefined or empty. Each value is rendered
 * via `formatSecondsAsDuration`, so unparseable seconds bubble up as
 * `[unparsed:<value>]` rather than being silently dropped.
 */
export function formatDelayRecord(delays: Record<string, string> | undefined): string | null {
  if (!delays || Object.keys(delays).length === 0) return null;
  return Object.entries(delays)
    .map(([role, secondsString]) => `${role} ${formatSecondsAsDuration(secondsString)}`)
    .join(", ");
}
