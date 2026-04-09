/**
 * Data formatting helpers — USD, percentages, dates, balances, pool/position/Morpho summaries.
 */

import type { SpectraPt, SpectraPool, SpectraMetavault, SpectraMetavaultPosition, MorphoMarket, MorphoVault, MorphoVaultAllocation, MorphoMarketSupplier, PendleMarket, PositionResult, TradeQuote, PositionSnapshot, ScanOpportunity, YtArbitrageOpportunity, MetavaultLoopRow, MetavaultCuratorEconomics, SpectraMetavaultBridgeTx, MerklTokenReward, CrossProtocolMatch, CuratorOpportunity, MerklCampaign, MorphoUserPositions, MorphoHistoricalAnalysis, MorphoRateStats, MorphoPublicAllocatorLiquidity, CuratorRiskSummary, LiquidationAlert, RiskAlertLevel } from "./types.js";
import { SUPPORTED_CHAINS } from "./config.js";
import { lookupMerklCampaigns } from "./api.js";

// =============================================================================
// Primitive Formatters
// =============================================================================

/**
 * Parse a maturity date from PT/campaign naming conventions.
 * Handles two format families:
 *   - Morpho/Pendle: "PT Staked cap USD 29JAN2026", "PT-RLP-9APR2026"
 *   - Spectra: "PT-yvvbUSDC(vbUSDC)-2026/02/13", "2026/07/16"
 *
 * Returns Date or null. Pure perception — no interpretation.
 *
 * Dissolution condition: when protocols expose maturity as structured data
 * (e.g., Morpho GraphQL field), this parser is redundant.
 */
