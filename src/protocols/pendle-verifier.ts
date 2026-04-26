/**
 * Pendle market chain-truth verifier (Theme E second slice).
 *
 * What this resolves:
 *   The Spectra API surfaces pendle `externalPositions` for MetaVaults that
 *   hold Pendle V2 LP shares. The API renders `market.maturity`, the
 *   protocol's nominal `aggregatedApy`, and a stale-by-rendering `settle ~0d`
 *   (Pendle exits via instant AMM swap — there's no operational cooldown).
 *   What the API CANNOT see at render time is whether the market contract
 *   has actually expired (post-maturity isExpired toggle), the live AMM
 *   reserves (depth — load-bearing for stress testing), and whether the
 *   contract self-reports as expired despite the API still rendering as
 *   active (or vice-versa, indexer staleness).
 *
 *   This verifier is one batched eth_call per position against the Pendle
 *   market contract on the position's chain, returning a small structured
 *   result that the engine appends as a `[chain-truth …]` line under the
 *   position render.
 *
 * What this does NOT resolve (honest unobservables):
 *   - **vePENDLE boost**: per-curator boost is computed from `balanceOf(curator)`
 *     against the vePENDLE escrow on Ethereum mainnet (and arbitrum mirror),
 *     which requires the curator's address. The engine boundary (engine.ts +
 *     metavault.ts) does NOT plumb the curator address through to per-position
 *     verification — the `TypedExternalPosition` shape is position-scoped, not
 *     curator-scoped. Adding boost would require a second registry surface
 *     (curator-scoped verifier OR a metavault-context object on the verify call).
 *     This slice covers depth + expiry only; boost stays in
 *     `observationBoundaries.unobservable` per the pendle metadata entry, with
 *     the existing mitigation prose pointing to `mv_get_protocol_context` for
 *     the manual workflow. Mirrors avant-verifier.ts's submission-timestamp
 *     drop — surface what's cheap and high-signal; flag the rest as gap.
 *
 *   - **USD-denominated depth**: totalSy is in SY-token wei (decimals vary by
 *     market — fusnstETH SY has decimals=20, NOT 18). Converting to USD
 *     requires `SY.exchangeRate()` * underlying-USD-price, where the latter is
 *     not on-chain. The verifier surfaces totalLp/totalSy/totalPt as raw wei
 *     observables; downstream consumers compute USD if they want it. This is
 *     analogous to avant surfacing `amountWei` raw rather than dollarizing it.
 *
 * Sources & verification:
 *   - Pendle V2 docs: https://docs.pendle.finance/pendle-v2/Developers/Contracts/PendleMarket
 *     (verified 2026-04-26).
 *   - Reference contract: PendleMarketV3.sol in pendle-finance/pendle-core-v2-public.
 *   - Selectors computed via independent keccak256 (node + `keccak` package):
 *       expiry()              = 0xe184c9be
 *       isExpired()           = 0x2f13b60c
 *       readState(address)    = 0x794052f3
 *       totalActiveSupply()   = 0x72069264
 *     Sanity-checked against Avant's BurnRequestCreated topic from
 *     avant-verifier.ts (computed identically: 0x09fdc4f6 — match).
 *   - Live verification (2026-04-26, mainnet block 25,096,224):
 *       Market 0x559e61c5647fa13d87a3c1dc1229189fcb52227a (CSfusionMVWETH's
 *         pendle:fusnstETH external):
 *       expiry()            = 0x69f29b80 = 1777507200 = 2026-04-30T00:00:00Z
 *                              ↳ matches API market.maturity exactly.
 *       isExpired()         = 0x0 (false — pre-maturity)
 *       totalActiveSupply() = 0x5b62b88fa43710f96 = 105.3975 LP wei (decoded)
 *       readState(0x0) decoded:
 *         totalPt   = 17.198 PT wei (18 decimals)
 *         totalSy   = 473.455 SY wei (decimals vary; here 20)
 *         totalLp   = 105.3605 LP wei
 *         expiry    = 1777507200 (matches the standalone expiry() call)
 *
 *   `totalActiveSupply` and `readState.totalLp` differ by ~37 LP wei. This
 *   is because totalActiveSupply includes the market's own treasury LP burns
 *   in its accounting (per PendleMarketV3 source); the difference is sub-1%
 *   and not material to depth interpretation. We surface `readState.totalLp`
 *   as the canonical depth signal — that's what a swapper actually trades
 *   against.
 *
 * Engine boundary: pure async function. No singletons, no shared state.
 * Per-call timeout 15s (Promise.race with cleared `setTimeout` to prevent
 * the timer leak pattern from earlier theme phases — see avant-verifier.ts
 * lines 366-380 for the canonical reference). Failures degrade to a
 * structured error result; never throws at the engine boundary.
 *
 * 60-day dissolution review:
 *   - If telemetry shows zero `verify_externals=true` invocations against
 *     pendle positions within 60 days of ship, the verifier is fossil and
 *     should be folded into list-mode default OR removed alongside avant
 *     (mirror the avant fossil-trigger).
 *   - If Pendle ships a curator-scoped verifier surface (boost + position
 *     attribution), revisit the vePENDLE narrowing — extend this verifier
 *     to consume curator address from a metavault-context payload.
 *   - If a different chain's Pendle deployment changes its function selectors
 *     (e.g., a v4 market), the keccak-verified selectors stay stable but
 *     readState's MarketState layout could shift — re-verify after a
 *     PendleMarketV4 announcement.
 */

