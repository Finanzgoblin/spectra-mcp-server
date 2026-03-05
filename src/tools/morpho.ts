/**
 * Tools: get_morpho_markets, get_morpho_rate, get_morpho_market_suppliers, get_morpho_vaults
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, MORPHO_CHAIN_IDS, resolveNetwork } from "../config.js";
import type { MorphoMarket } from "../types.js";
import { fetchMorpho, sanitizeGraphQL, MORPHO_MARKET_FIELDS, fetchSpectraPtAddresses, fetchMorphoMarketSuppliers, fetchMorphoVaults } from "../api.js";
import { formatPct, formatMorphoLltv, formatMorphoMarketSummary, formatMorphoMarketHints, formatMorphoSupplierAnalysis, formatMorphoVaultSummary, parsePtResponse } from "../formatters.js";
import { fetchSpectra } from "../api.js";

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
            const text = `No Morpho PT markets are currently tracked for ${chain}. Morpho PT markets exist on: ${Object.keys(MORPHO_CHAIN_IDS).join(", ")}.`;
            return { content: [{ type: "text" as const, text }], isError: true };
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
          const lines = [
            `No Morpho PT markets found on ${scope}${pt_symbol_filter ? ` matching "${pt_symbol_filter}"` : ""}.`,
            ``,
            `--- What This Means ---`,
            `No Morpho lending markets currently accept${pt_symbol_filter ? ` "${pt_symbol_filter}"` : ""} Spectra PTs as collateral on ${scope}.`,
            ...(chain ? [`• Morpho PT markets are available on: mainnet, base, arbitrum, katana`] : []),
            ...(chain ? [`• Try all chains: get_morpho_markets() without chain filter`] : []),
            ...(pt_symbol_filter ? [`• Try without filter: get_morpho_markets(${chain ? `chain="${chain}"` : ""}) to see all available PT markets`] : []),
            `• Leveraged strategies require a Morpho market — without one, consider:`,
            `    Unleveraged fixed yield: get_best_fixed_yields() or scan_opportunities()`,
            `    YT arbitrage: scan_yt_arbitrage(capital_usd=YOUR_AMOUNT) for spread-based opportunities`,
          ];
          const text = lines.join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        // Cross-reference: tag each market as Spectra or Pendle/Other
        const summaries = items.map((m) => {
          const collateralAddr = m.collateralAsset?.address?.toLowerCase() || "";
          const protocol = spectraPtAddrs.has(collateralAddr) ? "Spectra" : "Pendle/Other";
          const summary = formatMorphoMarketSummary(m, protocol);
          const hints = formatMorphoMarketHints(m);
          return hints.length > 0 ? summary + "\n" + hints.join("\n") : summary;
        });

        const spectraCount = items.filter(
          (m) => spectraPtAddrs.has(m.collateralAsset?.address?.toLowerCase() || "")
        ).length;
        const scope = chain || "all chains";
        const header = `Found ${items.length} of ${total} Morpho PT market(s) (${scope}${pt_symbol_filter ? `, filter: ${pt_symbol_filter}` : ""}, sorted by ${sort_by}):\n` +
          `  Spectra: ${spectraCount} | Pendle/Other: ${items.length - spectraCount}\n`;

        const footer = [
          ``,
          `--- Next Steps ---`,
          `• Live borrow rate: get_morpho_rate(chain=CHAIN, market_key=MARKET_KEY) for current rate + PT spread analysis`,
          `• Looping projection: get_looping_strategy(chain=CHAIN, pt_address=PT_ADDRESS) to model leveraged yield`,
          `• Capital-aware scan: scan_opportunities(capital_usd=YOUR_AMOUNT, include_looping=true) for cross-chain looping ranking`,
        ].join("\n");

        const text = header + "\n" + summaries.join("\n\n") + footer;
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching Morpho markets: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
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
          const text = `Morpho is not tracked for ${chain}. Supported: ${Object.keys(MORPHO_CHAIN_IDS).join(", ")}.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const query = `{
          marketByUniqueKey(uniqueKey: "${sanitizeGraphQL(market_key)}", chainId: ${morphoChainId}) {
            ${MORPHO_MARKET_FIELDS}
          }
        }`;

        const data = await fetchMorpho(query) as any;
        const market: MorphoMarket | null = data?.marketByUniqueKey;

        if (!market) {
          const text = `No Morpho market found for key ${market_key} on chain ${chain} (chainId ${morphoChainId}). Verify the key and chain match.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const summary = formatMorphoMarketSummary(market);

        // Add actionable context for looping
        const lltv = formatMorphoLltv(market.lltv);
        const borrowApy = market.state?.borrowApy || 0;
        const lines = [
          summary,
        ];

        // Layer 3: Best-effort PT spread analysis
        // Dissolution condition: Dissolves when the Morpho API itself returns
        // the PT's implied APY or a unified "looping readiness" endpoint exists.
        try {
          const ptAddress = market.collateralAsset?.address;
          if (ptAddress) {
            const ptData = await fetchSpectra(`/${network}/pt/${ptAddress}`).catch(() => null) as any;
            const pt = ptData ? parsePtResponse(ptData) : null;
            const impliedApy = pt?.pools?.[0]?.impliedApy;
            if (impliedApy !== undefined && impliedApy > 0) {
              const spread = impliedApy - borrowApy * 100;
              lines.push(``);
              lines.push(`  PT Spread Analysis:`);
              lines.push(`    PT Implied APY: ${formatPct(impliedApy)}`);
              lines.push(`    Borrow Rate: ${formatPct(borrowApy * 100)}`);
              lines.push(`    Spread: ${spread >= 0 ? "+" : ""}${formatPct(spread)}`);
              if (spread > 0) {
                lines.push(`    Spread is positive -- looping could be profitable at this borrow rate. Use get_looping_strategy to model leverage.`);
              } else {
                lines.push(`    Spread is negative -- borrowing costs exceed PT yield at current rates. Looping would reduce returns.`);
              }
            }
          }
        } catch {
          // Best-effort, don't block core output
        }

        // Best-effort supply-side analysis
        try {
          const suppliers = await fetchMorphoMarketSuppliers(market_key, morphoChainId, 5);
          if (suppliers.length > 0) {
            lines.push(``);
            lines.push(formatMorphoSupplierAnalysis(suppliers, market));
          }
        } catch {
          // Best-effort, don't block core output
        }

        lines.push(``);
        lines.push(`  For Looping:`);
        lines.push(`    Use morpho_ltv = ${lltv.toFixed(4)} and borrow_rate = ${formatPct(borrowApy * 100)}`);
        lines.push(`    in get_looping_strategy to calculate leveraged yield.`);

        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`• Supply details: get_morpho_market_suppliers(chain="${chain}", market_key="${market_key}") for full supplier breakdown`);
        lines.push(`• Vault discovery: get_morpho_vaults(chain="${chain}") to see all vaults on this chain`);
        lines.push(`• Looping: get_looping_strategy(chain="${chain}", pt_address=PT_ADDRESS) to model leveraged yield`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching Morpho rate: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // get_morpho_market_suppliers
  // ===========================================================================

  server.tool(
    "get_morpho_market_suppliers",
    `Show who supplies lending liquidity to a specific Morpho market.
Returns top suppliers ranked by supply size, identifies Morpho vaults vs EOAs vs loopers,
and provides concentration analysis.

A market's supply side determines looping viability. A high-APY market with $10K supply
from a single vault has different risk/capacity than $10M from diverse sources.

Protocol context:
- Suppliers are identified via Morpho's marketPositions query, then cross-referenced
  against the vault registry. Addresses that aren't vaults could be EOAs or contracts.
- A supplier with both collateral and borrows is likely a looper, not a lender.
  The tool tags these as [Looper] — but this is inference from position shape, not
  confirmed. The address could be a contract doing something more complex.
- Supply concentration affects rate stability: one vault withdrawing could spike borrow
  rates. High concentration is a signal, not necessarily a problem.
- Reward incentives (supply APR) can make supply competitive — or mask thin organic yield.

Use get_morpho_markets to find market keys first.
Use get_morpho_vaults to discover all vaults on a chain and their allocations.
Use get_morpho_rate for borrow-side rate and PT spread analysis.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      market_key: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid Morpho market key — must be 0x followed by 64 hex characters")
        .describe("The Morpho market unique key (0x + 64 hex chars). Use get_morpho_markets to find it."),
      top_n: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of top suppliers to return (default 10, max 50)"),
    },
    async ({ chain, market_key, top_n }) => {
      try {
        const network = resolveNetwork(chain);
        const morphoChainId = MORPHO_CHAIN_IDS[network];
        if (!morphoChainId) {
          const text = `Morpho is not tracked for ${chain}. Supported: ${Object.keys(MORPHO_CHAIN_IDS).join(", ")}.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Fetch market data and suppliers in parallel
        const marketQuery = `{
          marketByUniqueKey(uniqueKey: "${sanitizeGraphQL(market_key)}", chainId: ${morphoChainId}) {
            ${MORPHO_MARKET_FIELDS}
          }
        }`;

        const [marketData, suppliers] = await Promise.all([
          fetchMorpho(marketQuery) as Promise<any>,
          fetchMorphoMarketSuppliers(market_key, morphoChainId, top_n),
        ]);

        const market: MorphoMarket | null = marketData?.marketByUniqueKey;

        if (!market) {
          const text = `No Morpho market found for key ${market_key} on chain ${chain}. Verify the key and chain.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const analysis = formatMorphoSupplierAnalysis(suppliers, market);

        const footer = [
          ``,
          `--- Next Steps ---`,
          `• Vault details: get_morpho_vaults(chain="${chain}") to see all vaults and their allocations`,
          `• Borrow rate: get_morpho_rate(chain="${chain}", market_key="${market_key}") for rate + spread analysis`,
          `• Looping: get_looping_strategy(chain="${chain}", pt_address=PT_ADDRESS) to model leveraged yield`,
        ].join("\n");

        const text = analysis + footer;
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching market suppliers: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // get_morpho_vaults
  // ===========================================================================

  server.tool(
    "get_morpho_vaults",
    `List Morpho vaults on a chain — discover where supply-side liquidity lives.
Returns vault details including AUM, APY, fees, curator info, and market allocations.

Morpho vaults are curated lending strategies managed by curators who allocate deposits
across lending markets. They are often (but not always) the primary source of supply-side
liquidity for PT looping markets. EOA suppliers also exist.

Protocol context:
- Vault APY comes from lending yield on allocated markets, minus the curator's fee.
  High APY could indicate high borrow demand or could reflect temporary incentives.
- A vault's allocation breakdown shows which markets it supplies and how much capital
  is deployed to each. A vault allocating to a PT market directly funds the looping pool.
- Supply cap (when present) limits how much a vault will deploy to a given market.
  Uncapped allocations track demand; capped allocations create a ceiling.
- Not all vaults on a chain allocate to PT markets — many serve non-PT markets. Use
  get_morpho_market_suppliers with a specific market key to find who actually supplies it.

Use get_morpho_market_suppliers to see who supplies a specific market.
Use get_morpho_markets to find available PT lending markets.
Use get_looping_strategy to model leveraged yield after identifying supply liquidity.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network to query"),
      asset_filter: z
        .string()
        .max(100)
        .optional()
        .describe("Filter by asset symbol (e.g., 'USDT', 'USDC'). Matches vault names/assets."),
      min_tvl_usd: z
        .number()
        .default(0)
        .describe("Minimum vault AUM in USD (default 0)"),
      top_n: z
        .number()
        .min(1)
        .max(50)
        .default(20)
        .describe("Number of vaults to return (default 20, max 50)"),
    },
    async ({ chain, asset_filter, min_tvl_usd, top_n }) => {
      try {
        const network = resolveNetwork(chain);
        const morphoChainId = MORPHO_CHAIN_IDS[network];
        if (!morphoChainId) {
          const text = `Morpho is not tracked for ${chain}. Supported: ${Object.keys(MORPHO_CHAIN_IDS).join(", ")}.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const vaults = await fetchMorphoVaults(chain, {
          assetFilter: asset_filter,
          minTvlUsd: min_tvl_usd,
          topN: top_n,
        });

        if (vaults.length === 0) {
          const lines = [
            `No Morpho vaults found on ${chain}${asset_filter ? ` matching "${asset_filter}"` : ""}.`,
            ``,
            `--- What This Means ---`,
            `No curated lending vaults are currently deployed on ${chain}${asset_filter ? ` for "${asset_filter}"` : ""}.`,
            ...(asset_filter ? [`• Try without filter: get_morpho_vaults(chain="${chain}") to see all vaults`] : []),
            `• Supply-side liquidity may come from EOAs rather than vaults`,
            `• Check specific markets: get_morpho_market_suppliers(chain="${chain}", market_key=KEY)`,
          ];
          const text = lines.join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        const header = `== Morpho Vaults: ${chain}${asset_filter ? ` (filter: ${asset_filter})` : ""} ==\n` +
          `  Found ${vaults.length} vault(s)\n`;

        const summaries = vaults.map((v, i) => formatMorphoVaultSummary(v, i + 1));

        const footer = [
          ``,
          `--- Next Steps ---`,
          `• Market suppliers: get_morpho_market_suppliers(chain="${chain}", market_key=KEY) for per-market supplier breakdown`,
          `• PT markets: get_morpho_markets(chain="${chain}") to see which PTs have lending markets`,
          `• Looping: get_looping_strategy(chain="${chain}", pt_address=PT_ADDRESS) to model leveraged yield`,
        ].join("\n");

        const text = header + "\n" + summaries.join("\n\n") + "\n" + footer;
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching Morpho vaults: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
