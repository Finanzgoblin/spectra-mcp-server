/**
 * Data formatting helpers — USD, percentages, dates, balances, pool/position/Morpho summaries.
 */

import type { SpectraPt, SpectraPool, MorphoMarket, PositionResult, TradeQuote, PositionSnapshot, ScanOpportunity, YtArbitrageOpportunity, MetavaultLoopRow, MetavaultCuratorEconomics } from "./types.js";

// =============================================================================
// Primitive Formatters
// =============================================================================

export function formatUsd(val: number): string {
  return `$${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPct(val: number): string {
  return `${val.toFixed(2)}%`;
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toISOString().split("T")[0];
}

export function daysToMaturity(timestamp: number): number {
  const now = Date.now() / 1000;
  return Math.max(0, Math.round((timestamp - now) / 86400));
}

// Fractional days for math-sensitive contexts (rate annualization, YT implied rate).
// Avoids rounding artifacts near maturity — e.g. 18 hours = 0.75 days, not 1.
export function fractionalDaysToMaturity(timestamp: number): number {
  const now = Date.now() / 1000;
  return Math.max(0, (timestamp - now) / 86400);
}

// Format a raw token balance (integer string) to a human-readable number.
// Uses pure BigInt arithmetic for the divisor to handle any decimal count
// (including >18, e.g. 24-decimal tokens) without precision loss.
export function formatBalance(raw: string | null | undefined, decimals: number): number {
  if (!raw || raw === "0") return 0;
  try {
    const bi = BigInt(raw);
    // Build divisor entirely in BigInt to support decimals > 18
    const safeDec = Math.max(0, Math.round(decimals));
    let divisor = 1n;
    for (let i = 0; i < safeDec; i++) divisor *= 10n;
    // Split into integer + fractional parts to preserve precision on large values
    const intPart = bi / divisor;
    const fracPart = bi % divisor;
    // Recombine: integer part is exact via BigInt, fractional part converted to float
    return Number(intPart) + Number(fracPart) / Number(divisor);
  } catch {
    // Fallback for non-integer strings (shouldn't happen, but be safe)
    return Number(raw) / Math.pow(10, decimals);
  }
}

// =============================================================================
// Compact Formatters (for agent-efficient output)
// =============================================================================

/** One-line pool summary for compact list output. */
export function formatPoolCompact(pt: SpectraPt, pool: SpectraPool, chain: string): string {
  const apy = formatPct(pool.impliedApy || 0);
  const tvl = formatUsd(pt.tvl?.usd || 0);
  const liq = formatUsd(pool.liquidity?.usd || 0);
  const days = daysToMaturity(pt.maturity);
  const lpApy = pool.lpApy?.total ? ` | LP ${formatPct(pool.lpApy.total)}` : "";
  return `${pt.name} (${chain}) | APY ${apy} | TVL ${tvl} | Liq ${liq} | ${days}d${lpApy} | PT: ${pt.address} | Pool: ${pool.address || "?"}`;
}

/** One-line scan opportunity summary for compact output. */
export function formatScanOpportunityCompact(opp: ScanOpportunity, rank: number): string {
  const loopTag = opp.looping
    ? ` | Loop ${formatPct(opp.looping.optimalEffectiveNetApy)} @${opp.looping.optimalLoops}x`
    : "";
  return `#${rank} ${opp.pt.name} (${opp.chain}) | Eff ${formatPct(opp.effectiveApy)} | Impl ${formatPct(opp.impliedApy)} | Impact ${formatPct(opp.entryImpactPct)} | ${opp.daysToMaturity}d${loopTag} | PT: ${opp.ptAddress} | Pool: ${opp.poolAddress}`;
}

/** One-line YT arb opportunity summary for compact output. */
export function formatYtArbCompact(opp: YtArbitrageOpportunity, rank: number): string {
  return `#${rank} ${opp.pt.name} (${opp.chain}) | Spread ${opp.spreadPct >= 0 ? "+" : ""}${formatPct(opp.spreadPct)} | IBT ${formatPct(opp.ibtCurrentApr)} vs YT ${formatPct(opp.ytImpliedRate)} | Impact ${formatPct(opp.entryImpactPct)} | ${opp.daysToMaturity}d | PT: ${opp.ptAddress}`;
}

// =============================================================================
// PT Response Parsing
// =============================================================================

// Extract a single PT from the /pt/{address} API response, which may be
// wrapped in { data: ... } or returned directly. Returns undefined if the
// response is empty or an unexpected shape.
export function parsePtResponse(data: any): SpectraPt | undefined {
  if (!data) return undefined;
  // Wrapped: { data: <pt | [pt]> }
  if (data.data !== undefined) {
    if (Array.isArray(data.data)) return data.data[0] ?? undefined;
    return data.data ?? undefined;
  }
  // Bare array
  if (Array.isArray(data)) return data[0] ?? undefined;
  // Bare object — must at least have address + maturity to look like a PT
  if (typeof data === "object" && data.address && data.maturity) return data as SpectraPt;
  return undefined;
}

// =============================================================================
// Pool & PT Summaries
// =============================================================================

export function formatPoolSummary(pt: SpectraPt, pool: SpectraPool, chain: string): string {
  const lines = [
    `-- ${pt.name} --`,
    `  Chain: ${chain}`,
    `  PT Address: ${pt.address}`,
    `  Pool Address: ${pool.address || "unknown"}`,
    `  Maturity: ${formatDate(pt.maturity)} (${daysToMaturity(pt.maturity)} days)`,
    `  TVL: ${formatUsd(pt.tvl?.usd || 0)}`,
    `  Implied APY: ${formatPct(pool.impliedApy || 0)}`,
    `  PT Price: ${formatUsd(pool.ptPrice?.usd || 0)}`,
    `  YT Price: ${formatUsd(pool.ytPrice?.usd || 0)}`,
    `  YT Leverage: ${(pool.ytLeverage || 0).toFixed(1)}x`,
    `  Pool Liquidity: ${formatUsd(pool.liquidity?.usd || 0)}`,
    `  LP APY: ${formatPct(pool.lpApy?.total || 0)}`,
    `    +-- Fees: ${formatPct(pool.lpApy?.details?.fees || 0)}`,
    `    +-- PT: ${formatPct(pool.lpApy?.details?.pt || 0)}`,
    `    +-- IBT: ${formatPct(pool.lpApy?.details?.ibt || 0)}`,
  ];

  // External token rewards (e.g. KAT, rFLR, wAVAX)
  const rewards = pool.lpApy?.details?.rewards;
  if (rewards && Object.keys(rewards).length > 0) {
    for (const [token, apy] of Object.entries(rewards)) {
      lines.push(`    +-- ${token} Rewards: ${formatPct(apy)}`);
    }
  }

  // SPECTRA gauge emissions (boosted with veSPECTRA)
  const boosted = pool.lpApy?.details?.boostedRewards;
  if (boosted && Object.keys(boosted).length > 0) {
    for (const [token, range] of Object.entries(boosted)) {
      lines.push(`    +-- ${token} Gauge: ${formatPct(range.min)} -> ${formatPct(range.max)} (with veSPECTRA boost)`);
    }
  }

  // Boosted total (max boost APY)
  if (pool.lpApy?.boostedTotal && pool.lpApy.boostedTotal > (pool.lpApy?.total || 0)) {
    lines.push(`  LP APY (Max Boost): ${formatPct(pool.lpApy.boostedTotal)}`);
  }

  lines.push(
    `  Underlying: ${pt.underlying?.symbol || "?"} (${pt.underlying?.name || "?"})`,
    `  IBT: ${pt.ibt?.symbol || "?"} -- Base APR: ${formatPct(pt.ibt?.apr?.total || 0)}`,
    `  IBT Protocol: ${pt.ibt?.protocol || "Unknown"}`,
  );

  return lines.join("\n");
}

