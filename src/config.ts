/**
 * Configuration — constants, chain definitions, Zod schemas, and protocol parameters.
 *
 * Environment variable overrides (set any of these to redirect API traffic at runtime):
 *   SPECTRA_BASE_URL    — Spectra API base (default: https://api.spectra.finance)
 *   SPECTRA_APP_URL     — Spectra App API base (default: https://app.spectra.finance)
 *   MORPHO_GRAPHQL_URL  — Morpho GraphQL endpoint (default: https://api.morpho.org/graphql)
 *   PENDLE_API_URL      — Pendle API base (default: https://api-v2.pendle.finance/core)
 *   FETCH_TIMEOUT       — API timeout in ms (default: 15000)
 *   VE_SPECTRA_RPC_URL  — RPC for veSPECTRA reads (default: https://mainnet.base.org)
 */

import { z } from "zod";

// =============================================================================
// API Endpoints — env overrides allow runtime reconfiguration without rebuild
// =============================================================================

export const SPECTRA_BASE = process.env.SPECTRA_BASE_URL || "https://api.spectra.finance";
export const SPECTRA_API = `${SPECTRA_BASE}/v1`;

export const SPECTRA_APP_BASE = process.env.SPECTRA_APP_URL || "https://app.spectra.finance";
export const SPECTRA_APP_API = `${SPECTRA_APP_BASE}/api/v1`;

export const MORPHO_GRAPHQL = process.env.MORPHO_GRAPHQL_URL || "https://api.morpho.org/graphql";

export const PENDLE_API = process.env.PENDLE_API_URL || "https://api-v2.pendle.finance/core";

export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT) || 15_000;

// =============================================================================
// Chain Configuration
// =============================================================================

// Morpho uses Ethereum chain IDs — map Spectra network slugs to chain IDs for Morpho queries
export const MORPHO_CHAIN_IDS: Record<string, number> = {
  mainnet: 1,
  base: 8453,
  arbitrum: 42161,
  katana: 747474,
  // Morpho also has PT markets on unichain(130) and hyperliquid(999),
  // but those aren't Spectra chains. More can be added as Morpho expands.
};

// Pendle API uses Ethereum chain IDs.
// Includes ALL Pendle-supported chains — both those that overlap with Spectra
// and Pendle-only chains. Curators need the full picture to evaluate cross-protocol
// opportunities and identify chains where Spectra could expand.
// Source: GET /core/v1/chains (confirmed Feb 2026)
//
// DISSOLUTION: Re-fetch from GET /core/v1/chains when Pendle adds new chains.
// Pendle has no versioned chain registry — this list must be manually maintained.
// If Pendle launches on a new L2, add it here AND in PENDLE_CHAIN_NAMES below.
export const PENDLE_CHAIN_IDS: Record<string, number> = {
  mainnet: 1,
  optimism: 10,
  bsc: 56,
  sonic: 146,
  base: 8453,
  arbitrum: 42161,
  mantle: 5000,
  berachain: 80094,
  hyperevm: 999,
  corn: 9745,
  // Overlap with Spectra's SUPPORTED_CHAINS is computed dynamically at runtime.
  // Don't assume which chains are "Pendle-only" — Spectra deploys on new chains regularly.
};

// Human-readable names for Pendle-only chains (not in SUPPORTED_CHAINS)
export const PENDLE_CHAIN_NAMES: Record<string, string> = {
  mainnet: "Ethereum",
  optimism: "Optimism",
  bsc: "BSC",
  sonic: "Sonic",
  base: "Base",
  arbitrum: "Arbitrum",
  mantle: "Mantle",
  berachain: "Berachain",
  hyperevm: "HyperEVM",
  corn: "Corn",
};

const SUPPORTED_CHAINS_INTERNAL = {
  mainnet:   { name: "Ethereum",  id: 1 },
  base:      { name: "Base",      id: 8453 },
  arbitrum:  { name: "Arbitrum",  id: 42161 },
  optimism:  { name: "Optimism",  id: 10 },
  avalanche: { name: "Avalanche", id: 43114 },
  katana:    { name: "Katana",    id: 747474 },
  sonic:     { name: "Sonic",     id: 146 },
  flare:     { name: "Flare",     id: 14 },
  bsc:       { name: "BSC",       id: 56 },
  monad:     { name: "Monad",     id: 143 },
  // user-facing alias -- NOT sent to the API directly
  ethereum:  { name: "Ethereum (alias for mainnet)", id: 1 },
} as const satisfies Record<string, { name: string; id: number }>;

