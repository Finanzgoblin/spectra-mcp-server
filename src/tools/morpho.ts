/**
 * Tools: morpho_list_markets, morpho_get_rate, morpho_get_market_suppliers, morpho_list_vaults,
 *        morpho_get_positions, morpho_get_history
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, MORPHO_CHAIN_IDS, resolveNetwork } from "../config.js";
import type { MorphoMarket, MorphoVault, MorphoUserPositions, MorphoUserMarketPosition, MorphoUserVaultPosition, MorphoHistoricalAnalysis, MorphoHistoricalDataPoint, MorphoRateStats } from "../types.js";
import { fetchMorpho, sanitizeGraphQL, MORPHO_MARKET_FIELDS, fetchSpectraPtAddresses, fetchMorphoMarketSuppliers, fetchMorphoVaults, fetchMorphoMarketRates, fetchMorphoUserPositions, fetchMorphoMarketHistory } from "../api.js";
import { formatPct, formatUsd, formatMorphoLltv, formatMorphoMarketSummary, formatMorphoMarketHints, formatMorphoSupplierAnalysis, formatMorphoVaultSummary, formatMorphoVaultSummaryEnriched, formatMorphoUserPositions, formatMorphoHistoricalAnalysis, formatMorphoHistoryHints, parsePtResponse } from "../formatters.js";
import { fetchSpectra } from "../api.js";

export function register(server: McpServer): void {
  // ===========================================================================
  // morpho_list_markets
  // ===========================================================================

  server.tool(
    "morpho_list_markets",
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

Use spectra_get_looping_strategy to calculate leveraged yield for a specific PT + Morpho market.
Use morpho_get_rate to fetch live borrow APY for a specific market key.
Use spectra_scan_opportunities for automated cross-chain looping discovery.`,
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
            `--- Tensions ---`,
            `⚡ No market exists — but ${total} PT markets exist on other chains/assets. Morpho market`,
            `  creation is permissionless (createMarket() on Morpho.sol, ~$50 gas). Curators typically`,
            `  create and seed these markets as a strategic act — they control risk parameters (LLTV,`,
            `  oracle, caps) and earn supply-side yield on capital they provide.`,
            `⚡ This absence could mean: (A) nobody has seen sufficient demand to justify creation,`,
            `  (B) the underlying PT is too new or illiquid for comfortable collateralization, or`,
            `  (C) no curator has identified the opportunity yet. Each interpretation implies a`,
            `  different action — (A) suggests wait-and-see, (B) suggests the market shouldn't exist`,
            `  yet, (C) suggests first-mover opportunity.`,
            ``,
            ...(chain ? [`• Morpho PT markets exist on: mainnet, base, arbitrum, katana`] : []),
            ...(chain ? [`• Try all chains: morpho_list_markets() without chain filter`] : []),
            ...(pt_symbol_filter ? [`• Try without filter: morpho_list_markets(${chain ? `chain="${chain}"` : ""}) to see all available PT markets`] : []),
            `• Without leverage: spectra_get_best_fixed_yields() or spectra_scan_opportunities()`,
          ];
          const text = lines.join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        // Best-effort: fetch vaults to cross-reference which markets have vault suppliers
        const vaultsByMarket = new Map<string, string[]>();
        let vaultDataAvailable = true;
        try {
          const networks = chain ? [resolveNetwork(chain)] : Object.keys(MORPHO_CHAIN_IDS);
          const allVaults = (await Promise.all(
            networks.map((net) => fetchMorphoVaults(net).then(r => r.vaults).catch((): MorphoVault[] => [])),
          )).flat();
          if (allVaults.length === 0) vaultDataAvailable = false;
          for (const v of allVaults) {
            for (const a of v.state?.allocation || []) {
              if (!a.marketKey) continue;
              const key = a.marketKey.toLowerCase();
              if (!vaultsByMarket.has(key)) vaultsByMarket.set(key, []);
              vaultsByMarket.get(key)!.push(v.name);
            }
          }
        } catch { vaultDataAvailable = false; }

        // Cross-reference: tag each market as Spectra or Pendle/Other, add vault info
        const summaries = items.map((m) => {
          const collateralAddr = m.collateralAsset?.address?.toLowerCase() || "";
          const protocol = spectraPtAddrs.has(collateralAddr) ? "Spectra" : "Pendle/Other";
          const summary = formatMorphoMarketSummary(m, protocol);
          const hints = formatMorphoMarketHints(m);
          const parts = [summary];
          if (hints.length > 0) parts.push(hints.join("\n"));
          // Add vault supplier info
          const vaultNames = vaultsByMarket.get(m.uniqueKey?.toLowerCase() || "") || [];
          if (vaultNames.length > 0) {
            parts.push(`  Vault suppliers: ${vaultNames.length} (${vaultNames.slice(0, 3).join(", ")}${vaultNames.length > 3 ? ", ..." : ""})`);
          }
          return parts.join("\n");
        });

        const spectraCount = items.filter(
          (m) => spectraPtAddrs.has(m.collateralAsset?.address?.toLowerCase() || "")
        ).length;
        const scope = chain || "all chains";
        const headerLines = [
          `Found ${items.length} of ${total} Morpho PT market(s) (${scope}${pt_symbol_filter ? `, filter: ${pt_symbol_filter}` : ""}, sorted by ${sort_by}):`,
          `  Displayed: Spectra: ${spectraCount} | Pendle/Other: ${items.length - spectraCount}`,
        ];
        // Truncation notice — prevent agents from generalizing displayed composition to the full set
        const truncated = total - items.length;
        if (truncated > 0 && !chain) {
          const morphoChains = Object.keys(MORPHO_CHAIN_IDS).join(", ");
          headerLines.push(`  ⚠ ${truncated} additional market(s) not shown. Smaller markets on specific chains may not appear in top-${items.length} global ranking.`);
          headerLines.push(`    → Use chain parameter (e.g., chain="katana") for chain-specific discovery. Morpho-capable chains: ${morphoChains}`);
        }
        const header = headerLines.join("\n") + "\n";

        const footer = [
          ``,
          `--- Next Steps ---`,
          `• Live borrow rate: morpho_get_rate(chain=CHAIN, market_key=MARKET_KEY) for current rate + PT spread analysis`,
          `• Looping projection: spectra_get_looping_strategy(chain=CHAIN, pt_address=PT_ADDRESS) to model leveraged yield`,
          `• Rate history: morpho_get_history(chain=CHAIN, market_key=KEY) for historical rate trends`,
          `• Capital-aware scan: spectra_scan_opportunities(capital_usd=YOUR_AMOUNT, include_looping=true) for cross-chain looping ranking`,
        ].join("\n");

        let text = header + "\n" + summaries.join("\n\n") + footer;
        if (!vaultDataAvailable) {
          text += `\nNote: Vault supplier data unavailable — vault cross-reference may be incomplete.`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching Morpho markets: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // morpho_get_rate
  // ===========================================================================

  server.tool(
    "morpho_get_rate",
    `Get the current borrow rate and market state for a specific Morpho market.
Provide the market's unique key (hex ID) and chain. Returns live borrow APY,
supply APY, utilization, and liquidity — the data needed to calculate
looping profitability. Use morpho_list_markets to discover market keys first.

Important: Rates are live as-of-query and change continuously based on utilization.
When planning a looping strategy, verify rates are still favorable before executing.
A profitable spread (fixed yield > borrow rate) can turn negative if borrow rates spike.

Use spectra_get_looping_strategy with these rates to calculate leveraged yield projections.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network where the Morpho market lives"),
      market_key: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid Morpho market key — must be 0x followed by 64 hex characters")
        .describe("The Morpho market unique key (0x + 64 hex chars). Use morpho_list_markets to find it."),
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
            publicAllocatorSharedLiquidity {
              vault { address name }
              assets
              withdrawMarket { uniqueKey loanAsset { symbol } collateralAsset { symbol } }
            }
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
        let ptSpreadAvailable = false;
        try {
          const ptAddress = market.collateralAsset?.address;
          if (ptAddress) {
            const ptData = await fetchSpectra(`/${network}/pt/${ptAddress}`).catch(() => null) as any;
            const pt = ptData ? parsePtResponse(ptData) : null;
            const impliedApy = pt?.pools?.[0]?.impliedApy;
            if (impliedApy !== undefined && impliedApy > 0) {
              ptSpreadAvailable = true;
              const spread = impliedApy - borrowApy * 100;
              lines.push(``);
              lines.push(`  PT Spread Analysis:`);
              lines.push(`    PT Implied APY: ${formatPct(impliedApy)}`);
              lines.push(`    Borrow Rate: ${formatPct(borrowApy * 100)}`);
              lines.push(`    Spread: ${spread >= 0 ? "+" : ""}${formatPct(spread)}`);
              if (spread > 0) {
                lines.push(`    Spread is positive -- looping could be profitable at this borrow rate. Use spectra_get_looping_strategy to model leverage.`);
              } else {
                lines.push(`    Spread is negative -- borrowing costs exceed PT yield at current rates. Looping would reduce returns.`);
              }
            }
          }
        } catch {
          // Best-effort, don't block core output
        }

        // Best-effort supply-side analysis with vault cross-linking
        let supplierDataAvailable = false;
        try {
          const [suppResult, vaultResult] = await Promise.all([
            fetchMorphoMarketSuppliers(market_key, morphoChainId, 5),
            fetchMorphoVaults(chain).then(r => r.vaults).catch((): MorphoVault[] => []),
          ]);
          const suppliers = suppResult.suppliers;
          const vaults = vaultResult;
          if (suppliers.length > 0) {
            supplierDataAvailable = true;
            lines.push(``);
            lines.push(formatMorphoSupplierAnalysis(suppliers, market));

            // Cross-link vault suppliers with their allocation details
            const vaultSuppliers = suppliers.filter((s) => s.isVault);
            if (vaultSuppliers.length > 0 && vaults.length > 0) {
              const enriched: string[] = [];
              for (const vs of vaultSuppliers) {
                const vault = vaults.find((v) => v.address.toLowerCase() === vs.address.toLowerCase());
                if (!vault) continue;
                const alloc = (vault.state?.allocation || []).find((a) => a.marketKey.toLowerCase() === market_key.toLowerCase());
                if (!alloc) continue;
                const vaultAum = vault.state?.totalAssetsUsd || 0;
                const allocPct = vaultAum > 0 ? (alloc.supplyAssetsUsd / vaultAum) * 100 : 0;
                const cap = alloc.supplyCapUsd != null && alloc.supplyCapUsd > 0
                  ? ` | Cap: ${formatUsd(alloc.supplyCapUsd)} (${formatPct((alloc.supplyAssetsUsd / alloc.supplyCapUsd) * 100)} used)`
                  : " | No cap";
                enriched.push(`    ${vault.name}: ${formatPct(allocPct)} of vault AUM (${formatUsd(alloc.supplyAssetsUsd)} / ${formatUsd(vaultAum)})${cap}`);
              }
              if (enriched.length > 0) {
                lines.push(``);
                lines.push(`  Vault Allocation Details:`);
                lines.push(...enriched);
              }
            }
          }
        } catch {
          // Best-effort, don't block core output
        }

        // Data availability notes
        const unavailable: string[] = [];
        if (!ptSpreadAvailable) unavailable.push("PT spread analysis");
        if (!supplierDataAvailable) unavailable.push("supply-side analysis");
        if (unavailable.length > 0) {
          lines.push(``);
          lines.push(`  Note: ${unavailable.join(" and ")} unavailable — Spectra/Morpho enrichment API may be down.`);
        }

        lines.push(``);
        lines.push(`  For Looping:`);
        lines.push(`    Use morpho_ltv = ${lltv.toFixed(4)} and borrow_rate = ${formatPct(borrowApy * 100)}`);
        lines.push(`    in spectra_get_looping_strategy to calculate leveraged yield.`);

        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`• Supply details: morpho_get_market_suppliers(chain="${chain}", market_key="${market_key}") for full supplier breakdown`);
        lines.push(`• Vault discovery: morpho_list_vaults(chain="${chain}") to see all vaults on this chain`);
        lines.push(`• Rate history: morpho_get_history(chain="${chain}", market_key="${market_key}") for historical rate trends`);
        lines.push(`• Looping: spectra_get_looping_strategy(chain="${chain}", pt_address=PT_ADDRESS) to model leveraged yield`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching Morpho rate: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // morpho_get_market_suppliers
  // ===========================================================================

  server.tool(
    "morpho_get_market_suppliers",
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

Use morpho_list_markets to find market keys first.
Use morpho_list_vaults to discover all vaults on a chain and their allocations.
Use morpho_get_rate for borrow-side rate and PT spread analysis.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      market_key: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid Morpho market key — must be 0x followed by 64 hex characters")
        .describe("The Morpho market unique key (0x + 64 hex chars). Use morpho_list_markets to find it."),
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

        const [marketData, suppResult] = await Promise.all([
          fetchMorpho(marketQuery) as Promise<any>,
          fetchMorphoMarketSuppliers(market_key, morphoChainId, top_n),
        ]);
        const suppliers = suppResult.suppliers;
        const suppTotal = suppResult.total;

        const market: MorphoMarket | null = marketData?.marketByUniqueKey;

        if (!market) {
          const text = `No Morpho market found for key ${market_key} on chain ${chain}. Verify the key and chain.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const analysis = formatMorphoSupplierAnalysis(suppliers, market);

        // Truncation notice
        const truncNotice = suppTotal > suppliers.length
          ? `\n⚠ Showing top ${suppliers.length} of ${suppTotal} supplier(s). Increase top_n (max 50) to see more.\n`
          : "";

        const footer = [
          ``,
          `--- Next Steps ---`,
          `• Vault details: morpho_list_vaults(chain="${chain}") to see all vaults and their allocations`,
          `• Borrow rate: morpho_get_rate(chain="${chain}", market_key="${market_key}") for rate + spread analysis`,
          `• Looping: spectra_get_looping_strategy(chain="${chain}", pt_address=PT_ADDRESS) to model leveraged yield`,
        ].join("\n");

        const text = analysis + truncNotice + footer;
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching market suppliers: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // morpho_list_vaults
  // ===========================================================================

  server.tool(
    "morpho_list_vaults",
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
  morpho_get_market_suppliers with a specific market key to find who actually supplies it.

Use morpho_get_market_suppliers to see who supplies a specific market.
Use morpho_list_markets to find available PT lending markets.
Use spectra_get_looping_strategy to model leveraged yield after identifying supply liquidity.`,
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

        const vaultResult = await fetchMorphoVaults(chain, {
          assetFilter: asset_filter,
          minTvlUsd: min_tvl_usd,
          topN: top_n,
        });
        const vaults = vaultResult.vaults;
        const vaultTotal = vaultResult.total;

        if (vaults.length === 0) {
          const lines = [
            `No Morpho vaults found on ${chain}${asset_filter ? ` matching "${asset_filter}"` : ""}.`,
            ``,
            `⚡ No curated vaults on this chain${asset_filter ? ` for this asset` : ""} — supply-side liquidity`,
            `  may come from EOAs directly, or vault creation hasn't happened yet (permissionless).`,
            ...(asset_filter ? [`• Try without filter: morpho_list_vaults(chain="${chain}") to see all vaults`] : []),
            `• Check who actually supplies: morpho_get_market_suppliers(chain="${chain}", market_key=KEY)`,
          ];
          const text = lines.join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        // Collect all unique market keys across all vaults for batch rate fetching
        const allMarketKeys = new Set<string>();
        for (const v of vaults) {
          for (const a of v.state?.allocation || []) {
            if (a.marketKey) allMarketKeys.add(a.marketKey);
          }
        }

        // Parallel: fetch Spectra PT addresses + batch market rates
        let spectraPtTaggingAvailable = true;
        const [spectraPtAddrs, ratesResult] = await Promise.all([
          fetchSpectraPtAddresses().catch(() => { spectraPtTaggingAvailable = false; return new Set<string>(); }),
          fetchMorphoMarketRates([...allMarketKeys], morphoChainId),
        ]);
        const marketRates = ratesResult.rates;

        const spectraVaultCount = vaults.filter((v) =>
          (v.state?.allocation || []).some((a) => spectraPtAddrs.has(a.collateralAddress || "")),
        ).length;

        const truncated = vaultTotal - vaults.length;
        const headerLines = [
          `== Morpho Vaults: ${chain}${asset_filter ? ` (filter: ${asset_filter})` : ""} ==`,
          `  Found ${vaults.length} of ${vaultTotal} vault(s) (${spectraVaultCount} with Spectra PT allocations)`,
        ];
        if (truncated > 0) {
          headerLines.push(`  ⚠ ${truncated} additional vault(s) not shown. Increase top_n (max 50) or use asset_filter to narrow results.`);
        }
        const header = headerLines.join("\n") + "\n";

        const summaries = vaults.map((v, i) =>
          formatMorphoVaultSummaryEnriched(v, i + 1, marketRates, spectraPtAddrs),
        );

        const footer = [
          ``,
          `--- Next Steps ---`,
          `• Market suppliers: morpho_get_market_suppliers(chain="${chain}", market_key=KEY) for per-market supplier breakdown`,
          `• PT markets: morpho_list_markets(chain="${chain}") to see which PTs have lending markets`,
          `• Looping: spectra_get_looping_strategy(chain="${chain}", pt_address=PT_ADDRESS) to model leveraged yield`,
          `• Rate history: morpho_get_history(chain="${chain}", market_key=KEY) for historical rate trends`,
          `• Positions: morpho_get_positions(address=ADDR, chain="${chain}") to check wallet holdings`,
        ].join("\n");

        let text = header + "\n" + summaries.join("\n\n") + "\n" + footer;
        if (!ratesResult.available) {
          text += `\nNote: Market rate data unavailable — borrow APY and utilization figures may be missing or default to 0%.`;
        }
        if (!spectraPtTaggingAvailable) {
          text += `\nNote: Spectra PT address data unavailable — Spectra vs Pendle/Other tagging may be inaccurate.`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching Morpho vaults: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // morpho_get_positions
  // ===========================================================================

  server.tool(
    "morpho_get_positions",
    `Query a user's Morpho positions across all markets and vaults on a chain.
Returns collateral, borrows, supply (with USD values), vault deposits, health factors,
and position signals (looper detection, low health warnings).

Useful for understanding what a wallet holds on Morpho: is it a looper? A supplier?
A vault depositor? The position shape reveals the strategy.

Protocol context:
- Market positions show collateral, borrows, and supply separately. A position with
  both collateral and borrows is likely a looper (leveraged strategy).
- Health factor = (collateralUsd * LLTV) / borrowUsd — approximation using USD values.
  Health < 1.0 means liquidatable. Health < 1.3 means dangerously close.
- Vault positions show shares deposited in curated vaults (passive lending).
- Net value = supply + collateral + vaults - borrows.

Scans all Morpho chains by default (mainnet, base, arbitrum). Specify chain to narrow.

Use morpho_list_markets to find available PT markets.
Use morpho_get_rate for live borrow rate on a specific market.
Use spectra_get_portfolio for Spectra protocol positions (PT, YT, LP).`,
    {
      address: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address")
        .describe("The wallet address (0x...)"),
      chain: CHAIN_ENUM
        .optional()
        .describe("Specific chain to query. Omit to scan all Morpho chains."),
    },
    async ({ address, chain }) => {
      try {
        // Determine which chains to scan
        let chainsToScan: Array<{ network: string; chainId: number }>;
        if (chain) {
          const network = resolveNetwork(chain);
          const morphoId = MORPHO_CHAIN_IDS[network];
          if (!morphoId) {
            const text = `Morpho is not tracked for ${chain}. Supported: ${Object.keys(MORPHO_CHAIN_IDS).join(", ")}.`;
            return { content: [{ type: "text" as const, text }], isError: true };
          }
          chainsToScan = [{ network, chainId: morphoId }];
        } else {
          chainsToScan = Object.entries(MORPHO_CHAIN_IDS).map(([network, chainId]) => ({ network, chainId }));
        }

        // Fetch Spectra PT addresses for tagging (best-effort)
        let ptTaggingAvailable = true;
        const spectraPtAddrs = await fetchSpectraPtAddresses().catch(() => { ptTaggingAvailable = false; return new Set<string>(); });

        // Fetch positions across all chains in parallel
        const results = await Promise.all(
          chainsToScan.map(async ({ network, chainId }) => {
            const raw = await fetchMorphoUserPositions(address, chainId);

            // Process market positions
            const marketPositions: MorphoUserMarketPosition[] = raw.marketPositions.map((p: any) => {
              const collateralAddr = (p.market?.collateralAsset?.address || "").toLowerCase();
              const isSpectraPt = spectraPtAddrs.has(collateralAddr);
              const collateralUsd = p.collateralAssetsUsd || 0;
              const borrowUsd = p.borrowAssetsUsd || 0;
              const lltv = formatMorphoLltv(p.market?.lltv || "0");
              const healthFactor = borrowUsd > 0.01 ? (collateralUsd * lltv) / borrowUsd : undefined;

              return {
                market: {
                  uniqueKey: p.market?.uniqueKey || "",
                  collateralAsset: p.market?.collateralAsset || null,
                  loanAsset: p.market?.loanAsset || { address: "", symbol: "?", name: "?" },
                  lltv: p.market?.lltv || "0",
                  chain: p.market?.morphoBlue?.chain || { id: chainId, network },
                },
                supplyAssets: p.supplyAssets || 0,
                supplyAssetsUsd: p.supplyAssetsUsd || 0,
                borrowAssets: p.borrowAssets || 0,
                borrowAssetsUsd: borrowUsd,
                collateralAssets: p.collateralAssets || 0,
                collateralAssetsUsd: collateralUsd,
                isSpectraPt,
                healthFactor,
              } satisfies MorphoUserMarketPosition;
            });

            // Process vault positions
            const vaultPositions: MorphoUserVaultPosition[] = raw.vaultPositions.map((p: any) => ({
              vault: {
                address: p.vault?.address || "",
                name: p.vault?.name || "Unknown",
                symbol: p.vault?.symbol || "?",
                asset: p.vault?.asset || { address: "", symbol: "?", name: "?" },
                state: p.vault?.state ? {
                  totalAssetsUsd: p.vault.state.totalAssetsUsd || null,
                  apy: p.vault.state.apy || null,
                  netApy: p.vault.state.netApy || null,
                } : null,
              },
              assetsUsd: p.assetsUsd || 0,
              shares: p.shares || 0,
            } satisfies MorphoUserVaultPosition));

            // Compute totals
            const supplyUsd = marketPositions.reduce((s, p) => s + p.supplyAssetsUsd, 0);
            const borrowUsd = marketPositions.reduce((s, p) => s + p.borrowAssetsUsd, 0);
            const collateralUsd = marketPositions.reduce((s, p) => s + p.collateralAssetsUsd, 0);
            const vaultUsd = vaultPositions.reduce((s, p) => s + p.assetsUsd, 0);

            return {
              address,
              chain: network,
              chainId,
              marketPositions,
              vaultPositions,
              totals: {
                supplyUsd,
                borrowUsd,
                collateralUsd,
                vaultUsd,
                netUsd: supplyUsd + collateralUsd + vaultUsd - borrowUsd,
              },
            } satisfies MorphoUserPositions;
          }),
        );

        // Filter to chains with actual positions
        const active = results.filter(
          (r) =>
            r.marketPositions.some((p) => p.supplyAssetsUsd > 0.01 || p.borrowAssetsUsd > 0.01 || p.collateralAssetsUsd > 0.01) ||
            r.vaultPositions.some((p) => p.assetsUsd > 0.01),
        );

        if (active.length === 0) {
          const scope = chain || "any Morpho chain";
          const text = [
            `No active Morpho positions found for ${address} on ${scope}.`,
            ``,
            `--- What This Means ---`,
            `This address has no supply, borrow, collateral, or vault positions on Morpho.`,
            `This does not mean the address is inactive — they may hold Spectra/Pendle positions`,
            `without using Morpho for leverage, or use a different wallet for lending.`,
            ``,
            `• Check Spectra positions: spectra_get_portfolio(address="${address}")`,
            `• Check Pendle positions: pendle_get_portfolio(address="${address}")`,
            `• Morpho chains scanned: ${chainsToScan.map((c) => c.network).join(", ")}`,
          ].join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        const sections = active.map((pos) => formatMorphoUserPositions(pos));

        // Cross-chain totals if multi-chain
        const lines: string[] = [];
        if (active.length > 1) {
          const totalNet = active.reduce((s, r) => s + r.totals.netUsd, 0);
          const totalBorrow = active.reduce((s, r) => s + r.totals.borrowUsd, 0);
          const totalSupply = active.reduce((s, r) => s + r.totals.supplyUsd, 0);
          const totalCollateral = active.reduce((s, r) => s + r.totals.collateralUsd, 0);
          const totalVault = active.reduce((s, r) => s + r.totals.vaultUsd, 0);
          lines.push(`== Cross-Chain Totals ==`);
          lines.push(`  Net Value: ${formatUsd(totalNet)} (Supply: ${formatUsd(totalSupply)} + Collateral: ${formatUsd(totalCollateral)} + Vaults: ${formatUsd(totalVault)} - Borrow: ${formatUsd(totalBorrow)})`);
          lines.push(`  Chains: ${active.map((r) => r.chain).join(", ")}`);
          lines.push(``);
        }

        lines.push(...sections);

        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`• Spectra positions: spectra_get_portfolio(address="${address}") for PT/YT/LP holdings`);
        lines.push(`• Market details: morpho_get_rate(chain=CHAIN, market_key=KEY) for rate + spread analysis`);
        lines.push(`• Vault details: morpho_list_vaults(chain=CHAIN) to see vault allocations and APY`);

        if (!ptTaggingAvailable) {
          lines.push(``);
          lines.push(`Note: Spectra PT address data unavailable — isSpectraPt tagging may be inaccurate.`);
        }

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching Morpho positions: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // morpho_get_history
  // ===========================================================================

  server.tool(
    "morpho_get_history",
    `Historical rates and growth for a specific Morpho market.
Shows borrow APY, supply APY, utilization, and TVL trends over time with
min/avg/max/current stats and directional signals.

Useful for assessing rate stability before entering a looping position.
A market with stable, predictable borrow rates is safer for leveraged strategies
than one with frequent spikes.

Output includes signals: rate spikes, stability assessments, utilization warnings,
TVL decline alerts, and supply/demand squeeze detection.

Parameters:
- period: 7d (hourly), 30d (daily), 90d (daily), 1y (weekly)
- interval: auto-selected based on period, or override manually

Use morpho_get_rate for current live rates.
Use morpho_list_markets to discover market keys.
Use spectra_get_looping_strategy to model leveraged yield after confirming rate stability.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      market_key: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid Morpho market key")
        .describe("The Morpho market unique key (0x + 64 hex chars). Use morpho_list_markets to find it."),
      period: z
        .enum(["7d", "30d", "90d", "1y"])
        .default("30d")
        .describe("Time period: 7d (hourly data), 30d (daily), 90d (daily), 1y (weekly). Default 30d."),
      interval: z
        .enum(["HOUR", "DAY", "WEEK", "MONTH"])
        .optional()
        .describe("Override auto-selected interval. Auto: 7d→HOUR, 30d→DAY, 90d→DAY, 1y→WEEK."),
    },
    async ({ chain, market_key, period, interval: intervalOverride }) => {
      try {
        const network = resolveNetwork(chain);
        const morphoChainId = MORPHO_CHAIN_IDS[network];
        if (!morphoChainId) {
          const text = `Morpho is not tracked for ${chain}. Supported: ${Object.keys(MORPHO_CHAIN_IDS).join(", ")}.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Determine time range and interval
        const now = Math.floor(Date.now() / 1000);
        const periodMap: Record<string, { seconds: number; defaultInterval: string }> = {
          "7d": { seconds: 7 * 86400, defaultInterval: "HOUR" },
          "30d": { seconds: 30 * 86400, defaultInterval: "DAY" },
          "90d": { seconds: 90 * 86400, defaultInterval: "DAY" },
          "1y": { seconds: 365 * 86400, defaultInterval: "WEEK" },
        };
        const cfg = periodMap[period] || periodMap["30d"];
        const startTimestamp = now - cfg.seconds;
        const interval = intervalOverride || cfg.defaultInterval;

        const { market, history } = await fetchMorphoMarketHistory(
          market_key,
          morphoChainId,
          startTimestamp,
          now,
          interval,
        );

        if (!market) {
          const text = `No Morpho market found for key ${market_key} on chain ${chain}. Verify the key and chain.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        if (history.length === 0) {
          const text = [
            `No historical data available for this market (${period}, ${interval} interval).`,
            `The market may be too new or the API may not have data for this period.`,
            ``,
            `--- Try ---`,
            `• Shorter period: morpho_get_history(chain="${chain}", market_key="${market_key}", period="7d")`,
            `• Current state: morpho_get_rate(chain="${chain}", market_key="${market_key}")`,
          ].join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        // Compute stats for each metric
        function computeStats(values: number[]): MorphoRateStats {
          if (values.length === 0) return { min: 0, max: 0, avg: 0, current: 0, change: 0, trend: "stable" as const };
          const min = Math.min(...values);
          const max = Math.max(...values);
          const avg = values.reduce((s, v) => s + v, 0) / values.length;
          const current = values[values.length - 1];
          // Trend: compare last 3 avg vs first 3 avg
          const headSlice = values.slice(0, Math.min(3, values.length));
          const tailSlice = values.slice(-Math.min(3, values.length));
          const headAvg = headSlice.reduce((s, v) => s + v, 0) / headSlice.length;
          const tailAvg = tailSlice.reduce((s, v) => s + v, 0) / tailSlice.length;
          const change = headAvg > 0 ? (tailAvg - headAvg) / headAvg : 0;
          const trend = change > 0.1 ? "up" as const : change < -0.1 ? "down" as const : "stable" as const;
          return { min, max, avg, current, change, trend };
        }

        const analysis: MorphoHistoricalAnalysis = {
          market: market as MorphoMarket,
          chain: network,
          period,
          interval,
          dataPoints: history,
          stats: {
            borrowApy: computeStats(history.map((h) => h.borrowApy)),
            supplyApy: computeStats(history.map((h) => h.supplyApy)),
            utilization: computeStats(history.map((h) => h.utilization)),
            tvl: computeStats(history.map((h) => h.supplyAssetsUsd)),
          },
          hints: [],
        };

        // Compute hints
        analysis.hints = formatMorphoHistoryHints(analysis);

        const output = formatMorphoHistoricalAnalysis(analysis);

        const lines = [output];
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`• Live rate: morpho_get_rate(chain="${chain}", market_key="${market_key}") for current state`);
        lines.push(`• Looping: spectra_get_looping_strategy(chain="${chain}", pt_address=PT_ADDRESS) to model leveraged yield`);
        lines.push(`• Suppliers: morpho_get_market_suppliers(chain="${chain}", market_key="${market_key}") for supply-side analysis`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching Morpho history: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
