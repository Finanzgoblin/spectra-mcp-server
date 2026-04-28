/**
 * Asset metadata registry.
 *
 * PR-A of `docs/hardcode-vs-generalize-spec.md` v3-final.
 *
 * Single source of truth for asset classification — dissolves these scattered
 * inline Sets:
 *   - `formatters.ts:216-227` `DIRECT_ASSETS` + `ONE_HOP_ASSETS` (entry-path inference)
 *   - `tools/curator_scan.ts:567` `STABLES` (Hyperliquid funding hedge skip)
 *
 * Open emergence: adding a new asset = one row here. Helpers (`isStable`,
 * `isStartingPoint`, `getAssetClass`) consume the registry; consumers don't
 * touch literal asset symbols.
 *
 * Provenance discipline: every entry uses `SourcedValue` or `InterpretedValue`
 * per spec §3. Sources cite public protocol docs / CoinGecko / DeFiLlama
 * categories — the assignments are ours, but the inputs are publicly verifiable.
 *
 * Dissolution (spec §10): when a 9th asset class arrives — extend `AssetClass`,
 * add metadata rows, update consumer logic if needed.
 */

import type { SourcedValue, InterpretedValue } from "../protocols/types.js";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type AssetClass =
  | "stable"
  | "wrapped_native"
  | "wrapped_btc"
  | "lst" // liquid-staking token (e.g., stETH)
  | "lrt" // liquid-restaking token (e.g., weETH)
  | "lp_share" // PT/IBT pool LP token (placeholder; populated as PRs surface real cases)
  | "governance"
  | "other";

