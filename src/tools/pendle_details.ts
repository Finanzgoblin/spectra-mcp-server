/**
 * Tool: pendle_get_market_details
 *
 * Detailed view of a single Pendle market — the Pendle equivalent of spectra_get_pt_details.
 * Returns PT/YT/SY addresses, implied APY, LP APY breakdown, liquidity, TVL,
 * underlying, maturity, PENDLE incentives, and Merkl campaigns.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PENDLE_CHAIN_IDS, PENDLE_CHAIN_NAMES, EVM_ADDRESS } from "../config.js";
import type { MerklCampaign } from "../types.js";
import { fetchPendleMarketDetail, fetchMerklCampaigns, lookupMerklCampaigns } from "../api.js";
import { formatPendleMarketSummary, pendleDaysToMaturity, formatPct, formatUsd, CROSS_TOOL_THRESHOLDS } from "../formatters.js";

const PENDLE_CHAIN_KEYS = Object.keys(PENDLE_CHAIN_IDS) as [string, ...string[]];
const PENDLE_CHAIN_ENUM = z.enum(PENDLE_CHAIN_KEYS);

export function register(server: McpServer): void {
  server.tool(
    "pendle_get_market_details",
    `Get detailed information about a specific Pendle market by address.

Returns: market name, PT/YT/SY/underlying addresses, implied APY (fixed rate),
LP APY breakdown (swap fees + PENDLE incentives + boost), underlying variable APY,
TVL, pool liquidity, 24h volume, pool reserves, maturity, and external Merkl campaigns.

This is the Pendle equivalent of spectra_get_pt_details. Use it to drill into a
specific Pendle market after finding it via pendle_list_markets, mv_compare_yield,
or mv_scan_curator_opportunities.

Use mv_check_ibt_health(ibt_address=SY_ADDRESS) to assess the underlying vault's health.
Use mv_compare_yield to compare this market with Spectra equivalents.`,
    {
      chain: PENDLE_CHAIN_ENUM.describe(
        "The blockchain network where the Pendle market is deployed."
      ),
      market_address: EVM_ADDRESS.describe(
        "The Pendle market/pool contract address."
      ),
    },
    async ({ chain, market_address }) => {
      try {
        const market = await fetchPendleMarketDetail(chain, market_address);

        if (!market) {
          const text = [
            `Pendle market ${market_address} not found on ${PENDLE_CHAIN_NAMES[chain] || chain}.`,
            ``,
            `Possible causes:`,
            `  - Wrong chain (try other chains: ${PENDLE_CHAIN_KEYS.join(", ")})`,
            `  - Market is inactive/expired and not cached`,
            `  - Invalid address`,
            ``,
            `Use pendle_list_markets(chain="${chain}") to discover available markets.`,
          ].join("\n");
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Fetch Merkl campaigns (best-effort)
        const chainId = PENDLE_CHAIN_IDS[chain];
        let merklCampaigns: MerklCampaign[] = [];
        if (chainId) {
          try {
            const result = await fetchMerklCampaigns(chainId);
            const addrs = [market.address, market.pt, market.yt, market.sy].filter(Boolean);
            merklCampaigns = lookupMerklCampaigns(result.campaigns, addrs);
          } catch {
            // Best-effort
          }
        }

        const days = pendleDaysToMaturity(market.expiry);
        const d = market.details;
        const lines: string[] = [];

        lines.push(formatPendleMarketSummary(market, chain, merklCampaigns));

        // Additional analysis section
        lines.push(``);
        lines.push(`--- Analysis ---`);

        // Fixed vs variable spread
        const impliedPct = d.impliedApy * 100;
        const varPct = d.underlyingApy * 100;
        const spread = impliedPct - varPct;
        if (Math.abs(spread) < 0.3) {
          lines.push(`  Fixed ≈ Variable (spread ${formatPct(Math.abs(spread))}) — no directional edge`);
        } else if (spread > 0) {
          lines.push(`  Fixed rate premium: +${formatPct(spread)} above current variable rate`);
          if (spread > 3) {
            lines.push(`  Large premium — two readings:`);
            lines.push(`    (A) Market expects variable rates to rise, making current fixed rate a relative bargain`);
            lines.push(`    (B) PT liquidity is thin and the discount is a compensation for illiquidity, not a yield signal`);
          }
        } else {
          lines.push(`  Variable rate premium: +${formatPct(-spread)} above fixed rate`);
          if (-spread > 3) {
            lines.push(`  Large variable premium — two readings:`);
            lines.push(`    (A) Market expects variable rates to fall, so PT is priced near par (modest fixed rate)`);
            lines.push(`    (B) Current variable rate is elevated by temporary incentives that will decay`);
          }
        }

        // Maturity warning
        if (days < 7) {
          lines.push(`  ⚠ Very short maturity (<7d) — limited yield capture window`);
        } else if (days < 14) {
          lines.push(`  ⚠ Short maturity (<14d) — entry costs may erode returns`);
        }

        // Liquidity assessment
        if (d.liquidity < CROSS_TOOL_THRESHOLDS.LOW_LIQUIDITY_USD) {
          lines.push(`  ⚠ Low pool liquidity (${formatUsd(d.liquidity)}) — large trades will face significant slippage`);
        }

        // LP boost opportunity
        if (d.maxBoostedApy > d.aggregatedApy) {
          const boostDelta = (d.maxBoostedApy - d.aggregatedApy) * 100;
          lines.push(`  vePENDLE boost opportunity: +${formatPct(boostDelta)} LP APY with max boost`);
        }

        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`  • Compare with Spectra: mv_compare_yield(chain="${chain}", asset_filter="ASSET")`);
        lines.push(`  • IBT health check: mv_check_ibt_health(chain="${chain}", ibt_address="${market.sy}")`);
        lines.push(`  • Capital-aware scan: pendle_scan_opportunities(capital_usd=AMOUNT) for sizing`);
        lines.push(`  • Cross-protocol scan: mv_scan_curator_opportunities(capital_usd=AMOUNT) for unified ranking`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
