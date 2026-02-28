/**
 * Data formatting helpers — USD, percentages, dates, balances, pool/position/Morpho summaries.
 */

import type { SpectraPt, SpectraPool, SpectraMetavault, SpectraMetavaultPosition, MorphoMarket, PendleMarket, PositionResult, TradeQuote, PositionSnapshot, ScanOpportunity, YtArbitrageOpportunity, MetavaultLoopRow, MetavaultCuratorEconomics, SpectraMetavaultBridgeTx, MerklTokenReward } from "./types.js";
import { SUPPORTED_CHAINS } from "./config.js";

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
  return `${pt.name} (${chain}) | APY ${apy} | TVL ${tvl} | Liq ${liq} | ${days}d${lpApy} | PT: ${pt.address} | Pool: ${pool.address || "?"}${ibtAddr}${tags}${points}`;
}

/** One-line scan opportunity summary for compact output. */
export function formatScanOpportunityCompact(opp: ScanOpportunity, rank: number): string {
  const loopTag = opp.looping
    ? ` | Loop ${formatPct(opp.looping.optimalEffectiveNetApy)} @${opp.looping.optimalLoops}x`
    : "";
  const points = opp.pt.multipliers && opp.pt.multipliers.length > 0
    ? ` | Points: ${opp.pt.multipliers.map(m => `${m.name} ${m.amount}x`).join(", ")}`
    : "";
  return `#${rank} ${opp.pt.name} (${opp.chain}) | Eff ${formatPct(opp.effectiveApy)} | Impl ${formatPct(opp.impliedApy)} | Impact ${formatPct(opp.entryImpactPct)} | ${opp.daysToMaturity}d${loopTag} | PT: ${opp.ptAddress} | Pool: ${opp.poolAddress}${points}`;
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
    `  PT Price: ${formatUsd(pool.ptPrice?.usd || 0)}${pool.ptPrice?.underlying != null ? ` (${pool.ptPrice.underlying.toFixed(6)} underlying)` : ""}`,
    `  YT Price: ${formatUsd(pool.ytPrice?.usd || 0)}`,
    `  YT Leverage: ${(pool.ytLeverage || 0).toFixed(1)}x`,
    `  Pool Liquidity: ${formatUsd(pool.liquidity?.usd || 0)}`,
  ];

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
    `    +-- Fees: ${formatPct(pool.lpApy?.details?.fees || 0)}`,
    `    +-- PT: ${formatPct(pool.lpApy?.details?.pt || 0)}`,
    `    +-- IBT: ${formatPct(pool.lpApy?.details?.ibt || 0)}`,
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
      lines.push(`    +-- ${token} Gauge: ${formatPct(range.min)} -> ${formatPct(range.max)} (with veSPECTRA boost)`);
    }
  }

  // Boosted total (max boost APY)
  if (pool.lpApy?.boostedTotal && pool.lpApy.boostedTotal > (pool.lpApy?.total || 0)) {
    lines.push(`  LP APY (Max Boost): ${formatPct(pool.lpApy.boostedTotal)}`);
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
        lines.push(`    Gauge boost range: LP APY ${formatPct(lpApy)} (min) → ${formatPct(lpApyBoostedTotal)} (max 2.5x). Actual boost unknown — use get_ve_info to determine.`);
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
    // Navigational hint: surface the temporal blind spot
    if (totalValue > 100) {
      lines.push(`    Entry timing and cost basis unknown from portfolio alone. Use get_pool_activity with address parameter to reconstruct.`);
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
  MINT_PT_YT: "Mint PT+YT",
  REDEEM_PT: "Redeem PT",
  YIELD_CLAIMED: "Yield Claimed",
};

export function formatActivityType(type: string): string {
  return ACTIVITY_TYPES[type] || type;
}

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
  entries: Array<{ type: string; valueUsd: number }>,
): ActivityCycleResult | null {
  if (entries.length < 6) return null; // need at least 3 repetitions of a 2-action cycle

  const types = entries.map(e => e.type);
  let bestResult: ActivityCycleResult | null = null;

  // Try cycle lengths 2 through 5
  for (let cycleLen = 2; cycleLen <= Math.min(5, Math.floor(types.length / 3)); cycleLen++) {
    // Try each possible starting offset (0 to cycleLen-1)
    for (let offset = 0; offset < cycleLen && offset < types.length - cycleLen; offset++) {
      const candidate = types.slice(offset, offset + cycleLen);

      // Count how many times this exact sequence appears consecutively from this offset
      let matchCount = 0;
      let totalVal = 0;
      let pos = offset;
      while (pos + cycleLen <= types.length) {
        const slice = types.slice(pos, pos + cycleLen);
        if (slice.every((t, i) => t === candidate[i])) {
          matchCount++;
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
        };
      }
    }
  }

  return bestResult;
}

