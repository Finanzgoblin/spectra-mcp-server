// =============================================================================
// Spectra API Response Schemas
// =============================================================================
//
// Why this file exists:
//   The Spectra API returns JSON that the rest of the codebase consumes through
//   hand-written TypeScript interfaces. Those interfaces have historically
//   overstated what the API guarantees (e.g. declaring `yt.yield.claimable`
//   as non-optional when it can be missing on Base and Flare). When the
//   interface lies, every downstream consumer is silently wrong — and every
//   few weeks a field turns out to be nullable and the tool crashes.
//
// Scope discipline:
//   THIS FILE COVERS: `/v1/{chain}/metavaults`, `/v1/{chain}/pt/{address}`,
//   `/v1/{chain}/pools`, and `/v1/{chain}/portfolio/{address}`.
//   `/voting-incentives` is still fetched through the raw `fetchSpectra`.
//   Extending to more endpoints is incremental — one endpoint at a time,
//   each grounded in live fixtures, each with tests.
//
// Design choices (from a four-lens dialectic — see memory/):
//   1. `.passthrough()` at every object boundary. Spectra adds fields weekly
//      and strict mode would break on every addition. We validate what we
//      consume; we ignore what we don't.
//   2. `.optional()` on every field that is not universally present in the
//      live fixtures. This is derived from real `/metavaults` responses on
//      base, flare, and katana — NOT from wishful typing.
//   3. `.nullable()` only where null was directly observed (e.g.
//      `liveApy.details.base` which is legitimately null when there is no
//      base yield).
//   4. BigInt-as-string fields stay as `z.string()`. No `z.coerce.*` —
//      silent coercion hides drift.
//   5. The schema is the source of truth. Types used by the rest of the
//      codebase are derived via `z.infer`. If you want to change the type,
//      change the schema.
//
// Failure mode:
//   Validation failures never throw inside the schema itself. They produce
//   ZodError, which `fetchSpectraValidated` turns into a warning payload
//   alongside the raw data. The caller decides whether to render, warn, or
//   drop. This preserves tool output during live client calls when the API
//   shape drifts mid-session.
// =============================================================================

import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────────────────

const PriceSchema = z
  .object({
    usd: z.number().optional(),
    underlying: z.number().optional(),
  })
  .passthrough();

const TokenSchema = z
  .object({
    address: z.string(),
    symbol: z.string().optional(),
    name: z.string().optional(),
    decimals: z.number().optional(),
    chainId: z.number().optional(),
    logoURI: z.string().optional(),
    balance: z.string().optional(),
    price: PriceSchema.optional(),
  })
  .passthrough();

const BoostRangeSchema = z
  .object({
    min: z.number(),
    max: z.number(),
  })
  .passthrough();

// APY detail shape — used by liveApy, avgApy30d, lpApy, rewardsApy.
// `.base` is legitimately nullable (null when there's no base yield).
const ApyDetailsSchema = z
  .object({
    base: z.number().nullable().optional(),
    fees: z.number().optional(),
    pt: z.number().optional(),
    ibt: z.number().nullable().optional(),
    rewards: z.record(z.string(), z.number()).optional(),
    ibtRewards: z.record(z.string(), z.number()).optional(),
    mvRewards: z.record(z.string(), z.number()).optional(),
    boostedRewards: z.record(z.string(), BoostRangeSchema).optional(),
    rewardTokens: z.record(z.string(), TokenSchema).optional(),
  })
  .passthrough();

// `total` and `boostedTotal` are both sometimes null on real responses
// (e.g. `positions[].ibt.apr.total` on Base Gami USDC). Treat any computed
// APY number as nullable on principle — the API uses null to mean "no data
// yet" / "insufficient history" throughout.
const ApySchema = z
  .object({
    total: z.number().nullable().optional(),
    boostedTotal: z.number().nullable().optional(),
    details: ApyDetailsSchema.optional(),
  })
  .passthrough();

// ────────────────────────────────────────────────────────────────────────────
// Position
// ────────────────────────────────────────────────────────────────────────────

const LptSchema = z
  .object({
    address: z.string().optional(),
    balance: z.string().optional(),
    supply: z.string().optional(),
    decimals: z.number().optional(),
    chainId: z.number().optional(),
    price: PriceSchema.optional(),
  })
  .passthrough();

