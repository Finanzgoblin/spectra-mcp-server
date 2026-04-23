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