export function formatPtSummary(pt: SpectraPt, chain: string): string {
  const pool = pt.pools?.[0];
  if (!pool) return `${pt.name} -- no active pool`;
  return formatPoolSummary(pt, pool, chain);
}

// =============================================================================
// Position Summary (Portfolio)
// =============================================================================

export function formatPositionSummary(pos: SpectraPt, chain: string): PositionResult | null {
  const decimals = pos.decimals ?? 18;
  const ptBal = formatBalance(pos.balance, decimals);
  const ytBal = formatBalance(pos.yt?.balance, pos.yt?.decimals ?? decimals);
  const lpBal = pos.pools?.reduce((sum: number, p: SpectraPool) => {
    return sum + formatBalance(p.lpt?.balance, p.lpt?.decimals ?? 18);
  }, 0) || 0;

  // Skip positions with no balances
  if (ptBal === 0 && ytBal === 0 && lpBal === 0) return null;

  const pool = pos.pools?.[0];
  const ptPrice = pool?.ptPrice?.usd || 0;
  const ytPrice = pool?.ytPrice?.usd || 0;
  const lpPrice = pool?.lpt?.price?.usd || 0;
  const ptValue = ptBal * ptPrice;
  const ytValue = ytBal * ytPrice;
  const lpValue = lpBal * lpPrice;
  const totalValue = ptValue + ytValue + lpValue;

  const maturityDays = daysToMaturity(pos.maturity);
  const expired = pos.maturity * 1000 <= Date.now();

  const lines: string[] = [
    `-- ${pos.name} --`,
    `  Chain: ${chain}`,
    `  PT Address: ${pos.address}`,
    `  Maturity: ${formatDate(pos.maturity)} (${expired ? "EXPIRED" : `${maturityDays} days`})`,
    `  Underlying: ${pos.underlying?.symbol || "?"} | IBT: ${pos.ibt?.symbol || "?"}`,
    ``,
    `  Balances:`,
  ];

  if (ptBal > 0) lines.push(`    PT:  ${ptBal.toLocaleString("en-US", { maximumFractionDigits: 6 })}  (${formatUsd(ptValue)})`);
  if (ytBal > 0) lines.push(`    YT:  ${ytBal.toLocaleString("en-US", { maximumFractionDigits: 6 })}  (${formatUsd(ytValue)})`);
  if (lpBal > 0) lines.push(`    LP:  ${lpBal.toLocaleString("en-US", { maximumFractionDigits: 6 })}  (${formatUsd(lpValue)})`);
  lines.push(`    Total Value: ${formatUsd(totalValue)}`);

  // Claimable yield
  const claimable = pos.yt?.yield?.claimable;
  const claimed = pos.yt?.yield?.claimed;
  if (claimable && claimable !== "0") {
    const claimableAmt = formatBalance(claimable, pos.ibt?.decimals ?? decimals);
    lines.push(`    Claimable Yield: ${claimableAmt.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${pos.ibt?.symbol || "IBT"}`);
  }
  if (claimed && claimed !== "0") {
    const claimedAmt = formatBalance(claimed, pos.ibt?.decimals ?? decimals);
    lines.push(`    Already Claimed: ${claimedAmt.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${pos.ibt?.symbol || "IBT"}`);
  }

  // Current rates for context
  if (pool) {
    lines.push(``);
    lines.push(`  Current Rates:`);
    lines.push(`    Implied APY: ${formatPct(pool.impliedApy || 0)}`);
    lines.push(`    LP APY: ${formatPct(pool.lpApy?.total || 0)}`);
    lines.push(`    IBT Variable APR: ${formatPct(pos.ibt?.apr?.total || 0)}`);
  }

  if (expired) {
    lines.push(``);
    lines.push(`  MATURED -- PT redeemable 1:1. Consider claiming.`);
  }

  // Position shape — show balance ratios so the agent can reason about strategy
  if (!expired && (ptBal > 0 || ytBal > 0)) {
    const parts: string[] = [];
    if (ptBal > 0 && ytBal > 0) {
      const ratio = ptBal > ytBal
        ? `PT/YT ${Math.round(ptBal / ytBal)}:1`
        : `YT/PT ${Math.round(ytBal / ptBal)}:1`;
      parts.push(ratio);
    } else if (ytBal > 0) {
      parts.push("YT only (no PT)");
    } else {
      parts.push("PT only (no YT)");
    }
    if (lpBal > 0) parts.push(`LP: ${lpBal.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
    lines.push(``);
    lines.push(`  Position Shape: ${parts.join(" | ")}`);
  }

  return { text: lines.join("\n"), totalValue };
}

// =============================================================================
// Morpho Formatting
// =============================================================================

// Convert Morpho LLTV from BigInt string (e.g. "860000000000000000") to decimal (0.86).
// Uses BigInt arithmetic for precision on large integer strings (>15 digits).
// Returns 0 if the input is missing, non-numeric, or otherwise invalid.
export function formatMorphoLltv(raw: string | undefined | null): number {
  if (!raw) return 0;
  try {
    const bi = BigInt(raw);
    const divisor = BigInt("1000000000000000000"); // 1e18
    const intPart = bi / divisor;
    const fracPart = bi % divisor;
    return Number(intPart) + Number(fracPart) / Number(divisor);
  } catch {
    const val = Number(raw) / 1e18;
    return Number.isNaN(val) ? 0 : val;
  }
}

export function formatMorphoMarketSummary(m: MorphoMarket, protocol?: string): string {
  const lltv = formatMorphoLltv(m.lltv);
  const s = m.state;
  const chain = m.morphoBlue?.chain?.network || "unknown";
  const chainId = m.morphoBlue?.chain?.id || 0;
  const collateral = m.collateralAsset?.symbol || "?";
  const loan = m.loanAsset?.symbol || "?";

  const lines = [
    `-- ${collateral} / ${loan} --`,
    `  Morpho Market: ${m.uniqueKey.slice(0, 14)}...${m.uniqueKey.slice(-6)}`,
    `  Chain: ${chain} (${chainId})`,
  ];
  if (protocol) lines.push(`  Protocol: ${protocol}`);
  lines.push(
    `  Listed: ${m.listed ? "Yes" : "No"}`,
    `  LLTV: ${formatPct(lltv * 100)}`,
    `  Collateral: ${m.collateralAsset?.name || collateral} (${m.collateralAsset?.address || "?"})`,
    `  Loan: ${m.loanAsset?.name || loan} (${m.loanAsset?.address || "?"})`,
  );

  if (s) {
    lines.push(``);
    lines.push(`  Current State:`);
    lines.push(`    Borrow APY: ${formatPct((s.borrowApy || 0) * 100)}`);
    lines.push(`    Supply APY: ${formatPct((s.supplyApy || 0) * 100)}`);
    lines.push(`    Utilization: ${formatPct((s.utilization || 0) * 100)}`);
    lines.push(`    Total Supply: ${formatUsd(s.supplyAssetsUsd || 0)}`);
    lines.push(`    Total Borrow: ${formatUsd(s.borrowAssetsUsd || 0)}`);
    lines.push(`    Available Liquidity: ${formatUsd(s.liquidityAssetsUsd || 0)}`);
    lines.push(`    Collateral Deposited: ${formatUsd(s.collateralAssetsUsd || 0)}`);
    if ((s.fee ?? 0) > 0) lines.push(`    Protocol Fee: ${formatPct((s.fee ?? 0) * 100)}`);
  }

  if (m.warnings && m.warnings.length > 0) {
    lines.push(``);
    lines.push(`  Warnings:`);
    for (const w of m.warnings) {
      lines.push(`    [${w.level}] ${w.type}`);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Activity Formatting
// =============================================================================

// Activity types from the Spectra pool activity API.
// Note: No BUY_YT or SELL_YT — the Curve pool only trades IBT<->PT.
// YT selling via Router flash-redeem executes a BUY_PT internally.
// YT minting (deposit IBT -> PT+YT) does not appear in pool activity.
export const ACTIVITY_TYPES: Record<string, string> = {
  BUY_PT: "Buy PT",
  SELL_PT: "Sell PT",
  AMM_ADD_LIQUIDITY: "Add Liquidity",
  AMM_REMOVE_LIQUIDITY: "Remove Liquidity",
};

export function formatActivityType(type: string): string {
  return ACTIVITY_TYPES[type] || type;
}

// =============================================================================
// Math Helpers
// =============================================================================

// Cumulative leverage after N loops at a given LTV.
// Closed-form geometric series: (1 - ltv^(n+1)) / (1 - ltv)
export function cumulativeLeverageAtLoop(ltv: number, loops: number): number {
  if (loops <= 0) return 1;
  if (ltv === 1) return loops + 1; // degenerate case: sum of 1s
  return (1 - Math.pow(ltv, loops + 1)) / (1 - ltv);
}

// =============================================================================
// veSPECTRA Boost Computation
// =============================================================================

/**
 * Compute the real Spectra LP boost multiplier.
 *
 *   B = min(2.5, 1.5 * (v/V) * (D/d) + 1)
 *
 * Where:
 *   v = user's veSPECTRA balance
 *   V = total veSPECTRA supply
 *   D = pool TVL (total deposit value, USD)
 *   d = user's deposit value (USD)
 *
 * Returns:
 *   multiplier: 1.0–2.5 (the actual boost)
 *   boostFraction: 0.0–1.0 (maps B into the range used by computeLpApyAtBoost)
 *
 * boostFraction = (B - 1) / 1.5 correctly maps:
 *   B=1.0 (no boost)   -> 0.0
 *   B=2.5 (max boost)  -> 1.0
 */
export function computeSpectraBoost(
  veBalance: number,
  veTotalSupply: number,
  poolTvlUsd: number,
  capitalUsd: number,
): { multiplier: number; boostFraction: number } {
  if (veTotalSupply <= 0 || capitalUsd <= 0) {
    return { multiplier: 1, boostFraction: 0 };
  }

  const veShare = veBalance / veTotalSupply;        // v/V
  const poolShareInverse = poolTvlUsd / capitalUsd; // D/d
  const B = Math.min(2.5, 1.5 * veShare * poolShareInverse + 1);
  const boostFraction = Math.max(0, Math.min(1, (B - 1) / 1.5));

  return { multiplier: B, boostFraction };
}

/** Boost info passed through formatters — either per-pool computed boost or undefined. */
export interface BoostInfo {
  multiplier: number;       // 1.0–2.5
  boostFraction: number;    // 0.0–1.0
}

// =============================================================================
// LP APY Extraction Helper
// =============================================================================

/**
 * Compute LP APY at a given veSPECTRA boost level.
 *
 * The boost fraction (0.0–1.0) interpolates each gauge token's APY
 * between its min (no boost) and max (full 2.5x boost).
 *
 * Formula per gauge token: min + boostFraction * (max - min)
 *
 * The base (non-gauge) components (fees, PT, IBT, external rewards) are
 * unaffected by the boost — only SPECTRA gauge emissions scale.
 */
export function computeLpApyAtBoost(
  breakdown: {
    fees: number;
    pt: number;
    ibt: number;
    rewards: Record<string, number>;
    boostedRewards: Record<string, { min: number; max: number }>;
  },
  boostFraction: number,
): number {
  const clamp = Math.max(0, Math.min(1, boostFraction));
  let apy = breakdown.fees + breakdown.pt + breakdown.ibt;

  // External rewards (not affected by boost)
  for (const v of Object.values(breakdown.rewards)) {
    apy += v;
  }

  // SPECTRA gauge: interpolate min -> max
  for (const range of Object.values(breakdown.boostedRewards)) {
    apy += range.min + clamp * (range.max - range.min);
  }

  return apy;
}

/**
 * Extract a full LP APY breakdown from a SpectraPool, normalizing missing fields.
 * Used by scan_opportunities and scan_yt_arbitrage to attach LP data.
 *
 * @param boostFraction 0.0 = no veSPECTRA boost, 1.0 = max boost (2.5x). Default 0.
 */
export function extractLpApyBreakdown(pool: SpectraPool, boostFraction: number = 0): {
  lpApy: number;
  lpApyBoostedTotal: number;
  lpApyAtBoost: number;
  lpApyBreakdown: {
    fees: number;
    pt: number;
    ibt: number;
    rewards: Record<string, number>;
    boostedRewards: Record<string, { min: number; max: number }>;
  };
} {
  const lp = pool.lpApy;
  const breakdown = {
    fees: lp?.details?.fees || 0,
    pt: lp?.details?.pt || 0,
    ibt: lp?.details?.ibt || 0,
    rewards: lp?.details?.rewards || {},
    boostedRewards: lp?.details?.boostedRewards || {},
  };
  return {
    lpApy: lp?.total || 0,
    lpApyBoostedTotal: lp?.boostedTotal || lp?.total || 0,
    lpApyAtBoost: computeLpApyAtBoost(breakdown, boostFraction),
    lpApyBreakdown: breakdown,
  };
}

/**
 * Format LP APY lines for scan opportunity output. Returns 1-4 lines.
 *
 * @param boostInfo Real per-pool boost info (from computeSpectraBoost), or undefined if not computed.
 */
export function formatLpApyLines(
  lpApy: number,
  lpApyBoostedTotal: number,
  lpApyAtBoost: number,
  breakdown: {
    fees: number;
    pt: number;
    ibt: number;
    rewards: Record<string, number>;
    boostedRewards: Record<string, { min: number; max: number }>;
  },
  boostInfo?: BoostInfo,
): string[] {
  const lines: string[] = [];

  // Build compact breakdown parts
  const parts: string[] = [];
  parts.push(`fees ${formatPct(breakdown.fees)}`);
  if (breakdown.pt > 0) parts.push(`PT ${formatPct(breakdown.pt)}`);
  if (breakdown.ibt > 0) parts.push(`IBT ${formatPct(breakdown.ibt)}`);

  for (const [token, apy] of Object.entries(breakdown.rewards)) {
    parts.push(`${token} ${formatPct(apy)}`);
  }

  for (const [token, range] of Object.entries(breakdown.boostedRewards)) {
    parts.push(`${token} gauge ${formatPct(range.min)}-${formatPct(range.max)}`);
  }

  lines.push(`    LP APY: ${formatPct(lpApy)} (${parts.join(" + ")})`);

  if (lpApyBoostedTotal > lpApy) {
    lines.push(`    LP APY (Max Boost): ${formatPct(lpApyBoostedTotal)}`);
  }

  // Show agent's effective LP APY at their computed boost level
  if (boostInfo && boostInfo.multiplier > 1) {
    lines.push(`    LP APY (Your ${boostInfo.multiplier.toFixed(2)}x Boost): ${formatPct(lpApyAtBoost)}`);
  }

  return lines;
}

// =============================================================================
// Trade Quote Helpers
// =============================================================================

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

/**
 * Estimate cumulative price impact across multiple looping iterations.
 *
 * Each loop deploys capital * ltv^i into the pool. Prior loops have already
 * absorbed liquidity, so each subsequent loop faces a worse effective price.
 *
 * Per-loop model:
 *   amount_i = capitalUsd * ltv^i
 *   cumulativePrior_i = capitalUsd * (1 - ltv^i) / (1 - ltv)  (geometric partial sum)
 *   effectiveLiq_i = poolLiq - cumulativePrior_i / 2           (prior buys drain ~half)
 *   impact_i = amount_i / (2 * effectiveLiq_i)
 *
 * Returns blended impact % (dollar-weighted average across all loops) and per-loop breakdown.
 * This is conservative — Curve StableSwap-NG is more capital-efficient than this model.
 */
export function estimateLoopingEntryCost(
  capitalUsd: number,
  poolLiquidityUsd: number,
  ltv: number,
  loops: number,
): { totalImpactPct: number; perLoopImpacts: number[] } {
  if (poolLiquidityUsd <= 0 || capitalUsd <= 0 || loops <= 0) {
    return { totalImpactPct: 0, perLoopImpacts: [] };
  }

  const perLoopImpacts: number[] = [];
  let weightedImpactSum = 0;
  let totalDeployed = 0;

  for (let i = 0; i < loops; i++) {
    const amount = capitalUsd * Math.pow(ltv, i);
    // Cumulative capital deployed in prior loops (geometric partial sum for i terms)
    const cumulativePrior = i === 0 ? 0 : capitalUsd * (1 - Math.pow(ltv, i)) / (1 - ltv);
    // Each prior buy absorbs roughly half from the active liquidity side
    const effectiveLiq = Math.max(poolLiquidityUsd - cumulativePrior / 2, poolLiquidityUsd * 0.01);
    const impact = amount / (2 * effectiveLiq);
    const clampedImpact = Math.min(impact, 0.99);

    perLoopImpacts.push(clampedImpact * 100); // as percentage
    weightedImpactSum += amount * clampedImpact;
    totalDeployed += amount;
  }

  const blendedImpact = totalDeployed > 0 ? (weightedImpactSum / totalDeployed) * 100 : 0;
  return { totalImpactPct: blendedImpact, perLoopImpacts };
}

/**
 * Build a TradeQuote from PT + pool data. Pure computation — no API calls.
 * Returns null if PT price data is unavailable (zero or missing).
 * Used by both quote_trade and simulate_portfolio_after_trade tools.
 */
export function buildQuoteFromPt(
  pt: SpectraPt,
  pool: SpectraPool,
  amount: number,
  side: "buy" | "sell",
  slippagePct: number
): TradeQuote | null {
  const ptPriceUnderlying = pool.ptPrice?.underlying || 0;
  const ptPriceUsd = pool.ptPrice?.usd || 0;
  const poolLiqUsd = pool.liquidity?.usd || 0;
  const underlyingSymbol = pt.underlying?.symbol || "UNDERLYING";
  const ptName = pt.name || "PT";

  if (ptPriceUnderlying < 0.001) return null;
  if (amount <= 0) return null;

  let spotRate: number;
  let inputToken: string;
  let outputToken: string;
  let amountUsd: number;

  if (side === "buy") {
    spotRate = 1 / ptPriceUnderlying;
    inputToken = underlyingSymbol;
    outputToken = ptName;
    const underlyingPriceUsd = ptPriceUsd / ptPriceUnderlying;
    amountUsd = amount * underlyingPriceUsd;
  } else {
    spotRate = ptPriceUnderlying;
    inputToken = ptName;
    outputToken = underlyingSymbol;
    amountUsd = amount * ptPriceUsd;
  }

  const spotOut = amount * spotRate;
  const impactFrac = estimatePriceImpact(amountUsd, poolLiqUsd);
  const clampedImpact = Math.min(impactFrac, 0.99); // Clamp to prevent negative output
  const effectiveOut = spotOut * (1 - clampedImpact);
  const effectiveRate = effectiveOut / amount;
  const priceImpactPct = impactFrac * 100;
  const minOut = effectiveOut * (1 - slippagePct / 100);

  return {
    side,
    inputToken,
    outputToken,
    amountIn: amount,
    expectedOut: effectiveOut,
    spotRate,
    effectiveRate,
    priceImpactPct,
    minOut,
    slippageTolerancePct: slippagePct,
    poolLiquidityUsd: poolLiqUsd,
  };
}

export function formatTradeQuote(q: TradeQuote): string {
  const sideLabel = q.side === "buy" ? "Buy PT" : "Sell PT";
  const impactWarn =
    q.priceImpactPct > 5
      ? "  *** HIGH PRICE IMPACT -- consider splitting into smaller trades ***"
      : q.priceImpactPct > 1
        ? "  * Moderate price impact -- verify on-chain quote before executing *"
        : "";

  const lines = [
    `-- Trade Quote: ${sideLabel} --`,
    ``,
    `  Input:  ${q.amountIn.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${q.inputToken}`,
    `  Output: ${q.expectedOut.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${q.outputToken} (expected)`,
    ``,
    `  Spot Rate:      1 ${q.inputToken} = ${q.spotRate.toFixed(6)} ${q.outputToken}`,
    `  Effective Rate:  1 ${q.inputToken} = ${q.effectiveRate.toFixed(6)} ${q.outputToken}`,
    `  Price Impact:   ~${formatPct(q.priceImpactPct)} (conservative constant-product upper bound)`,
    ``,
    `  Slippage Tolerance: ${formatPct(q.slippageTolerancePct)}`,
    `  Min Output:     ${q.minOut.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${q.outputToken}`,
    ``,
    `  Pool Liquidity:  ${formatUsd(q.poolLiquidityUsd)}`,
  ];

  if (impactWarn) {
    lines.push(``);
    lines.push(impactWarn);
  }

  lines.push(``);
  lines.push(`  Note: Estimate only. Actual Curve StableSwap-NG pools are more capital-efficient,`);
  lines.push(`  so real impact will likely be lower. For exact on-chain quotes use:`);
  lines.push(`    - Curve pool: get_dy(i, j, amount)  [coins(0)=IBT, coins(1)=PT]`);
  lines.push(`    - Spectra Router: previewRate(commands, inputs)`);

  return lines.join("\n");
}

// =============================================================================
// Portfolio Simulation Formatting
// =============================================================================

function fmtNum(val: number): string {
  return val.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function fmtDelta(val: number): string {
  const sign = val >= 0 ? "+" : "";
  return `${sign}${fmtNum(val)}`;
}

function fmtDeltaUsd(val: number): string {
  const sign = val >= 0 ? "+$" : "-$";
  const abs = Math.abs(val);
  return `${sign}${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function snapLine(
  label: string, before: number, after: number, priceUsd: number
): string {
  const beforeVal = before * priceUsd;
  const afterVal = after * priceUsd;
  const delta = after - before;
  const deltaUsd = afterVal - beforeVal;
  if (delta === 0) {
    return `  ${label}:  ${fmtNum(after)}  (${formatUsd(afterVal)})    [no change]`;
  }
  return `  ${label}:  ${fmtNum(after)}  (${formatUsd(afterVal)})    [${fmtDelta(delta)}  (${fmtDeltaUsd(deltaUsd)})]`;
}

export function formatPortfolioSimulation(opts: {
  ptName: string;
  chain: string;
  maturity: number;
  wallet: string;
  underlyingSymbol: string;
  ibtSymbol: string;
  before: PositionSnapshot;
  after: PositionSnapshot;
  quote: TradeQuote;
  isNewPosition: boolean;
  sellExceedsBalance: boolean;
  ptPriceUsd: number;
  ytPriceUsd: number;
  lpPriceUsd: number;
  portfolioFetchFailed: boolean;
}): string {
  const expired = opts.maturity * 1000 <= Date.now();
  const maturityLabel = expired
    ? "EXPIRED"
    : `${daysToMaturity(opts.maturity)} days`;
  const shortWallet = `${opts.wallet.slice(0, 6)}...${opts.wallet.slice(-4)}`;

  const lines: string[] = [
    `== Portfolio Simulation: ${opts.ptName} ==`,
    `  Chain: ${opts.chain}`,
    `  Wallet: ${shortWallet}`,
    `  Maturity: ${formatDate(opts.maturity)} (${maturityLabel})`,
    `  Underlying: ${opts.underlyingSymbol} | IBT: ${opts.ibtSymbol}`,
  ];

  if (opts.portfolioFetchFailed) {
    lines.push(`  (Portfolio data unavailable -- simulating from zero balance)`);
  }

  // --- BEFORE ---
  lines.push(``);
  lines.push(`--- BEFORE ---`);
  if (opts.isNewPosition) {
    lines.push(`  No existing position in ${opts.ptName}.`);
    lines.push(`  PT: 0  |  YT: 0  |  LP: 0`);
    lines.push(`  Total Value: $0.00`);
  } else {
    lines.push(`  PT:  ${fmtNum(opts.before.ptBalance)}  (${formatUsd(opts.before.ptValueUsd)})`);
    lines.push(`  YT:  ${fmtNum(opts.before.ytBalance)}  (${formatUsd(opts.before.ytValueUsd)})`);
    lines.push(`  LP:  ${fmtNum(opts.before.lpBalance)}  (${formatUsd(opts.before.lpValueUsd)})`);
    lines.push(`  Total Value: ${formatUsd(opts.before.totalValueUsd)}`);
  }

  // --- TRADE ---
  lines.push(``);
  lines.push(`--- TRADE ---`);
  // Indent the quote output
  const quoteText = formatTradeQuote(opts.quote);
  for (const ql of quoteText.split("\n")) {
    lines.push(`  ${ql}`);
  }

  if (opts.sellExceedsBalance) {
    lines.push(``);
    lines.push(`  *** WARNING: Sell amount (${fmtNum(opts.quote.amountIn)} PT) exceeds current balance (${fmtNum(opts.before.ptBalance)} PT).`);
    lines.push(`      This simulation assumes the trade proceeds, but it cannot be executed on-chain. ***`);
  }

  // --- AFTER ---
  lines.push(``);
  lines.push(`--- AFTER ---`);
  lines.push(snapLine("PT", opts.before.ptBalance, opts.after.ptBalance, opts.ptPriceUsd));
  lines.push(snapLine("YT", opts.before.ytBalance, opts.after.ytBalance, opts.ytPriceUsd));
  lines.push(snapLine("LP", opts.before.lpBalance, opts.after.lpBalance, opts.lpPriceUsd));
  const totalDelta = opts.after.totalValueUsd - opts.before.totalValueUsd;
  lines.push(`  Total Value: ${formatUsd(opts.after.totalValueUsd)}    [${fmtDeltaUsd(totalDelta)}]`);

  // --- SUMMARY ---
  lines.push(``);
  lines.push(`--- SUMMARY ---`);
  const sideLabel = opts.quote.side === "buy" ? "Buy" : "Sell";
  lines.push(`  Trade: ${sideLabel} ${fmtNum(opts.quote.amountIn)} ${opts.quote.inputToken} -> ${fmtNum(opts.quote.expectedOut)} ${opts.quote.outputToken}`);
  lines.push(`  Portfolio Delta: ${fmtDeltaUsd(totalDelta)}`);
  lines.push(`  Note: Delta reflects Spectra position change only (PT/YT/LP).`);
  lines.push(`  ${opts.quote.side === "buy" ? `Underlying spent (${fmtNum(opts.quote.amountIn)} ${opts.quote.inputToken}) is not subtracted.` : `Underlying received (${fmtNum(opts.quote.expectedOut)} ${opts.quote.outputToken}) is not added.`}`);
  if (opts.after.totalValueUsd > 0) {
    const ptPct = (opts.after.ptValueUsd / opts.after.totalValueUsd) * 100;
    lines.push(`  New PT Exposure: ${formatUsd(opts.after.ptValueUsd)} (${formatPct(ptPct)} of portfolio)`);
  }

  if (expired) {
    lines.push(``);
    lines.push(`  PT has matured -- redemption is available at 1:1.`);
  }

  return lines.join("\n");
}

// =============================================================================
// Strategy Scanner Formatting
// =============================================================================

export function formatScanOpportunity(opp: ScanOpportunity, rank: number, boostInfo?: BoostInfo): string {
  const lines: string[] = [];

  // Header with rank and headline APY
  const headline = opp.looping
    ? `${formatPct(opp.impliedApy)} base -> ${formatPct(opp.looping.optimalEffectiveNetApy)} effective with ${opp.looping.optimalLoops}x loop`
    : `${formatPct(opp.impliedApy)} base -> ${formatPct(opp.effectiveApy)} effective`;
  lines.push(`#${rank}  ${opp.pt.name} (${opp.chain}) -- ${headline}`);

  // Maturity
  lines.push(`    Maturity: ${formatDate(opp.maturityTimestamp)} (${opp.daysToMaturity} days)`);

  // Pool size
  lines.push(`    TVL: ${formatUsd(opp.tvlUsd)} | Pool Liquidity: ${formatUsd(opp.poolLiquidityUsd)}`);

  // Capital-aware impact
  lines.push(`    Entry Impact: ~${formatPct(opp.entryImpactPct)} | Capacity: ~${formatUsd(opp.capacityUsd)} at <threshold`);

  // APY lines
  lines.push(`    Base APY: ${formatPct(opp.impliedApy)} | Effective APY: ${formatPct(opp.effectiveApy)} (after entry cost)`);

  // Looping section
  if (opp.looping) {
    lines.push(`    Looping: Morpho market found (LLTV ${formatPct(opp.looping.lltv * 100)}, borrow ${formatPct(opp.looping.borrowRatePct)})`);
    lines.push(`      Peak net APY: ${opp.looping.optimalLoops} loops -> ${formatPct(opp.looping.optimalNetApy)} (${opp.looping.optimalLeverage.toFixed(2)}x leverage)`);
    lines.push(`      Cumulative entry cost: ~${formatPct(opp.looping.cumulativeEntryImpactPct)} -> ${formatPct(opp.looping.optimalEffectiveNetApy)} effective net APY`);
    lines.push(`      Morpho Liquidity: ${formatUsd(opp.looping.morphoLiquidityUsd)}`);
  } else {
    lines.push(`    Looping: No Morpho market found`);
  }

  // LP yield (always incentivized by gauge emissions)
  const lpLines = formatLpApyLines(opp.lpApy, opp.lpApyBoostedTotal, opp.lpApyAtBoost, opp.lpApyBreakdown, boostInfo);
  for (const ll of lpLines) lines.push(ll);

  // Yield dimensions — all strategies side by side so the agent sees the tension
  const dims: string[] = [
    `Fixed: ${formatPct(opp.effectiveApy)}`,
    `Variable: ${formatPct(opp.variableApr)}`,
    `LP: ${formatPct(opp.lpApy)}`,
  ];
  if (opp.looping) dims.push(`Loop: ${formatPct(opp.looping.optimalEffectiveNetApy)}`);
  if (opp.lpApyBoostedTotal > opp.lpApy) dims.push(`LP(max boost): ${formatPct(opp.lpApyBoostedTotal)}`);
  lines.push(`    Yield Dimensions: ${dims.join(" | ")}`);

  // Underlying info
  lines.push(`    Underlying: ${opp.underlying} | IBT: ${opp.ibtSymbol} (${opp.ibtProtocol})`);

  // PT Address
  lines.push(`    PT Address: ${opp.ptAddress}`);

  // Warnings
  if (opp.warnings.length > 0) {
    lines.push(`    Warnings: ${opp.warnings.join("; ")}`);
  }

  return lines.join("\n");
}

export function formatScanResults(
  opportunities: ScanOpportunity[],
  capitalUsd: number,
  maxImpactPct: number,
  assetFilter: string | undefined,
  failedChains: string[],
  includeLooping: boolean,
  veSpectraBalance?: number,
  boostInfos?: (BoostInfo | undefined)[],
): string {
  const lines: string[] = [];

  // Header
  lines.push(`== Opportunity Scan: ${formatUsd(capitalUsd)} capital ==`);
  if (assetFilter) lines.push(`  Asset Filter: ${assetFilter}`);
  lines.push(`  Max Entry Impact: ${formatPct(maxImpactPct)}`);
  lines.push(`  Looping: ${includeLooping ? "enabled" : "disabled"}`);
  if (veSpectraBalance !== undefined && veSpectraBalance > 0) {
    lines.push(`  veSPECTRA: ${veSpectraBalance.toLocaleString("en-US")} tokens (boost varies per pool)`);
  }
  lines.push(`  Results: ${opportunities.length} opportunities sorted by ${includeLooping ? "looping net APY / " : ""}effective APY (see Yield Dimensions for other strategies)`);

  if (failedChains.length > 0) {
    lines.push(`  Note: ${failedChains.length} chain(s) failed (${failedChains.join(", ")}). Results may be partial.`);
  }

  lines.push(``);

  // Each opportunity
  for (let i = 0; i < opportunities.length; i++) {
    const bi = boostInfos?.[i];
    lines.push(formatScanOpportunity(opportunities[i], i + 1, bi));
    if (i < opportunities.length - 1) lines.push(``);
  }

  // Footer
  lines.push(``);
  lines.push(`  Estimates use constant-product upper bound. Actual Curve StableSwap-NG pools are more capital-efficient.`);

  return lines.join("\n");
}

// =============================================================================
// YT Arbitrage Formatting
// =============================================================================

export function formatYtArbitrageOpportunity(opp: YtArbitrageOpportunity, rank: number, boostInfo?: BoostInfo): string {
  const lines: string[] = [];

  const absSpread = Math.abs(opp.spreadPct);
  lines.push(`#${rank}  ${opp.pt.name} (${opp.chain}) -- ${formatPct(absSpread)} spread`);

  // Rates — the raw mechanics for the agent to interpret
  lines.push(`    IBT Current APR: ${formatPct(opp.ibtCurrentApr)}  (what the IBT actually earns now)`);
  lines.push(`    YT Implied Rate: ${formatPct(opp.ytImpliedRate)}  (what the YT market price implies)`);
  lines.push(`    Spread: ${opp.spreadPct >= 0 ? "+" : ""}${formatPct(opp.spreadPct)} (IBT APR minus YT implied rate)`);

  // YT price context
  lines.push(`    YT Price: ${formatUsd(opp.ytPriceUsd)} (${opp.ytPriceUnderlying.toFixed(4)} underlying) | Leverage: ${opp.ytLeverage.toFixed(1)}x`);

  // Maturity
  lines.push(`    Maturity: ${formatDate(opp.maturityTimestamp)} (${opp.daysToMaturity} days)`);

  // Size
  lines.push(`    TVL: ${formatUsd(opp.tvlUsd)} | Pool Liquidity: ${formatUsd(opp.poolLiquidityUsd)}`);

  // Capital-aware
  lines.push(`    Entry Impact: ~${formatPct(opp.entryImpactPct)} | Capacity: ~${formatUsd(opp.capacityUsd)}`);
  if (opp.breakEvenDays < Infinity) {
    lines.push(`    Break-Even: ~${Math.ceil(opp.breakEvenDays)} days (spread must persist to cover entry cost)`);
  }

  // LP yield (always incentivized by gauge emissions)
  const lpLines = formatLpApyLines(opp.lpApy, opp.lpApyBoostedTotal, opp.lpApyAtBoost, opp.lpApyBreakdown, boostInfo);
  for (const ll of lpLines) lines.push(ll);

  // Underlying info
  lines.push(`    Underlying: ${opp.underlying} | IBT: ${opp.ibtSymbol} (${opp.ibtProtocol})`);

  // PT Address
  lines.push(`    PT Address: ${opp.ptAddress}`);

  // Warnings
  if (opp.warnings.length > 0) {
    lines.push(`    Warnings: ${opp.warnings.join("; ")}`);
  }

  return lines.join("\n");
}

export function formatYtArbitrageResults(
  opportunities: YtArbitrageOpportunity[],
  capitalUsd: number,
  minSpreadPct: number,
  assetFilter: string | undefined,
  failedChains: string[],
  veSpectraBalance?: number,
  boostInfos?: (BoostInfo | undefined)[],
): string {
  const lines: string[] = [];

  const positiveSpread = opportunities.filter((o) => o.spreadPct > 0).length;
  const negativeSpread = opportunities.filter((o) => o.spreadPct <= 0).length;

  // Header
  lines.push(`== YT Arbitrage Scan: ${formatUsd(capitalUsd)} capital ==`);
  if (assetFilter) lines.push(`  Asset Filter: ${assetFilter}`);
  lines.push(`  Min Spread: ${formatPct(minSpreadPct)}`);
  if (veSpectraBalance !== undefined && veSpectraBalance > 0) {
    lines.push(`  veSPECTRA: ${veSpectraBalance.toLocaleString("en-US")} tokens (boost varies per pool)`);
  }
  lines.push(`  Results: ${opportunities.length} opportunities (${positiveSpread} positive spread, ${negativeSpread} negative spread)`);

  if (failedChains.length > 0) {
    lines.push(`  Note: ${failedChains.length} chain(s) failed (${failedChains.join(", ")}). Results may be partial.`);
  }

  lines.push(``);

  // Each opportunity
  for (let i = 0; i < opportunities.length; i++) {
    const bi = boostInfos?.[i];
    lines.push(formatYtArbitrageOpportunity(opportunities[i], i + 1, bi));
    if (i < opportunities.length - 1) lines.push(``);
  }

  // Footer
  lines.push(``);
  lines.push(`  Reading the spread:`);
  lines.push(`    Positive spread = IBT currently earns more than YT price implies.`);
  lines.push(`    Negative spread = IBT currently earns less than YT price implies.`);
  lines.push(``);
  lines.push(`  Spreads reflect current conditions only. IBT rates are variable. Break-even assumes the spread persists.`);
  lines.push(`  Price impact is a conservative upper bound (constant-product model).`);

  return lines.join("\n");
}

// =============================================================================
// MetaVault Strategy Formatting
// =============================================================================

export function formatMetavaultStrategy(opts: {
  baseApy: number;
  ytCompoundingApy: number;
  curatorFeePct: number;
  netVaultApy: number;
  grossVaultApy: number;
  morphoLtv: number;
  borrowRate: number;
  daysToMaturity: number;
  rows: MetavaultLoopRow[];
  bestLoop: number;
  bestNetApy: number;
  bestLeverage: number;
  curator?: MetavaultCuratorEconomics;
  comparePtApy?: number;
  comparePtRows?: MetavaultLoopRow[];
  comparePtBestLoop?: number;
  comparePtBestNetApy?: number;
}): string {
  const lines: string[] = [];

  // ── Vault Economics ────────────────────────────────────────
  lines.push(`== MetaVault Strategy Model ==`);
  lines.push(``);
  lines.push(`--- Vault Economics ---`);
  lines.push(`  Base LP APY:         ${formatPct(opts.baseApy)}`);
  if (opts.ytCompoundingApy > 0) {
    lines.push(`  YT→LP Compounding:   +${formatPct(opts.ytCompoundingApy)}`);
  }
  lines.push(`  Gross Vault APY:     ${formatPct(opts.grossVaultApy)}`);
  lines.push(`  Curator Fee Earned:  ${formatPct(opts.curatorFeePct)} of vault yield (curator's revenue)`);
  lines.push(`  Net Vault APY:       ${formatPct(opts.netVaultApy)} (what depositors receive after curator fee)`);
  lines.push(``);
  lines.push(`  Morpho LTV:          ${formatPct(opts.morphoLtv * 100)}`);
  lines.push(`  Borrow Rate:         ${formatPct(opts.borrowRate)}`);
  lines.push(`  Pool Cycle:          ${opts.daysToMaturity} days`);

  // ── Curator Economics ──────────────────────────────────────
  if (opts.curator) {
    const c = opts.curator;
    lines.push(``);
    lines.push(`--- Curator Economics ---`);
    lines.push(`  Own Capital:          ${formatUsd(c.capitalUsd)}`);
    lines.push(`  External Deposits:    ${formatUsd(c.externalDepositsUsd)}`);
    lines.push(`  Own TVL (looped):     ${formatUsd(c.ownTvl)} (${(c.ownTvl / c.capitalUsd).toFixed(2)}x leverage)`);
    lines.push(`  Additional TVL:       +${formatUsd(c.additionalTvlFromLooping)} from looping`);
    lines.push(`  Total Vault TVL:      ${formatUsd(c.totalTvl)}`);
    lines.push(``);
    lines.push(`  Annual Revenue:`);
    lines.push(`    Own Yield:          ${formatUsd(c.ownYieldUsd)}/yr (${formatPct(opts.bestNetApy)} on ${formatUsd(c.capitalUsd)})`);
    if (c.externalDepositsUsd > 0) {
      lines.push(`    Fee Revenue:        ${formatUsd(c.curatorFeeRevenueUsd)}/yr earned (${formatPct(opts.curatorFeePct)} of ${formatPct(opts.grossVaultApy)} on ${formatUsd(c.externalDepositsUsd)})`);
      lines.push(`    Total Revenue:      ${formatUsd(c.ownYieldUsd + c.curatorFeeRevenueUsd)}/yr`);
      lines.push(`    Effective ROI:      ${formatPct(c.effectiveCuratorApy)} on own capital`);
    }
  }

  // ── Leverage Table ─────────────────────────────────────────
  lines.push(``);
  lines.push(`--- MetaVault Looping Table ---`);
  lines.push(`  ${"Loop".padEnd(6)} ${"Lev".padEnd(8)} ${"Gross".padEnd(10)} ${"Net APY".padEnd(10)} ${"Margin".padEnd(10)} ${"TVL Mult".padEnd(10)}`);
  lines.push(`  ${"─".repeat(54)}`);

  for (const row of opts.rows) {
    lines.push(
      `  ${String(row.loop).padEnd(6)} ${(row.leverage.toFixed(2) + "x").padEnd(8)} ${formatPct(row.grossApy).padEnd(10)} ${formatPct(row.netApy).padEnd(10)} ${formatPct(row.effectiveMargin).padEnd(10)} ${(row.leverage.toFixed(2) + "x").padEnd(10)}`
    );
  }

  lines.push(``);
  lines.push(`  * Highest net APY: ${opts.bestLoop} loops -> ${formatPct(opts.bestNetApy)} (${opts.bestLeverage.toFixed(2)}x leverage). Margin column shows liquidation buffer per row.`);

  // ── PT Comparison ──────────────────────────────────────────
  if (opts.comparePtApy !== undefined && opts.comparePtRows) {
    lines.push(``);
    lines.push(`--- PT Looping Comparison ---`);
    lines.push(`  Raw PT APY: ${formatPct(opts.comparePtApy)} vs MetaVault Net: ${formatPct(opts.netVaultApy)}`);
    lines.push(``);
    lines.push(`  ${"Loop".padEnd(6)} ${"Lev".padEnd(8)} ${"PT Net".padEnd(10)} ${"MV Net".padEnd(10)} ${"Premium".padEnd(10)}`);
    lines.push(`  ${"─".repeat(44)}`);

    for (let i = 0; i < opts.rows.length; i++) {
      const mvRow = opts.rows[i];
      const ptRow = opts.comparePtRows[i];
      if (!ptRow) continue;
      const premium = mvRow.netApy - ptRow.netApy;
      const sign = premium >= 0 ? "+" : "";
      lines.push(
        `  ${String(mvRow.loop).padEnd(6)} ${(mvRow.leverage.toFixed(2) + "x").padEnd(8)} ${formatPct(ptRow.netApy).padEnd(10)} ${formatPct(mvRow.netApy).padEnd(10)} ${(sign + formatPct(premium)).padEnd(10)}`
      );
    }

    if (opts.comparePtBestNetApy !== undefined) {
      const totalPremium = opts.bestNetApy - opts.comparePtBestNetApy;
      lines.push(``);
      lines.push(`  PT peak: ${opts.comparePtBestLoop} loops -> ${formatPct(opts.comparePtBestNetApy)}`);
      lines.push(`  MV peak: ${opts.bestLoop} loops -> ${formatPct(opts.bestNetApy)}`);
      lines.push(`  Double-Loop Premium: ${totalPremium >= 0 ? "+" : ""}${formatPct(totalPremium)}`);
    }
  }

  // ── Rollover Advantage ─────────────────────────────────────
  if (opts.daysToMaturity > 0) {
    // Assume 3-7 days idle per manual rollover cycle
    const rolloverGapDays = 5;
    const cyclesPerYear = 365 / opts.daysToMaturity;
    const idleDaysPerYear = rolloverGapDays * cyclesPerYear;
    const rolloverDrag = opts.grossVaultApy * (idleDaysPerYear / 365);
    lines.push(``);
    lines.push(`--- Rollover Advantage ---`);
    lines.push(`  Manual LP: ~${rolloverGapDays} idle days per ${opts.daysToMaturity}-day cycle (${cyclesPerYear.toFixed(1)} cycles/yr)`);
    lines.push(`  Idle Days/Year: ~${Math.round(idleDaysPerYear)}`);
    lines.push(`  Yield Lost to Idle: ~${formatPct(rolloverDrag)}/yr`);
    lines.push(`  MetaVault: auto-rollover eliminates idle capital drag`);
  }

  // ── Risk Notes ─────────────────────────────────────────────
  lines.push(``);
  lines.push(`--- Risks ---`);
  lines.push(`  - Liquidation: MetaVault shares can depeg if underlying PT/LP positions lose value`);
  lines.push(`  - Smart contract: SAFE + Zodiac roles + Morpho + Spectra + Curve (deep composability stack)`);
  lines.push(`  - Borrow rate: Morpho rates are variable — can spike and erode looping margin`);
  lines.push(`  - Curator risk: Misconfigured rollovers, bad allocations, or delayed actions`);
  lines.push(`  - Liquidity: MetaVault shares may not have deep secondary market for unwinding`);
  lines.push(`  - This is a strategy model with hypothetical parameters. Verify all inputs before deploying.`);

  return lines.join("\n");
}
