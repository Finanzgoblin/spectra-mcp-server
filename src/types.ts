/**
 * TypeScript interfaces for Spectra and Morpho API responses.
 */

// =============================================================================
// Spectra API Interfaces
// =============================================================================

export interface SpectraPoolLpApy {
  total?: number;
  details?: {
    fees?: number;
    pt?: number;
    ibt?: number;
    rewards?: Record<string, number>;                          // external token incentives (e.g. { KAT: 54.84, rFLR: 59.46 })
    boostedRewards?: Record<string, { min: number; max: number }>; // SPECTRA gauge emissions with veSPECTRA boost range
  };
  boostedTotal?: number;  // total APY at max boost (includes base + rewards + max boosted)
}

export interface SpectraPool {
  address?: string;
  type?: string;                       // AMM type (e.g. "CURVE_SNG")
  chainId?: number;
  impliedApy?: number;
  ptPrice?: { usd?: number; underlying?: number };
  ytPrice?: { usd?: number };
  liquidity?: { usd?: number };
  lpApy?: SpectraPoolLpApy;
  ytLeverage?: number;
  ibtAmount?: string;                  // raw pool reserves — IBT side (BigInt string, divide by 10^ibt.decimals)
  ptAmount?: string;                   // raw pool reserves — PT side (BigInt string, divide by 10^pt.decimals)
  lpt?: {
    balance?: string;
    decimals?: number;
    supply?: string;                   // total LP token supply (BigInt string)
    price?: { usd?: number; underlying?: number };
  };
}

export interface SpectraIbt {
  address?: string;
  symbol?: string;
  name?: string;
  protocol?: string;
  decimals?: number;
  price?: { underlying?: number; usd?: number };
  apr?: {
    total?: number;
    details?: {
      base?: number;                          // organic yield (e.g. lending rate)
      rewards?: Record<string, number>;       // external incentives (e.g. { "KAT Base": 35, "KAT App Rewards": 5.94 })
    };
  };
}

export interface SpectraUnderlying {
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  price?: { usd?: number };
}

export interface SpectraPt {
  name: string;
  symbol?: string;
  address: string;
  chainId?: number;
  maturity: number;
  decimals?: number;
  balance?: string;
  rate?: string;                       // PT rate (BigInt string)
  createdAt?: number;                  // Unix timestamp of PT creation
  tvl?: { usd?: number; underlying?: number };
  maturityValue?: { underlying?: number; usd?: number };  // what 1 PT redeems for at maturity
  tags?: string[];                     // asset classification (e.g. ["stable"], ["eth"])
  multipliers?: Array<{ amount: number; name: string }>;  // points programs (e.g. Drops, InfiniFi, Firelight)
  pools?: SpectraPool[];
  underlying?: SpectraUnderlying;
  ibt?: SpectraIbt;
  baseIbt?: {                          // unwrapped IBT for sw-* tokens (only present on Spectra wrappers)
    address?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    price?: { usd?: number };
  };
  yt?: {
    balance?: string;
    decimals?: number;
    yield?: {
      claimable?: string;
      claimed?: string;
    };
  };
}

// =============================================================================
// Morpho API Interfaces
// =============================================================================

export interface MorphoAsset {
  address: string;
  symbol: string;
  name: string;
  decimals?: number;
  priceUsd?: number | null;
}

interface MorphoMarketReward {
  asset: { address: string; symbol: string };
  supplyApr: number | null;
  borrowApr: number | null;
}

export interface MorphoMarketState {
  borrowApy: number | null;
  supplyApy: number | null;
  borrowAssetsUsd: number | null;
  supplyAssetsUsd: number | null;
  collateralAssetsUsd: number | null;
  liquidityAssetsUsd: number | null;
  utilization: number | null;
  fee: number | null;
  timestamp: number | null;
  rewards?: MorphoMarketReward[];
}

/** Shared liquidity from a vault's Public Allocator that can be reallocated to this market. */
export interface MorphoPublicAllocatorLiquidity {
  vault: { address: string; name: string | null };
  assets: string; // raw BigInt as string
  withdrawMarket: {
    uniqueKey: string;
    loanAsset: { symbol: string } | null;
    collateralAsset: { symbol: string } | null;
  } | null;
}

interface MorphoWarning {
  type: string;
  level: string;
}

export interface MorphoMarket {
  uniqueKey: string;
  lltv: string; // BigInt as string, divide by 1e18
  listed: boolean;
  collateralAsset: MorphoAsset | null;
  loanAsset: MorphoAsset;
  morphoBlue: { address?: string; chain: { id: number; network: string } };
  state: MorphoMarketState | null;
  warnings: MorphoWarning[];
  // Public Allocator fields — available when queried with extended market fields
  reallocatableLiquidityAssets?: string | null; // raw BigInt as string
  publicAllocatorSharedLiquidity?: MorphoPublicAllocatorLiquidity[];
}

// =============================================================================
// Morpho Vault & Supply-Side Interfaces
// =============================================================================

export interface MorphoVaultAllocation {
  marketKey: string;
  collateralAddress: string;
  collateralSymbol: string;
  loanSymbol: string;
  supplyAssetsUsd: number;
  supplyCap: string | null;
  supplyCapUsd: number | null;
  // Inline market state — carried from vault query, avoids separate batch rate fetch
  lltv?: number;
  borrowApy?: number;
  supplyApy?: number;
  utilization?: number;
}

export interface MorphoVault {
  address: string;
  name: string;
  symbol: string;
  listed: boolean;
  asset: MorphoAsset;
  chain: { id: number; network: string };
  state: {
    totalAssetsUsd: number | null;
    apy: number | null;
    netApy: number | null;
    fee: number | null;
    allocation: MorphoVaultAllocation[];
  } | null;
  curator?: string;
}