/**
 * Format cycle detection results as output lines for get_pool_activity.
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
    lines.push(`    → These branches predict different future behavior. Use get_portfolio to check actual holdings before selecting one.`);
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
    lines.push(`      B) Capital recycled elsewhere: funds moved to another pool, chain, or protocol. Check get_address_activity for multi-pool patterns.`);
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
  /** Whether on-chain data was consulted (get_onchain_activity) */
  onchainConsulted?: boolean;
  /** Whether cross-chain data was consulted (get_address_activity) */
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
 * Returns lines to append to get_pool_volume output.
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
    lines.push(`    Pool liquidity unavailable -- use get_pt_details to get liquidity context.`);
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
 * and typical PT yields worth looping? Appended per-market in get_morpho_markets.
 *
 * Dissolution condition: When scan_opportunities becomes the default entry
 * point for all looping decisions (i.e., agents never call get_morpho_markets
 * directly for strategy), these hints are redundant and should be removed.
 */
export function formatMorphoMarketHints(m: MorphoMarket): string[] {
  const lines: string[] = [];
  const s = m.state;
  if (!s) return lines;

  const borrowApy = (s.borrowApy || 0) * 100;
  const utilization = (s.utilization || 0) * 100;
  const availableLiq = s.liquidityAssetsUsd || 0;

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
    lines.push(`  Hint: Borrow rate ${formatPct(borrowApy)} is high. Looping is only profitable when PT implied APY exceeds this. Verify spread with get_looping_strategy.`);
  } else if (borrowApy < 3) {
    lines.push(`  Hint: Borrow rate ${formatPct(borrowApy)} is low -- could indicate a favorable looping environment if PT APY is above this.`);
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
  }

  // --- Negative signals (valuable even for single positions) ---

  // Morpho looping availability
  const positionsWithMorphoData = positions.filter(p => p.morphoAvailable !== undefined);
  if (positionsWithMorphoData.length > 0) {
    const withMorpho = positionsWithMorphoData.filter(p => p.morphoAvailable === true);
    const withoutMorpho = positionsWithMorphoData.filter(p => p.morphoAvailable === false);

    if (withMorpho.length > 0) {
      const names = withMorpho.map(p => p.name).join(", ");
      lines.push(`    Morpho markets exist for: ${names}. No looping detected in portfolio — could indicate risk-averse strategy or uninvestigated opportunity. Use get_looping_strategy to evaluate.`);
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
    lines.push(`    ${lpPositions.length} LP position(s) detected. If gauge-boosted, veSPECTRA affects effective yield — use get_ve_info to check boost status.`);
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
    ? `${formatPct(opp.impliedApy)} base -> ~${formatPct(opp.looping.optimalEffectiveNetApy)} effective with ${opp.looping.optimalLoops}x loop (at current rates)`
    : `${formatPct(opp.impliedApy)} base -> ~${formatPct(opp.effectiveApy)} effective (at current rates)`;
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

  // Strategy tension: present competing interpretations (generative friction)
  // Dissolution condition: Dissolves when agents reliably surface competing
  // strategies without explicit prompting.
  if (opp.variableApr > 0 && opp.looping) {
    const ytExposure = opp.variableApr * (opp.pool.ytLeverage || 1);
    if (ytExposure > opp.looping.optimalEffectiveNetApy * 0.7) {
      lines.push(`    Strategy Tension: YT accumulation at ${(opp.pool.ytLeverage || 0).toFixed(1)}x leverage could yield ~${formatPct(ytExposure)} if variable rates persist -- which competes with the looping fixed ~${formatPct(opp.looping.optimalEffectiveNetApy)}. The right choice depends on rate direction conviction.`);
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
  lines.push(`  Rankings reflect one dimension of a multi-dimensional space. A lower-ranked pool could be better`);
  lines.push(`  for a different strategy (YT accumulation, LP farming) or time horizon. See Yield Dimensions per opportunity.`);

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

export function formatMetavaultSummary(mv: SpectraMetavault, chain: string): string {
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

  // TVL & APY
  const decimals = mv.underlying?.decimals || 6;
  lines.push(`  TVL: ${formatUsd(mv.tvl?.usd || 0)} (${(mv.tvl?.underlying || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${mv.underlying?.symbol || "tokens"})`);
  lines.push(`  Live APY: ${formatPct(mv.liveApy?.total || 0)}`);

  // APY breakdown — surface composition so agents can reason about yield sources
  const apyDetails = mv.liveApy?.details;
  if (apyDetails) {
    if (apyDetails.base != null) {
      lines.push(`    +-- Base (fees + PT + IBT): ${formatPct(apyDetails.base)}`);
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
        lines.push(`    +-- ${token} Gauge: ${formatPct(range.min)} -> ${formatPct(range.max)} (with veSPECTRA boost)`);
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
        if (lpDetails.pt) parts.push(`PT ${formatPct(lpDetails.pt)}`);
        if (lpDetails.ibt) parts.push(`IBT ${formatPct(lpDetails.ibt)}`);
        if (lpDetails.rewards) {
          for (const [token, apy] of Object.entries(lpDetails.rewards)) {
            parts.push(`${token} ${formatPct(apy)}`);
          }
        }
        if (lpDetails.boostedRewards) {
          for (const [token, range] of Object.entries(lpDetails.boostedRewards)) {
            parts.push(`${token} gauge ${formatPct(range.min)}-${formatPct(range.max)}`);
          }
        }
        if (parts.length > 0) {
          lines.push(`      LP: ${parts.join(" + ")}`);
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
      const prevRate = Number(prev.rate) / 1e6;
      const currRate = Number(curr.rate) / 1e6;

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

    // Summary: total net flow
    const firstAssets = Number(sorted[0].assets) / divisor;
    const lastAssets = Number(sorted[sorted.length - 1].assets) / divisor;
    const firstRate = Number(sorted[0].rate) / 1e6;
    const lastRate = Number(sorted[sorted.length - 1].rate) / 1e6;
    const totalYield = firstAssets * (lastRate - firstRate) / firstRate;
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

  return lines.join("\n");
}

/** One-line compact format for MetaVault listings. */
export function formatMetavaultCompact(mv: SpectraMetavault, chain: string): string {
  const apy = formatPct(mv.liveApy?.total || 0);
  const tvl = formatUsd(mv.tvl?.usd || 0);
  const posCount = mv.positions?.length || 0;
  const baseApy = mv.liveApy?.details?.base;
  const baseNote = baseApy != null ? ` (base ${formatPct(baseApy)})` : "";
  return `${mv.metadata?.title || mv.name} (${chain}) | ${mv.underlying?.symbol || "?"} | APY ${apy}${baseNote} | TVL ${tvl} | ${posCount} position(s) | Curator: ${mv.curator?.name || "?"} | ${mv.address}`;
}

/** Concise per-MetaVault format for the scan_opportunities output section. */
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

  lines.push(`  MV#${rank}  ${mv.metadata?.title || mv.name} (${mv.symbol}) -- ${chain}`);
  lines.push(`        APY: ${apy} | TVL: ${tvl} | Underlying: ${underlying}`);

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
  lines.push(`        \u2192 model_metavault_strategy(chain="${chain}", metavault_address="${mv.address}")`);

  return lines.join("\n");
}

/** Format the MetaVault alternatives section appended to scan_opportunities output. */
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

/** Format the full get_metavaults output. */
export function formatMetavaultList(
  entries: Array<{ metavault: SpectraMetavault; chain: string }>,
  chainFilter: string | undefined,
  failedChains: string[],
): string {
  const lines: string[] = [];

  lines.push(`== MetaVaults${chainFilter ? ` (${chainFilter})` : " (all chains)"} ==`);
  lines.push(`  Found: ${entries.length} MetaVault(s)`);

  if (failedChains.length > 0) {
    lines.push(`  Note: ${failedChains.length} chain(s) failed (${failedChains.join(", ")}). Results may be partial.`);
  }

  if (entries.length === 0) {
    lines.push(``);
    lines.push(`  No MetaVaults found${chainFilter ? ` on ${chainFilter}` : ""}. MetaVaults are curated vaults — they may not exist on all chains yet.`);
    return lines.join("\n");
  }

  lines.push(``);

  for (let i = 0; i < entries.length; i++) {
    const { metavault, chain } = entries[i];
    lines.push(formatMetavaultSummary(metavault, chain));
    if (i < entries.length - 1) lines.push(``);
  }

  // Next-step hints
  lines.push(``);
  lines.push(`--- Next Steps ---`);
  lines.push(`  • Model a strategy: model_metavault_strategy(chain=CHAIN, metavault_address=ADDRESS) for live-data-backed modeling`);
  lines.push(`  • Compare yields: scan_opportunities(capital_usd=AMOUNT) to see MetaVault APYs in context of all opportunities`);
  lines.push(`  • Check looping: get_looping_strategy(chain=CHAIN, pt_address=PT_ADDRESS) for any MetaVault position's PT`);

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
      lines.push(`      ${name}: get_address_activity(address="${address}")`);
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
  lines.push(`  TVL: ${formatUsd(opts.tvlUsd)} (${opts.tvlUnderlying.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${opts.underlyingSymbol})`);
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
      lines.push(`  Base (fees + PT + IBT): ${formatPct(opts.apyDetails.base)}`);
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
        lines.push(`  ${token} Gauge: ${formatPct(range.min)} -> ${formatPct(range.max)}`);
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
      lines.push(`  ${pos.symbol} | ${matLabel}${urgencyFlag} | ${allocationStr} | PT APY ${formatPct(pos.ptApy)} | LP APY ${formatPct(pos.lpApyTotal)}${pos.lpApyBoostedTotal && pos.lpApyBoostedTotal > pos.lpApyTotal ? ` (boost: ${formatPct(pos.lpApyBoostedTotal)})` : ""}`);
      lines.push(`    PT: ${pos.ptAddress}${pos.poolAddress ? ` | Pool: ${pos.poolAddress}` : ""}`);
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
    lines.push(`  Estimated Annual Fee Revenue: ~${formatUsd(opts.estimatedAnnualFeeRevenueUsd)}/yr`);
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
  lines.push(`  - Model leverage: model_metavault_strategy(chain="${opts.chain}", metavault_address="${opts.metavaultAddress}")`);
  if (opts.curatorAddresses.length > 0) {
    lines.push(`  - Curator activity: get_address_activity(address="${opts.curatorAddresses[0]}")`);
  }
  if (opts.positions.length > 0) {
    const firstPt = opts.positions[0];
    lines.push(`  - Pool activity: get_pool_activity(chain="${opts.chain}", pool_address="${firstPt.poolAddress || firstPt.ptAddress}")`);
  }
  lines.push(`  - Compare yields: scan_opportunities(capital_usd=YOUR_AMOUNT) for market context`);

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
  const tvl = formatUsd(d.totalTvl);
  const liq = formatUsd(d.liquidity);
  return `${m.name} (${chain}) | Impl ${impliedPct} | LP ${lpPct} | TVL ${tvl} | Liq ${liq} | ${days}d | Market: ${m.address}`;
}

/**
 * Format a single Pendle market in full detail.
 */
export function formatPendleMarketSummary(m: PendleMarket, chain: string): string {
  const d = m.details;
  const days = pendleDaysToMaturity(m.expiry);
  const expiryDate = m.expiry.split("T")[0];
  const lines: string[] = [];

  lines.push(`-- ${m.name} --`);
  lines.push(`  Chain: ${chain}`);
  lines.push(`  Market Address: ${m.address}`);
  lines.push(`  PT: ${m.pt}`);
  lines.push(`  YT: ${m.yt}`);
  lines.push(`  SY: ${m.sy}`);
  lines.push(`  Maturity: ${expiryDate} (${days}d)`);
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
  lines.push(``);
  lines.push(`  TVL: ${formatUsd(d.totalTvl)}`);
  lines.push(`  Pool Liquidity: ${formatUsd(d.liquidity)}`);
  lines.push(`  24h Volume: ${formatUsd(d.tradingVolume)}`);
  lines.push(`  Fee Rate: ${formatPct(d.feeRate * 100)}`);

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
  row("Variable APY",         formatPct(spectraVar),     formatPct(pendleVar),     formatPct(spectraVar - pendleVar));
  row("LP APY",               formatPct(spectraLp),      formatPct(pendleLp),      formatPct(spectraLp - pendleLp));
  row("Pool Liquidity",       formatUsd(spectraLiq),     formatUsd(pendleLiq),     formatUsd(spectraLiq - pendleLiq));
  row("TVL",                  formatUsd(spectraTvl),     formatUsd(pendleTvl),     formatUsd(spectraTvl - pendleTvl));
  row("Days to Maturity",     `${spectraDays}d`,         `${pendleDays}d`,         `${spectraDays - pendleDays}d`);

  lines.push(``);

  // Winner per metric
  const insights: string[] = [];
  if (spectraImplied > pendleImplied) {
    insights.push(`Spectra offers a higher fixed rate (+${formatPct(spectraImplied - pendleImplied)})`);
  } else if (pendleImplied > spectraImplied) {
    insights.push(`Pendle offers a higher fixed rate (+${formatPct(pendleImplied - spectraImplied)})`);
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