const PoolSchema = z
  .object({
    address: z.string(),
    chainId: z.number().optional(),
    type: z.string().optional(),
    impliedApy: z.number().optional(),
    ptApy: z.number().optional(),
    ptPrice: PriceSchema.optional(),
    ytPrice: PriceSchema.optional(),
    ytLeverage: z.number().optional(),
    liquidity: z.object({ underlying: z.number().optional(), usd: z.number().optional() }).passthrough().optional(),
    ibtAmount: z.string().optional(),
    ptAmount: z.string().optional(),
    ibtToPt: z.string().optional(),
    ptToIbt: z.string().optional(),
    ibtToPtFee: z.string().optional(),
    ptToIbtFee: z.string().optional(),
    feeRate: z.string().optional(),
    midFee: z.string().optional(),
    outFee: z.string().optional(),
    spotPrice: z.string().optional(),
    lastPrices: z.string().optional(),
    lpt: LptSchema.optional(),
    lpApy: ApySchema.optional(),
  })
  .passthrough();

// YT payload — the original bug's neighborhood.
// Every field here has been observed missing on at least one real position:
//   - yt.balance: undefined on pos[1] of Gami USDC (Base), pos[1] of UltraYield WETH
//   - yt.yield: undefined on same positions
//   - yt.yield.claimable: undefined on Base pos[2] (was crash site)
//   - yt.yield.claimed: undefined on UltraYield WETH pos[0]
const YtSchema = z
  .object({
    address: z.string().optional(),
    decimals: z.number().optional(),
    chainId: z.number().optional(),
    balance: z.string().optional(),
    yield: z
      .object({
        claimable: z.string().optional(),
        claimed: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const MaturityValueSchema = z
  .object({
    underlying: z.number().optional(),
    usd: z.number().optional(),
  })
  .passthrough();

// Multipliers can be either a flat array or an object with lp/yt arrays,
// depending on the position's reward program. Union both shapes.
const MultiplierItemSchema = z
  .object({
    name: z.string(),
    amount: z.number(),
  })
  .passthrough();

const MultipliersSchema = z.union([
  z.array(MultiplierItemSchema),
  z
    .object({
      lp: z.array(MultiplierItemSchema).optional(),
      yt: z.array(MultiplierItemSchema).optional(),
    })
    .passthrough(),
]);

const PositionSchema = z
  .object({
    address: z.string(), // PT address — structural, must be present
    symbol: z.string().optional(),
    name: z.string().optional(),
    maturity: z.number(), // Unix timestamp — structural
    chainId: z.number().optional(),
    decimals: z.number().optional(),
    createdAt: z.number().optional(),
    balance: z.string().optional(),
    rate: z.string().optional(),
    tags: z.array(z.string()).optional(),
    tvl: z.object({ ibt: z.number().optional(), underlying: z.number().optional(), usd: z.number().optional() }).passthrough().optional(),
    maturityValue: MaturityValueSchema.optional(),
    underlying: TokenSchema.optional(),
    ibt: TokenSchema.extend({
      apr: ApySchema.optional(),
      protocol: z.string().optional(),
      rate: z.string().optional(),
      spotRate: z.string().optional(),
      routes: z.record(z.string(), z.boolean()).optional(),
      extensions: z.record(z.string(), z.unknown()).optional(),
    }).passthrough().optional(),
    baseIbt: TokenSchema.optional(),
    yt: YtSchema.optional(),
    pools: z.array(PoolSchema).optional(),
    multipliers: MultipliersSchema.optional(),
  })
  .passthrough();

// ────────────────────────────────────────────────────────────────────────────
// Top-level MetaVault
// ────────────────────────────────────────────────────────────────────────────

const CuratorSchema = z
  .object({
    name: z.string().optional(),
    addresses: z.array(z.string()).optional(),
    url: z.string().optional(),
  })
  .passthrough();

const EpochSchema = z
  .object({
    id: z.number().optional(),
    timestamp: z.number(),
    rate: z.string().optional(),
    assets: z.string().optional(),
    rewardsApy: ApySchema.optional(),
  })
  .passthrough();

const BridgeTxSchema = z
  .object({
    status: z.string().optional(),
    hash: z.string().optional(),
    type: z.string().optional(),
    srcChainId: z.number().optional(),
    dstChainId: z.number().optional(),
    timestamp: z.number().optional(),
    amount: z.string().optional(),
    amountUsd: z.number().optional(),
    asset: z.string().optional(),
    message: z.string().optional(),
    attestation: z.string().optional(),
  })
  .passthrough();

const BridgeSchema = z
  .object({
    transactions: z.array(BridgeTxSchema).optional(),
    paths: z.array(z.unknown()).optional(), // shape varies — keep permissive
    totalPendingUsd: z.number().optional(),
  })
  .passthrough();

const ModifierSchema = z
  .object({
    roles: z.record(z.string(), z.string()).optional(),
    delay: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

// ────────────────────────────────────────────────────────────────────────────
// External Positions
// ────────────────────────────────────────────────────────────────────────────
//
// `metavault.externalPositions[]` surfaces value the vault holds OUTSIDE the
// Spectra LP structure — e.g. avUSDx burn-for-redemption on Avalanche (Base
// Gami: $3.65M across 3 entries as of 2026-04-22), or a Pendle LP position
// on mainnet (WETH MetaVault: 1 entry). The field is UNDOCUMENTED in Spectra
// public docs — shape is inferred from observed data.
//
// Phase 5 collapse (spec §9/§10): single permissive shape with
// `protocol: z.string()` and `.passthrough()`. The typed spine STOPS at four
// fields (protocol, chainId, valueUsd, updatedAt). A fifth typed field would
// mean protocol-specific logic has colonized the schema — spec §10 says stop
// and revert.
//
// Why collapsed: the registry at `src/protocols/*` owns all protocol-specific
// rendering, classification, and action-item logic. A third protocol addition
// (Morpho, Midas, Aave, Euler) must require ONLY a metadata.ts edit — no
// schema edits, no zod literal-union expansion. PR1 in the spec names this
// the zero-code protocol-addition gate.
//
// Forward compat: any future whitelisted ERC-4626 module rides through
// `.passthrough()` untouched. The engine interprets shape by protocol name;
// missing template paths surface as `[MISSING:path]` when
// `DRIFT_VISIBILITY=loud` (tests/CI), "?" in production (silent default).
// Consumers that read protocol-specific fields (`ext.market.maturity`,
// `ext.burnt.symbol`, etc.) cast locally — the engine itself resolves
// dot-paths via the template resolver.
//
// Observed protocols (2026-04-22): "avant" (redemption-in-flight), "pendle"
// (LP position held inside vault). Both parse cleanly through the permissive
// shape; their protocol-specific fields (burnt/claim/orderId/market/lp/...)
// survive via `.passthrough()` without narrowing.

export const ExternalPositionSchema = z
  .object({
    protocol: z.string(),
    chainId: z.number().optional(),
    valueUsd: z.number().optional(),
    updatedAt: z.number().optional(),
  })
  .passthrough();

// ────────────────────────────────────────────────────────────────────────────
// Remote (cross-chain module whitelist)
// ────────────────────────────────────────────────────────────────────────────
//
// `metavault.remote` maps foreign-chain IDs (as decimal strings, e.g. "43114")
// to an entry describing the MetaVault's remote deployment on that chain:
// its address there, the modifier/timelock architecture, and the enabled
// module flags. Inner `.passthrough()` keeps forward-compat; outer typing
// lets downstream code reach `.modules` without an `as any` cast.

const RemoteEntrySchema = z
  .object({
    address: z.string().optional(),
    modifier: ModifierSchema.optional(),
    modules: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

/**
 * Full schema for a single MetaVault returned by `/v1/{chain}/metavaults`.
 *
 * Structural fields (required):
 *   - address, vault, chainId, decimals: identity
 *   - name, symbol: human-readable identity
 *
 * Everything else is optional, matching the reality of the live API.
 */
export const MetavaultSchema = z
  .object({
    // Identity — these are the only fields we can count on
    address: z.string(),
    vault: z.string(),
    chainId: z.number(),
    decimals: z.number(),
    name: z.string(),
    symbol: z.string(),

    // Commonly-present fields, still optional for forward compatibility
    infraVault: z.string().optional(),
    createdAt: z.number().optional(),
    status: z.string().optional(),
    defaultIbt: z.string().optional(),
    defaultOption: z.string().optional(),
    exchangeRate: z.string().optional(),

    curator: CuratorSchema.optional(),
    underlying: TokenSchema.optional(),

    metadata: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        shortDescription: z.string().optional(),
      })
      .passthrough()
      .optional(),

    tags: z.array(z.string()).optional(),
    multipliers: z.record(z.string(), z.number()).optional(),

    tvl: z
      .object({
        underlying: z.number().optional(),
        usd: z.number().optional(),
      })
      .passthrough()
      .optional(),

    price: PriceSchema.optional(),
    liveApy: ApySchema.optional(),
    avgApy30d: ApySchema.optional(),

    positions: z.array(PositionSchema).optional(),
    epochs: z.array(EpochSchema).optional(),
    bridge: BridgeSchema.optional(),

    // UNDOCUMENTED live field — appeared after April 15 fixture capture.
    // $3.65M of avant avUSDx-burn on Base Gami flows through here today.
    externalPositions: z.array(ExternalPositionSchema).optional(),

    // Every observed module map is Record<string, boolean> — flag-only.
    // If Spectra adds metadata to module entries, the drift footer fires.
    modifier: ModifierSchema.optional(),
    modules: z.record(z.string(), z.boolean()).optional(),
    remote: z.record(z.string(), RemoteEntrySchema).optional(),

    // Still permissive — not yet investigated for shape stability.
    swap: z.record(z.string(), z.unknown()).optional(),
    transactionQueue: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * Schema for the full `/v1/{chain}/metavaults` response — an array of MetaVaults.
 * Use with `fetchSpectraValidated` for element-level soft validation.
 */
export const MetavaultsArraySchema = z.array(MetavaultSchema);

// ────────────────────────────────────────────────────────────────────────────
// Inferred types — use these in place of the old hand-written interfaces
// ────────────────────────────────────────────────────────────────────────────

export type MetavaultParsed = z.infer<typeof MetavaultSchema>;
export type MetavaultPositionParsed = z.infer<typeof PositionSchema>;
export type MetavaultYtParsed = z.infer<typeof YtSchema>;
export type MetavaultEpochParsed = z.infer<typeof EpochSchema>;
export type MetavaultBridgeParsed = z.infer<typeof BridgeSchema>;

// ────────────────────────────────────────────────────────────────────────────
// /v1/{chain}/pt/{address}
// ────────────────────────────────────────────────────────────────────────────
//
// The PT endpoint returns a single PT object wrapped as { data: [pt] } or
// { data: pt }, with { data: [] } when the PT does not exist on that chain.
//
// Shape parity with MetaVault positions:
//   A PT on the /pt endpoint has the same fields as a PT held inside a
//   MetaVault position (address, maturity, pools, yt, ibt, multipliers...).
//   We reuse PositionSchema directly. If these ever diverge at the API
//   level, split PtSchema out with its own definition.
//
// Live fixtures: test/fixtures/pt-{chain}-{symbol}.json captured from
//   https://app.spectra.finance/api/v1/{chain}/pt/{address}
//
export const PtSchema = PositionSchema;
export type PtParsed = MetavaultPositionParsed;

/**
 * Wrapper matching the endpoint's response shape.
 *
 * `data` may be:
 *   - An array of PTs (typical — `[pt]`)
 *   - A single PT object (legacy shape still observed)
 *   - An empty array (`[]` — PT not found on this chain)
 *   - Absent (`{}` — edge case from error responses)
 *
 * The existing `parsePtResponse` helper handles the unwrap.
 */
export const PtResponseSchema = z
  .object({
    data: z.union([z.array(PtSchema), PtSchema]).optional(),
  })
  .passthrough();

// ────────────────────────────────────────────────────────────────────────────
// /v1/{chain}/pools
// ────────────────────────────────────────────────────────────────────────────
//
// Returns a bare array of PTs (each one includes its `pools` sub-array with
// AMM state). Same shape as the /pt endpoint's inner payload, so we reuse
// PtSchema at the element level.
//
// Observed keys across live fixtures (base/avalanche/katana): address, name,
// symbol, decimals, chainId, rate, tvl, yt, ibt, baseIbt, underlying, maturity,
// createdAt, maturityValue, tags, pools. Every key is already in PositionSchema
// as optional (except the structural `address` + `maturity`).
//
export const PoolsResponseSchema = z.array(PtSchema);

// ────────────────────────────────────────────────────────────────────────────
// /v1/{chain}/portfolio/{address}
// ────────────────────────────────────────────────────────────────────────────
//
// Returns a bare array of PTs held by the address (active and expired).
// Same element shape as /pools, with `balance` populated. The endpoint
// returns HTTP 500 when the address has no positions — api.ts treats that
// as an empty result, so this schema only covers the success payload.
//
export const PortfolioResponseSchema = z.array(PtSchema);