export interface MorphoMarketSupplier {
  address: string;
  supplyAssetsUsd: number;
  borrowAssetsUsd: number;
  collateralUsd: number;
  isVault: boolean;
  vaultName?: string;
  vaultSymbol?: string;
  vaultTotalAssetsUsd?: number;
  vaultCurator?: string;
}

// =============================================================================
// Morpho User Position & History Interfaces
// =============================================================================

export interface MorphoUserMarketPosition {
  market: {
    uniqueKey: string;
    collateralAsset: MorphoAsset | null;
    loanAsset: MorphoAsset;
    lltv: string;
    chain: { id: number; network: string };
  };
  supplyAssets: number;
  supplyAssetsUsd: number;
  borrowAssets: number;
  borrowAssetsUsd: number;
  collateralAssets: number;
  collateralAssetsUsd: number;
  isSpectraPt: boolean;
  healthFactor?: number;
}

export interface MorphoUserVaultPosition {
  vault: {
    address: string;
    name: string;
    symbol: string;
    asset: MorphoAsset;
    state: {
      totalAssetsUsd: number | null;
      apy: number | null;
      netApy: number | null;
    } | null;
  };
  assetsUsd: number;
  shares: number;
}

export interface MorphoUserPositions {
  address: string;
  chain: string;
  chainId: number;
  marketPositions: MorphoUserMarketPosition[];
  vaultPositions: MorphoUserVaultPosition[];
  totals: {
    supplyUsd: number;
    borrowUsd: number;
    collateralUsd: number;
    vaultUsd: number;
    netUsd: number;
  };
}

export interface MorphoHistoricalDataPoint {
  timestamp: number;
  borrowApy: number;
  supplyApy: number;
  utilization: number;
  supplyAssetsUsd: number;
  borrowAssetsUsd: number;
}

export interface MorphoRateStats {
  min: number;
  max: number;
  avg: number;
  current: number;
  change: number;
  trend: "up" | "down" | "stable";
}

export interface MorphoHistoricalAnalysis {
  market: MorphoMarket;
  chain: string;
  period: string;
  interval: string;
  dataPoints: MorphoHistoricalDataPoint[];
  stats: {
    borrowApy: MorphoRateStats;
    supplyApy: MorphoRateStats;
    utilization: MorphoRateStats;
    tvl: MorphoRateStats;
  };
  hints: string[];
}

// =============================================================================
// Trade Quote Interfaces
// =============================================================================

export interface TradeQuote {
  side: "buy" | "sell";
  inputToken: string;
  outputToken: string;
  amountIn: number;
  expectedOut: number;
  spotRate: number;
  effectiveRate: number;
  priceImpactPct: number;
  minOut: number;
  slippageTolerancePct: number;
  poolLiquidityUsd: number;
  /** True if expectedOut came from on-chain Curve get_dy(), false if math estimate. */
  onChain?: boolean;
}

// =============================================================================
// Portfolio Simulation Interfaces
// =============================================================================

export interface PositionSnapshot {
  ptBalance: number;
  ptValueUsd: number;
  ytBalance: number;
  ytValueUsd: number;
  lpBalance: number;
  lpValueUsd: number;
  totalValueUsd: number;
}

// =============================================================================
// Strategy Scanner Interfaces
// =============================================================================

export interface ScanOpportunity {
  // Identity
  pt: SpectraPt;
  pool: SpectraPool;
  chain: string;
  ptAddress: string;
  poolAddress: string;

  // Yield metrics
  impliedApy: number;
  variableApr: number;
  fixedVsVariableSpread: number;

  // Maturity
  maturityTimestamp: number;
  daysToMaturity: number;

  // Size (USD)
  tvlUsd: number;
  poolLiquidityUsd: number;

  // Capital-aware metrics (the differentiator vs spectra_get_best_fixed_yields)
  capitalUsd: number;         // the capital size this was computed for (needed for gas rationality)
  entryImpactPct: number;
  effectiveApy: number;       // base APY minus amortized entry cost
  capacityUsd: number;        // max capital before impact exceeds threshold

  // Morpho looping (null if unavailable or not requested)
  looping: {
    morphoMarketKey: string;
    lltv: number;             // decimal (e.g. 0.86)
    borrowRatePct: number;    // percentage (e.g. 4.2)
    optimalLoops: number;
    optimalLeverage: number;
    optimalNetApy: number;    // percentage
    optimalEffectiveNetApy: number; // net APY minus annualized cumulative entry cost
    cumulativeEntryImpactPct: number; // blended impact % across all loops
    morphoLiquidityUsd: number;
  } | null;

  // LP yield (always incentivized by gauge emissions)
  lpApy: number;              // total LP APY (fees + pt + ibt + rewards + SPECTRA base)
  lpApyBoostedTotal: number;  // total LP APY at max veSPECTRA boost
  lpApyAtBoost: number;       // LP APY at agent's veSPECTRA boost level (interpolated)
  lpApyBreakdown: {
    fees: number;
    pt: number;
    ibt: number;
    rewards: Record<string, number>;          // external incentives
    boostedRewards: Record<string, { min: number; max: number }>; // SPECTRA gauge
  };

  // Sort key — used internally for default ordering; agents see all yield dimensions
  sortApy: number;            // looping?.optimalEffectiveNetApy || effectiveApy

  // Merkl external incentive campaigns (populated when available)
  merklCampaigns?: MerklCampaign[];

  // Metadata
  underlying: string;
  ibtAddress: string;
  ibtSymbol: string;
  ibtProtocol: string;
  warnings: string[];
}

// =============================================================================
// YT Arbitrage Interfaces
// =============================================================================

export interface YtArbitrageOpportunity {
  // Identity
  pt: SpectraPt;
  pool: SpectraPool;
  chain: string;
  ptAddress: string;
  poolAddress: string;

  // YT metrics
  ytPriceUsd: number;
  ytPriceUnderlying: number;
  ytLeverage: number;
  ibtCurrentApr: number;       // what IBT actually earns (%)
  ytImpliedRate: number;        // what market prices in (%)
  spreadPct: number;            // ibtCurrentApr - ytImpliedRate (positive = IBT earns more than market prices in)

