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
import { formatUsd, formatPct, daysToMaturity } from "../formatters.js";
import { classifyForStress, COST_MODELS } from "../protocols/index.js";
import type { TypedExternalPosition } from "../protocols/index.js";

export function register(server: McpServer): void {
  server.tool(
    "spectra_stress_test_vault",
    `Simulate a large redemption on a MetaVault to assess withdrawal liquidity.

Builds a liquidity waterfall — sources of cash ordered by cost:
  Tier 1:  Unallocated Cash (undeployed, no external — instant, no cost)
  Tier 1b: Avant Redemption Queue (avUSDx → avUSD burn, ~1 week cooldown per
           Avant docs, no price impact — emitted only when avant external
           positions exist; EXCLUDED from within-epoch max-safe calculation
           due to the delay, INCLUDED in the separate within-1-week metric)
  Tier 2:  Naturally maturing Spectra LP positions (no cost, time-dependent)
  Tier 3:  LP removal from Curve/Pendle pools (low-medium impact)
  Tier 4:  PT sale on Curve pool (higher impact)

Note: "Unallocated" replaces the old "Idle" label. External positions (avant
burn, pendle LP) are NOT counted in Tier 1 — they surface as Tier 1b (avant)
or are excluded from all tiers (pendle external, conservative error mode).

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

        // ── Bridge data for cross-chain risk ──
        const bridgePendingUsd = mv.bridge?.totalPendingUsd || 0;

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

          // Detect cross-chain: position or pool lives on a different chain than the MetaVault
          const isCrossChain =
            (pos.chainId != null && pos.chainId !== mv.chainId) ||
            (pool?.chainId != null && pool.chainId !== mv.chainId);

          return {
            symbol: pos.symbol,
            maturityDays: matDays,
            expired,
            allocationUsd: vaultAllocationUsd || 0,
            poolLiquidityUsd: poolTvlUsd,
            poolAddress: pool?.address || null,
            isCrossChain,
          };
        });

        // Classify externalPositions via the protocol registry (Phase 3).
        // AP-1: every externalPosition's valueUsd subtracts from idle
        // regardless of stressExclude — only tier placement + max-safe
        // inclusion are gated by the flag.
        const externalClassified = (mv.externalPositions || []).map((ext) => ({
          ext: ext as unknown as TypedExternalPosition,
          valueUsd: ext.valueUsd || 0,
          classification: classifyForStress(ext as unknown as TypedExternalPosition, mv.chainId),
        }));

        const knownAllocTotal = positions.reduce((s, p) => s + p.allocationUsd, 0);
        const externalTotalUsd = externalClassified.reduce((s, e) => s + e.valueUsd, 0);
        const idleCapitalUsd = Math.max(0, vaultTvl - knownAllocTotal - externalTotalUsd);

        // Zero-cost queued redemptions get a dedicated tier (avant-shaped).
        // Classifier-driven: any externalPosition with costModelName="zero"
        // and stressExclude=false qualifies. New protocols with this shape
        // flow through without edits here.
        const externalQueueTier = externalClassified.filter(
          (e) => !e.classification.stressExclude && e.valueUsd > 0 && e.classification.costModelName === "zero",
        );
        const externalQueueTotalUsd = externalQueueTier.reduce((s, e) => s + e.valueUsd, 0);

        // ── Build waterfall ──
        const waterfall: WithdrawalWaterfallTier[] = [];
        let remaining = redemptionUsd;
        let cumulative = 0;
        const remainingTvlAfter = vaultTvl - redemptionUsd;

        // Tier 1: Unallocated cash (truly undeployed — not in LP, not in external)
        const tier1Available = Math.min(idleCapitalUsd, remaining);
        cumulative += tier1Available;
        remaining -= tier1Available;
        waterfall.push({
          name: "Unallocated Cash",
          description: externalTotalUsd > 0
            ? `Undeployed cash in the vault (${formatUsd(externalTotalUsd)} in external positions counted separately)`
            : "Undeployed cash in the vault",
          availableUsd: tier1Available,
          coveragePct: redemptionUsd > 0 ? (tier1Available / redemptionUsd) * 100 : 0,
          estimatedCostUsd: 0,
          estimatedCostPct: 0,
          cumulativeCoverageUsd: cumulative,
        });

        // Tier 1b: External redemption queue — zero-cost, delayed settlement.
        // Classifier-driven. Observation boundary: the settlement window is
        // protocol-side; a CCTP bridge back to the home chain may add latency.
        if (externalQueueTotalUsd > 0) {
          const tier1bAvailable = Math.min(externalQueueTotalUsd, remaining);
          cumulative += tier1bAvailable;
          remaining -= tier1bAvailable;
          const protocols = [...new Set(externalQueueTier.map((e) => e.ext.protocol))];
          const proto = protocols[0];
          const tierName =
            protocols.length === 1
              ? `${proto[0].toUpperCase()}${proto.slice(1)} Redemption Queue`
              : "External Redemption Queue";
          const tierDesc =
            protocols.length === 1
              ? `${externalQueueTier[0].classification.windowLabelRendered} (no price impact)`
              : `${protocols.length} protocol queues combined`;
          waterfall.push({
            name: tierName,
            description: tierDesc,
            availableUsd: tier1bAvailable,
            coveragePct: redemptionUsd > 0 ? (tier1bAvailable / redemptionUsd) * 100 : 0,
            estimatedCostUsd: 0,
            estimatedCostPct: 0,
            cumulativeCoverageUsd: cumulative,
          });
        }

        // Tier 2: Maturing positions (within 7 days) — same-chain only
        // Cross-chain maturing positions need bridge settlement, so they can't be
        // counted as free liquidity within one epoch.
        const maturingSameChain = positions.filter((p) => (p.maturityDays <= 7 || p.expired) && !p.isCrossChain);
        const maturingCrossChain = positions.filter((p) => (p.maturityDays <= 7 || p.expired) && p.isCrossChain);
        const tier2Available = Math.min(
          maturingSameChain.reduce((s, p) => s + p.allocationUsd, 0),
          remaining,
        );
        cumulative += tier2Available;
        remaining -= tier2Available;
        const tier2Desc = maturingCrossChain.length > 0
          ? `${maturingSameChain.length} same-chain position(s) expiring within 7 days (${maturingCrossChain.length} cross-chain excluded — bridge latency)`
          : `${maturingSameChain.length} position(s) expiring within 7 days`;
        waterfall.push({
          name: "Maturing Positions",
          description: tier2Desc,
          availableUsd: tier2Available,
          coveragePct: redemptionUsd > 0 ? (tier2Available / redemptionUsd) * 100 : 0,
          estimatedCostUsd: 0,
          estimatedCostPct: 0,
          cumulativeCoverageUsd: cumulative,
        });

        // Tier 3: LP removal — same-chain first, then cross-chain with bridge penalty
        const activePositions = positions.filter((p) => !p.expired && p.maturityDays > 7);
        // Include cross-chain maturing positions here (they need LP exit + bridge settlement)
        const crossChainMaturingActive = maturingCrossChain;
        const allActiveSameChain = activePositions.filter((p) => !p.isCrossChain);
        const allActiveCrossChain = [
          ...crossChainMaturingActive,
          ...activePositions.filter((p) => p.isCrossChain),
        ];

        // LP cost helpers via registry (1.5x cross-chain handled in model).
        // Shared by Tier 3, Tier 4, and both max-safe binary searches.
        const lpSame = (amt: number, depth: number) =>
          COST_MODELS.lp_exit_samechain({ amountUsd: amt, poolLiquidityUsd: depth, stressMultiplier });
        const lpCross = (amt: number, depth: number) =>
          COST_MODELS.lp_exit_crosschain_cctp({ amountUsd: amt, poolLiquidityUsd: depth, stressMultiplier });

        // Tier 3 LP removal
        let tier3Available = 0;
        let tier3Cost = 0;
        for (const pos of allActiveSameChain) {
          if (remaining <= 0) break;
          const removable = Math.min(pos.allocationUsd, remaining);
          tier3Available += removable;
          tier3Cost += lpSame(removable, pos.poolLiquidityUsd);
          remaining -= removable;
        }
        for (const pos of allActiveCrossChain) {
          if (remaining <= 0) break;
          const removable = Math.min(pos.allocationUsd, remaining);
          tier3Available += removable;
          tier3Cost += lpCross(removable, pos.poolLiquidityUsd);
          remaining -= removable;
        }
        cumulative += tier3Available;
        const tier3CrossCount = allActiveCrossChain.filter((p) => p.allocationUsd > 0).length;
        const tier3Desc = tier3CrossCount > 0
          ? `Remove liquidity from ${allActiveSameChain.length + allActiveCrossChain.length} pool(s) (${tier3CrossCount} cross-chain, 1.5x impact penalty)`
          : `Remove liquidity from ${allActiveSameChain.length} active pool(s)`;
        waterfall.push({
          name: "LP Removal",
          description: tier3Desc,
          availableUsd: tier3Available,
          coveragePct: redemptionUsd > 0 ? (tier3Available / redemptionUsd) * 100 : 0,
          estimatedCostUsd: tier3Cost,
          estimatedCostPct: remainingTvlAfter > 0 ? (tier3Cost / remainingTvlAfter) * 100 : 0,
          cumulativeCoverageUsd: cumulative,
        });

        // Tier 4: PT sale — 2× LP-exit impact (factor outside the registry;
        // future `pt_sale_*` cost models would replace this literal).
        const PT_SALE_IMPACT_FACTOR = 2;
        let tier4Available = 0;
        let tier4Cost = 0;
        if (remaining > 0) {
          for (const pos of allActiveSameChain) {
            if (remaining <= 0) break;
            const ptSellable = Math.min(pos.allocationUsd * 0.5, remaining);
            tier4Available += ptSellable;
            tier4Cost += lpSame(ptSellable, pos.poolLiquidityUsd) * PT_SALE_IMPACT_FACTOR;
            remaining -= ptSellable;
          }
          for (const pos of allActiveCrossChain) {
            if (remaining <= 0) break;
            const ptSellable = Math.min(pos.allocationUsd * 0.5, remaining);
            tier4Available += ptSellable;
            tier4Cost += lpCross(ptSellable, pos.poolLiquidityUsd) * PT_SALE_IMPACT_FACTOR;
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

        // ── Cross-chain summary ──
        const crossChainPositions = positions
          .filter((p) => p.isCrossChain && p.allocationUsd > 0)
          .map((p) => ({ symbol: p.symbol, allocationUsd: p.allocationUsd }));
        const crossChainTotalUsd = crossChainPositions.reduce((s, p) => s + p.allocationUsd, 0);

        // ── Max-safe binary search ──
        // Within-epoch: external queue EXCLUDED (settlement > 1 epoch).
        // Within-1-week: external queue included if settlementDaysTypical ≤ 7.
        const sameChainMaturingTotal = maturingSameChain.reduce((s, p) => s + p.allocationUsd, 0);

        function maxSafeBinarySearch(includeQueueUsd: number): number {
          let safe = 0;
          for (let testPct = 1; testPct <= 100; testPct++) {
            const testAmount = vaultTvl * (testPct / 100);
            const testRemaining = vaultTvl - testAmount;
            if (testRemaining <= 0) break;
            let testRem = testAmount;
            let testCost = 0;
            // Tier 1: idle
            testRem -= Math.min(idleCapitalUsd, testRem);
            // Tier 1b: external redemption queue (only when called with queue)
            testRem -= Math.min(includeQueueUsd, testRem);
            // Tier 2: same-chain maturing
            testRem -= Math.min(sameChainMaturingTotal, testRem);
            // Tier 3: LP removal — same-chain then cross-chain
            for (const pos of allActiveSameChain) {
              if (testRem <= 0) break;
              const removable = Math.min(pos.allocationUsd, testRem);
              testCost += lpSame(removable, pos.poolLiquidityUsd);
              testRem -= removable;
            }
            for (const pos of allActiveCrossChain) {
              if (testRem <= 0) break;
              const removable = Math.min(pos.allocationUsd, testRem);
              testCost += lpCross(removable, pos.poolLiquidityUsd);
              testRem -= removable;
            }
            // Tier 4: PT sale (2× LP impact)
            for (const pos of allActiveSameChain) {
              if (testRem <= 0) break;
              const ptSellable = Math.min(pos.allocationUsd * 0.5, testRem);
              testCost += lpSame(ptSellable, pos.poolLiquidityUsd) * PT_SALE_IMPACT_FACTOR;
              testRem -= ptSellable;
            }
            for (const pos of allActiveCrossChain) {
              if (testRem <= 0) break;
              const ptSellable = Math.min(pos.allocationUsd * 0.5, testRem);
              testCost += lpCross(ptSellable, pos.poolLiquidityUsd) * PT_SALE_IMPACT_FACTOR;
              testRem -= ptSellable;
            }
            if (testRem > 0) break;
            if (testCost / testRemaining <= 0.01) {
              safe = testPct;
            } else {
              break;
            }
          }
          return safe;
        }

        // Within-1-week eligibility: queue position's settlementDaysTypical ≤ 7.
        const withinWeekQueueTotalUsd = externalQueueTier
          .filter((e) => {
            const d = e.classification.settlementDaysTypical;
            return typeof d === "number" && d <= 7;
          })
          .reduce((s, e) => s + e.valueUsd, 0);

        const maxSafePct = maxSafeBinarySearch(0);
        const maxSafeWithinWeekPct = maxSafeBinarySearch(withinWeekQueueTotalUsd);

        // ── Incentive dependency context ──
        const apyBase = mv.liveApy?.details?.base || 0;
        const liveApyTotal = mv.liveApy?.total || 0;
        const incentiveDependencyPct = liveApyTotal > 0 && apyBase < liveApyTotal
          ? ((liveApyTotal - apyBase) / liveApyTotal) * 100
          : 0;

        // ── Maturity timing analysis ──
        // If coverage depends on Tier 2 (maturing positions), surface the timing dependency
        const maturingCoverageUsd = waterfall.length >= 2 ? waterfall[1].availableUsd : 0;
        const maturingCoveragePct = redemptionUsd > 0 ? (maturingCoverageUsd / redemptionUsd) * 100 : 0;
        const nearestMaturityDays = maturingSameChain.length > 0
          ? Math.min(...maturingSameChain.map(p => p.maturityDays))
          : null;

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
          maxSafeWithinWeekPct,
          maxSafeWithinWeekUsd: vaultTvl * (maxSafeWithinWeekPct / 100),
          crossChainPositions,
          crossChainTotalUsd,
          bridgePendingUsd,
          incentiveDependencyPct,
          maturingCoveragePct,
          nearestMaturityDays,
          idlePct: vaultTvl > 0 ? (idleCapitalUsd / vaultTvl) * 100 : 0,
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
  lines.push(`  Maximum Safe Redemption (< 1% loss, within-epoch): ${r.maxSafeRedemptionPct}% of TVL (${formatUsd(r.maxSafeRedemptionUsd)})`);
  // Show the longer-window metric only when it's materially larger — i.e.
  // when Avant queue (Tier 1b) adds coverage. Avoids redundant display on
  // vaults without avant external positions (where the two numbers are equal).
  if (r.maxSafeWithinWeekPct > r.maxSafeRedemptionPct) {
    lines.push(`  Maximum Safe Redemption (< 1% loss, within ~1 week): ${r.maxSafeWithinWeekPct}% of TVL (${formatUsd(r.maxSafeWithinWeekUsd)}) — includes Avant burn queue settlement`);
  }

  // ── Coverage quality assessment ──
  // "COVERED" alone collapses genuine ambiguity about WHY coverage exists
  if (r.totalCovered) {
    const qualityWarnings: string[] = [];

    // Timing dependency: if maturing positions provide >30% of coverage
    if (r.maturingCoveragePct > 30 && r.nearestMaturityDays !== null) {
      qualityWarnings.push(
        `Coverage depends ${r.maturingCoveragePct.toFixed(0)}% on maturing positions (nearest: ${r.nearestMaturityDays}d). ` +
        `If redemption arrives before maturity, coverage drops to Tier 3+ (LP removal with impact cost).`
      );
    }

    // Unallocated capital dependency: if Tier 1 covers most of it.
    // r.idlePct now means "unallocated" — truly undeployed cash, excluding
    // external positions (which are surfaced as their own tier).
    if (r.idlePct > 50) {
      qualityWarnings.push(
        `${r.idlePct.toFixed(0)}% of TVL is unallocated — coverage is easy but yield is being sacrificed. ` +
        `High unallocated ratio means the vault is not deploying capital.`
      );
    }

    // Incentive dependency: coverage is meaningless if TVL evaporates
    if (r.incentiveDependencyPct > 70) {
      qualityWarnings.push(
        `${r.incentiveDependencyPct.toFixed(0)}% of vault APY comes from incentive programs. ` +
        `If incentives end, depositors may redeem en masse — this stress test assumes current TVL holds.`
      );
    }

    if (qualityWarnings.length > 0) {
      lines.push(``);
      lines.push(`  Coverage Quality:`);
      for (const w of qualityWarnings) {
        lines.push(`    [!] ${w}`);
      }
    }
  }

  if (!r.totalCovered) {
    lines.push(``);
    lines.push(`  [!!!] SHORTFALL: Vault cannot cover ${r.redemptionPct}% redemption with available liquidity.`);
    lines.push(`  This means depositors would be queued — ERC-7540 requires fulfillment but`);
    lines.push(`  the vault lacks liquid assets. The curator must either:`);
    lines.push(`    - Wait for maturing positions to generate cash`);
    lines.push(`    - Deleverage Morpho positions (if applicable)`);
    lines.push(`    - Accept higher slippage on forced LP exits`);
  }

  // ── Cross-chain risk section ──
  if (r.crossChainPositions.length > 0) {
    lines.push(``);
    lines.push(`  Cross-Chain Exposure:`);
    for (const p of r.crossChainPositions) {
      lines.push(`    ${p.symbol}: ${formatUsd(p.allocationUsd)}`);
    }
    lines.push(`    Total cross-chain: ${formatUsd(r.crossChainTotalUsd)} (${formatPct((r.crossChainTotalUsd / r.tvlUsd) * 100)} of TVL)`);
    lines.push(`    Impact: 1.5x penalty applied — bridge latency + execution uncertainty`);
    lines.push(`    Maturing cross-chain positions excluded from Tier 2 (cannot settle within one epoch)`);
    if (r.bridgePendingUsd > 0) {
      lines.push(`    Bridge pending: ${formatUsd(r.bridgePendingUsd)} in-flight (adds settlement delay)`);
    }
  }

  lines.push(``);
  lines.push(`--- Considerations ---`);
  lines.push(`  - Impact estimates use a constant-product model (conservative lower bound)`);
  lines.push(`  - Real Curve StableSwap-NG pools are more capital-efficient — actual impact likely lower`);
  if (r.crossChainPositions.length > 0) {
    lines.push(`  - Cross-chain positions (${r.crossChainPositions.length}) have 1.5x impact penalty and are excluded from free-maturity tier`);
  }
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
