/**
 * Tool: mv_get_curator_portfolio
 *
 * Aggregates multiple MetaVaults managed by a single curator into one
 * portfolio view. Supports discovery by curator address (scans all chains)
 * or explicit vault list.
 *
 * Output: total AUM, blended APY, projected fee revenue, concentration
 * by underlying and chain, per-vault summaries, and cross-vault action items.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EVM_ADDRESS, CHAIN_ENUM } from "../config.js";
import { scanAllMetavaults, fetchMetavaults } from "../api.js";
import type { SpectraMetavault, CuratorVaultSummary, CuratorPortfolioSummary } from "../types.js";
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
  const underlyingDecimals = mv.underlying?.decimals || 6;
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
  const idleLiquidityUsd = tvlUsd > 0 ? Math.max(0, tvlUsd - knownAllocTotal) : 0;
  const idlePct = tvlUsd > 0 ? (idleLiquidityUsd / tvlUsd) * 100 : 0;
  if (idlePct > 20 && idleLiquidityUsd > 1000) {
    actionItems.push(`[IDLE] ${idlePct.toFixed(0)}% idle capital (${formatUsd(idleLiquidityUsd)})`);
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

  // No positions
  if (positions.length === 0) {
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

/** Build aggregate portfolio from vault summaries. */
function buildPortfolio(
  vaults: CuratorVaultSummary[],
  curatorAddress: string | null,
  curatorFeePct: number,
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

  // Cross-vault action items (with vault name for context)
  const actionItems: string[] = [];
  for (const v of vaults) {
    for (const item of v.actionItems) {
      actionItems.push(`${item} -- ${v.name}`);
    }
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
    actionItems,
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

function formatCuratorPortfolio(p: CuratorPortfolioSummary): string {
  const lines: string[] = [];

  lines.push(`== Curator Portfolio ==`);
  lines.push(`  Curator: ${p.curatorAddress || "Manual selection"}`);
  lines.push(`  Total AUM: ${formatUsd(p.totalAumUsd)}`);
  lines.push(`  Vaults: ${p.vaultCount}  |  Total Positions: ${p.totalPositions}`);
  lines.push(`  Blended APY: ${formatPct(p.blendedApyPct)} (TVL-weighted)`);
  lines.push(`  Projected Annual Fee Revenue: ${formatUsd(p.projectedAnnualFeeRevenueUsd)} (at ${p.curatorFeePct}% fee)`);

  lines.push(``);
  lines.push(`  Concentration:`);
  lines.push(`    By Underlying: ${formatConcentration(p.concentrationByUnderlying)}`);
  lines.push(`    By Chain: ${formatConcentration(p.concentrationByChain)}`);

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

  if (p.actionItems.length > 0) {
    lines.push(``);
    lines.push(`  Action Items (cross-vault):`);
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

// ── Tool registration ────────────────────────────────────────────────────

export function register(server: McpServer): void {
  server.tool(
    "mv_get_curator_portfolio",
    `Aggregate multiple MetaVaults managed by a single curator into one portfolio view.

Supports two modes:
  1. Discovery mode: provide curator_address to scan all chains and find MetaVaults
     where the curator's address matches the vault's curator.addresses array.
  2. Explicit mode: provide metavault_addresses as a JSON array of {chain, address}
     pairs to aggregate specific vaults.

If both are provided, metavault_addresses takes priority (explicit over discovery).

Returns:
  - Total AUM across all vaults
  - Blended APY (TVL-weighted)
  - Projected annual fee revenue at the configured curator fee
  - Concentration by underlying asset and by chain
  - Per-vault summary with position count and action items
  - Cross-vault action items (expiring positions, idle capital, etc.)

Use spectra_get_curator_dashboard for deep-dive into a specific vault.
Use morpho_monitor_risk for Morpho position health across the curator's address.
Use spectra_stress_test_vault for withdrawal simulation on a specific vault.`,
    {
      curator_address: EVM_ADDRESS
        .optional()
        .describe("Curator wallet address. Scans all chains for MetaVaults managed by this address."),
      metavault_addresses: z
        .array(z.object({
          chain: CHAIN_ENUM,
          address: EVM_ADDRESS,
        }))
        .optional()
        .describe("Explicit list of MetaVault {chain, address} pairs to aggregate. Takes priority over curator_address."),
      curator_fee_pct: z
        .number()
        .min(0)
        .max(100)
        .default(10)
        .describe("Curator performance fee as % of vault yield (default 10%). Used for fee revenue projection."),
    },
    async ({ curator_address, metavault_addresses, curator_fee_pct }) => {
      try {
        // Validate that at least one discovery method is provided
        if (!curator_address && !metavault_addresses) {
          const text = `Error: provide either curator_address (to discover vaults) or metavault_addresses (explicit list). Use spectra_list_metavaults() to find curator addresses and vault addresses.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const vaultSummaries: CuratorVaultSummary[] = [];

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
              return matched.map((mv) => summarizeVault(mv, chain));
            },
          );

          const results = await Promise.allSettled(fetchPromises);
          for (const r of results) {
            if (r.status === "fulfilled") {
              vaultSummaries.push(...r.value);
            }
          }
        } else if (curator_address) {
          // ── Discovery mode: scan all chains for curator match ──
          const { metavaults } = await scanAllMetavaults();

          const curatorLower = curator_address.toLowerCase();
          for (const { metavault, chain } of metavaults) {
            const curatorAddresses = metavault.curator?.addresses || [];
            const match = curatorAddresses.some(
              (addr) => addr.toLowerCase() === curatorLower,
            );
            if (match) {
              vaultSummaries.push(summarizeVault(metavault, chain));
            }
          }

          if (vaultSummaries.length === 0) {
            const text = `No MetaVaults found for curator ${curator_address} across any chain.\nUse spectra_list_metavaults() to browse available MetaVaults and verify the curator address.`;
            return { content: [{ type: "text" as const, text }] };
          }
        }

        if (vaultSummaries.length === 0) {
          const text = `No MetaVaults found matching the provided addresses.\nVerify the chain and address values. Use spectra_list_metavaults() to discover available vaults.`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Sort vaults by TVL descending
        vaultSummaries.sort((a, b) => b.tvlUsd - a.tvlUsd);

        const portfolio = buildPortfolio(
          vaultSummaries,
          metavault_addresses ? null : (curator_address || null),
          curator_fee_pct,
        );

        const text = formatCuratorPortfolio(portfolio);
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `mv_get_curator_portfolio error: ${e.message || e}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}