  // Maturity
  maturityTimestamp: number;
  daysToMaturity: number;

  // Size (USD)
  tvlUsd: number;
  poolLiquidityUsd: number;

  // Capital-aware
  entryImpactPct: number;
  capacityUsd: number;
  breakEvenDays: number;        // days for yield spread to cover entry cost

  // LP yield (always incentivized by gauge emissions)
  lpApy: number;              // total LP APY
  lpApyBoostedTotal: number;  // total LP APY at max veSPECTRA boost
  lpApyAtBoost: number;       // LP APY at agent's veSPECTRA boost level (interpolated)
  lpApyBreakdown: {
    fees: number;
    pt: number;
    ibt: number;
    rewards: Record<string, number>;
    boostedRewards: Record<string, { min: number; max: number }>;
  };

  // Merkl external incentive campaigns (populated when available)
  merklCampaigns?: MerklCampaign[];

  // Metadata
  underlying: string;
  ibtAddress: string;
  ibtSymbol: string;
  ibtProtocol: string;
  warnings: string[];
}

// =============================================================================
// MetaVault API Interfaces
// =============================================================================

export interface SpectraMetavaultPosition {
  address: string;         // PT address
  symbol: string;
  maturity: number;        // Unix timestamp
  chainId?: number;        // chain where the position lives (may differ from MetaVault home chain)
  balance?: string;        // MetaVault's LP token balance (BigInt string) — fallback when lpt.balance is missing
  tvl: { underlying: number; usd: number };
  yt?: {                   // YT held by the vault (minted alongside PT for LP entry)
    address: string;
    decimals: number;
    chainId?: number;
    balance: string;       // BigInt string — vault's YT balance
    yield?: {
      claimable: string;   // BigInt string — unclaimed yield in IBT terms
      claimed: string;     // BigInt string — already claimed yield
    };
  };
  pools: Array<{
    address: string;
    chainId?: number;
    ptApy: number;
    lpApy: SpectraPoolLpApy;
    ytPrice?: { usd?: number };
    lpt?: {
      balance?: string;
      supply?: string;
      decimals?: number;
      price?: { underlying?: number; usd?: number };
    };
  }>;
}

export interface SpectraMetavaultEpoch {
  timestamp: number;
  rate: string;
  assets: string;
  rewardsApy?: {
    total?: number;
    details?: {
      rewards?: Record<string, number>;
      boostedRewards?: Record<string, { min: number; max: number }>;
      ibtRewards?: Record<string, number>;    // IBT-level external incentives (e.g. { "KAT Base": 22.63 })
    };
    boostedTotal?: number;
  };
}

export interface SpectraMetavaultBridgeTx {
  status: string;
  hash: string;
  type: string;
  srcChainId: number;
  dstChainId: number;
  timestamp: number;
  amount: string;
  amountUsd: number;
}

export interface SpectraMetavaultBridge {
  transactions: SpectraMetavaultBridgeTx[];
  totalPendingUsd: number;
}

// External position held outside Spectra LP structure.
// Surfaced by the Spectra API under `metavault.externalPositions[]`.
//
// Phase 5 collapse (spec §9/§10): the spine stops at four typed fields
// (`protocol`, `chainId`, `valueUsd`, `updatedAt`). Protocol-specific fields
// (avant's burnt/claim/orderId, pendle's market/lp/pt/yt/sy, and any future
// module Spectra whitelists) ride through `[key: string]: unknown` untouched.
//
// Why the spine stops at four: the registry at `src/protocols/*` owns
// protocol-specific rendering, classification, and action items. A fifth typed
// field would mean protocol logic has colonized the schema — spec §10 says
// stop and revert. Consumers that read `ext.market.maturity` etc. cast
// locally (e.g. in `formatters.ts`, `stress_test.ts`, `metavault.ts`) before
// accessing protocol-specific paths.
//
// v2 pin retained: package.json still reports version 2.1.0. Downstream tool
// outputs preserve the same visible fields — this is an internal typing change,
// not a format break.
export interface SpectraMetavaultExternalPosition {
  protocol: string;
  chainId?: number;
  valueUsd?: number;
  updatedAt?: number;
  // Protocol-specific fields (avant: burnt/claim/orderId, pendle: market/lp/...,
  // future modules: any shape Spectra whitelists) flow through untouched.
  [key: string]: unknown;
}

export interface SpectraMetavaultRemoteEntry {
  address?: string;
  modifier?: {
    roles?: Record<string, string>;
    delay?: Record<string, string>;
  };
  modules?: Record<string, boolean>;  // module-name → enabled flag
}

