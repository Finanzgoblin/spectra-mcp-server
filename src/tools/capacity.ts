/**
 * Tool: spectra_get_pool_capacity
 *
 * Runs a multi-size quote ladder against a PT pool to show how price impact
 * and effective APY degrade at increasing capital sizes. Supports both PT buy
 * (swap) and LP add (deposit) modes for different deployment strategies.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork } from "../config.js";
import { fetchSpectra, fetchCurveCalcTokenAmount, amountToBigInt } from "../api.js";
import { parsePtResponse, buildQuoteFromPt, formatUsd, formatPct, formatDate, daysToMaturity, estimateLpDepositImpact, extractLpApyBreakdown } from "../formatters.js";
import { tryOnChainQuote } from "./quote.js";

export function register(server: McpServer): void {
  server.tool(
    "spectra_get_pool_capacity",
    `Analyze a pool's capacity by quoting PT trades at increasing capital sizes.

Shows how price impact and effective APY degrade as capital grows, helping
curators and large deployers find the sweet spot (max capital with acceptable
impact) and the exhaustion point (where APY collapses).

Two modes:
  "pt_buy" (default): Measures PT swap impact via Curve get_dy(). Shows how much
    capital can be deployed as a directional PT buyer before slippage degrades APY.
  "lp_add": Measures LP deposit impact. LP deposits add liquidity to BOTH sides of
    the pool, deepening it rather than consuming it. Impact is near-zero for balanced
    deposits. Shows pool share concentration and post-deposit pool depth.
    USE THIS MODE for MetaVault curator capacity analysis — curators deploy as LP.

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
      mode: z
        .enum(["pt_buy", "lp_add"])
        .default("pt_buy")
        .describe("Analysis mode: 'pt_buy' for PT swap impact (default), 'lp_add' for LP deposit impact (MetaVault curators)."),
    },
    async ({ chain, pt_address, steps, max_capital_usd, use_on_chain, mode }) => {
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

        // LP APY for lp_add mode context
        const lpData = extractLpApyBreakdown(pool, 0);

        if (mode === "lp_add") {
          return buildLpCapacityCurve(
            pt, pool, tiers, poolLiqUsd, underlyingPriceUsd, impliedApy,
            maturityDays, ibtDecimals, ptDecimals, poolAddress, chain,
            use_on_chain, max_capital_usd, lpData.lpApy,
          );
        }

        // ──── PT BUY MODE (existing behavior) ────

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

// =============================================================================
// LP Add Capacity Analysis
// =============================================================================

async function buildLpCapacityCurve(
  pt: any,
  pool: any,
  tiers: number[],
  poolLiqUsd: number,
  underlyingPriceUsd: number,
  impliedApy: number,
  maturityDays: number,
  ibtDecimals: number,
  ptDecimals: number,
  poolAddress: string | undefined,
  chain: string,
  useOnChain: boolean,
  maxCapitalUsd: number,
  lpApy: number,
) {
  // Get current pool reserves for proportional splitting
  const ibtReserveRaw = BigInt(pool.ibtAmount || "0");
  const ptReserveRaw = BigInt(pool.ptAmount || "0");
  const lpSupplyRaw = BigInt(pool.lpt?.supply || "0");

  // Convert reserves to underlying terms for proportional split
  const ibtPriceUnderlying = pt.ibt?.price?.underlying || 1;
  const ptPriceUnderlying = pool.ptPrice?.underlying || 1;
  const ibtDivisor = 10n ** BigInt(ibtDecimals);
  const ptDivisor = 10n ** BigInt(ptDecimals);
  const ibtReserveUnderlying = Number(ibtReserveRaw) / Number(ibtDivisor) * ibtPriceUnderlying;
  const ptReserveUnderlying = Number(ptReserveRaw) / Number(ptDivisor) * ptPriceUnderlying;
  const totalReservesUnderlying = ibtReserveUnderlying + ptReserveUnderlying;

  // Proportional split fractions
  const ibtFrac = totalReservesUnderlying > 0 ? ibtReserveUnderlying / totalReservesUnderlying : 0.5;
  const ptFrac = 1 - ibtFrac;

  interface LpTierResult {
    capitalUsd: number;
    impactPct: number;
    poolSharePct: number;
    postDepositLiqUsd: number;
    method: string;
  }
  const results: LpTierResult[] = [];

  for (const capitalUsd of tiers) {
    const amountUnderlying = capitalUsd / underlyingPriceUsd;
    if (amountUnderlying <= 0) continue;

    let impactPct: number;
    let method = "math";

    // Try on-chain calc_token_amount quote
    if (useOnChain && poolAddress && totalReservesUnderlying > 0) {
      // Split deposit proportionally to current reserves
      const ibtDepositUnderlying = amountUnderlying * ibtFrac;
      const ptDepositUnderlying = amountUnderlying * ptFrac;

      // Convert to raw token amounts (IBT deposit in IBT units, PT deposit in PT units)
      const ibtDepositRaw = amountToBigInt(ibtDepositUnderlying / ibtPriceUnderlying, ibtDecimals);
      const ptDepositRaw = amountToBigInt(ptDepositUnderlying / ptPriceUnderlying, ptDecimals);

      const expectedLp = await fetchCurveCalcTokenAmount(
        poolAddress,
        [ibtDepositRaw, ptDepositRaw],
        true,
        chain,
      );

      if (expectedLp !== null && lpSupplyRaw > 0n) {
        // Theoretical LP tokens for a perfectly proportional deposit:
        // proportionalLp = (depositValue / poolValue) * totalLpSupply
        const depositFrac = amountUnderlying / totalReservesUnderlying;
        const proportionalLp = Number(lpSupplyRaw) * depositFrac;
        const actualLp = Number(expectedLp);

        // Impact = 1 - actual/theoretical (value lost to imbalance fees)
        impactPct = proportionalLp > 0
          ? Math.max(0, (1 - actualLp / proportionalLp) * 100)
          : 0;
        method = "on-chain";
      } else {
        impactPct = estimateLpDepositImpact(capitalUsd, poolLiqUsd) * 100;
      }
    } else {
      impactPct = estimateLpDepositImpact(capitalUsd, poolLiqUsd) * 100;
    }

    // Pool share after deposit
    const poolSharePct = (capitalUsd / (poolLiqUsd + capitalUsd)) * 100;
    const postDepositLiqUsd = poolLiqUsd + capitalUsd;

    results.push({ capitalUsd, impactPct, poolSharePct, postDepositLiqUsd, method });
  }

  if (results.length === 0) {
    return { content: [{ type: "text" as const, text: `Could not generate LP capacity curve for ${pt.name}. Price data may be insufficient.` }], isError: true };
  }

  // Find sweet spot (largest capital where pool share < 33%)
  let sweetSpot: LpTierResult | null = null;
  for (const r of results) {
    if (r.poolSharePct < 33) sweetSpot = r;
  }

  // Concentration threshold (first capital where pool share > 50%)
  let concentrationThreshold: LpTierResult | null = null;
  for (const r of results) {
    if (r.poolSharePct > 50) {
      concentrationThreshold = r;
      break;
    }
  }

  // Format output
  const lines: string[] = [];
  lines.push(`LP Capacity Curve: ${pt.name} (${chain})`);
  lines.push(`Maturity: ${formatDate(pt.maturity)} (${maturityDays} days) | Implied APY: ${formatPct(impliedApy)} | LP APY: ${formatPct(lpApy)} | Pool Liquidity: ${formatUsd(poolLiqUsd)}`);
  if (totalReservesUnderlying > 0) {
    lines.push(`Pool Reserves: IBT ${formatPct(ibtFrac * 100)} / PT ${formatPct(ptFrac * 100)} (deposit split proportionally)`);
  }
  lines.push("");

  // Table header
  const hdr = "Capital (USD)  | Imbalance Fee | Pool Share | Post-Deposit Liq | Method";
  lines.push(hdr);
  lines.push("─".repeat(hdr.length));

  for (const r of results) {
    const capStr = formatUsd(r.capitalUsd).padStart(13);
    const impStr = formatPct(r.impactPct).padStart(13);
    const shareStr = formatPct(r.poolSharePct).padStart(10);
    const postLiqStr = formatUsd(r.postDepositLiqUsd).padStart(16);
    const warn = r.poolSharePct > 50 ? " !! CONCENTRATION" : r.poolSharePct > 33 ? " ! HIGH SHARE" : "";
    lines.push(`${capStr}  | ${impStr} | ${shareStr} | ${postLiqStr} | ${r.method}${warn}`);
  }

  lines.push("");

  if (sweetSpot) {
    lines.push(`Sweet spot: ~${formatUsd(sweetSpot.capitalUsd)} (${formatPct(sweetSpot.poolSharePct)} pool share, ${formatPct(sweetSpot.impactPct)} imbalance fee)`);
  } else {
    lines.push("Sweet spot: Even $1K exceeds 33% pool share — pool is very small.");
  }

  if (concentrationThreshold) {
    lines.push(`Concentration threshold: ~${formatUsd(concentrationThreshold.capitalUsd)} (>${formatPct(concentrationThreshold.poolSharePct)} of pool)`);
    lines.push("  At >50% pool share, single-depositor concentration risk is significant.");
    lines.push("  However, LP deposits deepen pools — your capital ADDS depth, attracting more traders.");
  } else {
    lines.push(`No concentration risk within ${formatUsd(maxCapitalUsd)} range — pool is deep enough.`);
  }

  lines.push("");
  lines.push("Key difference from PT buy mode: LP deposits ADD liquidity to the pool (deepening it),");
  lines.push("while PT buys CONSUME liquidity (moving price). LP imbalance fees are near-zero for");
  lines.push("balanced deposits. The primary risk is concentration (owning too much of one pool),");
  lines.push("not price impact.");
  if (results.some(r => r.method === "on-chain")) {
    lines.push("On-chain quotes use Curve calc_token_amount() for exact imbalance fee estimation.");
  } else {
    lines.push("Math estimates use StableSwap model (A=1000). Real fees may be even lower.");
  }

  const text = lines.join("\n");
  return { content: [{ type: "text" as const, text }] };
}
