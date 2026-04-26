/**
 * Tool: mv_get_curator_portfolio
 *
 * Aggregates multiple MetaVaults managed by a single curator into one
 * portfolio view. Supports discovery by curator address (scans all chains),
 * label (resolves to all EOAs sharing a curator name across chains), or
 * explicit vault list.
 *
 * Output: total AUM, blended APY, projected fee revenue, concentration
 * by underlying and chain, per-underlying rollup (when ≥2 underlyings),
 * per-vault summaries, and GENUINE cross-vault items computed by
 * aggregation (NOT per-vault concatenation).
 *
 * Theme F refactor (2026-04-26): the previous "Action Items (cross-vault)"
 * section was per-vault iteration with vault-name suffixes — falsified label.
 * Replaced with `computeCrossVaultItems`, which fires only when the same
 * underlying clusters across ≥2 vaults (capacity-contention signal) or when
 * idle aggregates above a threshold across vaults sharing an underlying.
 * Silent on clean: emits nothing when no genuine cross-vault signal exists.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EVM_ADDRESS, CHAIN_ENUM } from "../config.js";
import { scanAllMetavaults, fetchMetavaults } from "../api.js";
import type {
  SpectraMetavault,
  SpectraMetavaultPosition,
  CuratorVaultSummary,
  CuratorPortfolioSummary,
} from "../types.js";
import { formatPct, formatUsd, daysToMaturity } from "../formatters.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a condensed summary for a single MetaVault. */
function summarizeVault(mv: SpectraMetavault, chain: string): CuratorVaultSummary {
  const tvlUsd = mv.tvl?.usd || 0;
  const liveApyTotal = mv.liveApy?.total || 0;
  const liveApyBase = mv.liveApy?.details?.base ?? null;
  const underlyingSymbol = mv.underlying?.symbol || "?";
  const positions = mv.positions || [];

  // ── Action items for this vault ──
  const actionItems: string[] = [];

  // Idle capital detection
  let knownAllocTotal = 0;
  for (const pos of positions) {
    const pool = pos.pools?.[0];
    const rawBalance = pool?.lpt?.balance || pos.balance;
    if (rawBalance && pool?.lpt?.price?.usd) {
      const decimals = pool.lpt.decimals || 18;
      const raw = BigInt(rawBalance);
      const divisor = 10n ** BigInt(decimals);
      const lpBalance = Number(raw / divisor) + Number(raw % divisor) / Number(divisor);
      knownAllocTotal += lpBalance * pool.lpt.price.usd;
    }
  }
  // Subtract external positions (avant burns, pendle LP) from unallocated
  // math so external capital isn't mislabeled idle.
  const externalUsd = (mv.externalPositions || []).reduce((s, e) => s + (e.valueUsd || 0), 0);
  const idleLiquidityUsd = tvlUsd > 0 ? Math.max(0, tvlUsd - knownAllocTotal - externalUsd) : 0;
  const idlePct = tvlUsd > 0 ? (idleLiquidityUsd / tvlUsd) * 100 : 0;
  if (idlePct > 20 && idleLiquidityUsd > 1000) {
    const suffix = externalUsd > 0
      ? ` (alongside ${formatUsd(externalUsd)} in external positions)`
      : "";
    actionItems.push(`[UNALLOC] ${idlePct.toFixed(0)}% unallocated (${formatUsd(idleLiquidityUsd)})${suffix}`);
  }

  // Expiring / expired positions
  for (const pos of positions) {
    const matDays = daysToMaturity(pos.maturity);
    const expired = pos.maturity * 1000 <= Date.now();
    if (expired) {
      actionItems.push(`[EXPIRED] ${pos.symbol} has matured`);
    } else if (matDays <= 7) {
      actionItems.push(`[URGENT] ${pos.symbol} expires in ${matDays}d`);
    } else if (matDays <= 14) {
      actionItems.push(`[SOON] ${pos.symbol} expires in ${matDays}d`);
    } else if (matDays <= 30) {
      actionItems.push(`[UPCOMING] ${pos.symbol} expires in ${matDays}d`);
    }
  }

  // No positions — only flag truly idle (no external deployment either)
  if (positions.length === 0 && externalUsd === 0) {
    actionItems.push(`[WARNING] No active positions`);
  }

  return {
    chain,
    name: mv.metadata?.title || mv.name,
    symbol: mv.symbol,
    address: mv.address,
    underlyingSymbol,
    tvlUsd,
    liveApyTotal,
    liveApyBase,
    idlePct: tvlUsd > 0 ? idlePct : null,
    positionCount: positions.length,
    actionItems,
  };
}