export interface SpectraMetavault {
  address: string;         // MetaVault contract address (the Safe Proxy in Theme A topology)
  vault: string;           // Outer ERC-4626 wrapper (secondaryVault in Theme A topology)
  // Inner / PRIMARY ERC-4626 — this is the "infrastructure ERC-4626 vault"
  // that aggregates deployed capital (its `totalAssets()` is the load-bearing
  // chain-truth for `tvl.underlying`). Optional in the schema for forward-
  // compat (some pre-onboarding API rows omit it); when present, Theme A's
  // `readMetaVaultChainState` reads it as the primary accounting source.
  // See docs/onchain-metavault-verification-spec.md §1 (Architecture diagram).
  infraVault?: string;
  chainId: number;
  name: string;
  symbol: string;
  decimals: number;
  // UI-layer visibility flag. Observed values: "VISIBLE" (3 of 6 vaults),
  // "HIDDEN" (3 of 6 — UltraYield WETH/USDC, mainnet WETH MetaVault).
  // Surface as a label, do NOT filter on it.
  status?: string;
  curator: {
    name: string;
    addresses: string[];
  };
  underlying: {
    address: string;
    symbol: string;
    decimals: number;
    price: { usd: number };
  };
  metadata: {
    title: string;
    shortDescription: string;
  };
  positions: SpectraMetavaultPosition[];
  epochs: SpectraMetavaultEpoch[];
  bridge?: SpectraMetavaultBridge;
  // Value held OUTSIDE the Spectra LP structure. Undocumented live field.
  externalPositions?: SpectraMetavaultExternalPosition[];
  tvl: { underlying: number; usd: number };
  liveApy: {
    total: number;
    boostedTotal?: number;
    details?: {
      base?: number;                                              // base LP yield (fees + PT + IBT)
      ibtRewards?: Record<string, number>;                        // IBT-level external incentives (e.g. { "KAT Base": 34.26 })
      mvRewards?: Record<string, number>;                         // MetaVault-specific incentives (e.g. { KAT: 106.61 })
      boostedRewards?: Record<string, { min: number; max: number }>; // SPECTRA gauge with veSPECTRA boost range
    };
  };
  // 30-day trailing average APY. Same shape as liveApy. Present on some
  // vaults, absent on others — may carry total=0 with details.base=null.
  avgApy30d?: {
    total?: number;
    boostedTotal?: number;
    details?: {
      base?: number | null;
      ibtRewards?: Record<string, number>;
      mvRewards?: Record<string, number>;
      boostedRewards?: Record<string, { min: number; max: number }>;
    };
  };
  // Module whitelist — module-name → enabled flag. Top-level is same-chain
  // modules; cross-chain modules live under `remote[chainId].modules`.
  modules?: Record<string, boolean>;
  // Zodiac modifier address record — addresses only, no on-chain reads.
  // The live API returns `roles` and `delay` as free-form `Record<string,string>`
  // with at least `default`, `pool`, `swap` keys observed in production. Theme A
  // captures this as data-only state; on-chain reads of Roles modifier
  // membership/scope graphs are deferred (Appendix A in the spec).
  modifier?: {
    roles?: Record<string, string>;
    delay?: Record<string, string>;
  };
  // Cross-chain deployment map. Keys are chain IDs as decimal strings.
  remote?: Record<string, SpectraMetavaultRemoteEntry>;
  exchangeRate: string;
  price: { underlying: number; usd: number };
}

// =============================================================================
// Theme A — On-Chain MetaVault Verification (Phase 1)
// =============================================================================
//
// Engine in `src/chain-reads.ts` reads canonical on-chain state for a Spectra
// MetaVault's three-role topology: Safe Proxy → infraVault (PRIMARY ERC-4626)
// → secondaryVault (outer ERC-4626 wrapper). Phase 2 will surface this state
// via `formatChainTruthFooter` in `src/formatters.ts`. The type signature is
// frozen in Phase 1 so the engine has a stable consumer at the type-export
// boundary (round-2 N15).
//
// Spec: docs/onchain-metavault-verification-spec.md §3.

import type { ChainKey } from "./config.js";

/**
 * The slice projected from `SpectraMetavault` that the chain-reads engine
 * consumes. Lives here (not in `chain-reads.ts`) because consumers from other
 * tools may want to construct it from non-API sources without importing the
 * engine itself. Decoupling this slice from `SpectraMetavault` keeps the engine
 * substrate-agnostic.
 */
export interface ChainReadInput {
  /** metavault.address — the Safe Proxy (or, in inverted topologies, the role flagged by `role-inversion-detected`). */
  address: string;
  /** metavault.vault — the outer ERC-4626 wrapper (secondaryVault). */
  vault: string;
  /** metavault.infraVault — the PRIMARY ERC-4626 (load-bearing accounting source). */
  infraVault?: string;
  /** Zodiac modifier addresses — data-only capture; no on-chain reads in Phase 1. */
  modifier?: {
    roles?: Record<string, string>;
    delay?: Record<string, string>;
  };
  /** Cross-chain governance map — keys are decimal chain IDs as strings. */
  remote?: Record<
    string,
    {
      modifier?: {
        roles?: Record<string, string>;
        delay?: Record<string, string>;
      };
    }
  >;
  underlying: { address: string; decimals: number; symbol: string };
}

/** Top-level output of `readMetaVaultChainState`. */
export interface MetaVaultChainState {
  chain: ChainKey;
  block: number;
  rpcUsed: string;
  /** Wall-clock ms timestamp when the engine fired (server-side, NOT block time). */
  fetchedAt: number;
  safe: SafeState;
  infraVault: InfraVaultState | null;
  secondaryVault: SecondaryVaultState | null;
  modifiers: ModifierAddresses | null;
  remoteModifiers: Record<string, ModifierAddresses>;
  warnings: ChainReadWarning[];
}

export interface SafeState {
  address: string;
  bytecodePresent: boolean;
  /** Bytecode size in bytes (excluding the `0x` prefix). 171 = canonical Safe Proxy. */
  bytecodeSize: number;
  isSafeProxy: boolean;
  /** Raw masterCopy() return — null when the call reverts or returns malformed data. */
  singleton: string | null;
  /** Mapped to a known Safe singleton ID, or null when the masterCopy is unrecognized. */
  singletonKnown: SafeSingletonId | null;
  /** Underlying token balance held by the Safe (in raw token units). */
  assetBalance: bigint | null;
}

export type SafeSingletonId = "safe-v1.4.1" | "safe-v1.3.0-l2" | "safe-v1.3.0";

export interface InfraVaultState {
  address: string;
  bytecodePresent: boolean;
  bytecodeSize: number;
  /** ERC-4626 totalAssets() — load-bearing primary that reconciles against `api.tvl.underlying`. */
  totalAssets: bigint | null;
  totalSupply: bigint | null;
  asset: string | null;
  decimals: number | null;
  name: string | null;
  symbol: string | null;
  /** Expected to equal SafeState.address when the topology is canonical. */
  owner: string | null;
  paused: boolean | null;
  /** Underlying token balance held BY the infraVault contract directly. */
  selfAssetBalance: bigint | null;
}

