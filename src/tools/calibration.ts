/**
 * Tool: mv_get_calibration
 *
 * The calibration oracle. Answers: "What does normal look like?"
 *
 * The Phylax session (March 31) revealed the practice's deepest product:
 * calibration intelligence. Not assertions. Not monitoring. The bridge
 * between them — "we know what normal looks like because we watch it
 * every day." The six Solidity assertions written for Phylax all needed
 * threshold values. Those values came from observation, not theory.
 *
 * This tool exports that knowledge. Given a market, pool, or IBT, it
 * produces the statistical profile of "normal" — percentiles, anomaly
 * thresholds, peer comparison, and assertion-ready language.
 *
 * Open emergence: the tool surfaces what the data shows, not what
 * the analyst wants to see. If the data is too sparse for reliable
 * calibration (< 10 data points), it says so. If the distribution
 * is bimodal (regime change mid-period), it flags the instability
 * rather than averaging it away. The observation boundary is explicit.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EVM_ADDRESS, CHAIN_ENUM, MORPHO_CHAIN_IDS, PENDLE_CHAIN_IDS, resolveNetwork } from "../config.js";
import {
  fetchMorphoMarketHistory,
  fetchPendleHistoricalData,
  fetchIbtConversionRate,
  computePercentiles,
  fetchSpectra,
  fetchMorpho,
} from "../api.js";
import { formatPct, formatUsd, daysToMaturity } from "../formatters.js";
import type { CalibrationMetric, CalibrationProfile, MorphoHistoricalDataPoint } from "../types.js";

// ── Calibration math ──
// Not in formatters because it produces data, not text.
// Not in api because it's domain logic, not fetching.

function buildMetric(
  name: string,
  unit: string,
  values: number[],
  current?: number,
): CalibrationMetric | null {
  const valid = values.filter(v => v != null && isFinite(v) && !isNaN(v));
  if (valid.length < 3) return null; // too sparse for calibration

  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - avg) ** 2, 0) / sorted.length;
  const stddev = Math.sqrt(variance);
  const cov = avg !== 0 ? (stddev / Math.abs(avg)) * 100 : 0;

  const pcts = computePercentiles(sorted);
  const cur = current ?? sorted[sorted.length - 1];

  // Trend: compare first third vs last third
  const third = Math.max(1, Math.floor(sorted.length / 3));
  const firstThirdAvg = valid.slice(0, third).reduce((a, b) => a + b, 0) / third;
  const lastThirdAvg = valid.slice(-third).reduce((a, b) => a + b, 0) / third;
  const trendPct = firstThirdAvg !== 0 ? ((lastThirdAvg - firstThirdAvg) / Math.abs(firstThirdAvg)) * 100 : 0;
  const trend: "up" | "down" | "stable" = Math.abs(trendPct) < 5 ? "stable" : trendPct > 0 ? "up" : "down";

  // Anomaly thresholds: use the more conservative of 3-sigma and 2x historical max/min
  // Anomaly thresholds — clip to domain constraints.
  // The Hunter found: utilization ceiling at 104% is mathematically impossible.
  // Rates can't be negative. Utilization can't exceed 100%.
  const sigma3High = avg + 3 * stddev;
  const sigma3Low = avg - 3 * stddev;
  const maxBased = sorted[sorted.length - 1] * 2;
  let highThreshold = Math.min(sigma3High, maxBased); // conservative = lower ceiling
  let lowThreshold = Math.max(sigma3Low, 0); // floor at 0 for rates

  // Domain clipping: utilization and percentages can't exceed 100%
  const isPercentageMetric = unit === "%" && (
    name.toLowerCase().includes("utilization") ||
    name.toLowerCase().includes("ratio")
  );
  if (isPercentageMetric && highThreshold > 100) highThreshold = 100;
  if (lowThreshold < 0) lowThreshold = 0;

  // Current status
  let currentStatus: "normal" | "elevated" | "anomalous" = "normal";
  if (cur > pcts.p95 || cur < pcts.p5) currentStatus = "elevated";
  if (cur > highThreshold || cur < lowThreshold) currentStatus = "anomalous";

  return {
    name,
    unit,
    stats: {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg,
      median: pcts.p50,
      stddev,
      p5: pcts.p5,
      p25: pcts.p25,
      p75: pcts.p75,
      p95: pcts.p95,
      current: cur,
      trend,
      cov,
    },
    normalRange: [pcts.p5, pcts.p95],
    anomalyThreshold: {
      low: lowThreshold,
      high: highThreshold,
      method: highThreshold === maxBased ? "2x_max" : "3_sigma",
    },
    currentStatus,
    dataPoints: valid.length,
  };
}

function formatMetricBlock(m: CalibrationMetric): string[] {
  const lines: string[] = [];
  const s = m.stats;
  const statusEmoji = m.currentStatus === "anomalous" ? "⚠" : m.currentStatus === "elevated" ? "↑" : "·";
  const fmtVal = (v: number) => m.unit === "%" ? formatPct(v) : m.unit === "USD" ? formatUsd(v) : v.toFixed(4);

  lines.push(`── ${m.name} (${m.dataPoints} observations) ──`);
  lines.push(`  Normal range: ${fmtVal(s.p5)} — ${fmtVal(s.p95)} (5th-95th percentile)`);
  lines.push(`  Current: ${fmtVal(s.current)} ${statusEmoji} ${m.currentStatus.toUpperCase()} — ${percentileLabel(s.current, s)}th percentile`);
  lines.push(`  Stats: min ${fmtVal(s.min)} | avg ${fmtVal(s.avg)} | median ${fmtVal(s.median)} | max ${fmtVal(s.max)} | stddev ${fmtVal(s.stddev)}`);
  lines.push(`  Volatility: CoV ${s.cov.toFixed(1)}% (${s.cov < 10 ? "STABLE" : s.cov < 30 ? "moderate" : "VOLATILE"}) | Trend: ${s.trend}`);
  lines.push(`  Anomaly threshold: < ${fmtVal(m.anomalyThreshold.low)} or > ${fmtVal(m.anomalyThreshold.high)} (${m.anomalyThreshold.method})`);

  return lines;
}

function percentileLabel(value: number, stats: CalibrationMetric["stats"]): number {
  // Approximate which percentile the current value sits at
  if (value <= stats.p5) return 5;
  if (value <= stats.p25) return Math.round(5 + (value - stats.p5) / (stats.p25 - stats.p5) * 20);
  if (value <= stats.median) return Math.round(25 + (value - stats.p25) / (stats.median - stats.p25) * 25);
  if (value <= stats.p75) return Math.round(50 + (value - stats.median) / (stats.p75 - stats.median) * 25);
  if (value <= stats.p95) return Math.round(75 + (value - stats.p75) / (stats.p95 - stats.p75) * 20);
  return 99;
}

function generateAssertionHints(metrics: CalibrationMetric[], targetName: string): string[] {
  const hints: string[] = [];
  for (const m of metrics) {
    const s = m.stats;
    const fmtVal = (v: number) => m.unit === "%" ? formatPct(v) : m.unit === "USD" ? formatUsd(v) : v.toFixed(4);

    if (m.name.includes("Apy") || m.name.includes("apy") || m.name.includes("Rate") || m.name.includes("rate")) {
      hints.push(
        `${m.name}: Historical max ${fmtVal(s.max)} over ${m.dataPoints} observations. ` +
        `A threshold of ${fmtVal(m.anomalyThreshold.high)} catches genuine spikes ` +
        `while tolerating normal volatility (CoV ${s.cov.toFixed(0)}%).`
      );
    }
    if (m.name.includes("utilization") || m.name.includes("Utilization")) {
      hints.push(
        `Utilization: Normal band ${fmtVal(s.p25)}—${fmtVal(s.p75)}. ` +
        `Floor alert at ${fmtVal(m.anomalyThreshold.low)} (demand collapse). ` +
        `Ceiling alert at ${fmtVal(Math.min(m.anomalyThreshold.high, 99))} (capacity exhaustion).`
      );
    }
    if (m.name.includes("tvl") || m.name.includes("TVL")) {
      const dropPct = s.max > 0 ? ((s.max - s.min) / s.max * 100).toFixed(0) : "?";
      hints.push(
        `TVL: Observed range ${fmtVal(s.min)}—${fmtVal(s.max)} (${dropPct}% swing). ` +
        `A > 25% decline in 24h may signal a bank run or oracle failure.`
      );
    }
  }
  return hints;
}

export function register(server: McpServer): void {
  server.tool(
    "mv_get_calibration",
    `Calibration oracle: what does "normal" look like for a market, pool, or IBT?

Produces statistical baselines from historical data — percentiles, anomaly
thresholds, peer comparison, and assertion-ready language.

This is the bridge between perception (monitoring tools) and specification
(security assertions like Phylax Credible Layer). The tool answers "what
should the threshold be?" from observation, not theory.

For each metric (borrow APY, utilization, TVL, implied APY, etc.), returns:
- Normal range (5th-95th percentile from historical data)
- Current status (normal / elevated / anomalous)
- Anomaly threshold (conservative: min of 3-sigma and 2x historical max)
- Peer comparison (where this market sits among similar markets)
- Assertion hints (natural language threshold suggestions)

Supports Morpho markets (by market key), Pendle markets (by market address),
and Spectra pools (by pool/PT address). Auto-detects target type from address
format (64-char hex = Morpho, 40-char hex = Pendle/Spectra).

Use morpho_get_history or pendle_get_market_history for raw time-series.
Use mv_check_ibt_health for single-point health snapshots.
Use this tool when you need to CALIBRATE — set thresholds, compare to peers,
or export knowledge about what normal looks like.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      target_address: z.string().describe("Market key (Morpho 0x+64 hex), market address (Pendle 0x+40 hex), or pool/PT address (Spectra 0x+40 hex)"),
      target_type: z.enum(["morpho", "pendle", "spectra", "ibt"]).optional()
        .describe("Target type. Auto-detected from address format if omitted."),
      period: z.enum(["7d", "30d", "90d"]).default("30d").optional()
        .describe("Historical period for calibration (default 30d)"),
      include_peers: z.boolean().default(true).optional()
        .describe("Compare to similar markets on the same chain (default true)"),
    },
    async ({ chain, target_address, target_type, period, include_peers }) => {
      try {
        const network = resolveNetwork(chain);
        const per = period || "30d";
        const addr = target_address.toLowerCase();

        // ── Target type detection ──
        // Morpho market keys are 66 chars (0x + 64 hex).
        // EVM addresses are 42 chars (0x + 40 hex).
        let type = target_type;
        if (!type) {
          if (addr.length === 66 && addr.startsWith("0x")) {
            type = "morpho";
          } else {
            // Try Morpho chain first, then Pendle, then Spectra
            type = MORPHO_CHAIN_IDS[network] ? "morpho" : PENDLE_CHAIN_IDS[network] ? "pendle" : "spectra";
          }
        }

        // ── Time range computation ──
        const now = Math.floor(Date.now() / 1000);
        const periodSeconds = per === "7d" ? 7 * 86400 : per === "90d" ? 90 * 86400 : 30 * 86400;
        const start = now - periodSeconds;
        const interval = per === "7d" ? "HOUR" : "DAY";
        const pendleTimeFrame = per === "7d" ? "hour" as const : "day" as const;

        const metrics: CalibrationMetric[] = [];
        let targetName = target_address;
        let targetType = type;
        let profileType: CalibrationProfile["target"]["type"] = "morpho_market";

        // ═══════════════════════════════════════════════
        // MORPHO CALIBRATION
        // ═══════════════════════════════════════════════
        if (type === "morpho") {
          const chainId = MORPHO_CHAIN_IDS[network];
          if (!chainId) {
            return { content: [{ type: "text" as const, text: `Morpho not available on ${chain}. Try: mainnet, base, arbitrum.` }], isError: true };
          }

          // Market key detection: if 42-char address, we need to find the market key
          let marketKey = addr;
          if (addr.length === 42) {
            // This is a collateral/loan address, not a market key. Can't calibrate directly.
            return { content: [{ type: "text" as const, text: `Address looks like an EVM address (40 hex), not a Morpho market key (64 hex). Use morpho_list_markets to find the market key, then calibrate with that.` }], isError: true };
          }

          const { market, history } = await fetchMorphoMarketHistory(marketKey, chainId, start, now, interval);
          if (!history || history.length < 3) {
            return { content: [{ type: "text" as const, text: `Insufficient data: ${history?.length || 0} data points for ${per}. Need at least 3 for calibration.` }], isError: true };
          }

          const collSymbol = market?.collateralAsset?.symbol || "?";
          const loanSymbol = market?.loanAsset?.symbol || "?";
          targetName = `${collSymbol}/${loanSymbol} Morpho market`;
          profileType = "morpho_market";

          // Build metrics from history
          const borrowM = buildMetric("Borrow APY", "%", history.map(h => h.borrowApy * 100), (history[history.length - 1]?.borrowApy || 0) * 100);
          const supplyM = buildMetric("Supply APY", "%", history.map(h => h.supplyApy * 100), (history[history.length - 1]?.supplyApy || 0) * 100);
          const utilM = buildMetric("Utilization", "%", history.map(h => h.utilization * 100), (history[history.length - 1]?.utilization || 0) * 100);
          const tvlM = buildMetric("TVL (Supply)", "USD", history.map(h => h.supplyAssetsUsd));

          if (borrowM) metrics.push(borrowM);
          if (supplyM) metrics.push(supplyM);
          if (utilM) metrics.push(utilM);
          if (tvlM) metrics.push(tvlM);

        // ═══════════════════════════════════════════════
        // PENDLE CALIBRATION
        // ═══════════════════════════════════════════════
        } else if (type === "pendle") {
          const chainId = PENDLE_CHAIN_IDS[network];
          if (!chainId) {
            return { content: [{ type: "text" as const, text: `Pendle not available on ${chain}.` }], isError: true };
          }

          const fields = ["impliedApy", "tvl", "tradingVolume", "ptPrice", "baseApy"];
          const startIso = new Date(start * 1000).toISOString();
          const endIso = new Date(now * 1000).toISOString();
          const result = await fetchPendleHistoricalData(chainId, addr, pendleTimeFrame, fields, startIso, endIso);

          if (!result.results || result.results.length < 3) {
            return { content: [{ type: "text" as const, text: `Insufficient data: ${result.results?.length || 0} points for ${per}.` }], isError: true };
          }

          targetName = `Pendle market ${addr.slice(0, 10)}...`;
          profileType = "pendle_market";

          // Extract time-series per field
          const impliedValues = result.results.map((r: any) => r.impliedApy).filter((v: any) => v != null);
          const tvlValues = result.results.map((r: any) => r.tvl).filter((v: any) => v != null);
          const volumeValues = result.results.map((r: any) => r.tradingVolume).filter((v: any) => v != null);
          const ptPriceValues = result.results.map((r: any) => r.ptPrice).filter((v: any) => v != null);
          const baseApyValues = result.results.map((r: any) => r.baseApy).filter((v: any) => v != null);

          const impliedM = buildMetric("Implied APY", "%", impliedValues.map((v: number) => v * 100));
          const tvlM = buildMetric("TVL", "USD", tvlValues);
          const volM = buildMetric("Daily Volume", "USD", volumeValues);
          const ptM = buildMetric("PT Price", "ratio", ptPriceValues);
          const baseM = buildMetric("Base APY (variable)", "%", baseApyValues.map((v: number) => v * 100));

          if (impliedM) metrics.push(impliedM);
          if (baseM) metrics.push(baseM);
          if (tvlM) metrics.push(tvlM);
          if (volM) metrics.push(volM);
          if (ptM) metrics.push(ptM);

        // ═══════════════════════════════════════════════
        // SPECTRA / IBT CALIBRATION
        // ═══════════════════════════════════════════════
        } else {
          // For Spectra, we use the pool/PT API data + on-chain IBT rate
          targetName = `Spectra pool ${addr.slice(0, 10)}...`;
          profileType = type === "ibt" ? "ibt" : "spectra_pool";

          // Try to get PT details for historical context
          try {
            const ptData = await fetchSpectra(`/${network}/pt/${addr}`) as any;
            if (ptData?.name) targetName = ptData.name;
            if (ptData?.pools?.[0]?.impliedApy != null) {
              // Single-point — not enough for calibration, but we can note current state
              const pool = ptData.pools[0];
              const singleMetric = buildMetric("Implied APY (current only)", "%", [pool.impliedApy * 100], pool.impliedApy * 100);
              if (singleMetric) {
                singleMetric.dataPoints = 1;
                metrics.push(singleMetric);
              }
            }
          } catch {}

          // On-chain conversion rate — single point but important
          try {
            const rate = await fetchIbtConversionRate(addr, 18, network);
            if (rate != null) {
              const rateMetric = buildMetric("Conversion Rate (live)", "ratio", [rate], rate);
              if (rateMetric) {
                rateMetric.dataPoints = 1;
                metrics.push(rateMetric);
              }
            }
          } catch {}

          if (metrics.length === 0) {
            return { content: [{ type: "text" as const, text: `Could not fetch calibration data for ${addr} on ${chain}. For Spectra pools, historical time-series data is limited. Try a Morpho market key or Pendle market address for richer calibration.` }], isError: true };
          }
        }

        // ═══════════════════════════════════════════════
        // PEER COMPARISON
        // ═══════════════════════════════════════════════
        let peerComparison: CalibrationProfile["peerComparison"] = null;

        if (include_peers && (type === "morpho" || type === "pendle")) {
          try {
            if (type === "morpho") {
              // Fetch all Morpho markets on this chain, compare borrow rates
              const chainId = MORPHO_CHAIN_IDS[network];
              if (chainId) {
                const query = `{ markets(where: { chainId_in: [${chainId}] }, first: 50) { items { uniqueKey loanAsset { symbol } state { borrowApy supplyApy utilization supplyAssetsUsd } } } }`;
                const data = await fetchMorpho(query) as any;
                const allMarkets = data?.markets?.items || [];
                const targetMarket = allMarkets.find((m: any) => m.uniqueKey?.toLowerCase() === addr);
                const loanSymbol = targetMarket?.loanAsset?.symbol || "?";

                // Filter peers: same loan asset
                const peers = allMarkets.filter((m: any) =>
                  m.loanAsset?.symbol === loanSymbol &&
                  m.state?.supplyAssetsUsd > 10000
                );

                if (peers.length >= 2) {
                  const peerBorrowRates = peers.map((m: any) => (m.state?.borrowApy || 0) * 100).sort((a: number, b: number) => a - b);
                  const myRate = (targetMarket?.state?.borrowApy || 0) * 100;
                  const myRank = peerBorrowRates.filter((r: number) => r <= myRate).length;
                  const myPct = Math.round((myRank / peerBorrowRates.length) * 100);

                  const peerUtils = peers.map((m: any) => (m.state?.utilization || 0) * 100).sort((a: number, b: number) => a - b);
                  const myUtil = (targetMarket?.state?.utilization || 0) * 100;
                  const utilRank = peerUtils.filter((r: number) => r <= myUtil).length;
                  const utilPct = Math.round((utilRank / peerUtils.length) * 100);

                  peerComparison = {
                    groupDescription: `${peers.length} ${loanSymbol} Morpho markets on ${chain}`,
                    peerCount: peers.length,
                    rankings: [
                      { metric: "Borrow Rate", percentile: myPct, label: myPct > 75 ? "high" : myPct > 50 ? "above average" : myPct > 25 ? "middle of pack" : "low" },
                      { metric: "Utilization", percentile: utilPct, label: utilPct > 75 ? "high demand" : utilPct > 50 ? "above average" : "moderate" },
                    ],
                  };
                }
              }
            } else if (type === "pendle") {
              // Pendle peer comparison: fetch all active markets on this chain,
              // compare implied APY and TVL for similar underlyings
              const chainId = PENDLE_CHAIN_IDS[network];
              if (chainId) {
                try {
                  const raw = await (await fetch(
                    `https://api-v2.pendle.finance/core/v1/${chainId}/markets?order_by=name%3A1&skip=0&limit=50&select=pro`,
                    { signal: AbortSignal.timeout(10000) }
                  )).json() as any;
                  const allMarkets = raw?.results || [];

                  if (allMarkets.length >= 2) {
                    // Get this market's APY for comparison
                    const targetMetric = metrics.find(m => m.name === "Implied APY");
                    const targetApy = targetMetric?.stats.current || 0;

                    const peerApys = allMarkets
                      .map((m: any) => (m.impliedApy || 0) * 100)
                      .filter((v: number) => v > 0)
                      .sort((a: number, b: number) => a - b);

                    const peerTvls = allMarkets
                      .map((m: any) => m.totalTvl || m.liquidity?.usd || 0)
                      .filter((v: number) => v > 0)
                      .sort((a: number, b: number) => a - b);

                    if (peerApys.length >= 2) {
                      const apyRank = peerApys.filter((r: number) => r <= targetApy).length;
                      const apyPct = Math.round((apyRank / peerApys.length) * 100);

                      const rankings: Array<{ metric: string; percentile: number; label: string }> = [
                        { metric: "Implied APY", percentile: apyPct, label: apyPct > 75 ? "high yield" : apyPct > 50 ? "above average" : apyPct > 25 ? "middle of pack" : "low yield" },
                      ];

                      // TVL ranking if we have target TVL
                      const tvlMetric = metrics.find(m => m.name === "TVL");
                      if (tvlMetric && peerTvls.length >= 2) {
                        const tvlRank = peerTvls.filter((r: number) => r <= tvlMetric.stats.current).length;
                        const tvlPct = Math.round((tvlRank / peerTvls.length) * 100);
                        rankings.push({ metric: "TVL", percentile: tvlPct, label: tvlPct > 75 ? "large market" : tvlPct > 50 ? "above average" : "smaller market" });
                      }

                      peerComparison = {
                        groupDescription: `${peerApys.length} active Pendle markets on ${chain}`,
                        peerCount: peerApys.length,
                        rankings,
                      };
                    }
                  }
                } catch {}
              }
            }
          } catch {}
        }

        // ═══════════════════════════════════════════════
        // COMPOSE OUTPUT
        // ═══════════════════════════════════════════════
        const assertionHints = generateAssertionHints(metrics, targetName);

        const lines: string[] = [];
        lines.push(`═══ CALIBRATION PROFILE ═══`);
        lines.push(`  Target: ${targetName}`);
        lines.push(`  Type: ${profileType} | Chain: ${chain} | Period: ${per}`);
        lines.push(`  Data: ${metrics.reduce((s, m) => Math.max(s, m.dataPoints), 0)} observations`);
        lines.push(``);

        // Observation boundary — what this calibration cannot tell you
        const sparseness = metrics.some(m => m.dataPoints < 10);
        if (sparseness) {
          lines.push(`⚠ LOW DATA: Some metrics have < 10 observations. Calibration is indicative, not reliable.`);
          lines.push(`  For robust thresholds, use a longer period (90d) or wait for more data to accumulate.`);
          lines.push(``);
        }

        // Metric blocks
        for (const m of metrics) {
          lines.push(...formatMetricBlock(m));
          lines.push(``);
        }

        // Peer comparison
        if (peerComparison) {
          lines.push(`── Peer Comparison ──`);
          lines.push(`  Among ${peerComparison.groupDescription}:`);
          for (const r of peerComparison.rankings) {
            lines.push(`    ${r.metric}: ${r.percentile}th percentile (${r.label})`);
          }
          lines.push(``);
        }

        // Assertion hints
        if (assertionHints.length > 0) {
          lines.push(`── Assertion-Ready Thresholds ──`);
          for (const hint of assertionHints) {
            lines.push(`  • ${hint}`);
          }
          lines.push(``);
        }

        // Observation boundary
        lines.push(`── Observation Boundary ──`);
        lines.push(`  This calibration is a ${per} snapshot. It cannot detect:`);
        lines.push(`  - Regime changes (rate model updates, governance parameter changes)`);
        lines.push(`  - Black swan events outside the observation window`);
        lines.push(`  - Intra-block manipulation (MEV, flash loans)`);
        lines.push(`  - Causal relationships (correlation ≠ causation between metrics)`);
        lines.push(`  Use multiple periods (7d + 30d + 90d) to assess stability over time.`);

        // Next steps
        lines.push(``);
        lines.push(`── Next Steps ──`);
        lines.push(`• Deeper history: morpho_get_history or pendle_get_market_history for raw time-series`);
        lines.push(`• Live health: mv_check_ibt_health for single-point ERC-4626 checks`);
        lines.push(`• Risk context: morpho_monitor_risk for liquidation distance on active positions`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Calibration error: ${e.message}` }], isError: true };
      }
    }
  );
}