export const SUPPORTED_CHAINS: Record<string, { name: string; id: number }> = SUPPORTED_CHAINS_INTERNAL;

// =============================================================================
// Zod Schemas
// =============================================================================

// All valid values a caller can pass as "chain"
type ChainKey = keyof typeof SUPPORTED_CHAINS_INTERNAL;
export const CHAIN_KEYS = Object.keys(SUPPORTED_CHAINS_INTERNAL) as [ChainKey, ...ChainKey[]];
export const CHAIN_ENUM = z.enum(CHAIN_KEYS);

// Reusable address validator
export const EVM_ADDRESS = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address — must be 0x followed by 40 hex characters");

// =============================================================================
// Helpers
// =============================================================================

// Map user-facing alias to the API network slug
export function resolveNetwork(chain: string): string {
  return chain === "ethereum" ? "mainnet" : chain;
}

// Networks to iterate when scanning all chains (skip the alias to avoid double-counting)
export const API_NETWORKS = Object.keys(SUPPORTED_CHAINS).filter((k) => k !== "ethereum");

// =============================================================================
// Protocol Constants
// =============================================================================

// Spectra protocol constants — sourced from SGP governance proposals.
// Update these if governance changes the parameters. Last verified: Feb 2026.
export const PROTOCOL_CONSTANTS = {
  maxSupply: 876_751_272,
  emissions: {
    base: 1_754_940,         // SPECTRA per week at epoch 0
    decay: 0.989,            // weekly decay multiplier
    offset: 27,              // epoch offset (governance parameter)
    epochStart: "2024-12-19T01:00:00Z",
    stabilizesAt: "1.8% annual at week 105",
  },
  fees: {
    swapToVoters: 0.60,      // 60% swap fees -> veSPECTRA voters
    swapToLPs: 0.20,         // 20% swap fees -> LPs
    swapToCurve: 0.20,       // 20% swap fees -> Curve DAO
    ytToTreasury: 0.03,      // 3% YT fees -> DAO Treasury (in ETH)
  },
  governance: {
    model: "ve(3,3) on Base",
    maxLock: "4 years",
    maxBoost: "2.5x LP boost",
    gaugeEpoch: "Weekly (Thursday UTC)",
  },
  // Default fallback values when no Morpho market is found for looping.
  // Clearly labelled as estimates — not derived from any live market.
  loopingDefaults: {
    ltv: 0.86,
    borrowRatePct: 5.0,
  },
} as const;

// =============================================================================
// veSPECTRA On-Chain Constants (Base chain)
// =============================================================================

// veSPECTRA is an NFT-based voting escrow on Base (NOT classic Curve address-based).
// Source: https://github.com/perspectivefi/spectra-core
// The spectra-governance repo has the OLD veAPW Vyper contracts — do NOT use those.
//
// Boost formula (from Spectra docs):
//   B = min(2.5, 1.5 * (v/V) * (D/d) + 1)
//   v = user's veSPECTRA balance, V = total supply, D = pool TVL, d = user deposit
//   Max boost (2.5x) when v/V >= d/D
//
// On-chain reads use raw eth_call via Base public RPC — no ethers/viem dependency needed.
// Working selectors confirmed Feb 2026:
//   totalSupply() = 0x18160ddd  ✓
//   balanceOf(address) = 0x70a08231  ✓ (returns NFT count)
//   locked(uint256 tokenId) = 0xb45a3c0e  ✓ (returns amount, end, isPermanent)
//   ownerOf(uint256) = 0x6352211e  ✓
// Non-working: balanceOfNFT (0x6bfa7380), tokenOfOwnerByIndex, getVotes
// DISSOLUTION: If veSPECTRA migrates to a new proxy, update address + implementation.
// The contract is behind EIP-1967 proxy — implementation can change without address change.
// Selectors are standard ERC-721/voting-escrow and won't change unless ABI changes.
export const VE_SPECTRA = {
  address: process.env.VE_SPECTRA_ADDRESS || "0x6a89228055c7c28430692e342f149f37462b478b",
  implementation: "0x8a92294ffcfe469a3df4a85c76a0b0d2b3292119", // EIP-1967 proxy
  chainId: 8453, // Base
  rpcUrl: process.env.VE_SPECTRA_RPC_URL || "https://mainnet.base.org",
  selectors: {
    totalSupply: "0x18160ddd",
    balanceOf: "0x70a08231",
    locked: "0xb45a3c0e",
    ownerOf: "0x6352211e",
  },
  decimals: 18,
  maxBoost: 2.5,
  sourceRepo: "https://github.com/perspectivefi/spectra-core",
} as const;