const MONTH_MAP: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};
export function parsePtMaturityFromName(name: string): Date | null {
  if (!name) return null;
  // Spectra style: 2026/02/13 or 2026/07/16
  const slashMatch = name.match(/(\d{4})\/(\d{2})\/(\d{2})/);
  if (slashMatch) {
    const d = new Date(Date.UTC(+slashMatch[1], +slashMatch[2] - 1, +slashMatch[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  // Morpho/Pendle style: 29JAN2026, 5MAR2026, 9APR2026
  const ddMonMatch = name.match(/(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})/i);
  if (ddMonMatch) {
    const mon = MONTH_MAP[ddMonMatch[2].toUpperCase()];
    if (mon !== undefined) {
      const d = new Date(Date.UTC(+ddMonMatch[3], mon, +ddMonMatch[1]));
      return isNaN(d.getTime()) ? null : d;
    }
  }
  return null;
}

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

// =============================================================================
// Entry Path Awareness
// =============================================================================
//
// Open emergence principle: the tools see protocol state, not the user's
// distance from that state. "19.8% APY" means nothing if you don't hold the
// entry asset and need 3 swaps to get there. This function makes the path
// visible — not by calculating swap costs (that changes by the second) but by
// naming the steps and flagging when the path is deep.
//
// The entry path is inferred from data already present in every PT:
//   underlying.symbol → the base asset (USDC, WETH, CRV)
//   ibt.symbol → the yield-bearing wrapper (asdCRV, sw-avUSDx, ynRWAx)
//   baseIbt.symbol → for sw-* wrappers, the unwrapped IBT underneath
//   chain → determines gas cost regime (mainnet $$, L2 ¢)
//
// Competing interpretations the function surfaces:
//   - "Direct entry" (underlying is USDC/WETH/ETH) vs "exotic entry" (ynRWAx, asdCRV)
//   - Mainnet gas makes small positions irrational; L2 gas is negligible
//   - sw-* wrappers add a hop that's invisible in the yield number
//   - The same yield on different chains has different real cost to enter

/** Common assets most wallets already hold or can acquire in one swap */
const DIRECT_ASSETS = new Set([
  "USDC", "USDT", "DAI", "USDC.e", "USDbC", "FRAX",
  "WETH", "ETH", "wETH",
  "WBTC", "BTC",
]);

/** Assets one swap away from common assets */
const ONE_HOP_ASSETS = new Set([
  "stETH", "wstETH", "cbETH", "rETH", "weETH", "ezETH", "rsETH",   // ETH LSTs
  "sDAI", "sUSDe", "GHO", "crvUSD", "FRAX", "pyUSD", "USDG",       // stablecoins one swap
  "CRV", "CVX", "AAVE", "COMP", "MKR",                               // governance one swap
]);

/** Gas regime by chain — rough order-of-magnitude cost for a complex tx */
const GAS_REGIME: Record<string, "high" | "medium" | "low"> = {
  mainnet: "high",    // $10-50 per tx
  ethereum: "high",
  base: "low",        // <$0.10
  arbitrum: "low",    // <$0.10
  optimism: "low",    // <$0.10
  sonic: "low",
  avalanche: "medium", // $0.50-2
  bsc: "low",
  flare: "low",
  katana: "low",
  monad: "low",
  hemi: "low",
};

/**
 * Infer the entry path complexity and return a human-readable description.
 *
 * Returns null when entry is trivial (underlying is USDC/ETH on L2).
 * Returns a string only when the agent SHOULD know about entry friction.
 * This is the open emergence criterion: surface tension only when it's real.
 */
export function inferEntryPath(
  underlyingSymbol: string | undefined,
  ibtSymbol: string | undefined,
  baseIbtSymbol: string | undefined,
  chain: string | undefined,
  capitalUsd?: number,
): string | null {
  if (!underlyingSymbol || !ibtSymbol) return null;

  const underlying = underlyingSymbol.toUpperCase().replace(/\.E$/i, ".e");
  const ibt = ibtSymbol;
  const gasRegime = GAS_REGIME[chain || ""] || "medium";

  // Count hops: underlying → IBT → (sw-wrapper?) → PT → LP
  // The underlying→IBT hop always exists (deposit into vault)
  // The sw-wrapper hop exists when baseIbt is present
  // PT minting and LP adding are protocol operations, always present
  let hops = 0;
  const steps: string[] = [];

  // Step 0: Acquire the underlying
  if (DIRECT_ASSETS.has(underlying)) {
    // User likely has it or can get it trivially
    // Don't count as a hop — this is the starting point
  } else if (ONE_HOP_ASSETS.has(underlying)) {
    hops += 1;
    steps.push(`acquire ${underlying} (1 swap from common assets)`);
  } else {
    // Exotic underlying — may need DEX aggregator, specific venue, or protocol interaction
    hops += 2;
    steps.push(`acquire ${underlying} (exotic — may require DEX aggregator or protocol-specific deposit)`);
  }

  // Step 1: Underlying → IBT (deposit into yield vault)
  hops += 1;
  steps.push(`deposit ${underlying} → ${ibt} (vault deposit)`);

  // Step 2: If sw-* wrapper exists, IBT → sw-IBT
  if (baseIbtSymbol && ibt.startsWith("sw-")) {
    hops += 1;
    steps.push(`wrap ${baseIbtSymbol} → ${ibt} (Spectra wrapper)`);
  }

  // Step 3: IBT → PT (mint or swap)
  // Step 4: PT + IBT → LP (add liquidity)
  // These are always present but are protocol operations the tools already guide

  // Decision: should we surface this?
  // Trivial entries (USDC → vault on L2) don't need a warning.
  // Complex entries (exotic asset + sw-wrapper + mainnet gas) do.
  const isExoticUnderlying = !DIRECT_ASSETS.has(underlying) && !ONE_HOP_ASSETS.has(underlying);
  const hasWrapper = !!baseIbtSymbol && ibt.startsWith("sw-");
  const isHighGas = gasRegime === "high";

  const isExotic = isExoticUnderlying;

  // Only surface when there's real friction to communicate
  if (hops <= 1 && !isHighGas && !(capitalUsd !== undefined)) return null;

  const parts: string[] = [];

  // Entry path steps
  if (hops > 1 || isExotic) {
    parts.push(`Entry path (${hops} step${hops > 1 ? "s" : ""} to IBT): ${steps.join(" → ")}`);
  }

  // Gas context — always show the ratio when capital is known, let agent judge.
  // Open emergence: no hardcoded "rational" threshold. The ratio IS the information.
  // $5 position with $10 gas = 200% gas ratio. $500 with $10 gas = 2%.
  // Both are informative. The agent decides what's acceptable for the strategy.
  const gasCostEstimate = isHighGas ? 10 : gasRegime === "medium" ? 2 : 0.5;
  if (capitalUsd !== undefined && capitalUsd > 0) {
    const gasRatio = (gasCostEstimate * 3) / capitalUsd * 100; // 3 txns typical (approve + deposit + mint)
    if (gasRatio > 1) { // only show when gas is >1% of position — below that it's noise
      parts.push(`Gas context: ~${formatUsd(gasCostEstimate)}/tx on ${gasRegime === "high" ? "mainnet" : gasRegime === "medium" ? "this chain" : "L2"}, ~3 txns needed. Estimated gas: ${gasRatio.toFixed(0)}% of ${formatUsd(capitalUsd)} position.`);
    }
  } else if (isHighGas) {
  } else if (isHighGas && hops > 1) {
    parts.push(`Note: Mainnet — gas for ${hops}-step entry adds meaningful friction. Consider whether position size justifies the cost.`);
  }

  // sw-wrapper opacity
  if (hasWrapper) {
    parts.push(`Note: ${ibt} is a Spectra wrapper around ${baseIbtSymbol}. The wrap is free but adds a step.`);
  }

  return parts.length > 0 ? parts.join("\n    ") : null;
}

// =============================================================================
// Prescriptive Observation Boundary
// =============================================================================
//
// The Dialectician found the deepest asymmetry in this codebase:
// diagnostic tools (ibt_health, risk_monitor, calibration) declare
// what they cannot see. Prescriptive tools (scan_opportunities,
// looping_strategy, curator_scanner) did not. The epistemological
// honesty lived where stakes were lowest and was absent where
// stakes were highest.
//
// This function adds the same honesty to every tool that produces
// ranked numerical recommendations an agent will act on.

/**
 * Generate observation boundary lines for prescriptive tools.
 * Call this at the end of any tool output that ranks opportunities
 * or projects returns — anywhere an agent might deploy capital
 * based on the numbers shown.
 *
 * @param context Which prescriptive tool is speaking
 * @param extras Additional context-specific caveats
 */
export function formatPrescriptiveObservationBoundary(
  context: "scan" | "looping" | "curator_scan" | "pendle_scan" | "pendle_looping",
  extras?: string[],
): string[] {
  const lines: string[] = [];
  lines.push(`── Observation Boundary ──`);
  lines.push(`  This ranking is a point-in-time snapshot. Numbers shown have temporal instability:`);
  lines.push(`  • Borrow rates are variable — Morpho rates can spike 10x in hours. Looping spreads`);
  lines.push(`    that are profitable now may turn negative before your transaction confirms.`);
  lines.push(`  • Pool liquidity was sampled once — a large trade in the pool between this snapshot`);
  lines.push(`    and your entry changes all impact estimates.`);
  lines.push(`  • Merkl subsidies have expiry dates — campaign APR shown may end without notice.`);
  lines.push(`    Check merkl_list_campaigns for campaign duration before sizing positions.`);
  lines.push(`  • Effective APY is computed, not guaranteed — it combines base rate, entry cost`);
  lines.push(`    amortization, and subsidy APR, each with different shelf lives.`);

  if (context === "looping" || context === "pendle_looping") {
    lines.push(`  • Leverage amplifies ALL of the above — a 3x loop has 3x exposure to rate changes,`);
    lines.push(`    3x sensitivity to liquidity shifts, and 3x consequences from subsidy expiry.`);
  }

  if (context === "curator_scan") {
    lines.push(`  • Cross-protocol rankings compare Spectra and Pendle with different AMM models —`);
    lines.push(`    Spectra uses Curve StableSwap-NG, Pendle uses logit with time-decay. Impact`);
    lines.push(`    estimates are not directly comparable at the margin.`);
  }

  if (extras) {
    for (const e of extras) lines.push(`  • ${e}`);
  }

  lines.push(`  Two-decimal-place display implies precision that does not exist.`);
  lines.push(`  Use mv_get_calibration to see historical volatility for any specific market.`);

  return lines;
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

/**
 * Format a bigint token amount with specified decimals for display.
 * Returns a string like "1,012.5000" (4 fractional digits, comma-separated).
 */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  const safeDec = Math.max(0, Math.round(decimals));
  let divisor = 1n;
  for (let i = 0; i < safeDec; i++) divisor *= 10n;
  const intPart = raw / divisor;
  const fracPart = raw % divisor;
  // Show up to 4 fractional digits
  const fracStr = fracPart.toString().padStart(safeDec, "0").slice(0, 4);
  const intStr = Number(intPart).toLocaleString("en-US");
  if (safeDec === 0 || fracStr === "0000") return intStr;
  return `${intStr}.${fracStr.replace(/0+$/, "")}`;
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
  const ibtAddr = pt.ibt?.address ? ` | IBT: ${pt.ibt.address}` : "";
  const tags = pt.tags && pt.tags.length > 0 ? ` | ${pt.tags.join(",")}` : "";
  const points = pt.multipliers && pt.multipliers.length > 0
    ? ` | Points: ${pt.multipliers.map(m => `${m.name} ${m.amount}x`).join(", ")}`
    : "";
  const priceFeedWarn = (pt.tvl?.usd || 0) === 0 && (pool.liquidity?.usd || 0) === 0
    && pool.ibtAmount && pool.ptAmount && (Number(pool.ibtAmount) > 0 || Number(pool.ptAmount) > 0)
    ? " | ⚡ $0 USD — likely price feed outage, not empty pool"
    : "";
  return `${pt.name} (${chain}) | APY ${apy} | Underlying ${tvl} | Depth ${liq} | ${days}d${lpApy} | PT: ${pt.address} | Pool: ${pool.address || "?"}${ibtAddr}${tags}${points}${priceFeedWarn}`;
}

/** One-line scan opportunity summary for compact output. */
export function formatScanOpportunityCompact(opp: ScanOpportunity, rank: number): string {
  const loopTag = opp.looping
    ? ` | Loop ${formatPct(opp.looping.optimalEffectiveNetApy)} @${opp.looping.optimalLoops}x`
    : "";
  const points = opp.pt.multipliers && opp.pt.multipliers.length > 0
    ? ` | Points: ${opp.pt.multipliers.map(m => `${m.name} ${m.amount}x`).join(", ")}`
    : "";
  // Use sortApy (the same metric used for ranking) to avoid showing wildly negative effectiveApy
  // while sorting by a different field — agents anchor on the displayed number.
  const displayApy = opp.sortApy ?? opp.effectiveApy;
  return `#${rank} ${opp.pt.name} (${opp.chain}) | APY ${formatPct(displayApy)} | Impl ${formatPct(opp.impliedApy)} | Impact ${formatPct(opp.entryImpactPct)} | ${opp.daysToMaturity}d${loopTag} | PT: ${opp.ptAddress} | Pool: ${opp.poolAddress}${points}`;
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
// Merkl Campaign Formatting
// =============================================================================

/**
 * Format Merkl campaign lines for display under a pool/market.
 * Filters out campaigns whose reward tokens are already shown via API rewards.
 * Returns formatted lines (empty array if nothing to show).
 */
export function formatMerklCampaignLines(
  campaigns: MerklCampaign[],
  existingRewardTokens?: Set<string>,
  indent: string = "    ",
): string[] {
  if (!campaigns || campaigns.length === 0) return [];

  // Filter to campaigns with meaningful APR, skip tokens already shown
  const filtered = campaigns.filter((c) => {
    if (c.apr <= 0) return false;
    if (existingRewardTokens && c.rewardTokens.length > 0) {
      // Skip if ALL reward tokens are already displayed
      const allKnown = c.rewardTokens.every((t) => existingRewardTokens.has(t.toUpperCase()));
      if (allKnown) return false;
    }
    return true;
  });

  if (filtered.length === 0) return [];

  const lines: string[] = [];
  lines.push(`${indent.slice(2)}Merkl Campaigns:`);
  for (const c of filtered) {
    const tokens = c.rewardTokens.length > 0 ? c.rewardTokens.join(", ") : "Rewards";
    const action = c.action || "UNKNOWN";
    const eligNote = action === "POOL" ? " [LP only — not for YT/PT holders]" : "";
    // Show campaign end date when available — subsidy duration matters for strategy
    let endNote = "";
    if (c.earliestEnd || c.latestEnd) {
      const endTs = c.latestEnd || c.earliestEnd!;
      const daysLeft = Math.max(0, Math.floor((endTs * 1000 - Date.now()) / 86400000));
      if (daysLeft <= 7) endNote = ` ⚠ expires in ${daysLeft}d`;
      else if (daysLeft <= 30) endNote = ` (${daysLeft}d left)`;
      else endNote = ` (ends ${new Date(endTs * 1000).toISOString().slice(0, 10)})`;
    }
    lines.push(`${indent}+-- ${tokens} (${action})${eligNote}: ${formatPct(c.apr)} APR${endNote}`);
  }
  return lines;
}

// =============================================================================
// Pool & PT Summaries
// =============================================================================

export function formatPoolSummary(pt: SpectraPt, pool: SpectraPool, chain: string, merklCampaigns?: MerklCampaign[]): string {
  const lines = [
    `-- ${pt.name} --`,
    `  Chain: ${chain}`,
    `  PT Address: ${pt.address}`,
    `  Pool Address: ${pool.address || "unknown"}`,
    `  Maturity: ${formatDate(pt.maturity)} (${daysToMaturity(pt.maturity)} days)`,
    `  PT TVL: ${formatUsd(pt.tvl?.usd || 0)}`,
    `  Implied APY: ${formatPct(pool.impliedApy || 0)}`,
    `  PT Price: ${formatUsd(pool.ptPrice?.usd || 0)}${pool.ptPrice?.underlying != null ? ` (${pool.ptPrice.underlying.toFixed(6)} underlying)` : ""}`,
    `  YT Price: ${formatUsd(pool.ytPrice?.usd || 0)}`,
    `  YT Leverage: ${(pool.ytLeverage || 0).toFixed(1)}x`,
    `  Liquidity: ${formatUsd(pool.liquidity?.usd || 0)}`,
  ];

  // Price feed awareness: when USD values are $0 but on-chain reserves exist,
  // the likely cause is a price feed outage (e.g. DeFiLlama), not an empty pool.
  const hasReserves = pool.ibtAmount && pool.ptAmount &&
    (Number(pool.ibtAmount) > 0 || Number(pool.ptAmount) > 0);
  const zeroUsd = (pt.tvl?.usd || 0) === 0 && (pool.liquidity?.usd || 0) === 0;
  if (zeroUsd && hasReserves) {
    lines.push(`  ⚡ $0 USD values but pool has on-chain reserves — likely a price feed outage (DeFiLlama or similar), not an empty pool. Verify on-chain before concluding this pool is dead.`);
  }

  // Pool reserves — surface IBT/PT composition for AMM imbalance analysis
  if (pool.ibtAmount && pool.ptAmount) {
    const ibtDec = pt.ibt?.decimals ?? pt.decimals ?? 18;
    const ptDec = pt.decimals ?? 18;
    const ibtReserve = formatBalance(pool.ibtAmount, ibtDec);
    const ptReserve = formatBalance(pool.ptAmount, ptDec);
    if (ibtReserve > 0 || ptReserve > 0) {
      const ratio = ibtReserve > 0 ? (ptReserve / ibtReserve).toFixed(2) : "N/A";
      lines.push(`  Pool Reserves: ${ibtReserve.toLocaleString("en-US", { maximumFractionDigits: 2 })} IBT / ${ptReserve.toLocaleString("en-US", { maximumFractionDigits: 2 })} PT (ratio ${ratio})`);
    }
  }

  lines.push(
    `  LP APY: ${formatPct(pool.lpApy?.total || 0)}`,
    `    +-- Swap Fees: ${formatPct(pool.lpApy?.details?.fees || 0)}`,
    `    +-- PT Discount Convergence: ${formatPct(pool.lpApy?.details?.pt || 0)}`,
    `    +-- IBT Yield Accrual: ${formatPct(pool.lpApy?.details?.ibt || 0)}`,
  );

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
      if (range.min == null && range.max == null) continue; // skip gauges with no data
      lines.push(`    +-- ${token} Gauge: ${formatPct(range.min ?? 0)} -> ${formatPct(range.max ?? 0)} (with veSPECTRA boost)`);
    }
  }

  // Boosted total (max boost APY)
  if (pool.lpApy?.boostedTotal && pool.lpApy.boostedTotal > (pool.lpApy?.total || 0)) {
    lines.push(`  LP APY (Max Boost): ${formatPct(pool.lpApy.boostedTotal)}`);
  }

  // Merkl campaign incentives (supplemental to API rewards)
  if (merklCampaigns && merklCampaigns.length > 0) {
    const existingTokens = new Set<string>();
    if (rewards) {
      for (const token of Object.keys(rewards)) existingTokens.add(token.toUpperCase());
    }
    const merklLines = formatMerklCampaignLines(merklCampaigns, existingTokens);
    for (const ml of merklLines) lines.push(ml);
  }

  // LP APY sustainability signal: flag when incentives dominate
  const lpTotal = pool.lpApy?.total || 0;
  const lpOrganic = (pool.lpApy?.details?.fees || 0) + (pool.lpApy?.details?.pt || 0) + (pool.lpApy?.details?.ibt || 0);
  const lpIncentives = lpTotal - lpOrganic;
  if (lpTotal > 0 && lpIncentives > 0 && lpOrganic < lpTotal * 0.5) {
    lines.push(`  LP APY (organic only, no rewards/gauge): ${formatPct(lpOrganic)}`);
  }

  lines.push(
    `  Underlying: ${pt.underlying?.symbol || "?"} (${pt.underlying?.name || "?"})`,
  );
  if (pt.underlying?.address) {
    lines.push(`  Underlying Address: ${pt.underlying.address}`);
  }
  lines.push(
    `  IBT: ${pt.ibt?.symbol || "?"} -- APR: ${formatPct(pt.ibt?.apr?.total || 0)}`,
  );

  // IBT APR breakdown — surface composition so agents can reason about yield sources
  const ibtDetails = pt.ibt?.apr?.details;
  if (ibtDetails) {
    if (ibtDetails.base != null) {
      lines.push(`    +-- Base: ${formatPct(ibtDetails.base)}`);
    }
    if (ibtDetails.rewards && Object.keys(ibtDetails.rewards).length > 0) {
      for (const [token, apy] of Object.entries(ibtDetails.rewards)) {
        lines.push(`    +-- ${token}: ${formatPct(apy)}`);
      }
    }
    // Incentive sustainability signal: flag when incentives dominate IBT APR
    const ibtTotal = pt.ibt?.apr?.total || 0;
    const ibtBase = ibtDetails.base ?? 0;
    const ibtIncentives = ibtTotal - ibtBase;
    if (ibtTotal > 0 && ibtIncentives > 0 && ibtBase < ibtTotal * 0.5) {
      const incentivePct = (ibtIncentives / ibtTotal * 100).toFixed(0);
      lines.push(`    ** ${incentivePct}% of IBT APR comes from incentives. Base yield alone: ${formatPct(ibtBase)} **`);
    }
  }

  if (pt.ibt?.address) {
    lines.push(`  IBT Address: ${pt.ibt.address}`);
  }
  lines.push(
    `  IBT Protocol: ${pt.ibt?.protocol || "Unknown"}`,
  );

  // BaseIbt — unwrapped token for sw-* wrappers (reveals the actual underlying IBT)
  if (pt.baseIbt?.symbol) {
    lines.push(`  Base IBT: ${pt.baseIbt.symbol} (${pt.baseIbt.name || "?"})`);
    if (pt.baseIbt.address) lines.push(`  Base IBT Address: ${pt.baseIbt.address}`);
  }

  // Entry path awareness — surface the distance between common assets and this pool.
  // Only shown when entry has real friction (exotic underlying, sw-wrapper, mainnet gas).
  // Trivial entries (USDC → vault on L2) produce null and are silently skipped.
  const entryPath = inferEntryPath(
    pt.underlying?.symbol, pt.ibt?.symbol, pt.baseIbt?.symbol, chain
  );
  if (entryPath) {
    lines.push(``);
    lines.push(`  ── Entry Path ──`);
    lines.push(`  ${entryPath}`);
  }

  // Maturity value — what 1 PT redeems for at maturity
  if (pt.maturityValue) {
    const parts: string[] = [];
    if (pt.maturityValue.underlying != null) parts.push(`${pt.maturityValue.underlying.toFixed(6)} underlying`);
    if (pt.maturityValue.usd != null) parts.push(formatUsd(pt.maturityValue.usd));
    if (parts.length > 0) lines.push(`  Maturity Value (per PT): ${parts.join(" / ")}`);
  }

  // Points program multipliers (e.g. Drops 3x, InfiniFi 12x)
  if (pt.multipliers && pt.multipliers.length > 0) {
    const mParts = pt.multipliers.map(m => `${m.name} ${m.amount}x`);
    lines.push(`  Points: ${mParts.join(", ")}`);
  }

  // Asset tags (stable, eth, etc.)
  if (pt.tags && pt.tags.length > 0) {
    lines.push(`  Tags: ${pt.tags.join(", ")}`);
  }

  lines.push(`  Protocol YT Fee: 3% on all yield + points (docs.spectra.finance/tokenomics/fees)`);

  return lines.join("\n");
}

export function formatPtSummary(pt: SpectraPt, chain: string, merklCampaigns?: MerklCampaign[]): string {
  const pool = pt.pools?.[0];
  if (!pool) return `${pt.name} -- no active pool`;
  return formatPoolSummary(pt, pool, chain, merklCampaigns);
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
    `  Underlying: ${pos.underlying?.symbol || "?"}${pos.underlying?.address ? ` (${pos.underlying.address})` : ""} | IBT: ${pos.ibt?.symbol || "?"}${pos.ibt?.address ? ` (${pos.ibt.address})` : ""}`,
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

  // Maturity value — what 1 PT redeems for at maturity
  if (pos.maturityValue) {
    const mvParts: string[] = [];
    if (pos.maturityValue.underlying != null) mvParts.push(`${pos.maturityValue.underlying.toFixed(6)} underlying`);
    if (pos.maturityValue.usd != null) mvParts.push(formatUsd(pos.maturityValue.usd));
    if (mvParts.length > 0) lines.push(`    Maturity Value (per PT): ${mvParts.join(" / ")}`);
  }

  // Points programs
  if (pos.multipliers && pos.multipliers.length > 0) {
    const mParts = pos.multipliers.map(m => `${m.name} ${m.amount}x`);
    lines.push(`  Points: ${mParts.join(", ")}`);
  }

  // Current rates for context
  if (pool) {
    lines.push(``);
    lines.push(`  Current Rates:`);
    lines.push(`    Implied APY: ${formatPct(pool.impliedApy || 0)}`);
    lines.push(`    LP APY: ${formatPct(pool.lpApy?.total || 0)}`);
    // Gauge boost range: surface the yield range so agents know to check veSPECTRA
    if (lpBal > 0) {
      const { lpApy, lpApyBoostedTotal, lpApyBreakdown } = extractLpApyBreakdown(pool, 0);
      const hasBoostedRewards = Object.keys(lpApyBreakdown.boostedRewards).length > 0;
      if (hasBoostedRewards && lpApyBoostedTotal > lpApy) {
        lines.push(`    Gauge boost range: LP APY ${formatPct(lpApy)} (min) → ${formatPct(lpApyBoostedTotal)} (max 2.5x). Actual boost unknown — use spectra_get_ve_info to determine.`);
      }
    }
    lines.push(`    IBT Variable APR: ${formatPct(pos.ibt?.apr?.total || 0)}`);
    // IBT APR breakdown — surface composition
    const ibtDet = pos.ibt?.apr?.details;
    if (ibtDet) {
      const ibtParts: string[] = [];
      if (ibtDet.base != null) ibtParts.push(`base ${formatPct(ibtDet.base)}`);
      if (ibtDet.rewards) {
        for (const [token, apy] of Object.entries(ibtDet.rewards)) {
          ibtParts.push(`${token} ${formatPct(apy)}`);
        }
      }
      if (ibtParts.length > 0) {
        lines.push(`      (${ibtParts.join(" + ")})`);
      }
    }
  }

  if (expired) {
    lines.push(``);
    if (pos.maturityValue?.underlying != null) {
      lines.push(`  MATURED -- PT redeems at ${pos.maturityValue.underlying.toFixed(6)} underlying. Consider claiming.`);
    } else {
      lines.push(`  MATURED -- PT redeemable at maturity value. Consider claiming.`);
    }
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

    // Data-driven tensions: surface competing explanations only when position shape is genuinely ambiguous
    if (ytBal > 0 && ptBal === 0 && lpBal === 0) {
      lines.push(`    Competing explanations: (A) Sold PT to fund YT acquisition — directional bet on variable rate exceeding implied. ` +
        `(B) Minted PT+YT and LPed the PT — but LP token shows zero, so either LP was withdrawn or it's in a different wallet. ` +
        `(C) Received YT via transfer from another wallet (multi-wallet strategy). ` +
        `spectra_get_pool_activity with this address resolves which.`);
    } else if (ptBal > 0 && ytBal === 0 && lpBal === 0) {
      lines.push(`    Competing explanations: (A) Bought PT on the AMM for fixed yield — straightforward. ` +
        `(B) Minted PT+YT and sold the YT — effectively shorting variable rate. ` +
        `(C) Received PT from LP withdrawal (pool returned IBT + PT, user kept PT). ` +
        `These imply different exit strategies: (A) and (B) likely hold to maturity, ` +
        `(C) may sell soon. spectra_get_pool_activity resolves.`);
    } else if (lpBal > 0 && ytBal > 0 && ptBal === 0) {
      lines.push(`    Competing explanations: (A) Router-batched mint+LP (minted PT+YT, PT went into LP, YT kept) — ` +
        `yield farming strategy earning LP fees + YT variable yield. ` +
        `(B) Separate LP entry + separate YT purchase — more expensive in gas, suggests deliberate sizing. ` +
        `The strategy is similar either way, but cost basis differs.`);
    } else if (ytBal > 0 && ptBal > 0 && ytBal > ptBal * 3) {
      lines.push(`    YT-heavy ratio suggests net YT accumulation. Could be: (A) repeated mint+sell-PT loops, ` +
        `or (B) direct YT acquisition via flash-mint. Either way, this is a leveraged bet that ` +
        `variable yield will exceed the implied rate over the remaining ${maturityDays} days.`);
    }

    // Navigational hint: surface the temporal blind spot
    if (totalValue > 100) {
      lines.push(`    Entry timing and cost basis unknown from portfolio alone. Use spectra_get_pool_activity with address parameter to reconstruct.`);
    }
  }

  return { text: lines.join("\n"), totalValue };
}

// =============================================================================
// Merkl Rewards Formatting
// =============================================================================

/** Format Merkl reward lines for a single position. Returns indented lines to append. */
export function formatMerklRewards(rewards: MerklTokenReward[]): string[] {
  if (!rewards || rewards.length === 0) return [];

  const lines: string[] = [];
  lines.push(`  Merkl Rewards:`);

  for (const r of rewards) {
    const parts: string[] = [];
    if (r.unclaimed > 0) {
      parts.push(`unclaimed: ${r.unclaimed.toLocaleString("en-US", { maximumFractionDigits: 4 })}`);
    }
    if (r.pending > 0) {
      parts.push(`pending: ${r.pending.toLocaleString("en-US", { maximumFractionDigits: 4 })}`);
    }
    if (r.accumulated > 0) {
      parts.push(`total earned: ${r.accumulated.toLocaleString("en-US", { maximumFractionDigits: 4 })}`);
    }
    if (parts.length > 0) {
      lines.push(`    ${r.symbol}: ${parts.join(" | ")}`);
    }
  }

  return lines.length > 1 ? lines : [];
}

/** Format unmatched Merkl rewards (from pools no longer in portfolio). */
export function formatUnmatchedMerklRewards(
  unmatchedByChain: Array<{ chain: string; rewards: MerklTokenReward[] }>,
): string {
  const allRewards = unmatchedByChain.filter(c => c.rewards.length > 0);
  if (allRewards.length === 0) return "";

  const lines: string[] = [
    ``,
    `--- Unclaimed Merkl Rewards (from exited positions) ---`,
  ];

  for (const { chain, rewards } of allRewards) {
    for (const r of rewards) {
      const parts: string[] = [];
      if (r.unclaimed > 0) parts.push(`unclaimed: ${r.unclaimed.toLocaleString("en-US", { maximumFractionDigits: 4 })}`);
      if (r.pending > 0) parts.push(`pending: ${r.pending.toLocaleString("en-US", { maximumFractionDigits: 4 })}`);
      if (parts.length > 0) {
        lines.push(`  ${r.symbol} (${chain}): ${parts.join(" | ")}`);
      }
    }
  }

  lines.push(`  Note: These rewards are from pools you may have exited. Claim on https://app.merkl.xyz/`);

  return lines.length > 2 ? lines.join("\n") : "";
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

/**
 * Compute the USD value of reallocatable liquidity from the Public Allocator.
 * Uses the loan asset price to convert raw token amounts to USD.
 * Returns 0 when no reallocatable liquidity is present.
 */
export function computeReallocatableUsd(m: MorphoMarket): number {
  const raw = m.reallocatableLiquidityAssets;
  if (!raw || raw === "0") return 0;
  const loanDecimals = m.loanAsset?.decimals ?? 18;
  const loanPrice = m.loanAsset?.priceUsd ?? 1;
  return Number(BigInt(raw)) / (10 ** loanDecimals) * loanPrice;
}

/** Effective liquidity = direct market liquidity + reallocatable from Public Allocator. */
export function getEffectiveLiquidityUsd(m: MorphoMarket): number {
  return (m.state?.liquidityAssetsUsd || 0) + computeReallocatableUsd(m);
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
    `  Morpho Market: ${m.uniqueKey}`,
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
    // Compute reallocatable liquidity in USD
    const reallocatableRaw = m.reallocatableLiquidityAssets ? BigInt(m.reallocatableLiquidityAssets) : 0n;
    const loanDecimals = m.loanAsset?.decimals ?? 18;
    const loanPriceUsd = m.loanAsset?.priceUsd ?? 1;
    const reallocatableUsd = reallocatableRaw > 0n
      ? Number(reallocatableRaw) / (10 ** loanDecimals) * loanPriceUsd
      : 0;
    const directSupply = s.supplyAssetsUsd || 0;
    const directLiquidity = s.liquidityAssetsUsd || 0;
    const totalSupply = directSupply + reallocatableUsd;
    const totalLiquidity = directLiquidity + reallocatableUsd;

    lines.push(``);
    lines.push(`  Current State:`);
    lines.push(`    Borrow APY: ${formatPct((s.borrowApy || 0) * 100)}`);
    lines.push(`    Supply APY: ${formatPct((s.supplyApy || 0) * 100)}`);
    lines.push(`    Utilization: ${formatPct((s.utilization || 0) * 100)}`);
    if (reallocatableUsd > 0) {
      lines.push(`    Total Supply: ${formatUsd(totalSupply)} (direct ${formatUsd(directSupply)} + reallocatable ${formatUsd(reallocatableUsd)})`);
      lines.push(`    Total Borrow: ${formatUsd(s.borrowAssetsUsd || 0)}`);
      lines.push(`    Available Liquidity: ${formatUsd(totalLiquidity)} (direct ${formatUsd(directLiquidity)} + reallocatable ${formatUsd(reallocatableUsd)})`);
    } else {
      lines.push(`    Total Supply: ${formatUsd(directSupply)}`);
      lines.push(`    Total Borrow: ${formatUsd(s.borrowAssetsUsd || 0)}`);
      lines.push(`    Available Liquidity: ${formatUsd(directLiquidity)}`);
    }
    lines.push(`    Collateral Deposited: ${formatUsd(s.collateralAssetsUsd || 0)}`);
    if ((s.fee ?? 0) > 0) lines.push(`    Protocol Fee: ${formatPct((s.fee ?? 0) * 100)}`);

    // Reward incentives (supply-side and borrow-side)
    const rewards = (s as any).rewards;
    if (rewards && Array.isArray(rewards) && rewards.length > 0) {
      lines.push(``);
      lines.push(`  Rewards:`);
      for (const r of rewards) {
        const sym = r.asset?.symbol || "?";
        const parts: string[] = [];
        if (r.supplyApr != null && r.supplyApr > 0) parts.push(`Supply: +${formatPct(r.supplyApr * 100)}`);
        if (r.borrowApr != null && r.borrowApr > 0) parts.push(`Borrow: +${formatPct(r.borrowApr * 100)}`);
        if (parts.length > 0) lines.push(`    ${sym}: ${parts.join(" | ")}`);
      }
    }

    // Public Allocator shared liquidity breakdown
    if (m.publicAllocatorSharedLiquidity && m.publicAllocatorSharedLiquidity.length > 0) {
      lines.push(``);
      lines.push(`  Public Allocator (reallocatable from vaults):`);
      for (const shared of m.publicAllocatorSharedLiquidity) {
        const sharedAssets = BigInt(shared.assets);
        const sharedUsd = Number(sharedAssets) / (10 ** loanDecimals) * loanPriceUsd;
        const vaultLabel = shared.vault?.name || shared.vault?.address || "?";
        const fromMarket = shared.withdrawMarket
          ? `${shared.withdrawMarket.collateralAsset?.symbol || "idle"} / ${shared.withdrawMarket.loanAsset?.symbol || "?"}`
          : "idle pool";
        lines.push(`    ${vaultLabel}: ${formatUsd(sharedUsd)} (from ${fromMarket})`);
      }
    }
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
// Morpho Vault & Supply-Side Formatting
// =============================================================================

/** Format a single Morpho vault with its allocations. */
export function formatMorphoVaultSummary(v: MorphoVault, rank?: number): string {
  const lines: string[] = [];
  const prefix = rank != null ? `#${rank} ` : "";
  const curator = v.curator ? ` | Curator: ${v.curator}` : "";
  const aum = v.state?.totalAssetsUsd ? formatUsd(v.state.totalAssetsUsd) : "?";
  const apy = v.state?.apy != null ? formatPct(v.state.apy * 100) : "?";
  const netApy = v.state?.netApy != null ? formatPct(v.state.netApy * 100) : null;
  const fee = v.state?.fee != null && v.state.fee > 0 ? ` | Fee: ${formatPct(v.state.fee * 100)}` : "";

  lines.push(`${prefix}${v.name} (${v.symbol})`);
  lines.push(`  Address: ${v.address}`);
  lines.push(`  Asset: ${v.asset?.symbol || "?"} | AUM: ${aum} | APY: ${apy}${netApy ? ` (net ${netApy})` : ""}${fee}${curator}`);
  lines.push(`  Listed: ${v.listed ? "Yes" : "No"}`);

  const allocs = v.state?.allocation || [];
  if (allocs.length > 0) {
    lines.push(`  Allocations: ${allocs.length} market(s)`);
    for (const a of allocs) {
      const cap = a.supplyCapUsd != null ? ` | Cap: ${formatUsd(a.supplyCapUsd)}` : "";
      lines.push(`    ${a.collateralSymbol}/${a.loanSymbol}: ${formatUsd(a.supplyAssetsUsd)}${cap} | Key: ${a.marketKey.slice(0, 10)}...`);
    }
  } else {
    lines.push(`  Allocations: none (idle vault)`);
  }

  return lines.join("\n");
}

/** Format supply-side analysis for a Morpho market. */
export function formatMorphoSupplierAnalysis(
  suppliers: MorphoMarketSupplier[],
  market: MorphoMarket,
): string {
  const s = market.state;
  const directSupply = s?.supplyAssetsUsd || 0;
  const directLiquidity = s?.liquidityAssetsUsd || 0;
  const reallocatable = computeReallocatableUsd(market);
  const totalSupply = directSupply + reallocatable;
  const available = directLiquidity + reallocatable;
  const utilization = s?.utilization || 0;
  const supplyApy = s?.supplyApy || 0;
  const collateral = market.collateralAsset?.symbol || "?";
  const loan = market.loanAsset?.symbol || "?";

  const lines: string[] = [];
  lines.push(`== Supply-Side Analysis: ${collateral} / ${loan} ==`);
  if (reallocatable > 0) {
    lines.push(`  Total Supply: ${formatUsd(totalSupply)} (direct ${formatUsd(directSupply)} + reallocatable ${formatUsd(reallocatable)})`);
    lines.push(`  Available: ${formatUsd(available)} (direct ${formatUsd(directLiquidity)} + reallocatable ${formatUsd(reallocatable)}) | Utilization: ${formatPct(utilization * 100)}`);
  } else {
    lines.push(`  Total Supply: ${formatUsd(totalSupply)} | Available: ${formatUsd(available)} | Utilization: ${formatPct(utilization * 100)}`);
  }
  lines.push(`  Supply APY: ${formatPct(supplyApy * 100)}`);

  // Reward incentives on supply side
  const rewards = (s as any)?.rewards;
  if (rewards && Array.isArray(rewards)) {
    const supplyRewards = rewards.filter((r: any) => r.supplyApr != null && r.supplyApr > 0);
    if (supplyRewards.length > 0) {
      const parts = supplyRewards.map((r: any) => `+${formatPct(r.supplyApr * 100)} ${r.asset?.symbol || "?"}`);
      lines.push(`  Supply Rewards: ${parts.join(", ")}`);
    }
  }

  lines.push(``);

  if (suppliers.length === 0) {
    lines.push(`  No supply-side positions found.`);
    return lines.join("\n");
  }

  lines.push(`  Top Suppliers:`);
  for (let i = 0; i < suppliers.length; i++) {
    const sup = suppliers[i];
    const pct = totalSupply > 0 ? (sup.supplyAssetsUsd / totalSupply) * 100 : 0;
    const addrShort = `${sup.address.slice(0, 6)}...${sup.address.slice(-4)}`;

    if (sup.isVault) {
      lines.push(`    #${i + 1} [Vault] ${sup.vaultName || "Unknown"} (${addrShort}) — ${formatUsd(sup.supplyAssetsUsd)} (${formatPct(pct)})`);
      const parts: string[] = [];
      if (sup.vaultTotalAssetsUsd) parts.push(`AUM: ${formatUsd(sup.vaultTotalAssetsUsd)}`);
      if (sup.vaultCurator) parts.push(`Curator: ${sup.vaultCurator}`);
      if (parts.length > 0) lines.push(`       ${parts.join(" | ")}`);
    } else {
      const role = sup.collateralUsd > 0 && sup.borrowAssetsUsd > 0
        ? "[Looper]" : "[EOA]";
      lines.push(`    #${i + 1} ${role} ${addrShort} — ${formatUsd(sup.supplyAssetsUsd)} (${formatPct(pct)})`);
    }
  }

  // Concentration analysis
  lines.push(``);
  const topPct = totalSupply > 0 ? (suppliers[0].supplyAssetsUsd / totalSupply) * 100 : 0;
  const concentration = topPct >= 80 ? "VERY HIGH" : topPct >= 50 ? "HIGH" : topPct >= 30 ? "MODERATE" : "LOW";
  lines.push(`  Concentration: ${concentration} — top supplier controls ${formatPct(topPct)}`);

  if (available < 10000) {
    lines.push(`  Supply Gap: Only ${formatUsd(available)} available — looping at scale needs more supply-side liquidity.`);
  }

  // Supplier withdrawal scenario — ALWAYS shown, no threshold gate.
  // Open emergence: the scenario is informative at every concentration level.
  // A 20% supplier exiting is different from a 60% supplier exiting, but both
  // are worth showing. The data speaks — the agent judges.
  if (suppliers.length > 0 && totalSupply > 0) {
    const topSupplyUsd = suppliers[0].supplyAssetsUsd;
    const totalBorrow = suppliers.reduce((s, sup) => s + (sup.borrowAssetsUsd || 0), 0);
    const afterSupply = totalSupply - topSupplyUsd;
    const afterAvailable = Math.max(0, afterSupply - totalBorrow);
    const currentUtil = totalBorrow > 0 ? (totalBorrow / totalSupply) * 100 : 0;
    const afterUtil = afterSupply > 0 ? Math.min(100, (totalBorrow / afterSupply) * 100) : 100;

    lines.push(``);
    lines.push(`  ── If top supplier exits ──`);
    lines.push(`    ${suppliers[0].isVault ? suppliers[0].vaultName : `EOA ${suppliers[0].address?.slice(0, 10) || "?"}`} (${formatUsd(topSupplyUsd)}, ${formatPct(topPct)})`);
    lines.push(`    Supply: ${formatUsd(totalSupply)} → ${formatUsd(afterSupply)} | Liquidity: ${formatUsd(available)} → ${formatUsd(afterAvailable)} | Utilization: ${formatPct(currentUtil)} → ${formatPct(afterUtil)}`);
  }

  return lines.join("\n");
}

// =============================================================================
// Morpho Vault Enriched Allocation
// =============================================================================

/**
 * Format a single vault allocation with optional live rates and Spectra PT tagging.
 * Prefers inline state from the enriched vault query (alloc.borrowApy etc.),
 * falls back to the external marketRate map for backward compatibility.
 */
export function formatMorphoVaultAllocationEnriched(
  alloc: MorphoVaultAllocation,
  marketRate?: { borrowApy: number; supplyApy: number; utilization: number; supplyAssetsUsd?: number },
  isSpectraPt?: boolean,
): string {
  const tag = isSpectraPt ? "[Spectra PT] " : "";
  const cap = alloc.supplyCapUsd != null && alloc.supplyCapUsd > 0
    ? ` | Cap: ${formatUsd(alloc.supplyCapUsd)} (${formatPct((alloc.supplyAssetsUsd / alloc.supplyCapUsd) * 100)} used)`
    : "";
  // Prefer inline state (from enriched vault query), fall back to external rates map
  const borrowApy = alloc.borrowApy ?? marketRate?.borrowApy;
  const util = alloc.utilization ?? marketRate?.utilization;
  const lltv = alloc.lltv;
  const rates = borrowApy != null && util != null
    ? ` | Borrow: ${formatPct(borrowApy * 100)} | Util: ${formatPct(util * 100)}${lltv != null ? ` | LLTV: ${formatPct(lltv * 100)}` : ""}`
    : "";
  return `    ${tag}${alloc.collateralSymbol}/${alloc.loanSymbol}: ${formatUsd(alloc.supplyAssetsUsd)}${cap}${rates} | Key: ${alloc.marketKey.slice(0, 10)}...`;
}

/** Format a full vault with enriched allocations. */
export function formatMorphoVaultSummaryEnriched(
  v: MorphoVault,
  rank: number | undefined,
  marketRates: Map<string, { borrowApy: number; supplyApy: number; utilization: number; supplyAssetsUsd?: number }>,
  spectraPtAddrs: Set<string>,
): string {
  const lines: string[] = [];
  const prefix = rank != null ? `#${rank} ` : "";
  const curator = v.curator ? ` | Curator: ${v.curator}` : "";
  const aum = v.state?.totalAssetsUsd ? formatUsd(v.state.totalAssetsUsd) : "?";
  const apy = v.state?.apy != null ? formatPct(v.state.apy * 100) : "?";
  const netApy = v.state?.netApy != null ? formatPct(v.state.netApy * 100) : null;
  const fee = v.state?.fee != null && v.state.fee > 0 ? ` | Fee: ${formatPct(v.state.fee * 100)}` : "";

  lines.push(`${prefix}${v.name} (${v.symbol})`);
  lines.push(`  Address: ${v.address}`);
  lines.push(`  Asset: ${v.asset?.symbol || "?"} | AUM: ${aum} | APY: ${apy}${netApy ? ` (net ${netApy})` : ""}${fee}${curator}`);
  lines.push(`  Listed: ${v.listed ? "Yes" : "No"}`);

  const allocs = v.state?.allocation || [];
  if (allocs.length > 0) {
    const spectraCount = allocs.filter((a) => spectraPtAddrs.has(a.collateralAddress || "")).length;
    lines.push(`  Allocations: ${allocs.length} market(s)${spectraCount > 0 ? ` (${spectraCount} Spectra PT)` : ""}`);
    for (const a of allocs) {
      const isSpectra = spectraPtAddrs.has(a.collateralAddress || "");
      const rate = marketRates.get(a.marketKey);
      lines.push(formatMorphoVaultAllocationEnriched(a, rate, isSpectra));
    }
  } else {
    lines.push(`  Allocations: none (idle vault)`);
  }

  return lines.join("\n");
}

// =============================================================================
// Morpho User Positions Formatter
// =============================================================================

/** Format a user's Morpho positions across markets and vaults. */
export function formatMorphoUserPositions(positions: MorphoUserPositions): string {
  const lines: string[] = [];
  const t = positions.totals;

  lines.push(`== Morpho Positions: ${positions.chain} ==`);
  lines.push(`  Address: ${positions.address}`);
  lines.push(`  Net Value: ${formatUsd(t.netUsd)} (Supply: ${formatUsd(t.supplyUsd)} + Collateral: ${formatUsd(t.collateralUsd)} + Vaults: ${formatUsd(t.vaultUsd)} - Borrow: ${formatUsd(t.borrowUsd)})`);

  // Market positions
  const mktPositions = positions.marketPositions.filter(
    (p) => p.supplyAssetsUsd > 0.01 || p.borrowAssetsUsd > 0.01 || p.collateralAssetsUsd > 0.01,
  );
  if (mktPositions.length > 0) {
    lines.push(``);
    lines.push(`  Market Positions: ${mktPositions.length}`);
    for (let i = 0; i < mktPositions.length; i++) {
      const p = mktPositions[i];
      const collSym = p.market.collateralAsset?.symbol || "?";
      const loanSym = p.market.loanAsset?.symbol || "?";
      const tag = p.isSpectraPt ? "[Spectra PT] " : "";

      const parts: string[] = [];
      if (p.collateralAssetsUsd > 0.01) parts.push(`Collateral: ${formatUsd(p.collateralAssetsUsd)}`);
      if (p.borrowAssetsUsd > 0.01) parts.push(`Borrow: ${formatUsd(p.borrowAssetsUsd)}`);
      if (p.supplyAssetsUsd > 0.01) parts.push(`Supply: ${formatUsd(p.supplyAssetsUsd)}`);
      if (p.healthFactor != null) parts.push(`Health: ${p.healthFactor.toFixed(2)}`);

      lines.push(`    #${i + 1} ${tag}${collSym} / ${loanSym} -- ${parts.join(" | ")}`);
      lines.push(`       Market: ${p.market.uniqueKey.slice(0, 10)}... | LLTV: ${formatPct(formatMorphoLltv(p.market.lltv) * 100)}`);
    }
  }

  // Vault positions
  const vaultPositions = positions.vaultPositions.filter((p) => p.assetsUsd > 0.01);
  if (vaultPositions.length > 0) {
    lines.push(``);
    lines.push(`  Vault Positions: ${vaultPositions.length}`);
    for (let i = 0; i < vaultPositions.length; i++) {
      const p = vaultPositions[i];
      const netApy = p.vault.state?.netApy != null ? ` | Vault APY: ${formatPct(p.vault.state.netApy * 100)} (net)` : "";
      lines.push(`    #${i + 1} ${p.vault.name} -- ${formatUsd(p.assetsUsd)}${netApy}`);
      lines.push(`       Vault: ${p.vault.address}`);
    }
  }

  // Signals
  const signals: string[] = [];
  for (const p of mktPositions) {
    if (p.collateralAssetsUsd > 0.01 && p.borrowAssetsUsd > 0.01) {
      const collSym = p.market.collateralAsset?.symbol || "?";
      signals.push(`Looper detected: ${collSym} position has collateral (${formatUsd(p.collateralAssetsUsd)}) and borrow (${formatUsd(p.borrowAssetsUsd)}) — likely looping strategy`);
    }
    if (p.healthFactor != null && p.healthFactor < 1.3 && p.healthFactor > 0) {
      signals.push(`Health factor ${p.healthFactor.toFixed(2)} is close to liquidation — monitor for rate changes`);
    }
  }
  if (signals.length > 0) {
    lines.push(``);
    lines.push(`  Position Signals:`);
    for (const s of signals) lines.push(`    - ${s}`);
  }

  if (mktPositions.length === 0 && vaultPositions.length === 0) {
    lines.push(``);
    lines.push(`  No active Morpho positions on ${positions.chain}.`);
  }

  return lines.join("\n");
}

// =============================================================================
// Morpho Historical Analysis Formatter
// =============================================================================

function formatRateStats(label: string, stats: MorphoRateStats, isPercent: boolean): string[] {
  const fmt = isPercent ? (v: number) => formatPct(v * 100) : (v: number) => formatUsd(v);
  const changeFmt = isPercent
    ? `${stats.change >= 0 ? "+" : ""}${(stats.change * 100).toFixed(2)}pp`
    : `${stats.change >= 0 ? "+" : ""}${((stats.change) * 100).toFixed(1)}%`;
  const trend = stats.trend.toUpperCase();
  return [
    `  ${label}: ${fmt(stats.current)} (${changeFmt}, ${trend})`,
    `    Min: ${fmt(stats.min)} | Avg: ${fmt(stats.avg)} | Max: ${fmt(stats.max)}`,
  ];
}

/** Compute Layer 3 hints from historical analysis. */
export function formatMorphoHistoryHints(analysis: MorphoHistoricalAnalysis): string[] {
  const hints: string[] = [];
  const { borrowApy, supplyApy, utilization, tvl } = analysis.stats;

  // Rate spike detection
  if (borrowApy.max > 0 && borrowApy.current > borrowApy.avg * 1.5) {
    hints.push(`Borrow rate spiked to ${formatPct(borrowApy.current * 100)} (avg ${formatPct(borrowApy.avg * 100)}) — looping cost is elevated`);
  }

  // Rate stability
  if (borrowApy.max > 0 && borrowApy.min > 0) {
    const range = borrowApy.max - borrowApy.min;
    if (range < borrowApy.avg * 0.2) {
      hints.push(`Borrow rate stable over ${analysis.period} (${formatPct(borrowApy.min * 100)}-${formatPct(borrowApy.max * 100)}) — favorable for looping`);
    }
  }

  // Utilization warning
  if (utilization.avg > 0.85 && utilization.trend === "up") {
    hints.push(`Utilization >85% and trending UP — supply may be tight, expect rate spikes`);
  }

  // TVL decline
  if (tvl.current > 0 && tvl.change < -0.2) {
    hints.push(`TVL declined ${((tvl.change) * 100).toFixed(1)}% — suppliers withdrawing, rates likely to increase`);
  }

  // Supply/demand divergence
  if (tvl.trend === "down" && borrowApy.trend === "up") {
    hints.push(`Supply declining while borrow rates rising — supply/demand squeeze in progress`);
  }

  return hints;
}

/** Format full historical analysis output. */
export function formatMorphoHistoricalAnalysis(analysis: MorphoHistoricalAnalysis): string {
  const lines: string[] = [];
  const m = analysis.market;
  const collSym = m?.collateralAsset?.symbol || "?";
  const loanSym = m?.loanAsset?.symbol || "?";

  lines.push(`== Morpho History: ${collSym} / ${loanSym} (${analysis.chain}) ==`);
  lines.push(`  Market: ${m?.uniqueKey || "?"}`);
  lines.push(`  Period: ${analysis.period} | Interval: ${analysis.interval} | Data points: ${analysis.dataPoints.length}`);
  lines.push(``);

  lines.push(...formatRateStats("Borrow APY", analysis.stats.borrowApy, true));
  lines.push(...formatRateStats("Supply APY", analysis.stats.supplyApy, true));
  lines.push(...formatRateStats("Utilization", analysis.stats.utilization, true));
  lines.push(...formatRateStats("TVL (Supply)", analysis.stats.tvl, false));

  if (analysis.hints.length > 0) {
    lines.push(``);
    lines.push(`  Signals:`);
    for (const h of analysis.hints) lines.push(`    - ${h}`);
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
  MINT_PT_YT: "Mint PT+YT",
  REDEEM_PT: "Redeem PT",
  YIELD_CLAIMED: "Yield Claimed",
};

export function formatActivityType(type: string): string {
  return ACTIVITY_TYPES[type] || type;
}

// Types that may be one step of a Router-batched operation (flash-mint, flash-redeem,
// or batched mint+LP). AMM_REMOVE_LIQUIDITY is always direct — not Router-batched.
export const ROUTER_BATCHABLE_TYPES = new Set(["BUY_PT", "SELL_PT", "AMM_ADD_LIQUIDITY"]);

// Footnote text for Router-batching marker on activity rows.
export const ROUTER_BATCH_FOOTNOTE =
  "† May be one step of a Router-batched operation (flash-mint, flash-redeem, or batched mint+LP).";

// =============================================================================
// Activity Sequence / Cycle Detection
// =============================================================================

/** A detected repeating cycle in activity data. */
export interface ActivityCycleResult {
  /** The repeating action type pattern (e.g., ["AMM_ADD_LIQUIDITY", "AMM_REMOVE_LIQUIDITY", "SELL_PT"]) */
  pattern: string[];
  /** How many times this cycle was detected */
  count: number;
  /** Total USD value across all cycle instances */
  totalValueUsd: number;
  /** Average USD value per cycle */
  avgValueUsd: number;
  /** Fraction of total entries covered by detected cycles */
  coverageFraction: number;
  /** Remaining entries not part of any detected cycle */
  uncoveredCount: number;
  /** Timestamp of the first event in the earliest detected cycle (Unix seconds) */
  firstOccurrenceTs: number | null;
  /** Timestamp of the first event in the most recent detected cycle (Unix seconds) */
  lastOccurrenceTs: number | null;
  /** Largest temporal gap (seconds) between consecutive cycle instances */
  maxGapBetweenCyclesSec: number | null;
}

/**
 * Detect repeating subsequence patterns in chronologically-sorted activity entries.
 *
 * Looks for the most common repeating cycle of length 2-5 actions.
 * Returns the best cycle (highest coverage) or null if no pattern repeats 3+ times.
 *
 * Design: This is Layer 3 (structured output hint). It surfaces structural patterns
 * without prescribing interpretation. A cycle of ADD→REMOVE→SELL "could indicate"
 * a mint→LP→unwind loop, but the tool never says "is."
 */
export function detectActivityCycles(
  entries: Array<{ type: string; valueUsd: number; timestamp?: number }>,
): ActivityCycleResult | null {
  if (entries.length < 6) return null; // need at least 3 repetitions of a 2-action cycle

  const types = entries.map(e => e.type);
  let bestResult: ActivityCycleResult | null = null;
  let bestMatchPositions: number[] = []; // starting indices of matched cycles

  // Try cycle lengths 2 through 5
  for (let cycleLen = 2; cycleLen <= Math.min(5, Math.floor(types.length / 3)); cycleLen++) {
    // Try each possible starting offset (0 to cycleLen-1)
    for (let offset = 0; offset < cycleLen && offset < types.length - cycleLen; offset++) {
      const candidate = types.slice(offset, offset + cycleLen);

      // Count how many times this exact sequence appears consecutively from this offset
      let matchCount = 0;
      let totalVal = 0;
      let pos = offset;
      const matchPositions: number[] = [];
      while (pos + cycleLen <= types.length) {
        const slice = types.slice(pos, pos + cycleLen);
        if (slice.every((t, i) => t === candidate[i])) {
          matchCount++;
          matchPositions.push(pos);
          for (let k = pos; k < pos + cycleLen; k++) {
            totalVal += entries[k].valueUsd || 0;
          }
          pos += cycleLen;
        } else {
          pos++;
        }
      }

      if (matchCount < 3) continue; // require at least 3 repetitions

      const covered = matchCount * cycleLen;
      const coverageFrac = covered / types.length;

      if (!bestResult || coverageFrac > bestResult.coverageFraction) {
        bestResult = {
          pattern: candidate,
          count: matchCount,
          totalValueUsd: totalVal,
          avgValueUsd: totalVal / matchCount,
          coverageFraction: coverageFrac,
          uncoveredCount: types.length - covered,
          firstOccurrenceTs: null,
          lastOccurrenceTs: null,
          maxGapBetweenCyclesSec: null,
        };
        bestMatchPositions = matchPositions;
      }
    }
  }

  // Populate temporal fields from matched cycle positions
  if (bestResult && bestMatchPositions.length > 0) {
    const cycleLen = bestResult.pattern.length;
    const cycleTimestamps = bestMatchPositions
      .map(pos => entries[pos]?.timestamp)
      .filter((t): t is number => t != null && t > 0);

    if (cycleTimestamps.length > 0) {
      bestResult.firstOccurrenceTs = cycleTimestamps[0];
      bestResult.lastOccurrenceTs = cycleTimestamps[cycleTimestamps.length - 1];

      // Compute max gap between consecutive cycle start timestamps
      if (cycleTimestamps.length >= 2) {
        let maxGap = 0;
        for (let i = 1; i < cycleTimestamps.length; i++) {
          const gap = cycleTimestamps[i] - cycleTimestamps[i - 1];
          if (gap > maxGap) maxGap = gap;
        }
        bestResult.maxGapBetweenCyclesSec = maxGap;
      }
    }
  }

  return bestResult;
}

/**
 * Format cycle detection results as output lines for spectra_get_pool_activity.
 *
 * Open Emergence design: present competing interpretation branches with equal
 * weight.  The agent (or user) must bring external evidence to collapse them.
 * A small repetition count is explicitly flagged as statistically insufficient
 * so that downstream reasoning cannot treat it as a confirmed pattern.
 */
export function formatCycleAnalysis(
  cycle: ActivityCycleResult,
  totalActivityValue: number,
): string[] {
  const lines: string[] = [];
  const patternStr = cycle.pattern.map(formatActivityType).join(" → ");
  const coveragePct = (cycle.coverageFraction * 100).toFixed(0);

  lines.push(`  Sequence Analysis:`);
  lines.push(`    Detected Cycle: [${patternStr}]`);
  lines.push(`    Repetitions: ${cycle.count}× (covers ${coveragePct}% of activity)`);
  lines.push(`    Cycle Value: avg ${formatUsd(cycle.avgValueUsd)}/cycle, total ${formatUsd(cycle.totalValueUsd)}`);

  if (cycle.uncoveredCount > 0) {
    lines.push(`    Uncovered: ${cycle.uncoveredCount} txn(s) outside detected pattern`);
  }

  // Temporal context — when was this pattern active?
  if (cycle.firstOccurrenceTs && cycle.lastOccurrenceTs) {
    const now = Math.floor(Date.now() / 1000);
    const daysSinceFirst = Math.round((now - cycle.firstOccurrenceTs) / 86400);
    const daysSinceLast = Math.round((now - cycle.lastOccurrenceTs) / 86400);
    lines.push(`    Timespan: first ${formatDate(cycle.firstOccurrenceTs)} (${daysSinceFirst}d ago) → last ${formatDate(cycle.lastOccurrenceTs)} (${daysSinceLast}d ago)`);

    // Staleness warning — pattern last seen >30 days ago
    if (daysSinceLast > 30) {
      lines.push(`    ⚠ Pattern last observed ${daysSinceLast} days ago — may no longer be active.`);
    }

    // Gap warning — pattern spans a temporal gap >14 days between consecutive cycles
    if (cycle.maxGapBetweenCyclesSec != null) {
      const maxGapDays = Math.round(cycle.maxGapBetweenCyclesSec / 86400);
      if (maxGapDays > 14) {
        lines.push(`    ⚠ Pattern spans a ${maxGapDays}-day gap between consecutive cycles — pre-gap and post-gap occurrences may be unrelated.`);
      }
    }
  }

  // Statistical confidence boundary
  if (cycle.count <= 5) {
    lines.push(`    ⚠ ${cycle.count} repetitions observed. Insufficient to distinguish systematic strategy from coincidental sequence. Do not extrapolate.`);
  }

  // -------------------------------------------------------
  // Competing interpretation branches — presented with equal
  // weight.  These branches predict DIFFERENT future behavior.
  // The agent must not collapse them without external evidence.
  // -------------------------------------------------------
  const p = cycle.pattern;
  const hasAdd = p.includes("AMM_ADD_LIQUIDITY");
  const hasRemove = p.includes("AMM_REMOVE_LIQUIDITY");
  const hasSellPt = p.includes("SELL_PT");
  const hasBuyPt = p.includes("BUY_PT");

  const branches: string[] = [];

  if (hasAdd && hasRemove && hasSellPt) {
    branches.push("Mint→LP→unwind→sell loop: YT accumulation via PT discount. Implies directional variable-rate bet; exit would appear as BUY_PT (flash-redeem).");
    branches.push("LP cycling for fee capture: adding/removing liquidity to harvest swap fees, with incidental PT sells to rebalance. Implies LP-centric strategy, not directional.");
    branches.push("One leg of a multi-step arb: pool activity alone shows only the Curve-visible steps. The full strategy may span other protocols or pools not visible here.");
  } else if (hasAdd && hasSellPt && !hasRemove) {
    branches.push("Router-batched mint+LP: each ADD mints PT+YT, deposits PT+IBT as LP, user keeps YT. SELL_PT may be excess PT disposal. Implies YT accumulation.");
    branches.push("LP provision with PT rebalancing: adding liquidity then selling PT received from pool mechanics. Implies LP yield strategy, not YT accumulation.");
  } else if (hasSellPt && !hasAdd && !hasRemove) {
    branches.push("Flash-mint YT accumulation: Router mints PT+YT, sells PT, user keeps YT. Implies directional variable-rate bet; exit would appear as BUY_PT.");
    branches.push("PT liquidation / rebalancing: reducing fixed-rate exposure or exiting a position. No necessary re-entry implied.");
    branches.push("One leg of cross-protocol arb: PT sold here may be bought cheaper elsewhere, or the underlying IBT is being arbitraged across venues.");
  } else if (hasBuyPt && !hasSellPt) {
    branches.push("Fixed-rate accumulation: buying PT at discount to lock in yield to maturity. Implies hold-to-maturity strategy.");
    branches.push("Flash-redeem YT exit: Router buys PT to pair with held YT for redemption. Implies unwinding a previous variable-rate bet.");
    branches.push("Liquidity provision prep: accumulating PT to pair with IBT for LP deposit. Next action would be ADD_LIQUIDITY.");
  } else if (hasBuyPt && hasSellPt) {
    branches.push("Market making / spread capture: buying and selling PT for the bid-ask spread. Implies non-directional strategy; may continue indefinitely.");
    branches.push("Strategy pivot: accumulation phase (SELL_PT) followed by partial unwind (BUY_PT), or vice versa. The direction change is the key signal.");
    branches.push("Arbitrage execution: PT price oscillations exploited across time or venues. Pool activity shows only one leg.");
  }

  if (branches.length > 0) {
    lines.push(`    Competing Interpretations (do not collapse without external evidence):`);
    branches.forEach((b, i) => {
      lines.push(`      ${String.fromCharCode(65 + i)}) ${b}`);
    });
    lines.push(`    → These branches predict different future behavior. Use spectra_get_portfolio to check actual holdings before selecting one.`);
  }

  return lines;
}

// =============================================================================
// Flow Accounting (Mint Inference from Portfolio Cross-Reference)
// =============================================================================

/**
 * Infer invisible mints by comparing YT holdings to pool activity.
 *
 * Since minting creates equal PT + YT, and standalone mints are invisible in pool
 * activity, we can back-infer approximate mint volume from:
 *   - YT balance (minted YT that was kept)
 *   - PT sold volume (minted PT that was sold through the pool)
 *   - LP activity (minted PT that entered the pool as liquidity)
 *
 * Returns formatted output lines. Uses "could be" / "estimated" language per
 * Open Emergence principles — these are inferences, not confirmed facts.
 */
export function formatFlowAccounting(opts: {
  ytBalance: number;
  ptBalance: number;
  lpBalance: number;
  ptSellCount: number;
  ptSellVolumeUsd: number;
  addLiqCount: number;
  addLiqVolumeUsd: number;
  buyPtCount: number;
  buyPtVolumeUsd: number;
  removeLiqCount: number;
  removeLiqVolumeUsd: number;
  ptPriceUsd: number;
  ytPriceUsd: number;
}): string[] {
  const lines: string[] = [];
  lines.push(`  Flow Accounting (inferred from portfolio + activity):`);

  const {
    ytBalance, ptBalance, lpBalance,
    ptSellCount, ptSellVolumeUsd,
    addLiqCount, addLiqVolumeUsd,
    buyPtCount, buyPtVolumeUsd,
    removeLiqCount, removeLiqVolumeUsd,
    ptPriceUsd, ytPriceUsd,
  } = opts;

  // Current holdings value
  const ytValueUsd = ytBalance * ytPriceUsd;
  const ptValueUsd = ptBalance * ptPriceUsd;

  lines.push(`    Current Holdings: ${ytBalance.toFixed(2)} YT (${formatUsd(ytValueUsd)}) | ${ptBalance.toFixed(2)} PT (${formatUsd(ptValueUsd)}) | LP: ${lpBalance.toFixed(4)}`);

  // Infer mints: YT can only come from minting (deposit IBT -> PT+YT)
  // Each mint creates equal PT + YT. The YT balance is a lower bound on total mints
  // (some YT may have been sold via flash-redeem, which shows as BUY_PT).
  if (ytBalance > 0) {
    const estimatedMinMints = ytBalance;
    lines.push(`    Estimated Minimum Mints: ~${estimatedMinMints.toFixed(2)} units (inferred from YT balance)`);
    lines.push(`      Each mint creates 1 PT + 1 YT. YT balance is a lower bound on total mints.`);
    // Confidence signal: surface the reliability boundary of this inference
    if (buyPtCount === 0) {
      lines.push(`      Confidence: moderate (no BUY_PT events suggesting flash-redeem YT selling)`);
    } else {
      lines.push(`      Confidence: low (BUY_PT events could indicate flash-redeem YT selling — actual mints may exceed YT balance)`);
    }
  } else if (ytBalance === 0 && ptBalance > 0) {
    lines.push(`    Mint inference unavailable (YT balance is zero — minting may not have occurred, or all YT was sold). Cannot distinguish from portfolio alone.`);
  }

  // PT flow analysis
  if (ptSellCount > 0 || addLiqCount > 0) {
    lines.push(`    PT Outflows via Pool:`);
    if (ptSellCount > 0) {
      lines.push(`      SELL_PT: ${ptSellCount} txns, ${formatUsd(ptSellVolumeUsd)}`);
    }
    if (addLiqCount > 0) {
      lines.push(`      ADD_LIQ: ${addLiqCount} txns, ${formatUsd(addLiqVolumeUsd)} (may include minted PT)`);
    }
  }

  if (buyPtCount > 0) {
    lines.push(`    PT Inflows via Pool:`);
    lines.push(`      BUY_PT: ${buyPtCount} txns, ${formatUsd(buyPtVolumeUsd)} (could be fixed-rate accumulation or flash-redeem YT selling)`);
  }

  if (removeLiqCount > 0) {
    lines.push(`    LP Removals: ${removeLiqCount} txns, ${formatUsd(removeLiqVolumeUsd)} (returns IBT + PT from pool)`);
  }

  // -------------------------------------------------------
  // Net flow interpretation — competing hypotheses.
  // Present the observable facts, then branches that explain them.
  // The branches predict different future behavior and should not
  // be collapsed without cross-referencing additional data sources.
  // -------------------------------------------------------

  if (ytBalance > 0 && ptBalance === 0 && ptSellCount > 0) {
    lines.push(`    Position Shape: YT-only (${ytBalance.toFixed(2)} YT, ~0 PT)`);
    lines.push(`    Competing Hypotheses:`);
    lines.push(`      A) YT accumulation via mint-and-sell: minted PT+YT, sold PT, kept YT for leveraged variable yield. Predicts: hold until spread narrows, then exit via BUY_PT (flash-redeem).`);
    lines.push(`      B) Intermediate state of a larger strategy: YT held temporarily before next step (LP deposit, cross-protocol move, or further minting). Predicts: next action is NOT a simple exit.`);
    if (buyPtCount > 0) {
      lines.push(`      C) Partial unwind already in progress: ${buyPtCount} BUY_PT events suggest some YT was already flash-redeemed. Remaining YT may be held to maturity, or unwind may continue — the partial exit does not predict the rest.`);
    }
    lines.push(`      → Observable fact: YT can only come from minting. But the reason for holding it is not observable from pool data alone.`);
  } else if (ptBalance > 0 && ytBalance === 0 && buyPtCount > 0) {
    lines.push(`    Position Shape: PT-only (${ptBalance.toFixed(2)} PT, ~0 YT)`);
    lines.push(`    Competing Hypotheses:`);
    lines.push(`      A) Fixed-rate accumulation: bought PT at discount, holding to maturity for guaranteed yield. Predicts: no further pool activity until maturity.`);
    lines.push(`      B) Post-mint YT exit: minted PT+YT, sold all YT via flash-redeem (shows as BUY_PT), kept PT. Predicts: may sell PT next, or hold to maturity.`);
    lines.push(`      C) LP preparation: accumulated PT to pair with IBT for LP deposit. Predicts: next action is ADD_LIQUIDITY.`);
    lines.push(`      → These hypotheses predict different next actions. Portfolio alone cannot distinguish them.`);
  } else if (ytBalance > 0 && ptBalance > 0) {
    const ratio = ytBalance / ptBalance;
    lines.push(`    Position Shape: YT/PT ${ratio > 100 ? `${(ratio).toFixed(0)}:1` : ratio > 1 ? `${ratio.toFixed(1)}:1` : `1:${(1/ratio).toFixed(1)}`}`);
    if (ratio > 5) {
      lines.push(`    Observation: Heavily YT-weighted. Most minted PT was disposed of (sold or LPed).`);
      lines.push(`    But: the reason for the remaining PT is ambiguous — dust from rounding, deliberate hedge, or LP residual.`);
    } else if (ratio < 0.2) {
      lines.push(`    Observation: Heavily PT-weighted. Most minted YT was likely sold.`);
      lines.push(`    But: the reason for the remaining YT is ambiguous — dust, yield collection vehicle, or partial exit in progress.`);
    } else {
      lines.push(`    Observation: Mixed PT/YT position. Could be partial mint (kept both), partial unwind (started with more of one), or LP residual.`);
    }
  } else if (ytBalance === 0 && ptBalance === 0 && (ptSellCount > 0 || buyPtCount > 0)) {
    lines.push(`    Position Shape: Fully exited (0 PT, 0 YT, LP: ${lpBalance.toFixed(4)})`);
    lines.push(`    Competing Hypotheses:`);
    lines.push(`      A) Completed round-trip: entered and fully exited. Strategy is finished for this pool.`);
    lines.push(`      B) Capital recycled elsewhere: funds moved to another pool, chain, or protocol. Check spectra_get_address_activity for multi-pool patterns.`);
    lines.push(`      C) Temporary exit: may re-enter if conditions (spread, liquidity, rates) become favorable again.`);
  }

  lines.push(`    Note: Flow accounting is approximate. Mints are invisible in pool data;`);
  lines.push(`    these estimates rely on YT balance (which can only come from minting).`);

  return lines;
}

// =============================================================================
// Observation Coverage — quantifying blind spots
// =============================================================================

/**
 * Compute and format observation coverage metrics for address-specific analysis.
 *
 * Coverage metrics tell you HOW MUCH of the address's behavior this analysis
 * actually sees.  They do NOT interpret behavior — they bound the domain of
 * validity for any interpretation.
 *
 * Three dimensions:
 *   1. Value coverage — observable activity volume vs current position value
 *   2. Temporal coverage — active periods vs dark periods (no observable events)
 *   3. Data source coverage — which tools contributed vs which are available
 *
 * Design: these are not interpretations.  They are structural measurements
 * of the analysis's own incompleteness.  An agent that sees "35% value coverage"
 * should size its confidence (and any downstream position) accordingly.
 */
export function formatObservationCoverage(opts: {
  /** Total USD value of all observable pool activity for this address */
  totalActivityVolumeUsd: number;
  /** Current position value in USD (PT + YT + LP) */
  currentPositionValueUsd: number;
  /** Array of entry timestamps (unix seconds) — used for temporal gap analysis */
  entryTimestamps: number[];
  /** Whether portfolio data was successfully fetched */
  portfolioFetched: boolean;
  /** Whether pool context (liquidity, APY) was successfully fetched */
  poolContextFetched: boolean;
  /** Whether on-chain data was consulted (spectra_get_onchain_activity) */
  onchainConsulted?: boolean;
  /** Whether cross-chain data was consulted (spectra_get_address_activity) */
  crossChainConsulted?: boolean;
  /** Pool liquidity USD — for sizing context */
  poolLiquidityUsd?: number;
  /** Number of distinct activity types observed */
  distinctActivityTypes: number;
}): string[] {
  const lines: string[] = [];
  lines.push(`  Observation Coverage (what this analysis can and cannot see):`);

  const {
    totalActivityVolumeUsd,
    currentPositionValueUsd,
    entryTimestamps,
    portfolioFetched,
    poolContextFetched,
    onchainConsulted = false,
    crossChainConsulted = false,
    poolLiquidityUsd = 0,
    distinctActivityTypes,
  } = opts;

  // -------------------------------------------------------
  // 1. Value coverage — does activity volume explain position size?
  // -------------------------------------------------------
  if (currentPositionValueUsd > 0 && totalActivityVolumeUsd > 0) {
    const ratio = totalActivityVolumeUsd / currentPositionValueUsd;
    const pct = (ratio * 100).toFixed(0);

    if (ratio < 0.5) {
      // Activity volume is much less than position — large invisible component
      lines.push(`    Value Coverage: ${pct}% — observable activity (${formatUsd(totalActivityVolumeUsd)}) explains less than half of current position (${formatUsd(currentPositionValueUsd)}).`);
      lines.push(`      ⚠ Significant invisible activity: direct mints, cross-protocol moves, L2 bridges, or transfers not visible in pool data.`);
      lines.push(`      Implication: any strategy inference from pool activity alone is based on a minority of this address's behavior.`);
    } else if (ratio < 1.5) {
      lines.push(`    Value Coverage: ${pct}% — observable activity roughly matches position size. Pool activity may explain most of the position.`);
    } else {
      // Activity volume >> position — capital recycling or completed round-trips
      lines.push(`    Value Coverage: ${pct}% — observable activity (${formatUsd(totalActivityVolumeUsd)}) significantly exceeds current position (${formatUsd(currentPositionValueUsd)}).`);
      lines.push(`      This suggests capital recycling (looping), completed round-trips (entered and exited), or funds that moved elsewhere.`);
    }
  } else if (currentPositionValueUsd === 0 && totalActivityVolumeUsd > 0) {
    lines.push(`    Value Coverage: Position is zero despite ${formatUsd(totalActivityVolumeUsd)} in observable activity.`);
    lines.push(`      Address has fully exited, or position is held in a form not visible here (different pool, chain, or protocol).`);
  } else if (currentPositionValueUsd > 0 && totalActivityVolumeUsd === 0) {
    lines.push(`    Value Coverage: 0% — no observable pool activity, but position value is ${formatUsd(currentPositionValueUsd)}.`);
    lines.push(`      ⚠ Entire position was built through channels invisible to this tool (direct mints, transfers, other pools).`);
  }

  // -------------------------------------------------------
  // 2. Temporal coverage — when was this address active vs dark?
  // -------------------------------------------------------
  if (entryTimestamps.length >= 2) {
    const sorted = [...entryTimestamps].sort((a, b) => a - b);
    const firstTs = sorted[0];
    const lastTs = sorted[sorted.length - 1];
    const spanDays = Math.max(1, (lastTs - firstTs) / 86400);
    const activeDays = new Set(sorted.map(ts => Math.floor(ts / 86400))).size;

    // Find the longest gap between consecutive entries
    let maxGapSeconds = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap > maxGapSeconds) maxGapSeconds = gap;
    }
    const maxGapDays = maxGapSeconds / 86400;

    const activePct = ((activeDays / spanDays) * 100).toFixed(0);
    lines.push(`    Temporal Coverage: active on ${activeDays} of ~${spanDays.toFixed(0)} days spanned (${activePct}%).`);

    if (maxGapDays > 7) {
      lines.push(`      Longest dark period: ${maxGapDays.toFixed(1)} days with no observable pool activity.`);
      lines.push(`      During dark periods, the address may have been: inactive, operating on other pools/chains, or using channels invisible to pool activity data.`);
    }
  }

  // -------------------------------------------------------
  // 3. Data source coverage — what contributed to this analysis?
  // -------------------------------------------------------
  const sourcesUsed: string[] = ["pool activity (Curve AMM events)"];
  const sourcesAvailable: string[] = ["pool activity (Curve AMM events)"];

  if (portfolioFetched) {
    sourcesUsed.push("portfolio (PT/YT/LP balances)");
  }
  sourcesAvailable.push("portfolio (PT/YT/LP balances)");

  if (poolContextFetched) {
    sourcesUsed.push("pool context (liquidity, implied APY)");
  }
  sourcesAvailable.push("pool context (liquidity, implied APY)");

  sourcesAvailable.push("on-chain events (eth_getLogs: mints, redeems, yield claims)");
  if (onchainConsulted) {
    sourcesUsed.push("on-chain events (eth_getLogs)");
  }

  sourcesAvailable.push("cross-chain scan (all Spectra pools)");
  if (crossChainConsulted) {
    sourcesUsed.push("cross-chain scan");
  }

  const coverageRatio = `${sourcesUsed.length}/${sourcesAvailable.length}`;
  lines.push(`    Data Sources: ${coverageRatio} available sources consulted.`);
  lines.push(`      Used: ${sourcesUsed.join(", ")}`);

  const unused = sourcesAvailable.filter(s => !sourcesUsed.includes(s));
  if (unused.length > 0) {
    lines.push(`      Not consulted: ${unused.join(", ")}`);
    lines.push(`      → Invisible to this analysis: standalone mints/redeems (no pool event), yield claims, cross-chain activity, and any non-Spectra operations.`);
  }

  // -------------------------------------------------------
  // 4. Activity type coverage — how many event types observed?
  // -------------------------------------------------------
  if (distinctActivityTypes === 1) {
    lines.push(`    Activity Diversity: only 1 event type observed. Single-type activity is the highest-ambiguity pattern — competing interpretations diverge maximally.`);
  } else if (distinctActivityTypes === 2) {
    lines.push(`    Activity Diversity: 2 event types observed. Paired types constrain interpretations somewhat, but multiple strategies produce the same pairs.`);
  }

  // -------------------------------------------------------
  // Boundary marker — the meta-statement
  // -------------------------------------------------------
  lines.push(`    ─────────────────────────────────────────`);
  lines.push(`    This analysis covers interpretations consistent with observed history.`);
  lines.push(`    It cannot account for unprecedented behavior or invisible activity.`);
  lines.push(`    Position sizing should assume this analysis is incomplete, not comprehensive.`);

  return lines;
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
 * Used by spectra_scan_opportunities and spectra_scan_yt_arbitrage to attach LP data.
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
  // Sanitize boostedRewards: API can return null for min/max on new gauges
  const rawBoosted = lp?.details?.boostedRewards || {};
  const safeBoosted: Record<string, { min: number; max: number }> = {};
  for (const [token, range] of Object.entries(rawBoosted)) {
    if (range.min == null && range.max == null) continue; // skip entirely null gauges
    safeBoosted[token] = { min: range.min ?? 0, max: range.max ?? 0 };
  }
  const breakdown = {
    fees: lp?.details?.fees || 0,
    pt: lp?.details?.pt || 0,
    ibt: lp?.details?.ibt || 0,
    rewards: lp?.details?.rewards || {},
    boostedRewards: safeBoosted,
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
  if (breakdown.pt > 0) parts.push(`PT convergence ${formatPct(breakdown.pt)}`);
  if (breakdown.ibt > 0) parts.push(`IBT accrual ${formatPct(breakdown.ibt)}`);

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

  // Sustainability signal: flag when incentives dominate LP APY
  const organic = breakdown.fees + breakdown.pt + breakdown.ibt;
  if (lpApy > 0 && organic < lpApy * 0.5 && (lpApy - organic) > 0) {
    lines.push(`    LP APY (organic only, no rewards/gauge): ${formatPct(organic)}`);
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
 * Estimate the imbalance fee from an LP deposit into a Curve StableSwap-NG pool.
 *
 * LP deposits add to BOTH sides of the pool (IBT and PT), deepening liquidity
 * rather than consuming it. The "impact" is the imbalance fee charged by Curve
 * when the deposit shifts the pool's balance ratio.
 *
 * For a balanced deposit (proportional to current reserves), the imbalance fee
 * is near zero. For any deposit into a StableSwap pool with high amplification (A),
 * the fee is extremely small compared to swap slippage.
 *
 * Model: impact ≈ poolShare² / (4 * A) where poolShare = deposit / (poolLiq + deposit)
 * With conservative A=1000 (typical StableSwap-NG pools use A=1000-5000).
 *
 * For comparison at $500K into a $26K pool:
 *   Swap impact (estimatePriceImpact): 961%
 *   LP impact (this function):         0.07%
 *
 * Returns a fraction (0 to 1), same unit as estimatePriceImpact().
 */
export function estimateLpDepositImpact(depositUsd: number, poolLiquidityUsd: number): number {
  if (poolLiquidityUsd <= 0) return 0.01; // 1% default for empty pools (still much lower than swap)
  if (depositUsd <= 0) return 0;

  // Pool share: what fraction of the post-deposit pool is the new deposit
  const poolShareFrac = depositUsd / (poolLiquidityUsd + depositUsd);

  // StableSwap imbalance fee model: fee ≈ poolShare² / (4 * A)
  // Conservative A=1000 (real pools often have A=1000-5000)
  const conservativeA = 1000;
  const impactFrac = (poolShareFrac * poolShareFrac) / (4 * conservativeA);

  // Clamp to [0, 0.5] — LP deposit can never lose more than 50%
  return Math.min(impactFrac, 0.5);
}

/**
 * Estimate price impact for a Pendle logit AMM trade.
 *
 * Pendle's AMM uses: exchangeRate = ln(p/(1-p)) / rateScalar + rateAnchor
 * where p = totalPt / (totalPt + totalAsset) and rateScalar = scalarRoot * 365d / timeToExpiry.
 *
 * The marginal impact is d(rate)/dp = 1 / (rateScalar * p * (1-p)), giving an
 * effective depth of (rateScalar * p * (1-p)) — much deeper than constant-product
 * for balanced pools.
 *
 * We don't have scalarRoot per pool (it's an on-chain parameter, typically 50-200
 * for stablecoin pools). A conservative default of 50 is used, which underestimates
 * efficiency — real impact will usually be lower than this estimate.
 *
 * Falls back to constant-product if the logit model produces a higher estimate
 * (should never happen in practice, but guarantees we never overestimate efficiency).
 */
export function estimatePendlePriceImpact(
  amountUsd: number,
  poolLiquidityUsd: number,
  totalPt: number,
  totalSy: number,
  daysToExpiry: number,
): number {
  if (poolLiquidityUsd <= 0) return 1;

  const cpImpact = amountUsd / (2 * poolLiquidityUsd);

  // Need pool reserves to compute logit model
  const totalPool = totalPt + totalSy;
  if (totalPool <= 0) return cpImpact;

  // Pool proportion (clamped to Pendle's bounds)
  const p = Math.max(0.01, Math.min(0.96, totalPt / totalPool));

  // rateScalar = scalarRoot * 365 / daysToExpiry
  // Conservative scalarRoot = 50 (typical stablecoin pools use 50-200)
  const CONSERVATIVE_SCALAR_ROOT = 50;
  const rateScalar = CONSERVATIVE_SCALAR_ROOT * 365 / Math.max(daysToExpiry, 1);

  // Logit AMM depth: rateScalar * p * (1-p)
  // Compare: constant-product depth factor is 2
  const logitDepth = rateScalar * p * (1 - p);

  // impact = amount / (logitDepth * liquidity)
  const pendleImpact = amountUsd / (logitDepth * poolLiquidityUsd);

  // Never claim Pendle is WORSE than constant-product
  return Math.min(pendleImpact, cpImpact);
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
 * Used by both spectra_quote_trade and spectra_simulate_trade tools.
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

  const sourceTag = q.onChain
    ? "(on-chain Curve get_dy)"
    : "(estimated — constant-product upper bound)";
  const impactLabel = q.onChain
    ? `~${formatPct(q.priceImpactPct)} (derived from on-chain quote vs spot)`
    : `~${formatPct(q.priceImpactPct)} (conservative constant-product upper bound)`;

  const lines = [
    `-- Trade Quote: ${sideLabel} ${sourceTag} --`,
    ``,
    `  Input:  ${q.amountIn.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${q.inputToken}`,
    `  Output: ${q.expectedOut.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${q.outputToken} (expected)`,
    ``,
    `  Spot Rate:      1 ${q.inputToken} = ${q.spotRate.toFixed(6)} ${q.outputToken}`,
    `  Effective Rate:  1 ${q.inputToken} = ${q.effectiveRate.toFixed(6)} ${q.outputToken}`,
    `  Price Impact:   ${impactLabel}`,
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

  if (q.onChain) {
    lines.push(``);
    lines.push(`  Source: Live on-chain Curve StableSwap-NG get_dy() quote.`);
    lines.push(`  This reflects actual pool state including amplification parameter.`);
  } else {
    lines.push(``);
    lines.push(`  Note: Estimate only. Actual Curve StableSwap-NG pools are more capital-efficient,`);
    lines.push(`  so real impact will likely be lower. For exact on-chain quotes use:`);
    lines.push(`    - Curve pool: get_dy(i, j, amount)  [coins(0)=IBT, coins(1)=PT]`);
    lines.push(`    - Spectra Router: previewRate(commands, inputs)`);
  }

  return lines.join("\n");
}

// =============================================================================
// Layer 3 Output Hints
// =============================================================================

/**
 * Layer 3 output hint: volume context relative to pool liquidity.
 * Computes volume/liquidity ratio, trend direction, buy/sell imbalance.
 * Returns lines to append to spectra_get_pool_volume output.
 *
 * Dissolution condition: This hint exists because volume data alone is
 * ambiguous without liquidity context. If a future API returns
 * pre-computed volume-to-liquidity ratios, this function becomes redundant
 * and should be removed.
 */
export function formatVolumeHints(opts: {
  totalVolume: number;
  totalBuy: number;
  totalSell: number;
  recentTotal: number;
  recentBuy: number;
  recentSell: number;
  rangeDays: number;
  poolLiquidityUsd?: number;
}): string[] {
  const lines: string[] = [];
  lines.push(``);
  lines.push(`  Volume Signals:`);

  // Volume/liquidity ratio
  if (opts.poolLiquidityUsd && opts.poolLiquidityUsd > 0) {
    const dailyAvg = opts.totalVolume / Math.max(1, opts.rangeDays);
    const volLiqRatio = dailyAvg / opts.poolLiquidityUsd;
    const recentDailyAvg = opts.recentTotal / 7;
    const recentVolLiqRatio = recentDailyAvg / opts.poolLiquidityUsd;

    lines.push(`    Pool Liquidity: ${formatUsd(opts.poolLiquidityUsd)}`);
    lines.push(`    Daily Avg / Liquidity: ${(volLiqRatio * 100).toFixed(2)}% (all-time) | ${(recentVolLiqRatio * 100).toFixed(2)}% (7d)`);

    if (recentVolLiqRatio > 0.1) {
      lines.push(`    High turnover -- daily volume exceeds 10% of pool depth. Could indicate active looping or large position entries.`);
    } else if (recentVolLiqRatio < 0.005 && opts.recentTotal > 0) {
      lines.push(`    Low turnover -- volume well below 1% of pool depth. Could indicate a mature/stable pool or declining interest.`);
    }
  } else {
    lines.push(`    Pool liquidity unavailable -- use spectra_get_pt_details to get liquidity context.`);
  }

  // Buy/sell imbalance (recent)
  if (opts.recentTotal > 0) {
    const buyPct = (opts.recentBuy / opts.recentTotal) * 100;
    const sellPct = (opts.recentSell / opts.recentTotal) * 100;
    if (Math.abs(buyPct - sellPct) > 20) {
      const skew = buyPct > sellPct ? "buy" : "sell";
      lines.push(`    7d skew: ${skew}-heavy (${buyPct.toFixed(0)}% buy / ${sellPct.toFixed(0)}% sell). Could indicate ${skew === "buy" ? "PT accumulation or YT flash-redeem selling" : "PT distribution or YT flash-mint acquisition"}.`);
    }
  }

  // Trend: compare recent to all-time daily average
  if (opts.rangeDays > 14 && opts.totalVolume > 0) {
    const allTimeDaily = opts.totalVolume / opts.rangeDays;
    const recentDaily = opts.recentTotal / 7;
    if (allTimeDaily > 0) {
      const trendRatio = recentDaily / allTimeDaily;
      if (trendRatio > 2) {
        lines.push(`    Trend: Recent daily volume is ${trendRatio.toFixed(1)}x the all-time average -- activity could be accelerating.`);
      } else if (trendRatio < 0.3 && opts.recentTotal > 0) {
        lines.push(`    Trend: Recent daily volume is ${(trendRatio * 100).toFixed(0)}% of all-time average -- activity could be declining.`);
      }
    }
  }

  return lines;
}

/**
 * Layer 3 output hint: is the spread between a Morpho market's borrow rate
 * and typical PT yields worth looping? Appended per-market in morpho_list_markets.
 *
 * Dissolution condition: When spectra_scan_opportunities becomes the default entry
 * point for all looping decisions (i.e., agents never call morpho_list_markets
 * directly for strategy), these hints are redundant and should be removed.
 */
export function formatMorphoMarketHints(m: MorphoMarket, ptMaturityIndex?: Map<string, number>): string[] {
  const lines: string[] = [];
  const s = m.state;
  if (!s) return lines;

  const borrowApy = (s.borrowApy || 0) * 100;
  const utilization = (s.utilization || 0) * 100;
  const availableLiq = getEffectiveLiquidityUsd(m);

  // Capacity warning
  if (availableLiq < 50000) {
    lines.push(`  Hint: Available liquidity is ${formatUsd(availableLiq)} -- looping at scale could exhaust borrowable supply.`);
  }

  // Utilization warning
  if (utilization > 90) {
    lines.push(`  Hint: Utilization is ${formatPct(utilization)} -- borrow rate could spike further. Looping margin may compress.`);
  }

  // Spread hint
  if (borrowApy > 8) {
    lines.push(`  Hint: Borrow rate ${formatPct(borrowApy)} is high. Looping is only profitable when PT implied APY exceeds this. Verify spread with spectra_get_looping_strategy.`);
  } else if (borrowApy < 3) {
    lines.push(`  Hint: Borrow rate ${formatPct(borrowApy)} is low -- could indicate a favorable looping environment if PT APY is above this.`);
  }

  // Temporal perception: surface collateral PT maturity
  // Prefer structured data from Spectra/Pendle APIs, fall back to name parsing
  const collateralAddr = m.collateralAsset?.address?.toLowerCase() || "";
  const structuredMaturity = ptMaturityIndex?.get(collateralAddr);
  const maturityDate = structuredMaturity
    ? new Date(structuredMaturity * 1000)
    : parsePtMaturityFromName(m.collateralAsset?.name || "");

  if (maturityDate && !isNaN(maturityDate.getTime())) {
    const deltaDays = Math.floor((Date.now() - maturityDate.getTime()) / 86400000);
    if (deltaDays > 0) {
      lines.push(`  Collateral PT matured ${maturityDate.toISOString().slice(0, 10)} (${deltaDays}d ago)`);
    } else if (-deltaDays <= 14) {
      lines.push(`  Collateral PT matures ${maturityDate.toISOString().slice(0, 10)} (${-deltaDays}d)`);
    }
  }

  return lines;
}

/**
 * Layer 3 output hint: portfolio-level signals when viewing all positions.
 * Concentration analysis, maturity proximity warnings, strategy shape,
 * and negative signals (observable absences).
 *
 * Dissolution condition: When Spectra adds a native portfolio analytics
 * endpoint that computes these metrics server-side, this function becomes
 * redundant and should be removed.
 */
export function formatPortfolioHints(
  positions: Array<{
    totalValue: number; chain: string; maturityDays: number;
    ptBalance: number; ytBalance: number; lpBalance: number; name: string;
    ptAddress?: string; maturityTs?: number;
    morphoAvailable?: boolean; // true=market exists, false=checked but none, undefined=lookup failed
  }>,
  totalPortfolioValue: number,
): string[] {
  const lines: string[] = [];
  lines.push(``);
  lines.push(`  Portfolio Signals:`);

  // --- Multi-position hints (require 2+ positions) ---
  if (positions.length >= 2) {
    // Concentration
    const sorted = [...positions].sort((a, b) => b.totalValue - a.totalValue);
    if (totalPortfolioValue > 0) {
      const largestPct = (sorted[0].totalValue / totalPortfolioValue) * 100;
      if (largestPct > 80) {
        lines.push(`    Concentration: ${largestPct.toFixed(0)}% in ${sorted[0].name} -- portfolio is heavily concentrated in a single position.`);
      }
    }

    // Maturity proximity
    const maturingSoon = positions.filter(p => p.maturityDays > 0 && p.maturityDays < 14);
    if (maturingSoon.length > 0) {
      const names = maturingSoon.map(p => p.name).join(", ");
      lines.push(`    Maturity alert: ${maturingSoon.length} position(s) maturing within 14 days (${names}). Consider redemption or rollover.`);
    }

    // Cross-chain diversification
    const uniqueChains = new Set(positions.map(p => p.chain));
    if (uniqueChains.size === 1 && positions.length > 2) {
      lines.push(`    All ${positions.length} positions are on a single chain. Could indicate intentional concentration or an opportunity for cross-chain diversification.`);
    }

    // Strategy shape
    const totalPt = positions.reduce((s, p) => s + p.ptBalance, 0);
    const totalYt = positions.reduce((s, p) => s + p.ytBalance, 0);
    if (totalYt > 0 && totalPt > 0) {
      const ytPtRatio = totalYt / totalPt;
      if (ytPtRatio > 3) {
        lines.push(`    Portfolio shape: YT-heavy (${ytPtRatio.toFixed(1)}:1 YT/PT). Could indicate aggregate yield-directional positioning.`);
      } else if (ytPtRatio < 0.3) {
        lines.push(`    Portfolio shape: PT-heavy (${(1 / ytPtRatio).toFixed(1)}:1 PT/YT). Could indicate aggregate fixed-rate accumulation.`);
      }
    }

    // Data tension: contradicting strategies across positions
    const ptHeavyPositions = positions.filter(p => p.ptBalance > 0 && (p.ytBalance === 0 || p.ptBalance > p.ytBalance * 3));
    const ytHeavyPositions = positions.filter(p => p.ytBalance > 0 && (p.ptBalance === 0 || p.ytBalance > p.ptBalance * 3));
    if (ptHeavyPositions.length > 0 && ytHeavyPositions.length > 0) {
      lines.push(
        `    Data tension: Portfolio holds PT-heavy positions (${ptHeavyPositions.map(p => p.name).join(", ")}) ` +
        `AND YT-heavy positions (${ytHeavyPositions.map(p => p.name).join(", ")}). ` +
        `This is either: (A) a deliberate hedge — fixed-rate on some underlyings, variable-rate bet on others, ` +
        `(B) different strategies at different entry times that haven't been cleaned up, ` +
        `or (C) different underlyings with different rate outlooks justifying opposite positions. ` +
        `The aggregate YT/PT ratio masks this split.`
      );
    }
  }

  // --- Negative signals (valuable even for single positions) ---

  // Morpho looping availability
  const positionsWithMorphoData = positions.filter(p => p.morphoAvailable !== undefined);
  if (positionsWithMorphoData.length > 0) {
    const withMorpho = positionsWithMorphoData.filter(p => p.morphoAvailable === true);
    const withoutMorpho = positionsWithMorphoData.filter(p => p.morphoAvailable === false);

    if (withMorpho.length > 0) {
      const names = withMorpho.map(p => p.name).join(", ");
      lines.push(`    Morpho markets exist for: ${names}. No looping detected in portfolio — could indicate risk-averse strategy or uninvestigated opportunity. Use spectra_get_looping_strategy to evaluate.`);
    }
    if (withoutMorpho.length > 0) {
      const names = withoutMorpho.map(p => p.name).join(", ");
      lines.push(`    No Morpho markets found for: ${names}. Looping unavailable for these positions.`);
    }
  }

  // Expired positions aggregate
  const expired = positions.filter(p =>
    p.maturityTs && p.maturityTs * 1000 <= Date.now() && p.totalValue > 10
  );
  if (expired.length > 0) {
    const totalExpiredValue = expired.reduce((s, p) => s + p.totalValue, 0);
    const names = expired.map(p => p.name).join(", ");
    lines.push(`    ${expired.length} expired position(s) with ~${formatUsd(totalExpiredValue)} (${names}). Consider redemption.`);
  }

  // Gauge exposure without boost context (portfolio-level reminder)
  const lpPositions = positions.filter(p => p.lpBalance > 0 && p.totalValue > 100);
  if (lpPositions.length > 0) {
    lines.push(`    ${lpPositions.length} LP position(s) detected. If gauge-boosted, veSPECTRA affects effective yield — use spectra_get_ve_info to check boost status.`);
  }

  if (lines.length <= 2) return []; // Only header, no actual hints
  return lines;
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
  ibtAddress?: string;
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
    `  Underlying: ${opts.underlyingSymbol} | IBT: ${opts.ibtSymbol}${opts.ibtAddress ? ` (${opts.ibtAddress})` : ""}`,
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
    ? `${formatPct(opp.impliedApy)} base -> ≥${formatPct(opp.looping.optimalEffectiveNetApy)} effective with ${opp.looping.optimalLoops}x loop (conservative est.)`
    : `${formatPct(opp.impliedApy)} base -> ≥${formatPct(opp.effectiveApy)} effective (conservative est.)`;
  lines.push(`#${rank}  ${opp.pt.name} (${opp.chain}) -- ${headline}`);

  // Maturity
  lines.push(`    Maturity: ${formatDate(opp.maturityTimestamp)} (${opp.daysToMaturity} days)`);

  // Pool size
  lines.push(`    PT TVL: ${formatUsd(opp.tvlUsd)} | Liquidity: ${formatUsd(opp.poolLiquidityUsd)}`);
  if (opp.tvlUsd === 0 && opp.poolLiquidityUsd === 0) {
    lines.push(`    ⚡ $0 USD values — likely price feed outage (DeFiLlama or similar), not an empty pool. Check on-chain reserves before skipping.`);
  }

  // Capital-aware impact
  lines.push(`    Entry Impact: ~${formatPct(opp.entryImpactPct)} | Capacity: ~${formatUsd(opp.capacityUsd)} at <threshold`);

  // APY lines — always show all three dimensions. No threshold hides the LP alternative.
  // Open emergence: the comparison between base, effective, and LP IS the information.
  // An agent seeing "base 23%, effective -228%, LP 23%" understands immediately that
  // PT buy is expensive but LP is viable. The three numbers together teach the mechanics.
  lines.push(`    Base APY: ${formatPct(opp.impliedApy)} | Effective APY (PT buy): ≥${formatPct(opp.effectiveApy)} (conservative est.)`);
  if (opp.lpApy > 0) {
    lines.push(`    LP APY: ${formatPct(opp.lpApy)} (near-zero entry impact — LP adds liquidity, not buys PT)`);
  }

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

  // Merkl external campaigns (supplemental to API rewards)
  if (opp.merklCampaigns && opp.merklCampaigns.length > 0) {
    const existingTokens = new Set<string>();
    for (const token of Object.keys(opp.lpApyBreakdown.rewards)) existingTokens.add(token.toUpperCase());
    const merklLines = formatMerklCampaignLines(opp.merklCampaigns, existingTokens, "      ");
    for (const ml of merklLines) lines.push(ml);
  }

  // Yield dimensions — all strategies side by side so the agent sees the tension
  const dims: string[] = [
    `Fixed: ${formatPct(opp.effectiveApy)}`,
    `Variable: ${formatPct(opp.variableApr)}`,
    `LP: ${formatPct(opp.lpApy)}`,
  ];
  if (opp.looping) dims.push(`Loop: ${formatPct(opp.looping.optimalEffectiveNetApy)}`);
  if (opp.lpApyBoostedTotal > opp.lpApy) dims.push(`LP(max boost): ${formatPct(opp.lpApyBoostedTotal)}`);
  lines.push(`    Yield Dimensions: ${dims.join(" | ")}`);

  // Strategy tension: present competing interpretations (generative friction)
  // Dissolution condition: Dissolves when agents reliably surface competing
  // strategies without explicit prompting.
  if (opp.variableApr > 0 && opp.looping) {
    const ytExposure = opp.variableApr * (opp.pool.ytLeverage || 1);
    if (ytExposure > opp.looping.optimalEffectiveNetApy * 0.7) {
      lines.push(`    Strategy Tension: YT accumulation at ${(opp.pool.ytLeverage || 0).toFixed(1)}x leverage could yield ~${formatPct(ytExposure)} if variable rates persist -- which competes with the looping fixed ~${formatPct(opp.looping.optimalEffectiveNetApy)}. The right choice depends on rate direction conviction.`);
    }
  }

  // Combined LP + Loop strategy hint: when both LP and looping are viable,
  // curators can split their mint output — LP some PT, loop some PT, keep YT.
  // Dissolution condition: Dissolves when agents reliably discover combined
  // strategies from Yield Dimensions alone.
  if (opp.looping && opp.lpApy > 5) {
    const bestLp = opp.lpApyBoostedTotal > opp.lpApy ? opp.lpApyBoostedTotal : opp.lpApy;
    if (bestLp > opp.looping.optimalEffectiveNetApy * 0.5) {
      lines.push(`    Combined Strategy: Mint PT+YT → LP a portion (${formatPct(bestLp)} LP APY) + loop remaining PT via Morpho (${formatPct(opp.looping.optimalEffectiveNetApy)} net). YT earns variable yield. Split ratio depends on pool depth vs Morpho liquidity (${formatUsd(opp.looping.morphoLiquidityUsd)} available).`);
    }
  }

  // Underlying info
  lines.push(`    Underlying: ${opp.underlying} | IBT: ${opp.ibtSymbol} (${opp.ibtProtocol})`);

  // IBT APR composition — critical for reasoning about where yield comes from
  const scanIbtDet = opp.pt.ibt?.apr?.details;
  if (scanIbtDet) {
    const ibtParts: string[] = [];
    if (scanIbtDet.base != null) ibtParts.push(`base ${formatPct(scanIbtDet.base)}`);
    if (scanIbtDet.rewards) {
      for (const [token, apy] of Object.entries(scanIbtDet.rewards)) {
        ibtParts.push(`${token} ${formatPct(apy)}`);
      }
    }
    if (ibtParts.length > 0) {
      lines.push(`    IBT APR: ${formatPct(opp.variableApr)} (${ibtParts.join(" + ")})`);
    }
    // Incentive sustainability signal
    const scanIbtBase = scanIbtDet.base ?? 0;
    if (opp.variableApr > 0 && scanIbtBase < opp.variableApr * 0.5) {
      const scanIncentivePct = ((opp.variableApr - scanIbtBase) / opp.variableApr * 100).toFixed(0);
      lines.push(`    ** ${scanIncentivePct}% of IBT APR is incentive-driven. Base alone: ${formatPct(scanIbtBase)} **`);
    }
  }

  // Entry path awareness — surface distance from common assets to this pool.
  // The scanner ranks by effective APY, but effective APY doesn't include the
  // cost of GETTING the entry asset. An agent recommending "deposit into ynRWAx
  // on mainnet" without flagging that ynRWAx requires minting through YieldNest
  // is giving incomplete advice. This surfaces the gap — not the exact cost
  // (that changes by the second) but the shape of the path.
  // Pass capitalUsd so the gas rationality floor fires for small positions
  const scanEntryPath = inferEntryPath(
    opp.underlying, opp.ibtSymbol, opp.pt.baseIbt?.symbol, opp.chain, opp.capitalUsd
  );
  if (scanEntryPath) {
    lines.push(`    ${scanEntryPath}`);
  }

  // Points programs
  if (opp.pt.multipliers && opp.pt.multipliers.length > 0) {
    const mParts = opp.pt.multipliers.map(m => `${m.name} ${m.amount}x`);
    lines.push(`    Points: ${mParts.join(", ")}`);
  }

  // Tags
  if (opp.pt.tags && opp.pt.tags.length > 0) {
    lines.push(`    Tags: ${opp.pt.tags.join(", ")}`);
  }

  // Pool context — data the scanner already computed, surfaced so agents
  // don't need to re-fetch via spectra_get_pt_details or spectra_get_pool_activity
  lines.push(`    Pool: ${opp.poolAddress}`);
  if (opp.pool.ibtAmount && opp.pool.ptAmount) {
    const ibtDec = opp.pt.ibt?.decimals ?? 18;
    const ptDec = opp.pt.decimals ?? 18;
    const ibtAmt = Number(opp.pool.ibtAmount) / 10 ** ibtDec;
    const ptAmt = Number(opp.pool.ptAmount) / 10 ** ptDec;
    if (ibtAmt > 0 && ptAmt > 0) {
      const ratio = ptAmt / ibtAmt;
      lines.push(`    Pool Reserves: ${ibtAmt.toFixed(2)} IBT / ${ptAmt.toFixed(2)} PT (ratio ${ratio.toFixed(2)}:1)`);
      if (ratio > 5) {
        lines.push(`    ** Heavy PT side (${ratio.toFixed(1)}:1) — could mean high PT supply from minting, or LP withdrawal on IBT side **`);
      } else if (ratio < 0.2) {
        lines.push(`    ** Heavy IBT side (1:${(1/ratio).toFixed(1)}) — could mean strong PT demand (rate compression), or fresh pool with few mints **`);
      }
    }
  }

  // Full loop curve — agents need the shape, not just the peak
  if (opp.looping && opp.looping.lltv > 0) {
    const loopLines: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const lev = cumulativeLeverageAtLoop(i, opp.looping.lltv);
      const borrowed = lev - 1;
      const grossApy = lev * opp.impliedApy;
      const borrowCost = borrowed * opp.looping.borrowRatePct;
      const netApy = grossApy - borrowCost;
      loopLines.push(`${i}L: ${lev.toFixed(2)}x lev, ${formatPct(netApy)} net`);
    }
    lines.push(`    Loop Curve: ${loopLines.join(" | ")}`);
  }

  // Addresses
  lines.push(`    PT Address: ${opp.ptAddress}`);
  if (opp.ibtAddress) {
    lines.push(`    IBT Address: ${opp.ibtAddress}`);
  }

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
  totalBeforeTruncation?: number,
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
  const truncNote = totalBeforeTruncation != null && totalBeforeTruncation > opportunities.length
    ? ` (showing top ${opportunities.length} of ${totalBeforeTruncation})`
    : "";
  lines.push(`  Results: ${opportunities.length} opportunities${truncNote} sorted by ${includeLooping ? "looping net APY / " : ""}effective APY (see Yield Dimensions for other strategies)`);

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
  lines.push(`--- Impact Accuracy ---`);
  lines.push(`  ⚠ Effective APY shown is a CONSERVATIVE LOWER BOUND.`);
  lines.push(`  Entry impact uses constant-product model. Real Curve StableSwap-NG pools are more`);
  lines.push(`  capital-efficient — actual effective APY is typically 30-60% higher than shown.`);
  lines.push(`  → Verify top picks: spectra_quote_trade(chain, pt_address, amount, "buy") gives exact on-chain quotes.`);
  lines.push(``);
  lines.push(`  Rankings reflect one dimension of a multi-dimensional space. A lower-ranked pool could be better`);
  lines.push(`  for a different strategy (YT accumulation, LP farming) or time horizon. See Yield Dimensions per opportunity.`);

  // Prescriptive observation boundary — the tools that recommend capital
  // deployment must declare what they cannot see
  lines.push(``);
  const boundary = formatPrescriptiveObservationBoundary("scan");
  for (const bl of boundary) lines.push(bl);

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
  if (Math.abs(opp.spreadPct) > 5) {
    lines.push(`    Note: Large spread could indicate a genuine mispricing or could reflect stale IBT APR data. Verify IBT rate freshness before acting.`);
  }

  // YT price context
  lines.push(`    YT Price: ${formatUsd(opp.ytPriceUsd)} (${opp.ytPriceUnderlying.toFixed(4)} underlying) | Leverage: ${opp.ytLeverage.toFixed(1)}x`);

  // Maturity
  lines.push(`    Maturity: ${formatDate(opp.maturityTimestamp)} (${opp.daysToMaturity} days)`);

  // Size
  lines.push(`    PT TVL: ${formatUsd(opp.tvlUsd)} | Liquidity: ${formatUsd(opp.poolLiquidityUsd)}`);

  // Capital-aware
  lines.push(`    Entry Impact: ~${formatPct(opp.entryImpactPct)} | Capacity: ~${formatUsd(opp.capacityUsd)}`);
  if (opp.breakEvenDays < Infinity) {
    lines.push(`    Break-Even: ~${Math.ceil(opp.breakEvenDays)} days (spread must persist to cover entry cost)`);
  }

  // LP yield (always incentivized by gauge emissions)
  const lpLines = formatLpApyLines(opp.lpApy, opp.lpApyBoostedTotal, opp.lpApyAtBoost, opp.lpApyBreakdown, boostInfo);
  for (const ll of lpLines) lines.push(ll);

  // Merkl external campaigns
  if (opp.merklCampaigns && opp.merklCampaigns.length > 0) {
    const existingTokens = new Set<string>();
    for (const token of Object.keys(opp.lpApyBreakdown.rewards)) existingTokens.add(token.toUpperCase());
    const merklLines = formatMerklCampaignLines(opp.merklCampaigns, existingTokens, "      ");
    for (const ml of merklLines) lines.push(ml);
  }

  // Underlying info
  lines.push(`    Underlying: ${opp.underlying} | IBT: ${opp.ibtSymbol} (${opp.ibtProtocol})`);

  // IBT APR composition — essential for YT arb: is the IBT APR organic or incentive-driven?
  const ytIbtDet = opp.pt.ibt?.apr?.details;
  if (ytIbtDet) {
    const ibtParts: string[] = [];
    if (ytIbtDet.base != null) ibtParts.push(`base ${formatPct(ytIbtDet.base)}`);
    if (ytIbtDet.rewards) {
      for (const [token, apy] of Object.entries(ytIbtDet.rewards)) {
        ibtParts.push(`${token} ${formatPct(apy)}`);
      }
    }
    if (ibtParts.length > 0) {
      lines.push(`    IBT APR Composition: ${ibtParts.join(" + ")}`);
    }
  }

  // Points programs
  if (opp.pt.multipliers && opp.pt.multipliers.length > 0) {
    const mParts = opp.pt.multipliers.map(m => `${m.name} ${m.amount}x`);
    lines.push(`    Points: ${mParts.join(", ")}`);
  }

  // Tags
  if (opp.pt.tags && opp.pt.tags.length > 0) {
    lines.push(`    Tags: ${opp.pt.tags.join(", ")}`);
  }

  // Addresses
  lines.push(`    PT Address: ${opp.ptAddress}`);
  if (opp.ibtAddress) {
    lines.push(`    IBT Address: ${opp.ibtAddress}`);
  }

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
  totalBeforeTruncation?: number,
): string {
  const lines: string[] = [];

  const positiveSpread = opportunities.filter((o) => o.spreadPct > 0).length;
  const negativeSpread = opportunities.filter((o) => o.spreadPct <= 0).length;
  const truncNote = totalBeforeTruncation != null && totalBeforeTruncation > opportunities.length
    ? ` (showing top ${opportunities.length} of ${totalBeforeTruncation})`
    : "";

  // Header
  lines.push(`== YT Arbitrage Scan: ${formatUsd(capitalUsd)} capital ==`);
  if (assetFilter) lines.push(`  Asset Filter: ${assetFilter}`);
  lines.push(`  Min Spread: ${formatPct(minSpreadPct)}`);
  if (veSpectraBalance !== undefined && veSpectraBalance > 0) {
    lines.push(`  veSPECTRA: ${veSpectraBalance.toLocaleString("en-US")} tokens (boost varies per pool)`);
  }
  lines.push(`  Results: ${opportunities.length} opportunities${truncNote} (${positiveSpread} positive spread, ${negativeSpread} negative spread)`);

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
  lines.push(`  These are snapshots, not predictions. A spread that exists now could narrow before your transaction confirms.`);

  return lines.join("\n");
}

// =============================================================================
// MetaVault API Formatting
// =============================================================================

/** Format a single MetaVault for detailed output. */
/** Map chain ID → human-readable name for bridge display. */
function chainIdToName(id: number): string {
  for (const info of Object.values(SUPPORTED_CHAINS)) {
    if (info.id === id) return info.name;
  }
  return `Chain ${id}`;
}

export function formatMetavaultSummary(
  mv: SpectraMetavault,
  chain: string,
  merklByPool?: Map<string, MerklCampaign[]>,
  vaultMerklRewards?: Array<{ symbol: string; amount: number }>,
  merklWarnings?: string[],
): string {
  const lines: string[] = [];

  lines.push(`-- ${mv.metadata?.title || mv.name} (${mv.symbol}) --`);
  lines.push(`  Chain: ${chain}`);
  lines.push(`  MetaVault: ${mv.address}`);
  lines.push(`  Vault: ${mv.vault}`);
  lines.push(`  Curator: ${mv.curator?.name || "Unknown"}${mv.curator?.addresses?.length ? ` (${mv.curator.addresses[0]})` : ""}`);
  if (mv.metadata?.shortDescription) {
    lines.push(`  Description: ${mv.metadata.shortDescription}`);
  }

  // Underlying
  lines.push(`  Underlying: ${mv.underlying?.symbol || "?"} (${mv.underlying?.address || "?"})`);

  // TVL & APY — compute idle ratio for headline visibility
  const decimals = mv.underlying?.decimals || 6;
  const vaultTvlUsd = mv.tvl?.usd || 0;
  // Pre-compute idle ratio so it appears in the headline, not buried in allocations
  let headlineIdlePct: number | null = null;
  let headlineIdleUsd = 0;
  if (mv.positions && mv.positions.length > 0 && vaultTvlUsd > 0) {
    let headlineAllocTotal = 0;
    for (const pos of mv.positions) {
      const pool = pos.pools?.[0];
      const rawBalance = pool?.lpt?.balance || pos.balance;
      if (rawBalance && pool?.lpt?.price?.usd) {
        const dec = pool.lpt.decimals || 18;
        const raw = BigInt(rawBalance);
        const d = 10n ** BigInt(dec);
        const lpBalance = Number(raw / d) + Number(raw % d) / Number(d);
        headlineAllocTotal += lpBalance * pool.lpt.price.usd;
      }
    }
    headlineIdleUsd = Math.max(0, vaultTvlUsd - headlineAllocTotal);
    headlineIdlePct = (headlineIdleUsd / vaultTvlUsd) * 100;
  }
  const idleSuffix = headlineIdlePct !== null && headlineIdlePct > 5
    ? ` — ${headlineIdlePct.toFixed(0)}% idle (${formatUsd(headlineIdleUsd)} undeployed)`
    : "";
  lines.push(`  TVL: ${formatUsd(vaultTvlUsd)} (${(mv.tvl?.underlying || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${mv.underlying?.symbol || "tokens"})${idleSuffix}`);
  lines.push(`  Live APY: ${formatPct(mv.liveApy?.total || 0)}`);

  // APY breakdown — surface composition so agents can reason about yield sources
  const apyDetails = mv.liveApy?.details;
  if (apyDetails) {
    if (apyDetails.base != null) {
      lines.push(`    +-- Base (fees + PT convergence + IBT accrual): ${formatPct(apyDetails.base)}`);
    }
    if (apyDetails.ibtRewards && Object.keys(apyDetails.ibtRewards).length > 0) {
      for (const [token, apy] of Object.entries(apyDetails.ibtRewards)) {
        lines.push(`    +-- ${token} (IBT reward): ${formatPct(apy)}`);
      }
    }
    if (apyDetails.mvRewards && Object.keys(apyDetails.mvRewards).length > 0) {
      for (const [token, apy] of Object.entries(apyDetails.mvRewards)) {
        lines.push(`    +-- ${token} (MetaVault reward): ${formatPct(apy)}`);
      }
    }
    if (apyDetails.boostedRewards && Object.keys(apyDetails.boostedRewards).length > 0) {
      for (const [token, range] of Object.entries(apyDetails.boostedRewards)) {
        if (range.min == null && range.max == null) continue;
        lines.push(`    +-- ${token} Gauge: ${formatPct(range.min ?? 0)} -> ${formatPct(range.max ?? 0)} (with veSPECTRA boost)`);

      }
    }

    // Compute incentive share — surface the composition ratio
    const baseApy = apyDetails.base || 0;
    const totalApy = mv.liveApy?.total || 0;
    if (totalApy > 0 && baseApy < totalApy) {
      const incentiveApy = totalApy - baseApy;
      const incentivePct = (incentiveApy / totalApy) * 100;
      // Summarize all incentive token names
      const incentiveTokens = [
        ...Object.keys(apyDetails.ibtRewards || {}),
        ...Object.keys(apyDetails.mvRewards || {}),
      ];
      const tokenList = incentiveTokens.length > 0
        ? ` (${[...new Set(incentiveTokens)].join(", ")})`
        : "";
      lines.push(`    Yield composition: ${formatPct(baseApy)} base + ${formatPct(incentiveApy)} incentives${tokenList} (${incentivePct.toFixed(0)}% from incentive programs)`);
      // Single-source fact: surface when one token provides the majority of incentive yield
      const uniqueTokens = [...new Set(incentiveTokens)];
      if (incentivePct > 75 && uniqueTokens.length === 1) {
        lines.push(`    Single incentive source: ${uniqueTokens[0]}`);
      }
    }
  }

  if (mv.liveApy?.boostedTotal && mv.liveApy.boostedTotal > (mv.liveApy?.total || 0)) {
    lines.push(`  Live APY (Max Boost): ${formatPct(mv.liveApy.boostedTotal)}`);
  }

  // Price & exchange rate
  if (mv.price) {
    lines.push(`  Share Price: ${formatUsd(mv.price.usd || 0)} (${(mv.price.underlying || 0).toFixed(6)} underlying)`);
  }

  // Positions
  if (mv.positions && mv.positions.length > 0) {
    const vaultTvlUsd = mv.tvl?.usd || 0;
    lines.push(``);
    let knownAllocTotal = 0;
    let knownAllocCount = 0;
    // Helper: get LP balance from lpt.balance or pos.balance fallback
    const getLpAlloc = (pos: SpectraMetavaultPosition): number | null => {
      const pool = pos.pools?.[0];
      const rawBalance = pool?.lpt?.balance || pos.balance;
      if (!rawBalance || !pool?.lpt?.price?.usd) return null;
      const decimals = pool.lpt.decimals || 18;
      const raw = BigInt(rawBalance);
      const divisor = 10n ** BigInt(decimals);
      const lpBalance = Number(raw / divisor) + Number(raw % divisor) / Number(divisor);
      return lpBalance * pool.lpt.price.usd;
    };
    // Only show positions with known allocation (skip positions with no balance data)
    const allocatedPositions = mv.positions
      .map(pos => ({ pos, alloc: getLpAlloc(pos) }))
      .filter((p): p is { pos: SpectraMetavaultPosition; alloc: number } => p.alloc != null)
      .sort((a, b) => b.alloc - a.alloc);
    lines.push(`  Pool Allocations (${allocatedPositions.length}):`);
    for (const { pos, alloc } of allocatedPositions) {
      knownAllocTotal += alloc;
      knownAllocCount++;
      const matDays = daysToMaturity(pos.maturity);
      const expired = pos.maturity * 1000 <= Date.now();
      const matLabel = expired ? "EXPIRED" : `${matDays}d`;
      const pool = pos.pools?.[0];
      const ptApyStr = pool ? ` | PT APY ${formatPct(pool.ptApy || 0)}` : "";
      const lpApyStr = pool?.lpApy?.total ? ` | LP APY ${formatPct(pool.lpApy.total)}` : "";
      const vaultPct = vaultTvlUsd > 0 ? (alloc / vaultTvlUsd * 100).toFixed(1) : "?";
      const sizeStr = `${vaultPct}% | ${formatUsd(alloc)}`;
      lines.push(`    ${pos.symbol} -- ${formatDate(pos.maturity)} (${matLabel}) -- ${sizeStr}${ptApyStr}${lpApyStr}`);
      lines.push(`      PT: ${pos.address}${pool ? ` | Pool: ${pool.address}` : ""}`);

      // LP APY breakdown per position — surface composition
      const lpDetails = pool?.lpApy?.details;
      if (lpDetails) {
        const parts: string[] = [];
        if (lpDetails.fees) parts.push(`fees ${formatPct(lpDetails.fees)}`);
        if (lpDetails.pt) parts.push(`PT convergence ${formatPct(lpDetails.pt)}`);
        if (lpDetails.ibt) parts.push(`IBT accrual ${formatPct(lpDetails.ibt)}`);
        if (lpDetails.rewards) {
          for (const [token, apy] of Object.entries(lpDetails.rewards)) {
            parts.push(`${token} ${formatPct(apy)}`);
          }
        }
        if (lpDetails.boostedRewards) {
          for (const [token, range] of Object.entries(lpDetails.boostedRewards)) {
            if (range.min == null && range.max == null) continue;
            parts.push(`${token} gauge ${formatPct(range.min ?? 0)}-${formatPct(range.max ?? 0)}`);
          }
        }
        if (parts.length > 0) {
          lines.push(`      LP: ${parts.join(" + ")}`);
        }
      }

      // Merkl campaigns for this position's pool
      if (merklByPool && pool?.address) {
        const campaigns = lookupMerklCampaigns(merklByPool, [pool.address]);
        if (campaigns.length > 0) {
          const existing = new Set<string>();
          if (lpDetails?.rewards) for (const t of Object.keys(lpDetails.rewards)) existing.add(t.toUpperCase());
          const mLines = formatMerklCampaignLines(campaigns, existing, "        ");
          for (const ml of mLines) lines.push(ml);
        }
      }
    }
    // Idle liquidity line
    if (knownAllocCount > 0 && vaultTvlUsd > 0) {
      const idleLiquidity = vaultTvlUsd - knownAllocTotal;
      if (idleLiquidity > 0) {
        const idlePct = (idleLiquidity / vaultTvlUsd * 100).toFixed(1);
        lines.push(`    ${mv.underlying?.symbol || "?"} Idle Liquidity -- ${idlePct}% | ${formatUsd(idleLiquidity)}`);
      }
    }
  }

  // Deposit/withdrawal flow analysis from epochs
  if (mv.epochs && mv.epochs.length >= 2) {
    const underlyingPrice = mv.underlying?.price?.usd || 0;
    const divisor = Math.pow(10, decimals);

    lines.push(``);
    lines.push(`  Vault Flows (from epoch snapshots, ${mv.epochs.length} epochs):`);

    // Sort epochs chronologically
    const sorted = [...mv.epochs].sort((a, b) => a.timestamp - b.timestamp);

    // Show all epoch-to-epoch flows
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const prevAssets = Number(prev.assets) / divisor;
      const currAssets = Number(curr.assets) / divisor;
      const prevRate = Number(prev.rate) / divisor;
      const currRate = Number(curr.rate) / divisor;

      // Asset delta includes both deposits/withdrawals AND yield accrual.
      // Approximate yield = prevAssets * (currRate - prevRate) / prevRate
      // Net deposits ≈ assetDelta - yieldAccrual
      const assetDelta = currAssets - prevAssets;
      const yieldAccrual = prevAssets * (currRate - prevRate) / prevRate;
      const netDeposits = assetDelta - yieldAccrual;

      const deltaUsd = netDeposits * underlyingPrice;
      const sign = deltaUsd >= 0 ? "+" : "";
      const arrow = deltaUsd >= 0 ? "IN" : "OUT";

      lines.push(`    ${formatDate(prev.timestamp)} → ${formatDate(curr.timestamp)} | ${arrow} ${sign}${formatUsd(Math.abs(deltaUsd))} net | TVL ${formatUsd(currAssets * underlyingPrice)} | Rate ${currRate.toFixed(6)}`);
    }

    // Summary: total net flow — sum yield epoch-by-epoch using each epoch's actual TVL
    const firstAssets = Number(sorted[0].assets) / divisor;
    const lastAssets = Number(sorted[sorted.length - 1].assets) / divisor;
    const firstRate = Number(sorted[0].rate) / divisor;
    const lastRate = Number(sorted[sorted.length - 1].rate) / divisor;
    let totalYield = 0;
    for (let i = 1; i < sorted.length; i++) {
      const pA = Number(sorted[i - 1].assets) / divisor;
      const pR = Number(sorted[i - 1].rate) / divisor;
      const cR = Number(sorted[i].rate) / divisor;
      if (pR > 0) totalYield += pA * (cR - pR) / pR;
    }
    const totalAssetDelta = lastAssets - firstAssets;
    const totalNetDeposits = totalAssetDelta - totalYield;
    const totalNetUsd = totalNetDeposits * underlyingPrice;
    const totalSign = totalNetUsd >= 0 ? "+" : "";

    lines.push(`    ──`);
    lines.push(`    Lifetime net flow: ${totalSign}${formatUsd(Math.abs(totalNetUsd))} ${totalNetUsd >= 0 ? "(net inflows)" : "(net outflows)"}`);
    lines.push(`    Yield accrued: ~${formatUsd(Math.abs(totalYield * underlyingPrice))} (rate ${firstRate.toFixed(6)} → ${lastRate.toFixed(6)})`);
  }

  // Bridge transactions
  const bridgeTxs = mv.bridge?.transactions;
  if (bridgeTxs && bridgeTxs.length > 0) {
    lines.push(``);
    lines.push(`  Bridge Transactions (${bridgeTxs.length}):`);

    // Sort by timestamp descending (most recent first)
    const sorted = [...bridgeTxs].sort((a, b) => b.timestamp - a.timestamp);
    for (const tx of sorted) {
      const date = formatDate(tx.timestamp);
      const src = chainIdToName(tx.srcChainId);
      const dst = chainIdToName(tx.dstChainId);
      const statusLabel = tx.status === "COMPLETED" ? "" : ` [${tx.status}]`;
      lines.push(`    ${date} | ${src} → ${dst} | ${formatUsd(tx.amountUsd)}${statusLabel} | ${tx.hash.slice(0, 10)}...`);
    }

    // Summarize by direction
    const dirMap = new Map<string, { count: number; totalUsd: number }>();
    for (const tx of bridgeTxs) {
      const key = `${chainIdToName(tx.srcChainId)} → ${chainIdToName(tx.dstChainId)}`;
      const entry = dirMap.get(key) || { count: 0, totalUsd: 0 };
      entry.count++;
      entry.totalUsd += tx.amountUsd || 0;
      dirMap.set(key, entry);
    }
    lines.push(`    ──`);
    for (const [dir, { count, totalUsd }] of dirMap) {
      lines.push(`    ${dir}: ${count} txn(s), ${formatUsd(totalUsd)} total`);
    }

    const pending = mv.bridge?.totalPendingUsd || 0;
    if (pending > 0) {
      lines.push(`    Pending: ${formatUsd(pending)}`);
    }
  }

  // Unclaimed Merkl rewards at the vault address
  if (vaultMerklRewards && vaultMerklRewards.length > 0) {
    lines.push(``);
    lines.push(`  Unclaimed Merkl Rewards (at vault address):`);
    for (const r of vaultMerklRewards) {
      lines.push(`    ${r.symbol}: ${r.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })}`);
    }
  }

  // Merkl warnings (non-silent failure)
  if (merklWarnings && merklWarnings.length > 0) {
    for (const w of merklWarnings) {
      lines.push(`  ${w}`);
    }
  }

  return lines.join("\n");
}

/** One-line compact format for MetaVault listings. */
export function formatMetavaultCompact(mv: SpectraMetavault, chain: string): string {
  const apy = formatPct(mv.liveApy?.total || 0);
  const tvlUsd = mv.tvl?.usd || 0;
  const tvl = formatUsd(tvlUsd);
  const posCount = mv.positions?.length || 0;
  const baseApy = mv.liveApy?.details?.base;
  const baseNote = baseApy != null ? ` (base ${formatPct(baseApy)})` : "";
  // Surface idle ratio in compact line — headline TVL alone masks deployment gaps
  let idleNote = "";
  if (mv.positions && mv.positions.length > 0 && tvlUsd > 0) {
    let allocTotal = 0;
    for (const pos of mv.positions) {
      const pool = pos.pools?.[0];
      const rawBalance = pool?.lpt?.balance || pos.balance;
      if (rawBalance && pool?.lpt?.price?.usd) {
        const dec = pool.lpt.decimals || 18;
        const raw = BigInt(rawBalance);
        const d = 10n ** BigInt(dec);
        const lpBalance = Number(raw / d) + Number(raw % d) / Number(d);
        allocTotal += lpBalance * pool.lpt.price.usd;
      }
    }
    const idlePct = ((tvlUsd - allocTotal) / tvlUsd) * 100;
    if (idlePct > 20) idleNote = ` (${idlePct.toFixed(0)}% idle)`;
  }
  return `${mv.metadata?.title || mv.name} (${chain}) | ${mv.underlying?.symbol || "?"} | APY ${apy}${baseNote} | TVL ${tvl}${idleNote} | ${posCount} position(s) | Curator: ${mv.curator?.name || "?"} | ${mv.address}`;
}

/** Concise per-MetaVault format for the spectra_scan_opportunities output section. */
export function formatMetavaultScanEntry(mv: SpectraMetavault, chain: string, rank: number): string {
  const lines: string[] = [];
  const apy = formatPct(mv.liveApy?.total || 0);
  const tvl = formatUsd(mv.tvl?.usd || 0);
  const underlying = mv.underlying?.symbol || "?";
  const curator = mv.curator?.name || "Unknown";
  const activePositions = (mv.positions || []).filter(p => p.maturity * 1000 > Date.now());
  const posCount = activePositions.length;

  // Best LP APY among active positions
  let bestLpApy = 0;
  for (const pos of activePositions) {
    const lpApy = pos.pools?.[0]?.lpApy?.total || 0;
    if (lpApy > bestLpApy) bestLpApy = lpApy;
  }

  // Compute idle ratio for scan entry headline
  const tvlUsdVal = mv.tvl?.usd || 0;
  let scanIdleNote = "";
  if (mv.positions && mv.positions.length > 0 && tvlUsdVal > 0) {
    let scanAllocTotal = 0;
    for (const pos of mv.positions) {
      const pool = pos.pools?.[0];
      const rawBalance = pool?.lpt?.balance || pos.balance;
      if (rawBalance && pool?.lpt?.price?.usd) {
        const dec = pool.lpt.decimals || 18;
        const raw = BigInt(rawBalance);
        const d = 10n ** BigInt(dec);
        const lpBalance = Number(raw / d) + Number(raw % d) / Number(d);
        scanAllocTotal += lpBalance * pool.lpt.price.usd;
      }
    }
    const scanIdlePct = ((tvlUsdVal - scanAllocTotal) / tvlUsdVal) * 100;
    if (scanIdlePct > 20) scanIdleNote = ` (${scanIdlePct.toFixed(0)}% idle)`;
  }

  lines.push(`  MV#${rank}  ${mv.metadata?.title || mv.name} (${mv.symbol}) -- ${chain}`);
  lines.push(`        APY: ${apy} | TVL: ${tvl}${scanIdleNote} | Underlying: ${underlying}`);

  // Surface yield composition — base vs incentive
  const apyDetails = mv.liveApy?.details;
  const baseApy = apyDetails?.base || 0;
  const totalApy = mv.liveApy?.total || 0;
  if (apyDetails && totalApy > 0 && baseApy < totalApy) {
    const incentiveApy = totalApy - baseApy;
    const incentiveTokens = [
      ...Object.keys(apyDetails.ibtRewards || {}),
      ...Object.keys(apyDetails.mvRewards || {}),
    ];
    const tokenList = [...new Set(incentiveTokens)].join(", ");
    lines.push(`        Yield: ${formatPct(baseApy)} base + ${formatPct(incentiveApy)} incentives${tokenList ? ` (${tokenList})` : ""}`);
  }

  lines.push(`        Curator: ${curator} | ${posCount} active position(s)${bestLpApy > 0 ? ` (best LP APY: ${formatPct(bestLpApy)})` : ""}`);
  lines.push(`        Address: ${mv.address}`);
  lines.push(`        \u2192 spectra_model_metavault(chain="${chain}", metavault_address="${mv.address}")`);

  return lines.join("\n");
}

/** Format the MetaVault alternatives section appended to spectra_scan_opportunities output. */
export function formatMetavaultScanSection(
  entries: Array<{ metavault: SpectraMetavault; chain: string }>,
  compact: boolean,
): string {
  if (entries.length === 0) return "";

  const lines: string[] = [];
  lines.push(``);
  lines.push(`== MetaVault Alternatives ==`);
  lines.push(`  MetaVaults are curated vaults with auto-rollover and YT compounding.`);
  lines.push(`  APY is live/variable (not fixed like PT). Curator manages positions.`);
  lines.push(``);

  // Sort by live APY descending
  const sorted = [...entries].sort((a, b) => (b.metavault.liveApy?.total || 0) - (a.metavault.liveApy?.total || 0));

  if (compact) {
    for (let i = 0; i < sorted.length; i++) {
      const { metavault, chain } = sorted[i];
      lines.push(`MV#${i + 1} ${formatMetavaultCompact(metavault, chain)}`);
    }
  } else {
    for (let i = 0; i < sorted.length; i++) {
      const { metavault, chain } = sorted[i];
      lines.push(formatMetavaultScanEntry(metavault, chain, i + 1));
      if (i < sorted.length - 1) lines.push(``);
    }
  }

  return lines.join("\n");
}

/** Format the full spectra_list_metavaults output. */
export function formatMetavaultList(
  entries: Array<{ metavault: SpectraMetavault; chain: string }>,
  chainFilter: string | undefined,
  merklMaps?: Map<number, Map<string, MerklCampaign[]>>,
  merklWarnings?: string[],
): string {
  const lines: string[] = [];

  lines.push(`== MetaVaults${chainFilter ? ` (${chainFilter})` : " (all chains)"} ==`);
  lines.push(`  Found: ${entries.length} MetaVault(s)`);

  if (entries.length === 0) {
    lines.push(``);
    lines.push(`  No MetaVaults found${chainFilter ? ` on ${chainFilter}` : ""}. MetaVaults are curated vaults — they may not exist on all chains yet.`);
    return lines.join("\n");
  }

  lines.push(``);

  for (let i = 0; i < entries.length; i++) {
    const { metavault, chain } = entries[i];
    // Build per-position Merkl lookup from position chain IDs
    let positionMerklMap: Map<string, MerklCampaign[]> | undefined;
    if (merklMaps) {
      positionMerklMap = new Map();
      for (const pos of metavault.positions || []) {
        const pool = pos.pools?.[0];
        const posChainId = pool?.chainId || pos.chainId;
        if (posChainId && pool?.address) {
          const chainMap = merklMaps.get(posChainId);
          if (chainMap) {
            const campaigns = lookupMerklCampaigns(chainMap, [pool.address]);
            if (campaigns.length > 0) {
              positionMerklMap.set(pool.address.toLowerCase(), campaigns);
            }
          }
        }
      }
    }
    lines.push(formatMetavaultSummary(metavault, chain, positionMerklMap, undefined, merklWarnings));
    if (i < entries.length - 1) lines.push(``);
  }

  // Next-step hints
  lines.push(``);
  lines.push(`--- Next Steps ---`);
  lines.push(`  • Model a strategy: spectra_model_metavault(chain=CHAIN, metavault_address=ADDRESS) for live-data-backed modeling`);
  lines.push(`  • Compare yields: spectra_scan_opportunities(capital_usd=AMOUNT) to see MetaVault APYs in context of all opportunities`);
  lines.push(`  • Check looping: spectra_get_looping_strategy(chain=CHAIN, pt_address=PT_ADDRESS) for any MetaVault position's PT`);

  // Curator activity hints — teach the Router mechanic
  const curators = new Map<string, { name: string; address: string }>();
  for (const { metavault } of entries) {
    const addr = metavault.curator?.addresses?.[0];
    if (addr && !curators.has(addr.toLowerCase())) {
      curators.set(addr.toLowerCase(), {
        name: metavault.curator?.name || "Unknown",
        address: addr,
      });
    }
  }
  if (curators.size > 0) {
    lines.push(`  • Curator pool activity (LP adds/removes, rebalancing):`);
    for (const { name, address } of curators.values()) {
      lines.push(`      ${name}: spectra_get_address_activity(address="${address}")`);
    }
    lines.push(`    MetaVault contracts operate via the Spectra Router, so vault/MetaVault`);
    lines.push(`    addresses won't appear in pool activity. The curator EOA is tx.origin.`);
  }

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
  borrowRateIsDefault?: boolean;
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
  // Blended Spectra + Pendle allocation
  pendleAllocationPct?: number;
  pendleLpApy?: number;
  spectraBaseApy?: number;
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
  lines.push(`  Borrow Rate:         ${formatPct(opts.borrowRate)}${opts.borrowRateIsDefault ? " [DEFAULT — not from a live Morpho market]" : ""}`);
  lines.push(`  Pool Cycle:          ${opts.daysToMaturity} days`);
  if (opts.borrowRateIsDefault) {
    lines.push(``);
    lines.push(`  [!] Borrow rate is the default placeholder (${formatPct(opts.borrowRate)}), not sourced from a real Morpho market.`);
    lines.push(`      All leverage projections below are hypothetical. Use morpho_list_markets() to find`);
    lines.push(`      actual borrow rates, then re-run with borrow_rate=ACTUAL_RATE for meaningful projections.`);
  }

  // ── Allocation Model (Spectra + Pendle blend) ──────────────
  if (opts.pendleAllocationPct && opts.pendleAllocationPct > 0 && opts.pendleLpApy !== undefined && opts.spectraBaseApy !== undefined) {
    const spectraPct = 100 - opts.pendleAllocationPct;
    lines.push(``);
    lines.push(`--- Allocation Model ---`);
    lines.push(`  Spectra LP:        ${spectraPct}% allocation | ${formatPct(opts.spectraBaseApy)} base APY`);
    lines.push(`  Pendle LP:         ${opts.pendleAllocationPct}% allocation | ${formatPct(opts.pendleLpApy)} base APY`);
    lines.push(`  Blended Base APY:  ${formatPct(opts.baseApy)}`);
    lines.push(``);
    lines.push(`  Note: Pendle positions require manual rollover at maturity.`);
    lines.push(`  Spectra MetaVault auto-rolls Spectra positions only.`);
    lines.push(`  Operational complexity increases with cross-protocol allocation.`);
  }

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

// =============================================================================
// Curator Dashboard Formatting
// =============================================================================

export interface CuratorDashboardOpts {
  chain: string;
  metavaultAddress: string;
  curatorName: string;
  curatorAddresses: string[];
  vaultName: string;
  vaultSymbol: string;
  underlyingSymbol: string;
  underlyingDecimals: number;
  underlyingPriceUsd: number;

  // Current state
  tvlUsd: number;
  tvlUnderlying: number;
  liveApyTotal: number;
  liveApyBoostedTotal: number | null;
  liveApyBase: number | null;
  apyDetails: SpectraMetavault["liveApy"]["details"] | undefined;
  sharePriceUsd: number;
  sharePriceUnderlying: number;

  // Positions
  positions: Array<{
    symbol: string;
    ptAddress: string;
    poolAddress: string | null;
    maturityTimestamp: number;
    daysToMaturity: number;
    expired: boolean;
    tvlUsd: number;
    vaultAllocationUsd: number | null;
    ptApy: number;
    lpApyTotal: number;
    lpApyBoostedTotal: number | null;
    protocol: "Spectra" | "Pendle" | "Unknown";
  }>;

  // Epoch flow analysis
  epochFlows: Array<{
    fromDate: string;
    toDate: string;
    netDepositsUsd: number;
    yieldAccruedUsd: number;
    tvlAfterUsd: number;
    rateAfter: number;
  }>;
  lifetimeNetFlowUsd: number;
  lifetimeYieldUsd: number;
  firstRate: number;
  lastRate: number;
  epochCount: number;

  // Bridge summary
  bridgeTxCount: number;
  bridgePendingUsd: number;
  bridgeDirections: Array<{ direction: string; count: number; totalUsd: number }>;

  // Health & action items
  actionItems: string[];
  curatorFeePct: number;

  // Revenue estimate
  estimatedAnnualFeeRevenueUsd: number | null;

  // Merkl (optional, best-effort)
  merklByPool?: Map<string, MerklCampaign[]>;
  vaultMerklRewards?: Array<{ symbol: string; amount: number }>;
  merklWarnings?: string[];
}

export function formatCuratorDashboard(opts: CuratorDashboardOpts): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────
  lines.push(`== Curator Dashboard ==`);
  lines.push(`  ${opts.vaultName} (${opts.vaultSymbol})`);
  lines.push(`  Chain: ${opts.chain} | MetaVault: ${opts.metavaultAddress}`);
  lines.push(`  Curator: ${opts.curatorName}${opts.curatorAddresses.length ? ` (${opts.curatorAddresses[0]})` : ""}`);
  lines.push(``);

  // ── Vault Health ────────────────────────────────────────────
  lines.push(`--- Vault Health ---`);
  // Compute idle ratio for headline — agents anchor on TVL, so idle capital must be visible here
  const knownAllocForHeadline = opts.positions
    .filter(p => p.vaultAllocationUsd != null)
    .reduce((sum, p) => sum + p.vaultAllocationUsd!, 0);
  const idleForHeadline = opts.tvlUsd > 0 ? Math.max(0, opts.tvlUsd - knownAllocForHeadline) : 0;
  const idlePctForHeadline = opts.tvlUsd > 0 ? (idleForHeadline / opts.tvlUsd) * 100 : 0;
  const tvlIdleSuffix = idlePctForHeadline > 5
    ? ` — ${idlePctForHeadline.toFixed(0)}% idle (${formatUsd(idleForHeadline)} undeployed)`
    : "";
  lines.push(`  TVL: ${formatUsd(opts.tvlUsd)} (${opts.tvlUnderlying.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${opts.underlyingSymbol})${tvlIdleSuffix}`);
  lines.push(`  Live APY: ${formatPct(opts.liveApyTotal)}${opts.liveApyBoostedTotal && opts.liveApyBoostedTotal > opts.liveApyTotal ? ` (max boost: ${formatPct(opts.liveApyBoostedTotal)})` : ""}`);
  if (opts.liveApyBase != null) {
    const incentiveApy = opts.liveApyTotal - opts.liveApyBase;
    if (incentiveApy > 0) {
      lines.push(`  Yield Mix: ${formatPct(opts.liveApyBase)} base + ${formatPct(incentiveApy)} incentives (${((incentiveApy / opts.liveApyTotal) * 100).toFixed(0)}% incentive-dependent)`);
    }
  }
  lines.push(`  Share Price: ${formatUsd(opts.sharePriceUsd)} (${opts.sharePriceUnderlying.toFixed(6)} underlying)`);
  lines.push(``);

  // ── APY Composition ─────────────────────────────────────────
  if (opts.apyDetails) {
    lines.push(`--- APY Composition ---`);
    if (opts.apyDetails.base != null) {
      lines.push(`  Base (fees + PT convergence + IBT accrual): ${formatPct(opts.apyDetails.base)}`);
    }
    if (opts.apyDetails.ibtRewards) {
      for (const [token, apy] of Object.entries(opts.apyDetails.ibtRewards)) {
        lines.push(`  ${token} (IBT reward): ${formatPct(apy)}`);
      }
    }
    if (opts.apyDetails.mvRewards) {
      for (const [token, apy] of Object.entries(opts.apyDetails.mvRewards)) {
        lines.push(`  ${token} (MetaVault reward): ${formatPct(apy)}`);
      }
    }
    if (opts.apyDetails.boostedRewards) {
      for (const [token, range] of Object.entries(opts.apyDetails.boostedRewards)) {
        if (range.min == null && range.max == null) continue;
        lines.push(`  ${token} Gauge: ${formatPct(range.min ?? 0)} -> ${formatPct(range.max ?? 0)}`);
      }
    }
    lines.push(``);
  }

  // ── Active Positions ────────────────────────────────────────
  // Only show positions with known allocation (skip positions with no balance data)
  const allocated = opts.positions
    .filter(p => p.vaultAllocationUsd != null)
    .sort((a, b) => b.vaultAllocationUsd! - a.vaultAllocationUsd!);
  const posCount = allocated.length;
  lines.push(`--- Pool Allocations (${posCount}) ---`);
  if (posCount === 0) {
    lines.push(`  No active pool allocations.`);
  } else {
    let knownAllocationTotal = 0;
    for (const pos of allocated) {
      knownAllocationTotal += pos.vaultAllocationUsd!;
      const matLabel = pos.expired ? "EXPIRED" : `${pos.daysToMaturity}d`;
      const urgencyFlag = !pos.expired && pos.daysToMaturity <= 14 ? " !!!" : !pos.expired && pos.daysToMaturity <= 30 ? " !!" : "";
      const vaultPct = opts.tvlUsd > 0 ? (pos.vaultAllocationUsd! / opts.tvlUsd * 100).toFixed(1) : "?";
      const allocationStr = `${vaultPct}% | ${formatUsd(pos.vaultAllocationUsd!)}`;
      const protocolTag = `[${pos.protocol}]`;
      lines.push(`  ${protocolTag} ${pos.symbol} | ${matLabel}${urgencyFlag} | ${allocationStr} | PT APY ${formatPct(pos.ptApy)} | LP APY ${formatPct(pos.lpApyTotal)}${pos.lpApyBoostedTotal && pos.lpApyBoostedTotal > pos.lpApyTotal ? ` (boost: ${formatPct(pos.lpApyBoostedTotal)})` : ""}`);
      lines.push(`    PT: ${pos.ptAddress}${pos.poolAddress ? ` | Pool: ${pos.poolAddress}` : ""}`);

      // Merkl campaigns for this position's pool
      if (opts.merklByPool && pos.poolAddress) {
        const campaigns = lookupMerklCampaigns(opts.merklByPool, [pos.poolAddress]);
        if (campaigns.length > 0) {
          const mLines = formatMerklCampaignLines(campaigns, new Set(), "      ");
          for (const ml of mLines) lines.push(ml);
        }
      }
    }

    // Unclaimed Merkl rewards at the vault address
    if (opts.vaultMerklRewards && opts.vaultMerklRewards.length > 0) {
      lines.push(``);
      lines.push(`  Unclaimed Merkl Rewards (at vault address):`);
      for (const r of opts.vaultMerklRewards) {
        lines.push(`    ${r.symbol}: ${r.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })}`);
      }
    }

    // Merkl warnings
    if (opts.merklWarnings && opts.merklWarnings.length > 0) {
      for (const w of opts.merklWarnings) lines.push(`  ${w}`);
    }

    // Idle liquidity: vault TVL minus sum of known position allocations
    if (opts.tvlUsd > 0) {
      const idleLiquidity = Math.max(0, opts.tvlUsd - knownAllocationTotal);
      const idlePct = (idleLiquidity / opts.tvlUsd * 100).toFixed(1);
      if (idleLiquidity > 0) {
        lines.push(`  ${opts.underlyingSymbol} Idle Liquidity | ${idlePct}% | ${formatUsd(idleLiquidity)}`);
      }
      lines.push(`  ──`);
      lines.push(`  Deployed: ${formatUsd(knownAllocationTotal)} (${(knownAllocationTotal / opts.tvlUsd * 100).toFixed(1)}%) | Idle: ${formatUsd(idleLiquidity)} (${idlePct}%) | Total: ${formatUsd(opts.tvlUsd)}`);
    }
  }
  lines.push(``);

  // ── Depositor Flows ─────────────────────────────────────────
  if (opts.epochFlows.length > 0) {
    lines.push(`--- Depositor Flows (${opts.epochCount} epochs) ---`);
    // Show last 5 epoch transitions max to keep it concise
    const recentFlows = opts.epochFlows.slice(-5);
    if (opts.epochFlows.length > 5) {
      lines.push(`  (showing last 5 of ${opts.epochFlows.length} epoch transitions)`);
    }
    for (const flow of recentFlows) {
      const arrow = flow.netDepositsUsd >= 0 ? "IN" : "OUT";
      const sign = flow.netDepositsUsd >= 0 ? "+" : "";
      lines.push(`  ${flow.fromDate} -> ${flow.toDate} | ${arrow} ${sign}${formatUsd(Math.abs(flow.netDepositsUsd))} net | Yield ${formatUsd(flow.yieldAccruedUsd)} | TVL ${formatUsd(flow.tvlAfterUsd)}`);
    }
    lines.push(`  ──`);
    lines.push(`  Lifetime net flow: ${opts.lifetimeNetFlowUsd >= 0 ? "+" : ""}${formatUsd(Math.abs(opts.lifetimeNetFlowUsd))} ${opts.lifetimeNetFlowUsd >= 0 ? "(net inflows)" : "(net outflows)"}`);
    lines.push(`  Lifetime yield: ~${formatUsd(Math.abs(opts.lifetimeYieldUsd))} (rate ${opts.firstRate.toFixed(6)} -> ${opts.lastRate.toFixed(6)})`);

    // Trend signal
    if (recentFlows.length >= 3) {
      const recentNetFlows = recentFlows.map(f => f.netDepositsUsd);
      const positiveCount = recentNetFlows.filter(f => f >= 0).length;
      if (positiveCount >= 3) {
        lines.push(`  Trend: Consistent inflows (${positiveCount}/${recentFlows.length} positive epochs)`);
      } else if (positiveCount === 0) {
        lines.push(`  Trend: Consistent outflows (${recentFlows.length}/${recentFlows.length} negative epochs)`);
      } else {
        lines.push(`  Trend: Mixed flows (${positiveCount}/${recentFlows.length} positive epochs)`);
      }
    }
    lines.push(``);
  }

  // ── Fee Revenue ─────────────────────────────────────────────
  lines.push(`--- Fee Revenue (at current rates) ---`);
  lines.push(`  Curator Fee: ${formatPct(opts.curatorFeePct)} of vault yield`);
  if (opts.estimatedAnnualFeeRevenueUsd != null) {
    lines.push(`  Estimated Annual Fee Revenue: ~${formatUsd(opts.estimatedAnnualFeeRevenueUsd)}/yr (gross, incl. incentives)`);
    lines.push(`    = ${formatPct(opts.curatorFeePct)} x ${formatPct(opts.liveApyTotal)} x ${formatUsd(opts.tvlUsd)} TVL`);
    lines.push(`    Both TVL and APY are variable — this is a snapshot projection.`);
  } else {
    lines.push(`  Fee revenue estimate unavailable (no TVL or APY data).`);
  }
  lines.push(``);

  // ── Bridge Activity ─────────────────────────────────────────
  if (opts.bridgeTxCount > 0) {
    lines.push(`--- Bridge Activity ---`);
    for (const dir of opts.bridgeDirections) {
      lines.push(`  ${dir.direction}: ${dir.count} txn(s), ${formatUsd(dir.totalUsd)} total`);
    }
    if (opts.bridgePendingUsd > 0) {
      lines.push(`  Pending: ${formatUsd(opts.bridgePendingUsd)}`);
    }
    lines.push(``);
  }

  // ── Action Items ────────────────────────────────────────────
  if (opts.actionItems.length > 0) {
    lines.push(`--- Action Items ---`);
    for (const item of opts.actionItems) {
      lines.push(`  ${item}`);
    }
    lines.push(``);
  }

  // ── Next Steps ──────────────────────────────────────────────
  lines.push(`--- Next Steps ---`);
  lines.push(`  - Model leverage: spectra_model_metavault(chain="${opts.chain}", metavault_address="${opts.metavaultAddress}")`);
  if (opts.curatorAddresses.length > 0) {
    lines.push(`  - Curator activity: spectra_get_address_activity(address="${opts.curatorAddresses[0]}")`);
  }
  if (opts.positions.length > 0) {
    const firstPt = opts.positions[0];
    lines.push(`  - Pool activity: spectra_get_pool_activity(chain="${opts.chain}", pool_address="${firstPt.poolAddress || firstPt.ptAddress}")`);
  }
  lines.push(`  - Compare yields: spectra_scan_opportunities(capital_usd=YOUR_AMOUNT) for market context`);
  lines.push(`  - Cross-protocol scan: mv_scan_curator_opportunities(capital_usd=YOUR_AMOUNT) for unified Spectra + Pendle ranking`);

  return lines.join("\n");
}

// =============================================================================
// Pendle Market Formatters
// =============================================================================

/**
 * Helper: convert Pendle expiry string to days remaining.
 */
export function pendleDaysToMaturity(expiry: string): number {
  const expiryMs = new Date(expiry).getTime();
  return Math.max(0, Math.round((expiryMs - Date.now()) / 86_400_000));
}

/**
 * Format a single Pendle market as a compact one-liner.
 */
export function formatPendleMarketCompact(m: PendleMarket, chain: string): string {
  const d = m.details;
  const days = pendleDaysToMaturity(m.expiry);
  const impliedPct = formatPct(d.impliedApy * 100);
  const lpPct = formatPct(d.aggregatedApy * 100);
  const varPct = formatPct(d.underlyingApy * 100);
  const tvl = formatUsd(d.totalTvl);
  const liq = formatUsd(d.liquidity);
  const prime = m.isPrime ? " ★" : "";
  const boostSuffix = d.maxBoostedApy > d.aggregatedApy
    ? ` (Boost ${formatPct(d.maxBoostedApy * 100)})`
    : "";
  return `${m.name} (${chain}) | Impl ${impliedPct} | LP ${lpPct}${boostSuffix} | Var ${varPct} | TVL ${tvl} | Liq ${liq} | ${days}d${prime} | Market: ${m.address}`;
}

/**
 * Format a single Pendle market in full detail.
 */
export function formatPendleMarketSummary(m: PendleMarket, chain: string, merklCampaigns?: MerklCampaign[]): string {
  const d = m.details;
  const days = pendleDaysToMaturity(m.expiry);
  const expiryDate = m.expiry.split("T")[0];
  const lines: string[] = [];

  lines.push(`-- ${m.name} --`);
  const tags: string[] = [];
  if (m.isPrime) tags.push("★ Prime");
  if (m.categoryIds?.length) tags.push(...m.categoryIds);
  if (tags.length > 0) lines.push(`  Tags: ${tags.join(" | ")}`);
  lines.push(`  Chain: ${chain}`);
  lines.push(`  Market Address: ${m.address}`);
  lines.push(`  PT: ${m.pt}`);
  lines.push(`  YT: ${m.yt}`);
  lines.push(`  SY: ${m.sy}`);
  lines.push(`  Underlying Asset: ${m.underlyingAsset}`);
  lines.push(`  Maturity: ${expiryDate} (${days}d)`);

  // Entry path awareness — surface distance from common assets, same as Spectra formatter.
  // Pendle markets use SY tokens (Standardized Yield) which wrap the underlying IBT.
  // The underlying asset name often reveals the entry complexity.
  const pendleEntryPath = inferEntryPath(m.underlyingAsset, undefined, undefined, chain);
  if (pendleEntryPath) {
    lines.push(``);
    lines.push(`  ── Entry Path ──`);
    lines.push(`  ${pendleEntryPath}`);
  }

  lines.push(``);
  lines.push(`  Implied APY (Fixed Rate): ${formatPct(d.impliedApy * 100)}`);
  lines.push(`  Underlying APY (Variable): ${formatPct(d.underlyingApy * 100)}`);
  lines.push(`  Fixed vs Variable Spread: ${formatPct((d.impliedApy - d.underlyingApy) * 100)}`);
  lines.push(``);
  lines.push(`  LP APY: ${formatPct(d.aggregatedApy * 100)}`);
  lines.push(`    +-- Swap Fees: ${formatPct(d.swapFeeApy * 100)}`);
  lines.push(`    +-- PENDLE Incentives: ${formatPct(d.pendleApy * 100)}`);
  if (d.maxBoostedApy > 0) {
    lines.push(`    +-- Max Boosted LP APY: ${formatPct(d.maxBoostedApy * 100)}`);
  }

  // Merkl external incentive campaigns (LP, YT holding, SY campaigns)
  if (merklCampaigns && merklCampaigns.length > 0) {
    const existingTokens = new Set(["PENDLE"]); // PENDLE incentives already shown above
    const merklLines = formatMerklCampaignLines(merklCampaigns, existingTokens);
    for (const ml of merklLines) lines.push(ml);
  }

  lines.push(``);
  lines.push(`  TVL: ${formatUsd(d.totalTvl)}`);
  lines.push(`  Liquidity: ${formatUsd(d.liquidity)}`);
  lines.push(`  24h Volume: ${formatUsd(d.tradingVolume)}`);
  lines.push(`  Fee Rate: ${formatPct(d.feeRate * 100)}`);
  if (d.totalPt > 0 || d.totalSy > 0) {
    lines.push(`  Pool Reserves: ${d.totalPt.toLocaleString("en-US", { maximumFractionDigits: 2 })} PT / ${d.totalSy.toLocaleString("en-US", { maximumFractionDigits: 2 })} SY`);
  }

  lines.push(``);
  lines.push(`  Protocol YT Fee: 5% on all yield + points (docs.pendle.finance/ProtocolMechanics/Mechanisms/Fees)`);

  return lines.join("\n");
}

/**
 * Format a Spectra vs Pendle comparison for markets on the same underlying + maturity.
 */
export function formatPendleSpectraComparison(opts: {
  spectraPt: SpectraPt;
  spectraPool: SpectraPool;
  pendleMarket: PendleMarket;
  chain: string;
}): string {
  const { spectraPt, spectraPool, pendleMarket, chain } = opts;
  const pd = pendleMarket.details;
  const spectraImplied = spectraPool.impliedApy || 0;
  const pendleImplied = pd.impliedApy * 100;
  const spectraLp = spectraPool.lpApy?.total || 0;
  const pendleLp = pd.aggregatedApy * 100;
  const spectraLiq = spectraPool.liquidity?.usd || 0;
  const pendleLiq = pd.liquidity;
  const spectraTvl = spectraPt.tvl?.usd || 0;
  const pendleTvl = pd.totalTvl;
  const spectraDays = daysToMaturity(spectraPt.maturity);
  const pendleDays = pendleDaysToMaturity(pendleMarket.expiry);
  const spectraVar = spectraPt.ibt?.apr?.total || 0;
  const pendleVar = pd.underlyingApy * 100;

  const lines: string[] = [];
  lines.push(`== Spectra vs Pendle: ${spectraPt.underlying?.symbol || spectraPt.name} on ${chain} ==`);
  lines.push(``);

  // Table header
  lines.push(`  Metric                    Spectra             Pendle              Delta`);
  lines.push(`  ${"─".repeat(76)}`);

  const row = (label: string, sVal: string, pVal: string, delta: string) => {
    lines.push(`  ${label.padEnd(26)} ${sVal.padEnd(20)} ${pVal.padEnd(20)} ${delta}`);
  };

  row("Implied APY (Fixed)",  formatPct(spectraImplied), formatPct(pendleImplied), formatPct(spectraImplied - pendleImplied));
  row("Variable Rate",         formatPct(spectraVar),     formatPct(pendleVar),     formatPct(spectraVar - pendleVar));
  row("LP APY",               formatPct(spectraLp),      formatPct(pendleLp),      formatPct(spectraLp - pendleLp));

  // LP APY breakdown
  const spectraFees = spectraPool.lpApy?.details?.fees || 0;
  const pendleFees = pd.swapFeeApy * 100;
  row("  LP: Swap Fees",      formatPct(spectraFees),    formatPct(pendleFees),    formatPct(spectraFees - pendleFees));
  const spectraRewards = Object.values(spectraPool.lpApy?.details?.rewards || {}).reduce((a, b) => a + b, 0)
    + Object.values(spectraPool.lpApy?.details?.boostedRewards || {}).reduce((a, r) => a + (r.min ?? 0), 0);
  const pendleIncentives = pd.pendleApy * 100;
  row("  LP: Incentives",     `${formatPct(spectraRewards)} SPECTRA`, `${formatPct(pendleIncentives)} PENDLE`, formatPct(spectraRewards - pendleIncentives));
  const spectraBoosted = spectraPool.lpApy?.boostedTotal || 0;
  const pendleBoosted = pd.maxBoostedApy * 100;
  if (spectraBoosted > 0 || pendleBoosted > 0) {
    row("  Max Boosted LP",   formatPct(spectraBoosted), formatPct(pendleBoosted), formatPct(spectraBoosted - pendleBoosted));
  }

  row("Liquidity",      formatUsd(spectraLiq),     formatUsd(pendleLiq),     formatUsd(spectraLiq - pendleLiq));
  row("TVL",                  formatUsd(spectraTvl),     formatUsd(pendleTvl),     formatUsd(spectraTvl - pendleTvl));
  row("Days to Maturity",     `${spectraDays}d`,         `${pendleDays}d`,         `${spectraDays - pendleDays}d`);

  lines.push(``);

  // Per-metric comparison with context
  const insights: string[] = [];
  const impliedDelta = Math.abs(spectraImplied - pendleImplied);
  if (impliedDelta > 0.5) {
    const higher = spectraImplied > pendleImplied ? "Spectra" : "Pendle";
    const lower = higher === "Spectra" ? "Pendle" : "Spectra";
    insights.push(`${higher} offers a higher fixed rate (+${formatPct(impliedDelta)})`);
    // When rate disagrees significantly AND liquidity also disagrees, flag the tension
    const liqRatio = Math.max(spectraLiq, pendleLiq) / (Math.min(spectraLiq, pendleLiq) || 1);
    const deeperLiqProtocol = spectraLiq > pendleLiq ? "Spectra" : "Pendle";
    if (liqRatio > 3 && deeperLiqProtocol === lower) {
      insights.push(`  ^ but ${lower} has ${formatPct((liqRatio - 1) * 100 / liqRatio)} more liquidity — the deeper`);
      insights.push(`    pool's lower rate may reflect more informed price discovery, not worse yield`);
    }
  } else if (impliedDelta <= 0.5) {
    if (spectraImplied > pendleImplied) {
      insights.push(`Spectra offers a higher fixed rate (+${formatPct(impliedDelta)})`);
    } else if (pendleImplied > spectraImplied) {
      insights.push(`Pendle offers a higher fixed rate (+${formatPct(impliedDelta)})`);
    }
  }

  if (spectraLp > pendleLp) {
    insights.push(`Spectra LP APY is higher (+${formatPct(spectraLp - pendleLp)}) — more attractive for MetaVault allocation`);
  } else if (pendleLp > spectraLp) {
    insights.push(`Pendle LP APY is higher (+${formatPct(pendleLp - spectraLp)}) — consider integrating this Pendle pool into a MetaVault`);
  }

  if (spectraLiq > pendleLiq) {
    insights.push(`Spectra has deeper pool liquidity (${formatUsd(spectraLiq)} vs ${formatUsd(pendleLiq)})`);
  } else if (pendleLiq > spectraLiq) {
    insights.push(`Pendle has deeper pool liquidity (${formatUsd(pendleLiq)} vs ${formatUsd(spectraLiq)})`);
  }

  if (insights.length > 0) {
    lines.push(`  Insights:`);
    for (const insight of insights) {
      lines.push(`    • ${insight}`);
    }
  }

  lines.push(``);
  lines.push(`  Spectra PT: ${spectraPt.address}`);
  lines.push(`  Pendle Market: ${pendleMarket.address}`);

  return lines.join("\n");
}

// =============================================================================
// Cross-Protocol Maturity Matching
// =============================================================================

/**
 * Normalize underlying asset symbols for cross-protocol matching.
 * Conservative: only normalizes known equivalences. Unknown symbols pass through unchanged.
 */
export function normalizeUnderlyingSymbol(symbol: string): string {
  const upper = symbol.toUpperCase().trim();
  // Wrapped → unwrapped equivalences
  if (upper === "WETH" || upper === "WETHE" || upper === "WETH.E") return "ETH";
  if (upper === "WBTC" || upper === "WBTC.E") return "BTC";
  // Bridged stablecoin variants
  if (upper === "USDC.E" || upper === "USDCE" || upper === "USDC.B") return "USDC";
  if (upper === "USDT.E" || upper === "USDTE") return "USDT";
  // Liquid staking equivalences
  if (upper === "WSTETH") return "STETH";
  // DAI → USDS rebrand
  if (upper === "SDAI" || upper === "SUSDS") return "USDS";
  return upper;
}

/**
 * Match Spectra pools with Pendle markets by normalized underlying + maturity proximity.
 * Returns matched pairs (with match quality) plus unmatched items from each side.
 *
 * Match quality thresholds:
 *   - "exact":  ≤7 day maturity gap
 *   - "close":  ≤30 day maturity gap
 *   - "loose":  ≤tolerance day maturity gap
 *   - "unmatched": no counterpart found
 */
export function matchByAssetAndMaturity(
  spectraPools: Array<{ pt: SpectraPt; pool: SpectraPool; chain: string }>,
  pendleMarkets: Array<{ market: PendleMarket; chain: string }>,
  toleranceDays: number = 90,
): CrossProtocolMatch[] {
  // Group by normalized underlying
  const spectraByAsset = new Map<string, Array<{ pt: SpectraPt; pool: SpectraPool; chain: string; maturityTs: number }>>();
  for (const sp of spectraPools) {
    const sym = normalizeUnderlyingSymbol(sp.pt.underlying?.symbol || sp.pt.name || "");
    if (!sym) continue;
    if (!spectraByAsset.has(sym)) spectraByAsset.set(sym, []);
    spectraByAsset.get(sym)!.push({ ...sp, maturityTs: sp.pt.maturity });
  }

  const pendleByAsset = new Map<string, Array<{ market: PendleMarket; chain: string; maturityTs: number }>>();
  for (const pm of pendleMarkets) {
    // Extract underlying from Pendle market name: try common patterns
    const nameParts = pm.market.name.split(/\s+/);
    // Pendle names typically include the underlying (e.g., "PT stETH 26JUN2025", "PT USDC 26JUN2025")
    // Try each name part for symbol matching
    let bestSym = "";
    for (const part of nameParts) {
      const cleaned = part.replace(/^PT[-_]?/i, "").replace(/[-_]/g, "");
      if (cleaned.length >= 2 && cleaned.length <= 12 && !/^\d+[A-Z]{3}\d{4}$/.test(cleaned)) {
        const norm = normalizeUnderlyingSymbol(cleaned);
        if (norm.length >= 2) { bestSym = norm; break; }
      }
    }
    // Fallback: try the whole name for broad asset class matching
    if (!bestSym) {
      const nameUpper = pm.market.name.toUpperCase();
      if (nameUpper.includes("USD")) bestSym = "USD_CLASS";
      else if (nameUpper.includes("ETH")) bestSym = "ETH_CLASS";
      else if (nameUpper.includes("BTC")) bestSym = "BTC_CLASS";
    }
    if (!bestSym) continue;

    if (!pendleByAsset.has(bestSym)) pendleByAsset.set(bestSym, []);
    const expiryMs = new Date(pm.market.expiry).getTime();
    pendleByAsset.get(bestSym)!.push({ ...pm, maturityTs: Math.floor(expiryMs / 1000) });
  }

  const results: CrossProtocolMatch[] = [];
  const matchedSpectraKeys = new Set<string>();
  const matchedPendleKeys = new Set<string>();

  // For each asset group, find nearest-maturity matches
  for (const [sym, spectraItems] of spectraByAsset) {
    // Find Pendle items with same normalized symbol or matching asset class
    let pendleItems = pendleByAsset.get(sym);
    if (!pendleItems) {
      // Try asset class fallback
      if (sym === "USDC" || sym === "USDT" || sym === "USDS" || sym === "DAI" || sym === "GHO") {
        pendleItems = pendleByAsset.get("USD_CLASS");
      } else if (sym === "ETH" || sym === "STETH") {
        pendleItems = pendleByAsset.get("ETH_CLASS");
      } else if (sym === "BTC") {
        pendleItems = pendleByAsset.get("BTC_CLASS");
      }
    }
    if (!pendleItems) continue;

    for (const sp of spectraItems) {
      const spKey = `${sp.chain}:${sp.pt.address}`;
      if (matchedSpectraKeys.has(spKey)) continue;

      // Find closest unmatched Pendle market by maturity
      let bestMatch: typeof pendleItems[0] | null = null;
      let bestGap = Infinity;

      for (const pm of pendleItems) {
        const pmKey = `${pm.chain}:${pm.market.address}`;
        if (matchedPendleKeys.has(pmKey)) continue;
        const gapDays = Math.abs(sp.maturityTs - pm.maturityTs) / 86400;
        if (gapDays < bestGap && gapDays <= toleranceDays) {
          bestGap = gapDays;
          bestMatch = pm;
        }
      }

      if (bestMatch) {
        const pmKey = `${bestMatch.chain}:${bestMatch.market.address}`;
        matchedSpectraKeys.add(spKey);
        matchedPendleKeys.add(pmKey);

        const quality: CrossProtocolMatch["matchQuality"] =
          bestGap <= 7 ? "exact" : bestGap <= 30 ? "close" : "loose";

        results.push({
          spectra: { pt: sp.pt, pool: sp.pool, chain: sp.chain },
          pendle: { market: bestMatch.market, chain: bestMatch.chain },
          underlying: sym,
          maturityGapDays: Math.round(bestGap),
          matchQuality: quality,
        });
      }
    }
  }

  // Add unmatched Spectra pools
  for (const sp of spectraPools) {
    const spKey = `${sp.chain}:${sp.pt.address}`;
    if (matchedSpectraKeys.has(spKey)) continue;
    results.push({
      spectra: { pt: sp.pt, pool: sp.pool, chain: sp.chain },
      pendle: null,
      underlying: normalizeUnderlyingSymbol(sp.pt.underlying?.symbol || "?"),
      maturityGapDays: 0,
      matchQuality: "unmatched",
    });
  }

  // Add unmatched Pendle markets
  for (const pm of pendleMarkets) {
    const pmKey = `${pm.chain}:${pm.market.address}`;
    if (matchedPendleKeys.has(pmKey)) continue;
    results.push({
      spectra: null,
      pendle: { market: pm.market, chain: pm.chain },
      underlying: pm.market.name,
      maturityGapDays: 0,
      matchQuality: "unmatched",
    });
  }

  return results;
}

// =============================================================================
// Curator Opportunity Formatters
// =============================================================================

/** One-liner for compact curator scan output — shows all strategy building blocks. */
export function formatCuratorOpportunityCompact(opp: CuratorOpportunity, rank: number): string {
  const proto = opp.protocol === "spectra" ? "[S]" : "[P]";
  const parts: string[] = [];
  parts.push(`PT ${formatPct(opp.effectiveApy)}`);
  parts.push(`LP ${formatPct(opp.lpApy)}`);
  if (opp.looping) {
    parts.push(`Loop ${formatPct(opp.looping.optimalEffectiveNetApy)}@${opp.looping.optimalLoops}x`);
  }
  if (opp.mvGrossEstimatePct != null) {
    parts.push(`MV~${formatPct(opp.mvGrossEstimatePct)}`);
  }
  if (opp.morpho) {
    if (opp.morpho.marketExists) {
      parts.push(`Mkt: ${formatUsd(opp.morpho.availableLiquidityUsd || 0)}/${formatPct(opp.morpho.supplyApyPct || 0)}/${Math.round((opp.morpho.utilization || 0) * 100)}%`);
    } else if (opp.morpho.hypotheticalLoopNetApy != null) {
      parts.push(`No Mkt (→Loop ~${formatPct(opp.morpho.hypotheticalLoopNetApy)}@${opp.morpho.hypotheticalLoops}x, BE ${formatPct(opp.morpho.hypotheticalBreakEvenBorrow || 0)})`);
    } else {
      parts.push(`No Mkt`);
    }
  }
  if (opp.funding) {
    const sign = opp.funding.annualizedPct >= 0 ? "-" : "+";
    parts.push(`${opp.funding.perpSymbol} ${sign}${formatPct(Math.abs(opp.funding.annualizedPct))}/yr`);
  }
  const matchTag = opp.matchedWith
    ? ` ↔ ${opp.matchedWith.protocol === "spectra" ? "[S]" : "[P]"} ${formatPct(opp.matchedWith.impliedApy)} (${opp.matchedWith.matchQuality})`
    : "";
  const warnTag = opp.warnings.length > 0 ? ` ⚠${opp.warnings.length}` : "";
  return `  #${rank} ${proto} ${opp.name} | ${opp.chain} | ${parts.join(" | ")} | TVL ${formatUsd(opp.tvlUsd)} | ${opp.daysToMaturity}d${matchTag}${warnTag}`;
}

/** Full detail for a single curator opportunity — shows Strategy Space building blocks. */
export function formatCuratorOpportunity(opp: CuratorOpportunity, rank: number): string {
  const proto = opp.protocol === "spectra" ? "Spectra" : "Pendle";
  const lines: string[] = [];

  lines.push(`  #${rank} [${proto}] ${opp.name} — ${opp.chain}`);
  lines.push(`    Underlying: ${opp.underlying} | Maturity: ${new Date(opp.maturityTimestamp * 1000).toISOString().slice(0, 10)} (${opp.daysToMaturity}d)`);
  lines.push(`    PT TVL: ${formatUsd(opp.tvlUsd)} | Liquidity: ${formatUsd(opp.poolLiquidityUsd)} | Entry Impact: ${formatPct(opp.entryImpactPct)} | Capacity: ${formatUsd(opp.capacityUsd)}`);

  // Strategy Space — all building blocks, no single "best" collapsed
  lines.push(``);
  lines.push(`    Strategy Space:`);
  lines.push(`      PT spot:  ≥${formatPct(opp.effectiveApy)} effective (${formatPct(opp.impliedApy)} implied - ${formatPct(opp.entryImpactPct > 0 && opp.daysToMaturity > 0 ? opp.entryImpactPct * (365 / opp.daysToMaturity) : opp.entryImpactPct)} entry, conservative)`);

  // LP line with breakdown if available
  if (opp.lpApyBreakdown) {
    const bd = opp.lpApyBreakdown;
    const parts: string[] = [];
    if (bd.fees) parts.push(`fees ${formatPct(bd.fees)}`);
    if (bd.pt) parts.push(`PT convergence ${formatPct(bd.pt)}`);
    if (bd.ibt) parts.push(`IBT accrual ${formatPct(bd.ibt)}`);
    for (const [k, v] of Object.entries(bd.rewards)) parts.push(`${k} ${formatPct(v)}`);
    lines.push(`      LP:       ${formatPct(opp.lpApy)}${parts.length > 0 ? ` (${parts.join(" + ")})` : ""}`);
  } else {
    lines.push(`      LP:       ${formatPct(opp.lpApy)}`);
  }

  // Merkl external campaigns
  if (opp.merklCampaigns && opp.merklCampaigns.length > 0) {
    const existingTokens = new Set<string>();
    if (opp.lpApyBreakdown) {
      for (const token of Object.keys(opp.lpApyBreakdown.rewards)) existingTokens.add(token.toUpperCase());
    }
    const merklLines = formatMerklCampaignLines(opp.merklCampaigns, existingTokens, "        ");
    for (const ml of merklLines) lines.push(ml);
  }

  if (opp.looping) {
    lines.push(`      PT loop:  ${formatPct(opp.looping.optimalEffectiveNetApy)} net @ ${opp.looping.optimalLoops}x (LLTV ${formatPct((opp.looping.lltv || 0) * 100)}, borrow ${formatPct(opp.looping.borrowRatePct)})`);
  }

  if (opp.mvGrossEstimatePct != null) {
    const ytFeeLabel = opp.protocol === "pendle" ? "5%" : "3%";
    lines.push(`      MV est:   ~${formatPct(opp.mvGrossEstimatePct)} gross (LP + 30% variable APR, net of ${ytFeeLabel} YT fee)`);
  }

  lines.push(`      Variable: ${formatPct(opp.variableApr)} APR`);

  // Combined LP + Loop hint: when both LP and looping are viable, curators can split
  // their mint output — LP some PT in the pool, loop remaining PT via Morpho, keep YT.
  if (opp.looping && opp.lpApy > 5 && opp.lpApy > opp.looping.optimalEffectiveNetApy * 0.5) {
    lines.push(`      Combined: Mint PT+YT → LP a portion (${formatPct(opp.lpApy)}) + loop remaining PT (${formatPct(opp.looping.optimalEffectiveNetApy)} net). Split by Morpho depth (${formatUsd(opp.morpho?.availableLiquidityUsd || 0)}).`);
  }

  // Entry path — surface distance from common assets for curator opportunity
  // CuratorOpportunity has `underlying` but not ibtSymbol/baseIbt, so we infer
  // from the name (which contains the IBT symbol for most pools)
  const curatorEntryPath = inferEntryPath(opp.underlying, undefined, undefined, opp.chain);
  if (curatorEntryPath) {
    lines.push(`    ${curatorEntryPath}`);
  }

  // Morpho Market section
  lines.push(``);
  if (opp.morpho) {
    if (opp.morpho.marketExists) {
      lines.push(`    Morpho Market:`);
      lines.push(`      Available: ${formatUsd(opp.morpho.availableLiquidityUsd || 0)} | Supply APY: ${formatPct(opp.morpho.supplyApyPct || 0)} | Util: ${Math.round((opp.morpho.utilization || 0) * 100)}%`);
      if (opp.morpho.breakEvenBorrowRate != null) {
        lines.push(`      Break-even borrow: ${formatPct(opp.morpho.breakEvenBorrowRate)}`);
      }
      if (opp.morpho.marketKey) {
        lines.push(`      Key: ${opp.morpho.marketKey.slice(0, 10)}...`);
      }
    } else {
      lines.push(`    Morpho Market: none — creation opportunity`);
      if (opp.morpho.hypotheticalLoopNetApy != null && opp.morpho.hypotheticalLoops) {
        lines.push(`      If created (LLTV ${Math.round((opp.morpho.hypotheticalLltv || 0.86) * 100)}%, ~${formatPct(opp.morpho.hypotheticalBorrowRate || 3)} borrow): Loop ~${formatPct(opp.morpho.hypotheticalLoopNetApy)} net @${opp.morpho.hypotheticalLoops}x`);
        if (opp.morpho.hypotheticalBreakEvenBorrow != null) {
          lines.push(`      Break-even borrow: ${formatPct(opp.morpho.hypotheticalBreakEvenBorrow)} — room for supply-side revenue`);
        }
      }
    }
  }

  // Delta-neutral hedge (Hyperliquid funding)
  if (opp.funding) {
    const fundingDir = opp.funding.annualizedPct >= 0 ? "pay" : "receive";
    const fundingAbs = Math.abs(opp.funding.annualizedPct);
    lines.push(``);
    lines.push(`    Hedge (${opp.funding.perpSymbol} perp):`);
    lines.push(`      Funding: ${fundingDir} ${formatPct(fundingAbs)}/yr | Short to delta-neutralize`);
    if (opp.funding.deltaNeutralCostBudget != null) {
      lines.push(`      DN cost budget: ${formatPct(opp.funding.deltaNeutralCostBudget)} (break-even ${opp.funding.annualizedPct >= 0 ? "minus" : "plus"} funding)`);
    }
  }

  // Cross-protocol match
  if (opp.matchedWith) {
    const mProto = opp.matchedWith.protocol === "spectra" ? "Spectra" : "Pendle";
    lines.push(`    ↔ Matched with [${mProto}] ${opp.matchedWith.name}: Impl ${formatPct(opp.matchedWith.impliedApy)} | LP ${formatPct(opp.matchedWith.lpApy)} | ${opp.matchedWith.matchQuality} match (${opp.matchedWith.maturityGapDays}d gap)`);
  }

  // Full loop curve — agents need the shape to reason about leverage risk
  if (opp.looping && opp.looping.lltv && opp.looping.lltv > 0) {
    const loopLines: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const lev = cumulativeLeverageAtLoop(i, opp.looping.lltv);
      const borrowed = lev - 1;
      const grossApy = lev * opp.impliedApy;
      const borrowCost = borrowed * opp.looping.borrowRatePct;
      const netApy = grossApy - borrowCost;
      loopLines.push(`${i}L: ${lev.toFixed(2)}x, ${formatPct(netApy)} net`);
    }
    lines.push(`    Loop Curve: ${loopLines.join(" | ")}`);
  }

  // Addresses
  if (opp.ptAddress) lines.push(`    PT: ${opp.ptAddress}`);
  if (opp.poolAddress) lines.push(`    Pool: ${opp.poolAddress}`);
  if (opp.pendleMarketAddress) lines.push(`    Pendle Market: ${opp.pendleMarketAddress}`);
  if (opp.pendleSyAddress) lines.push(`    SY: ${opp.pendleSyAddress} (use for mv_check_ibt_health)`);

  // Warnings
  if (opp.warnings.length > 0) {
    lines.push(`    ⚠ ${opp.warnings.join(" | ")}`);
  }

  return lines.join("\n");
}

/** Full output for mv_scan_curator_opportunities results. */
export function formatCuratorScanResults(
  opps: CuratorOpportunity[],
  capitalUsd: number,
  maxImpactPct: number,
  assetFilter: string | undefined,
  failedChains: string[],
  compact: boolean,
  totalBeforeTruncation?: number,
): string {
  const lines: string[] = [];
  lines.push(`== Curator Opportunity Scan: ${formatUsd(capitalUsd)} capital ==`);
  lines.push(`  Scope: Spectra + Pendle (cross-protocol)`);
  if (assetFilter) lines.push(`  Asset: ${assetFilter}`);

  const spectraCount = opps.filter(o => o.protocol === "spectra").length;
  const pendleCount = opps.filter(o => o.protocol === "pendle").length;
  const truncNote = totalBeforeTruncation != null && totalBeforeTruncation > opps.length
    ? ` (showing top ${opps.length} of ${totalBeforeTruncation})`
    : "";
  lines.push(`  Results: ${opps.length} (${spectraCount} Spectra, ${pendleCount} Pendle)${truncNote} | Max Impact: ${formatPct(maxImpactPct)}`);
  if (failedChains.length > 0) lines.push(`  Failed chains: ${failedChains.join(", ")}`);
  lines.push(``);

  if (compact) {
    for (let i = 0; i < opps.length; i++) {
      lines.push(formatCuratorOpportunityCompact(opps[i], i + 1));
    }
  } else {
    for (let i = 0; i < opps.length; i++) {
      lines.push(formatCuratorOpportunity(opps[i], i + 1));
      if (i < opps.length - 1) lines.push(``);
    }
  }

  // Maturity Pipelines — group by expiry windows for rollover planning
  if (opps.length > 1) {
    const near = opps.map((o, i) => ({ o, rank: i + 1 })).filter(x => x.o.daysToMaturity <= 30);
    const mid = opps.map((o, i) => ({ o, rank: i + 1 })).filter(x => x.o.daysToMaturity > 30 && x.o.daysToMaturity <= 90);
    const far = opps.map((o, i) => ({ o, rank: i + 1 })).filter(x => x.o.daysToMaturity > 90);

    lines.push(``);
    lines.push(`--- Maturity Pipelines ---`);
    if (near.length > 0) lines.push(`  <30d:   ${near.map(x => `#${x.rank} ${x.o.name} (${x.o.daysToMaturity}d)`).join(", ")}`);
    if (mid.length > 0) lines.push(`  30-90d: ${mid.map(x => `#${x.rank} ${x.o.name} (${x.o.daysToMaturity}d)`).join(", ")}`);
    if (far.length > 0) lines.push(`  >90d:   ${far.map(x => `#${x.rank} ${x.o.name} (${x.o.daysToMaturity}d)`).join(", ")}`);
  }

  // Next steps
  lines.push(``);
  lines.push(`--- Next Steps ---`);
  const topSpectra = opps.find(o => o.protocol === "spectra");
  const topPendle = opps.find(o => o.protocol === "pendle");
  if (topSpectra) {
    lines.push(`  • Drill into top Spectra: spectra_get_looping_strategy(chain="${topSpectra.chain}", pt_address="${topSpectra.ptAddress}")`);
    lines.push(`  • Quote entry: spectra_quote_trade(chain="${topSpectra.chain}", pt_address="${topSpectra.ptAddress}", amount=${capitalUsd}, side="buy")`);
  }
  if (topPendle) {
    lines.push(`  • Pendle detail: pendle_list_markets(chain="${topPendle.chain}", asset_filter="${topPendle.underlying}")`);
  }
  if (topSpectra && topPendle) {
    lines.push(`  • Head-to-head: mv_compare_yield(chain="${topSpectra.chain}", asset_filter="${topSpectra.underlying}")`);
  }
  lines.push(`  • MetaVault modeling: spectra_model_metavault(chain=CHAIN, metavault_address=ADDR) for blended allocation`);
  lines.push(`  • Curator dashboard: spectra_get_curator_dashboard(chain=CHAIN, metavault_address=ADDR) for operational overview`);

  lines.push(``);
  lines.push(`--- Protocol Legend ---`);
  lines.push(`  [S] = Spectra (Curve AMM, SPECTRA gauge, Morpho looping on mainnet/base/arbitrum/katana)`);
  lines.push(`  [P] = Pendle (Pendle AMM, PENDLE incentives, Morpho looping on mainnet/base/arbitrum)`);
  lines.push(`  ↔ = Cross-protocol match on same underlying + similar maturity`);

  lines.push(``);
  lines.push(`--- Impact Accuracy ---`);
  lines.push(`  ⚠ Effective APY is a CONSERVATIVE LOWER BOUND.`);
  lines.push(`  Spectra: constant-product estimate. Curve StableSwap-NG is more efficient — real APY typically 30-60% higher.`);
  if (pendleCount > 0) {
    lines.push(`  Pendle: logit AMM model (scalarRoot=50, conservative). Real impact likely lower.`);
  }
  lines.push(`  → Verify: spectra_quote_trade(chain, pt_address, amount, "buy") for exact on-chain Curve quotes.`);
  lines.push(`  Curators: You control pool depth. Entry impact is a design choice, not a given constraint.`);

  return lines.join("\n");
}

// =============================================================================
// Curator Risk Monitor Formatter
// =============================================================================

function riskIcon(level: RiskAlertLevel): string {
  switch (level) {
    case "critical": return "[!!!]";
    case "warning":  return "[!!]";
    case "watch":    return "[!]";
    default:         return "";
  }
}

function formatPositionAlert(p: LiquidationAlert, idx: number): string[] {
  const lines: string[] = [];
  const icon = riskIcon(p.alertLevel);
  const tag = p.isSpectraPt ? "[Spectra PT] " : "";
  const loopTag = p.isLooper ? "[Looper] " : "";

  lines.push(`  Position ${idx + 1}: ${tag}${loopTag}${p.collateralSymbol} / ${p.debtSymbol} ${icon}`);
  lines.push(`    Collateral: ${formatUsd(p.collateralUsd)}  |  Debt: ${formatUsd(p.debtUsd)}`);
  lines.push(`    LLTV: ${formatPct(p.lltv * 100)}  |  Health Factor: ${p.healthFactor === Infinity ? "∞ (no debt)" : p.healthFactor.toFixed(3)}`);

  if (p.currentPrice > 0 && p.liquidationPrice > 0) {
    lines.push(`    Collateral Price: ${formatUsd(p.currentPrice)}  →  Liquidation at: ${formatUsd(p.liquidationPrice)}`);
    lines.push(`    Distance to Liquidation: ${p.distanceToLiquidationPct.toFixed(1)}%`);
  }

  if (p.currentBorrowRate > 0) {
    lines.push(`    Borrow Rate: ${formatPct(p.currentBorrowRate)}`);
  }

  if (p.isFullLiquidation) {
    lines.push(`    Morpho: No close factor — FULL position liquidatable at health = 1.0`);
  }

  lines.push(`    Market: ${p.marketKey.slice(0, 10)}...  |  Chain: ${p.chain}`);

  if (p.alertReasons.length > 0) {
    for (const reason of p.alertReasons) {
      lines.push(`    ${icon} ${reason}`);
    }
  }

  return lines;
}

export function formatCuratorRiskSummary(summary: CuratorRiskSummary): string {
  const lines: string[] = [];
  const scope = summary.chain || "all Morpho chains";

  lines.push(`== Curator Risk Monitor: ${summary.address.slice(0, 6)}...${summary.address.slice(-4)} ==`);
  lines.push(`  Scope: ${scope}  |  Alert threshold: ${summary.alertThresholdPct}%`);
  lines.push(`  Borrowing Positions: ${summary.borrowingPositions}`);
  lines.push(`  Total Collateral: ${formatUsd(summary.totalCollateralUsd)}  |  Total Debt: ${formatUsd(summary.totalDebtUsd)}`);

  if (summary.worstHealthFactor != null && summary.worstHealthFactor !== Infinity) {
    lines.push(`  Worst Health Factor: ${summary.worstHealthFactor.toFixed(3)}`);
  }

  // Risk distribution
  const { critical, warning, watch, ok } = summary.positionsByLevel;
  const distParts: string[] = [];
  if (critical > 0) distParts.push(`${critical} critical`);
  if (warning > 0) distParts.push(`${warning} warning`);
  if (watch > 0) distParts.push(`${watch} watch`);
  if (ok > 0) distParts.push(`${ok} ok`);
  lines.push(`  Risk Distribution: ${distParts.join(" | ")}`);

  if (!summary.ratesAvailable) {
    lines.push(`  ⚠ Borrow Rates: UNAVAILABLE — Morpho rate API was unreachable. Borrow rate fields default to 0% and should not be trusted.`);
  }

  lines.push(``);

  // Sort: critical first, then warning, watch, ok
  const levelOrder: Record<RiskAlertLevel, number> = { critical: 0, warning: 1, watch: 2, ok: 3 };
  const sorted = [...summary.positions].sort((a, b) => levelOrder[a.alertLevel] - levelOrder[b.alertLevel]);

  for (let i = 0; i < sorted.length; i++) {
    lines.push(...formatPositionAlert(sorted[i], i));
    if (i < sorted.length - 1) lines.push(``);
  }

  // Alerts section — aggregated action items (scaffolding, not directives)
  const alertPositions = sorted.filter((p) => p.alertLevel !== "ok");
  if (alertPositions.length > 0) {
    lines.push(``);
    lines.push(`--- Alerts ---`);
    for (const p of alertPositions) {
      const icon = riskIcon(p.alertLevel);
      for (const reason of p.alertReasons) {
        lines.push(`  ${icon} ${p.collateralSymbol}/${p.debtSymbol}: ${reason}`);
      }
    }

    lines.push(``);
    lines.push(`--- Considerations (not directives) ---`);
    if (critical > 0) {
      lines.push(`  - Critical positions may warrant immediate deleverage — but check if the collateral is approaching maturity (PT redeems at par)`);
    }
    if (warning > 0 || watch > 0) {
      lines.push(`  - Elevated positions could indicate normal operation at high leverage, or genuine risk — context matters`);
    }
    lines.push(`  - Morpho Pre-Liquidation (opt-in Auto-Deleverage) reduces cliff risk for positions near threshold`);
    lines.push(`  - Use morpho_get_history to assess whether current borrow rates are a spike or a trend`);
  } else {
    lines.push(``);
    lines.push(`  All positions within safe parameters.`);
  }

  // Observation boundary — what the risk monitor cannot see
  lines.push(``);
  lines.push(`--- Observation Boundary ---`);
  lines.push(`  Health factor and distance-to-liquidation use Morpho's oracle price.`);
  lines.push(`  This price may diverge from executable exit price under stress:`);
  lines.push(`  - PT collateral: oracle tracks par trajectory, but pool liquidity determines`);
  lines.push(`    actual exit price. A PT with 25% distance-to-liquidation but $10K pool`);
  lines.push(`    liquidity cannot be exited at oracle price for large positions.`);
  lines.push(`  - MetaVault share collateral: no secondary market may exist — the oracle`);
  lines.push(`    reflects NAV, but redemptions take an epoch and may face withdrawal queues.`);
  lines.push(`  - Multiple positions using the same collateral create cascade risk that`);
  lines.push(`    individual health factors do not capture.`);
  if (ok > 0 && critical === 0 && warning === 0 && watch === 0) {
    lines.push(`  All positions show "ok" — but "ok" measures oracle-derived health, not`);
    lines.push(`  the collateral's real-world liquidatability.`);
  }

  lines.push(``);
  lines.push(`--- Next Steps ---`);
  lines.push(`  • Rate history: morpho_get_history(chain, market_key) — assess borrow rate stability`);
  lines.push(`  • Position details: morpho_get_positions(address) — full supply/vault/borrow view`);
  lines.push(`  • Deleverage modeling: spectra_get_looping_strategy(chain, pt_address) — sensitivity at different leverage`);
  lines.push(`  • Collateral depth: spectra_get_pool_capacity(chain, pt_address) — verify exit liquidity at position size`);
  lines.push(`  • MetaVault status: spectra_get_curator_dashboard(chain, metavault_address) — operational overview`);

  return lines.join("\n");
}
