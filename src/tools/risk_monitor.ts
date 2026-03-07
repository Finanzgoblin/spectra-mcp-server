/**
 * Tool: morpho_monitor_risk
 *
 * Liquidation distance monitor for Morpho positions.
 * Surfaces health factor, distance-to-liquidation, borrow rate drift,
 * and alert signals for curator risk management.
 *
 * Design: Alerts scaffold attention, not action. When signals disagree
 * (e.g., health factor says "safe" but rate drift says "eroding"),
 * both are presented without collapsing the tension.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, MORPHO_CHAIN_IDS } from "../config.js";
import type { CuratorRiskSummary, RiskAlertLevel } from "../types.js";
import { fetchMorphoPositionRiskData } from "../api.js";
import { formatCuratorRiskSummary } from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "morpho_monitor_risk",
    `Monitor liquidation risk across a curator's Morpho positions.

Computes health factor, liquidation price, distance-to-liquidation, and borrow rate
for every borrowing position. Flags positions approaching danger zones.

Morpho has NO close factor — when health factor reaches 1.0, the ENTIRE position can
be liquidated in one transaction. This makes distance-to-liquidation critical: a 14%
distance means a 14% collateral price drop wipes the position completely.

Alert levels scaffold attention, not action — multiple signals may disagree:
  - ok: position healthy, no immediate concern
  - watch: distance below threshold or rate elevated — worth monitoring
  - warning: health factor < 1.3 or distance dangerously low
  - critical: health factor < 1.1 or distance < 5% — immediate attention needed

Use morpho_get_positions for raw position data without risk analysis.
Use morpho_get_history to assess borrow rate stability over time.
Use spectra_get_looping_strategy to model deleverage scenarios.`,
    {
      address: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address")
        .describe("Curator wallet address to monitor (0x...)"),
      chain: CHAIN_ENUM
        .optional()
        .describe("Restrict to a single chain. Omit to scan all Morpho-capable chains."),
      alert_threshold_pct: z
        .number()
        .min(1)
        .max(50)
        .default(15)
        .describe("Warn when distance-to-liquidation drops below this % (default 15)"),
    },
    async ({ address, chain, alert_threshold_pct }) => {
      try {
        // Validate chain has Morpho support if specified
        if (chain) {
          const hasKey = Object.keys(MORPHO_CHAIN_IDS).some(
            (k) => k === chain || k === (chain === "mainnet" ? "ethereum" : chain),
          );
          if (!hasKey) {
            const supported = Object.keys(MORPHO_CHAIN_IDS).join(", ");
            const text = `No Morpho markets tracked for ${chain}. Supported: ${supported}.`;
            return { content: [{ type: "text" as const, text }], isError: true };
          }
        }

        // Fetch enriched risk data
        const chainResults = await fetchMorphoPositionRiskData(
          address,
          chain,
          alert_threshold_pct,
        );

        // Flatten all positions across chains
        const allPositions = chainResults.flatMap((cr) => cr.positions);
        const ratesAvailable = chainResults.every((cr) => cr.ratesAvailable);

        if (allPositions.length === 0) {
          const scope = chain || "any Morpho-capable chain";
          const text = `No active borrowing positions found for ${address} on ${scope}.\n\nThis could mean:\n  - The address has no Morpho positions\n  - Positions are supply-only (no borrows = no liquidation risk)\n  - The address uses a different wallet for Morpho\n\nUse morpho_get_positions to check for supply and vault positions.`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Build summary
        const positionsByLevel: Record<RiskAlertLevel, number> = { ok: 0, watch: 0, warning: 0, critical: 0 };
        for (const p of allPositions) {
          positionsByLevel[p.alertLevel]++;
        }

        const worstPosition = allPositions.reduce((worst, p) =>
          p.healthFactor < (worst?.healthFactor ?? Infinity) ? p : worst,
        );

        const summary: CuratorRiskSummary = {
          address,
          chain: chain || null,
          totalPositions: allPositions.length,
          borrowingPositions: allPositions.length,
          totalCollateralUsd: allPositions.reduce((s, p) => s + p.collateralUsd, 0),
          totalDebtUsd: allPositions.reduce((s, p) => s + p.debtUsd, 0),
          positionsByLevel,
          worstHealthFactor: worstPosition.healthFactor,
          worstPositionMarket: worstPosition.marketKey,
          alertThresholdPct: alert_threshold_pct,
          ratesAvailable,
          positions: allPositions,
        };

        const text = formatCuratorRiskSummary(summary);
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `morpho_monitor_risk error: ${e.message || e}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}