/**
 * SecondaryVaultState — the OUTER ERC-4626 wrapper around infraVault.
 *
 * IMPORTANT (round-2 N2): agent prompts and tool outputs MUST NOT directly
 * compare or reconcile `secondaryVault.totalAssets` against `api.tvl.underlying`
 * or any other primary-aggregate metric. The two contracts measure different
 * things: secondaryVault.totalAssets is user-entitlement (outer-vault scope);
 * infraVault.totalAssets is total-deployed (primary aggregate). They share a
 * share rate but not a TVL. See §7 advisory row.
 *
 * v1 captures the surface for the OQ-J disambiguation probe and to expose the
 * outer-inner share-rate identity (a wrapper-pattern signature).
 */
export interface SecondaryVaultState {
  address: string;
  bytecodePresent: boolean;
  bytecodeSize: number;
  /** user-entitlement; do NOT reconcile against tvl.underlying */
  totalAssets: bigint | null;
  totalSupply: bigint | null;
  asset: string | null;
  decimals: number | null;
  name: string | null;
  symbol: string | null;
  selfAssetBalance: bigint | null;
  /** infraVault.balanceOf(secondaryVault) — wrapper signature (≥99% of infraVault.totalSupply expected). */
  infraVaultShareBalance: bigint | null;
  /**
   * Phase 2 (spec BLOCKER #4) — vault-side withdraw capacity reads.
   *
   * These are CAPACITY metrics, NOT entitlement-vs-aggregate comparisons. They
   * answer: "if a holder of secondaryVault shares tried to exit RIGHT NOW, what
   * does the contract say is available?" — important for LP-side risk reads.
   *
   * Holder argument: the secondaryVault's OWN address is passed as the holder
   * (i.e. `maxWithdraw(vault.address)`). This gives a vault-side reading that
   * doesn't require knowing a specific user's identity. For implementations
   * that vary capacity by holder (e.g. allowlists), this is a representative
   * sample; the real per-user value can drift. Spec deviation note: the spec
   * left "caller is the curator EOA OR the secondaryVault's own address" open;
   * Phase 2 takes the second option for simplicity (no need to thread the
   * caller's identity through the engine).
   *
   * Importantly, this DOES NOT propagate the secondaryVault prohibition
   * violation: we read the contract's stated capacity, not its totalAssets-
   * versus-aggregate position.
   */
  maxWithdrawSelf: bigint | null;
  maxRedeemSelf: bigint | null;
  /**
   * `previewRedeem(1 * 10^decimals)` — what the contract says ONE share converts
   * to (in underlying). Spec BLOCKER #4 named three selectors; the brief
   * explicitly listed only two state fields (`maxWithdrawSelf`/`maxRedeemSelf`),
   * but dropping the third selector entirely would silently leave it on the
   * floor. We surface it as `previewRedeemOneShare` so the formatter can
   * cross-check the per-share computation derived from totalAssets/totalSupply.
   * Deviation acknowledged in the diff brief.
   */
  previewRedeemOneShare: bigint | null;
}

/** Flat projection of Zodiac modifier addresses (data-only — no on-chain reads). */
export interface ModifierAddresses {
  rolesDefault: string | null;
  rolesPool: string | null;
  rolesSwap: string | null;
  delayDefault: string | null;
}

export interface ChainReadWarning {
  severity: "info" | "warn" | "error";
  code: ChainReadWarningCode;
  detail: string;
  /** Required (round-2 N9) — warnings are ammunition, not facts. The next investigation
   *  step belongs at the construction site, not the consumer. */
  nextProbe: string;
  blockNumber?: number;
}

export type ChainReadWarningCode =
  | "rpc-fallback-used"                    // ≥1 RPC failed before success
  | "rpc-all-failed"                       // all RPCs in chain's fallback list failed
  | "rpc-batch-truncated"                  // batch response length < request length (silent truncation)
  | "safe-no-bytecode"
  | "infravault-no-bytecode"
  | "secondaryvault-no-bytecode"
  | "secondaryvault-reasoning-prohibited"  // info: reads succeeded; reminds consumers OQ-L is open
  | "pre-onboarding-state"                 // info: only Safe + infraVault have bytecode; secondaryVault empty
  | "accounting-state-zero"                // warn: ALL contracts have null/zero supply (broken vault, NOT pre-onboarding)
  | "safe-non-proxy"
  | "safe-singleton-unknown"
  | "asset-mismatch-infravault"            // infraVault.asset() != input.underlying.address
  | "asset-mismatch-secondaryvault"
  | "owner-mismatch"                       // infraVault.owner() != Safe address
  | "wrapper-signature-broken"             // infraVault.balanceOf(secondaryVault) < 50% of totalSupply (OQ-J pattern violated)
  | "tvl-divergence-small"
  | "tvl-divergence-large"
  | "price-feed-zero"                      // STAK-class signal
  | "role-inversion-detected"              // ERC-4626 reads succeed at metavault.address (would invert the model)
  | "remote-modifier-detected";            // info: cross-chain modifier present

// =============================================================================
// MetaVault Strategy Interfaces
// =============================================================================

export interface MetavaultLoopRow {
  loop: number;
  leverage: number;
  grossApy: number;
  netApy: number;
  effectiveMargin: number;
}

export interface MetavaultCuratorEconomics {
  capitalUsd: number;
  externalDepositsUsd: number;
  ownTvl: number;                // capital * optimal leverage
  totalTvl: number;              // ownTvl + external deposits
  additionalTvlFromLooping: number;
  curatorFeeRevenueUsd: number;  // annual fee income on external deposits
  ownYieldUsd: number;           // annual yield on own capital
  effectiveCuratorApy: number;   // (ownYield + feeRevenue) / capital * 100
}

// =============================================================================
// Merkl Campaign Types
// =============================================================================

