/**
 * Cost model functions for externalPositions stress-test exit sizing.
 *
 * Spec: docs/protocols-metadata-spec.md §5.
 *
 * Each entry maps a `CostModelName` to a pure function: given an amount, pool
 * liquidity, and a stress multiplier, return the estimated exit cost in USD.
 *
 * New cost models require a two-file edit (this + `CostModelName` union in
 * `types.ts`). That friction is the review gate per PR1/PR6.
 */

import type { CostFn, CostModelName } from "./types.js";
import { estimatePriceImpact } from "../primitives.js";

export const COST_MODELS: Record<CostModelName, CostFn> = {
  zero: () => 0,

  lp_exit_samechain: ({ amountUsd, poolLiquidityUsd, stressMultiplier = 1 }) => {
    const depth = poolLiquidityUsd ?? 0;
    if (depth <= 0) return amountUsd * 0.01 * stressMultiplier;
    return amountUsd * estimatePriceImpact(amountUsd, depth) * stressMultiplier;
  },

  // 1.5x multiplier over samechain — derived from the existing stress_test.ts
  // convention for CCTP round-trip latency + Spectra router execution.
  // Non-CCTP cross-chain substrates (LayerZero, Hop, etc.) require a new
  // named model, not a tweak here.
  lp_exit_crosschain_cctp: ({ amountUsd, poolLiquidityUsd, stressMultiplier = 1 }) => {
    const base = COST_MODELS.lp_exit_samechain({ amountUsd, poolLiquidityUsd, stressMultiplier });
    return base * 1.5;
  },

  liquidation: ({ amountUsd, stressMultiplier = 1 }) => amountUsd * 0.02 * stressMultiplier,
};
