/**
 * Tool: get_ve_info
 *
 * Reads live veSPECTRA on-chain data from Base and computes boost scenarios.
 * Uses raw eth_call to Base public RPC — no ethers/viem dependency needed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork, VE_SPECTRA } from "../config.js";
import { fetchVeTotalSupply, fetchSpectra } from "../api.js";
import { formatUsd, formatPct, parsePtResponse, computeSpectraBoost } from "../formatters.js";
import { dual } from "./dual.js";

export function register(server: McpServer): void {
  server.tool(
    "get_ve_info",
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
      ve_spectra_balance: z
        .number()
        .min(0)
        .optional()
        .describe("Your veSPECTRA token balance. If provided with capital_usd, computes your boost."),
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
    async ({ ve_spectra_balance, capital_usd, chain, pt_address }) => {
      try {
        const veTotalSupply = await fetchVeTotalSupply();
        let computedBoost: { multiplier: number; boostFraction: number } | null = null;
        let ptResult: any = null;
        let poolResult: any = null;

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
            ptResult = pt || null;
            poolResult = pool || null;

            if (pt && pool && tvlUsd > 0) {
              const boost = computeSpectraBoost(
                ve_spectra_balance, veTotalSupply, tvlUsd, capital_usd
              );
              computedBoost = boost;
              const { multiplier, boostFraction } = boost;

              lines.push(``);
              lines.push(`  Pool: ${pt.name}`);
              lines.push(`  Pool TVL: ${formatUsd(tvlUsd)}`);
              lines.push(`  Your Deposit: ${formatUsd(capital_usd)}`);
              lines.push(`  Your Boost: ${multiplier.toFixed(2)}x`);
              lines.push(`  Boost Utilization: ${formatPct(boostFraction * 100)}`);

              // Compute veSPECTRA needed for full 2.5x boost
              // Full boost when v/V >= d/D, so v >= V * d/D
              const neededForMax = veTotalSupply * (capital_usd / tvlUsd);
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
              lines.push(`  Pool not found at ${pt_address} on ${chain}.`);
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

        const ts = Math.floor(Date.now() / 1000);
        return dual(lines.join("\n"), {
          tool: "get_ve_info",
          ts,
          params: { ve_spectra_balance, capital_usd, chain, pt_address },
          data: { veTotalSupply, boostInfo: computedBoost, pt: ptResult, pool: poolResult },
        });
      } catch (e: any) {
        return dual(`Error fetching veSPECTRA info: ${e.message}`, { tool: "get_ve_info", ts: Math.floor(Date.now() / 1000), params: { ve_spectra_balance, capital_usd, chain, pt_address }, data: { error: e.message } }, { isError: true });
      }
    }
  );
}
