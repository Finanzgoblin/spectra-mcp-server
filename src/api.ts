/**
 * API helpers — fetch wrappers with retry, GraphQL sanitization, and Morpho market lookup.
 */

import {
  SPECTRA_API,
  SPECTRA_APP_API,
  MORPHO_GRAPHQL,
  PENDLE_API,
  FETCH_TIMEOUT_MS,
  MORPHO_CHAIN_IDS,
  PENDLE_CHAIN_IDS,
  PENDLE_CHAIN_NAMES,
  API_NETWORKS,
  resolveNetwork,
  VE_SPECTRA,
  CHAIN_RPC_URLS,
  MAX_LOG_BLOCK_RANGE,
} from "./config.js";
import type { MorphoMarket, MorphoMarketSupplier, MorphoVault, MorphoVaultAllocation, MorphoHistoricalDataPoint, SpectraPt, SpectraPool, SpectraMetavault, PendleMarket, RawPoolOpportunity, ChainScanResult, MerklTokenReward, MerklChainRewards, MerklCampaign, LiquidationAlert, RiskAlertLevel } from "./types.js";

// =============================================================================
// Retry Logic
// =============================================================================

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 1;

// Retry on network/timeout errors only. HTTP 4xx errors are not retried (client error).
const RETRYABLE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);
function isRetryable(err: any): boolean {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return true;
  if (err?.cause?.code && RETRYABLE_CODES.has(err.cause.code)) return true;
  // fetch network failures surface as TypeError
  if (err instanceof TypeError && err.message.includes("fetch")) return true;
  return false;
}

async function fetchWithRetry(fn: () => Promise<Response>): Promise<Response> {
  let lastErr: any;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fn();
      // 4xx = client error, never retry. 5xx = server error, worth retrying.
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      // 5xx: treat as retryable
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      return res; // exhausted retries, return the 5xx response as-is
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isRetryable(err)) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// =============================================================================
// Spectra API
// =============================================================================

export async function fetchSpectra(path: string): Promise<unknown> {
  const url = `${SPECTRA_API}${path}`;
  const res = await fetchWithRetry(() =>
    fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  );
  if (!res.ok) {
    console.error(`Spectra API error: ${res.status} ${res.statusText} for ${url}`);
    throw new Error(`Spectra API error: ${res.status} ${res.statusText}`);
  }
  // Read body as text first, then parse — avoids stream double-consumption
  // (res.json() consumes the stream, so res.text() in the catch would always be empty)
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Spectra API returned invalid JSON for ${url}: ${body.slice(0, 120)}`);
  }
}

export async function fetchSpectraAppNumber(path: string): Promise<number> {
  const url = `${SPECTRA_APP_API}${path}`;
  const res = await fetchWithRetry(() =>
    fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  );
  if (!res.ok) {
    console.error(`Spectra App API error: ${res.status} ${res.statusText} for ${url}`);
    throw new Error(`Spectra App API error: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.text()).trim();
  const num = parseFloat(raw);
  if (Number.isNaN(num)) {
    console.error(`Spectra App API returned non-numeric value for ${path}: "${raw.slice(0, 80)}"`);
    throw new Error(`Spectra App API returned non-numeric value`);
  }
  return num;
}

// =============================================================================
// Morpho GraphQL API
// =============================================================================

