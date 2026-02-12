/**
 * Configuration — constants, chain definitions, Zod schemas, and protocol parameters.
 */

import { z } from "zod";

// =============================================================================
// API Endpoints
// =============================================================================

export const SPECTRA_BASE = "https://api.spectra.finance";
export const SPECTRA_API = `${SPECTRA_BASE}/v1`;

export const SPECTRA_APP_BASE = "https://app.spectra.finance";
export const SPECTRA_APP_API = `${SPECTRA_APP_BASE}/api/v1`;

export const MORPHO_GRAPHQL = "https://api.morpho.org/graphql";

export const FETCH_TIMEOUT_MS = 15_000;

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
export const VE_SPECTRA = {
  address: "0x6a89228055c7c28430692e342f149f37462b478b",
  implementation: "0x8a92294ffcfe469a3df4a85c76a0b0d2b3292119", // EIP-1967 proxy
  chainId: 8453, // Base
  rpcUrl: "https://mainnet.base.org",
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
  // katana and monad: no well-known public RPCs; these chains will return "unknown"
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
