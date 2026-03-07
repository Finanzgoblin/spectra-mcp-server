/**
 * Tool: spectra_stress_test_vault
 *
 * Withdrawal stress test for MetaVaults. Simulates a large redemption
 * and builds a liquidity waterfall showing how the vault would generate
 * cash to meet it, with cost estimates for remaining depositors.
 *
 * ERC-7540 constraint: once a depositor requests redemption, the vault
 * MUST fulfill it. There is no cancelRequest mechanism.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { StressTestResult, WithdrawalWaterfallTier } from "../types.js";
import { CHAIN_ENUM, EVM_ADDRESS } from "../config.js";
import { fetchMetavaults } from "../api.js";
import { formatUsd, formatPct, daysToMaturity, estimatePriceImpact } from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "spectra_stress_test_vault",
    `Simulate a large redemption on a MetaVault to assess withdrawal liquidity.

Builds a liquidity waterfall — sources of cash ordered by cost:
  Tier 1: Idle capital (no cost)
  Tier 2: Naturally maturing positions (no cost, time-dependent)
  Tier 3: LP removal from Curve/Pendle pools (low-medium impact)
  Tier 4: PT sale on Curve pool (higher impact)

Computes total coverage, cost to remaining depositors, and maximum safe
redemption size (< 1% loss to remaining holders).

ERC-7540 constraint: once redemption is requested, the vault MUST fulfill it.
There is no cancelRequest. This makes withdrawal liquidity critical.

Use spectra_get_curator_dashboard for operational overview before stress testing.
Use spectra_get_pool_capacity to assess individual pool depth.
Use morpho_monitor_risk for Morpho position risk.`,
    {
      chain: CHAIN_ENUM
        .describe("The blockchain network where the MetaVault lives."),
      metavault_address: EVM_ADDRESS
        .describe("The MetaVault contract address. Use spectra_list_metavaults to discover addresses."),
      redemption_pct: z
        .number()
        .min(1)
        .max(100)
        .default(30)
        .describe("% of TVL redeemed in one epoch (default 30)"),
      market_stress: z
        .boolean()
        .default(false)
        .describe("If true, assume 2x normal price impact on LP exits (correlated sell pressure)"),
    },
    async ({ chain, metavault_address, redemption_pct, market_stress }) => {
      try {
        // Fetch MetaVault data
        const mvs = await fetchMetavaults(chain);
        const mv = mvs.find(
          (m) => m.address.toLowerCase() === metavault_address.toLowerCase(),
        );

        if (!mv) {
          const text = `MetaVault ${metavault_address} not found on ${chain}.\nUse spectra_list_metavaults(chain="${chain}") to discover available MetaVaults.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const vaultTvl = mv.tvl?.usd || 0;
        if (vaultTvl <= 0) {
          const text = `MetaVault ${mv.name || metavault_address} has $0 TVL — nothing to stress test.`;
          return { content: [{ type: "text" as const, text }] };
        }

        const underlyingDecimals = mv.underlying?.decimals || 6;
        const underlyingPriceUsd = mv.underlying?.price?.usd || 0;
        const divisor = Math.pow(10, underlyingDecimals);

        const redemptionUsd = vaultTvl * (redemption_pct / 100);
        const stressMultiplier = market_stress ? 2 : 1;

        // ── Build positions with liquidity data ──
        const positions = (mv.positions || []).map((pos) => {
          const pool = pos.pools?.[0];
          const matDays = daysToMaturity(pos.maturity);
          const expired = pos.maturity * 1000 <= Date.now();

          let vaultAllocationUsd: number | null = null;
          const rawBalance = pool?.lpt?.balance || pos.balance;
          if (rawBalance && pool?.lpt?.price?.usd) {
            const decimals = pool.lpt.decimals || 18;
            const raw = BigInt(rawBalance);
            const d = 10n ** BigInt(decimals);
            const lpBalance = Number(raw / d) + Number(raw % d) / Number(d);
            vaultAllocationUsd = lpBalance * pool.lpt.price.usd;
          }

          // Pool liquidity: use position TVL as proxy for total pool liquidity
          // The vault's allocation is a fraction of the pool — pool TVL is typically larger
          const poolTvlUsd = pos.tvl?.usd || 0;

          return {
            symbol: pos.symbol,
            maturityDays: matDays,
            expired,
            allocationUsd: vaultAllocationUsd || 0,
            poolLiquidityUsd: poolTvlUsd,
            poolAddress: pool?.address || null,
            isCrossChain: false, // TODO: detect cross-chain positions via bridge data
          };
        });

        // ── Compute idle capital ──
        const knownAllocTotal = positions.reduce((s, p) => s + p.allocationUsd, 0);
        const idleCapitalUsd = Math.max(0, vaultTvl - knownAllocTotal);

        // ── Build waterfall ──
        const waterfall: WithdrawalWaterfallTier[] = [];
        let remaining = redemptionUsd;
        let cumulative = 0;
        const remainingTvlAfter = vaultTvl - redemptionUsd;

        // Tier 1: Idle capital
        const tier1Available = Math.min(idleCapitalUsd, remaining);
        cumulative += tier1Available;
        remaining -= tier1Available;
        waterfall.push({
          name: "Idle Capital",
          description: "Undeployed cash in the vault",
          availableUsd: tier1Available,
          coveragePct: redemptionUsd > 0 ? (tier1Available / redemptionUsd) * 100 : 0,
          estimatedCostUsd: 0,
          estimatedCostPct: 0,
          cumulativeCoverageUsd: cumulative,
        });

        // Tier 2: Maturing positions (within 7 days)
        const maturingPositions = positions.filter((p) => p.maturityDays <= 7 || p.expired);
        const tier2Available = Math.min(
          maturingPositions.reduce((s, p) => s + p.allocationUsd, 0),
          remaining,
        );
        cumulative += tier2Available;
        remaining -= tier2Available;
        waterfall.push({
          name: "Maturing Positions",
          description: `${maturingPositions.length} position(s) expiring within 7 days`,
          availableUsd: tier2Available,
          coveragePct: redemptionUsd > 0 ? (tier2Available / redemptionUsd) * 100 : 0,
          estimatedCostUsd: 0,
          estimatedCostPct: 0,
          cumulativeCoverageUsd: cumulative,
        });

        // Tier 3: LP removal
        const activePositions = positions.filter((p) => !p.expired && p.maturityDays > 7);
        let tier3Available = 0;
        let tier3Cost = 0;
        for (const pos of activePositions) {
          if (remaining <= 0) break;
          const removable = Math.min(pos.allocationUsd, remaining);
          const impact = estimatePriceImpact(removable, pos.poolLiquidityUsd) * stressMultiplier;
          const cost = removable * impact;
          tier3Available += removable;
          tier3Cost += cost;
          remaining -= removable;
        }
        cumulative += tier3Available;
        waterfall.push({
          name: "LP Removal",
          description: `Remove liquidity from ${activePositions.length} active pool(s)`,
          availableUsd: tier3Available,
          coveragePct: redemptionUsd > 0 ? (tier3Available / redemptionUsd) * 100 : 0,
          estimatedCostUsd: tier3Cost,
          estimatedCostPct: remainingTvlAfter > 0 ? (tier3Cost / remainingTvlAfter) * 100 : 0,
          cumulativeCoverageUsd: cumulative,
        });

        // Tier 4: PT sale (if LP removal wasn't enough, sell PT tokens with higher impact)
        // PT sale has ~2x the impact of LP removal since you're selling one side of the pair
        let tier4Available = 0;
        let tier4Cost = 0;
        if (remaining > 0) {
          for (const pos of activePositions) {
            if (remaining <= 0) break;
            // PT sale available is roughly the PT component of the LP (~50% of allocation)
            const ptSellable = Math.min(pos.allocationUsd * 0.5, remaining);
            const impact = estimatePriceImpact(ptSellable, pos.poolLiquidityUsd) * 2 * stressMultiplier;
            const cost = ptSellable * impact;
            tier4Available += ptSellable;
            tier4Cost += cost;
            remaining -= ptSellable;
          }
        }
        cumulative += tier4Available;
        waterfall.push({
          name: "PT Sale",
          description: "Sell PT tokens on Curve pool (higher impact than LP removal)",
          availableUsd: tier4Available,
          coveragePct: redemptionUsd > 0 ? (tier4Available / redemptionUsd) * 100 : 0,
          estimatedCostUsd: tier4Cost,
          estimatedCostPct: remainingTvlAfter > 0 ? (tier4Cost / remainingTvlAfter) * 100 : 0,
          cumulativeCoverageUsd: cumulative,
        });

        const totalCost = tier3Cost + tier4Cost;
        const totalCovered = cumulative >= redemptionUsd;

        // ── Compute max safe redemption (< 1% loss to remaining) ──
        // Binary search for the largest redemption where total cost < 1% of remaining TVL
        let maxSafePct = 0;
        for (let testPct = 1; testPct <= 100; testPct++) {
          const testAmount = vaultTvl * (testPct / 100);
          const testRemaining = vaultTvl - testAmount;
          if (testRemaining <= 0) break;

          let testRem = testAmount;
          let testCost = 0;

          // Tier 1: idle
          testRem -= Math.min(idleCapitalUsd, testRem);
          // Tier 2: maturing
          testRem -= Math.min(
            maturingPositions.reduce((s, p) => s + p.allocationUsd, 0),
            testRem,
          );
          // Tier 3: LP removal
          for (const pos of activePositions) {
            if (testRem <= 0) break;
            const removable = Math.min(pos.allocationUsd, testRem);
            testCost += removable * estimatePriceImpact(removable, pos.poolLiquidityUsd) * stressMultiplier;
            testRem -= removable;
          }
          // Tier 4: PT sale
          for (const pos of activePositions) {
            if (testRem <= 0) break;
            const ptSellable = Math.min(pos.allocationUsd * 0.5, testRem);
            testCost += ptSellable * estimatePriceImpact(ptSellable, pos.poolLiquidityUsd) * 2 * stressMultiplier;
            testRem -= ptSellable;
          }

          if (testRem > 0) break; // can't cover this amount
          if (testCost / testRemaining <= 0.01) {
            maxSafePct = testPct;
          } else {
            break; // once we exceed 1%, stop
          }
        }

        const result: StressTestResult = {
          vaultName: mv.name || mv.symbol || metavault_address,
          chain,
          vaultAddress: metavault_address,
          tvlUsd: vaultTvl,
          redemptionPct: redemption_pct,
          redemptionAmountUsd: redemptionUsd,
          marketStress: market_stress,
          waterfall,
          totalCovered,
          totalCostToRemainingUsd: totalCost,
          totalCostToRemainingPct: remainingTvlAfter > 0 ? (totalCost / remainingTvlAfter) * 100 : 0,
          maxSafeRedemptionPct: maxSafePct,
          maxSafeRedemptionUsd: vaultTvl * (maxSafePct / 100),
        };

        const text = formatStressTestResult(result);
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `spectra_stress_test_vault error: ${e.message || e}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}

// ── Inline formatter (self-contained for simplicity) ──

function formatStressTestResult(r: StressTestResult): string {
  const lines: string[] = [];

  lines.push(`== Withdrawal Stress Test ==`);
  lines.push(`  MetaVault: ${r.vaultName} (${r.chain})`);
  lines.push(`  TVL: ${formatUsd(r.tvlUsd)}  |  Scenario: ${r.redemptionPct}% redemption (${formatUsd(r.redemptionAmountUsd)})`);
  if (r.marketStress) {
    lines.push(`  Mode: MARKET STRESS (2x price impact assumed)`);
  }

  lines.push(``);
  lines.push(`  Liquidity Waterfall:`);

  for (const tier of r.waterfall) {
    const coverage = tier.coveragePct > 0 ? `covers ${formatPct(tier.coveragePct)}` : "covers 0%";
    const cost = tier.estimatedCostUsd > 0
      ? `  |  Est. impact: ${formatPct(tier.estimatedCostPct)} (${formatUsd(tier.estimatedCostUsd)})`
      : `  |  Cost: $0`;
    lines.push(`    ${tier.name}: ${formatUsd(tier.availableUsd)} (${coverage})${cost}`);
    if (tier.description) {
      lines.push(`      ${tier.description}`);
    }
  }

  lines.push(``);
  const coverIcon = r.totalCovered ? "COVERED" : "SHORTFALL";
  const cumAvailable = r.waterfall.length > 0
    ? r.waterfall[r.waterfall.length - 1].cumulativeCoverageUsd
    : 0;
  lines.push(`  Coverage: ${formatUsd(cumAvailable)} available vs ${formatUsd(r.redemptionAmountUsd)} needed — ${coverIcon}`);
  lines.push(`  Total cost to remaining depositors: ${formatUsd(r.totalCostToRemainingUsd)} (${formatPct(r.totalCostToRemainingPct)} of remaining TVL)`);

  lines.push(``);
  lines.push(`  Maximum Safe Redemption (< 1% loss): ${r.maxSafeRedemptionPct}% of TVL (${formatUsd(r.maxSafeRedemptionUsd)})`);

  if (!r.totalCovered) {
    lines.push(``);
    lines.push(`  [!!!] SHORTFALL: Vault cannot cover ${r.redemptionPct}% redemption with available liquidity.`);
    lines.push(`  This means depositors would be queued — ERC-7540 requires fulfillment but`);
    lines.push(`  the vault lacks liquid assets. The curator must either:`);
    lines.push(`    - Wait for maturing positions to generate cash`);
    lines.push(`    - Deleverage Morpho positions (if applicable)`);
    lines.push(`    - Accept higher slippage on forced LP exits`);
  }

  lines.push(``);
  lines.push(`--- Considerations ---`);
  lines.push(`  - Impact estimates use a constant-product model (conservative lower bound)`);
  lines.push(`  - Real Curve StableSwap-NG pools are more capital-efficient — actual impact likely lower`);
  lines.push(`  - Cross-chain positions add bridge latency — may not be available within one epoch`);
  lines.push(`  - The "max safe redemption" assumes orderly exit — panic scenarios could cascade`);

  lines.push(``);
  lines.push(`--- Next Steps ---`);
  lines.push(`  • Pool depth: spectra_get_pool_capacity(chain, pt_address) — detailed impact curve per pool`);
  lines.push(`  • Risk monitor: morpho_monitor_risk(address) — check Morpho position health`);
  lines.push(`  • Dashboard: spectra_get_curator_dashboard(chain, metavault_address) — operational overview`);
  if (!r.marketStress) {
    lines.push(`  • Stress mode: spectra_stress_test_vault(..., market_stress=true) — test with 2x impact`);
  }

  return lines.join("\n");
}