export async function fetchMorpho(query: string): Promise<unknown> {
  const res = await fetchWithRetry(() =>
    fetch(MORPHO_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  );
  if (!res.ok) {
    throw new Error(`Morpho API error: ${res.status} ${res.statusText}`);
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Morpho API returned invalid JSON`);
  }
  if (json.errors?.length) {
    console.error(`Morpho GraphQL error: ${json.errors[0].message}`);
    throw new Error(`Morpho GraphQL error`);
  }
  return json.data;
}

// Standard GraphQL fragment for Morpho market fields we always need.
// Includes reallocatableLiquidityAssets for accurate available-liquidity display.
// The Morpho GraphQL state.liquidityAssetsUsd only reflects direct supply, but
// the Public Allocator can reallocate idle liquidity from other vault markets
// on demand — the Morpho UI shows (direct + reallocatable) as "Total Market Size".
export const MORPHO_MARKET_FIELDS = `
  uniqueKey
  lltv
  listed
  collateralAsset { address symbol name decimals }
  loanAsset { address symbol name decimals priceUsd }
  morphoBlue { address chain { id network } }
  reallocatableLiquidityAssets
  state {
    borrowApy
    supplyApy
    borrowAssetsUsd
    supplyAssetsUsd
    collateralAssetsUsd
    liquidityAssetsUsd
    utilization
    fee
    timestamp
    rewards {
      asset { address symbol }
      supplyApr
      borrowApr
    }
  }
  warnings { type level }
`;

// Sanitize user input before interpolation into GraphQL query strings.
// Strips anything that could break out of a quoted string or alter query structure.
// Includes # (comment char) to prevent structure manipulation.
// Does NOT strip colons — they appear in valid identifiers but are harmless inside quoted strings.
export function sanitizeGraphQL(input: string): string {
  return input.replace(/[\\"\n\r\t{}()\[\]#]/g, "");
}

// =============================================================================
// Morpho Market Lookup
// =============================================================================

/**
 * Look up a Morpho market by PT collateral address on a given chain.
 * Returns null if no market is found or Morpho is not tracked for that chain.
 * Best-effort — errors are swallowed to avoid blocking callers.
 */
export async function findMorphoMarketForPt(
  ptAddress: string,
  chain: string
): Promise<MorphoMarket | null> {
  const network = resolveNetwork(chain);
  const morphoChainId = MORPHO_CHAIN_IDS[network];
  if (!morphoChainId) return null;

  try {
    const query = `{
      markets(
        where: {
          collateralAssetAddress_in: ["${sanitizeGraphQL(ptAddress)}"]
          chainId_in: [${morphoChainId}]
        }
        first: 1
        orderBy: SupplyAssetsUsd
        orderDirection: Desc
      ) {
        items { ${MORPHO_MARKET_FIELDS} }
      }
    }`;
    const data = await fetchMorpho(query) as any;
    const items: MorphoMarket[] = data?.markets?.items || [];
    return items.length > 0 ? items[0] : null;
  } catch (err) {
    console.error(`Morpho lookup failed for PT ${ptAddress} on ${chain}:`, err instanceof Error ? err.message : err);
    return null; // Morpho lookup is best-effort — don't block the tool
  }
}

/**
 * Batch-lookup Morpho markets for multiple PT collateral addresses on a single chain.
 * Returns a Map from lowercased PT address -> best MorphoMarket (by supply).
 * Best-effort — returns empty map on error.
 */
export async function findMorphoMarketsForPts(
  ptAddresses: string[],
  chain: string
): Promise<Map<string, MorphoMarket>> {
  const result = new Map<string, MorphoMarket>();
  if (ptAddresses.length === 0) return result;

  const network = resolveNetwork(chain);
  const morphoChainId = MORPHO_CHAIN_IDS[network];
  if (!morphoChainId) return result;

  try {
    // Cap address list to avoid oversized GraphQL queries
    const capped = ptAddresses.slice(0, 200);
    const addrList = capped
      .map((a) => `"${sanitizeGraphQL(a)}"`)
      .join(", ");

    const query = `{
      markets(
        where: {
          collateralAssetAddress_in: [${addrList}]
          chainId_in: [${morphoChainId}]
        }
        first: ${Math.min(capped.length * 3, 500)}
        orderBy: SupplyAssetsUsd
        orderDirection: Desc
      ) {
        items { ${MORPHO_MARKET_FIELDS} }
      }
    }`;

    const data = await fetchMorpho(query) as any;
    const items: MorphoMarket[] = data?.markets?.items || [];

    // Keep the first (highest supply) market for each collateral address
    for (const market of items) {
      const addr = market.collateralAsset?.address?.toLowerCase();
      if (addr && !result.has(addr)) {
        result.set(addr, market);
      }
    }
  } catch (err) {
    console.error(`Morpho batch lookup failed for ${chain}:`, err instanceof Error ? err.message : err);
    // Best-effort — return whatever we have
  }

  return result;
}

// =============================================================================
// Morpho Supply-Side: Market Suppliers & Vaults
// =============================================================================

/**
 * Fetch top suppliers for a Morpho market, then identify which are vaults.
 * Returns enriched supplier list with vault metadata.
 * Best-effort — returns empty array on error.
 */
export async function fetchMorphoMarketSuppliers(
  marketKey: string,
  chainId: number,
  topN: number = 10,
): Promise<{ suppliers: MorphoMarketSupplier[]; total: number }> {
  try {
    // Step 1: Get top suppliers by supply shares
    const posQuery = `{
      marketPositions(
        where: {
          marketUniqueKey_in: ["${sanitizeGraphQL(marketKey)}"]
          chainId_in: [${chainId}]
        }
        first: ${Math.min(topN, 50)}
        orderBy: SupplyShares
        orderDirection: Desc
      ) {
        items {
          user { address }
          state {
            supplyShares
            supplyAssets
            supplyAssetsUsd
            borrowShares
            borrowAssets
            borrowAssetsUsd
            collateral
            collateralUsd
          }
        }
        pageInfo { count countTotal }
      }
    }`;

    const posData = await fetchMorpho(posQuery) as any;
    const positions = posData?.marketPositions?.items || [];
    const posTotal = posData?.marketPositions?.pageInfo?.countTotal || 0;

    // Filter to actual suppliers (non-zero supply)
    const suppliers = positions.filter(
      (p: any) => p.state?.supplyAssetsUsd > 0
    );

    if (suppliers.length === 0) return { suppliers: [], total: posTotal };

    // Step 2: Check which supplier addresses are Morpho vaults
    const supplierAddrs = suppliers.map((p: any) => p.user?.address).filter(Boolean);
    const addrList = supplierAddrs
      .map((a: string) => `"${sanitizeGraphQL(a)}"`)
      .join(", ");

    const vaultQuery = `{
      vaults(
        where: {
          address_in: [${addrList}]
          chainId_in: [${chainId}]
        }
        first: ${supplierAddrs.length}
      ) {
        items {
          address
          name
          symbol
          state {
            totalAssetsUsd
          }
          metadata { curators { name } }
        }
      }
    }`;

    let vaultMap = new Map<string, any>();
    try {
      const vaultData = await fetchMorpho(vaultQuery) as any;
      const vaults = vaultData?.vaults?.items || [];
      for (const v of vaults) {
        vaultMap.set(v.address.toLowerCase(), v);
      }
    } catch {
      // Vault lookup is best-effort
    }

    // Step 3: Combine into enriched supplier list
    const result: MorphoMarketSupplier[] = [];
    for (const pos of suppliers) {
      const addr = pos.user?.address || "";
      const vault = vaultMap.get(addr.toLowerCase());
      const curatorName = vault?.metadata?.curators?.[0]?.name;
      result.push({
        address: addr,
        supplyAssetsUsd: pos.state?.supplyAssetsUsd || 0,
        borrowAssetsUsd: pos.state?.borrowAssetsUsd || 0,
        collateralUsd: pos.state?.collateralUsd || 0,
        isVault: !!vault,
        ...(vault ? {
          vaultName: vault.name,
          vaultSymbol: vault.symbol,
          vaultTotalAssetsUsd: vault.state?.totalAssetsUsd || 0,
          vaultCurator: curatorName || undefined,
        } : {}),
      });
    }

    return { suppliers: result, total: posTotal };
  } catch (err) {
    console.error(`Morpho supplier lookup failed for market ${marketKey}:`, err instanceof Error ? err.message : err);
    return { suppliers: [], total: 0 };
  }
}

/**
 * Fetch all Morpho-related addresses a user interacts with on a chain.
 * Used by spectra_get_portfolio to match Merkl rewards against Morpho positions.
 * Returns a Set of lowercased addresses: vault addresses, loan asset addresses,
 * collateral asset addresses, Morpho Blue contract address.
 * Best-effort — returns empty set on error.
 */
export async function fetchMorphoUserAddresses(
  userAddress: string,
  chainId: number,
): Promise<Set<string>> {
  const addresses = new Set<string>();
  try {
    const query = `{
      vaultPositions(
        where: {
          userAddress_in: ["${sanitizeGraphQL(userAddress)}"]
          chainId_in: [${chainId}]
        }
        first: 50
      ) {
        items {
          vault { address }
        }
      }
      marketPositions(
        where: {
          userAddress_in: ["${sanitizeGraphQL(userAddress)}"]
          chainId_in: [${chainId}]
        }
        first: 50
      ) {
        items {
          market {
            loanAsset { address }
            collateralAsset { address }
            morphoBlue { address }
          }
        }
      }
    }`;

    const data = await fetchMorpho(query) as any;

    // Extract vault addresses
    for (const vp of data?.vaultPositions?.items || []) {
      const addr = vp?.vault?.address;
      if (addr) addresses.add(addr.toLowerCase());
    }

    // Extract market-related addresses
    for (const mp of data?.marketPositions?.items || []) {
      const m = mp?.market;
      if (m?.loanAsset?.address) addresses.add(m.loanAsset.address.toLowerCase());
      if (m?.collateralAsset?.address) addresses.add(m.collateralAsset.address.toLowerCase());
      if (m?.morphoBlue?.address) addresses.add(m.morphoBlue.address.toLowerCase());
    }
  } catch (err) {
    console.error(`Morpho user address lookup failed for ${userAddress}:`, err instanceof Error ? err.message : err);
  }
  return addresses;
}

/** GraphQL fields for Morpho vault queries. */
const MORPHO_VAULT_FIELDS = `
  address
  name
  symbol
  listed
  asset { address symbol decimals }
  chain { id network }
  state {
    totalAssetsUsd
    apy
    netApy
    fee
    allocation {
      market { uniqueKey loanAsset { symbol } collateralAsset { address symbol } }
      supplyAssetsUsd
      supplyCap
      supplyCapUsd
    }
  }
  metadata { curators { name } }
`;

/**
 * Fetch Morpho vaults on a chain.
 * Best-effort — returns empty array on error.
 */
export async function fetchMorphoVaults(
  chain: string,
  opts?: { assetFilter?: string; minTvlUsd?: number; topN?: number },
): Promise<{ vaults: MorphoVault[]; total: number }> {
  const network = resolveNetwork(chain);
  const morphoChainId = MORPHO_CHAIN_IDS[network];
  if (!morphoChainId) return { vaults: [], total: 0 };

  try {
    const topN = Math.min(opts?.topN || 50, 100);
    const minTvl = opts?.minTvlUsd || 0;

    const query = `{
      vaults(
        where: {
          chainId_in: [${morphoChainId}]
          ${minTvl > 0 ? `totalAssetsUsd_gte: ${minTvl}` : ""}
          ${opts?.assetFilter ? `search: "${sanitizeGraphQL(opts.assetFilter)}"` : ""}
        }
        first: ${topN}
        orderBy: TotalAssetsUsd
        orderDirection: Desc
      ) {
        items { ${MORPHO_VAULT_FIELDS} }
        pageInfo { count countTotal }
      }
    }`;

    const data = await fetchMorpho(query) as any;
    const items = data?.vaults?.items || [];
    const total = data?.vaults?.pageInfo?.countTotal || items.length;

    const vaults = items.map((v: any): MorphoVault => {
      const curatorName = v.metadata?.curators?.[0]?.name;
      const allocations: MorphoVaultAllocation[] = (v.state?.allocation || []).map((a: any) => ({
        marketKey: a.market?.uniqueKey || "",
        collateralAddress: (a.market?.collateralAsset?.address || "").toLowerCase(),
        collateralSymbol: a.market?.collateralAsset?.symbol || "?",
        loanSymbol: a.market?.loanAsset?.symbol || "?",
        supplyAssetsUsd: a.supplyAssetsUsd || 0,
        supplyCap: a.supplyCap || null,
        supplyCapUsd: a.supplyCapUsd || null,
      }));

      return {
        address: v.address,
        name: v.name || "Unnamed",
        symbol: v.symbol || "?",
        listed: v.listed ?? false,
        asset: v.asset || { address: "", symbol: "?", name: "?" },
        chain: v.chain || { id: morphoChainId, network },
        state: v.state ? {
          totalAssetsUsd: v.state.totalAssetsUsd || null,
          apy: v.state.apy || null,
          netApy: v.state.netApy || null,
          fee: v.state.fee || null,
          allocation: allocations,
        } : null,
        curator: curatorName || undefined,
      };
    });
    return { vaults, total };
  } catch (err) {
    console.error(`Morpho vault fetch failed for ${chain}:`, err instanceof Error ? err.message : err);
    return { vaults: [], total: 0 };
  }
}

// =============================================================================
// Morpho Batch Market Rates
// =============================================================================

/** Result from batch Morpho rate fetch — distinguishes "no data" from "API unavailable" */
export interface MorphoRatesResult {
  rates: Map<string, { borrowApy: number; supplyApy: number; utilization: number; supplyAssetsUsd: number }>;
  available: boolean;
}

/**
 * Batch-fetch live rates for multiple Morpho markets in a single GraphQL query.
 * Uses aliased fields (m0, m1, ...) to avoid N+1 round trips. Max 50 markets.
 * Returns { rates, available } — available=false means the API was unreachable.
 */
export async function fetchMorphoMarketRates(
  marketKeys: string[],
  chainId: number,
): Promise<MorphoRatesResult> {
  const rates = new Map<string, { borrowApy: number; supplyApy: number; utilization: number; supplyAssetsUsd: number }>();
  if (marketKeys.length === 0) return { rates, available: true };

  try {
    const capped = marketKeys.slice(0, 50);
    const aliases = capped.map((key, i) =>
      `m${i}: marketByUniqueKey(uniqueKey: "${sanitizeGraphQL(key)}", chainId: ${chainId}) {
        uniqueKey
        state { borrowApy supplyApy utilization supplyAssetsUsd }
      }`
    );
    const query = `{ ${aliases.join("\n")} }`;
    const data = (await fetchMorpho(query)) as any;
    for (let i = 0; i < capped.length; i++) {
      const m = data?.[`m${i}`];
      if (m?.state) {
        rates.set(m.uniqueKey || capped[i], {
          borrowApy: m.state.borrowApy || 0,
          supplyApy: m.state.supplyApy || 0,
          utilization: m.state.utilization || 0,
          supplyAssetsUsd: m.state.supplyAssetsUsd || 0,
        });
      }
    }
    return { rates, available: true };
  } catch (err) {
    console.error("Morpho batch rate fetch failed:", err instanceof Error ? err.message : err);
    return { rates, available: false };
  }
}

// =============================================================================
// Morpho User Positions
// =============================================================================

/**
 * Fetch a user's Morpho market + vault positions on a specific chain.
 */
export async function fetchMorphoUserPositions(
  userAddress: string,
  chainId: number,
): Promise<{ marketPositions: any[]; vaultPositions: any[] }> {
  try {
    const addr = sanitizeGraphQL(userAddress);
    const query = `{
      userByAddress(address: "${addr}", chainId: ${chainId}) {
        address
        marketPositions {
          market {
            uniqueKey
            lltv
            collateralAsset { address symbol name decimals }
            loanAsset { address symbol name decimals }
            morphoBlue { chain { id network } }
          }
          supplyAssets
          supplyAssetsUsd
          borrowAssets
          borrowAssetsUsd
          collateralAssets
          collateralAssetsUsd
        }
        vaultPositions {
          vault {
            address
            name
            symbol
            asset { address symbol decimals }
            state { totalAssetsUsd apy netApy }
          }
          assetsUsd
          shares
        }
      }
    }`;
    const data = (await fetchMorpho(query)) as any;
    return {
      marketPositions: data?.userByAddress?.marketPositions || [],
      vaultPositions: data?.userByAddress?.vaultPositions || [],
    };
  } catch (err) {
    console.error(`Morpho user positions fetch failed for ${userAddress}:`, err instanceof Error ? err.message : err);
    return { marketPositions: [], vaultPositions: [] };
  }
}

// =============================================================================
// Morpho Position Risk Data (Liquidation Distance Monitor)
// =============================================================================

/**
 * Fetch enriched Morpho position data for liquidation distance monitoring.
 * For each chain with borrowing positions, computes health factor, liquidation price,
 * and distance to liquidation. Borrow rates are fetched in parallel per chain.
 *
 * @param address - Wallet address to inspect
 * @param chain   - Optional: restrict to a single chain (Spectra network slug). Omit to scan all Morpho chains.
 * @param alertThresholdPct - Distance-to-liquidation % below which a position is flagged (default 20%)
 */
export async function fetchMorphoPositionRiskData(
  address: string,
  chain?: string,
  alertThresholdPct: number = 20,
): Promise<{ chain: string; positions: LiquidationAlert[]; ratesAvailable: boolean }[]> {
  // Determine which chains to scan
  let chainsToScan: Array<{ network: string; chainId: number }>;
  if (chain) {
    const network = resolveNetwork(chain);
    const morphoChainId = MORPHO_CHAIN_IDS[network];
    if (!morphoChainId) return [];
    chainsToScan = [{ network, chainId: morphoChainId }];
  } else {
    chainsToScan = Object.entries(MORPHO_CHAIN_IDS).map(([network, chainId]) => ({ network, chainId }));
  }

  // Fetch Spectra PT addresses for tagging (best-effort, parallel with position fetches)
  const spectraPtAddrs = await fetchSpectraPtAddresses().catch(() => new Set<string>());

  // Fetch positions across all chains in parallel (best-effort)
  const chainResults = await Promise.allSettled(
    chainsToScan.map(async ({ network, chainId }): Promise<{ chain: string; positions: LiquidationAlert[]; ratesAvailable: boolean }> => {
      // Step 1: get raw positions for this chain
      const raw = await fetchMorphoUserPositions(address, chainId);

      // Step 2: isolate borrowing positions
      const borrowingPositions = raw.marketPositions.filter((p: any) => (p.borrowAssetsUsd || 0) > 0.01);
      if (borrowingPositions.length === 0) {
        return { chain: network, positions: [], ratesAvailable: true };
      }

      // Step 3: batch-fetch live borrow rates for all markets on this chain
      const marketKeys = borrowingPositions.map((p: any) => p.market?.uniqueKey).filter(Boolean) as string[];
      const ratesResult = await fetchMorphoMarketRates(marketKeys, chainId).catch(() =>
        ({ rates: new Map<string, { borrowApy: number; supplyApy: number; utilization: number; supplyAssetsUsd: number }>(), available: false })
      );
      const ratesMap = ratesResult.rates;
      const ratesAvailable = ratesResult.available;

      // Step 4: compute risk metrics per position
      const positions: LiquidationAlert[] = borrowingPositions.map((p: any): LiquidationAlert => {
        const marketKey: string = p.market?.uniqueKey || "";
        const collateralSymbol: string = p.market?.collateralAsset?.symbol || "?";
        const debtSymbol: string = p.market?.loanAsset?.symbol || "?";
        const collateralUsd: number = p.collateralAssetsUsd || 0;
        const debtUsd: number = p.borrowAssetsUsd || 0;
        // collateralAssets is the raw token amount (not USD)
        const collateralAmount: number = p.collateralAssets || 0;

        const lltv: number = Number(p.market?.lltv || "0") / 1e18;

        // Health factor: (collateralUsd * lltv) / debtUsd
        const healthFactor: number = debtUsd > 0 ? (collateralUsd * lltv) / debtUsd : Infinity;

        // Current collateral price (USD per token), derived from position data
        const currentPrice: number = collateralAmount > 0 ? collateralUsd / collateralAmount : 0;

        // Liquidation price: price at which health factor = 1.0
        // Derived from: collateralAmount * price * lltv = debtUsd  =>  price = debtUsd / (collateralAmount * lltv)
        const liquidationPrice: number =
          collateralAmount > 0 && lltv > 0 ? debtUsd / (collateralAmount * lltv) : 0;

        // Distance to liquidation: how far the collateral price must fall before liquidation
        const distanceToLiquidationPct: number =
          currentPrice > 0 && liquidationPrice > 0
            ? (1 - liquidationPrice / currentPrice) * 100
            : 100; // unknown distance — default safe

        // Borrow rate from batch fetch
        const rateData = ratesMap.get(marketKey);
        const currentBorrowRate: number = rateData ? (rateData.borrowApy || 0) * 100 : 0;

        // Determine alert level from distance-to-liquidation and health factor
        const alertReasons: string[] = [];
        let alertLevel: RiskAlertLevel = "ok";

        if (distanceToLiquidationPct < 5) {
          alertLevel = "critical";
          alertReasons.push(`Only ${distanceToLiquidationPct.toFixed(1)}% price drop to liquidation`);
        } else if (distanceToLiquidationPct < alertThresholdPct / 2) {
          alertLevel = "warning";
          alertReasons.push(`${distanceToLiquidationPct.toFixed(1)}% distance to liquidation (below ${(alertThresholdPct / 2).toFixed(0)}% threshold)`);
        } else if (distanceToLiquidationPct < alertThresholdPct) {
          alertLevel = "watch";
          alertReasons.push(`${distanceToLiquidationPct.toFixed(1)}% distance to liquidation (below ${alertThresholdPct}% threshold)`);
        }

        if (healthFactor < 1.1 && alertLevel === "ok") {
          alertLevel = "warning";
          alertReasons.push(`Health factor ${healthFactor.toFixed(3)} dangerously close to 1.0`);
        }

        return {
          marketKey,
          chain: network,
          collateralSymbol,
          debtSymbol,
          collateralUsd,
          debtUsd,
          lltv,
          healthFactor,
          liquidationPrice,
          currentPrice,
          distanceToLiquidationPct,
          currentBorrowRate,
          entryBorrowAssumption: null,  // not available from position data alone
          borrowRateDrift: null,         // not available without entry-time rate
          isFullLiquidation: true,       // Morpho has no close factor — entire position at risk
          isSpectraPt: spectraPtAddrs.has((p.market?.collateralAsset?.address || "").toLowerCase()),
          isLooper: collateralUsd > 0.01 && debtUsd > 0.01,
          alertLevel,
          alertReasons,
        };
      });

      return { chain: network, positions, ratesAvailable };
    })
  );

  // Collect fulfilled results; log failures but don't throw
  const output: { chain: string; positions: LiquidationAlert[]; ratesAvailable: boolean }[] = [];
  for (const result of chainResults) {
    if (result.status === "fulfilled") {
      if (result.value.positions.length > 0) {
        output.push(result.value);
      }
    } else {
      console.error("fetchMorphoPositionRiskData chain fetch failed:", result.reason instanceof Error ? result.reason.message : result.reason);
    }
  }
  return output;
}

// =============================================================================
// Morpho Market History
// =============================================================================

/**
 * Fetch historical rate data for a Morpho market using historicalState.
 */
export async function fetchMorphoMarketHistory(
  marketKey: string,
  chainId: number,
  startTimestamp: number,
  endTimestamp: number,
  interval: string,
): Promise<{ market: any; history: MorphoHistoricalDataPoint[] }> {
  try {
    const key = sanitizeGraphQL(marketKey);
    const query = `{
      marketByUniqueKey(uniqueKey: "${key}", chainId: ${chainId}) {
        ${MORPHO_MARKET_FIELDS}
        historicalState {
          borrowApy(options: { startTimestamp: ${startTimestamp}, endTimestamp: ${endTimestamp}, interval: ${interval} }) {
            x
            y
          }
          supplyApy(options: { startTimestamp: ${startTimestamp}, endTimestamp: ${endTimestamp}, interval: ${interval} }) {
            x
            y
          }
          utilization(options: { startTimestamp: ${startTimestamp}, endTimestamp: ${endTimestamp}, interval: ${interval} }) {
            x
            y
          }
          supplyAssetsUsd(options: { startTimestamp: ${startTimestamp}, endTimestamp: ${endTimestamp}, interval: ${interval} }) {
            x
            y
          }
          borrowAssetsUsd(options: { startTimestamp: ${startTimestamp}, endTimestamp: ${endTimestamp}, interval: ${interval} }) {
            x
            y
          }
        }
      }
    }`;
    const data = (await fetchMorpho(query)) as any;
    const mkt = data?.marketByUniqueKey;
    if (!mkt) return { market: null, history: [] };

    const hs = mkt.historicalState;
    const borrowApyArr: Array<{ x: number; y: number }> = hs?.borrowApy || [];
    const supplyApyArr: Array<{ x: number; y: number }> = hs?.supplyApy || [];
    const utilizationArr: Array<{ x: number; y: number }> = hs?.utilization || [];
    const supplyUsdArr: Array<{ x: number; y: number }> = hs?.supplyAssetsUsd || [];
    const borrowUsdArr: Array<{ x: number; y: number }> = hs?.borrowAssetsUsd || [];

    // Merge time series by timestamp
    const timestamps = new Set<number>();
    for (const arr of [borrowApyArr, supplyApyArr, utilizationArr, supplyUsdArr, borrowUsdArr]) {
      for (const p of arr) timestamps.add(p.x);
    }
    const sorted = [...timestamps].sort((a, b) => a - b);

    const makeMap = (arr: Array<{ x: number; y: number }>) => {
      const m = new Map<number, number>();
      for (const p of arr) m.set(p.x, p.y ?? 0);
      return m;
    };
    const bApy = makeMap(borrowApyArr);
    const sApy = makeMap(supplyApyArr);
    const util = makeMap(utilizationArr);
    const sUsd = makeMap(supplyUsdArr);
    const bUsd = makeMap(borrowUsdArr);

    const history: MorphoHistoricalDataPoint[] = sorted.map((ts) => ({
      timestamp: ts,
      borrowApy: bApy.get(ts) ?? 0,
      supplyApy: sApy.get(ts) ?? 0,
      utilization: util.get(ts) ?? 0,
      supplyAssetsUsd: sUsd.get(ts) ?? 0,
      borrowAssetsUsd: bUsd.get(ts) ?? 0,
    }));

    // Strip historicalState from market to avoid bloating downstream
    const { historicalState: _hs, ...marketData } = mkt;
    return { market: marketData, history };
  } catch (err) {
    console.error(`Morpho market history fetch failed for ${marketKey}:`, err instanceof Error ? err.message : err);
    return { market: null, history: [] };
  }
}

// =============================================================================
// Pool Data Cache (30s TTL per chain)
// =============================================================================

const POOL_CACHE_TTL_MS = 30_000; // 30 seconds
const _poolCache = new Map<string, { pts: SpectraPt[]; expiresAt: number }>();
const _poolInflight = new Map<string, Promise<SpectraPt[]>>();

/**
 * Fetch all PTs (with pools) for a chain, with 30s TTL cache and inflight dedup.
 * Used by scanAllChainPools and resolvePoolAddressFromPt indirectly via fetchSpectra.
 */
/**
 * Validate essential PT fields at the system boundary.
 * Filters out entries missing required fields (address, maturity, name).
 * Logs a warning for the first malformed entry per chain (avoid log spam).
 */
function validatePtEntries(raw: any[], chain: string): SpectraPt[] {
  let warned = false;
  const valid: SpectraPt[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.address === "string" &&
      typeof item.maturity === "number" &&
      typeof item.name === "string"
    ) {
      valid.push(item as SpectraPt);
    } else if (!warned) {
      console.error(`[${chain}] Skipping malformed PT entry: missing address/maturity/name`);
      warned = true;
    }
  }
  return valid;
}

async function fetchChainPools(chain: string): Promise<SpectraPt[]> {
  const now = Date.now();
  const cached = _poolCache.get(chain);
  if (cached && now < cached.expiresAt) return cached.pts;

  // Deduplicate concurrent requests for the same chain
  const inflight = _poolInflight.get(chain);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const raw = await fetchSpectra(`/${chain}/pools`) as any;
      const arr: any[] = raw?.data || raw || [];
      if (!Array.isArray(arr)) return [];
      const pts = validatePtEntries(arr, chain);
      _poolCache.set(chain, { pts, expiresAt: Date.now() + POOL_CACHE_TTL_MS });
      return pts;
    } finally {
      _poolInflight.delete(chain);
    }
  })();

  _poolInflight.set(chain, promise);
  return promise;
}

// =============================================================================
// Multi-Chain Pool Scanner
// =============================================================================

interface ChainScanOptions {
  min_tvl_usd?: number;
  min_liquidity_usd?: number;
  asset_filter?: string;
}

/**
 * Scan all Spectra chains in parallel, returning non-expired PT×pool pairs
 * that pass TVL, liquidity, and optional asset filters.
 * Shared by spectra_get_best_fixed_yields, spectra_scan_opportunities, and spectra_scan_yt_arbitrage.
 * Uses a 30s TTL cache per chain to avoid redundant API calls.
 */
export async function scanAllChainPools(
  opts: ChainScanOptions = {}
): Promise<ChainScanResult> {
  const minTvl = opts.min_tvl_usd ?? 0;
  const minLiq = opts.min_liquidity_usd ?? 0;
  const assetFilter = opts.asset_filter?.toUpperCase();

  const failedChains: string[] = [];

  const chainResults = await Promise.allSettled(
    API_NETWORKS.map(async (chain): Promise<RawPoolOpportunity[]> => {
      const pts = await fetchChainPools(chain);
      if (pts.length === 0) return [];

      const results: RawPoolOpportunity[] = [];
      for (const pt of pts) {
        if (!pt.pools || pt.pools.length === 0) continue;
        if (pt.maturity * 1000 <= Date.now()) continue;
        if ((pt.tvl?.usd || 0) < minTvl) continue;

        if (assetFilter) {
          const sym = (pt.underlying?.symbol || "").toUpperCase();
          const name = (pt.underlying?.name || "").toUpperCase();
          if (!sym.includes(assetFilter) && !name.includes(assetFilter)) continue;
        }

        for (const pool of pt.pools) {
          if ((pool.liquidity?.usd || 0) < minLiq) continue;
          results.push({ pt, pool, chain });
        }
      }
      return results;
    })
  );

  const opportunities: RawPoolOpportunity[] = [];
  chainResults.forEach((result, i) => {
    if (result.status === "fulfilled") {
      opportunities.push(...result.value);
    } else {
      failedChains.push(API_NETWORKS[i]);
    }
  });

  return { opportunities, failedChains };
}

// =============================================================================
// Spectra PT Address Index
// =============================================================================

/**
 * Fetch all Spectra PT addresses from chains that overlap with Morpho.
 * Returns a Set<string> of lowercased PT addresses for O(1) lookups.
 * Best-effort — chains that fail are skipped silently.
 */
export async function fetchSpectraPtAddresses(): Promise<Set<string>> {
  const morphoNetworks = Object.keys(MORPHO_CHAIN_IDS);
  const results = await Promise.allSettled(
    morphoNetworks.map(async (net) => {
      const pts = await fetchChainPools(net);
      return pts
        .filter((pt) => pt.address)
        .map((pt) => pt.address.toLowerCase());
    })
  );

  const addresses = new Set<string>();
  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const addr of result.value) {
        addresses.add(addr);
      }
    }
  }
  return addresses;
}

// =============================================================================
// veSPECTRA On-Chain Reads (Base RPC)
// =============================================================================

// Cache: totalSupply changes slowly (locks/unlocks), 5-minute TTL is reasonable.
// Uses Promise-based dedup to avoid redundant RPC calls from concurrent tool invocations.
let _veTotalSupplyCache: { value: number; expiresAt: number } | null = null;
let _veTotalSupplyInflight: Promise<number> | null = null;
const VE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch veSPECTRA totalSupply from the Base chain via raw eth_call.
 * Returns the total supply as a regular number (18 decimals divided out).
 * Cached for 5 minutes. Deduplicates concurrent in-flight requests. Throws on RPC failure.
 */
export async function fetchVeTotalSupply(): Promise<number> {
  const now = Date.now();
  if (_veTotalSupplyCache && now < _veTotalSupplyCache.expiresAt) {
    return Promise.resolve(_veTotalSupplyCache.value);
  }

  // Deduplicate: if a fetch is already in flight, piggyback on it
  if (_veTotalSupplyInflight) {
    return _veTotalSupplyInflight;
  }

  _veTotalSupplyInflight = (async () => {
    try {
      const res = await fetchWithRetry(() =>
        fetch(VE_SPECTRA.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
              { to: VE_SPECTRA.address, data: VE_SPECTRA.selectors.totalSupply },
              "latest",
            ],
          }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      );

      if (!res.ok) {
        throw new Error(`Base RPC error: ${res.status} ${res.statusText}`);
      }

      let json: any;
      try {
        json = await res.json();
      } catch {
        throw new Error("Base RPC returned invalid JSON");
      }
      if (json.error) {
        throw new Error(`Base RPC error: ${json.error.message || JSON.stringify(json.error)}`);
      }

      const hex: string = json.result;
      if (!hex || hex === "0x") {
        throw new Error("veSPECTRA totalSupply returned empty");
      }

      // Parse hex -> BigInt -> Number (divide by 10^decimals)
      const raw = BigInt(hex);
      const divisor = 10n ** BigInt(VE_SPECTRA.decimals);
      const intPart = raw / divisor;
      const fracPart = raw % divisor;
      const value = Number(intPart) + Number(fracPart) / Number(divisor);

      _veTotalSupplyCache = { value, expiresAt: Date.now() + VE_CACHE_TTL_MS };
      return value;
    } finally {
      _veTotalSupplyInflight = null;
    }
  })();

  return _veTotalSupplyInflight;
}

// =============================================================================
// Safe Amount → BigInt Conversion (avoids float overflow)
// =============================================================================

/**
 * Convert a human-readable token amount to raw BigInt units (e.g. 1.5 USDC → 1500000n).
 * Uses string arithmetic to avoid precision loss when amount * 10^decimals > MAX_SAFE_INTEGER.
 * For example: amountToBigInt(1000000, 18) correctly produces 1000000000000000000000000n
 * instead of losing precision through float intermediary.
 */
export function amountToBigInt(amount: number, decimals: number): bigint {
  if (amount <= 0 || !Number.isFinite(amount)) return 0n;
  const s = amount.toString();
  const dotIndex = s.indexOf(".");
  if (dotIndex === -1) {
    // Integer — just multiply by 10^decimals
    return BigInt(s) * 10n ** BigInt(decimals);
  }
  const intPart = s.slice(0, dotIndex);
  const fracPart = s.slice(dotIndex + 1);
  if (fracPart.length >= decimals) {
    // More fractional digits than decimals — truncate
    return BigInt(intPart + fracPart.slice(0, decimals));
  }
  // Fewer fractional digits — pad with zeros
  return BigInt(intPart + fracPart + "0".repeat(decimals - fracPart.length));
}

// =============================================================================
// On-Chain Curve Pool Quoting (get_dy)
// =============================================================================

// Curve StableSwap-NG function selectors (from keccak256 of signatures)
const CURVE_SELECTORS = {
  get_dy: "0x5e0d443f",               // get_dy(int128,int128,uint256)
  calc_token_amount_dyn: "0x3db06dd8", // calc_token_amount(uint256[],bool) — StableSwap-NG
  calc_token_amount_2: "0xed8e84f3",   // calc_token_amount(uint256[2],bool) — legacy 2-coin
} as const;

/**
 * Encode a Curve get_dy(i, j, dx) call as raw calldata.
 * i, j are int128 pool indices (0=IBT, 1=PT). dx is uint256 in token raw units.
 */
function encodeCurveGetDy(i: number, j: number, dx: bigint): string {
  const iHex = i.toString(16).padStart(64, "0");
  const jHex = j.toString(16).padStart(64, "0");
  const dxHex = dx.toString(16).padStart(64, "0");
  return CURVE_SELECTORS.get_dy + iHex + jHex + dxHex;
}

/**
 * Call Curve pool's get_dy(i, j, dx) on-chain via eth_call.
 * Returns the expected output in raw token units (bigint), or null on failure.
 *
 * Best-effort — returns null if RPC is unavailable or call reverts.
 * Used to get exact on-chain quotes instead of the conservative constant-product estimate.
 *
 * @param poolAddress - Curve pool contract address
 * @param i - Input coin index (0=IBT, 1=PT)
 * @param j - Output coin index (0=IBT, 1=PT)
 * @param dx - Input amount in raw token units (before decimals)
 * @param chainSlug - Spectra chain slug (e.g., "mainnet", "base")
 */
export async function fetchCurveGetDy(
  poolAddress: string,
  i: number,
  j: number,
  dx: bigint,
  chainSlug: string,
): Promise<bigint | null> {
  const network = resolveNetwork(chainSlug);
  const rpcUrl = CHAIN_RPC_URLS[network];
  if (!rpcUrl) return null;

  try {
    const calldata = encodeCurveGetDy(i, j, dx);
    const res = await fetchWithRetry(() =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            { to: poolAddress, data: calldata },
            "latest",
          ],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );

    if (!res.ok) return null;

    let json: any;
    try {
      json = await res.json();
    } catch {
      return null;
    }

    if (json.error) return null;

    const hex: string = json.result;
    if (!hex || hex === "0x" || hex === "0x0") return null;

    return BigInt(hex);
  } catch {
    return null; // Best-effort — fall back to math estimate
  }
}

// =============================================================================
// On-Chain Curve Pool LP Quoting (calc_token_amount)
// =============================================================================

/**
 * Encode a Curve calc_token_amount(amounts, is_deposit) call as raw calldata.
 * StableSwap-NG uses dynamic arrays (uint256[]), legacy pools use fixed (uint256[2]).
 * We try both selectors in sequence — the wrong one will revert and return null.
 */
function encodeCurveCalcTokenAmountDynamic(amounts: [bigint, bigint], isDeposit: boolean): string {
  // ABI encoding for (uint256[], bool):
  // Word 0: offset to dynamic array data = 0x40 (64 bytes, past the bool slot)
  // Word 1: bool is_deposit
  // Word 2: array length = 2
  // Word 3: amounts[0]
  // Word 4: amounts[1]
  const offsetHex = "0".repeat(62) + "40";
  const boolHex = "0".repeat(63) + (isDeposit ? "1" : "0");
  const lenHex = "0".repeat(63) + "2";
  const amt0Hex = amounts[0].toString(16).padStart(64, "0");
  const amt1Hex = amounts[1].toString(16).padStart(64, "0");
  return CURVE_SELECTORS.calc_token_amount_dyn + offsetHex + boolHex + lenHex + amt0Hex + amt1Hex;
}

function encodeCurveCalcTokenAmountFixed2(amounts: [bigint, bigint], isDeposit: boolean): string {
  // ABI encoding for (uint256[2], bool):
  // Word 0: amounts[0]
  // Word 1: amounts[1]
  // Word 2: bool is_deposit
  const amt0Hex = amounts[0].toString(16).padStart(64, "0");
  const amt1Hex = amounts[1].toString(16).padStart(64, "0");
  const boolHex = "0".repeat(63) + (isDeposit ? "1" : "0");
  return CURVE_SELECTORS.calc_token_amount_2 + amt0Hex + amt1Hex + boolHex;
}

/**
 * Call Curve pool's calc_token_amount(amounts, is_deposit) on-chain via eth_call.
 * Returns the expected LP tokens minted for a deposit (or burned for withdrawal) as bigint.
 *
 * Tries the StableSwap-NG dynamic array selector first, falls back to legacy fixed-2 selector.
 * Returns null if both revert (pool doesn't support this function or is expired).
 *
 * Best-effort — returns null if RPC is unavailable or call reverts.
 *
 * @param poolAddress - Curve pool contract address
 * @param amounts - [IBT amount, PT amount] in raw token units
 * @param isDeposit - true for deposit (minting LP), false for withdrawal
 * @param chainSlug - Spectra chain slug (e.g., "mainnet", "base")
 */
export async function fetchCurveCalcTokenAmount(
  poolAddress: string,
  amounts: [bigint, bigint],
  isDeposit: boolean,
  chainSlug: string,
): Promise<bigint | null> {
  const network = resolveNetwork(chainSlug);
  const rpcUrl = CHAIN_RPC_URLS[network];
  if (!rpcUrl) return null;

  // Try both selectors: dynamic array (NG) first, then fixed 2-coin (legacy)
  const calldatas = [
    encodeCurveCalcTokenAmountDynamic(amounts, isDeposit),
    encodeCurveCalcTokenAmountFixed2(amounts, isDeposit),
  ];

  for (const calldata of calldatas) {
    try {
      const res = await fetchWithRetry(() =>
        fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
              { to: poolAddress, data: calldata },
              "latest",
            ],
          }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      );

      if (!res.ok) continue;

      let json: any;
      try {
        json = await res.json();
      } catch {
        continue;
      }

      if (json.error) continue;

      const hex: string = json.result;
      if (!hex || hex === "0x" || hex === "0x0") continue;

      const result = BigInt(hex);
      if (result > 0n) return result; // Valid result — return it
    } catch {
      continue; // Try next selector
    }
  }

  return null; // Both selectors failed — fall back to math estimate
}

// =============================================================================
// On-Chain ERC-20 decimals()
// =============================================================================

/**
 * Call ERC-20 decimals() on a token contract via eth_call.
 * Returns the number of decimals (e.g., 6 for USDC, 18 for most tokens), or null on failure.
 * Best-effort — returns null if the chain has no RPC or the call reverts.
 */
export async function fetchTokenDecimals(
  tokenAddress: string,
  chainSlug: string,
): Promise<number | null> {
  const network = resolveNetwork(chainSlug);
  const rpcUrl = CHAIN_RPC_URLS[network];
  if (!rpcUrl) return null;

  try {
    // decimals() selector: 0x313ce567
    const res = await fetchWithRetry(() =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            { to: tokenAddress, data: "0x313ce567" },
            "latest",
          ],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );

    if (!res.ok) return null;

    let json: any;
    try {
      json = await res.json();
    } catch {
      return null;
    }

    if (json.error) return null;

    const hex: string = json.result;
    if (!hex || hex === "0x" || hex === "0x0") return null;

    const val = Number(BigInt(hex));
    // Sanity check — decimals should be 0-36
    if (val < 0 || val > 36) return null;
    return val;
  } catch {
    return null;
  }
}

// =============================================================================
// On-Chain ERC-4626 Conversion Rate
// =============================================================================

// ERC-4626 function selectors
// convertToAssets(uint256) = keccak256("convertToAssets(uint256)")[0:4] = 0x07a2d13a
// convertToShares(uint256) = keccak256("convertToShares(uint256)")[0:4] = 0xc6e6f592
const ERC4626_SELECTORS = {
  convertToAssets: "0x07a2d13a",
} as const;

/**
 * Call ERC-4626 convertToAssets(10^decimals) on an IBT contract via eth_call.
 * Returns the conversion rate as a number (underlying per 1 IBT), or null on failure.
 *
 * A healthy IBT typically has a rate >= 1.0 (accruing value over time).
 * A rate below 1.0 may indicate the IBT has lost value (e.g., bad debt, hack, depeg).
 *
 * Best-effort — returns null if the chain has no RPC or the call reverts.
 *
 * IMPORTANT: ibtDecimals encodes the input (1 full IBT = 10^ibtDecimals).
 * underlyingDecimals decodes the output (convertToAssets returns in underlying's
 * decimal space). These can differ — e.g., an 18-decimal IBT wrapping 6-decimal USDC.
 * If underlyingDecimals is not provided, falls back to ibtDecimals (same-decimal case).
 */
export async function fetchIbtConversionRate(
  ibtAddress: string,
  ibtDecimals: number,
  chainSlug: string,
  underlyingDecimals?: number,
): Promise<number | null> {
  const network = resolveNetwork(chainSlug);
  const rpcUrl = CHAIN_RPC_URLS[network];
  if (!rpcUrl) return null;

  const outDecimals = underlyingDecimals ?? ibtDecimals;

  try {
    // Encode: convertToAssets(10^ibtDecimals) — "how much underlying does 1 full IBT token equal?"
    const oneToken = (10n ** BigInt(ibtDecimals)).toString(16).padStart(64, "0");
    const calldata = ERC4626_SELECTORS.convertToAssets + oneToken;

    const res = await fetchWithRetry(() =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            { to: ibtAddress, data: calldata },
            "latest",
          ],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );

    if (!res.ok) return null;

    let json: any;
    try {
      json = await res.json();
    } catch {
      return null;
    }

    if (json.error) return null;

    const hex: string = json.result;
    if (!hex || hex === "0x" || hex === "0x0") return null;

    const raw = BigInt(hex);
    // Divide by underlying decimals — convertToAssets returns in underlying's decimal space
    const divisor = 10n ** BigInt(outDecimals);
    const intPart = raw / divisor;
    const fracPart = raw % divisor;
    return Number(intPart) + Number(fracPart) / Number(divisor);
  } catch {
    return null; // Best-effort — graceful degradation
  }
}

// =============================================================================
// On-Chain Pendle SY Exchange Rate
// =============================================================================

// Pendle IStandardizedYield function selector: exchangeRate()
const PENDLE_SY_SELECTORS = {
  exchangeRate: "0x3ba0b9a9",
} as const;

/**
 * Call Pendle SY exchangeRate() on a Standardized Yield token via eth_call.
 * Returns the exchange rate as a number (underlying per 1 SY), or null on failure.
 *
 * exchangeRate() is a no-arg view function returning uint256 in 18-decimal fixed point,
 * regardless of the underlying token's decimals. 1 SY = result / 1e18 underlying.
 *
 * Best-effort — returns null if the chain has no RPC or the call reverts.
 */
export async function fetchSyExchangeRate(
  syAddress: string,
  chainSlug: string,
): Promise<number | null> {
  const network = resolveNetwork(chainSlug);
  const rpcUrl = CHAIN_RPC_URLS[network];
  if (!rpcUrl) return null;

  try {
    const res = await fetchWithRetry(() =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            { to: syAddress, data: PENDLE_SY_SELECTORS.exchangeRate },
            "latest",
          ],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );

    if (!res.ok) return null;

    let json: any;
    try {
      json = await res.json();
    } catch {
      return null;
    }

    if (json.error) return null;

    const hex: string = json.result;
    if (!hex || hex === "0x" || hex === "0x0") return null;

    const raw = BigInt(hex);
    // exchangeRate() always returns in 18-decimal fixed point
    const divisor = 10n ** 18n;
    const intPart = raw / divisor;
    const fracPart = raw % divisor;
    return Number(intPart) + Number(fracPart) / Number(divisor);
  } catch {
    return null; // Best-effort — graceful degradation
  }
}

// =============================================================================
// MetaVault API
// =============================================================================

/**
 * Validate essential MetaVault fields at the system boundary.
 * Filters out entries missing required fields (address, name, underlying).
 * Logs a warning for the first malformed entry per chain (avoid log spam).
 */
function validateMetavaultEntries(raw: any[], chain: string): SpectraMetavault[] {
  let warned = false;
  const valid: SpectraMetavault[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.address === "string" &&
      typeof item.name === "string" &&
      item.underlying &&
      typeof item.underlying === "object"
    ) {
      valid.push(item as SpectraMetavault);
    } else if (!warned) {
      console.error(`[${chain}] Skipping malformed MetaVault entry: missing address/name/underlying`);
      warned = true;
    }
  }
  return valid;
}

/**
 * Fetch all MetaVaults for a single chain.
 * Returns an empty array if the endpoint returns no data or errors.
 */
export async function fetchMetavaults(chain: string): Promise<SpectraMetavault[]> {
  const network = resolveNetwork(chain);
  try {
    const raw = await fetchSpectra(`/${network}/metavaults`) as any;
    const arr = Array.isArray(raw) ? raw : (raw?.data || []);
    if (!Array.isArray(arr)) return [];
    return validateMetavaultEntries(arr, chain);
  } catch (err) {
    console.error(`MetaVault fetch failed for ${chain}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetch all known Spectra pool addresses for a chain (for protocol detection).
 * Returns a Set<string> of lowercased pool addresses.
 * Best-effort — returns empty set on error.
 */
export async function fetchChainPoolAddresses(chain: string): Promise<Set<string>> {
  const addresses = new Set<string>();
  try {
    const pts = await fetchChainPools(resolveNetwork(chain));
    for (const pt of pts) {
      if (pt.pools) {
        for (const pool of pt.pools) {
          if (pool.address) addresses.add(pool.address.toLowerCase());
        }
      }
    }
  } catch {
    // Best-effort
  }
  return addresses;
}

/**
 * Scan all chains for MetaVaults in parallel.
 * Returns all MetaVaults with their chain slug attached.
 */
export async function scanAllMetavaults(): Promise<{
  metavaults: Array<{ metavault: SpectraMetavault; chain: string }>;
}> {
  const results = await Promise.allSettled(
    API_NETWORKS.map(async (chain) => {
      const mvs = await fetchMetavaults(chain);
      return mvs.map((metavault) => ({ metavault, chain }));
    })
  );

  const metavaults = results
    .filter((r): r is PromiseFulfilledResult<Array<{ metavault: SpectraMetavault; chain: string }>> => r.status === "fulfilled")
    .flatMap(r => r.value);

  return { metavaults };
}

// =============================================================================
// Pendle API
// =============================================================================

/**
 * Fetch JSON from a Pendle API endpoint.
 * Follows the same retry + timeout pattern as fetchSpectra.
 */
export async function fetchPendle(path: string): Promise<unknown> {
  const url = `${PENDLE_API}${path}`;
  const res = await fetchWithRetry(() =>
    fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  );
  if (!res.ok) {
    console.error(`Pendle API error: ${res.status} ${res.statusText} for ${url}`);
    throw new Error(`Pendle API error: ${res.status} ${res.statusText}`);
  }
  // Read body as text first, then parse — avoids stream double-consumption
  const penBody = await res.text();
  try {
    return JSON.parse(penBody);
  } catch {
    throw new Error(`Pendle API returned invalid JSON for ${url}: ${penBody.slice(0, 120)}`);
  }
}

// --- Pendle market cache (30s TTL per chain, matching Spectra pool cache) ---

const PENDLE_CACHE_TTL_MS = 30_000;
const _pendleCache = new Map<string, { markets: PendleMarket[]; expiresAt: number }>();
const _pendleInflight = new Map<string, Promise<PendleMarketResult>>();

/**
 * Strip Pendle's chain-prefixed address format (e.g. "8453-0xabc..." → "0xabc...").
 * Returns the original string if no prefix is found.
 */
function stripPendleChainPrefix(addr: string): string {
  const idx = addr.indexOf("0x");
  return idx >= 0 ? addr.slice(idx) : addr;
}

/**
 * Validate essential Pendle market fields at the system boundary.
 * Also normalizes chain-prefixed addresses (pt, yt, sy, underlyingAsset).
 */
function validatePendleMarkets(raw: any[]): PendleMarket[] {
  const valid: PendleMarket[] = [];
  let warned = false;
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.address === "string" &&
      typeof item.name === "string" &&
      typeof item.expiry === "string" &&
      item.details &&
      typeof item.details === "object"
    ) {
      // Normalize chain-prefixed addresses (e.g. "8453-0xabc..." → "0xabc...")
      if (typeof item.pt === "string") item.pt = stripPendleChainPrefix(item.pt);
      if (typeof item.yt === "string") item.yt = stripPendleChainPrefix(item.yt);
      if (typeof item.sy === "string") item.sy = stripPendleChainPrefix(item.sy);
      if (typeof item.underlyingAsset === "string") item.underlyingAsset = stripPendleChainPrefix(item.underlyingAsset);
      valid.push(item as PendleMarket);
    } else if (!warned) {
      console.error(`[pendle] Skipping malformed market entry: missing address/name/expiry/details`);
      warned = true;
    }
  }
  return valid;
}

/**
 * Result of fetching Pendle markets for a chain.
 * `ok: false` means the API call failed — distinct from `ok: true, markets: []` (chain has no markets).
 */
export interface PendleMarketResult {
  ok: boolean;
  markets: PendleMarket[];
  error?: string;
}

/**
 * Fetch all active Pendle markets for a given Spectra chain slug.
 * Returns { ok: true, markets: [] } if the chain is not supported by Pendle.
 * Returns { ok: false, markets: [], error } on API failure.
 * Cached for 30s with inflight deduplication.
 */
export async function fetchPendleMarkets(chain: string): Promise<PendleMarketResult> {
  const network = resolveNetwork(chain);
  const pendleChainId = PENDLE_CHAIN_IDS[network];
  if (!pendleChainId) return { ok: true, markets: [] }; // Chain not supported by Pendle

  const cacheKey = String(pendleChainId);
  const now = Date.now();
  const cached = _pendleCache.get(cacheKey);
  if (cached && now < cached.expiresAt) return { ok: true, markets: cached.markets };

  const inflight = _pendleInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const raw = await fetchPendle(`/v1/markets/all?isActive=true&chainId=${pendleChainId}`) as any;
      const arr: any[] = raw?.markets || raw || [];
      if (!Array.isArray(arr)) return { ok: true, markets: [] as PendleMarket[] };
      const markets = validatePendleMarkets(arr);
      _pendleCache.set(cacheKey, { markets, expiresAt: Date.now() + PENDLE_CACHE_TTL_MS });
      return { ok: true, markets };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pendle] Failed to fetch markets for ${chain}: ${msg}`);
      return { ok: false, markets: [] as PendleMarket[], error: msg };
    } finally {
      _pendleInflight.delete(cacheKey);
    }
  })();

  _pendleInflight.set(cacheKey, promise);
  return promise;
}

/**
 * Scan all Pendle-supported chains that overlap with Spectra in parallel.
 * Returns active, non-expired markets that pass minimum filters.
 * Best-effort — failed chains are noted but don't block results.
 */
export async function scanAllPendleMarkets(opts: {
  min_tvl_usd?: number;
  min_liquidity_usd?: number;
  asset_filter?: string;
} = {}): Promise<{ markets: Array<{ market: PendleMarket; chain: string }>; failedChains: string[] }> {
  const minTvl = opts.min_tvl_usd ?? 0;
  const minLiq = opts.min_liquidity_usd ?? 0;
  const assetFilter = opts.asset_filter?.toUpperCase();

  const pendleChains = Object.keys(PENDLE_CHAIN_IDS);
  const failedChains: string[] = [];

  const results = await Promise.allSettled(
    pendleChains.map(async (chain) => {
      const result = await fetchPendleMarkets(chain);
      if (!result.ok) {
        return { chain, failed: true as const, markets: [] as Array<{ market: PendleMarket; chain: string }> };
      }
      const now = Date.now();
      const filtered: Array<{ market: PendleMarket; chain: string }> = [];

      for (const m of result.markets) {
        // Skip expired
        const expiryMs = new Date(m.expiry).getTime();
        if (expiryMs <= now) continue;
        // TVL filter
        if ((m.details.totalTvl || 0) < minTvl) continue;
        // Liquidity filter
        if ((m.details.liquidity || 0) < minLiq) continue;
        // Asset filter (match against market name — Pendle names include underlying symbol)
        if (assetFilter && !m.name.toUpperCase().includes(assetFilter)) continue;

        filtered.push({ market: m, chain });
      }
      return { chain, failed: false as const, markets: filtered };
    })
  );

  const allMarkets: Array<{ market: PendleMarket; chain: string }> = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      if (result.value.failed) {
        failedChains.push(result.value.chain);
      } else {
        allMarkets.push(...result.value.markets);
      }
    } else {
      failedChains.push(pendleChains[i]);
    }
  });

  return { markets: allMarkets, failedChains };
}

// =============================================================================
// Pendle Single Market Detail
// =============================================================================

/**
 * Fetch a single Pendle market by address on a given chain.
 * First tries the cache (populated by fetchPendleMarkets), then falls back
 * to the single-market API endpoint.
 */
export async function fetchPendleMarketDetail(
  chain: string,
  marketAddress: string,
): Promise<PendleMarket | null> {
  const network = resolveNetwork(chain);
  const pendleChainId = PENDLE_CHAIN_IDS[network];
  if (!pendleChainId) return null;

  const addrLower = marketAddress.toLowerCase();

  // Try cache first (populated by pendle_list_markets or scanAllPendleMarkets)
  const cacheKey = String(pendleChainId);
  const cached = _pendleCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    const found = cached.markets.find((m) => m.address.toLowerCase() === addrLower);
    if (found) return found;
  }

  // Fetch all markets for this chain (populates cache) — efficient because cache is shared
  const result = await fetchPendleMarkets(chain);
  if (result.ok) {
    const found = result.markets.find((m) => m.address.toLowerCase() === addrLower);
    if (found) return found;
  }

  // Try single-market endpoint as fallback (for inactive/expired markets)
  try {
    const raw = await fetchPendle(`/v1/${pendleChainId}/markets/${marketAddress}`) as any;
    if (raw && typeof raw === "object" && typeof raw.address === "string") {
      const validated = validatePendleMarkets([raw]);
      return validated.length > 0 ? validated[0] : null;
    }
  } catch {
    // Best-effort — market may not exist or endpoint may not be available
  }

  return null;
}

// =============================================================================
// Pendle User Positions
// =============================================================================

/** A single user position on a Pendle market (parsed from API response). */
export interface PendleUserPosition {
  marketAddress: string;
  marketName: string;
  chain: string;
  chainId: number;
  expiry: string;
  pt: { address: string; balance: number; valueUsd: number };
  yt: { address: string; balance: number; valueUsd: number };
  lp: { address: string; balance: number; valueUsd: number };
  sy: { address: string };
  underlyingAsset: string;
  impliedApy: number;   // decimal
  lpApy: number;        // decimal
  totalValueUsd: number;
  isExpired: boolean;
}

/**
 * Fetch user positions on Pendle for a given chain.
 * Tries Pendle's user-data endpoint. Returns empty array on failure.
 */
export async function fetchPendleUserPositions(
  chain: string,
  userAddress: string,
): Promise<{ positions: PendleUserPosition[]; available: boolean }> {
  const network = resolveNetwork(chain);
  const pendleChainId = PENDLE_CHAIN_IDS[network];
  if (!pendleChainId) return { positions: [], available: true };

  try {
    // Pendle user positions endpoint
    const raw = await fetchPendle(
      `/v1/${pendleChainId}/users/${userAddress}/active-positions`
    ) as any;

    const positions: PendleUserPosition[] = [];
    const items: any[] = raw?.positions || raw || [];
    if (!Array.isArray(items)) return { positions: [], available: true };

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const market = item.market || {};
      const pt = item.pt || {};
      const yt = item.yt || {};
      const lp = item.lp || {};

      positions.push({
        marketAddress: market.address || item.marketAddress || "",
        marketName: market.name || item.name || "Unknown",
        chain: network,
        chainId: pendleChainId,
        expiry: market.expiry || item.expiry || "",
        pt: {
          address: stripPendleChainPrefix(pt.address || market.pt || ""),
          balance: pt.balance || pt.amount || 0,
          valueUsd: pt.valuation?.usd || pt.valueUsd || 0,
        },
        yt: {
          address: stripPendleChainPrefix(yt.address || market.yt || ""),
          balance: yt.balance || yt.amount || 0,
          valueUsd: yt.valuation?.usd || yt.valueUsd || 0,
        },
        lp: {
          address: stripPendleChainPrefix(lp.address || market.address || ""),
          balance: lp.balance || lp.amount || 0,
          valueUsd: lp.valuation?.usd || lp.valueUsd || 0,
        },
        sy: { address: stripPendleChainPrefix(market.sy || item.sy || "") },
        underlyingAsset: stripPendleChainPrefix(market.underlyingAsset || item.underlyingAsset || ""),
        impliedApy: market.details?.impliedApy || item.impliedApy || 0,
        lpApy: market.details?.aggregatedApy || item.lpApy || 0,
        totalValueUsd: (pt.valuation?.usd || pt.valueUsd || 0) +
          (yt.valuation?.usd || yt.valueUsd || 0) +
          (lp.valuation?.usd || lp.valueUsd || 0),
        isExpired: item.expiry
          ? new Date(item.expiry).getTime() <= Date.now()
          : false,
      });
    }

    return { positions, available: true };
  } catch (err) {
    console.error(`[pendle] Failed to fetch user positions for ${userAddress} on ${chain}: ${(err as Error).message}`);
    return { positions: [], available: false };
  }
}

/**
 * Scan all Pendle chains for user positions in parallel. Best-effort.
 */
export async function scanAllPendleUserPositions(
  userAddress: string,
): Promise<{ positions: PendleUserPosition[]; failedChains: string[] }> {
  const pendleChains = Object.keys(PENDLE_CHAIN_IDS);
  const failedChains: string[] = [];
  const allPositions: PendleUserPosition[] = [];

  const results = await Promise.allSettled(
    pendleChains.map((chain) => fetchPendleUserPositions(chain, userAddress))
  );

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      if (!result.value.available) failedChains.push(pendleChains[i]);
      allPositions.push(...result.value.positions);
    } else {
      failedChains.push(pendleChains[i]);
    }
  });

  return { positions: allPositions, failedChains };
}

// =============================================================================
// On-Chain Address Type Detection
// =============================================================================

// Cache: address type doesn't change (contracts don't un-deploy).
// Use a simple Map cache — no TTL needed.
const _addressTypeCache = new Map<string, "contract" | "eoa">();

/**
 * Detect whether an address is a contract or EOA via eth_getCode.
 * Returns "contract" if code exists, "eoa" if no code, "unknown" on RPC failure.
 * Best-effort — errors are swallowed. Cached permanently (code doesn't change).
 *
 * @param address - EVM address (0x...)
 * @param chainSlug - Spectra chain slug (e.g., "mainnet", "base")
 */
export async function fetchAddressType(
  address: string,
  chainSlug: string,
): Promise<"contract" | "eoa" | "unknown"> {
  const network = resolveNetwork(chainSlug);
  const cacheKey = `${network}:${address.toLowerCase()}`;

  const cached = _addressTypeCache.get(cacheKey);
  if (cached) return cached;

  const rpcUrl = CHAIN_RPC_URLS[network];
  if (!rpcUrl) return "unknown"; // No RPC configured for this chain

  try {
    const res = await fetchWithRetry(() =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getCode",
          params: [address, "latest"],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );

    if (!res.ok) return "unknown";

    let json: any;
    try {
      json = await res.json();
    } catch {
      return "unknown";
    }

    if (json.error) return "unknown";

    const code: string = json.result || "0x";
    // "0x" or empty means no contract code (EOA)
    const result: "contract" | "eoa" = code.length > 2 ? "contract" : "eoa";
    _addressTypeCache.set(cacheKey, result);
    return result;
  } catch {
    return "unknown"; // Best-effort — don't block the caller
  }
}

// =============================================================================
// On-Chain Event Log Fetching (eth_getLogs)
// =============================================================================

/**
 * Raw event log entry from eth_getLogs.
 */
export interface RawEventLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;       // hex
  transactionHash: string;
  logIndex: string;           // hex
  blockHash: string;
  transactionIndex: string;   // hex
  removed: boolean;
}

/**
 * Fetch the current block number from an RPC endpoint.
 * Returns the block number as a regular number, or null on failure.
 * Best-effort — errors are swallowed.
 */
export async function fetchBlockNumber(rpcUrl: string): Promise<number | null> {
  try {
    const res = await fetchWithRetry(() =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_blockNumber",
          params: [],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );
    if (!res.ok) return null;
    let json: any;
    try { json = await res.json(); } catch { return null; }
    if (json.error) return null;
    const hex: string = json.result;
    if (!hex || hex === "0x") return null;
    return Number(BigInt(hex));
  } catch {
    return null;
  }
}

/**
 * Fetch the timestamp of a specific block via eth_getBlockByNumber.
 * Returns Unix timestamp in seconds, or null on failure.
 * Best-effort — errors are swallowed.
 */
export async function fetchBlockTimestamp(rpcUrl: string, blockNumber: number): Promise<number | null> {
  try {
    const res = await fetchWithRetry(() =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByNumber",
          params: ["0x" + blockNumber.toString(16), false],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );
    if (!res.ok) return null;
    let json: any;
    try { json = await res.json(); } catch { return null; }
    if (json.error || !json.result) return null;
    const hex: string = json.result.timestamp;
    if (!hex) return null;
    return Number(BigInt(hex));
  } catch {
    return null;
  }
}

/**
 * Fetch event logs from an RPC endpoint using eth_getLogs.
 * Automatically chunks large block ranges to avoid public RPC limits.
 * Returns all matching logs sorted by block number ascending.
 * Best-effort — skips failed chunks and continues with the rest.
 *
 * @param rpcUrl - RPC endpoint URL
 * @param address - Contract address to filter logs for
 * @param topics - Event topic filters (topic0 = event signature hash)
 * @param fromBlock - Start block number
 * @param toBlock - End block number
 * @param maxBlocksPerChunk - Max blocks per eth_getLogs request (default MAX_LOG_BLOCK_RANGE)
 * @returns Tuple of [logs, chunksSucceeded, chunksTotal]
 */
export async function fetchLogs(
  rpcUrl: string,
  address: string,
  topics: (string | string[] | null)[],
  fromBlock: number,
  toBlock: number,
  maxBlocksPerChunk: number = MAX_LOG_BLOCK_RANGE,
): Promise<[RawEventLog[], number, number]> {
  const allLogs: RawEventLog[] = [];
  let chunksTotal = 0;
  let chunksSucceeded = 0;

  for (let start = fromBlock; start <= toBlock; start += maxBlocksPerChunk) {
    const end = Math.min(start + maxBlocksPerChunk - 1, toBlock);
    chunksTotal++;
    try {
      const res = await fetchWithRetry(() =>
        fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getLogs",
            params: [{
              address,
              topics,
              fromBlock: "0x" + start.toString(16),
              toBlock: "0x" + end.toString(16),
            }],
          }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
      );

      if (!res.ok) continue;

      let json: any;
      try { json = await res.json(); } catch { continue; }
      if (json.error) {
        console.error(`eth_getLogs error for blocks ${start}-${end}: ${json.error.message || JSON.stringify(json.error)}`);
        continue;
      }

      const logs: RawEventLog[] = json.result || [];
      allLogs.push(...logs);
      chunksSucceeded++;
    } catch (err) {
      console.error(`eth_getLogs fetch failed for blocks ${start}-${end}:`, err instanceof Error ? err.message : err);
    }
  }

  // Sort by block number ascending, then log index
  allLogs.sort((a, b) => {
    const blockDiff = Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber));
    if (blockDiff !== 0) return blockDiff;
    return Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex));
  });

  return [allLogs, chunksSucceeded, chunksTotal];
}

// =============================================================================
// Merkl Rewards API
// =============================================================================

const MERKL_API = "https://api.merkl.xyz/v3";

/**
 * Fetch raw Merkl rewards for a user on a specific chain.
 * Best-effort — returns empty object on any error.
 */
export async function fetchMerkl(
  address: string,
  chainId: number,
): Promise<Record<string, any>> {
  try {
    const url = `${MERKL_API}/userRewards?user=${address}&chainId=${chainId}&proof=false`;
    const res = await fetchWithRetry(() =>
      fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    );
    if (!res.ok) return {};
    try {
      const json = await res.json();
      return (json && typeof json === "object") ? json as Record<string, any> : {};
    } catch {
      return {};
    }
  } catch {
    return {};
  }
}

/**
 * Extract an EVM address from a Merkl reason key.
 * Handles: "ERC20_0xAddr", "Aave_Supply_0xAddr", "MultiLog_123_ERC20_0xAddr", etc.
 * Returns the last 0x+40hex match, or null if none found.
 */
export function extractPoolAddressFromReasonKey(reasonKey: string): string | null {
  const matches = reasonKey.match(/0x[a-fA-F0-9]{40}/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1];
}

/**
 * Parse a raw wei string to human-readable number.
 * Returns 0 for null/undefined/"0" (expected empty inputs).
 * Returns NaN on BigInt parse failure (unexpected format — caller should track this).
 */
export function parseWei(raw: string | null | undefined, decimals: number): number {
  if (!raw || raw === "0") return 0;
  try {
    const bi = BigInt(raw);
    const safeDec = Math.max(0, Math.round(decimals));
    let divisor = 1n;
    for (let i = 0; i < safeDec; i++) divisor *= 10n;
    const intPart = bi / divisor;
    const fracPart = bi % divisor;
    return Number(intPart) + Number(fracPart) / Number(divisor);
  } catch {
    return NaN;
  }
}

/**
 * Parse raw Merkl response into structured rewards, matching against known pool addresses.
 */
export function parseMerklRewards(
  raw: Record<string, any>,
  knownPoolAddresses: Set<string>,
  chain: string,
): MerklChainRewards {
  const matchedMap = new Map<string, Map<string, { symbol: string; decimals: number; accumulated: number; unclaimed: number; pending: number }>>();
  const unmatchedMap = new Map<string, { symbol: string; decimals: number; accumulated: number; unclaimed: number; pending: number }>();
  let parseFailures = 0;

  for (const [tokenAddr, tokenData] of Object.entries(raw)) {
    if (!tokenData || typeof tokenData !== "object") continue;
    const symbol: string = (tokenData as any).symbol || "???";
    const decimals: number = (tokenData as any).decimals ?? 18;
    const reasons: Record<string, any> = (tokenData as any).reasons || {};

    for (const [reasonKey, reasonData] of Object.entries(reasons)) {
      if (!reasonData || typeof reasonData !== "object") continue;

      const poolAddr = extractPoolAddressFromReasonKey(reasonKey);
      if (!poolAddr) continue;

      const accumulated = parseWei((reasonData as any).accumulated, decimals);
      const unclaimed = parseWei((reasonData as any).unclaimed, decimals);
      const pending = parseWei((reasonData as any).pending, decimals);

      // Track parse failures — NaN means BigInt conversion failed on non-null input
      if (isNaN(accumulated) || isNaN(unclaimed) || isNaN(pending)) {
        parseFailures++;
        continue;
      }

      if (accumulated === 0 && unclaimed === 0 && pending === 0) continue;

      const poolLower = poolAddr.toLowerCase();
      if (knownPoolAddresses.has(poolLower)) {
        if (!matchedMap.has(poolLower)) matchedMap.set(poolLower, new Map());
        const poolTokens = matchedMap.get(poolLower)!;
        const tokenKey = tokenAddr.toLowerCase();
        const existing = poolTokens.get(tokenKey);
        if (existing) {
          existing.accumulated += accumulated;
          existing.unclaimed += unclaimed;
          existing.pending += pending;
        } else {
          poolTokens.set(tokenKey, { symbol, decimals, accumulated, unclaimed, pending });
        }
      } else {
        const key = `${tokenAddr.toLowerCase()}_${poolLower}`;
        const existing = unmatchedMap.get(key);
        if (existing) {
          existing.accumulated += accumulated;
          existing.unclaimed += unclaimed;
          existing.pending += pending;
        } else {
          unmatchedMap.set(key, { symbol, decimals, accumulated, unclaimed, pending });
        }
      }
    }
  }

  // Convert matchedMap to MerklTokenReward arrays
  const matched = new Map<string, MerklTokenReward[]>();
  for (const [poolAddr, tokenMap] of matchedMap) {
    const rewards: MerklTokenReward[] = [];
    for (const [tokenAddr, data] of tokenMap) {
      rewards.push({ tokenAddress: tokenAddr, ...data });
    }
    matched.set(poolAddr, rewards);
  }

  // Consolidate unmatched by token address
  const unmatchedByToken = new Map<string, MerklTokenReward>();
  for (const [key, data] of unmatchedMap) {
    const tokenAddr = key.split("_")[0];
    const existing = unmatchedByToken.get(tokenAddr);
    if (existing) {
      existing.accumulated += data.accumulated;
      existing.unclaimed += data.unclaimed;
      existing.pending += data.pending;
    } else {
      unmatchedByToken.set(tokenAddr, { tokenAddress: tokenAddr, ...data });
    }
  }

  return {
    chain,
    matched,
    unmatched: Array.from(unmatchedByToken.values()).filter(r => r.unclaimed > 0 || r.pending > 0),
    parseFailures,
  };
}

// =============================================================================
// Merkl Campaign APR (v4 Opportunities API)
// =============================================================================

const MERKL_V4_API = "https://api.merkl.xyz/v4";
const MERKL_CAMPAIGN_TTL_MS = 60_000; // 60 seconds
/** Result from Merkl API — distinguishes "no campaigns" from "API unavailable" */
export interface MerklResult {
  campaigns: Map<string, MerklCampaign[]>;
  available: boolean;
}

const _merklCampaignCache = new Map<string, { campaigns: Map<string, MerklCampaign[]>; available: boolean; expiresAt: number }>();
const _merklCampaignInflight = new Map<string, Promise<MerklResult>>();

/**
 * Extract a clean 0x address from a Merkl opportunity identifier.
 * Identifiers can have suffixes like "JUMPER", "WHITELIST_CAMPAIGN", etc.
 * Extracts the first 42-char 0x address found.
 */
function cleanMerklIdentifier(identifier: string): string | null {
  const match = identifier.match(/0x[a-fA-F0-9]{40}/);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Fetch Merkl v4 campaign opportunities for a chain, indexed by target address.
 * Returns { campaigns: Map<lowercased_address, MerklCampaign[]>, available: boolean }.
 * available=false means the API was unreachable — campaigns may exist but we can't confirm.
 * Cached for 60s with inflight dedup. Best-effort — never throws.
 */
export async function fetchMerklCampaigns(chainId: number, nameFilter?: string): Promise<MerklResult> {
  // Cache key includes name filter so filtered and unfiltered requests are cached separately
  const cacheKey = nameFilter ? `${chainId}:name=${nameFilter.toLowerCase()}` : `${chainId}`;
  const now = Date.now();
  const cached = _merklCampaignCache.get(cacheKey);
  if (cached && now < cached.expiresAt) return { campaigns: cached.campaigns, available: cached.available };

  const inflight = _merklCampaignInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      // The Merkl v4 API returns ~28 results by default. When nameFilter is provided,
      // pass it as &name= for server-side filtering (returns campaigns matching the name).
      // Also request more items to avoid truncation.
      let url = `${MERKL_V4_API}/opportunities?chainId=${chainId}`;
      if (nameFilter) {
        url += `&name=${encodeURIComponent(nameFilter)}&items=100`;
      }
      const res = await fetchWithRetry(() =>
        fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      );
      if (!res.ok) return { campaigns: new Map<string, MerklCampaign[]>(), available: false };

      const raw = await res.json() as any[];
      if (!Array.isArray(raw)) return { campaigns: new Map<string, MerklCampaign[]>(), available: false };

      const campaignMap = new Map<string, MerklCampaign[]>();

      for (const opp of raw) {
        if (!opp || typeof opp !== "object") continue;
        if (opp.status !== "LIVE") continue;
        if (!opp.identifier || typeof opp.identifier !== "string") continue;

        const addr = cleanMerklIdentifier(opp.identifier);
        if (!addr) continue;

        const apr = typeof opp.apr === "number" ? opp.apr : 0;
        if (apr <= 0) continue;

        // Extract reward token symbols from tokens array
        const rewardTokens: string[] = [];
        if (Array.isArray(opp.tokens)) {
          for (const t of opp.tokens) {
            if (t?.symbol && typeof t.symbol === "string") {
              rewardTokens.push(t.symbol);
            }
          }
        }

        const campaign: MerklCampaign = {
          identifier: addr,
          apr,
          type: opp.type || "",
          action: opp.action || "",
          name: opp.name || "",
          tvl: typeof opp.tvl === "number" ? opp.tvl : 0,
          status: opp.status || "",
          rewardTokens,
          dailyRewards: typeof opp.dailyRewards === "number" ? opp.dailyRewards : 0,
        };

        const existing = campaignMap.get(addr);
        if (existing) {
          existing.push(campaign);
        } else {
          campaignMap.set(addr, [campaign]);
        }
      }

      _merklCampaignCache.set(cacheKey, { campaigns: campaignMap, available: true, expiresAt: Date.now() + MERKL_CAMPAIGN_TTL_MS });
      return { campaigns: campaignMap, available: true } as MerklResult;
    } catch (err) {
      console.error(`Merkl campaign fetch failed for chainId ${chainId}:`, err instanceof Error ? err.message : err);
      return { campaigns: new Map<string, MerklCampaign[]>(), available: false };
    } finally {
      _merklCampaignInflight.delete(cacheKey);
    }
  })();

  _merklCampaignInflight.set(cacheKey, promise);
  return promise;
}

/**
 * Look up Merkl campaigns for a set of addresses.
 * Returns all matching campaigns across all provided addresses.
 */
export function lookupMerklCampaigns(
  merklMap: Map<string, MerklCampaign[]>,
  addresses: string[],
): MerklCampaign[] {
  const campaigns: MerklCampaign[] = [];
  for (const addr of addresses) {
    const found = merklMap.get(addr.toLowerCase());
    if (found) campaigns.push(...found);
  }
  return campaigns;
}

// =============================================================================
// Hyperliquid Funding Rates (free, no auth)
// =============================================================================

const HYPERLIQUID_API = "https://api.hyperliquid.xyz/info";
const FUNDING_CACHE_TTL_MS = 60_000; // 1 minute cache

/** Result from Hyperliquid funding rate fetch — distinguishes "no data" from "API unavailable" */
export interface HyperliquidFundingResult {
  data: Map<string, number>;
  available: boolean;
}

let _fundingCache: { data: Map<string, number>; available: boolean; expiresAt: number } | null = null;

/**
 * Fetch current hourly funding rates for all Hyperliquid perp assets.
 * Returns { data: Map<symbol, annualizedFundingPct>, available: boolean }.
 * Negative = shorts get paid (adds to delta-neutral yield).
 * Caches for 60s. Returns available=false when the API was unreachable.
 */
export async function fetchHyperliquidFunding(): Promise<HyperliquidFundingResult> {
  if (_fundingCache && Date.now() < _fundingCache.expiresAt) {
    return { data: _fundingCache.data, available: _fundingCache.available };
  }

  try {
    const resp = await fetch(HYPERLIQUID_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // Non-OK response — return cached data if available, otherwise unavailable
      if (_fundingCache) return { data: _fundingCache.data, available: _fundingCache.available };
      return { data: new Map(), available: false };
    }

    const raw = await resp.json() as [{ universe: { name: string; isDelisted?: boolean }[] }, { funding: string }[]];
    const universe = raw[0].universe;
    const ctxs = raw[1];
    const result = new Map<string, number>();

    for (let i = 0; i < universe.length; i++) {
      if (universe[i].isDelisted) continue;
      const hourlyRate = parseFloat(ctxs[i].funding);
      if (isNaN(hourlyRate)) continue;
      // Annualize: hourly rate * 24 * 365 * 100 (to percent)
      result.set(universe[i].name.toUpperCase(), hourlyRate * 24 * 365 * 100);
    }

    _fundingCache = { data: result, available: true, expiresAt: Date.now() + FUNDING_CACHE_TTL_MS };
    return { data: result, available: true };
  } catch {
    if (_fundingCache) return { data: _fundingCache.data, available: _fundingCache.available };
    return { data: new Map(), available: false };
  }
}

/**
 * Known mappings from DeFi yield token underlyings to Hyperliquid perp symbols.
 * Best-effort — covers common patterns. Returns null if no match.
 */
export function resolveHyperliquidSymbol(underlying: string): string | null {
  const u = underlying.toUpperCase();

  // Direct match attempts
  const KNOWN_MAP: Record<string, string> = {
    "BTC.B": "BTC", "WBTC": "BTC", "TBTC": "BTC", "CBBTC": "BTC",
    "FXRP": "XRP", "WFLR": "FLR",
    "WETH": "ETH", "STETH": "ETH", "WSTETH": "ETH", "RETH": "ETH", "CBETH": "ETH", "EETH": "ETH",
    "SDCRV": "CRV", "ASDCRV": "CRV",
    "SKAITO": "KAITO",
    "STK-EPENDLE": "PENDLE",
    "SAVAX": "AVAX", "WAVAX": "AVAX",
    "WSOL": "SOL",
    "WBNB": "BNB",
  };

  if (KNOWN_MAP[u]) return KNOWN_MAP[u];

  // Strip common DeFi prefixes and try again
  const stripped = u
    .replace(/^(SW-|YV-|YVV|PT-|YT-|A-|S-|W-|ST-|C-|R-)/, "")
    .replace(/^(SW|YV|YVV|MEV)/, "");
  if (KNOWN_MAP[stripped]) return KNOWN_MAP[stripped];

  // If the underlying IS a Hyperliquid symbol (e.g., "BTC", "ETH")
  // The caller checks against the fetched symbol set
  return stripped || null;
}