import { resolveRpcUrlsWithFallbacks, FETCH_TIMEOUT_MS, SUPPORTED_CHAINS } from "../config.js";
import { withRpcFallback } from "../api.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pendle V2 market function selectors. First 4 bytes of keccak256(signature),
 * computed independently and verified against the live mainnet market for
 * fusnstETH on 2026-04-26 (see ts-doc atop file).
 */
export const PENDLE_MARKET_SELECTORS = {
  expiry:            "0xe184c9be", // expiry() returns uint256 (unix seconds)
  isExpired:         "0x2f13b60c", // isExpired() returns bool
  readState:         "0x794052f3", // readState(address router) returns MarketState (9 slots)
  totalActiveSupply: "0x72069264", // totalActiveSupply() returns uint256 LP wei
} as const;

/**
 * Per-position verification timeout. One batched eth_call (4 sub-requests) →
 * 15s is plenty even on slow public RPCs. Mirrors AVANT_VERIFY_TIMEOUT_MS.
 */
export const PENDLE_VERIFY_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export interface PendleVerificationOk {
  kind: "ok";
  /** Market contract address (also the LP token address on Pendle V2). */
  marketAddress: string;
  /** Chain slug the market was probed on (e.g., "mainnet"). */
  chainSlug: string;
  /** Numeric chain id mirrored from the position payload. */
  chainId: number;
  /** Maturity unix timestamp from the contract's expiry() method. */
  expirySec: number;
  /** Contract-self-reported expiry flag (independent of timestamp). */
  isExpired: boolean;
  /** Total PT in the market, in PT wei (18 decimals on standard markets). */
  totalPtWei: bigint;
  /** Total SY in the market, in SY wei (decimals vary per market). */
  totalSyWei: bigint;
  /** Total LP minted, in LP wei (always 18 decimals). */
  totalLpWei: bigint;
  /** Block number at read time (audit trail). */
  blockRead: number;
  /** Which RPC URL produced the answer (audit trail). */
  rpcUrl: string;
}

export interface PendleVerificationFailed {
  kind: "failed";
  marketAddress: string;
  chainSlug: string;
  /** Short, single-line error suitable for inline render. */
  error: string;
}

export type PendleVerification = PendleVerificationOk | PendleVerificationFailed;

// ─────────────────────────────────────────────────────────────────────────────
// Calldata + decoding helpers (intentionally local — avoid importing
// chain-reads.ts to keep this slice independent + cheap to test). Mirrors
// avant-verifier.ts's local-helper pattern.
// ─────────────────────────────────────────────────────────────────────────────

function pad32(hex: string): string {
  const clean = hex.toLowerCase().replace(/^0x/, "");
  return clean.padStart(64, "0");
}

/** ABI-encode `readState(address router)` with router = 0x0 (no router-specific fees). */
function encodeReadStateCall(): string {
  return PENDLE_MARKET_SELECTORS.readState + pad32("0x0000000000000000000000000000000000000000");
}

