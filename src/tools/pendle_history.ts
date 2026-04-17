/**
 * Tool: pendle_get_market_history
 *
 * Historical time-series data for a Pendle market.
 * The first tool in the MCP that answers "what happened over time?"
 *
 * Source: Pendle v2 historical-data endpoint.
 * Up to 1440 data points: hourly (60d), daily (4yr), weekly (27yr).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES, EVM_ADDRESS } from "../config.js";
import { fetchPendleHistoricalData, fetchPendleMarketDetail } from "../api.js";
import { formatPct, formatUsd } from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

const PERIOD_MAP: Record<string, { timeFrame: "hour" | "day" | "week"; daysBack: number; label: string }> = {
  "7d":  { timeFrame: "hour", daysBack: 7, label: "7 days (hourly)" },
  "30d": { timeFrame: "day",  daysBack: 30, label: "30 days (daily)" },
  "90d": { timeFrame: "day",  daysBack: 90, label: "90 days (daily)" },
  "1y":  { timeFrame: "week", daysBack: 365, label: "1 year (weekly)" },
};

const DEFAULT_FIELDS = ["impliedApy", "tvl", "tradingVolume", "ptPrice", "ytPrice"];

const ALL_FIELDS = [
  "impliedApy", "tvl", "tradingVolume", "ptPrice", "ytPrice",
  "baseApy", "lpPrice", "lpRewardApy", "maxApy", "pendleApy",
  "swapFeeApy", "syPrice", "totalPt", "totalSupply", "totalSy",
  "totalTvl", "underlyingApy", "underlyingInterestApy",
  "underlyingRewardApy", "voterApr", "ytFloatingApy", "lastEpochVotes",
];

function computeStats(values: number[]): { min: number; max: number; avg: number; current: number; stddev: number } {
  if (values.length === 0) return { min: 0, max: 0, avg: 0, current: 0, stddev: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const current = values[values.length - 1];
  const variance = values.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  return { min, max, avg, current, stddev };
}

function trendDirection(values: number[]): string {
  if (values.length < 3) return "insufficient data";
  const first = values.slice(0, Math.ceil(values.length / 3));
  const last = values.slice(-Math.ceil(values.length / 3));
  const firstAvg = first.reduce((s, v) => s + v, 0) / first.length;
  const lastAvg = last.reduce((s, v) => s + v, 0) / last.length;
  const pctChange = firstAvg === 0 ? 0 : ((lastAvg - firstAvg) / Math.abs(firstAvg)) * 100;
  if (Math.abs(pctChange) < 5) return "flat";
  return pctChange > 0 ? `rising (+${pctChange.toFixed(1)}%)` : `falling (${pctChange.toFixed(1)}%)`;
}

function formatFieldValue(field: string, value: number): string {
  if (field.toLowerCase().includes("apy") || field.toLowerCase().includes("apr")) {
    return formatPct(value * 100);
  }
  if (field.toLowerCase().includes("tvl") || field.toLowerCase().includes("volume")) {
    return formatUsd(value);
  }
  if (field.toLowerCase().includes("price")) {
    return value.toFixed(6);
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function register(server: McpServer): void {
  server.tool(
    "pendle_get_market_history",
    `Historical time-series data for a Pendle market.

Shows how implied APY, TVL, volume, PT/YT prices, and other metrics have moved
over time. The first tool that answers "what happened?" not just "what is it now?"

Enables: trend analysis, yield stability assessment, anomaly detection, conviction
building before entry. A flat APY with low stddev means predictable yield. A
volatile APY with high stddev means the rate you see today may not persist.

Available fields: impliedApy, tvl, tradingVolume, ptPrice, ytPrice, baseApy,
lpPrice, lpRewardApy, maxApy, pendleApy, swapFeeApy, syPrice, totalPt,
totalSupply, totalSy, totalTvl, underlyingApy, underlyingInterestApy,
underlyingRewardApy, voterApr, ytFloatingApy, lastEpochVotes

Use pendle_get_market_details for current market snapshot.
Use pendle_list_markets to find market addresses.`,
    {
      chain: PENDLE_CHAIN_ENUM.describe("The blockchain network where the Pendle market lives."),
      market_address: EVM_ADDRESS.describe("The Pendle market/pool contract address."),
      period: z.enum(["7d", "30d", "90d", "1y"]).default("30d").describe(
        "Time period: 7d (hourly), 30d (daily), 90d (daily), 1y (weekly). Default 30d."
      ),
      fields: z.string().optional().describe(
        "Comma-separated fields to include. Default: impliedApy,tvl,tradingVolume,ptPrice,ytPrice. Use 'all' for everything."
      ),
    },
    async ({ chain, market_address, period, fields: fieldsParam }) => {
      try {
        const periodConfig = PERIOD_MAP[period] || PERIOD_MAP["30d"];
        const pendleChainId = PENDLE_CHAIN_IDS[chain];
        if (!pendleChainId) {
          return { content: [{ type: "text" as const, text: `Chain "${chain}" is not supported by Pendle.` }] };
        }

        // Parse fields
        let requestedFields: string[];
        if (fieldsParam === "all") {
          requestedFields = ALL_FIELDS;
        } else if (fieldsParam) {
          requestedFields = fieldsParam.split(",").map((f) => f.trim()).filter(Boolean);
        } else {
          requestedFields = DEFAULT_FIELDS;
        }

        // Compute time range
        const end = new Date();
        const start = new Date(end.getTime() - periodConfig.daysBack * 24 * 60 * 60 * 1000);

        // Fetch historical data and market detail in parallel
        const [histData, marketDetail] = await Promise.all([
          fetchPendleHistoricalData(
            pendleChainId,
            market_address,
            periodConfig.timeFrame,
            requestedFields,
            start.toISOString(),
            end.toISOString(),
          ),
          fetchPendleMarketDetail(chain, market_address),
        ]);

        if (histData.results.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No historical data available for ${market_address} on ${chain} over ${period}.\nThe market may be too new or the address may be incorrect.`,
            }],
          };
        }

        const lines: string[] = [];
        const marketName = marketDetail?.name || market_address;
        lines.push(`== ${marketName} — Historical Data (${periodConfig.label}) ==`);
        lines.push(`  Chain: ${PENDLE_CHAIN_NAMES[chain] || chain}`);
        lines.push(`  Market: ${market_address}`);
        lines.push(`  Data points: ${histData.results.length}`);
        lines.push(`  Period: ${histData.results[0]?.timestamp?.split("T")[0] || "?"} to ${histData.results[histData.results.length - 1]?.timestamp?.split("T")[0] || "?"}`);
        lines.push(``);

        // Per-field statistics
        const fieldStats: Map<string, ReturnType<typeof computeStats>> = new Map();
        const fieldTrends: Map<string, string> = new Map();

        for (const field of requestedFields) {
          const values = histData.results
            .map((r) => {
              const v = r[field];
              return typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
            })
            .filter((v) => !isNaN(v));

          if (values.length === 0) continue;

          const stats = computeStats(values);
          fieldStats.set(field, stats);
          fieldTrends.set(field, trendDirection(values));
        }

        lines.push(`--- Summary Statistics ---`);
        for (const [field, stats] of fieldStats) {
          const trend = fieldTrends.get(field) || "?";
          const isRate = field.toLowerCase().includes("apy") || field.toLowerCase().includes("apr");
          const stability = isRate && stats.avg > 0
            ? (stats.stddev / stats.avg * 100).toFixed(1) + "% CoV"
            : "";

          lines.push(`  ${field}:`);
          lines.push(`    Current: ${formatFieldValue(field, stats.current)} | Avg: ${formatFieldValue(field, stats.avg)} | Min: ${formatFieldValue(field, stats.min)} | Max: ${formatFieldValue(field, stats.max)}`);
          lines.push(`    Trend: ${trend}${stability ? ` | Volatility: ${stability}` : ""}`);
        }
        lines.push(``);

        // Signals
        const signals: string[] = [];
        const impliedStats = fieldStats.get("impliedApy");
        if (impliedStats) {
          const cov = impliedStats.avg > 0 ? impliedStats.stddev / impliedStats.avg : 0;
          if (cov < 0.1) {
            signals.push("Implied APY is STABLE (CoV < 10%) — the rate you see today is likely to persist");
          } else if (cov > 0.3) {
            signals.push("Implied APY is VOLATILE (CoV > 30%) — the current rate may not persist, plan for variance");
          }

          const range = impliedStats.max - impliedStats.min;
          if (range > 0.1) {
            signals.push(`APY range: ${formatPct(impliedStats.min * 100)} to ${formatPct(impliedStats.max * 100)} — ${formatPct(range * 100)} spread over the period`);
          }
        }

        const tvlStats = fieldStats.get("tvl");
        if (tvlStats) {
          const trend = fieldTrends.get("tvl") || "";
          if (trend.startsWith("falling") && tvlStats.current < tvlStats.avg * 0.7) {
            signals.push("TVL declining significantly — capital is leaving this market");
          } else if (trend.startsWith("rising") && tvlStats.current > tvlStats.avg * 1.3) {
            signals.push("TVL growing strongly — capital is flowing into this market");
          }
        }

        const volStats = fieldStats.get("tradingVolume");
        if (volStats && tvlStats && tvlStats.avg > 0) {
          const turnover = volStats.avg / tvlStats.avg;
          if (turnover > 0.05) {
            signals.push(`High turnover: avg daily volume is ${(turnover * 100).toFixed(1)}% of TVL — actively traded`);
          } else if (turnover < 0.005) {
            signals.push(`Low turnover: avg daily volume is ${(turnover * 100).toFixed(2)}% of TVL — thin trading activity`);
          }
        }

        if (signals.length > 0) {
          lines.push(`--- Signals ---`);
          for (const sig of signals) {
            lines.push(`  ${sig}`);
          }
          lines.push(``);
        }

        // Recent data points (last 5)
        const recent = histData.results.slice(-5);
        if (recent.length > 0) {
          lines.push(`--- Recent Data (last ${recent.length} points) ---`);
          for (const point of recent) {
            const ts = (point.timestamp as string)?.split("T")[0] || "?";
            const vals = requestedFields
              .filter((f) => point[f] != null)
              .map((f) => {
                const v = typeof point[f] === "number" ? point[f] as number : parseFloat(point[f] as string);
                return `${f}: ${formatFieldValue(f, v)}`;
              })
              .join(" | ");
            lines.push(`  ${ts}: ${vals}`);
          }
          lines.push(``);
        }

        lines.push(`--- Next Steps ---`);
        lines.push(`  • Current snapshot: pendle_get_market_details(chain="${chain}", market_address="${market_address}")`);
        lines.push(`  • Trade quote: pendle_quote_trade(chain="${chain}", market_address="${market_address}", amount=X, side="buy")`);
        lines.push(`  • Capacity: pendle_get_market_capacity(chain="${chain}", market_address="${market_address}")`);
        if (period !== "7d") {
          lines.push(`  • Zoom in: pendle_get_market_history(chain="${chain}", market_address="${market_address}", period="7d")`);
        }
        if (period !== "1y") {
          lines.push(`  • Zoom out: pendle_get_market_history(chain="${chain}", market_address="${market_address}", period="1y")`);
        }

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
