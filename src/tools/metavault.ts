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
import type { MetavaultLoopRow, MetavaultCuratorEconomics } from "../types.js";
import { CHAIN_ENUM, EVM_ADDRESS } from "../config.js";
import { fetchMetavaults, scanAllMetavaults } from "../api.js";
import {
  formatPct,
  formatUsd,
  cumulativeLeverageAtLoop,
  formatMetavaultStrategy,
  formatMetavaultList,
} from "../formatters.js";

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

export function register(server: McpServer): void {

  // ─── get_metavaults ────────────────────────────────────────────────────

  server.tool(
    "get_metavaults",
    `List live MetaVaults from the Spectra API.

MetaVaults are ERC-7540 curated vaults that automate LP rollover and compound
YT yield back into LP positions. They are managed by curators who earn
performance fees on depositor yield.

Returns all MetaVaults with:
  - Curator info, TVL, live APY, share price
  - Active positions (PT markets the vault is deployed in)
  - Underlying asset details
  - Vault flows: epoch-by-epoch deposit/withdrawal analysis (net inflows vs outflows
    derived from asset snapshots, with yield accrual separated out)
  - Bridge transactions: cross-chain CCTP transfers with amounts, directions, and status
  - Epoch history (rate snapshots)

Use this tool to discover which MetaVaults are live, then pass the address to
model_metavault_strategy for detailed strategy modeling with live data.

To investigate curator activity (LP adds/removes, rebalancing), use get_address_activity
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
        let failedChains: string[] = [];

        if (chain) {
          const mvs = await fetchMetavaults(chain);
          entries = mvs.map((metavault) => ({ metavault, chain }));
        } else {
          const result = await scanAllMetavaults();
          entries = result.metavaults;
          failedChains = result.failedChains;
        }

        const text = formatMetavaultList(entries, chain, failedChains);
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching MetaVaults: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ─── model_metavault_strategy ──────────────────────────────────────────

  server.tool(
    "model_metavault_strategy",
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
revenue for managing the vault (rolling positions, compounding YT, maintaining allocations).`,
    {
      chain: CHAIN_ENUM
        .optional()
        .describe("Chain where the MetaVault lives. Required with metavault_address for live data."),
      metavault_address: EVM_ADDRESS
        .optional()
        .describe("MetaVault contract address. When provided with chain, auto-fetches live APY and TVL as base_apy. Use get_metavaults to discover addresses."),
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
            liveDataNote = [
              `--- Live MetaVault Data ---`,
              `  Name: ${mv.metadata?.title || mv.name} (${mv.symbol})`,
              `  Chain: ${chain}`,
              `  Address: ${mv.address}`,
              `  Curator: ${curatorName}`,
              `  TVL: ${tvlStr}`,
              `  Live APY: ${formatPct(liveApy)}${resolvedBaseApy !== liveApy ? ` (overridden to ${formatPct(resolvedBaseApy!)})` : " (used as base_apy)"}`,
              `  Share Price: ${formatUsd(mv.price?.usd || 0)}`,
              `  Positions: ${mv.positions?.length || 0} active`,
              ``,
            ].join("\n");
          } else {
            liveDataNote = [
              `--- Live MetaVault Data ---`,
              `  MetaVault ${metavault_address} not found on ${chain}.`,
              `  Use get_metavaults to discover available MetaVaults.`,
              `  Falling back to manual base_apy.`,
              ``,
            ].join("\n");
          }
        } else if (metavault_address && !chain) {
          liveDataNote = [
            `--- Live MetaVault Data ---`,
            `  chain is required when metavault_address is provided.`,
            `  Use get_metavaults to find chain + address pairs.`,
            `  Falling back to manual base_apy.`,
            ``,
          ].join("\n");
        }

        // Require base_apy one way or another
        if (resolvedBaseApy === undefined) {
          const text = `Error: base_apy is required. Either provide it directly or supply chain + metavault_address to auto-fetch from the live API. Use get_metavaults to discover MetaVault addresses.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Vault economics
        const grossVaultApy = resolvedBaseApy + yt_compounding_apy;
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
          baseApy: resolvedBaseApy,
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
        });

        // Next-step hints
        const nextLines = [
          ``,
          `--- Next Steps ---`,
          `• List live MetaVaults: get_metavaults() for current vault data`,
          `• Find pools matching your target APY: scan_opportunities(capital_usd=${capital_usd || "YOUR_AMOUNT"}) for live pool data`,
          `• Check raw PT looping baseline: get_looping_strategy(chain=CHAIN, pt_address=PT_ADDRESS) for comparison`,
          `• Find Morpho markets: get_morpho_markets() to see which PTs have lending markets for Market A`,
        ].join("\n");

        return { content: [{ type: "text" as const, text: liveDataNote + text + nextLines }] };
      } catch (e: any) {
        const text = `Error modeling MetaVault strategy: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
