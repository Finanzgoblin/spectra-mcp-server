/**
 * Tool: mv_get_position_map
 *
 * The Cartographer's tool. Sees the whole position across all protocols —
 * Spectra, Pendle, Morpho, governance tokens — in one view.
 *
 * Open emergence principle: each protocol tool sees its own silo. This tool
 * sees the contradictions BETWEEN silos. "You're lending at 3% on Morpho
 * while 8% fixed is available on Spectra" is invisible to either tool alone.
 * The position map surfaces what the gaps between protocols hide.
 *
 * What it is NOT:
 * - Not a net worth calculator (swap prices change by the second)
 * - Not a portfolio optimizer (that's judgment, not perception)
 * - Not a replacement for per-protocol tools (they have deeper detail)
 *
 * What it IS:
 * - The first tool that sees the user, not just the protocol
 * - Cross-protocol contradiction detection
 * - Honest about what it can't see (failed chains, dead endpoints, missing tokens)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EVM_ADDRESS, CHAIN_ENUM, API_NETWORKS, SUPPORTED_CHAINS, resolveNetwork, MORPHO_CHAIN_IDS } from "../config.js";
import { fetchSpectra, fetchMorphoUserPositions, scanAllPendleUserPositions, fetchVeTotalSupply, fetchVeBalance, fetchVePendleTotalSupply, fetchVePendleBalance } from "../api.js";
import { formatUsd, formatPct, daysToMaturity, formatBalance } from "../formatters.js";
import type { SpectraPt, SpectraPool } from "../types.js";

export function register(server: McpServer): void {
  server.tool(
    "mv_get_position_map",
    `Cross-protocol position map — see the whole wallet across Spectra, Pendle, Morpho, and governance.

Each protocol tool sees its own silo. This tool sees the contradictions BETWEEN silos.
Calls all portfolio sources in parallel and composes a unified view with:
- Per-protocol position summaries with USD values
- Governance tokens (veSPECTRA on Base, vePENDLE if detectable)
- Cross-protocol totals with honest failure reporting
- Contradiction detection: lending vs fixed rate spreads, concentration risks,
  expiring positions across protocols, governance boost mismatches
- Entry path awareness for rebalancing opportunities

Does NOT replace per-protocol tools — use spectra_get_portfolio, pendle_get_portfolio,
morpho_get_positions for deeper per-protocol analysis.

Use this as the FIRST call when analyzing a wallet. It answers "where am I?"
before "what should I do?"`,
    {
      address: EVM_ADDRESS.describe("The wallet address (0x...)"),
      chain: CHAIN_ENUM
        .optional()
        .describe("Restrict to a single chain. Omit to scan all chains."),
    },
    async ({ address, chain }) => {
      try {
        const lines: string[] = [];
        const failures: string[] = [];

        // ═══════════════════════════════════════════════════════════
        // Fire ALL data sources in parallel — the whole point of this
        // tool is that we don't wait for one before starting another.
        // Each source can fail independently. We surface what we get.
        // ═══════════════════════════════════════════════════════════
        const networks = chain ? [resolveNetwork(chain)] : API_NETWORKS;

        const [
          spectraResult,
          pendleResult,
          morphoResults,
          veSpectraResult,
          vePendleResult,
        ] = await Promise.allSettled([
          // Spectra: portfolio across all chains
          Promise.allSettled(
            networks.map(async (net) => {
              const raw = await fetchSpectra(`/${net}/portfolio/${address}`) as any;
              const items = Array.isArray(raw) ? raw : raw?.data || [];
              return { chain: net, positions: items as SpectraPt[] };
            })
          ),
          // Pendle: portfolio across all chains
          scanAllPendleUserPositions(address),
          // Morpho: positions on all Morpho-capable chains
          Promise.allSettled(
            Object.entries(MORPHO_CHAIN_IDS)
              .filter(([net]) => !chain || resolveNetwork(chain) === net)
              .map(async ([net, chainId]) => {
                const result = await fetchMorphoUserPositions(address, chainId);
                return { chain: net, ...result };
              })
          ),
          // veSPECTRA governance position on Base
          fetchVeBalance(address).catch(() => null),
          // vePENDLE governance position on Ethereum mainnet
          fetchVePendleBalance(address).catch(() => null),
        ]);

        // ═══════════════════════════════════════════════════════════
        // Parse results — track what succeeded and what failed
        // ═══════════════════════════════════════════════════════════

        // Spectra
        let spectraTotalUsd = 0;
        let spectraPositionCount = 0;
        const spectraChainsFailed: string[] = [];
        const spectraExpiring: string[] = [];
        const spectraLines: string[] = [];

        if (spectraResult.status === "fulfilled") {
          for (const r of spectraResult.value) {
            if (r.status === "rejected") {
              spectraChainsFailed.push("?");
              continue;
            }
            const { chain: net, positions } = r.value;
            for (const pos of positions) {
              const pools = pos.pools || [];
              const pool = pools[0];
              if (!pool) continue;

              // Use the same balance extraction pattern as formatPositionSummary
              const decimals = pos.decimals ?? 18;
              const ptBal = formatBalance(pos.balance, decimals);
              const ytBal = formatBalance(pos.yt?.balance, pos.yt?.decimals ?? decimals);
              const lpBal = pools.reduce((sum: number, p: SpectraPool) => {
                return sum + formatBalance(p.lpt?.balance, p.lpt?.decimals ?? 18);
              }, 0);
              if (ptBal === 0 && ytBal === 0 && lpBal === 0) continue;

              spectraPositionCount++;
              const ptUsd = ptBal * (pool.ptPrice?.usd || 0);
              const ytUsd = ytBal * (pool.ytPrice?.usd || 0);
              const lpUsd = lpBal * (pool.lpt?.price?.usd || 0);
              const posTotal = ptUsd + ytUsd + lpUsd;
              spectraTotalUsd += posTotal;

              const maturity = pos.maturity ? daysToMaturity(pos.maturity) : null;
              const isExpired = maturity !== null && maturity <= 0;
              const isExpiring = maturity !== null && maturity > 0 && maturity <= 14;

              const parts = [];
              if (ptBal > 0) parts.push(`PT: ${ptBal.toFixed(2)}`);
              if (ytBal > 0) parts.push(`YT: ${ytBal.toFixed(2)}`);
              if (lpBal > 0) parts.push(`LP: ${lpBal.toFixed(4)}`);

              let statusTag = "";
              if (isExpired) statusTag = " [MATURED — redeem]";
              else if (isExpiring) statusTag = ` [⚠ ${maturity}d to maturity]`;

              spectraLines.push(`    ${pos.name || pos.symbol || "?"} (${net}) — ${formatUsd(posTotal)}${statusTag}`);
              spectraLines.push(`      ${parts.join(" | ")}${pool.impliedApy ? ` | APY ${formatPct(pool.impliedApy)}` : ""}`);

              if (isExpiring) spectraExpiring.push(`${pos.name} on ${net} (${maturity}d)`);
              if (isExpired) spectraExpiring.push(`${pos.name} on ${net} (MATURED)`);
            }
          }
          if (spectraChainsFailed.length > 0) {
            failures.push(`Spectra: ${spectraChainsFailed.length} chain(s) failed`);
          }
        } else {
          failures.push("Spectra: all chains failed");
        }

        // Pendle
        let pendleTotalUsd = 0;
        let pendlePositionCount = 0;
        const pendleLines: string[] = [];
        const pendleExpiring: string[] = [];

        if (pendleResult.status === "fulfilled") {
          const { positions: pendlePositions, failedChains: pendleFailedChains } = pendleResult.value;
          if (pendleFailedChains.length > 0) {
            failures.push(`Pendle: ${pendleFailedChains.length} chain(s) failed (${pendleFailedChains.join(", ")})`);
          }
          for (const pos of pendlePositions) {
            if (!pos || typeof pos !== "object") continue;
            const valUsd = pos.totalValueUsd || 0;
            if (valUsd === 0 && !pos.pt && !pos.yt && !pos.lp) continue;

            pendlePositionCount++;
            pendleTotalUsd += valUsd;

            // pos.expiry is ISO string — convert to Unix seconds for daysToMaturity
            const expiryTs = pos.expiry ? Math.floor(new Date(pos.expiry).getTime() / 1000) : 0;
            const maturity = expiryTs > 0 ? daysToMaturity(expiryTs) : null;
            const isExpiring = maturity !== null && maturity > 0 && maturity <= 14;
            const isExpired = pos.isExpired || (maturity !== null && maturity <= 0);
            let statusTag = "";
            if (isExpired) statusTag = " [MATURED]";
            else if (isExpiring) statusTag = ` [⚠ ${maturity}d]`;

            pendleLines.push(`    ${pos.marketName || "Pendle position"} — ${formatUsd(valUsd)}${statusTag}`);
            if (isExpiring) pendleExpiring.push(`${pos.marketName} (${maturity}d)`);
            if (isExpired) pendleExpiring.push(`${pos.marketName} (MATURED)`);
          }
          if (pendlePositionCount === 0 && pendleFailedChains.length === 0) {
            // No positions found and no chains failed — wallet genuinely has no Pendle positions
          }
        } else {
          failures.push("Pendle: portfolio fetch failed");
        }

        // Morpho
        let morphoSupplyUsd = 0;
        let morphoBorrowUsd = 0;
        let morphoCollateralUsd = 0;
        let morphoVaultUsd = 0;
        let morphoPositionCount = 0;
        const morphoLines: string[] = [];

        if (morphoResults.status === "fulfilled") {
          for (const r of morphoResults.value) {
            if (r.status === "rejected") continue;
            const { chain: net, marketPositions, vaultPositions } = r.value;

            for (const mp of marketPositions) {
              const supply = mp.supplyAssetsUsd || 0;
              const borrow = mp.borrowAssetsUsd || 0;
              const collateral = mp.collateralAssetsUsd || 0;
              if (supply === 0 && borrow === 0 && collateral === 0) continue;

              morphoPositionCount++;
              morphoSupplyUsd += supply;
              morphoBorrowUsd += borrow;
              morphoCollateralUsd += collateral;

              const collSym = mp.market?.collateralAsset?.symbol || "?";
              const loanSym = mp.market?.loanAsset?.symbol || "?";
              const parts = [];
              if (collateral > 0) parts.push(`collateral ${formatUsd(collateral)}`);
              if (borrow > 0) parts.push(`borrow ${formatUsd(borrow)}`);
              if (supply > 0) parts.push(`supply ${formatUsd(supply)}`);

              morphoLines.push(`    ${collSym}/${loanSym} (${net}) — ${parts.join(" | ")}`);
            }

            for (const vp of vaultPositions) {
              const val = vp.assetsUsd || 0;
              if (val === 0) continue;

              morphoPositionCount++;
              morphoVaultUsd += val;
              morphoLines.push(`    ${vp.vault?.name || "Vault"} (${net}) — ${formatUsd(val)}`);
            }
          }
        } else {
          failures.push("Morpho: all chains failed");
        }

        const morphoNetUsd = morphoSupplyUsd + morphoCollateralUsd + morphoVaultUsd - morphoBorrowUsd;

        // Governance: veSPECTRA (Base) + vePENDLE (Ethereum mainnet)
        // Both checked in parallel above. Both may coexist in one wallet.
        let veLines: string[] = [];
        let veVotingPower = 0; // veSPECTRA
        let veTotalSupply = 0;
        let vePendleVotingPower = 0;

        if (veSpectraResult.status === "fulfilled" && veSpectraResult.value) {
          const walletData = veSpectraResult.value;
          veVotingPower = walletData.votingPower;
          if (veVotingPower > 0) {
            try { veTotalSupply = await fetchVeTotalSupply(); } catch {}
            const share = veTotalSupply > 0 ? (veVotingPower / veTotalSupply) * 100 : 0;
            veLines.push(`    veSPECTRA: ${veVotingPower.toLocaleString("en-US", { maximumFractionDigits: 0 })} voting power (${formatPct(share)} of supply) — Base`);
            veLines.push(`      NFTs: ${walletData.nftCount} | Max boost: 2.5x on Spectra LP`);
          }
        }

        if (vePendleResult.status === "fulfilled" && vePendleResult.value) {
          const pendleVe = vePendleResult.value;
          vePendleVotingPower = pendleVe.votingPower;
          if (vePendleVotingPower > 0) {
            let pendleTotalSupply = 0;
            try { pendleTotalSupply = await fetchVePendleTotalSupply(); } catch {}
            const share = pendleTotalSupply > 0 ? (vePendleVotingPower / pendleTotalSupply) * 100 : 0;
            veLines.push(`    vePENDLE: ${vePendleVotingPower.toLocaleString("en-US", { maximumFractionDigits: 0 })} voting power (${formatPct(share)} of supply) — Ethereum`);
            if (pendleVe.lockedAmount > 0) {
              const expiryStr = pendleVe.lockExpiry > 0
                ? new Date(pendleVe.lockExpiry * 1000).toISOString().slice(0, 10)
                : "unknown";
              veLines.push(`      Locked: ${pendleVe.lockedAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })} PENDLE until ${expiryStr} | Max boost: 2.5x on Pendle LP`);
            }
            veLines.push(`      Note: vePENDLE is transitioning to sPENDLE (liquid staking, launched Jan 2026)`);
          }
        }

        // ═══════════════════════════════════════════════════════════
        // Compose the map
        // ═══════════════════════════════════════════════════════════

        const grandTotal = spectraTotalUsd + pendleTotalUsd + morphoNetUsd;
        const allExpiring = [...spectraExpiring, ...pendleExpiring];

        lines.push(`═══ POSITION MAP for ${address} ═══`);
        lines.push(``);

        // Honest failure reporting — BEFORE the numbers, not after
        if (failures.length > 0) {
          lines.push(`⚠ INCOMPLETE VIEW — ${failures.length} data source(s) degraded:`);
          for (const f of failures) lines.push(`  • ${f}`);
          lines.push(`Totals below may be significantly lower than actual holdings.`);
          lines.push(``);
        }

        // Grand total
        lines.push(`Total Visible: ${formatUsd(grandTotal)}${failures.length > 0 ? " (PARTIAL)" : ""}`);
        lines.push(``);

        // Spectra section
        lines.push(`── Spectra (${spectraPositionCount} position${spectraPositionCount !== 1 ? "s" : ""}) ── ${formatUsd(spectraTotalUsd)}`);
        if (spectraLines.length > 0) {
          lines.push(...spectraLines);
        } else {
          lines.push(`    No active Spectra positions found.`);
        }
        lines.push(``);

        // Pendle section
        lines.push(`── Pendle (${pendlePositionCount} position${pendlePositionCount !== 1 ? "s" : ""}) ── ${formatUsd(pendleTotalUsd)}`);
        if (pendleLines.length > 0) {
          lines.push(...pendleLines);
        } else {
          lines.push(`    No Pendle positions detected.`);
          if (failures.some(f => f.includes("Pendle"))) {
            lines.push(`    (Portfolio endpoint unreliable — positions may exist but be invisible)`);
          }
        }
        lines.push(``);

        // Morpho section
        lines.push(`── Morpho (${morphoPositionCount} position${morphoPositionCount !== 1 ? "s" : ""}) ── Net: ${formatUsd(morphoNetUsd)}`);
        if (morphoLines.length > 0) {
          if (morphoBorrowUsd > 0) {
            lines.push(`    Supply: ${formatUsd(morphoSupplyUsd)} | Collateral: ${formatUsd(morphoCollateralUsd)} | Borrows: ${formatUsd(morphoBorrowUsd)} | Vaults: ${formatUsd(morphoVaultUsd)}`);
          }
          lines.push(...morphoLines);
        } else {
          lines.push(`    No active Morpho positions found.`);
        }
        lines.push(``);

        // Governance section
        if (veLines.length > 0) {
          lines.push(`── Governance ──`);
          lines.push(...veLines);
          lines.push(``);
        }

        // ═══════════════════════════════════════════════════════════
        // Cross-protocol insights — the contradictions between silos
        // ═══════════════════════════════════════════════════════════
        // This section surfaces tensions that no single-protocol tool
        // can see. Each insight is conditional — it only appears when
        // the data creates genuine tension. Open emergence: surface
        // the competing truths, don't collapse them.

        const insights: string[] = [];

        // 1. Expiring positions across protocols
        if (allExpiring.length > 0) {
          insights.push(`⚠ EXPIRING: ${allExpiring.join(", ")}. Check rollover plans.`);
        }

        // 2. Governance boost mismatch — has ve tokens but maybe no LP positions to boost
        if (veVotingPower > 0 && spectraPositionCount === 0) {
          insights.push(`Governance mismatch: ${veVotingPower.toLocaleString()} veSPECTRA locked but no active Spectra LP positions. Boost is unused.`);
        }
        if (vePendleVotingPower > 0 && pendlePositionCount === 0) {
          insights.push(`Governance mismatch: ${vePendleVotingPower.toLocaleString()} vePENDLE locked but no active Pendle LP positions. Boost is unused.`);
        }

        // 3. Morpho lending while higher fixed rates exist on Spectra/Pendle
        // (This is the core cross-protocol insight — you're lending variable
        // when you could be earning fixed. But it's not always wrong — maybe
        // the lending is collateral for a loop. Surface the tension, don't resolve it.)
        if (morphoSupplyUsd > 1000 && spectraTotalUsd === 0 && pendleTotalUsd === 0) {
          insights.push(`Morpho supply only: ${formatUsd(morphoSupplyUsd)} lending on Morpho with no Spectra/Pendle positions. Fixed-rate alternatives may offer higher yield — check spectra_scan_opportunities or pendle_scan_opportunities.`);
        }

        // 4. Concentration risk — majority of value in one protocol
        if (grandTotal > 100) {
          const spectraPct = (spectraTotalUsd / grandTotal) * 100;
          const pendlePct = (pendleTotalUsd / grandTotal) * 100;
          const morphoPct = (morphoNetUsd / grandTotal) * 100;
          if (spectraPct > 80) insights.push(`Concentration: ${formatPct(spectraPct)} on Spectra. Consider protocol diversification.`);
          if (pendlePct > 80) insights.push(`Concentration: ${formatPct(pendlePct)} on Pendle. Consider protocol diversification.`);
          if (morphoPct > 80) insights.push(`Concentration: ${formatPct(morphoPct)} on Morpho. Consider protocol diversification.`);
        }

        // 5. Looper detection — collateral + borrows on Morpho often means leveraged positions
        if (morphoCollateralUsd > 0 && morphoBorrowUsd > 0) {
          const leverage = morphoCollateralUsd / (morphoCollateralUsd - morphoBorrowUsd);
          if (leverage > 1.5) {
            insights.push(`Looper detected: Morpho collateral ${formatUsd(morphoCollateralUsd)} / borrows ${formatUsd(morphoBorrowUsd)} ≈ ${leverage.toFixed(1)}x leverage. Monitor health factor with morpho_monitor_risk.`);
          }
        }

        if (insights.length > 0) {
          lines.push(`── Cross-Protocol Insights ──`);
          for (const insight of insights) {
            lines.push(`  • ${insight}`);
          }
          lines.push(``);
        }

        // Next steps
        lines.push(`── Next Steps ──`);
        lines.push(`• Deep dive: spectra_get_portfolio, pendle_get_portfolio, morpho_get_positions`);
        if (veVotingPower > 0) {
          lines.push(`• Boost check: spectra_get_ve_info(wallet_address="${address}") for per-pool boost`);
        }
        if (morphoBorrowUsd > 0) {
          lines.push(`• Risk: morpho_monitor_risk(address="${address}") for liquidation distance`);
        }
        if (allExpiring.length > 0) {
          lines.push(`• Rollover: spectra_list_expiring_pools or pendle_list_expiring_markets for successor pools`);
        }
        lines.push(`• Opportunities: spectra_scan_opportunities or mv_scan_curator_opportunities for yield comparison`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error building position map: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