/** A Merkl incentive campaign fetched from the v4 opportunities API. */
export interface MerklCampaign {
  identifier: string;    // pool/vault/token address (cleaned, lowercased 0x...)
  apr: number;           // total APR (%)
  type: string;          // CLAMM, ERC20LOGPROCESSOR, MORPHOVAULT, etc.
  action: string;        // POOL, HOLD, etc.
  name: string;          // human-readable campaign name
  tvl: number;           // campaign TVL in USD
  status: string;        // LIVE, PAST, etc.
  rewardTokens: string[]; // reward token symbols
  dailyRewards: number;  // USD daily rewards
  // Campaign timing — when subsidies end. Critical for strategy duration.
  // Without this, agents assume subsidies persist forever.
  earliestEnd?: number;  // Unix timestamp — earliest campaign end
  latestEnd?: number;    // Unix timestamp — latest campaign end
}

// =============================================================================
// Shared Scanner Types
// =============================================================================

/** A single PT×pool pair from a multi-chain scan, before domain-specific enrichment. */
export interface RawPoolOpportunity {
  pt: SpectraPt;
  pool: SpectraPool;
  chain: string;
}

export interface ChainScanResult {
  opportunities: RawPoolOpportunity[];
  failedChains: string[];
}

// =============================================================================
// Pendle API Interfaces
// =============================================================================

export interface PendleMarketDetails {
  liquidity: number;       // pool liquidity in USD
  totalTvl: number;        // total TVL in USD
  tradingVolume: number;   // 24h volume in USD
  underlyingApy: number;   // underlying variable APY (decimal, e.g. 0.05 = 5%)
  swapFeeApy: number;      // swap fee APY (decimal)
  pendleApy: number;       // PENDLE incentive APY (decimal)
  impliedApy: number;      // fixed rate / implied APY (decimal)
  feeRate: number;         // pool fee rate (decimal)
  aggregatedApy: number;   // total LP APY (decimal)
  maxBoostedApy: number;   // max boosted LP APY (decimal)
  totalPt: number;         // total PT in pool
  totalSy: number;         // total SY in pool
  totalSupply: number;     // total LP supply
  totalActiveSupply: number;
  yieldRange?: { min: number; max: number };
}

export interface PendleMarket {
  name: string;
  address: string;         // market/pool address
  expiry: string;          // ISO date string (e.g. "2026-06-25T00:00:00.000Z")
  pt: string;              // PT token address
  yt: string;              // YT token address
  sy: string;              // SY (standardized yield) token address
  underlyingAsset: string; // underlying asset address
  details: PendleMarketDetails;
  chainId: number;
  isNew?: boolean;
  isPrime?: boolean;
  categoryIds?: string[];
  timestamp?: string;
}

// =============================================================================
// Cross-Protocol Interfaces
// =============================================================================

/** A matched pair (or unmatched single) across Spectra and Pendle, aligned by underlying + maturity. */
export interface CrossProtocolMatch {
  spectra: { pt: SpectraPt; pool: SpectraPool; chain: string } | null;
  pendle: { market: PendleMarket; chain: string } | null;
  underlying: string;          // normalized symbol (e.g. "USDC", "ETH")
  maturityGapDays: number;     // absolute days between maturities (0 if one side is null)
  matchQuality: "exact" | "close" | "loose" | "unmatched";
}

/** Unified opportunity from either Spectra or Pendle, for cross-protocol ranking. */
export interface CuratorOpportunity {
  protocol: "spectra" | "pendle";
  chain: string;
  name: string;
  underlying: string;
  maturityTimestamp: number;
  daysToMaturity: number;
  impliedApy: number;          // raw fixed rate (%)
  lpApy: number;               // LP yield (%) — relevant for MetaVault allocation
  variableApr: number;         // underlying variable rate (%)
  tvlUsd: number;
  poolLiquidityUsd: number;
  entryImpactPct: number;
  effectiveApy: number;        // implied APY minus annualized entry cost
  capacityUsd: number;         // max capital before impact exceeds threshold
  sortApy: number;             // ranking key — max(effectiveApy, lpApy, loopingNetApy)
  bestStrategy: "lp" | "pt_spot" | "pt_loop"; // which strategy drives sortApy

  // Protocol-specific identifiers
  ptAddress?: string;          // Spectra PT address
  poolAddress?: string;        // Spectra Curve pool address
  pendleMarketAddress?: string; // Pendle market address
  pendlePtAddress?: string;    // Pendle PT address
  pendleSyAddress?: string;    // Pendle SY address (for mv_check_ibt_health)

  // Enrichment (populated for both Spectra and Pendle)
  looping?: ScanOpportunity["looping"];
  lpApyBreakdown?: ScanOpportunity["lpApyBreakdown"];

  // Morpho supply-side economics (populated for all PTs on Morpho-capable chains)
  morpho?: {
    marketExists: boolean;
    marketKey?: string;
    lltv?: number;
    supplyApyPct?: number;
    borrowApyPct?: number;
    availableLiquidityUsd?: number;
    utilization?: number;
    breakEvenBorrowRate?: number;
    // Hypothetical loop projections for PTs without a Morpho market (creation signal)
    hypotheticalLoopNetApy?: number;   // net APY at assumed LLTV + borrow
    hypotheticalLoops?: number;        // optimal loops at assumed params
    hypotheticalLeverage?: number;
    hypotheticalBreakEvenBorrow?: number; // max borrow rate before loop goes negative
    hypotheticalLltv?: number;         // assumed LLTV used for projection
    hypotheticalBorrowRate?: number;   // assumed borrow rate used
  };

  // Conservative MetaVault gross estimate (LP + 30% YT compounding)
  mvGrossEstimatePct?: number;

  // Perp funding rate for delta-neutral strategy (from Hyperliquid)
  funding?: {
    perpSymbol: string;          // Hyperliquid symbol matched (e.g., "CRV")
    annualizedPct: number;       // annualized funding rate (%). Negative = shorts get paid
    deltaNeutralCostBudget?: number; // break-even borrow + funding adjustment
  };

