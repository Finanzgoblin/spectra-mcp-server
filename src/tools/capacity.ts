/**
 * Tool: spectra_get_pool_capacity
 *
 * Runs a multi-size quote ladder against a PT pool to show how price impact
 * and effective APY degrade at increasing capital sizes. Helps curators and
 * large deployers assess pool depth before entering a position.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork } from "../config.js";
import { fetchSpectra } from "../api.js";
import { parsePtResponse, buildQuoteFromPt, formatUsd, formatPct, formatDate, daysToMaturity } from "../formatters.js";
import { tryOnChainQuote } from "./quote.js";

export function register(server: McpServer): void {
  server.tool(
    "spectra_get_pool_capacity",
    `Analyze a pool's capacity by quoting PT trades at increasing capital sizes.

Shows how price impact and effective APY degrade as capital grows, helping
curators and large deployers find the sweet spot (max capital with acceptable
impact) and the exhaustion point (where APY collapses).

Each tier is quoted independently (not cumulative). Real execution across
multiple txns would face additional impact from pool state changes.

On-chain quotes use the actual Curve StableSwap-NG amplification parameter.
Set use_on_chain=false for math-only estimates (faster, more conservative).

Use spectra_quote_trade for a single exact quote at a specific amount.
Use spectra_scan_opportunities for capital-aware ranking across all pools.
Use mv_check_ibt_health to verify the underlying IBT before deploying.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pt_address: EVM_ADDRESS.describe("The PT contract address (0x...)"),
      steps: z
        .number()
        .int()
        .min(1)
        .max(12)
        .default(8)
        .describe("Number of capital tiers in the ladder (default 8, max 12)"),
      max_capital_usd: z
        .number()
        .positive()
        .default(1_000_000)
        .describe("Upper bound of the capital ladder in USD (default $1,000,000)"),
      use_on_chain: z
        .boolean()
        .default(true)
        .describe("Try on-chain Curve get_dy() quotes (default true). Set false for math-only estimates."),
    },
    async ({ chain, pt_address, steps, max_capital_usd, use_on_chain }) => {
      try {
        const network = resolveNetwork(chain);
        const data = await fetchSpectra(`/${network}/pt/${pt_address}`) as any;
        const pt = parsePtResponse(data);

        if (!pt) {
          return { content: [{ type: "text" as const, text: `No PT found at ${pt_address} on ${chain}` }], isError: true };
        }

        const pool = pt.pools?.[0];
        if (!pool) {
          return { content: [{ type: "text" as const, text: `No active pool for PT ${pt.name}` }], isError: true };
        }

        const ptPriceUsd = pool.ptPrice?.usd || 0;
        const ptPriceUnderlying = pool.ptPrice?.underlying || 0;
        const poolLiqUsd = pool.liquidity?.usd || 0;
        const impliedApy = pool.impliedApy || 0;
        const maturityDays = daysToMaturity(pt.maturity);
        const poolAddress = pool.address;
        const ibtDecimals = pt.ibt?.decimals ?? pt.decimals ?? 18;
        const ptDecimals = pt.decimals ?? 18;

        if (ptPriceUnderlying < 0.001 || ptPriceUsd < 0.0001) {
          return { content: [{ type: "text" as const, text: `PT price data unavailable for ${pt.name}. Cannot build capacity curve.` }], isError: true };
        }

        // Generate geometric (log-spaced) capital tiers
        const MIN_TIER_USD = 1_000;
        const minLog = Math.log10(MIN_TIER_USD);
        const maxLog = Math.log10(max_capital_usd);
        const tiers: number[] = [];
        for (let i = 0; i < steps; i++) {
          const log = steps === 1 ? maxLog : minLog + (maxLog - minLog) * i / (steps - 1);
          tiers.push(Math.round(10 ** log));
        }

        // Underlying price per unit (derived from PT price data)
        const underlyingPriceUsd = ptPriceUsd / ptPriceUnderlying;

        // Quote each tier
        interface TierResult {
          capitalUsd: number;
          impactPct: number;
          effectiveApy: number;
          method: string;
        }
        const results: TierResult[] = [];

        for (const capitalUsd of tiers) {
          // Convert USD to underlying units
          const amountUnderlying = capitalUsd / underlyingPriceUsd;
          if (amountUnderlying <= 0) continue;

          // Math-based quote
          const mathQuote = buildQuoteFromPt(pt, pool, amountUnderlying, "buy", 0.5);
          if (!mathQuote) continue;

          let impactPct = mathQuote.priceImpactPct;
          let method = "math";

          // Try on-chain quote
          if (use_on_chain && poolAddress) {
            const onChain = await tryOnChainQuote(
              mathQuote, poolAddress, chain, amountUnderlying, "buy",
              ibtDecimals, ptDecimals, 0.5,
            );
            if (onChain) {
              impactPct = onChain.priceImpactPct;
              method = "on-chain";
            }
          }

          // Effective APY = implied APY minus annualized entry cost
          const annualizedImpact = maturityDays > 0
            ? (impactPct / 100) * (365 / maturityDays) * 100
            : impactPct;
          const effectiveApy = impliedApy - annualizedImpact;

          results.push({ capitalUsd, impactPct, effectiveApy, method });
        }

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `Could not generate capacity curve for ${pt.name}. Price data may be insufficient.` }], isError: true };
        }

        // Find sweet spot (largest capital where impact < 1%)
        let sweetSpot: TierResult | null = null;
        for (const r of results) {
          if (r.impactPct < 1) sweetSpot = r;
        }

        // Find exhaustion point (first capital where impact > 5% or APY goes negative)
        let exhaustion: TierResult | null = null;
        for (const r of results) {
          if (r.impactPct > 5 || r.effectiveApy < 0) {
            exhaustion = r;
            break;
          }
        }

        // Format output
        const lines: string[] = [];
        lines.push(`Pool Capacity Curve: ${pt.name} (${chain})`);
        lines.push(`Maturity: ${formatDate(pt.maturity)} (${maturityDays} days) | Implied APY: ${formatPct(impliedApy)} | Pool Liquidity: ${formatUsd(poolLiqUsd)}`);
        lines.push("");

        // Table header
        const hdr = "Capital (USD)  | Impact (%) | Eff. APY (%) | Method";
        lines.push(hdr);
        lines.push("─".repeat(hdr.length));

        for (const r of results) {
          const capStr = formatUsd(r.capitalUsd).padStart(13);
          const impStr = formatPct(r.impactPct).padStart(10);
          const apyStr = formatPct(r.effectiveApy).padStart(12);
          const warn = r.impactPct > 5 ? " !!" : r.impactPct > 1 ? " !" : "";
          lines.push(`${capStr}  | ${impStr} | ${apyStr}   | ${r.method}${warn}`);
        }

        lines.push("");

        if (sweetSpot) {
          lines.push(`Sweet spot: ~${formatUsd(sweetSpot.capitalUsd)} (impact ${formatPct(sweetSpot.impactPct)}, effective APY ~${formatPct(sweetSpot.effectiveApy)})`);
        } else {
          lines.push("Sweet spot: Even $1K exceeds 1% impact — pool is very thin.");
        }

        if (exhaustion) {
          lines.push(`Exhaustion: ~${formatUsd(exhaustion.capitalUsd)} (impact ${formatPct(exhaustion.impactPct)}, APY drops to ${formatPct(exhaustion.effectiveApy)})`);
        } else {
          lines.push(`No exhaustion within ${formatUsd(max_capital_usd)} range — pool has deep liquidity.`);
        }

        lines.push("");
        lines.push("Note: Each tier is quoted independently (not cumulative). Real execution");
        lines.push("across multiple txns would face additional impact from pool state changes.");
        if (results.some(r => r.method === "on-chain")) {
          lines.push("On-chain quotes reflect the actual Curve StableSwap-NG amplification parameter.");
        } else {
          lines.push("Math estimates use conservative constant-product model. Real impact is likely lower.");
        }

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const text = `Error building capacity curve: ${err?.message || String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}
