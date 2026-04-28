/**
 * Tool: mv_plan_rollover
 *
 * Position Rollover Planner for MetaVault curators.
 * Identifies expiring positions, scans for rollover candidates (Spectra + Pendle),
 * and ranks them by effective APY after transition costs.
 *
 * Reuses scanning primitives from scan_curator_opportunities logic:
 *   - scanAllChainPools (Spectra)
 *   - scanAllPendleMarkets (Pendle)
 *   - estimateLpDepositImpact (LP deposit model, not swap impact)
 *   - findMorphoMarketsForPts (looping availability)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, MORPHO_CHAIN_IDS } from "../config.js";
import type {
  SpectraMetavault,
  SpectraMetavaultPosition,
  RolloverCandidate,
} from "../types.js";
import {
  fetchMetavaults,
  scanAllChainPools,
  scanAllPendleMarkets,
  findMorphoMarketsForPts,
} from "../api.js";
import { getMeta } from "../protocols/index.js";
import {
  formatPct,
  formatUsd,
  formatDate,
  daysToMaturity,
  pendleDaysToMaturity,
  estimateLpDepositImpact,
  // MetaVault rollovers are LP operations (balanced IBT+PT deposit), not directional PT swaps.
  // Use LP deposit impact model instead of swap impact for accurate capacity assessment.
  normalizeUnderlyingSymbol,
  cumulativeLeverageAtLoop,
  formatMorphoLltv,
  getEffectiveLiquidityUsd,
  formatHaltCheckLine,
  formatPlatformLabel,
} from "../formatters.js";
import type { RolloverHaltCheckResult } from "../formatters.js";
import { readMetaVaultChainStateCached, projectChainReadInput } from "../chain-reads.js";
import type { ChainKey } from "../config.js";

// ─── Formatting helpers (inline, not in formatters.ts) ──────────────────────

function formatRolloverCandidate(c: RolloverCandidate, rank: number): string {
  const lines: string[] = [];
  // PR-D: dispatch via formatPlatformLabel instead of `c.protocol === "spectra" ? "[Spectra]" : "[Pendle]"`.
  const tag = `[${formatPlatformLabel(c.protocol)}]`;
  lines.push(`  #${rank} ${tag} ${c.name} (${c.chain})`);
  lines.push(`    Maturity: ${formatDate(c.maturityTimestamp)} (${c.daysToMaturity}d)`);
  lines.push(`    Implied APY: ${formatPct(c.impliedApy)}  |  LP APY: ${formatPct(c.lpApy)}`);
  lines.push(`    Entry Impact: ${formatPct(c.entryImpactPct)}  |  Effective APY: ${formatPct(c.effectiveApy)}`);
  lines.push(`    Liquidity: ${formatUsd(c.poolLiquidityUsd)}  |  PT TVL: ${formatUsd(c.tvlUsd)}`);

  if (c.yieldGapDays > 0) {
    lines.push(`    Yield Gap: ${c.yieldGapDays}d of zero yield during transition`);
  }
  if (c.overlapDays !== null && c.overlapDays > 0) {
    lines.push(`    Overlap: ${c.overlapDays}d of double capital requirement if entering before old matures`);
  }

  if (c.loopingAvailable && c.loopingNetApy !== null) {
    lines.push(`    Looping: ${formatPct(c.loopingNetApy)} net APY @${c.loopingLoops}x loops`);
  }

  if (c.warnings.length > 0) {
    for (const w of c.warnings) {
      lines.push(`    ⚠ ${w}`);
    }
  }

  return lines.join("\n");
}

function formatRolloverPlan(
  vaultName: string,
  chain: string,
  position: { symbol: string; daysToMaturity: number; maturityTimestamp: number; allocationUsd: number },
  candidates: RolloverCandidate[],
  totalBeforeTruncation?: number,
): string {
  const lines: string[] = [];
  lines.push(`-- Rollover: ${position.symbol} --`);
  lines.push(`  Current maturity: ${formatDate(position.maturityTimestamp)} (${position.daysToMaturity}d)`);
  lines.push(`  Allocation: ${formatUsd(position.allocationUsd)}`);
  lines.push(`  Vault: ${vaultName} (${chain})`);
  lines.push(``);

  if (candidates.length === 0) {
    lines.push(`  No rollover candidates found matching the underlying asset.`);
    lines.push(`  Consider: broader asset_filter, or creating a new Spectra pool for this underlying.`);
  } else {
    const truncNote = totalBeforeTruncation != null && totalBeforeTruncation > candidates.length
      ? ` (showing top ${candidates.length} of ${totalBeforeTruncation})`
      : "";
    lines.push(`  Rollover Candidates (${candidates.length})${truncNote}:`);
    for (let i = 0; i < candidates.length; i++) {
      lines.push(formatRolloverCandidate(candidates[i], i + 1));
    }
  }

  return lines.join("\n");
}

// ─── Tool registration ──────────────────────────────────────────────────────

export function register(server: McpServer): void {
  server.tool(
    "mv_plan_rollover",
    `Plan position rollovers for expiring MetaVault positions.

When a MetaVault position approaches maturity, the curator must:
(1) identify the next pool, (2) estimate transition costs,
(3) time the entry, (4) execute the rollover.

This tool automates steps 1-3 by scanning Spectra and Pendle for rollover
candidates matching the expiring position's underlying asset, computing entry
impact at the position's capital size, and ranking by effective APY.

Returns per expiring position: ranked list of rollover candidates with entry
impact, yield gap (days of zero yield during transition), overlap window
(if entering before old matures), and net effective APY after transition costs.

Use spectra_get_curator_dashboard to see which positions are approaching maturity.
Use mv_scan_curator_opportunities for broader cross-protocol opportunity discovery.
Use spectra_get_pool_capacity to assess depth at your capital size for specific candidates.`,
    {
      chain: CHAIN_ENUM
        .describe("The blockchain network where the MetaVault lives."),
      metavault_address: EVM_ADDRESS
        .describe("The MetaVault contract address. Use spectra_list_metavaults to discover addresses."),
      pt_address: EVM_ADDRESS
        .optional()
        .describe("Specific position PT address to plan rollover for. If omitted, plans for all positions expiring within 30 days."),
      max_maturity_days: z
        .number()
        .min(1)
        .max(365)
        .default(30)
        .describe("Plan rollovers for positions expiring within this many days (default 30). Ignored when pt_address is specified."),
      capital_usd: z
        .number()
        .positive()
        .optional()
        .describe("Override position size for impact calculation. If omitted, uses the position's current allocation."),
      top_n: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Number of top rollover candidates per position (default 5)."),
      include_looping: z
        .boolean()
        .default(true)
        .describe("Whether to check Morpho looping availability for candidates (default true)."),
      verify_onchain: z.boolean()
        .optional()
        .describe(
          "Pre-flight halt-check on the SOURCE MetaVault before showing rollover candidates. Off by default — the candidate ranking does NOT depend on chain-truth (it ranks on candidate pool liquidity + lpApy, not source TVL). " +
          "When true, reads the source vault's Safe + infraVault + secondaryVault via the same engine that powers spectra_get_curator_dashboard (5-min cache shared with the dashboard, so a curator who just rendered the dashboard hits cache for free). " +
          "A halt-check line at the top of the output flags catastrophic / topology-shifted conditions (paused, role-inversion, missing bytecode, broken accounting, wrapper-signature-broken) that should make the curator pause before executing any rollover. Failures degrade to [✗] — the candidate listing still renders. " +
          "Dissolution: if telemetry shows zero verify_onchain=true invocations within 60 days of ship, the flag is fossil.",
        ),
    },
    async ({
      chain,
      metavault_address,
      pt_address,
      max_maturity_days,
      capital_usd,
      top_n,
      include_looping,
      verify_onchain,
    }) => {
      try {
        // ── Fetch MetaVault data ──────────────────────────────────
        const mvs = await fetchMetavaults(chain);
        const mv = mvs.find(
          (m) => m.address.toLowerCase() === metavault_address.toLowerCase()
        );

        if (!mv) {
          const text = `MetaVault ${metavault_address} not found on ${chain}.\nUse spectra_list_metavaults(chain="${chain}") to discover available MetaVaults.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // ── Source-vault halt-check (Theme A Phase 4 sub-PR 2) ──────
        //
        // Off by default — candidate ranking is built from CANDIDATE pool
        // liquidity + lpApy, NOT from source-vault TVL, so chain-truth on
        // the source does not change the recommendation's load-bearing
        // inputs. What it DOES change: whether the curator should reason
        // on this source MV at all. A paused infraVault, a role-inverted
        // Safe, or a broken wrapper signature all mean "halt — the
        // rollover decision is unsound from the source side."
        //
        // Single-MV scope, no concurrency pool needed. Per-MV timeout 30s
        // matches sub-PR 1 (spectra_list_metavaults) — long enough for one
        // RPC fallback hop on a degraded chain, short enough that one bad
        // chain doesn't blow up the rollover output budget.
        //
        // Cache shared with spectra_get_curator_dashboard: a curator who
        // just rendered the dashboard hits cache for free (5-min TTL).
        // PR0 graceful degradation: any failure → [✗] line, candidates
        // still render.
        let haltCheckLine: string | null = null;
        if (verify_onchain) {
          const PER_MV_TIMEOUT_MS = 30_000;
          // Timer-leak fix (Sonnet+depth audit B2 on sub-PR 2; identical
          // pattern hot-fixed in sub-PR 1 at 378e409): store the setTimeout
          // handle so the engine winning the race doesn't leave a pending
          // 30s timer holding the event-loop reference.
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
            const chainInput = projectChainReadInput(mv);
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error(`chain-read timed out after ${PER_MV_TIMEOUT_MS}ms`)),
                PER_MV_TIMEOUT_MS,
              );
            });
            const state = await Promise.race([
              readMetaVaultChainStateCached(chain as ChainKey, chainInput, {
                forceRefresh: false,
              }),
              timeoutPromise,
            ]);
            const haltResult: RolloverHaltCheckResult = { kind: "ok", state };
            haltCheckLine = formatHaltCheckLine(haltResult);
          } catch (err: any) {
            console.error(
              `[mv_plan_rollover] halt-check failed for ${mv.address} on ${chain}: ${err?.message || err}`,
            );
            const haltResult: RolloverHaltCheckResult = {
              kind: "failed",
              error: err?.message || String(err),
            };
            haltCheckLine = formatHaltCheckLine(haltResult);
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
          }
        }

        // ── Identify expiring positions ───────────────────────────
        const underlyingSymbol = mv.underlying?.symbol || "";
        const underlyingPriceUsd = mv.underlying?.price?.usd || 0;
        const underlyingDecimals = mv.underlying?.decimals || 6;

        type ExpiringPosition = {
          symbol: string;
          ptAddress: string;
          poolAddress: string | null;
          maturityTimestamp: number;
          daysToMaturity: number;
          allocationUsd: number;
          underlyingNormalized: string;
          isExternal?: boolean;
          externalProtocol?: string;
        };

        const expiringPositions: ExpiringPosition[] = [];

        for (const pos of mv.positions || []) {
          const days = daysToMaturity(pos.maturity);
          const pool = pos.pools?.[0];

          // Compute allocation USD
          let allocUsd = 0;
          const rawBalance = pool?.lpt?.balance || pos.balance;
          if (rawBalance && pool?.lpt?.price?.usd) {
            const decimals = pool.lpt.decimals || 18;
            const raw = BigInt(rawBalance);
            const divisor = 10n ** BigInt(decimals);
            const lpBalance = Number(raw / divisor) + Number(raw % divisor) / Number(divisor);
            allocUsd = lpBalance * pool.lpt.price.usd;
          } else {
            allocUsd = pos.tvl?.usd || 0;
          }

          // Filter: specific PT or within maturity window
          if (pt_address) {
            if (pos.address.toLowerCase() !== pt_address.toLowerCase()) continue;
          } else {
            if (days > max_maturity_days) continue;
          }

          expiringPositions.push({
            symbol: pos.symbol,
            ptAddress: pos.address,
            poolAddress: pool?.address || null,
            maturityTimestamp: pos.maturity,
            daysToMaturity: days,
            allocationUsd: allocUsd,
            underlyingNormalized: normalizeUnderlyingSymbol(underlyingSymbol),
          });
        }

        // ── Spec §9 Phase 4: External maturities as first-class rollover candidates ──
        // Driven by registry metadata — any protocol with actionItems.maturityFieldPath
        // registered is picked up. Zero-code protocol addition (spec §1 PR1).
        for (const ext of mv.externalPositions || []) {
          const extMeta = getMeta(ext.protocol);
          const maturityPath = extMeta.actionItems?.maturityFieldPath;
          if (!maturityPath) continue;

          let cur: unknown = ext;
          for (const part of maturityPath.split(".")) {
            if (cur == null || typeof cur !== "object") { cur = null; break; }
            cur = (cur as Record<string, unknown>)[part];
          }
          if (typeof cur !== "number" || !Number.isFinite(cur)) continue;
          const maturitySec = cur;

          const days = Math.floor((maturitySec - Math.floor(Date.now() / 1000)) / 86400);
          if (days > max_maturity_days) continue;
          if (days < 0) continue;

          const e = ext as { market?: { name?: string; address?: string } };
          const mname = e.market?.name || e.market?.address || `${extMeta.label} position`;
          const maddr = e.market?.address || mname;

          expiringPositions.push({
            symbol: mname,
            ptAddress: maddr,
            poolAddress: e.market?.address || null,
            maturityTimestamp: maturitySec,
            daysToMaturity: days,
            allocationUsd: ext.valueUsd || 0,
            underlyingNormalized: normalizeUnderlyingSymbol(underlyingSymbol),
            isExternal: true,
            externalProtocol: ext.protocol,
          });
        }

        if (expiringPositions.length === 0) {
          const msg = pt_address
            ? `Position ${pt_address} not found in MetaVault ${metavault_address}.`
            : `No positions expiring within ${max_maturity_days} days in MetaVault ${mv.metadata?.title || mv.name}.`;
          const headerLines: string[] = [
            `== Rollover Planner ==`,
            `  Vault: ${mv.metadata?.title || mv.name} (${chain})`,
          ];
          // Halt-check renders right after vault identification — the curator
          // sees source-vault health before being told there's nothing to roll.
          if (haltCheckLine) headerLines.push(haltCheckLine);
          headerLines.push(
            `  ${msg}`,
            ``,
            `  Tip: Use max_maturity_days to expand the window, or pt_address to target a specific position.`,
          );
          const text = headerLines.join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        // ── Scan for rollover candidates (Spectra + Pendle) ──────
        const targetUnderlying = expiringPositions[0].underlyingNormalized;

        const [spectraResult, pendleResult] = await Promise.all([
          scanAllChainPools({
            min_tvl_usd: 5000,
            min_liquidity_usd: 2000,
            asset_filter: targetUnderlying,
          }),
          scanAllPendleMarkets({
            min_tvl_usd: 5000,
            min_liquidity_usd: 2000,
            asset_filter: targetUnderlying,
          }),
        ]);

        // ── Optionally fetch Morpho looping data ─────────────────
        let morphoMap = new Map<string, any>();
        if (include_looping) {
          const spectraPtAddresses = spectraResult.opportunities
            .filter(({ chain: c }) => MORPHO_CHAIN_IDS[c] !== undefined)
            .map(({ pt, chain: c }) => ({ address: pt.address, chain: c }));

          if (spectraPtAddresses.length > 0) {
            // Group by chain to avoid querying only the first chain's markets
            const ptsByChain: Record<string, string[]> = {};
            for (const { address, chain: c } of spectraPtAddresses) {
              if (!ptsByChain[c]) ptsByChain[c] = [];
              ptsByChain[c].push(address);
            }

            const morphoResults = await Promise.allSettled(
              Object.entries(ptsByChain).map(async ([c, addrs]) => {
                const markets = await findMorphoMarketsForPts([...new Set(addrs)], c);
                return markets;
              })
            );

            // Merge all chain results into a single map
            for (const result of morphoResults) {
              if (result.status === "fulfilled") {
                for (const [k, v] of result.value) {
                  morphoMap.set(k, v);
                }
              }
            }
          }
        }

        // ── Build rollover plans per expiring position ────────────
        const outputSections: string[] = [];

        outputSections.push(`== Rollover Planner ==`);
        outputSections.push(`  Vault: ${mv.metadata?.title || mv.name} (${chain})`);
        // Halt-check sits at the TOP — between vault identification and the
        // body — so a curator sees catastrophic source-vault conditions
        // before reading any candidate listing. Skipped silently when
        // verify_onchain=false; off-by-default behavior is byte-identical
        // to the pre-Phase-4 output.
        if (haltCheckLine) outputSections.push(haltCheckLine);
        outputSections.push(`  Underlying: ${underlyingSymbol}`);
        outputSections.push(`  Expiring positions: ${expiringPositions.length}`);
        outputSections.push(``);

        for (const pos of expiringPositions) {
          const capitalForImpact = capital_usd || pos.allocationUsd || 10000;
          const candidates: RolloverCandidate[] = [];

          // ── Spectra candidates ──────────────────────────
          for (const { pt, pool, chain: candChain } of spectraResult.opportunities) {
            // Skip the position we're rolling out of
            if (pt.address.toLowerCase() === pos.ptAddress.toLowerCase()) continue;

            const impliedApy = pool.impliedApy || 0;
            const lpApy = pool.lpApy?.total || 0;
            const poolLiqUsd = pool.liquidity?.usd || 0;
            const tvlUsd = pt.tvl?.usd || 0;
            const matTs = pt.maturity;
            const days = daysToMaturity(matTs);

            // Skip expired or very short maturity candidates
            if (days <= 7) continue;

            // MetaVault rollovers are LP operations — use LP deposit impact, not swap impact
            const impactFrac = estimateLpDepositImpact(capitalForImpact, poolLiqUsd);
            const impactPct = impactFrac * 100;
            const annualizedEntryCost = days > 0
              ? impactFrac * (365 / days) * 100
              : impactFrac * 100;
            const effectiveApy = impliedApy - annualizedEntryCost;

            // Yield gap: days between old maturity and new entry (0 if overlap)
            const oldMaturityDate = pos.maturityTimestamp * 1000;
            const nowMs = Date.now();
            const yieldGapDays = oldMaturityDate > nowMs
              ? Math.max(0, Math.ceil((oldMaturityDate - nowMs) / 86400000))
              : 0;

            // Overlap: if entering now, days of running both positions
            const overlapDays = pos.daysToMaturity > 0 ? pos.daysToMaturity : null;

            // Looping
            let loopingAvailable = false;
            let loopingNetApy: number | null = null;
            let loopingLoops: number | null = null;

            const morphoMarket = morphoMap.get(pt.address.toLowerCase());
            if (morphoMarket) {
              loopingAvailable = true;
              const lltv = formatMorphoLltv(morphoMarket.lltv);
              const borrowRate = morphoMarket.state?.borrowApy != null
                ? morphoMarket.state.borrowApy * 100
                : 5;
              // Find optimal loop
              let bestNet = impliedApy;
              let bestLoops = 0;
              for (let l = 1; l <= 5; l++) {
                const leverage = cumulativeLeverageAtLoop(lltv, l);
                const gross = impliedApy * leverage;
                const borrow = borrowRate * (leverage - 1);
                const net = gross - borrow;
                if (net > bestNet) {
                  bestNet = net;
                  bestLoops = l;
                }
              }
              if (bestLoops > 0) {
                loopingNetApy = bestNet;
                loopingLoops = bestLoops;
              }
            }

            const warnings: string[] = [];
            if (impactPct > 0.5) warnings.push(`LP deposit imbalance fee ${formatPct(impactPct)} may be significant at ${formatUsd(capitalForImpact)}`);
            if (poolLiqUsd > 0 && capitalForImpact / poolLiqUsd > 0.3) {
              const shareEst = ((capitalForImpact / (poolLiqUsd + capitalForImpact)) * 100).toFixed(0);
              warnings.push(`Your allocation would be ~${shareEst}% of pool — concentration risk. Check spectra_get_pool_activity for existing LP concentration.`);
            } else if (poolLiqUsd < capitalForImpact * 0.5) {
              warnings.push(`Pool liquidity (${formatUsd(poolLiqUsd)}) — your LP share would exceed 50%`);
            }
            if (candChain !== chain) warnings.push(`Cross-chain rollover (${chain} → ${candChain}) requires bridge transfer`);

            candidates.push({
              protocol: "spectra",
              chain: candChain,
              name: pt.name,
              ptAddress: pt.address,
              poolAddress: pool.address || null,
              impliedApy,
              lpApy,
              effectiveApy,
              entryImpactPct: impactPct,
              daysToMaturity: days,
              maturityTimestamp: matTs,
              tvlUsd,
              poolLiquidityUsd: poolLiqUsd,
              yieldGapDays,
              overlapDays,
              loopingAvailable,
              loopingNetApy,
              loopingLoops,
              warnings,
            });
          }

          // ── Pendle candidates ───────────────────────────
          for (const { market, chain: candChain } of pendleResult.markets) {
            const impliedApy = (market.details?.impliedApy || 0) * 100;
            const lpApy = (market.details?.aggregatedApy || 0) * 100;
            const poolLiqUsd = market.details?.liquidity || 0;
            const tvlUsd = market.details?.totalTvl || 0;
            const days = pendleDaysToMaturity(market.expiry);

            if (days <= 7) continue;

            // MetaVault rollovers are LP operations — use LP deposit impact
            const impactFrac = estimateLpDepositImpact(capitalForImpact, poolLiqUsd);
            const impactPct = impactFrac * 100;
            const annualizedEntryCost = days > 0
              ? impactFrac * (365 / days) * 100
              : impactFrac * 100;
            const effectiveApy = impliedApy - annualizedEntryCost;

            const matTs = Math.floor(new Date(market.expiry).getTime() / 1000);
            const oldMaturityDate = pos.maturityTimestamp * 1000;
            const nowMs = Date.now();
            const yieldGapDays = oldMaturityDate > nowMs
              ? Math.max(0, Math.ceil((oldMaturityDate - nowMs) / 86400000))
              : 0;
            const overlapDays = pos.daysToMaturity > 0 ? pos.daysToMaturity : null;

            const warnings: string[] = [];
            if (impactPct > 0.5) warnings.push(`LP deposit imbalance fee ${formatPct(impactPct)} may be significant`);
            if (poolLiqUsd < capitalForImpact * 0.5) warnings.push(`Pool liquidity thin — LP share would exceed 50%`);
            if (candChain !== chain) warnings.push(`Cross-chain rollover requires bridge transfer`);
            warnings.push(`Pendle positions require manual rollover (no MetaVault auto-roll)`);

            candidates.push({
              protocol: "pendle",
              chain: candChain,
              name: market.name,
              ptAddress: market.pt,
              poolAddress: market.address,
              impliedApy,
              lpApy,
              effectiveApy,
              entryImpactPct: impactPct,
              daysToMaturity: days,
              maturityTimestamp: matTs,
              tvlUsd,
              poolLiquidityUsd: poolLiqUsd,
              yieldGapDays,
              overlapDays,
              loopingAvailable: false,
              loopingNetApy: null,
              loopingLoops: null,
              warnings,
            });
          }

          // ── Sort by effective APY (or looping net APY if available) ──
          candidates.sort((a, b) => {
            const aSort = (a.loopingAvailable && a.loopingNetApy !== null) ? a.loopingNetApy : a.effectiveApy;
            const bSort = (b.loopingAvailable && b.loopingNetApy !== null) ? b.loopingNetApy : b.effectiveApy;
            return bSort - aSort;
          });

          const topCandidates = candidates.slice(0, top_n);

          outputSections.push(formatRolloverPlan(
            mv.metadata?.title || mv.name,
            chain,
            pos,
            topCandidates,
            candidates.length,  // total before truncation
          ));
          outputSections.push(``);
        }

        // ── Observation Boundaries ─────────────────────────────────
        outputSections.push(`--- What This Ranking Cannot See ---`);
        outputSections.push(`  - Liquidity concentration: pool TVL may be dominated by 1-3 addresses. A high-liquidity pool`);
        outputSections.push(`    where 80% comes from one whale is fragile — they withdraw, your LP share becomes illiquid.`);
        outputSections.push(`    Use spectra_get_pool_activity(chain, pool_address) on top candidates to check address concentration.`);
        outputSections.push(`  - Rate stability: the implied APY shown is a snapshot. Pools with volatile APY histories may`);
        outputSections.push(`    offer different rates by the time you enter. Use spectra_get_pool_volume for trading pattern stability.`);
        outputSections.push(`  - Gauge vote timing: LP APY includes gauge emissions which reset at each gauge vote.`);
        outputSections.push(`    A candidate ranked #1 on gauge-boosted APY may drop to #3 after the next vote cycle.`);
        outputSections.push(`  - This ranking is sorted by effective APY. A candidate with 0.5% lower APY but 10x deeper`);
        outputSections.push(`    liquidity may be structurally safer for a large MetaVault allocation.`);
        outputSections.push(``);

        // ── Considerations ────────────────────────────────────────
        outputSections.push(`--- Considerations ---`);
        outputSections.push(`  - Entry impact uses LP deposit imbalance model (not swap impact) — MetaVault rollovers are balanced LP deposits`);
        outputSections.push(`  - Yield gap assumes instantaneous redemption + re-entry. Real transitions involve bridge latency and gas costs`);
        outputSections.push(`  - Overlap window shows double capital requirement — relevant if entering new position before old matures`);
        outputSections.push(`  - Looping availability does not guarantee sufficient Morpho liquidity at your capital size`);

        // ── Next Steps ────────────────────────────────────────────
        outputSections.push(``);
        outputSections.push(`--- Next Steps ---`);
        outputSections.push(`  • Quote entry: spectra_quote_trade(chain, pt_address, amount, side="buy") for exact on-chain quote`);
        outputSections.push(`  • Pool depth: spectra_get_pool_capacity(chain, pt_address) for impact curve at various sizes`);
        outputSections.push(`  • IBT health: mv_check_ibt_health(chain, pt_address) for underlying safety check`);
        outputSections.push(`  • Looping detail: spectra_get_looping_strategy(chain, pt_address) for full leverage table`);
        outputSections.push(`  • Dashboard: spectra_get_curator_dashboard(chain, metavault_address) for vault overview`);

        const text = outputSections.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error planning rollover: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