  // Cross-protocol match info (populated when a counterpart exists on the other protocol)
  matchedWith?: {
    protocol: "spectra" | "pendle";
    chain: string;
    name: string;
    impliedApy: number;
    lpApy: number;
    maturityGapDays: number;
    matchQuality: "exact" | "close" | "loose";
  };

  // Merkl external incentive campaigns (populated when available)
  merklCampaigns?: MerklCampaign[];

  warnings: string[];
}

// =============================================================================
// Curator Risk Monitor Interfaces
// =============================================================================

/** Alert level for a single Morpho position — scaffolds attention, not action. */
export type RiskAlertLevel = "ok" | "watch" | "warning" | "critical";

/** A single Morpho borrowing position with liquidation distance analysis. */
export interface LiquidationAlert {
  /** Morpho market unique key */
  marketKey: string;
  chain: string;
  collateralSymbol: string;
  debtSymbol: string;

  /** Position size */
  collateralUsd: number;
  debtUsd: number;

  /** Core risk metrics */
  lltv: number;                    // decimal (e.g. 0.86)
  healthFactor: number;            // (collateralUsd * lltv) / debtUsd
  liquidationPrice: number;        // price at which liquidation triggers (USD)
  currentPrice: number;            // current collateral price (USD, from API)
  distanceToLiquidationPct: number; // % price drop before liquidation

  /** Borrow rate context — tension between entry assumption and current reality */
  currentBorrowRate: number;       // current borrow APY (%)
  entryBorrowAssumption: number | null; // rate at entry if known, null if unknown
  borrowRateDrift: number | null;  // current - entry, null if entry unknown

  /** Morpho-specific mechanics */
  isFullLiquidation: boolean;      // Morpho has no close factor — entire position at risk

  /** Position tagging */
  isSpectraPt: boolean;            // collateral is a Spectra PT
  isLooper: boolean;               // has both collateral and borrows (loop position)

  /** Risk level — scaffolds attention, multiple signals may disagree */
  alertLevel: RiskAlertLevel;
  alertReasons: string[];          // human-readable reasons for the alert level
}

/** Aggregate risk summary across all positions. */
export interface CuratorRiskSummary {
  address: string;
  chain: string | null;            // null = scanned all chains
  totalPositions: number;
  borrowingPositions: number;      // positions with active debt

  /** Aggregate exposure */
  totalCollateralUsd: number;
  totalDebtUsd: number;

  /** Risk distribution */
  positionsByLevel: Record<RiskAlertLevel, number>;

  /** Lowest health factor across all positions — quick risk signal */
  worstHealthFactor: number | null;
  worstPositionMarket: string | null;

  /** Alert threshold used for this scan */
  alertThresholdPct: number;

  /** Whether live borrow rates were available from the Morpho API.
   *  When false, currentBorrowRate on positions defaults to 0% — rate-based analysis is unreliable. */
  ratesAvailable: boolean;

  /** Individual position details */
  positions: LiquidationAlert[];
}

// =============================================================================
// Borrow Rate Risk Interfaces
// =============================================================================

/** Borrow rate risk assessment for a specific loop count. */
export interface BorrowRateRisk {
  loop: number;
  leverage: number;
  breakEvenRate: number;       // borrow rate (%) that makes net APY = 0
  meanRate: number;            // historical mean borrow rate (%)
  stdDev: number;              // historical std dev of borrow rate (%)
  maxObservedRate: number;     // highest rate seen in the period (%)
  probabilityUnderwater: number; // P(rate > breakEven) based on normal approx
  safe95thPercentile: boolean;   // breakEven > mean + 2*stdDev
}

/** Historical rate analysis for risk assessment. */
export interface BorrowRateAnalysis {
  marketKey: string;
  chain: string;
  period: string;             // e.g. "30d"
  dataPoints: number;
  meanBorrowApy: number;      // %
  stdDevBorrowApy: number;    // %
  maxBorrowApy: number;       // %
  minBorrowApy: number;       // %
  currentBorrowApy: number;   // %
  riskTable: BorrowRateRisk[];
}

// =============================================================================
// Calibration Oracle Interfaces
// =============================================================================
// What "normal" looks like. Built from historical observation, not theory.
// The bridge between perception (monitoring) and specification (assertions).

/** Statistical profile of a single metric over a historical period. */
export interface CalibrationMetric {
  name: string;             // e.g. "borrowApy", "conversionRate", "impliedApy"
  unit: string;             // "%", "ratio", "USD", "tokens"
  stats: {
    min: number;
    max: number;
    avg: number;
    median: number;
    stddev: number;
    p5: number;             // 5th percentile — lower bound of normal
    p25: number;
    p75: number;
    p95: number;            // 95th percentile — upper bound of normal
    current: number;
    trend: "up" | "down" | "stable";
    cov: number;            // coefficient of variation (stddev/avg * 100)
  };
  normalRange: [number, number];  // [p5, p95]
  anomalyThreshold: {
    low: number;            // below this = anomalous
    high: number;           // above this = anomalous
    method: string;         // "2x_max" | "3_sigma" | "iqr_fence"
  };
  currentStatus: "normal" | "elevated" | "anomalous";
  dataPoints: number;
}

/** Full calibration profile for a target (market, pool, or IBT). */
export interface CalibrationProfile {
  target: {
    type: "morpho_market" | "pendle_market" | "spectra_pool" | "ibt";
    identifier: string;    // market key, pool address, or IBT address
    chain: string;
    name: string;
  };
  period: string;          // "7d" | "30d" | "90d"
  metrics: CalibrationMetric[];
  peerComparison: {
    groupDescription: string;   // e.g. "8 USDC Morpho markets on mainnet"
    peerCount: number;
    rankings: Array<{
      metric: string;
      percentile: number;       // where this target sits (0-100)
      label: string;            // "above average", "middle of pack", etc.
    }>;
  } | null;
  assertionHints: string[];    // natural language threshold suggestions
  observationBoundary: string; // what this calibration cannot tell you
}