// =============================================================================
// Chain RPC URLs (for eth_getCode and other on-chain reads)
// =============================================================================

// Public RPCs — free, no API key required. May rate-limit under heavy load.
// Used for best-effort on-chain queries (contract detection, etc).
// If a public RPC goes stale, try alternatives like Alchemy/Infura endpoints.
export const CHAIN_RPC_URLS: Partial<Record<string, string>> = {
  mainnet:   "https://eth.llamarpc.com",
  base:      "https://mainnet.base.org",
  arbitrum:  "https://arb1.arbitrum.io/rpc",
  optimism:  "https://mainnet.optimism.io",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  sonic:     "https://rpc.soniclabs.com",
  bsc:       "https://bsc-dataseed1.binance.org",
  flare:     "https://flare-api.flare.network/ext/C/rpc",
  katana:    "https://rpc.katana.network",
  // monad: no well-known public RPC; will return "unknown"
};

// =============================================================================
// Morpho Blue On-Chain Constants
// =============================================================================

// Morpho Blue contract — the address varies per chain despite CREATE2 origins.
// Standard address on mainnet/base/arbitrum: 0xBBBBBBBBbb9cC5e90e3b3Af64bdAF62C37EEFFCb
// Katana: 0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc
// The correct per-chain address is available from the Morpho GraphQL API via morphoBlue { address }.
// Fallback RPCs — tried when the primary RPC fails. Order matters (first fallback tried first).
// Every chain with a primary RPC should have at least one fallback to survive rate-limits.
export const CHAIN_RPC_FALLBACKS: Partial<Record<string, string[]>> = {
  mainnet: [
    "https://rpc.ankr.com/eth",
    "https://ethereum-rpc.publicnode.com",
    "https://1rpc.io/eth",
  ],
  base: [
    "https://base-rpc.publicnode.com",
    "https://1rpc.io/base",
  ],
  arbitrum: [
    "https://arbitrum-one-rpc.publicnode.com",
    "https://1rpc.io/arb",
  ],
  optimism: [
    "https://optimism-rpc.publicnode.com",
    "https://1rpc.io/op",
  ],
  avalanche: [
    "https://avalanche-c-chain-rpc.publicnode.com",
  ],
  bsc: [
    "https://bsc-dataseed2.binance.org",
    "https://bsc-rpc.publicnode.com",
  ],
  sonic: [
    "https://rpc.ankr.com/sonic",
  ],
  flare: [
    "https://rpc.ankr.com/flare",
  ],
};

// =============================================================================
// Average Gas Cost Estimates (USD per transaction)
// =============================================================================

// Approximate average gas cost per Spectra-related transaction (swap, LP, approve).
// These are rough heuristics — actual costs vary with network conditions.
// Used for gas-cost warnings in activity analysis, not for precise accounting.
// Last updated: Feb 2026.
export const CHAIN_GAS_ESTIMATES: Record<string, number> = {
  mainnet:   3.00,
  base:      0.01,
  arbitrum:  0.05,
  optimism:  0.03,
  avalanche: 0.08,
  katana:    0.01,
  sonic:     0.01,
  flare:     0.01,
  bsc:       0.10,
  monad:     0.01,
};

// =============================================================================
// Average Block Times (seconds per block, for block range estimation)
// =============================================================================

// Approximate average block times used to convert time-based lookback windows
// into block counts. Used by spectra_get_onchain_activity to estimate fromBlock when
// the agent specifies a time window instead of explicit block numbers.
export const CHAIN_BLOCK_TIMES: Record<string, number> = {
  mainnet:   12,
  base:      2,
  arbitrum:  0.25,
  optimism:  2,
  avalanche: 2,
  katana:    2,     // estimate — adjust when known
  sonic:     1,
  flare:     3,
  bsc:       3,
  monad:     1,     // estimate — adjust when known
};

