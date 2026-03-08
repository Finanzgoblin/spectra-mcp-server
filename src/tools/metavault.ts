/**
 * Tools: get_metavaults, model_metavault_strategy
 *
 * get_metavaults — Discovery tool for live MetaVaults from the Spectra API.
 * Lists all MetaVaults across chains with curator info, TVL, APY, and positions.
 *
 * model_metavault_strategy — Strategy modeler for MetaVault "double loop" economics.
 * Can auto-populate from live API data when chain + metavault_address are provided,
 * or run in pure computational mode with manual parameters.
 *
 * Dual Morpho Market Strategy for Curators:
 *
 *   Market A — PT / underlying (e.g. PT-ibUSDC / USDC):
 *     For external users. Users buy PT on Spectra, deposit as Morpho collateral,
 *     borrow underlying, buy more PT, loop. Drives PT demand, pool volume, and
 *     LP fee revenue. The curator can also supply the lending side (earn borrow rate
 *     on idle capital). This is the growth engine — it creates the flywheel.
 *
 *   Market B — MetaVault shares / underlying (e.g. MV-ibUSDC / USDC):
 *     For the curator (and sophisticated depositors). MetaVault shares are deposited
 *     as Morpho collateral, borrow underlying, deposit back into the vault, loop.
 *     This multiplies the curator's own capital efficiency. This is the capital
 *     efficiency play — it amplifies the curator's yield and fee revenue.
 *
 *   The two markets reinforce each other:
 *     1. Market A drives PT buying demand → more volume → more LP fees
 *     2. Higher LP fees boost the MetaVault base APY
 *     3. Curator loops MV shares (Market B) → deepens pool liquidity
 *     4. Deeper liquidity attracts more PT loopers (Market A)
 *     5. More external deposits into the vault → more fee revenue for the curator
 *
 * Curator Fee Model:
 *   The curator EARNS the performance fee (curator_fee_pct) on vault yield
 *   generated for external depositors. This is the curator's revenue stream
 *   for managing the vault — rolling LP positions, compounding YT, and
 *   maintaining allocations. Net Vault APY shown is what depositors receive
 *   AFTER the curator's fee has been deducted.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MetavaultLoopRow, MetavaultCuratorEconomics, MetavaultPerformanceMetrics, SpectraMetavault, SpectraMetavaultEpoch } from "../types.js";
import { CHAIN_ENUM, EVM_ADDRESS } from "../config.js";
import { fetchMetavaults, scanAllMetavaults, fetchChainPoolAddresses } from "../api.js";
import {
  formatPct,
  formatUsd,
  formatDate,
  daysToMaturity,
  cumulativeLeverageAtLoop,
  formatMetavaultStrategy,
  formatMetavaultList,
  formatCuratorDashboard,
} from "../formatters.js";
import type { CuratorDashboardOpts } from "../formatters.js";

function computeLoopRows(
  baseApy: number,
  borrowRate: number,
  morphoLtv: number,
  maxLoops: number,
): MetavaultLoopRow[] {
  const rows: MetavaultLoopRow[] = [];
  for (let i = 0; i <= maxLoops; i++) {
    const leverage = cumulativeLeverageAtLoop(morphoLtv, i);
    const grossApy = baseApy * leverage;
    const borrowCost = borrowRate * (leverage - 1);
    const netApy = grossApy - borrowCost;
    const debtRatio = leverage > 1
      ? (leverage - 1) / (leverage * morphoLtv)
      : 0;
    const effectiveMargin = (1 - debtRatio) * 100;
    rows.push({ loop: i, leverage, grossApy, netApy, effectiveMargin });
  }
  return rows;
}

function findOptimal(rows: MetavaultLoopRow[]): { loop: number; netApy: number; leverage: number } {
  let best = rows[0];
  for (const row of rows) {
    if (row.netApy > best.netApy) best = row;
  }
  return { loop: best.loop, netApy: best.netApy, leverage: best.leverage };
}

// ─── Performance metrics computation ────────────────────────────────────────

function computePerformanceMetrics(
  epochs: SpectraMetavaultEpoch[],
  riskFreeRatePct: number = 5,
  underlyingDecimals: number = 6,
): MetavaultPerformanceMetrics | null {
  if (!epochs || epochs.length < 2) return null;

  const rateDivisor = Math.pow(10, underlyingDecimals);
  const sorted = [...epochs].sort((a, b) => a.timestamp - b.timestamp);
  const rates = sorted.map((e) => Number(e.rate) / rateDivisor);
  const timestamps = sorted.map((e) => e.timestamp);

  const firstRate = rates[0];
  const lastRate = rates[rates.length - 1];
  const startDate = formatDate(timestamps[0]);
  const endDate = formatDate(timestamps[timestamps.length - 1]);
  const totalDays = (timestamps[timestamps.length - 1] - timestamps[0]) / 86400;

  if (totalDays <= 0 || firstRate <= 0) return null;

  const annualizedReturnPct = (lastRate / firstRate - 1) * (365 / totalDays) * 100;

  // Max drawdown
  let peak = rates[0];
  let maxDrawdownPct = 0;
  let drawdownStartIdx: number | null = null;
  let drawdownEndIdx: number | null = null;
  let currentPeakIdx = 0;

  for (let i = 1; i < rates.length; i++) {
    if (rates[i] > peak) {
      peak = rates[i];
      currentPeakIdx = i;
    }
    const drawdown = (rates[i] - peak) / peak * 100;
    if (drawdown < maxDrawdownPct) {
      maxDrawdownPct = drawdown;
      drawdownStartIdx = currentPeakIdx;
      drawdownEndIdx = i;
    }
  }

  const drawdownStartDate = drawdownStartIdx !== null ? formatDate(timestamps[drawdownStartIdx]) : null;
  const drawdownEndDate = drawdownEndIdx !== null ? formatDate(timestamps[drawdownEndIdx]) : null;

  // Volatility
  const epochReturns: number[] = [];
  let totalEpochDays = 0;
  for (let i = 1; i < rates.length; i++) {
    if (rates[i - 1] > 0) {
      epochReturns.push((rates[i] - rates[i - 1]) / rates[i - 1]);
    }
    totalEpochDays += (timestamps[i] - timestamps[i - 1]) / 86400;
  }

  let volatilityAnnualizedPct = 0;
  let sharpeRatio: number | null = null;

  if (epochReturns.length >= 2) {
    const avgEpochDays = totalEpochDays / epochReturns.length;
    const mean = epochReturns.reduce((s, r) => s + r, 0) / epochReturns.length;
    const variance = epochReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (epochReturns.length - 1);
    const stdDev = Math.sqrt(variance);
    const annualizationFactor = avgEpochDays > 0 ? Math.sqrt(365 / avgEpochDays) : 0;
    volatilityAnnualizedPct = stdDev * annualizationFactor * 100;

    if (volatilityAnnualizedPct > 0) {
      sharpeRatio = (annualizedReturnPct - riskFreeRatePct) / volatilityAnnualizedPct;
    }
  }

  return {
    startDate,
    endDate,
    totalDays: Math.round(totalDays),
    epochCount: sorted.length,
    annualizedReturnPct,
    maxDrawdownPct,
    drawdownStartDate,
    drawdownEndDate,
    volatilityAnnualizedPct,
    sharpeRatio,
    riskFreeRatePct,
  };
}

function formatPerformanceMetrics(metrics: MetavaultPerformanceMetrics): string {
  const lines: string[] = [];
  lines.push(`--- Performance (since inception) ---`);
  lines.push(`  Period: ${metrics.startDate} to ${metrics.endDate} (${metrics.totalDays} days, ${metrics.epochCount} epochs)`);
  lines.push(`  Time-Weighted Return: ${formatPct(metrics.annualizedReturnPct)} annualized`);

  if (metrics.maxDrawdownPct < 0 && metrics.drawdownStartDate && metrics.drawdownEndDate) {
    lines.push(`  Max Drawdown: ${formatPct(metrics.maxDrawdownPct)} (${metrics.drawdownStartDate} to ${metrics.drawdownEndDate})`);
  } else {
    lines.push(`  Max Drawdown: none`);
  }

  lines.push(`  Volatility: ${formatPct(metrics.volatilityAnnualizedPct)} annualized`);

  if (metrics.sharpeRatio !== null) {
    const sharpeStr = `  Sharpe Ratio: ${metrics.sharpeRatio.toFixed(1)} (vs ${formatPct(metrics.riskFreeRatePct)} risk-free proxy)`;
    if (metrics.totalDays < 30) {
      lines.push(`${sharpeStr} ⚠ ${metrics.totalDays}d track record — too short for meaningful Sharpe`);
    } else if (metrics.totalDays < 90) {
      lines.push(`${sharpeStr} (${metrics.totalDays}d track record — interpret with caution)`);
    } else {
      lines.push(sharpeStr);
    }
  } else {
    lines.push(`  Sharpe Ratio: N/A (insufficient volatility data)`);
  }

  lines.push(``);
  lines.push(`  Considerations:`);
  lines.push(`  - Returns are in underlying terms (not USD) — denomination asset price changes are excluded`);
  lines.push(`  - Performance based on ${metrics.epochCount} epoch snapshots — granularity is limited by epoch frequency`);
  lines.push(`  - Max drawdown measures share rate decline, which can reflect LP impermanent loss or pool rebalancing`);
  if (metrics.totalDays < 90) {
    lines.push(`  - Short track record (${metrics.totalDays} days) — insufficient for robust statistical inference`);
  }

  return lines.join("\n");
}

export function register(server: McpServer): void {

  // ─── get_metavaults ────────────────────────────────────────────────────

  server.tool(
    "spectra_list_metavaults",
    `List live MetaVaults from the Spectra API.

MetaVaults are ERC-7540 curated vaults that automate LP rollover and compound
YT yield back into LP positions. They are managed by curators who earn
performance fees on depositor yield.

Returns all MetaVaults with:
  - Curator info, TVL, live APY with full breakdown (base vs external incentives)
  - Active positions (PT markets the vault is deployed in)
  - Underlying asset details
  - Vault flows: epoch-by-epoch deposit/withdrawal analysis (net inflows vs outflows
    derived from asset snapshots, with yield accrual separated out)
  - Bridge transactions: cross-chain CCTP transfers with amounts, directions, and status
  - Epoch history (rate snapshots)

Use this tool to discover which MetaVaults are live, then pass the address to
spectra_model_metavault for detailed strategy modeling with live data.

To investigate curator activity (LP adds/removes, rebalancing), use spectra_get_address_activity
on the curator's EOA address — MetaVault operations go through the Spectra Router, so
the vault contract address won't appear in pool activity data.`,
    {
      chain: CHAIN_ENUM
        .optional()
        .describe("Chain to query. Omit to scan all chains."),
    },
    async ({ chain }) => {
      try {
        let entries: Array<{ metavault: any; chain: string }>;

        if (chain) {
          const mvs = await fetchMetavaults(chain);
          entries = mvs.map((metavault) => ({ metavault, chain }));
        } else {
          const result = await scanAllMetavaults();
          entries = result.metavaults;
        }

        const text = formatMetavaultList(entries, chain);
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching MetaVaults: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ─── model_metavault_strategy ──────────────────────────────────────────

  server.tool(
    "spectra_model_metavault",
    `Model a MetaVault "double loop" strategy for curators.

MetaVaults are ERC-7540 curated vaults that automate LP rollover and compound
YT yield back into LP positions. This tool models the economics of leveraging
MetaVault shares as collateral on Morpho (or similar lending markets).

Two modes:
  1. Live mode: Provide chain + metavault_address to auto-populate base_apy from
     the live MetaVault API. All other params can be overridden.
  2. Manual mode: Provide base_apy directly for hypothetical modeling.

The "double loop":
  Layer 1 (inside vault): YT yield → LP tokens (compounding loop, managed by curator)
  Layer 2 (on top):       MV shares → Morpho collateral → borrow → deposit back (leverage loop)

Because YT compounding raises the base yield, leverage multiplies a higher base —
creating a "double loop premium" over raw PT looping.

Dual Morpho Market Strategy:
  Curators should create TWO Morpho markets for maximum flywheel effect:
  Market A (PT / underlying): For external users to loop PT. Drives pool volume & LP fees.
  Market B (MV shares / underlying): For the curator to loop vault shares. Amplifies own capital.
  These markets reinforce each other — PT demand deepens the pool, deeper pool attracts more
  loopers, and the curator earns fees on all external deposits flowing through the vault.

Curator economics: The curator EARNS the performance fee on external deposits — this is
revenue for managing the vault (rolling positions, compounding YT, maintaining allocations).

Blended allocation: Supports modeling MetaVaults that allocate across both Spectra and
Pendle LP positions via pendle_allocation_pct and pendle_lp_apy parameters. Computes
blended base APY and warns about manual Pendle rollover requirements.`,
    {
      chain: CHAIN_ENUM
        .optional()
        .describe("Chain where the MetaVault lives. Required with metavault_address for live data."),
      metavault_address: EVM_ADDRESS
        .optional()
        .describe("MetaVault contract address. When provided with chain, auto-fetches live APY and TVL as base_apy. Use spectra_list_metavaults to discover addresses."),
      base_apy: z
        .number()
        .optional()
        .describe("Base LP APY the MetaVault targets (%), e.g. 12 for 12%. Auto-populated from live data when metavault_address is provided, or required in manual mode."),
      yt_compounding_apy: z
        .number()
        .default(0)
        .describe("Additional yield from YT→LP compounding (%), e.g. 3 for 3%. Default 0."),
      curator_fee_pct: z
        .number()
        .min(0)
        .max(100)
        .default(10)
        .describe("Performance fee the curator EARNS as % of vault yield (default 10%). E.g. 10 means curator collects 10% of gross yield as revenue, depositors receive the remaining 90%."),
      morpho_ltv: z
        .number()
        .gt(0)
        .lt(1)
        .default(0.86)
        .describe("Morpho LTV for MetaVault share collateral (0-1, default 0.86 = 86%)"),
      borrow_rate: z
        .number()
        .default(5)
        .describe("Morpho borrow rate in % APY (default 5%)"),
      max_loops: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum leverage loops to model (default 5)"),
      capital_usd: z
        .number()
        .positive()
        .optional()
        .describe("Curator's own capital in USD. Enables curator economics section."),
      external_deposits_usd: z
        .number()
        .min(0)
        .default(0)
        .describe("External deposits the curator attracts (USD). The curator earns performance fees on these deposits. Default 0."),
      days_to_maturity: z
        .number()
        .positive()
        .default(90)
        .describe("Average pool cycle length in days (default 90). Used for rollover advantage."),
      compare_pt_apy: z
        .number()
        .optional()
        .describe("If provided, show side-by-side comparison with raw PT looping at this APY (%)"),
      pendle_allocation_pct: z
        .number()
        .min(0)
        .max(100)
        .default(0)
        .describe("Percentage of vault capital allocated to Pendle LP positions (0-100, default 0). When >0, computes blended APY across Spectra and Pendle. Requires pendle_lp_apy."),
      pendle_lp_apy: z
        .number()
        .optional()
        .describe("Pendle LP APY (%) for the Pendle allocation. Required when pendle_allocation_pct > 0."),
    },
    async ({
      chain,
      metavault_address,
      base_apy,
      yt_compounding_apy,
      curator_fee_pct,
      morpho_ltv,
      borrow_rate,
      max_loops,
      capital_usd,
      external_deposits_usd,
      days_to_maturity,
      compare_pt_apy,
      pendle_allocation_pct,
      pendle_lp_apy,
    }) => {
      try {
        let resolvedBaseApy = base_apy;
        let liveDataNote = "";

        // Live mode: fetch metavault data from API
        if (metavault_address && chain) {
          const mvs = await fetchMetavaults(chain);
          const mv = mvs.find(
            (m) => m.address.toLowerCase() === metavault_address.toLowerCase()
          );
          if (mv) {
            const liveApy = mv.liveApy?.total || 0;
            if (resolvedBaseApy === undefined) {
              resolvedBaseApy = liveApy;
            }
            const tvlStr = formatUsd(mv.tvl?.usd || 0);
            const curatorName = mv.curator?.name || "Unknown";
            const noteLines = [
              `--- Live MetaVault Data ---`,
              `  Name: ${mv.metadata?.title || mv.name} (${mv.symbol})`,
              `  Chain: ${chain}`,
              `  Address: ${mv.address}`,
              `  Curator: ${curatorName}`,
              `  TVL: ${tvlStr}`,
              `  Live APY: ${formatPct(liveApy)}${resolvedBaseApy !== liveApy ? ` (overridden to ${formatPct(resolvedBaseApy!)})` : " (used as base_apy)"}`,
              `  Share Price: ${formatUsd(mv.price?.usd || 0)}`,
              `  Positions: ${mv.positions?.length || 0} active`,
            ];

            // Surface APY composition — let agent reason about what's base vs incentive
            const apyDetails = mv.liveApy?.details;
            if (apyDetails) {
              noteLines.push(``);
              noteLines.push(`  APY Composition:`);
              if (apyDetails.base != null) {
                noteLines.push(`    Base (fees + PT + IBT): ${formatPct(apyDetails.base)}`);
              }
              if (apyDetails.ibtRewards && Object.keys(apyDetails.ibtRewards).length > 0) {
                for (const [token, apy] of Object.entries(apyDetails.ibtRewards)) {
                  noteLines.push(`    ${token} (IBT reward): ${formatPct(apy)}`);
                }
              }
              if (apyDetails.mvRewards && Object.keys(apyDetails.mvRewards).length > 0) {
                for (const [token, apy] of Object.entries(apyDetails.mvRewards)) {
                  noteLines.push(`    ${token} (MetaVault reward): ${formatPct(apy)}`);
                }
              }
              if (apyDetails.boostedRewards && Object.keys(apyDetails.boostedRewards).length > 0) {
                for (const [token, range] of Object.entries(apyDetails.boostedRewards)) {
                  noteLines.push(`    ${token} Gauge: ${formatPct(range.min)} -> ${formatPct(range.max)}`);
                }
              }

              const baseApy = apyDetails.base || 0;
              if (liveApy > 0 && baseApy < liveApy) {
                const incentiveApy = liveApy - baseApy;
                const incentivePct = (incentiveApy / liveApy) * 100;
                noteLines.push(`    => ${formatPct(baseApy)} base + ${formatPct(incentiveApy)} incentives (${incentivePct.toFixed(0)}% from incentive programs)`);
              }
            }

            noteLines.push(``);
            liveDataNote = noteLines.join("\n");
          } else {
            liveDataNote = [
              `--- Live MetaVault Data ---`,
              `  MetaVault ${metavault_address} not found on ${chain}.`,
              `  Use spectra_list_metavaults to discover available MetaVaults.`,
              `  Falling back to manual base_apy.`,
              ``,
            ].join("\n");
          }
        } else if (metavault_address && !chain) {
          liveDataNote = [
            `--- Live MetaVault Data ---`,
            `  chain is required when metavault_address is provided.`,
            `  Use spectra_list_metavaults to find chain + address pairs.`,
            `  Falling back to manual base_apy.`,
            ``,
          ].join("\n");
        }

        // Require base_apy one way or another
        if (resolvedBaseApy === undefined) {
          const text = `Error: base_apy is required. Either provide it directly or supply chain + metavault_address to auto-fetch from the live API. Use spectra_list_metavaults to discover MetaVault addresses.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Validate Pendle allocation
        if (pendle_allocation_pct > 0 && pendle_lp_apy === undefined) {
          const text = `Error: pendle_lp_apy is required when pendle_allocation_pct > 0. Provide the Pendle LP APY (%) for the blended allocation model. Use pendle_list_markets to find Pendle LP APYs.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Blended base APY (Spectra + Pendle allocation)
        const spectraBaseApy = resolvedBaseApy;
        const blendedBaseApy = pendle_allocation_pct > 0
          ? (resolvedBaseApy * (100 - pendle_allocation_pct) / 100) + (pendle_lp_apy! * pendle_allocation_pct / 100)
          : resolvedBaseApy;

        // Vault economics
        const grossVaultApy = blendedBaseApy + yt_compounding_apy;
        const netVaultApy = grossVaultApy * (1 - curator_fee_pct / 100);

        // MetaVault looping table
        const rows = computeLoopRows(netVaultApy, borrow_rate, morpho_ltv, max_loops);
        const optimal = findOptimal(rows);

        // PT comparison (if requested)
        let comparePtRows: MetavaultLoopRow[] | undefined;
        let comparePtBest: { loop: number; netApy: number; leverage: number } | undefined;
        if (compare_pt_apy !== undefined) {
          comparePtRows = computeLoopRows(compare_pt_apy, borrow_rate, morpho_ltv, max_loops);
          comparePtBest = findOptimal(comparePtRows);
        }

        // Curator economics (if capital provided)
        let curator: MetavaultCuratorEconomics | undefined;
        if (capital_usd !== undefined) {
          const ownTvl = capital_usd * optimal.leverage;
          const additionalTvlFromLooping = capital_usd * (optimal.leverage - 1);
          const totalTvl = ownTvl + external_deposits_usd;
          const ownYieldUsd = capital_usd * optimal.netApy / 100;
          const grossYieldOnExternal = external_deposits_usd * grossVaultApy / 100;
          const curatorFeeRevenueUsd = grossYieldOnExternal * curator_fee_pct / 100;
          const effectiveCuratorApy = (ownYieldUsd + curatorFeeRevenueUsd) / capital_usd * 100;

          curator = {
            capitalUsd: capital_usd,
            externalDepositsUsd: external_deposits_usd,
            ownTvl,
            totalTvl,
            additionalTvlFromLooping,
            curatorFeeRevenueUsd,
            ownYieldUsd,
            effectiveCuratorApy,
          };
        }

        const text = formatMetavaultStrategy({
          baseApy: blendedBaseApy,
          ytCompoundingApy: yt_compounding_apy,
          curatorFeePct: curator_fee_pct,
          netVaultApy,
          grossVaultApy,
          morphoLtv: morpho_ltv,
          borrowRate: borrow_rate,
          daysToMaturity: days_to_maturity,
          rows,
          bestLoop: optimal.loop,
          bestNetApy: optimal.netApy,
          bestLeverage: optimal.leverage,
          curator,
          comparePtApy: compare_pt_apy,
          comparePtRows,
          comparePtBestLoop: comparePtBest?.loop,
          comparePtBestNetApy: comparePtBest?.netApy,
          pendleAllocationPct: pendle_allocation_pct > 0 ? pendle_allocation_pct : undefined,
          pendleLpApy: pendle_allocation_pct > 0 ? pendle_lp_apy : undefined,
          spectraBaseApy: pendle_allocation_pct > 0 ? spectraBaseApy : undefined,
        });

        // Next-step hints
        const nextLines = [
          ``,
          `--- Next Steps ---`,
          `• List live MetaVaults: spectra_list_metavaults() for current vault data`,
          `• Find pools matching your target APY: spectra_scan_opportunities(capital_usd=${capital_usd || "YOUR_AMOUNT"}) for live pool data`,
          `• Check raw PT looping baseline: spectra_get_looping_strategy(chain=CHAIN, pt_address=PT_ADDRESS) for comparison`,
          `• Find Morpho markets: morpho_list_markets() to see which PTs have lending markets for Market A`,
          `• Cross-protocol scan: mv_scan_curator_opportunities(capital_usd=${capital_usd || "YOUR_AMOUNT"}) for unified Spectra + Pendle ranking`,
        ].join("\n");

        return { content: [{ type: "text" as const, text: liveDataNote + text + nextLines }] };
      } catch (e: any) {
        const text = `Error modeling MetaVault strategy: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ─── get_curator_dashboard ──────────────────────────────────────────────

  server.tool(
    "spectra_get_curator_dashboard",
    `Operational dashboard for MetaVault curators.

Aggregates vault health, position status, depositor flows, fee revenue estimates,
and actionable alerts into a single view. Designed for curators managing live
MetaVaults who need a quick operational overview.

Returns:
  - Vault health: TVL, live APY with composition (base vs incentives), share price
  - Position status: each active PT position with maturity countdown, APY, and size.
    Positions approaching maturity are flagged (!!!=14d, !!=30d)
  - Depositor flows: epoch-by-epoch net inflows/outflows with trend analysis
  - Fee revenue: estimated annual curator fee revenue (at current rates — both TVL
    and APY are variable, so this is a snapshot projection, not a guarantee)
  - Bridge activity: cross-chain CCTP transfer summary
  - Action items: auto-generated alerts for expiring positions, outflow trends,
    pending bridges, high incentive dependency, Pendle rollover warnings, and missing positions

Pool allocations show each position as a % of total vault TVL (e.g., "37.1% | $236K"),
sorted by size, with protocol tags ([Spectra]/[Pendle]/[Unknown]) on each position.
Idle liquidity (undeployed capital) is shown separately.
When the API doesn't provide LP balance data for a position, it shows "?%".

Cross-chain positions: MetaVault positions may live on a different chain than the
MetaVault itself (e.g., Base MetaVault → Avalanche pools via CCTP bridge). Pool
addresses in positions are on the position's chain, not the MetaVault's home chain.

Epoch flows: Derived from asset snapshots and rate changes. Yield accrual is estimated
from share rate deltas — actual yield may differ. Use share price trend to corroborate.

Requires chain + metavault_address. Use spectra_list_metavaults to discover addresses.
Use spectra_model_metavault for leverage modeling after reviewing the dashboard.
Use spectra_get_pool_activity on specific pool addresses for trading pattern analysis.
Use spectra_get_address_activity on the curator's EOA for cross-pool curator activity.`,
    {
      chain: CHAIN_ENUM
        .describe("The blockchain network where the MetaVault lives."),
      metavault_address: EVM_ADDRESS
        .describe("The MetaVault contract address. Use spectra_list_metavaults to discover addresses."),
      curator_fee_pct: z
        .number()
        .min(0)
        .max(100)
        .default(10)
        .describe("Curator performance fee as % of vault yield (default 10%). Used for fee revenue estimation."),
    },
    async ({ chain, metavault_address, curator_fee_pct }) => {
      try {
        const mvs = await fetchMetavaults(chain);
        const mv = mvs.find(
          (m) => m.address.toLowerCase() === metavault_address.toLowerCase()
        );

        if (!mv) {
          const text = `MetaVault ${metavault_address} not found on ${chain}.\nUse spectra_list_metavaults(chain="${chain}") to discover available MetaVaults.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const underlyingDecimals = mv.underlying?.decimals || 6;
        const underlyingPriceUsd = mv.underlying?.price?.usd || 0;
        const divisor = Math.pow(10, underlyingDecimals);
        const liveApyTotal = mv.liveApy?.total || 0;

        // ── Fetch known Spectra pool addresses for protocol detection ──
        // Best-effort: if fetch fails, fall back to heuristic-based detection.
        let spectraPoolAddresses: Set<string> = new Set();
        try {
          spectraPoolAddresses = await fetchChainPoolAddresses(chain);
        } catch {
          // Best-effort — fall back to heuristic
        }

        // ── Build positions with vault allocation ──────────────
        // The API provides LP balance in two places:
        //   1. pool.lpt.balance — standard location
        //   2. pos.balance — fallback when lpt.balance is missing (cross-chain positions)
        // Vault allocation = lpBalance * lpt.price.usd
        const positions = (mv.positions || []).map((pos) => {
          const pool = pos.pools?.[0];
          const matDays = daysToMaturity(pos.maturity);
          const expired = pos.maturity * 1000 <= Date.now();

          // Compute vault's allocation from API-provided LP balance + price
          let vaultAllocationUsd: number | null = null;
          const rawBalance = pool?.lpt?.balance || pos.balance;
          if (rawBalance && pool?.lpt?.price?.usd) {
            const decimals = pool.lpt.decimals || 18;
            const raw = BigInt(rawBalance);
            const divisor = 10n ** BigInt(decimals);
            const lpBalance = Number(raw / divisor) + Number(raw % divisor) / Number(divisor);
            vaultAllocationUsd = lpBalance * pool.lpt.price.usd;
          }

          // Protocol detection: multi-signal approach
          // 1. Pool address matches known Spectra pools → Spectra (most reliable)
          // 2. Has lpt data (Curve StableSwap LP token) → Spectra
          // 3. Symbol or name contains "pendle" → Pendle
          // 4. Default to "Unknown" if no signal matches (conservative)
          let protocol: "Spectra" | "Pendle" | "Unknown" = "Unknown";
          const poolAddr = pool?.address?.toLowerCase();
          if (poolAddr && spectraPoolAddresses.has(poolAddr)) {
            protocol = "Spectra";
          } else if (pool?.lpt) {
            protocol = "Spectra";
          } else if (
            pos.symbol?.toLowerCase().includes("pendle")
          ) {
            protocol = "Pendle";
          }

          return {
            symbol: pos.symbol,
            ptAddress: pos.address,
            poolAddress: pool?.address || null,
            maturityTimestamp: pos.maturity,
            daysToMaturity: matDays,
            expired,
            tvlUsd: pos.tvl?.usd || 0,
            vaultAllocationUsd,
            ptApy: pool?.ptApy || 0,
            lpApyTotal: pool?.lpApy?.total || 0,
            lpApyBoostedTotal: pool?.lpApy?.boostedTotal || null,
            protocol,
          };
        });

        // ── Epoch flow analysis ────────────────────────────────
        const epochFlows: CuratorDashboardOpts["epochFlows"] = [];
        let lifetimeNetFlowUsd = 0;
        let lifetimeYieldUsd = 0;
        let firstRate = 0;
        let lastRate = 0;

        if (mv.epochs && mv.epochs.length >= 2) {
          const sorted = [...mv.epochs].sort((a, b) => a.timestamp - b.timestamp);
          firstRate = Number(sorted[0].rate) / divisor;
          lastRate = Number(sorted[sorted.length - 1].rate) / divisor;

          let cumulativeYield = 0;
          let cumulativeNetDeposits = 0;

          for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const curr = sorted[i];
            const prevAssets = Number(prev.assets) / divisor;
            const currAssets = Number(curr.assets) / divisor;
            const prevRate = Number(prev.rate) / divisor;
            const currRate = Number(curr.rate) / divisor;

            const assetDelta = currAssets - prevAssets;
            const yieldAccrual = prevRate > 0 ? prevAssets * (currRate - prevRate) / prevRate : 0;
            const netDeposits = assetDelta - yieldAccrual;

            cumulativeYield += yieldAccrual;
            cumulativeNetDeposits += netDeposits;

            epochFlows.push({
              fromDate: formatDate(prev.timestamp),
              toDate: formatDate(curr.timestamp),
              netDepositsUsd: netDeposits * underlyingPriceUsd,
              yieldAccruedUsd: yieldAccrual * underlyingPriceUsd,
              tvlAfterUsd: currAssets * underlyingPriceUsd,
              rateAfter: currRate,
            });
          }

          // Lifetime totals — accumulated from per-epoch calculations
          lifetimeYieldUsd = cumulativeYield * underlyingPriceUsd;
          lifetimeNetFlowUsd = cumulativeNetDeposits * underlyingPriceUsd;
        }

        // ── Bridge summary ─────────────────────────────────────
        const bridgeTxs = mv.bridge?.transactions || [];
        const bridgeDirections: CuratorDashboardOpts["bridgeDirections"] = [];
        if (bridgeTxs.length > 0) {
          const dirMap = new Map<string, { count: number; totalUsd: number }>();
          for (const tx of bridgeTxs) {
            // Use chain IDs since chainIdToName is private in formatters
            const key = `Chain ${tx.srcChainId} -> Chain ${tx.dstChainId}`;
            const entry = dirMap.get(key) || { count: 0, totalUsd: 0 };
            entry.count++;
            entry.totalUsd += tx.amountUsd || 0;
            dirMap.set(key, entry);
          }
          for (const [direction, { count, totalUsd }] of dirMap) {
            bridgeDirections.push({ direction, count, totalUsd });
          }
        }

        // ── Compute known allocation total ─────────────────────
        const knownAllocTotal = positions
          .filter(p => p.vaultAllocationUsd != null)
          .reduce((sum, p) => sum + p.vaultAllocationUsd!, 0);
        const vaultTvl = mv.tvl?.usd || 0;
        const idleLiquidityUsd = vaultTvl > 0 ? Math.max(0, vaultTvl - knownAllocTotal) : 0;
        const idlePct = vaultTvl > 0 ? idleLiquidityUsd / vaultTvl * 100 : 0;

        // ── Action items ───────────────────────────────────────
        const actionItems: string[] = [];

        // Idle liquidity warning
        if (idlePct > 20 && idleLiquidityUsd > 1000) {
          actionItems.push(`[IDLE] ${idlePct.toFixed(0)}% of vault capital (${formatUsd(idleLiquidityUsd)}) is sitting idle. Deploy to active pools to generate yield.`);
        }

        // Expiring positions
        for (const pos of positions) {
          if (pos.expired) {
            actionItems.push(`[EXPIRED] ${pos.symbol} has matured. Redeem and reallocate to a new pool.`);
          } else if (pos.daysToMaturity <= 7) {
            actionItems.push(`[URGENT] ${pos.symbol} expires in ${pos.daysToMaturity}d. Prepare rollover to next maturity.`);
          } else if (pos.daysToMaturity <= 14) {
            actionItems.push(`[SOON] ${pos.symbol} expires in ${pos.daysToMaturity}d. Plan rollover strategy.`);
          } else if (pos.daysToMaturity <= 30) {
            actionItems.push(`[UPCOMING] ${pos.symbol} expires in ${pos.daysToMaturity}d. Monitor for rollover timing.`);
          }
        }

        // No positions
        if (positions.length === 0) {
          actionItems.push(`[WARNING] No active positions. Vault capital may be sitting idle.`);
        }

        // Outflow trend
        if (epochFlows.length >= 3) {
          const recent = epochFlows.slice(-3);
          const allOutflows = recent.every(f => f.netDepositsUsd < 0);
          if (allOutflows) {
            actionItems.push(`[OUTFLOWS] 3 consecutive epochs of net outflows. Review depositor retention.`);
          }
        }

        // Bridge pending
        if ((mv.bridge?.totalPendingUsd || 0) > 0) {
          actionItems.push(`[BRIDGE] ${formatUsd(mv.bridge!.totalPendingUsd)} pending in cross-chain bridge transfers.`);
        }

        // High incentive dependency
        const apyBase = mv.liveApy?.details?.base || 0;
        if (liveApyTotal > 0 && apyBase > 0) {
          const incentiveShare = (liveApyTotal - apyBase) / liveApyTotal;
          if (incentiveShare > 0.7) {
            actionItems.push(`[INCENTIVE] ${(incentiveShare * 100).toFixed(0)}% of APY comes from incentive programs. Base yield is only ${formatPct(apyBase)}.`);
          }
        }

        // Pendle manual rollover warnings
        for (const pos of positions) {
          if (pos.protocol === "Pendle" && !pos.expired && pos.daysToMaturity <= 30) {
            actionItems.push(`[PENDLE ROLLOVER] ${pos.symbol} matures in ${pos.daysToMaturity}d — requires manual rollover (MetaVault auto-roll does not cover Pendle positions)`);
          }
        }

        // ── Fee revenue estimate ───────────────────────────────
        let estimatedAnnualFeeRevenueUsd: number | null = null;
        if (mv.tvl?.usd && liveApyTotal > 0) {
          estimatedAnnualFeeRevenueUsd = (curator_fee_pct / 100) * (liveApyTotal / 100) * mv.tvl.usd;
        }

        const dashOpts: CuratorDashboardOpts = {
          chain,
          metavaultAddress: metavault_address,
          curatorName: mv.curator?.name || "Unknown",
          curatorAddresses: mv.curator?.addresses || [],
          vaultName: mv.metadata?.title || mv.name,
          vaultSymbol: mv.symbol,
          underlyingSymbol: mv.underlying?.symbol || "?",
          underlyingDecimals,
          underlyingPriceUsd,
          tvlUsd: mv.tvl?.usd || 0,
          tvlUnderlying: mv.tvl?.underlying || 0,
          liveApyTotal,
          liveApyBoostedTotal: mv.liveApy?.boostedTotal || null,
          liveApyBase: mv.liveApy?.details?.base ?? null,
          apyDetails: mv.liveApy?.details,
          sharePriceUsd: mv.price?.usd || 0,
          sharePriceUnderlying: mv.price?.underlying || 0,
          positions,
          epochFlows,
          lifetimeNetFlowUsd,
          lifetimeYieldUsd,
          firstRate,
          lastRate,
          epochCount: mv.epochs?.length || 0,
          bridgeTxCount: bridgeTxs.length,
          bridgePendingUsd: mv.bridge?.totalPendingUsd || 0,
          bridgeDirections,
          actionItems,
          curatorFeePct: curator_fee_pct,
          estimatedAnnualFeeRevenueUsd,
        };

        let text = formatCuratorDashboard(dashOpts);

        // Append performance metrics if enough epoch data
        const perfMetrics = computePerformanceMetrics(mv.epochs || [], 5, underlyingDecimals);
        if (perfMetrics) {
          const perfText = formatPerformanceMetrics(perfMetrics);
          const nextStepsMarker = "--- Next Steps ---";
          const nextStepsIdx = text.indexOf(nextStepsMarker);
          if (nextStepsIdx >= 0) {
            text = text.slice(0, nextStepsIdx) + perfText + "\n\n" + text.slice(nextStepsIdx);
          } else {
            text += "\n" + perfText;
          }
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error building curator dashboard: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