// =============================================================================
// Withdrawal Stress Test Interfaces
// =============================================================================

/** A single tier in the liquidity waterfall — how the vault generates cash for redemptions. */
export interface WithdrawalWaterfallTier {
  name: string;
  description: string;
  availableUsd: number;
  coveragePct: number;         // % of requested redemption this tier covers
  estimatedCostUsd: number;    // cost to remaining depositors from this tier
  estimatedCostPct: number;    // cost as % of remaining TVL
  cumulativeCoverageUsd: number;
}

/** Result of a withdrawal stress test on a MetaVault. */
export interface StressTestResult {
  vaultName: string;
  chain: string;
  vaultAddress: string;
  tvlUsd: number;
  redemptionPct: number;
  redemptionAmountUsd: number;
  marketStress: boolean;
  waterfall: WithdrawalWaterfallTier[];
  totalCovered: boolean;
  totalCostToRemainingUsd: number;
  totalCostToRemainingPct: number;
  maxSafeRedemptionPct: number;           // within-epoch (instant), Tier 1 + maturing-within-7d only
  maxSafeRedemptionUsd: number;
  // Longer window — includes Tier 1b Avant redemption queue (~1 week cooldown
  // per Avant docs, $0 cost). Delta vs maxSafeRedemptionPct is the liquidity
  // buffer the queue provides. Equal to maxSafeRedemptionPct when no avant
  // external positions exist.
  maxSafeWithinWeekPct: number;
  maxSafeWithinWeekUsd: number;
  /** Cross-chain position summary (empty when all positions are same-chain). */
  crossChainPositions: Array<{ symbol: string; allocationUsd: number }>;
  /** Total USD allocated to cross-chain positions (subject to bridge latency). */
  crossChainTotalUsd: number;
  /** USD currently in-flight via bridge (from MetaVault bridge data). */
  bridgePendingUsd: number;
  /** % of APY from incentive programs (0-100). High values mean TVL may flee when incentives end. */
  incentiveDependencyPct: number;
  /** % of redemption covered by Tier 2 (maturing positions). High values mean coverage is timing-dependent. */
  maturingCoveragePct: number;
  /** Days until nearest maturing position (null if no maturing positions in Tier 2). */
  nearestMaturityDays: number | null;
  /** % of vault TVL sitting idle (undeployed). */
  idlePct: number;
}

// =============================================================================
// Curator Portfolio Interfaces
// =============================================================================

/** Summary of a single vault within a curator's portfolio. */
export interface CuratorVaultSummary {
  chain: string;
  name: string;
  symbol: string;
  address: string;          // MetaVault address
  underlyingSymbol: string;
  tvlUsd: number;
  liveApyTotal: number;
  liveApyBase: number | null;
  /** % of vault TVL sitting idle (undeployed). Null if unknown. */
  idlePct: number | null;
  positionCount: number;
  actionItems: string[];    // expiring positions, idle capital, etc.
}

/** Aggregate portfolio view across all curator vaults. */
export interface CuratorPortfolioSummary {
  curatorAddress: string | null;
  totalAumUsd: number;
  blendedApyPct: number;
  projectedAnnualFeeRevenueUsd: number;
  curatorFeePct: number;
  concentrationByUnderlying: Record<string, number>;  // symbol -> % of AUM
  concentrationByChain: Record<string, number>;        // chain -> % of AUM
  vaultCount: number;
  totalPositions: number;
  actionItems: string[];
  vaults: CuratorVaultSummary[];
}

// =============================================================================
// Performance Metrics Interfaces
// =============================================================================

/** Historical performance metrics computed from MetaVault epoch data. */
export interface MetavaultPerformanceMetrics {
  startDate: string;
  endDate: string;
  totalDays: number;
  epochCount: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  drawdownStartDate: string | null;
  drawdownEndDate: string | null;
  volatilityAnnualizedPct: number;
  sharpeRatio: number | null;       // null if volatility is 0
  riskFreeRatePct: number;
}

// =============================================================================
// Rollover Planner Interfaces
// =============================================================================

/** A candidate pool/market for rolling over an expiring MetaVault position. */
export interface RolloverCandidate {
  protocol: "spectra" | "pendle";
  chain: string;
  name: string;
  ptAddress: string;
  poolAddress: string | null;
  impliedApy: number;
  lpApy: number;
  effectiveApy: number;         // implied APY minus annualized entry cost
  entryImpactPct: number;       // price impact at position's capital size
  daysToMaturity: number;
  maturityTimestamp: number;
  tvlUsd: number;
  poolLiquidityUsd: number;
  yieldGapDays: number;         // days of zero yield during transition
  overlapDays: number | null;   // days of double capital if entering before old matures
  loopingAvailable: boolean;
  loopingNetApy: number | null;
  loopingLoops: number | null;
  warnings: string[];
}

// =============================================================================
// Internal Interfaces
// =============================================================================

export interface PositionResult {
  text: string;
  totalValue: number;
}

// =============================================================================
// Merkl Rewards Interfaces
// =============================================================================

/** A single reward token from the Merkl API, parsed into human-readable units. */
export interface MerklTokenReward {
  tokenAddress: string;
  symbol: string;
  decimals: number;
  accumulated: number;  // total ever earned (human units)
  unclaimed: number;    // available to claim now
  pending: number;      // accrued but not yet claimable
}

/** Merkl reward data for a user on a single chain. */
export interface MerklChainRewards {
  chain: string;
  /** Rewards matched to known portfolio pool addresses. Key = lowercased pool address. */
  matched: Map<string, MerklTokenReward[]>;
  /** Rewards from pools NOT in the current portfolio (user may have exited). */
  unmatched: MerklTokenReward[];
  /** Number of reward entries that failed to parse (BigInt conversion errors).
   *  When > 0, some reward amounts may be missing from the output. */
  parseFailures: number;
}
