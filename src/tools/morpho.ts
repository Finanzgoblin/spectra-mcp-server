/**
 * Tools: get_morpho_markets, get_morpho_rate
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, MORPHO_CHAIN_IDS, resolveNetwork } from "../config.js";
import type { MorphoMarket } from "../types.js";
import { fetchMorpho, sanitizeGraphQL, MORPHO_MARKET_FIELDS, fetchSpectraPtAddresses } from "../api.js";
import { formatPct, formatMorphoLltv, formatMorphoMarketSummary } from "../formatters.js";
import { dual } from "./dual.js";

export function register(server: McpServer): void {
  // ===========================================================================
  // get_morpho_markets
  // ===========================================================================

  server.tool(
    "get_morpho_markets",
    `Find Morpho lending markets that accept Spectra PT tokens as collateral.
Returns market details including LLTV, borrow/supply APY, utilization, and liquidity.
Essential for looping strategies: borrow against PT to lever up fixed yield.
Can search across all chains or filter by a specific chain.

Protocol context:
- LLTV = Liquidation Loan-to-Value. This is the threshold where liquidation CAN occur,
  NOT the safe operating level. Loop safely at ~90-95% of LLTV for margin buffer.
- High utilization (>90%) means limited borrowing capacity — check available liquidity.
- Borrow rates are variable and can spike. Monitor rates when running leveraged positions.
- Not all Spectra chains have Morpho markets. Current Morpho PT coverage: mainnet, base,
  arbitrum, katana.

Use get_looping_strategy to calculate leveraged yield for a specific PT + Morpho market.
Use get_morpho_rate to fetch live borrow APY for a specific market key.
Use scan_opportunities for automated cross-chain looping discovery.`,
    {
      chain: CHAIN_ENUM
        .optional()
        .describe("Filter by Spectra chain. Omit to search all chains with Morpho PT markets."),
      pt_symbol_filter: z
        .string()
        .max(100)
        .optional()
        .describe("Filter by PT symbol (e.g., 'USDC', 'reUSD', 'sUSDe'). Matches against collateral symbol."),
      min_supply_usd: z
        .number()
        .default(0)
        .describe("Minimum total supply in USD (default 0)"),
      sort_by: z
        .enum(["supply", "borrow_apy", "utilization"])
        .default("supply")
        .describe("Sort results (descending): supply, borrow_apy, or utilization"),
      top_n: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of results to return (default 10, max 50)"),
    },
    async ({ chain, pt_symbol_filter, min_supply_usd, sort_by, top_n }) => {
      try {
        // Determine which Morpho chain IDs to query
        let chainIds: number[] = [];
        if (chain) {
          const network = resolveNetwork(chain);
          const morphoId = MORPHO_CHAIN_IDS[network];
          if (!morphoId) {
            return { content: [{ type: "text", text: `No Morpho PT markets are currently tracked for ${chain}. Morpho PT markets exist on: ${Object.keys(MORPHO_CHAIN_IDS).join(", ")}.` }], isError: true };
          }
          chainIds = [morphoId];
        } else {
          chainIds = Object.values(MORPHO_CHAIN_IDS);
        }

        // Build search string — always include PT- prefix, optionally narrow by symbol
        // Sanitize user input to prevent GraphQL injection
        const search = pt_symbol_filter ? `PT-${sanitizeGraphQL(pt_symbol_filter)}` : "PT-";

        const orderBy = sort_by === "borrow_apy" ? "BorrowApy"
          : sort_by === "utilization" ? "Utilization"
          : "SupplyAssetsUsd";

        const query = `{
          markets(
            where: {
              search: "${search}"
              chainId_in: [${chainIds.join(",")}]
              ${min_supply_usd > 0 ? `supplyAssetsUsd_gte: ${Number(min_supply_usd)}` : ""}
            }
            first: ${Math.min(Number(top_n), 50)}
            orderBy: ${orderBy}
            orderDirection: Desc
          ) {
            items { ${MORPHO_MARKET_FIELDS} }
            pageInfo { count countTotal }
          }
        }`;

        // Fetch Morpho markets and Spectra PT addresses in parallel
        const [morphoData, spectraPtAddrs] = await Promise.all([
          fetchMorpho(query) as Promise<any>,
          fetchSpectraPtAddresses(),
        ]);

        const items: MorphoMarket[] = morphoData?.markets?.items || [];
        const total = morphoData?.markets?.pageInfo?.countTotal || 0;

        if (items.length === 0) {
          const scope = chain || "any tracked chain";
          const ts = Math.floor(Date.now() / 1000);
          const text = `No Morpho PT markets found on ${scope}${pt_symbol_filter ? ` matching "${pt_symbol_filter}"` : ""}. Total PT markets on Morpho: query returned 0 results.`;
          return dual(text, { tool: "get_morpho_markets", ts, params: { chain, pt_symbol_filter, min_supply_usd, sort_by, top_n }, data: { markets: [], total: 0 } });
        }

        // Cross-reference: tag each market as Spectra or Pendle/Other
        const summaries = items.map((m) => {
          const collateralAddr = m.collateralAsset?.address?.toLowerCase() || "";
          const protocol = spectraPtAddrs.has(collateralAddr) ? "Spectra" : "Pendle/Other";
          return formatMorphoMarketSummary(m, protocol);
        });

        const spectraCount = items.filter(
          (m) => spectraPtAddrs.has(m.collateralAsset?.address?.toLowerCase() || "")
        ).length;
        const scope = chain || "all chains";
        const header = `Found ${items.length} of ${total} Morpho PT market(s) (${scope}${pt_symbol_filter ? `, filter: ${pt_symbol_filter}` : ""}, sorted by ${sort_by}):\n` +
          `  Spectra: ${spectraCount} | Pendle/Other: ${items.length - spectraCount}\n`;

        const ts = Math.floor(Date.now() / 1000);
        return dual(header + "\n" + summaries.join("\n\n"), { tool: "get_morpho_markets", ts, params: { chain, pt_symbol_filter, min_supply_usd, sort_by, top_n }, data: { markets: items, total } });
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error fetching Morpho markets: ${e.message}` }], isError: true };
      }
    }
  );

  // ===========================================================================
  // get_morpho_rate
  // ===========================================================================

  server.tool(
    "get_morpho_rate",
    `Get the current borrow rate and market state for a specific Morpho market.
Provide the market's unique key (hex ID) and chain. Returns live borrow APY,
supply APY, utilization, and liquidity — the data needed to calculate
looping profitability. Use get_morpho_markets to discover market keys first.

Important: Rates are live as-of-query and change continuously based on utilization.
When planning a looping strategy, verify rates are still favorable before executing.
A profitable spread (fixed yield > borrow rate) can turn negative if borrow rates spike.

Use get_looping_strategy with these rates to calculate leveraged yield projections.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network where the Morpho market lives"),
      market_key: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid Morpho market key — must be 0x followed by 64 hex characters")
        .describe("The Morpho market unique key (0x + 64 hex chars). Use get_morpho_markets to find it."),
    },
    async ({ chain, market_key }) => {
      try {
        const network = resolveNetwork(chain);
        const morphoChainId = MORPHO_CHAIN_IDS[network];
        if (!morphoChainId) {
          const ts = Math.floor(Date.now() / 1000);
          return dual(`Morpho is not tracked for ${chain}. Supported: ${Object.keys(MORPHO_CHAIN_IDS).join(", ")}.`, { tool: "get_morpho_rate", ts, params: { chain, market_key }, data: { market: null } });
        }

        const query = `{
          marketByUniqueKey(uniqueKey: "${sanitizeGraphQL(market_key)}", chainId: ${morphoChainId}) {
            ${MORPHO_MARKET_FIELDS}
          }
        }`;

        const data = await fetchMorpho(query) as any;
        const market: MorphoMarket | null = data?.marketByUniqueKey;

        if (!market) {
          const ts = Math.floor(Date.now() / 1000);
          return dual(`No Morpho market found for key ${market_key} on chain ${chain} (chainId ${morphoChainId}). Verify the key and chain match.`, { tool: "get_morpho_rate", ts, params: { chain, market_key }, data: { market: null } });
        }

        const summary = formatMorphoMarketSummary(market);

        // Add actionable context for looping
        const lltv = formatMorphoLltv(market.lltv);
        const borrowApy = market.state?.borrowApy || 0;
        const lines = [
          summary,
          ``,
          `  For Looping:`,
          `    Use morpho_ltv = ${lltv.toFixed(4)} and borrow_rate = ${formatPct(borrowApy * 100)}`,
          `    in get_looping_strategy to calculate leveraged yield.`,
        ];

        const ts = Math.floor(Date.now() / 1000);
        return dual(lines.join("\n"), { tool: "get_morpho_rate", ts, params: { chain, market_key }, data: { market } });
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error fetching Morpho rate: ${e.message}` }], isError: true };
      }
    }
  );
}