export interface AssetMeta {
  symbol: string;
  class: SourcedValue<AssetClass> | InterpretedValue<AssetClass>;
  /** True when the asset is one swap from a starting-point asset (USDC/ETH/BTC). */
  oneHop?: boolean;
  /** Canonical token decimals — used for cross-chain shape consistency. */
  canonicalDecimals?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Source URLs
// ────────────────────────────────────────────────────────────────────────────

// Centralized source citations — these are well-known public tickers; the
// classification is ours but the inputs are publicly verifiable.
const COINGECKO_STABLECOINS = "https://www.coingecko.com/en/categories/stablecoins";
const COINGECKO_LST = "https://www.coingecko.com/en/categories/liquid-staking-tokens";
const COINGECKO_LRT = "https://www.coingecko.com/en/categories/liquid-restaking-tokens";
const COINGECKO_GOVERNANCE = "https://www.coingecko.com/en/categories/governance";
const COINGECKO_WRAPPED = "https://www.coingecko.com/en/categories/wrapped-tokens";
const VERIFIED_ON = "2026-04-28";

// Helper: stable SourcedValue<AssetClass> with date-stamped attribution.
function srcClass(value: AssetClass, sourceUrl: string): SourcedValue<AssetClass> {
  return { value, sourceUrl, sourceVerifiedOn: VERIFIED_ON };
}

// ────────────────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────────────────

export const ASSET_METADATA: Record<string, AssetMeta> = {
  // --- Stables (USD-pegged) ---
  USDC:     { symbol: "USDC",     class: srcClass("stable", COINGECKO_STABLECOINS), canonicalDecimals: 6 },
  USDT:     { symbol: "USDT",     class: srcClass("stable", COINGECKO_STABLECOINS), canonicalDecimals: 6 },
  DAI:      { symbol: "DAI",      class: srcClass("stable", COINGECKO_STABLECOINS), canonicalDecimals: 18 },
  "USDC.e": { symbol: "USDC.e",   class: srcClass("stable", COINGECKO_STABLECOINS), canonicalDecimals: 6 },
  USDBC:    { symbol: "USDbC",    class: srcClass("stable", COINGECKO_STABLECOINS), canonicalDecimals: 6 },
  FRAX:     { symbol: "FRAX",     class: srcClass("stable", COINGECKO_STABLECOINS), canonicalDecimals: 18 },
  GHO:      { symbol: "GHO",      class: srcClass("stable", COINGECKO_STABLECOINS), canonicalDecimals: 18, oneHop: true },
  LUSD:     { symbol: "LUSD",     class: srcClass("stable", COINGECKO_STABLECOINS), canonicalDecimals: 18, oneHop: true },
  AUSD:     { symbol: "AUSD",     class: srcClass("stable", COINGECKO_STABLECOINS) },
  NUSD:     { symbol: "NUSD",     class: srcClass("stable", COINGECKO_STABLECOINS) },
  SNUSD:    { symbol: "SNUSD",    class: srcClass("stable", COINGECKO_STABLECOINS) },
  SUSD:     { symbol: "SUSD",     class: srcClass("stable", COINGECKO_STABLECOINS) },
  USP:      { symbol: "USP",      class: srcClass("stable", COINGECKO_STABLECOINS) },
  USDU:     { symbol: "USDU",     class: srcClass("stable", COINGECKO_STABLECOINS) },
  SUSDU:    { symbol: "SUSDU",    class: srcClass("stable", COINGECKO_STABLECOINS) },
  CUSD:     { symbol: "CUSD",     class: srcClass("stable", COINGECKO_STABLECOINS) },
  REUSD:    { symbol: "REUSD",    class: srcClass("stable", COINGECKO_STABLECOINS) },
  USDAI:    { symbol: "USDAI",    class: srcClass("stable", COINGECKO_STABLECOINS) },
  APYUSD:   { symbol: "APYUSD",   class: srcClass("stable", COINGECKO_STABLECOINS) },
  COREUSD:  { symbol: "COREUSD",  class: srcClass("stable", COINGECKO_STABLECOINS) },
  COREUSDC: { symbol: "COREUSDC", class: srcClass("stable", COINGECKO_STABLECOINS) },
  VBUSDC:   { symbol: "VBUSDC",   class: srcClass("stable", COINGECKO_STABLECOINS) },
  VBUSDT:   { symbol: "VBUSDT",   class: srcClass("stable", COINGECKO_STABLECOINS) },
  // Stables one swap from starting-point (treated as stable for class queries; oneHop flag preserves entry-path semantics)
  SDAI:     { symbol: "sDAI",     class: srcClass("stable", COINGECKO_STABLECOINS), oneHop: true, canonicalDecimals: 18 },
  SUSDE:    { symbol: "sUSDe",    class: srcClass("stable", COINGECKO_STABLECOINS), oneHop: true, canonicalDecimals: 18 },
  CRVUSD:   { symbol: "crvUSD",   class: srcClass("stable", COINGECKO_STABLECOINS), oneHop: true, canonicalDecimals: 18 },
  PYUSD:    { symbol: "pyUSD",    class: srcClass("stable", COINGECKO_STABLECOINS), oneHop: true, canonicalDecimals: 6 },
  USDG:     { symbol: "USDG",     class: srcClass("stable", COINGECKO_STABLECOINS), oneHop: true },

  // --- Wrapped native ---
  WETH:     { symbol: "WETH",     class: srcClass("wrapped_native", COINGECKO_WRAPPED), canonicalDecimals: 18 },
  ETH:      { symbol: "ETH",      class: srcClass("wrapped_native", COINGECKO_WRAPPED), canonicalDecimals: 18 },
  WETH_LC:  { symbol: "wETH",     class: srcClass("wrapped_native", COINGECKO_WRAPPED), canonicalDecimals: 18 },

  // --- Wrapped BTC ---
  WBTC:     { symbol: "WBTC",     class: srcClass("wrapped_btc", COINGECKO_WRAPPED), canonicalDecimals: 8 },
  BTC:      { symbol: "BTC",      class: srcClass("wrapped_btc", COINGECKO_WRAPPED), canonicalDecimals: 8 },

  // --- LSTs (Liquid Staking Tokens) ---
  STETH:    { symbol: "stETH",    class: srcClass("lst", COINGECKO_LST), oneHop: true, canonicalDecimals: 18 },
  WSTETH:   { symbol: "wstETH",   class: srcClass("lst", COINGECKO_LST), oneHop: true, canonicalDecimals: 18 },
  CBETH:    { symbol: "cbETH",    class: srcClass("lst", COINGECKO_LST), oneHop: true, canonicalDecimals: 18 },
  RETH:     { symbol: "rETH",     class: srcClass("lst", COINGECKO_LST), oneHop: true, canonicalDecimals: 18 },

  // --- LRTs (Liquid Restaking Tokens) ---
  WEETH:    { symbol: "weETH",    class: srcClass("lrt", COINGECKO_LRT), oneHop: true, canonicalDecimals: 18 },
  EZETH:    { symbol: "ezETH",    class: srcClass("lrt", COINGECKO_LRT), oneHop: true, canonicalDecimals: 18 },
  RSETH:    { symbol: "rsETH",    class: srcClass("lrt", COINGECKO_LRT), oneHop: true, canonicalDecimals: 18 },

  // --- Governance tokens ---
  CRV:      { symbol: "CRV",      class: srcClass("governance", COINGECKO_GOVERNANCE), oneHop: true, canonicalDecimals: 18 },
  CVX:      { symbol: "CVX",      class: srcClass("governance", COINGECKO_GOVERNANCE), oneHop: true, canonicalDecimals: 18 },
  AAVE:     { symbol: "AAVE",     class: srcClass("governance", COINGECKO_GOVERNANCE), oneHop: true, canonicalDecimals: 18 },
  COMP:     { symbol: "COMP",     class: srcClass("governance", COINGECKO_GOVERNANCE), oneHop: true, canonicalDecimals: 18 },
  MKR:      { symbol: "MKR",      class: srcClass("governance", COINGECKO_GOVERNANCE), oneHop: true, canonicalDecimals: 18 },
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an asset symbol to the registry key shape.
 *
 * Spectra API and Pendle API use varying casing (e.g., `"USDC.e"` lowercased
 * `e` for Avalanche bridged USDC; `"WETH"` uppercase elsewhere). This
 * normalization upper-cases the symbol but preserves the `.e` lowercase
 * convention for Avalanche bridged assets.
 *
 * Examples:
 *   - `"usdc"` → `"USDC"`
 *   - `"USDC.E"` → `"USDC.e"`
 *   - `"weth"` → `"WETH"`
 *   - `"sDAI"` → `"SDAI"` (registry key lookup; the `AssetMeta.symbol` field
 *     preserves display casing `"sDAI"`)
 */
export function normalizeAssetSymbol(s: string): string {
  if (!s) return "";
  return s.toUpperCase().replace(/\.E$/i, ".e");
}

/**
 * Resolve an asset symbol to its `AssetClass`. Returns `"other"` for unmapped
 * symbols (caller decides whether to treat as exotic).
 */
export function getAssetClass(symbol: string): AssetClass {
  if (!symbol) return "other";
  const meta = ASSET_METADATA[normalizeAssetSymbol(symbol)];
  return meta?.class.value ?? "other";
}

/** True if the asset is in the `stable` class. */
export function isStable(symbol: string): boolean {
  return getAssetClass(symbol) === "stable";
}

/**
 * True if the asset is a "starting point" — one of the universally-held
 * classes (stable, wrapped_native, wrapped_btc) most wallets already hold or
 * can acquire trivially. Drives entry-path inference (no swap hop needed).
 */
export function isStartingPoint(symbol: string): boolean {
  const c = getAssetClass(symbol);
  return c === "stable" || c === "wrapped_native" || c === "wrapped_btc";
}

/**
 * True if the asset is one swap away from a starting-point asset. Used to
 * differentiate "trivial entry" from "single-swap entry" in entry-path prose.
 *
 * Implementation note: the `oneHop` field on `AssetMeta` is the canonical
 * source. `isStartingPoint` and `isOneHop` are mutually exclusive for any
 * given symbol (a starting-point asset is never also one-hop).
 */
export function isOneHop(symbol: string): boolean {
  if (!symbol) return false;
  if (isStartingPoint(symbol)) return false;
  const meta = ASSET_METADATA[normalizeAssetSymbol(symbol)];
  return meta?.oneHop === true;
}
