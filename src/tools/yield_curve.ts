/**
 * Tool: spectra_get_yield_curve
 *
 * Term structure view for a given underlying asset across all Spectra chains.
 * Shows all available PT maturities sorted chronologically with implied APY,
 * TVL, and liquidity — the fixed-income "yield curve" that curators need
 * to spot term premium anomalies and choose maturities.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM } from "../config.js";
import { scanAllChainPools } from "../api.js";
import { normalizeUnderlyingSymbol, formatDate, daysToMaturity, formatPct, formatUsd } from "../formatters.js";
import type { RawPoolOpportunity } from "../types.js";

export function register(server: McpServer): void {
  server.tool(
    "spectra_get_yield_curve",
    `Show the yield curve (term structure) for a given underlying asset across all chains.

Fetches all active Spectra PTs matching the underlying (e.g., "USDC", "ETH"),
sorts by maturity, and displays implied APY at each point on the curve.

This is the fixed-income view: "What rate can I lock for 30 days vs 90 days
vs 180 days?" Helps curators spot term premium anomalies, compare cross-chain
rates at similar maturities, and choose optimal maturity targets.

Handles symbol variants automatically (USDC.e, WETH, wstETH → normalized).

Use spectra_get_pt_details or mv_check_ibt_health to drill into a specific maturity.
Use spectra_get_pool_capacity to check depth at your capital size.
Use spectra_compare_yield for fixed-vs-variable analysis on a specific PT.`,
    {
      underlying: z
        .string()
        .min(1)
        .max(20)
        .describe("Underlying asset symbol (e.g., 'USDC', 'ETH', 'stETH', 'GHO')"),
      chain: CHAIN_ENUM
        .optional()
        .describe("Restrict to a single chain. Omit to scan all chains."),
      min_tvl_usd: z
        .number()
        .default(0)
        .describe("Minimum TVL in USD to include (default 0)"),
      min_liquidity_usd: z
        .number()
        .default(0)
        .describe("Minimum pool liquidity in USD (default 0)"),
      compact: z
        .boolean()
        .default(false)
        .describe("One-line-per-maturity output for quick scanning"),
    },
    async ({ underlying, chain, min_tvl_usd, min_liquidity_usd, compact }) => {
      try {
        // Fetch all pools across chains with asset filter
        const { opportunities, failedChains } = await scanAllChainPools({
          asset_filter: underlying,
          min_tvl_usd,
          min_liquidity_usd,
        });

        // If chain param given, filter to that chain
        let filtered = chain
          ? opportunities.filter(o => o.chain === chain)
          : opportunities;

        // Group by normalized underlying and pick the matching group
        const targetNorm = normalizeUnderlyingSymbol(underlying);
        const byAsset = new Map<string, RawPoolOpportunity[]>();
        for (const opp of filtered) {
          const sym = normalizeUnderlyingSymbol(
            opp.pt.underlying?.symbol || opp.pt.name || ""
          );
          if (!sym) continue;
          if (!byAsset.has(sym)) byAsset.set(sym, []);
          byAsset.get(sym)!.push(opp);
        }

        // Try exact match first, then partial
        let matched = byAsset.get(targetNorm);
        if (!matched) {
          // Try finding a group whose key contains the target
          for (const [key, group] of byAsset) {
            if (key.includes(targetNorm) || targetNorm.includes(key)) {
              matched = group;
              break;
            }
          }
        }

        if (!matched || matched.length === 0) {
          const chainNote = chain ? ` on ${chain}` : " across any chain";
          const failNote = failedChains.length > 0
            ? `\nFailed chains: ${failedChains.join(", ")}`
            : "";
          const text = `No active PTs found for "${underlying}"${chainNote}.${failNote}\n\nTry a different symbol (USDC, ETH, stETH, GHO, etc.) or relax filters.`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Sort by maturity ascending (near-term first)
        matched.sort((a, b) => a.pt.maturity - b.pt.maturity);

        // Collect unique chains
        const chains = [...new Set(matched.map(o => o.chain))];

        // Build output
        const lines: string[] = [];
        const assetLabel = matched[0].pt.underlying?.symbol || underlying;
        lines.push(`${assetLabel} Yield Curve (${matched.length} maturit${matched.length === 1 ? "y" : "ies"} across ${chains.length} chain${chains.length === 1 ? "" : "s"})`);
        lines.push("");

        if (compact) {
          const hdr = "Maturity     | Days | Impl. APY |       TVL | Liquidity | Chain    | PT Address";
          lines.push(hdr);
          lines.push("─".repeat(hdr.length));

          for (const opp of matched) {
            const date = formatDate(opp.pt.maturity);
            const days = String(daysToMaturity(opp.pt.maturity)).padStart(4);
            const apy = formatPct(opp.pool.impliedApy || 0).padStart(9);
            const tvl = formatUsd(opp.pt.tvl?.usd || 0).padStart(9);
            const liq = formatUsd(opp.pool.liquidity?.usd || 0).padStart(9);
            const ch = opp.chain.padEnd(8);
            const addr = opp.pt.address.slice(0, 6) + "..." + opp.pt.address.slice(-4);
            lines.push(`${date}  | ${days} | ${apy} | ${tvl} | ${liq} | ${ch} | ${addr}`);
          }
        } else {
          for (const opp of matched) {
            const days = daysToMaturity(opp.pt.maturity);
            const ptPrice = opp.pool.ptPrice;
            lines.push(`-- ${opp.pt.name} (${opp.chain}) --`);
            lines.push(`  Maturity: ${formatDate(opp.pt.maturity)} (${days} days)`);
            lines.push(`  Implied APY: ${formatPct(opp.pool.impliedApy || 0)}`);
            lines.push(`  TVL: ${formatUsd(opp.pt.tvl?.usd || 0)} | Liquidity: ${formatUsd(opp.pool.liquidity?.usd || 0)}`);
            if (ptPrice) {
              const parts: string[] = [];
              if (ptPrice.usd) parts.push(formatUsd(ptPrice.usd));
              if (ptPrice.underlying != null) parts.push(`${ptPrice.underlying.toFixed(6)} underlying`);
              if (parts.length > 0) lines.push(`  PT Price: ${parts.join(" / ")}`);
            }
            lines.push(`  PT Address: ${opp.pt.address}`);
            if (opp.pt.ibt?.protocol) lines.push(`  IBT Protocol: ${opp.pt.ibt.protocol}`);
            lines.push("");
          }
        }

        // Curve shape analysis
        if (matched.length >= 2) {
          lines.push("");
          const first = matched[0];
          const last = matched[matched.length - 1];
          const firstApy = first.pool.impliedApy || 0;
          const lastApy = last.pool.impliedApy || 0;
          const diff = lastApy - firstApy;

          if (Math.abs(diff) < 0.1) {
            lines.push("Curve shape: Flat (similar rates across maturities)");
          } else if (diff > 0) {
            lines.push("Curve shape: Normal (upward sloping — longer maturities pay more)");
          } else {
            lines.push("Curve shape: Inverted (shorter maturities pay more — unusual, investigate)");
          }

          // Find steepest segment
          let maxSlopePer30d = 0;
          let steepestIdx = 0;
          for (let i = 1; i < matched.length; i++) {
            const daysDelta = daysToMaturity(matched[i].pt.maturity) - daysToMaturity(matched[i - 1].pt.maturity);
            const apyDelta = (matched[i].pool.impliedApy || 0) - (matched[i - 1].pool.impliedApy || 0);
            const slopePer30d = daysDelta > 0 ? (apyDelta / daysDelta) * 30 : 0;
            if (Math.abs(slopePer30d) > Math.abs(maxSlopePer30d)) {
              maxSlopePer30d = slopePer30d;
              steepestIdx = i;
            }
          }

          if (steepestIdx > 0) {
            const prev = matched[steepestIdx - 1];
            const curr = matched[steepestIdx];
            const daysPrev = daysToMaturity(prev.pt.maturity);
            const daysCurr = daysToMaturity(curr.pt.maturity);
            const apyDelta = (curr.pool.impliedApy || 0) - (prev.pool.impliedApy || 0);
            const sign = apyDelta >= 0 ? "+" : "";
            lines.push(`Steepest segment: ${daysPrev}d→${daysCurr}d (${sign}${formatPct(apyDelta)} over ${daysCurr - daysPrev} days)`);
          }

          // Flag near-maturity cross-chain pairs (within 7 days)
          for (let i = 1; i < matched.length; i++) {
            const prev = matched[i - 1];
            const curr = matched[i];
            if (curr.chain === prev.chain) continue;
            const dayGap = Math.abs(daysToMaturity(curr.pt.maturity) - daysToMaturity(prev.pt.maturity));
            if (dayGap <= 7) {
              const apyDelta = Math.abs((curr.pool.impliedApy || 0) - (prev.pool.impliedApy || 0));
              lines.push(`Cross-chain pair: ${formatDate(prev.pt.maturity)} ${prev.chain} vs ${curr.chain} — APY delta ${formatPct(apyDelta)}${apyDelta < 0.1 ? " (negligible, choose by liquidity)" : ""}`);
            }
          }
        }

        if (failedChains.length > 0) {
          lines.push("");
          lines.push(`Note: Failed to fetch from: ${failedChains.join(", ")}`);
        }

        lines.push("");
        lines.push("Use spectra_get_pt_details or mv_check_ibt_health on a specific PT for deeper analysis.");
        lines.push("Use spectra_get_pool_capacity to assess depth at your capital size.");

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const text = `Error building yield curve: ${err?.message || String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}