/**
 * Vault input bundle for cross-vault analysis. We need richer per-vault state
 * than `CuratorVaultSummary` carries (positions + idle USD), so we pass the
 * raw `SpectraMetavault` paired with the summary alongside.
 */
export interface CrossVaultInput {
  summary: CuratorVaultSummary;
  positions: SpectraMetavaultPosition[];
  idleUsd: number;
}

/**
 * ISO week key for a unix timestamp (seconds). Returns YYYY-Www anchored to
 * the Monday of that week, so two PTs maturing on different weekdays inside
 * the same week cluster correctly.
 */
export function isoWeekKey(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  // Anchor to Monday: shift by (dayOfWeek - 1), where Sunday = 0 → -6
  const dow = d.getUTCDay();
  const shift = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + shift));
  const yyyy = monday.getUTCFullYear();
  const mm = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(monday.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Compute GENUINE cross-vault items by aggregating across vaults (not by
 * iterating per-vault and prefixing names). Two cheap-wins:
 *
 *   a) Per-underlying expiry clustering: ≥2 distinct vaults share an
 *      underlying-week pair within the next 30d → capacity-contention signal.
 *   b) Per-underlying idle aggregation: ≥2 vaults share an underlying AND
 *      total idle across them ≥ $250K AND ≥ 5% of summed TVL → redeployment
 *      candidate.
 *
 * Returns empty array on clean curators (no genuine cross-vault signal).
 * Pure function — exported for unit testing.
 *
 * THRESHOLD CALIBRATION + DISSOLUTION (Diverger Round-7 audit-driven addition):
 *
 * - **CLUSTER 30-day horizon**: tuned to fire on the named near-term
 *   consumer — Gami's gamisUSDC May 14-15 Avant cliff (3 PT-avUSD positions
 *   share underlying-week with infraVault redemptions). Dissolution: if no
 *   `[CLUSTER]` fires across 90 days of curator-portfolio runs against
 *   real curator state, narrow to 14d horizon (May-cliff use case will
 *   still hit). If it fires on every call, widen the >=2 threshold.
 *
 * - **IDLE-CONCENTRATION $250K AND ≥5%**: tuned for current curator AUM
 *   scale ($1-5M typical vault). At 10x scale ($50M+), $250K is noise; at
 *   0.1x scale (<$500K), 5% is noise. The AND-conjunction prevents
 *   false-positive on tiny-but-percent-heavy idle (UltraUSDC's $1 vault)
 *   AND on large-but-percent-light idle (a $10M vault with $300K idle
 *   would pass if it were OR but shouldn't fire — that's normal cash
 *   buffer). Dissolution: if no `[IDLE-CONCENTRATION]` fires across 90
 *   days against real curator state, lower the dollar floor to $100K OR
 *   convert AND→OR; if curators report it fires when they've intentionally
 *   parked dry-powder for a launch, reframe as informational not prescriptive.
 *
 * - **General philosophy**: thresholds are tuned for TODAY's curator
 *   landscape. Re-verify quarterly. The framework's value isn't in the
 *   numeric defaults — it's in the cross-vault aggregation discipline that
 *   replaces the falsely-labeled per-vault concatenation that shipped before.
 */
export function computeCrossVaultItems(inputs: CrossVaultInput[]): string[] {
  const items: string[] = [];
  if (inputs.length < 2) return items;

  // ── (a) Expiry clustering: underlying + week → vaults ──
  const clusterMap = new Map<string, { underlying: string; weekStart: string; vaults: Set<string> }>();
  const nowSec = Date.now() / 1000;
  const horizonSec = nowSec + 30 * 86400;
  for (const inp of inputs) {
    const u = inp.summary.underlyingSymbol;
    for (const pos of inp.positions) {
      if (pos.maturity <= nowSec || pos.maturity > horizonSec) continue;
      const week = isoWeekKey(pos.maturity);
      const key = `${u}|${week}`;
      let entry = clusterMap.get(key);
      if (!entry) {
        entry = { underlying: u, weekStart: week, vaults: new Set() };
        clusterMap.set(key, entry);
      }
      entry.vaults.add(inp.summary.name);
    }
  }
  // Fire only when ≥2 distinct vaults share the underlying-week pair
  const clusters = Array.from(clusterMap.values()).filter((c) => c.vaults.size >= 2);
  // Sort by week ascending so soonest-contention surfaces first
  clusters.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  for (const c of clusters) {
    const names = Array.from(c.vaults).sort().join(", ");
    items.push(
      `[CLUSTER] ${c.vaults.size} ${c.underlying} vaults expire in week of ${c.weekStart} — rollover capacity contention (${names})`,
    );
  }

  // ── (b) Idle aggregation per-underlying ──
  const idleMap = new Map<string, { idleUsd: number; tvlUsd: number; vaults: string[] }>();
  for (const inp of inputs) {
    const u = inp.summary.underlyingSymbol;
    let entry = idleMap.get(u);
    if (!entry) {
      entry = { idleUsd: 0, tvlUsd: 0, vaults: [] };
      idleMap.set(u, entry);
    }
    entry.idleUsd += inp.idleUsd;
    entry.tvlUsd += inp.summary.tvlUsd;
    entry.vaults.push(inp.summary.name);
  }
  // Fire only when ≥2 vaults share an underlying AND idle is non-trivial
  // (≥ $250K AND ≥ 5% of summed TVL of those vaults).
  const IDLE_USD_FLOOR = 250_000;
  const IDLE_PCT_FLOOR = 5;
  const idleEntries = Array.from(idleMap.entries()).filter(
    ([, v]) =>
      v.vaults.length >= 2 &&
      v.idleUsd >= IDLE_USD_FLOOR &&
      v.tvlUsd > 0 &&
      (v.idleUsd / v.tvlUsd) * 100 >= IDLE_PCT_FLOOR,
  );
  // Sort by idle USD descending — biggest redeployment opportunity first
  idleEntries.sort(([, a], [, b]) => b.idleUsd - a.idleUsd);
  for (const [u, v] of idleEntries) {
    const names = v.vaults.slice().sort().join(", ");
    items.push(
      `[IDLE-CONCENTRATION] ${formatUsd(v.idleUsd)} ${u} idle across ${v.vaults.length} vaults — redeployment candidates (${names})`,
    );
  }

  return items;
}

/**
 * Per-underlying rollup: total exposure, total idle, expiry calendar (next
 * 30d grouped by week). Returns one block per underlying that has ≥2 vaults.
 * Pure function — exported for unit testing.
 */
export interface PerUnderlyingRollupRow {
  underlying: string;
  vaultCount: number;
  totalExposureUsd: number;
  totalIdleUsd: number;
  /** Calendar: week-start (YYYY-MM-DD) → vault-name list maturing that week. */
  expiryCalendar: Array<{ weekStart: string; vaults: string[]; symbols: string[] }>;
}

export function computePerUnderlyingRollup(
  inputs: CrossVaultInput[],
): PerUnderlyingRollupRow[] {
  const byUnderlying = new Map<string, CrossVaultInput[]>();
  for (const inp of inputs) {
    const u = inp.summary.underlyingSymbol;
    const arr = byUnderlying.get(u) || [];
    arr.push(inp);
    byUnderlying.set(u, arr);
  }
  const rows: PerUnderlyingRollupRow[] = [];
  const nowSec = Date.now() / 1000;
  const horizonSec = nowSec + 30 * 86400;
  for (const [underlying, group] of byUnderlying.entries()) {
    if (group.length < 2) continue;
    const totalExposureUsd = group.reduce((s, x) => s + x.summary.tvlUsd, 0);
    const totalIdleUsd = group.reduce((s, x) => s + x.idleUsd, 0);
    // Build calendar: week → {vault names, symbols}
    const weekMap = new Map<string, { vaults: Set<string>; symbols: Set<string> }>();
    for (const inp of group) {
      for (const pos of inp.positions) {
        if (pos.maturity <= nowSec || pos.maturity > horizonSec) continue;
        const week = isoWeekKey(pos.maturity);
        let entry = weekMap.get(week);
        if (!entry) {
          entry = { vaults: new Set(), symbols: new Set() };
          weekMap.set(week, entry);
        }
        entry.vaults.add(inp.summary.name);
        entry.symbols.add(pos.symbol);
      }
    }
    const expiryCalendar = Array.from(weekMap.entries())
      .map(([weekStart, e]) => ({
        weekStart,
        vaults: Array.from(e.vaults).sort(),
        symbols: Array.from(e.symbols).sort(),
      }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    rows.push({
      underlying,
      vaultCount: group.length,
      totalExposureUsd,
      totalIdleUsd,
      expiryCalendar,
    });
  }
  // Largest exposure first
  rows.sort((a, b) => b.totalExposureUsd - a.totalExposureUsd);
  return rows;
}

/** Result of curator-label resolution. */
export interface CuratorLabelResolution {
  /** Distinct curator EOAs (lowercased) found across chains for this label. */
  addresses: string[];
  /** Original-case curator name(s) that matched (case-insensitive). */
  matchedNames: string[];
  /** All available labels in the curator universe (for error messaging). */
  allLabels: string[];
}

/**
 * Resolve a curator label (e.g. "Gami Labs") to the union of curator EOAs
 * across chains. Case-insensitive on the label. Pure function over the
 * scanned MV list — exported for unit testing.
 */
export function resolveCuratorLabel(
  metavaults: Array<{ metavault: SpectraMetavault; chain: string }>,
  label: string,
): CuratorLabelResolution {
  const target = label.trim().toLowerCase();
  const addrSet = new Set<string>();
  const nameSet = new Set<string>();
  const allLabelsSet = new Set<string>();
  for (const { metavault } of metavaults) {
    const name = metavault.curator?.name;
    if (!name) continue;
    allLabelsSet.add(name);
    if (name.trim().toLowerCase() === target) {
      nameSet.add(name);
      for (const a of metavault.curator?.addresses || []) {
        addrSet.add(a.toLowerCase());
      }
    }
  }
  return {
    addresses: Array.from(addrSet).sort(),
    matchedNames: Array.from(nameSet).sort(),
    allLabels: Array.from(allLabelsSet).sort(),
  };
}

/** Build aggregate portfolio from vault summaries. */
function buildPortfolio(
  vaults: CuratorVaultSummary[],
  curatorAddress: string | null,
  curatorFeePct: number,
  crossVaultItems: string[],
): CuratorPortfolioSummary {
  const totalAumUsd = vaults.reduce((s, v) => s + v.tvlUsd, 0);
  const totalPositions = vaults.reduce((s, v) => s + v.positionCount, 0);

  // TVL-weighted blended APY
  let blendedApyPct = 0;
  if (totalAumUsd > 0) {
    for (const v of vaults) {
      blendedApyPct += v.liveApyTotal * (v.tvlUsd / totalAumUsd);
    }
  }

  // Projected annual fee revenue
  const projectedAnnualFeeRevenueUsd = totalAumUsd * (blendedApyPct / 100) * (curatorFeePct / 100);

  // Concentration by underlying
  const underlyingTotals: Record<string, number> = {};
  for (const v of vaults) {
    const sym = v.underlyingSymbol || "?";
    underlyingTotals[sym] = (underlyingTotals[sym] || 0) + v.tvlUsd;
  }
  const concentrationByUnderlying: Record<string, number> = {};
  for (const [sym, total] of Object.entries(underlyingTotals)) {
    concentrationByUnderlying[sym] = totalAumUsd > 0 ? (total / totalAumUsd) * 100 : 0;
  }

  // Concentration by chain
  const chainTotals: Record<string, number> = {};
  for (const v of vaults) {
    chainTotals[v.chain] = (chainTotals[v.chain] || 0) + v.tvlUsd;
  }
  const concentrationByChain: Record<string, number> = {};
  for (const [ch, total] of Object.entries(chainTotals)) {
    concentrationByChain[ch] = totalAumUsd > 0 ? (total / totalAumUsd) * 100 : 0;
  }

  return {
    curatorAddress,
    totalAumUsd,
    blendedApyPct,
    projectedAnnualFeeRevenueUsd,
    curatorFeePct,
    concentrationByUnderlying,
    concentrationByChain,
    vaultCount: vaults.length,
    totalPositions,
    actionItems: crossVaultItems,
    vaults,
  };
}

// ── Inline formatter ─────────────────────────────────────────────────────

function formatCompactUsd(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return formatUsd(val);
}

function formatConcentration(map: Record<string, number>): string {
  const sorted = Object.entries(map)
    .sort(([, a], [, b]) => b - a);
  return sorted.map(([k, v]) => `${k} ${v.toFixed(0)}%`).join(" | ");
}

/**
 * Render the per-underlying rollup section. Pure function — exported for
 * unit testing. Returns empty array when `rows` is empty (single-underlying
 * curator case → caller should suppress the section header too).
 */
export function formatPerUnderlyingRollup(rows: PerUnderlyingRollupRow[]): string[] {
  if (rows.length === 0) return [];
  const lines: string[] = [];
  lines.push(`  Per-Underlying Rollup:`);
  for (const r of rows) {
    const idleNote =
      r.totalIdleUsd > 0
        ? ` | idle ${formatCompactUsd(r.totalIdleUsd)}`
        : "";
    lines.push(
      `    ${r.underlying}: ${r.vaultCount} vaults, exposure ${formatCompactUsd(r.totalExposureUsd)}${idleNote}`,
    );
    if (r.expiryCalendar.length > 0) {
      lines.push(`      Next-30d expiry calendar:`);
      for (const wk of r.expiryCalendar) {
        lines.push(
          `        wk ${wk.weekStart}: ${wk.vaults.join(", ")} (${wk.symbols.join(", ")})`,
        );
      }
    }
  }
  return lines;
}

function formatCuratorPortfolio(
  p: CuratorPortfolioSummary,
  rollupRows: PerUnderlyingRollupRow[],
): string {
  const lines: string[] = [];

  lines.push(`== Curator Portfolio ==`);
  lines.push(`  Curator: ${p.curatorAddress || "Manual selection"}`);
  lines.push(`  Total AUM: ${formatUsd(p.totalAumUsd)}`);
  lines.push(`  Vaults: ${p.vaultCount}  |  Total Positions: ${p.totalPositions}`);
  lines.push(`  Blended APY: ${formatPct(p.blendedApyPct)} (TVL-weighted)`);
  lines.push(`  Projected Annual Fee Revenue: ${formatUsd(p.projectedAnnualFeeRevenueUsd)} (at ${p.curatorFeePct}% fee)`);

  // ── Concentration block: suppress on single-vault curators (100% by definition is noise) ──
  if (p.vaultCount > 1) {
    lines.push(``);
    lines.push(`  Concentration:`);
    lines.push(`    By Underlying: ${formatConcentration(p.concentrationByUnderlying)}`);
    lines.push(`    By Chain: ${formatConcentration(p.concentrationByChain)}`);
  }

  // ── Per-underlying rollup: suppress on single-underlying curators ──
  if (rollupRows.length > 0) {
    lines.push(``);
    lines.push(...formatPerUnderlyingRollup(rollupRows));
  }

  lines.push(``);
  lines.push(`  Vaults:`);
  for (let i = 0; i < p.vaults.length; i++) {
    const v = p.vaults[i];
    // Surface idle ratio and incentive dependency inline — don't make agents dig for it
    const idleTag = v.idlePct != null && v.idlePct > 20 ? ` (${v.idlePct.toFixed(0)}% idle)` : "";
    const baseTag = v.liveApyBase != null && v.liveApyTotal > 0 && v.liveApyBase < v.liveApyTotal
      ? ` (base ${formatPct(v.liveApyBase)})`
      : "";
    lines.push(`    ${i + 1}. ${v.name} (${v.chain}) -- ${formatCompactUsd(v.tvlUsd)}${idleTag} | APY ${formatPct(v.liveApyTotal)}${baseTag} | ${v.positionCount} position${v.positionCount !== 1 ? "s" : ""}`);
    for (const item of v.actionItems) {
      lines.push(`       ${item}`);
    }
  }

  // ── Cross-Vault Items: emit ONLY when genuine signals computed via aggregation fired ──
  if (p.actionItems.length > 0) {
    lines.push(``);
    lines.push(`  Cross-Vault Items:`);
    for (const item of p.actionItems) {
      lines.push(`    ${item}`);
    }
  }

  // ── Observation Boundaries ──
  // Declare what this aggregation cannot see
  lines.push(``);
  lines.push(`--- What This View Cannot See ---`);
  lines.push(`  - Idle capital detail: per-vault idle % is only flagged if >20%. Some vaults may have`);
  lines.push(`    significant undeployed capital below this threshold. Use spectra_get_curator_dashboard per vault.`);
  lines.push(`  - Incentive dependency: Blended APY includes incentive programs that may end.`);
  lines.push(`    A portfolio showing 12% blended APY where 80% is incentive-driven has ~2.4% base yield.`);
  lines.push(`    Use spectra_get_curator_dashboard on individual vaults to see APY composition.`);
  lines.push(`  - Cross-chain exposure: positions bridged to other chains are not separated here.`);
  lines.push(`    Bridge latency risk is invisible at the portfolio level.`);
  lines.push(`  - Morpho leverage: if any vault uses Morpho looping, this view shows gross TVL`);
  lines.push(`    not net exposure. Use morpho_monitor_risk(address) for leverage health.`);
  lines.push(`  - Fee revenue projection assumes current TVL and APY hold. Both are variable.`);

  lines.push(``);
  lines.push(`--- Next Steps ---`);
  lines.push(`  • Dashboard for specific vault: spectra_get_curator_dashboard(chain, metavault_address)`);
  lines.push(`  • Risk monitor: morpho_monitor_risk(address) for Morpho position health`);
  lines.push(`  • Stress test: spectra_stress_test_vault(chain, metavault_address) for withdrawal simulation`);

  return lines.join("\n");
}

/** Compute the idle USD for a single vault using the same math as summarizeVault. */
function computeIdleUsd(mv: SpectraMetavault): number {
  const tvlUsd = mv.tvl?.usd || 0;
  if (tvlUsd <= 0) return 0;
  let knownAllocTotal = 0;
  for (const pos of mv.positions || []) {
    const pool = pos.pools?.[0];
    const rawBalance = pool?.lpt?.balance || pos.balance;
    if (rawBalance && pool?.lpt?.price?.usd) {
      const decimals = pool.lpt.decimals || 18;
      const raw = BigInt(rawBalance);
      const divisor = 10n ** BigInt(decimals);
      const lpBalance = Number(raw / divisor) + Number(raw % divisor) / Number(divisor);
      knownAllocTotal += lpBalance * pool.lpt.price.usd;
    }
  }
  const externalUsd = (mv.externalPositions || []).reduce((s, e) => s + (e.valueUsd || 0), 0);
  return Math.max(0, tvlUsd - knownAllocTotal - externalUsd);
}

// ── Tool registration ────────────────────────────────────────────────────

export function register(server: McpServer): void {
  server.tool(
    "mv_get_curator_portfolio",
    `Aggregate multiple MetaVaults managed by a single curator into one portfolio view.

Three input modes (priority: explicit > label > address):
  1. Explicit mode: metavault_addresses as a JSON array of {chain, address}
     pairs to aggregate specific vaults (machine-friendly).
  2. Label mode: curator_label="Gami Labs" — resolves to the union of curator
     EOAs whose curator.name matches case-insensitively across chains.
     Solves the named-curator-multiple-EOAs case (e.g. Gami Labs has different
     EOAs on base vs flare).
  3. Address mode: curator_address=0x... — scans all chains for MetaVaults
     where the curator's address matches the vault's curator.addresses array
     (machine-friendly when the EOA is known).

Returns:
  - Total AUM across all vaults
  - Blended APY (TVL-weighted)
  - Projected annual fee revenue at the configured curator fee
  - Concentration by underlying asset and by chain (suppressed for single-vault curators)
  - Per-underlying rollup with expiry calendar (suppressed for single-underlying curators)
  - Per-vault summary with position count and per-vault action items
  - Cross-Vault Items: GENUINE cross-vault signals computed by aggregation
    (suppressed when no genuine signal fires — silent on clean is first-class)

Use spectra_get_curator_dashboard for deep-dive into a specific vault.
Use morpho_monitor_risk for Morpho position health across the curator's address.
Use spectra_stress_test_vault for withdrawal simulation on a specific vault.`,
    {
      curator_address: EVM_ADDRESS
        .optional()
        .describe("Curator wallet address. Scans all chains for MetaVaults managed by this address. Machine-friendly when the EOA is known."),
      curator_label: z
        .string()
        .min(1)
        .optional()
        .describe("Curator display name (e.g. 'Gami Labs'). Resolves case-insensitively to the union of curator EOAs across chains. Use when a curator brand spans multiple EOAs (Gami Labs has different EOAs on base vs flare)."),
      metavault_addresses: z
        .array(z.object({
          chain: CHAIN_ENUM,
          address: EVM_ADDRESS,
        }))
        .optional()
        .describe("Explicit list of MetaVault {chain, address} pairs to aggregate. Takes priority over label/address."),
      curator_fee_pct: z
        .number()
        .min(0)
        .max(100)
        .default(10)
        .describe("Curator performance fee as % of vault yield (default 10%). Used for fee revenue projection."),
    },
    async ({ curator_address, curator_label, metavault_addresses, curator_fee_pct }) => {
      try {
        // Validate that at least one discovery method is provided
        if (!curator_address && !curator_label && !metavault_addresses) {
          const text = `Error: provide one of curator_label (human-friendly), curator_address (EOA), or metavault_addresses (explicit list). Use spectra_list_metavaults() to discover labels and addresses.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const vaultSummaries: CuratorVaultSummary[] = [];
        const vaultRaw: Array<{ mv: SpectraMetavault; chain: string }> = [];
        let resolvedFromLabel: CuratorLabelResolution | null = null;

        if (metavault_addresses && metavault_addresses.length > 0) {
          // ── Explicit mode: fetch specific vaults ──
          // Group by chain to minimize API calls
          const byChain = new Map<string, string[]>();
          for (const { chain, address } of metavault_addresses) {
            const existing = byChain.get(chain) || [];
            existing.push(address.toLowerCase());
            byChain.set(chain, existing);
          }

          const fetchPromises = Array.from(byChain.entries()).map(
            async ([chain, addresses]) => {
              const mvs = await fetchMetavaults(chain);
              const matched = mvs.filter((mv) =>
                addresses.includes(mv.address.toLowerCase()),
              );
              return matched.map((mv) => ({ mv, chain }));
            },
          );

          const results = await Promise.allSettled(fetchPromises);
          for (const r of results) {
            if (r.status === "fulfilled") {
              for (const { mv, chain } of r.value) {
                vaultSummaries.push(summarizeVault(mv, chain));
                vaultRaw.push({ mv, chain });
              }
            }
          }
        } else if (curator_label || curator_address) {
          // ── Label / address mode: scan all chains, resolve label first if given ──
          const { metavaults } = await scanAllMetavaults();

          let curatorEoas: string[] = [];
          if (curator_label) {
            resolvedFromLabel = resolveCuratorLabel(metavaults, curator_label);
            if (resolvedFromLabel.addresses.length === 0) {
              const labels = resolvedFromLabel.allLabels.length > 0
                ? `\nAvailable labels: ${resolvedFromLabel.allLabels.join(", ")}`
                : "";
              const text = `No curator matched label "${curator_label}".${labels}\nUse spectra_list_metavaults() to browse curator names.`;
              return { content: [{ type: "text" as const, text }], isError: true };
            }
            curatorEoas = resolvedFromLabel.addresses;
          } else if (curator_address) {
            curatorEoas = [curator_address.toLowerCase()];
          }

          for (const { metavault, chain } of metavaults) {
            const curatorAddresses = (metavault.curator?.addresses || []).map((a) => a.toLowerCase());
            const match = curatorAddresses.some((addr) => curatorEoas.includes(addr));
            if (match) {
              vaultSummaries.push(summarizeVault(metavault, chain));
              vaultRaw.push({ mv: metavault, chain });
            }
          }

          if (vaultSummaries.length === 0) {
            const labelTrace = curator_label ? ` (label "${curator_label}" matched ${curatorEoas.length} EOA(s) but no MVs)` : "";
            const subj = curator_label ? `label "${curator_label}"` : `curator ${curator_address}`;
            const text = `No MetaVaults found for ${subj}${labelTrace} across any chain.\nUse spectra_list_metavaults() to browse available MetaVaults.`;
            return { content: [{ type: "text" as const, text }] };
          }
        }

        if (vaultSummaries.length === 0) {
          const text = `No MetaVaults found matching the provided addresses.\nVerify the chain and address values. Use spectra_list_metavaults() to discover available vaults.`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Sort vaults by TVL descending; keep raw metadata in lock-step
        const indexed = vaultSummaries.map((s, i) => ({ s, raw: vaultRaw[i] }));
        indexed.sort((a, b) => b.s.tvlUsd - a.s.tvlUsd);
        const sortedSummaries = indexed.map((x) => x.s);
        const sortedRaw = indexed.map((x) => x.raw);

        // Build cross-vault inputs for aggregation helpers
        const crossInputs: CrossVaultInput[] = sortedSummaries.map((s, i) => ({
          summary: s,
          positions: sortedRaw[i].mv.positions || [],
          idleUsd: computeIdleUsd(sortedRaw[i].mv),
        }));

        const crossVaultItems = computeCrossVaultItems(crossInputs);
        const rollupRows = computePerUnderlyingRollup(crossInputs);

        // Surface label resolution prefix in curatorAddress slot when label-mode was used
        const curatorSlot = metavault_addresses
          ? null
          : resolvedFromLabel
            ? `${resolvedFromLabel.matchedNames.join(" / ")} (${resolvedFromLabel.addresses.join(", ")})`
            : (curator_address || null);

        const portfolio = buildPortfolio(
          sortedSummaries,
          curatorSlot,
          curator_fee_pct,
          crossVaultItems,
        );

        const text = formatCuratorPortfolio(portfolio, rollupRows);
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `mv_get_curator_portfolio error: ${e.message || e}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}