// Maximum block range per eth_getLogs request (public RPCs rate-limit large ranges)
export const MAX_LOG_BLOCK_RANGE = 2000;

// =============================================================================
// RPC URL Resolution
// =============================================================================

/**
 * Resolve the RPC URL for a chain, with agent-provided override taking precedence.
 * Enables agents to supply RPC URLs for chains without hardcoded defaults
 * (e.g., Katana, Monad) or to use premium RPCs for better reliability.
 */
export function resolveRpcUrl(chain: string, overrideRpcUrl?: string): string | null {
  if (overrideRpcUrl) return overrideRpcUrl;
  const network = resolveNetwork(chain);
  return CHAIN_RPC_URLS[network] ?? null;
}

/**
 * Get all RPC URLs for a chain — primary + fallbacks — in priority order.
 * If an override is provided, returns only that (no fallbacks).
 */
export function resolveRpcUrlsWithFallbacks(chain: string, overrideRpcUrl?: string): string[] {
  if (overrideRpcUrl) return [overrideRpcUrl];
  const network = resolveNetwork(chain);
  const urls: string[] = [];
  const primary = CHAIN_RPC_URLS[network];
  if (primary) urls.push(primary);
  const fallbacks = CHAIN_RPC_FALLBACKS[network];
  if (fallbacks) urls.push(...fallbacks);
  return urls;
}

// =============================================================================
// Config Staleness Tracking
// =============================================================================

/**
 * Verified dates for hardcoded config sections. If any section is older than
 * STALENESS_THRESHOLD_DAYS, a warning is emitted at startup. This makes
 * invisible staleness visible to operators.
 */
export const CONFIG_VERIFIED_DATES: Record<string, string> = {
  protocolConstants:  "2026-02-01",
  veSpectra:          "2026-02-01",
  morphoBlueAddresses: "2026-02-01",
  pendleChainIds:     "2026-02-01",
  chainBlockTimes:    "2026-02-01",
  chainGasEstimates:  "2026-02-01",
};

const STALENESS_THRESHOLD_DAYS = 120;

/**
 * Emit warnings to stderr for any config section verified more than
 * STALENESS_THRESHOLD_DAYS ago. Called once at startup.
 */
export function checkConfigStaleness(): void {
  const now = Date.now();
  for (const [section, dateStr] of Object.entries(CONFIG_VERIFIED_DATES)) {
    const verifiedAt = new Date(dateStr).getTime();
    const ageDays = (now - verifiedAt) / (1000 * 60 * 60 * 24);
    if (ageDays > STALENESS_THRESHOLD_DAYS) {
      console.error(
        `[config-staleness] ⚠ "${section}" was last verified ${dateStr} (${Math.round(ageDays)}d ago). ` +
        `Review and update CONFIG_VERIFIED_DATES after re-verification.`
      );
    }
  }
}

// =============================================================================
// Chain Config Completeness Validation
// =============================================================================

/**
 * Validate that every chain in SUPPORTED_CHAINS (except aliases) has entries
 * in all per-chain config maps. Emits warnings for gaps — does NOT throw,
 * since missing entries degrade gracefully at runtime.
 */
export function validateChainConfig(): void {
  const chains = API_NETWORKS; // excludes the "ethereum" alias
  const checks: { name: string; map: Partial<Record<string, unknown>> }[] = [
    { name: "CHAIN_RPC_URLS", map: CHAIN_RPC_URLS },
    { name: "CHAIN_BLOCK_TIMES", map: CHAIN_BLOCK_TIMES },
    { name: "CHAIN_GAS_ESTIMATES", map: CHAIN_GAS_ESTIMATES },
  ];

  for (const { name, map } of checks) {
    const missing = chains.filter((c) => !(c in map));
    if (missing.length > 0) {
      console.error(
        `[config-validation] ⚠ ${name} missing entries for: ${missing.join(", ")}. ` +
        `These chains will use fallback defaults or return null at runtime.`
      );
    }
  }
}
