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
  impliedApy?: number;
  ptPrice?: { usd?: number; underlying?: number };
  ytPrice?: { usd?: number };
  liquidity?: { usd?: number };
  lpApy?: SpectraPoolLpApy;
  ytLeverage?: number;
  lpt?: {
    balance?: string;
    decimals?: number;
    price?: { usd?: number };
  };
}

export interface SpectraIbt {
  symbol?: string;
  name?: string;
  protocol?: string;
  decimals?: number;
  apr?: { total?: number };
}

export interface SpectraUnderlying {
  symbol?: string;
  name?: string;
}

export interface SpectraPt {
  name: string;
  address: string;
  maturity: number;
  decimals?: number;
  balance?: string;
  tvl?: { usd?: number };
  pools?: SpectraPool[];
  underlying?: SpectraUnderlying;
  ibt?: SpectraIbt;
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
}

export interface MorphoWarning {
  type: string;
  level: string;
}

export interface MorphoMarket {
  uniqueKey: string;
  lltv: string; // BigInt as string, divide by 1e18
  listed: boolean;
  collateralAsset: MorphoAsset | null;
  loanAsset: MorphoAsset;
  morphoBlue: { chain: { id: number; network: string } };
  state: MorphoMarketState | null;
  warnings: MorphoWarning[];
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

  // Capital-aware metrics (the differentiator vs get_best_fixed_yields)
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

  // Metadata
  underlying: string;
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

  // Metadata
  underlying: string;
  ibtSymbol: string;
  ibtProtocol: string;
  warnings: string[];
}

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
// Internal Interfaces
// =============================================================================

export interface PositionResult {
  text: string;
  totalValue: number;
}