/** ABI-decode a single 32-byte uint256 word. Returns null on shape failure. */
function decodeWordToBigInt(hex: string | null | undefined): bigint | null {
  if (!hex || hex === "0x" || hex.length !== 66) return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

/** ABI-decode a single bool encoded as 32-byte word. Returns null on shape failure. */
function decodeWordToBool(hex: string | null | undefined): boolean | null {
  const big = decodeWordToBigInt(hex);
  if (big == null) return null;
  if (big !== 0n && big !== 1n) return null;
  return big === 1n;
}

/**
 * Decode the MarketState struct returned by `readState(address)`. Layout
 * (9 slots × 32B = 288B = 576 hex chars + 0x prefix = 578):
 *   slot 0: totalPt (int256 packed as uint256 — non-negative in practice)
 *   slot 1: totalSy
 *   slot 2: totalLp
 *   slot 3: treasury (address)
 *   slot 4: scalarRoot (int256)
 *   slot 5: expiry (uint256, unix seconds)
 *   slot 6: lnFeeRateRoot (uint256)
 *   slot 7: reserveFeePercent (uint256)
 *   slot 8: lastLnImpliedRate (uint256)
 *
 * We only consume totalPt/totalSy/totalLp/expiry from this. The other slots
 * are read-only for completeness; future extensions (fee-rate observation)
 * could use them.
 *
 * Returns null on length mismatch.
 */
export function decodePendleMarketState(hex: string): {
  totalPt: bigint;
  totalSy: bigint;
  totalLp: bigint;
  expiry: bigint;
} | null {
  if (!hex || !hex.startsWith("0x")) return null;
  if (hex.length !== 578) return null;
  const body = hex.slice(2);
  const word = (i: number) => "0x" + body.slice(i * 64, (i + 1) * 64);

  const totalPt = decodeWordToBigInt(word(0));
  if (totalPt == null) return null;
  const totalSy = decodeWordToBigInt(word(1));
  if (totalSy == null) return null;
  const totalLp = decodeWordToBigInt(word(2));
  if (totalLp == null) return null;
  const expiry = decodeWordToBigInt(word(5));
  if (expiry == null) return null;

  return { totalPt, totalSy, totalLp, expiry };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain id → slug resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a chainId number from the position payload to a SUPPORTED_CHAINS
 * slug suitable for `resolveRpcUrlsWithFallbacks`. Returns null when the
 * chainId isn't in the supported set (e.g., Pendle on a chain we don't have
 * RPC config for). Skips the "ethereum" alias.
 */
export function chainIdToSlug(chainId: number): string | null {
  for (const [slug, info] of Object.entries(SUPPORTED_CHAINS)) {
    if (slug === "ethereum") continue; // alias for mainnet — skip to keep stable slug
    if (info.id === chainId) return slug;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC plumbing — four batched calls per verification
// ─────────────────────────────────────────────────────────────────────────────

interface BatchEntry {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

interface BatchResult {
  id: number;
  result?: string;
  error?: { code?: number; message?: string };
}

/**
 * Send four calls (expiry, isExpired, readState, blockNumber) as a single
 * JSON-RPC batch. All public Pendle-supported chains accept batches of
 * this size. The response is sorted by `id` to tolerate spec-permitted
 * reordering. Mirrors avant-verifier.ts's fetchBatch.
 *
 * Note: totalActiveSupply is intentionally OMITTED — readState's totalLp is
 * the canonical depth signal, and totalActiveSupply differs by sub-1% (LP
 * burns into the market's own treasury). Surfacing both invites confusion
 * for negligible signal gain. Keep the batch lean.
 */
async function fetchPendleBatch(
  rpcUrl: string,
  marketAddress: string,
): Promise<{
  expiry: string | null;
  isExpired: string | null;
  readState: string | null;
  block: number;
}> {
  const calls: BatchEntry[] = [
    {
      jsonrpc: "2.0",
      id: 0,
      method: "eth_call",
      params: [
        { to: marketAddress, data: PENDLE_MARKET_SELECTORS.expiry },
        "latest",
      ],
    },
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: marketAddress, data: PENDLE_MARKET_SELECTORS.isExpired },
        "latest",
      ],
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_call",
      params: [
        { to: marketAddress, data: encodeReadStateCall() },
        "latest",
      ],
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "eth_blockNumber",
      params: [],
    },
  ];

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(calls),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) {
    throw new Error("RPC returned non-array response to batch");
  }
  const arr = json as BatchResult[];
  // Index by id (spec-permitted reordering).
  const byId = new Map<number, BatchResult>();
  for (const entry of arr) {
    if (typeof entry.id === "number") byId.set(entry.id, entry);
  }
  const ent0 = byId.get(0);
  const ent1 = byId.get(1);
  const ent2 = byId.get(2);
  const ent3 = byId.get(3);
  if (ent0?.error) throw new Error(`expiry reverted: ${ent0.error.message ?? "unknown"}`);
  if (ent1?.error) throw new Error(`isExpired reverted: ${ent1.error.message ?? "unknown"}`);
  if (ent2?.error) throw new Error(`readState reverted: ${ent2.error.message ?? "unknown"}`);
  if (ent3?.error) throw new Error(`block fetch failed: ${ent3.error.message ?? "unknown"}`);
  return {
    expiry: ent0?.result ?? null,
    isExpired: ent1?.result ?? null,
    readState: ent2?.result ?? null,
    block: ent3?.result ? Number(BigInt(ent3.result)) : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public verifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a single Pendle market's live state on its native chain.
 *
 * Caller passes the Pendle market address (which on Pendle V2 is also the
 * LP token address — see Spectra API shape: market.address === lp.address)
 * and the chain id from the position payload.
 *
 * Returns:
 *   - { kind: "ok", … } on a clean batched read.
 *   - { kind: "failed", error } on RPC failure, decode failure, timeout, or
 *     unsupported chain.
 *
 * Never throws. Per-call timeout 15s. Uses `withRpcFallback` so a primary
 * RPC outage falls through to public alternatives (mainnet has 3 fallbacks
 * configured at config.ts).
 */
export async function verifyPendlePosition(
  marketAddress: string,
  chainId: number,
  options: { overrideRpcUrl?: string } = {},
): Promise<PendleVerification> {
  // Defensive guards — return failed-result rather than throw, mirroring
  // avant-verifier.ts's input validation pattern.
  if (typeof marketAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(marketAddress)) {
    return {
      kind: "failed",
      marketAddress: String(marketAddress),
      chainSlug: "?",
      error: `invalid marketAddress: ${marketAddress}`,
    };
  }
  if (!Number.isFinite(chainId) || !Number.isInteger(chainId) || chainId <= 0) {
    return {
      kind: "failed",
      marketAddress,
      chainSlug: "?",
      error: `invalid chainId: ${chainId}`,
    };
  }

  const chainSlug = chainIdToSlug(chainId);
  if (chainSlug == null) {
    return {
      kind: "failed",
      marketAddress,
      chainSlug: `chain:${chainId}`,
      error: `unsupported chainId ${chainId} — no RPC config`,
    };
  }

  const rpcs = resolveRpcUrlsWithFallbacks(chainSlug, options.overrideRpcUrl);
  if (rpcs.length === 0) {
    return {
      kind: "failed",
      marketAddress,
      chainSlug,
      error: `no RPC URLs configured for ${chainSlug}`,
    };
  }

  // Per-position timeout: race the batched RPC against a hard deadline.
  // Mirror avant-verifier.ts's timer-leak fix: store the timer handle and
  // clear in `finally` regardless of who wins, so a slow RPC winning doesn't
  // leave a pending timer holding the event loop. CRITICAL — this is the
  // pattern the architect flagged as a load-bearing constraint.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await withRpcFallback(
      rpcs,
      async (rpcUrl) => {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(new Error(`pendle-verify timed out after ${PENDLE_VERIFY_TIMEOUT_MS}ms`)),
            PENDLE_VERIFY_TIMEOUT_MS,
          );
        });
        try {
          const batch = await Promise.race([
            fetchPendleBatch(rpcUrl, marketAddress),
            timeoutPromise,
          ]);
          // Decode standalone expiry()
          const expiryBig = decodeWordToBigInt(batch.expiry);
          if (expiryBig == null) {
            return {
              kind: "failed",
              marketAddress,
              chainSlug,
              error: "expiry decode failed",
            } satisfies PendleVerificationFailed;
          }
          // Decode standalone isExpired()
          const isExpiredVal = decodeWordToBool(batch.isExpired);
          if (isExpiredVal == null) {
            return {
              kind: "failed",
              marketAddress,
              chainSlug,
              error: "isExpired decode failed",
            } satisfies PendleVerificationFailed;
          }
          // Decode the readState tuple
          const state = decodePendleMarketState(batch.readState ?? "");
          if (!state) {
            return {
              kind: "failed",
              marketAddress,
              chainSlug,
              error: "readState decode failed (length mismatch)",
            } satisfies PendleVerificationFailed;
          }
          // Sanity: expiry() and readState.expiry MUST match — if they
          // diverge, something is structurally wrong (RPC inconsistency,
          // contract migration mid-batch, etc.). Surface as failed rather
          // than render contradictory glyphs.
          if (state.expiry !== expiryBig) {
            return {
              kind: "failed",
              marketAddress,
              chainSlug,
              error: `expiry mismatch: standalone=${expiryBig} readState=${state.expiry}`,
            } satisfies PendleVerificationFailed;
          }
          const ok: PendleVerificationOk = {
            kind: "ok",
            marketAddress,
            chainSlug,
            chainId,
            expirySec: Number(expiryBig),
            isExpired: isExpiredVal,
            totalPtWei: state.totalPt,
            totalSyWei: state.totalSy,
            totalLpWei: state.totalLp,
            blockRead: batch.block,
            rpcUrl,
          };
          return ok;
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          timeoutId = undefined;
        }
      },
      `pendle-verify market=${marketAddress.slice(0, 10)} chain=${chainSlug}`,
    );
  } catch (err: unknown) {
    return {
      kind: "failed",
      marketAddress,
      chainSlug,
      error: (err as Error)?.message?.slice(0, 120) ?? "unknown error",
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Render helpers — used by engine.ts to inline a chain-truth line under
// each pendle external position. Lives here so the format stays co-located
// with the verifier semantics. Mirrors avant-verifier.ts's render section.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a verification result as a single chain-truth line. Three glyphs:
 *
 *   [chain-truth ✓] expiry=2026-04-30 (3d) | depth=105.36 LP / 17.20 PT / 473.45 SY | block N
 *   [chain-truth ⚠] {warning prose} | depth=… | block N
 *   [chain-truth ✗] {short error}
 *
 * The ⚠ glyph fires when:
 *   - on-chain expiry doesn't match the API's market.maturity (indexer drift)
 *   - the contract reports isExpired=true but the API rendering claims still-active
 *     (post-maturity API lag — exits switch from AMM to redeem)
 *   - depth dropped to zero (totalLp === 0) — the market is structurally
 *     dry; the API's aggregatedApy is meaningless
 *
 * Plain ✓ (no qualifier like avant's "eligible") because Pendle exits are
 * truly instant via AMM — the verifier's approval IS confirmation that an
 * exit can transact now (modulo gas + price impact, surfaced separately).
 */
export function formatPendleVerification(
  v: PendleVerification,
  expectedExpirySec?: number,
): string {
  if (v.kind === "failed") {
    return `[chain-truth ✗] ${v.error}`;
  }
  const warnings: string[] = [];
  const expiryIso = new Date(v.expirySec * 1000).toISOString().slice(0, 10);

  // Expiry drift check — the API rendered market.maturity should equal the
  // on-chain expiry(). Divergence signals indexer staleness.
  if (
    expectedExpirySec != null &&
    Number.isFinite(expectedExpirySec) &&
    expectedExpirySec !== v.expirySec
  ) {
    warnings.push(
      `expiry drift: chain=${v.expirySec} (${expiryIso}) vs api=${expectedExpirySec}`,
    );
  }

  // isExpired toggle — once the contract self-reports expired, the AMM stops
  // accepting trades and exit becomes redeem(). The API's `aggregatedApy`
  // and `settle ~0d` both become misleading after this flips.
  if (v.isExpired) {
    warnings.push("contract isExpired=true — AMM closed, redeem-only");
  }

  // Depth-zero check — totalLp = 0 means no one is providing liquidity. Even
  // if the market hasn't expired, an exit will revert or impact 100%.
  if (v.totalLpWei === 0n) {
    warnings.push("totalLp=0 — market structurally dry");
  }

  // Render the depth slice. Three values surfaced raw (bigint→string with
  // 18-decimal-fixed-point for human readability where standard, otherwise
  // raw wei). The decimals heuristic: LP is always 18; PT is typically 18;
  // SY decimals VARY per market (fusnstETH SY = 20). For SY we surface raw
  // wei + the count digits so an observer can trivially eyeball the order
  // of magnitude without misinterpretation.
  const fmtLp = (bi: bigint) => {
    // 18-decimal fixed format
    const whole = bi / 10n ** 18n;
    const frac = bi % 10n ** 18n;
    const fracStr = frac.toString().padStart(18, "0").slice(0, 4); // 4 dp
    return `${whole}.${fracStr}`;
  };
  const depth = `LP=${fmtLp(v.totalLpWei)} PT=${fmtLp(v.totalPtWei)} SY-wei=${v.totalSyWei}`;

  if (warnings.length > 0) {
    return `[chain-truth ⚠] ${warnings.join("; ")} | expiry=${expiryIso} | ${depth} | block ${v.blockRead}`;
  }
  return `[chain-truth ✓] expiry=${expiryIso} | isExpired=${v.isExpired} | ${depth} | block ${v.blockRead}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProtocolVerifier strategy — generic dispatch entry point
// ─────────────────────────────────────────────────────────────────────────────
//
// All pendle-specific glue lives below this line. Engine.ts + metavault.ts
// consume `pendleVerifier` via the registry's `getVerifier("pendle")` — they
// never reference pendle-specific symbols directly. To add a new protocol,
// implement `ProtocolVerifier` in a sibling file and register it in
// verifier-registry.ts. No engine/tool edits required.

import type { ProtocolVerifier, VerifierResult } from "./verifier-types.js";
import type { TypedExternalPosition } from "./engine.js";

/**
 * Extract the Pendle market address + chainId from the API position shape.
 * Pendle V2 markets ARE the LP — `market.address === lp.address` — so we
 * key off market.address (more semantic than lp.address).
 *
 * Returns null when shape is malformed (positionKey contract: skip
 * verification, don't throw).
 */
function extractPendleMarket(
  position: TypedExternalPosition,
): { marketAddress: string; chainId: number; expirySec?: number } | null {
  const market = (position as { market?: { address?: unknown; maturity?: unknown } }).market;
  const chainId = (position as { chainId?: unknown }).chainId;
  if (
    !market ||
    typeof market.address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(market.address) ||
    typeof chainId !== "number" ||
    !Number.isInteger(chainId) ||
    chainId <= 0
  ) {
    return null;
  }
  const expirySec =
    typeof market.maturity === "number" && Number.isFinite(market.maturity)
      ? market.maturity
      : undefined;
  return { marketAddress: market.address.toLowerCase(), chainId, expirySec };
}

/**
 * Pendle verifier strategy. Implements `ProtocolVerifier` over
 * `verifyPendlePosition` + `formatPendleVerification`. The engine + tools
 * dispatch through this; the pendle-specific functions remain exported
 * for direct unit testing (pendle-verifier.test.ts) but are not consumed
 * from outside the protocols/ directory.
 */
export const pendleVerifier: ProtocolVerifier = {
  name: "pendle",

  positionKey(position) {
    const m = extractPendleMarket(position);
    if (m == null) return null;
    // Position key shape: `pendle:<chainId>:<marketAddress>`. ChainId is
    // included because the same market address could (in principle) collide
    // across chains — Pendle deploys per-chain markets via a factory, and
    // while CREATE2 makes collisions astronomically unlikely, the position
    // key is cheap to make collision-proof.
    return `pendle:${m.chainId}:${m.marketAddress}`;
  },

  async verify(position): Promise<VerifierResult> {
    const m = extractPendleMarket(position);
    if (m == null) {
      return {
        kind: "failed",
        protocol: "pendle",
        line: "[chain-truth ✗] pendle: missing or malformed market.address/chainId",
      };
    }
    const v = await verifyPendlePosition(m.marketAddress, m.chainId);
    const line = formatPendleVerification(v, m.expirySec);
    return {
      kind: v.kind === "ok" ? "ok" : "failed",
      protocol: "pendle",
      line,
      extra: v,
    };
  },
};
