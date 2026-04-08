/**
 * Tool: spectra_get_ve_info
 *
 * Reads live veSPECTRA on-chain data from Base and computes boost scenarios.
 * Uses raw eth_call to Base public RPC — no ethers/viem dependency needed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork, VE_SPECTRA } from "../config.js";
import { fetchVeTotalSupply, fetchVeBalance, fetchSpectra } from "../api.js";
import { formatUsd, formatPct, parsePtResponse, computeSpectraBoost } from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "spectra_get_ve_info",
    `Get live veSPECTRA governance token information and compute boost scenarios.

Reads the current veSPECTRA total supply from Base chain on-chain, and given your
balance + a specific pool, computes your exact boost multiplier.

The Spectra boost formula: B = min(2.5, 1.5 * (v/V) * (D/d) + 1)
  v = your veSPECTRA balance
  V = total veSPECTRA supply (read live from Base)
  D = pool TVL
  d = your deposit size
Full 2.5x boost when: v/V >= d/D (your share of votes >= your share of pool)

Useful for understanding how much veSPECTRA you need for max boost in a given
pool at a given deposit size.`,
    {
      wallet_address: EVM_ADDRESS
        .optional()
        .describe("Wallet address to check veSPECTRA balance for. Reads on-chain from Base. If provided, auto-populates ve_spectra_balance."),
      ve_spectra_balance: z
        .number()
        .min(0)
        .optional()
        .describe("Your veSPECTRA token balance. If provided with capital_usd, computes your boost. Auto-populated when wallet_address is provided."),
      capital_usd: z
        .number()
        .positive()
        .optional()
        .describe("Your planned deposit size in USD. Required with ve_spectra_balance to compute boost."),
      chain: CHAIN_ENUM
        .optional()
        .describe("Chain of the pool to check boost for (optional, used with pt_address)."),
      pt_address: EVM_ADDRESS
        .optional()
        .describe("PT address of the pool to check boost for (optional, used with chain)."),
    },
    async ({ wallet_address, ve_spectra_balance, capital_usd, chain, pt_address }) => {
      try {
        const veTotalSupply = await fetchVeTotalSupply();
        let computedBoost: { multiplier: number; boostFraction: number } | null = null;

        // If wallet_address provided, read on-chain balance and auto-populate
        let walletData: { votingPower: number; nftCount: number; nfts: Array<{ tokenId: string; votingPower: number }> } | null = null;
        if (wallet_address) {
          walletData = await fetchVeBalance(wallet_address);
          // Auto-populate ve_spectra_balance from on-chain if not manually overridden
          if (ve_spectra_balance === undefined || ve_spectra_balance === 0) {
            ve_spectra_balance = walletData.votingPower;
          }
        }

        const lines: string[] = [
          `-- veSPECTRA Info --`,
          ``,
          `  Total Supply: ${veTotalSupply.toLocaleString("en-US", { maximumFractionDigits: 0 })} veSPECTRA`,
          `  Contract: ${VE_SPECTRA.address} (Base, chain ID ${VE_SPECTRA.chainId})`,
          `  Type: veNFT (NFT-based voting escrow)`,
          `  Max Boost: ${VE_SPECTRA.maxBoost}x LP gauge emissions`,
          `  Formula: B = min(2.5, 1.5 * (v/V) * (D/d) + 1)`,
          `  Source: ${VE_SPECTRA.sourceRepo}`,
        ];

        // Show wallet balance if we read it on-chain
        if (walletData) {
          lines.push(``);
          lines.push(`  Wallet: ${wallet_address}`);
          lines.push(`  veNFTs owned: ${walletData.nftCount}`);
          if (walletData.nftCount > 0) {
            lines.push(`  Total Voting Power: ${walletData.votingPower.toLocaleString("en-US", { maximumFractionDigits: 0 })} veSPECTRA`);
            lines.push(`  Share of Total: ${formatPct((walletData.votingPower / veTotalSupply) * 100)}`);
            for (const nft of walletData.nfts) {
              lines.push(`    NFT #${nft.tokenId}: ${nft.votingPower.toLocaleString("en-US", { maximumFractionDigits: 0 })} veSPECTRA`);
            }
          } else {
            lines.push(`  No veSPECTRA found at this address.`);
            lines.push(`  Note: if you hold sdSPECTRA (StakeDAO liquid locker), your veSPECTRA`);
            lines.push(`  is held by the StakeDAO contract, not your wallet directly.`);
          }
        }

        // If balance + capital provided, compute boost
        if (ve_spectra_balance !== undefined && ve_spectra_balance > 0 && capital_usd) {
          lines.push(``);
          lines.push(`  Your Balance: ${ve_spectra_balance.toLocaleString("en-US")} veSPECTRA`);
          lines.push(`  Your Share: ${formatPct((ve_spectra_balance / veTotalSupply) * 100)} of total supply`);

          // If pool specified, compute exact boost
          if (chain && pt_address) {
            const network = resolveNetwork(chain);
            const ptData = await fetchSpectra(`/${network}/pt/${pt_address}`) as any;
            const pt = parsePtResponse(ptData);
            const pool = pt?.pools?.[0];
            const tvlUsd = pt?.tvl?.usd || 0;
            // Use pool liquidity (total AMM depth) for boost, not PT TVL —
            // the gauge boost formula uses the user's share of the pool
            const poolLiqUsd = pool?.liquidity?.usd || 0;
            const boostDenominator = poolLiqUsd || tvlUsd;

            if (pt && pool && boostDenominator > 0) {
              const boost = computeSpectraBoost(
                ve_spectra_balance, veTotalSupply, boostDenominator, capital_usd
              );
              computedBoost = boost;
              const { multiplier, boostFraction } = boost;

              lines.push(``);
              lines.push(`  Pool: ${pt.name}`);
              lines.push(`  Pool Liquidity: ${formatUsd(boostDenominator)}`);
              lines.push(`  Your Deposit: ${formatUsd(capital_usd)}`);
              lines.push(`  Your Boost: ${multiplier.toFixed(2)}x`);
              lines.push(`  Boost Utilization: ${formatPct(boostFraction * 100)}`);

              // Compute veSPECTRA needed for full 2.5x boost
              // Full boost when v/V >= d/D, so v >= V * d/D
              const neededForMax = veTotalSupply * (capital_usd / boostDenominator);
              lines.push(``);
              if (ve_spectra_balance >= neededForMax) {
                lines.push(`  You have FULL 2.5x boost in this pool at this deposit size.`);
              } else {
                lines.push(`  For full 2.5x boost: need ${neededForMax.toLocaleString("en-US", { maximumFractionDigits: 0 })} veSPECTRA (${(neededForMax - ve_spectra_balance).toLocaleString("en-US", { maximumFractionDigits: 0 })} more)`);
              }

              // Show LP APY at this boost
              const lpApy = pool.lpApy;
              if (lpApy?.total) {
                lines.push(``);
                lines.push(`  LP APY (no boost): ${formatPct(lpApy.total)}`);
                if (lpApy.boostedTotal && lpApy.boostedTotal > lpApy.total) {
                  lines.push(`  LP APY (max 2.5x boost): ${formatPct(lpApy.boostedTotal)}`);
                }
              }
            } else {
              lines.push(``);
              lines.push(`  Pool not found at ${pt_address} on ${chain}. Verify this is a valid PT address.`);
            }
          } else {
            // No specific pool -- show boost at reference TVLs
            lines.push(`  Deposit: ${formatUsd(capital_usd)}`);
            lines.push(``);
            lines.push(`  Boost at various pool TVLs:`);
            for (const refTvl of [100_000, 500_000, 1_000_000, 5_000_000, 10_000_000, 50_000_000]) {
              const { multiplier } = computeSpectraBoost(
                ve_spectra_balance, veTotalSupply, refTvl, capital_usd
              );
              lines.push(`    ${formatUsd(refTvl).padEnd(16)} TVL -> ${multiplier.toFixed(2)}x boost`);
            }

            // Show how much veSPECTRA needed for max boost at each TVL
            lines.push(``);
            lines.push(`  veSPECTRA needed for max 2.5x boost at each TVL:`);
            for (const refTvl of [100_000, 500_000, 1_000_000, 5_000_000, 10_000_000]) {
              const needed = veTotalSupply * (capital_usd / refTvl);
              lines.push(`    ${formatUsd(refTvl).padEnd(16)} TVL -> ${needed.toLocaleString("en-US", { maximumFractionDigits: 0 })} veSPECTRA`);
            }
          }
        } else if (ve_spectra_balance !== undefined && ve_spectra_balance > 0 && !capital_usd) {
          lines.push(``);
          lines.push(`  Provide capital_usd to compute your boost (boost depends on deposit size).`);
        }

        // Always show the max-boost condition
        lines.push(``);
        lines.push(`  Max boost condition: v/V >= d/D`);
        lines.push(`  In words: your share of total veSPECTRA must be >= your share of pool TVL.`);

        // Next-step hints
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        if (ve_spectra_balance !== undefined && ve_spectra_balance > 0) {
          lines.push(`• See boosted opportunities: spectra_scan_opportunities(capital_usd=${capital_usd || "YOUR_AMOUNT"}, ve_spectra_balance=${ve_spectra_balance}) for boosted LP rankings`);
          lines.push(`• YT arb with boost context: spectra_scan_yt_arbitrage(capital_usd=${capital_usd || "YOUR_AMOUNT"}, ve_spectra_balance=${ve_spectra_balance})`);
        } else {
          lines.push(`• Provide ve_spectra_balance + capital_usd to compute your actual boost`);
        }
        lines.push(`• Boost only affects gauge-enabled LP positions — use spectra_compare_yield to see LP APY breakdown per pool`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching veSPECTRA info: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
