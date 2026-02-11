/**
 * API helpers — fetch wrappers with retry, GraphQL sanitization, and Morpho market lookup.
 */

import {
  SPECTRA_API,
  SPECTRA_APP_API,
  MORPHO_GRAPHQL,
  FETCH_TIMEOUT_MS,
  MORPHO_CHAIN_IDS,
  API_NETWORKS,
  resolveNetwork,
  VE_SPECTRA,
} from "./config.js";
import type { MorphoMarket, SpectraPt, SpectraPool, RawPoolOpportunity, ChainScanResult } from "./types.js";

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
  try {
    return await res.json();
  } catch {
    const text = await res.text().catch(() => "(unreadable body)");
    throw new Error(`Spectra API returned invalid JSON for ${url}: ${text.slice(0, 120)}`);
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

// Standard GraphQL fragment for Morpho market fields we always need
export const MORPHO_MARKET_FIELDS = `
  uniqueKey
  lltv
  listed
  collateralAsset { address symbol name decimals }
  loanAsset { address symbol name decimals }
  morphoBlue { chain { id network } }
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

export interface ChainScanOptions {
  min_tvl_usd?: number;
  min_liquidity_usd?: number;
  asset_filter?: string;
}

/**
 * Scan all Spectra chains in parallel, returning non-expired PT×pool pairs
 * that pass TVL, liquidity, and optional asset filters.
 * Shared by get_best_fixed_yields, scan_opportunities, and scan_yt_arbitrage.
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
