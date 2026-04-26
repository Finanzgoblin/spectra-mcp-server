/**
 * chain-reads.ts — Theme A Phase 1 engine.
 *
 * Returns canonical on-chain state for a Spectra MetaVault's three-role topology:
 *   1. Safe Proxy (`metavault.address`) — Gnosis Safe holding underlying.
 *   2. infraVault (`metavault.infraVault`) — PRIMARY ERC-4626; `totalAssets()` ↔ `api.tvl.underlying`.
 *   3. secondaryVault (`metavault.vault`) — outer ERC-4626 wrapper around infraVault.
 *
 * Phase 1 ships the engine + decoders + the prohibition that
 * `secondaryVault.totalAssets` is wrapper-scope and MUST NOT be reconciled
 * directly against `api.tvl.underlying`. The wrapper-pattern signature
 * (`infraVault.balanceOf(secondaryVault) ≥ 99% of infraVault.totalSupply`) is
 * verified instead, with a `wrapper-signature-broken` warning when violated.
 *
 * Phase 2 will surface this state via `formatChainTruthFooter` (currently a stub
 * in src/formatters.ts; the type signature is frozen in Phase 1).
 *
 * Engine boundary: pure read layer. No writes. RPC failure degrades gracefully
 * to `rpc-all-failed` warnings with all-null reads — never throws at the tool
 * boundary. Block number always reported for reproducibility (PR0 invariant).
 *
 * Reuses Phase 0 exports from src/api.ts and src/config.ts:
 *   - `withRpcFallback` (multi-RPC retry; logs to console.error per failure).
 *   - `fetchBlockNumber` (best-effort eth_blockNumber).
 *   - `resolveRpcUrlsWithFallbacks` (chain → ordered RPC list).
 */

import {
  fetchBlockNumber,
  withRpcFallback,
} from "./api.js";
import {
  type ChainKey,
  FETCH_TIMEOUT_MS,
  resolveRpcUrlsWithFallbacks,
} from "./config.js";
import type {
  ChainReadInput,
  ChainReadWarning,
  InfraVaultState,
  MetaVaultChainState,
  ModifierAddresses,
  SafeSingletonId,
  SafeState,
  SecondaryVaultState,
  SpectraMetavault,
} from "./types.js";

// =============================================================================
// Errors
// =============================================================================

/**
 * Thrown by `pickWorkingRpc` when every RPC in the chain's fallback list fails.
 * Caller is `readMetaVaultChainState`, which catches and emits a single
 * `rpc-all-failed` warning paired with all-null reads.
 *
 * Failures are NOT silent: `withRpcFallback` already logs each per-RPC failure
 * to `console.error` (see src/api.ts:1366) — that's the audit trail. This error
 * is the structured tail-state that surfaces at the tool boundary.
 */
export class RpcAllFailedError extends Error {
  readonly chain: ChainKey;
  readonly attemptedUrls: string[];
  constructor(chain: ChainKey, attemptedUrls: string[], cause?: unknown) {
    super(`All RPCs failed for ${chain}: tried ${attemptedUrls.length} endpoint(s)`);
    this.name = "RpcAllFailedError";
    this.chain = chain;
    this.attemptedUrls = attemptedUrls;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

// =============================================================================
// Constants & registry
// =============================================================================

/**
 * Canonical Safe singleton implementations observed in production.
 * Spec §4: registry lives here. `safe-singleton-unknown` warning fires when
 * the masterCopy address falls outside this set; the warning's `nextProbe`
 * tells the operator to update this map.
 */
export const KNOWN_SAFE_SINGLETONS: Record<string, SafeSingletonId> = {
  "0x41675c099f32341bf84bfc5382af534df5c7461a": "safe-v1.4.1",
  "0xfb1bffc9d739b8d520daf37df666da4c687191ea": "safe-v1.3.0-l2",
  "0xd9db270c1b5e3bd161e8c8503c55ceabee709552": "safe-v1.3.0",
};

/**
 * Function selectors (first 4 bytes of keccak256(signature)).
 *
 * Verified against canonical EIPs / OpenZeppelin / Gnosis Safe contracts.
 * `Deposit` / `Withdraw` topics verified against ERC-4626 spec; `Transfer`
 * is the canonical ERC-20 topic.
 */
export const SELECTORS = {
  totalSupply: "0x18160ddd",
  totalAssets: "0x01e1d114",
  asset: "0x38d52e0f",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  balanceOf: "0x70a08231",
  owner: "0x8da5cb5b",
  paused: "0x5c975abb",
  masterCopy: "0xa619486e",
  // Phase 2 (spec BLOCKER #4) — ERC-4626 capacity reads.
  // keccak256("maxWithdraw(address)") = 0xce96cb77...
  // keccak256("maxRedeem(address)")   = 0xd905777e...
  // keccak256("previewRedeem(uint256)") = 0x4cdad506...
  maxWithdraw: "0xce96cb77",
  maxRedeem: "0xd905777e",
  previewRedeem: "0x4cdad506",
} as const;

// =============================================================================
// Decoders
// =============================================================================
// Pure functions. The contract semantics encoded here are LOAD-BEARING for the
// `pre-onboarding-state` heuristic in §6 (which uses `> 0n`, not `!== 0n`):
//   `decodeUint256('0x')` MUST return null (RPC failure or empty result).
//   `decodeUint256('0x0000...0000')` MUST return 0n (legitimate zero value).
// Mixing these collapses RPC failure into pre-onboarding signal — a real bug
// in v2 that round-2 N3 fixed. Don't re-collapse.

/**
 * Decode a 32-byte ABI-encoded uint256.
 * Returns null on empty/short input (cannot distinguish RPC failure from
 * genuine zero unless caller treats `null` as "unknown" and `0n` as "zero").
 */
export function decodeUint256(result: string | undefined | null): bigint | null {
  if (!result || result === "0x" || result.length !== 66) return null;
  try {
    return BigInt(result);
  } catch {
    return null;
  }
}

/**
 * Decode a 32-byte ABI-encoded address.
 *
 * ABI encoding pads a 20-byte address with 12 zero bytes on the left. Without
 * the upper-12-byte zero guard, malformed RPC responses (e.g. an oversized
 * uint256 that happens to be 32 bytes) would produce a syntactically-valid
 * but semantically-wrong address — silent corruption.
 *
 * Returns null when the upper 12 bytes are not all-zero (round-2 N5).
 */
export function decodeAddress(result: string | undefined | null): string | null {
  if (!result || result === "0x" || result.length !== 66) return null;
  // Upper-12-byte guard: ABI-padded addresses must have all-zero upper bytes.
  if (result.slice(2, 26) !== "000000000000000000000000") return null;
  return ("0x" + result.slice(26, 66)).toLowerCase();
}

/** Decode an ABI-encoded uint8 (e.g. ERC-20 `decimals()` return). */
export function decodeUint8(result: string | undefined | null): number | null {
  if (!result || result === "0x" || result.length !== 66) return null;
  try {
    const v = BigInt(result);
    if (v > 255n) return null;
    return Number(v);
  } catch {
    return null;
  }
}

/** Decode an ABI-encoded bool. */
export function decodeBool(result: string | undefined | null): boolean | null {
  if (!result || result === "0x" || result.length !== 66) return null;
  try {
    return BigInt(result) !== 0n;
  } catch {
    return null;
  }
}

/**
 * Decode a Solidity ABI-encoded `string` (offset → length → bytes layout).
 *
 * Length cap (round-2 D-Gap on decodeString): 1024 bytes. Adversarial RPCs
 * could otherwise return a length that triggers precision loss (Number cast
 * of length > 2^53) or pre-allocation DoS. 1024 is well above legitimate
 * `name()` / `symbol()` returns and below any pathological allocation.
 */
export function decodeString(result: string | undefined | null): string | null {
  if (!result || result === "0x" || result.length < 130) return null;
  try {
    const lenHex = result.slice(66, 130);
    const len = Number(BigInt("0x" + lenHex));
    if (len === 0) return null;
    if (len > 1024) return null;
    if (result.length < 130 + len * 2) return null;
    const dataHex = result.slice(130, 130 + len * 2);
    return Buffer.from(dataHex, "hex").toString("utf8");
  } catch {
    return null;
  }
}

// =============================================================================
// Bytecode signatures
// =============================================================================

/**
 * Detect a Gnosis Safe Proxy by exact bytecode shape.
 *
 * Production Safe Proxies are exactly 171 bytes (344 hex chars including 0x
 * prefix) and contain the masterCopy() selector "a619486e" embedded as a
 * literal — the constant the proxy delegates to for resolving the
 * implementation. Both conditions must hold.
 *
 * Dissolution: if Safe v1.5+ ships a different proxy bytecode, add a
 * length-tolerant variant. Until that happens, the exact match is the safer
 * signal.
 */
export function isSafeProxyBytecode(code: string | null | undefined): boolean {
  if (!code || code.length !== 344) return false;
  return code.toLowerCase().includes("a619486e");
}

// =============================================================================
// Reconciliation classifiers
// =============================================================================

/**
 * Classify the divergence between API-reported `tvl.underlying` and the
 * chain-side `infraVault.totalAssets()` (the load-bearing primary).
 *
 * Threshold calibration (round-2 N8):
 *   - 0.5% / 5% are baseline starting values.
 *   - First 30 days of production observations populate empirical floor.
 *   - Dissolution: if false-positive rate > 10% of dashboard renders over a
 *     rolling 7-day window, thresholds are wrong — recalibrate.
 *
 * `unverifiable` is returned (NOT silently 0) when either input is missing,
 * so consumers see "we couldn't compare" instead of "no divergence."
 */
export function classifyTvlDivergence(
  apiTvlUnderlying: number | undefined | null,
  chainTotalAssets: bigint | null,
  decimals: number,
): {
  code: "none" | "tvl-divergence-small" | "tvl-divergence-large" | "unverifiable";
  pct: number;
  apiValue: number;
  chainValue: number;
} {
  if (apiTvlUnderlying == null || chainTotalAssets == null) {
    return { code: "unverifiable", pct: 0, apiValue: apiTvlUnderlying ?? 0, chainValue: 0 };
  }
  const chainValue = Number(chainTotalAssets) / 10 ** decimals;
  const delta = Math.abs(chainValue - apiTvlUnderlying);
  const denom = Math.max(apiTvlUnderlying, 0.001);
  const pct = delta / denom;
  if (pct < 0.005 && delta < 0.001) {
    return { code: "none", pct, apiValue: apiTvlUnderlying, chainValue };
  }
  if (pct < 0.05) {
    return { code: "tvl-divergence-small", pct, apiValue: apiTvlUnderlying, chainValue };
  }
  return { code: "tvl-divergence-large", pct, apiValue: apiTvlUnderlying, chainValue };
}

/**
 * STAK-class detection: Spectra/DeFiLlama price feed has gone to zero while
 * the underlying chain state is healthy. The canonical scar this codebase was
 * forged through (SOUL.md "I trusted the API and didn't check the chain").
 */
export function detectPriceFeedZero(apiUnderlyingPriceUsd: number | undefined | null): boolean {
  return apiUnderlyingPriceUsd === 0;
}

/**
 * Verify the OQ-J wrapper-pattern signature: secondaryVault should hold ≥99%
 * of infraVault's totalSupply. We use a 50% threshold for the "broken" warning
 * because anything below half indicates a topological shift severe enough to
 * invalidate the secondaryVault role assumptions baked into this engine.
 *
 * Returns `false` when the signature is healthy or unverifiable (null inputs).
 * Returns `true` ONLY when both inputs are present and the signature is
 * conclusively broken — surfacing as `wrapper-signature-broken`.
 */
export function isWrapperSignatureBroken(
  infraVaultShareBalance: bigint | null,
  infraVaultTotalSupply: bigint | null,
): boolean {
  if (infraVaultShareBalance == null || infraVaultTotalSupply == null) return false;
  if (infraVaultTotalSupply === 0n) return false;
  return infraVaultShareBalance * 2n < infraVaultTotalSupply;
}

// =============================================================================
// Projection
// =============================================================================

/**
 * Project a `SpectraMetavault` (the live API shape) to the engine's
 * `ChainReadInput` slice. This is the seam the engine reads from — it lets
 * callers (tools, future drift tests) build the slice from any source while
 * keeping `chain-reads.ts` ignorant of the full API DTO.
 *
 * KNOWN_DROPPED_FIELDS (every field in `SpectraMetavault` either appears in
 * `ChainReadInput` or is intentionally dropped here):
 *   - chainId, name, symbol, decimals: identity, used by callers not engine
 *   - status, curator, metadata, multipliers: UI/business metadata
 *   - positions, epochs, bridge, externalPositions: per-position data (Theme E/D)
 *   - tvl, liveApy, avgApy30d, exchangeRate, price: rates/values for reconciliation,
 *       passed in separately at classification time
 *   - modules: module-whitelist data, NOT an on-chain state shape (Theme E)
 *
 * If a future API shape change adds a new field to SpectraMetavault that
 * carries an address the engine should read, add it here and to ChainReadInput.
 * A drift test (Phase 2 work) will assert this list stays exhaustive.
 */
export function projectChainReadInput(mv: SpectraMetavault): ChainReadInput {
  // Narrow `remote` to the modifier slice; we don't want unrelated fields
  // (e.g. cross-chain `address`, `modules`) flowing into the engine's input —
  // the engine reads modifier addresses only in Phase 1.
  const remote = mv.remote
    ? Object.fromEntries(
        Object.entries(mv.remote).map(([chainId, entry]) => [
          chainId,
          entry?.modifier ? { modifier: entry.modifier } : {},
        ]),
      )
    : undefined;
  return {
    address: mv.address,
    vault: mv.vault,
    infraVault: mv.infraVault,
    modifier: mv.modifier,
    remote,
    underlying: {
      address: mv.underlying.address,
      decimals: mv.underlying.decimals,
      symbol: mv.underlying.symbol,
    },
  };
}

// =============================================================================
// RPC plumbing — internals
// =============================================================================

interface RpcContext {
  url: string;
  fellBack: boolean;
  attemptedUrls: string[];
}

/**
 * Resolve a working RPC for `chain` by probing the chain's fallback list with
 * a cheap `eth_blockNumber` call. Returns the first URL that responds.
 *
 * Throws `RpcAllFailedError` ONLY when every URL fails. Caller catches and
 * emits a structured `rpc-all-failed` warning with all-null reads — Phase 1's
 * graceful-degradation contract (PR0).
 *
 * Why probe with eth_blockNumber instead of trusting `withRpcFallback`'s
 * per-call retry? The engine sends batched `eth_call` arrays; some RPCs reject
 * batches but accept singles. Probing first lets us pick a URL that's
 * operational at a low cost, then commit to it for the (possibly batched)
 * payload. The probe also gives us a block number for reproducibility without
 * a second round trip.
 */
export async function pickWorkingRpc(chain: ChainKey): Promise<RpcContext> {
  const rpcs = resolveRpcUrlsWithFallbacks(chain);
  if (rpcs.length === 0) {
    throw new RpcAllFailedError(chain, [], "no RPC URLs configured for chain");
  }

  let chosenIndex = -1;
  let lastError: unknown = null;

  try {
    await withRpcFallback(
      rpcs,
      async (rpcUrl) => {
        const block = await fetchBlockNumber(rpcUrl);
        if (block == null) {
          throw new Error(`eth_blockNumber returned null at ${rpcUrl}`);
        }
        chosenIndex = rpcs.indexOf(rpcUrl);
        return block;
      },
      `chain-reads bootstrap ${chain}`,
    );
  } catch (err) {
    lastError = err;
  }

  if (chosenIndex < 0) {
    throw new RpcAllFailedError(chain, rpcs, lastError);
  }

  return {
    url: rpcs[chosenIndex],
    fellBack: chosenIndex > 0,
    attemptedUrls: rpcs.slice(0, chosenIndex + 1),
  };
}

/** A single JSON-RPC call: method + params, indexed by caller for result lookup. */
interface RpcCall {
  method: string;
  params: unknown[];
}

interface RpcCallResult {
  result?: string;
  error?: { code?: number; message?: string };
}

/**
 * Send `calls` as a JSON-RPC batch (array body). Public RPCs cap batch size
 * at varying limits — we chunk to ≤10 per request and stitch results back in
 * order. If a chunk's response length is short of the request length, emit
 * `rpc-batch-truncated`; this catches silent truncation that would otherwise
 * propagate as null reads downstream.
 *
 * Failures are NOT silent: per-call errors land in the returned array (caller
 * inspects `result.error`). Network/HTTP failures throw, and the caller
 * decides whether to fall back.
 *
 * Round-2 N11: the response order is enforced via JSON-RPC `id` matching —
 * spec-compliant servers MAY return out of order, so we always sort by id.
 */
export async function ethBatchCall(
  rpcUrl: string,
  calls: RpcCall[],
  chunkSize = 10,
): Promise<{ results: RpcCallResult[]; truncated: boolean }> {
  if (calls.length === 0) return { results: [], truncated: false };
  if (chunkSize < 1) chunkSize = 1;

  const aggregated: RpcCallResult[] = new Array(calls.length).fill({});
  let truncated = false;

  for (let offset = 0; offset < calls.length; offset += chunkSize) {
    const slice = calls.slice(offset, offset + chunkSize);
    const body = slice.map((call, i) => ({
      jsonrpc: "2.0",
      id: offset + i,
      method: call.method,
      params: call.params,
    }));

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} at ${rpcUrl}`);

    const json = (await res.json()) as unknown;

    // Most RPCs return an array; some return a single object on a malformed
    // batch. Treat anything non-array as a hard error so the caller falls back.
    if (!Array.isArray(json)) {
      throw new Error(`RPC ${rpcUrl} returned non-array response to batch of ${slice.length}`);
    }

    const arr = json as Array<{ id?: number; result?: string; error?: { code?: number; message?: string } }>;
    if (arr.length < slice.length) truncated = true;

    for (const entry of arr) {
      if (typeof entry.id !== "number") continue;
      const idx = entry.id;
      if (idx < 0 || idx >= calls.length) continue;
      aggregated[idx] = {
        result: entry.result,
        error: entry.error,
      };
    }
  }

  return { results: aggregated, truncated };
}

/**
 * ABI-encode a `balanceOf(address)` calldata: selector + 32-byte zero-padded
 * address.
 */
function encodeBalanceOf(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return SELECTORS.balanceOf + clean.padStart(64, "0");
}

// =============================================================================
// Engine
// =============================================================================

/**
 * Read on-chain state for a Spectra MetaVault's three-role topology.
 *
 * Batch ordering (round-2 N10): Safe → infraVault → secondaryVault. Under
 * sequential-fallback partial-failure, the load-bearing primary (infraVault)
 * completes BEFORE the secondary; this lets reconciliation against
 * `api.tvl.underlying` succeed even when the secondaryVault block fails.
 *
 * Always-emitted `secondaryvault-reasoning-prohibited` info warning when the
 * secondaryVault block is read: the prohibition is in the type comment, but
 * the warning is the runtime version of the discipline. OQ-L tracks the
 * residual provenance gap; agents reason on `infraVault.totalAssets` only.
 *
 * Phase 2 (BLOCKER #4): adds `maxWithdraw(self)`, `maxRedeem(self)`,
 * `previewRedeem(1 share)` reads to the secondaryVault block. These are CAPACITY
 * metrics surfaced for LP-side risk reads — they do NOT propagate the
 * secondaryVault prohibition (capacity ≠ entitlement-vs-aggregate).
 */
export async function readMetaVaultChainState(
  chain: ChainKey,
  input: ChainReadInput,
): Promise<MetaVaultChainState> {
  const fetchedAt = Date.now();
  const warnings: ChainReadWarning[] = [];

  // Step 1: pick a working RPC. Fail-soft on RpcAllFailedError.
  let rpcCtx: RpcContext;
  try {
    rpcCtx = await pickWorkingRpc(chain);
  } catch (err) {
    if (err instanceof RpcAllFailedError) {
      return makeAllNullState(chain, input, err);
    }
    throw err;
  }

  if (rpcCtx.fellBack) {
    warnings.push({
      severity: "info",
      code: "rpc-fallback-used",
      detail: `primary RPC failed; succeeded on ${rpcCtx.url}`,
      nextProbe: "check primary RPC health if pattern persists for >24h; consider promoting a fallback to primary in CHAIN_RPC_URLS",
    });
  }

  // Step 2: capture block number (already retrieved during probe, but the
  // probe doesn't expose it; one extra round trip keeps the surface area
  // simple). Block 0 means the chain itself is unverifiable — treat as
  // RPC-degradation rather than throwing.
  const blockMaybe = await fetchBlockNumber(rpcCtx.url);
  const block = blockMaybe ?? 0;

  // Step 3: build the indexed call list. Indices are STABLE and load-bearing
  // for the result-extraction logic below — adding/removing a call shifts every
  // downstream index. The boundary comments mark each block.
  const hasInfraVault = !!input.infraVault && input.infraVault.length === 42;

  // Safe block: 4 calls (round-2 N13 added an extra totalAssets() probe at the
  // Safe address to detect role-inversion).
  // [0] eth_getCode at safe
  // [1] eth_call masterCopy()
  // [2] eth_call underlying.balanceOf(safe)
  // [3] eth_call totalAssets() at safe — for role-inversion detection
  const calls: RpcCall[] = [
    { method: "eth_getCode", params: [input.address, "latest"] },
    { method: "eth_call", params: [{ to: input.address, data: SELECTORS.masterCopy }, "latest"] },
    { method: "eth_call", params: [{ to: input.underlying.address, data: encodeBalanceOf(input.address) }, "latest"] },
    { method: "eth_call", params: [{ to: input.address, data: SELECTORS.totalAssets }, "latest"] },
  ];

  // infraVault block: 10 calls (after Safe per N10 ordering)
  let infraStart = -1;
  if (hasInfraVault) {
    infraStart = calls.length;
    calls.push(
      { method: "eth_getCode", params: [input.infraVault, "latest"] },
      { method: "eth_call", params: [{ to: input.infraVault, data: SELECTORS.totalAssets }, "latest"] },
      { method: "eth_call", params: [{ to: input.infraVault, data: SELECTORS.totalSupply }, "latest"] },
      { method: "eth_call", params: [{ to: input.infraVault, data: SELECTORS.asset }, "latest"] },
      { method: "eth_call", params: [{ to: input.infraVault, data: SELECTORS.decimals }, "latest"] },
      { method: "eth_call", params: [{ to: input.infraVault, data: SELECTORS.name }, "latest"] },
      { method: "eth_call", params: [{ to: input.infraVault, data: SELECTORS.symbol }, "latest"] },
      { method: "eth_call", params: [{ to: input.infraVault, data: SELECTORS.owner }, "latest"] },
      { method: "eth_call", params: [{ to: input.infraVault, data: SELECTORS.paused }, "latest"] },
      { method: "eth_call", params: [{ to: input.underlying.address, data: encodeBalanceOf(input.infraVault!) }, "latest"] },
    );
  }

  // secondaryVault block: 11 calls (was 8 in Phase 1; Phase 2 adds 3 capacity
  // reads per spec BLOCKER #4). No owner/paused — outer wrappers are
  // structurally lighter; agents shouldn't reason on this state per the
  // prohibition in SecondaryVaultState's type comment.
  //
  // Phase 2 additions (indices secondaryStart+8..+10): maxWithdraw(self),
  // maxRedeem(self), previewRedeem(1 share). The HOLDER argument for the first
  // two is the secondaryVault's OWN address — see SecondaryVaultState's type
  // comment for the spec-deviation rationale (no need to thread a caller EOA).
  // `previewRedeem` is called with `1 * 10^underlying.decimals` (one share's
  // worth) — note we use `underlying.decimals`, not the secondary's decimals,
  // because we don't yet know the secondary's decimals at call-build time and
  // wrapper conventionally matches underlying.
  const secondaryStart = calls.length;
  const oneShareForPreview =
    "0x" + (10n ** BigInt(input.underlying.decimals)).toString(16).padStart(64, "0");
  calls.push(
    { method: "eth_getCode", params: [input.vault, "latest"] },
    { method: "eth_call", params: [{ to: input.vault, data: SELECTORS.totalAssets }, "latest"] },
    { method: "eth_call", params: [{ to: input.vault, data: SELECTORS.totalSupply }, "latest"] },
    { method: "eth_call", params: [{ to: input.vault, data: SELECTORS.asset }, "latest"] },
    { method: "eth_call", params: [{ to: input.vault, data: SELECTORS.decimals }, "latest"] },
    { method: "eth_call", params: [{ to: input.vault, data: SELECTORS.name }, "latest"] },
    { method: "eth_call", params: [{ to: input.vault, data: SELECTORS.symbol }, "latest"] },
    { method: "eth_call", params: [{ to: input.underlying.address, data: encodeBalanceOf(input.vault) }, "latest"] },
    // Phase 2 capacity reads (BLOCKER #4)
    { method: "eth_call", params: [{ to: input.vault, data: SELECTORS.maxWithdraw + input.vault.toLowerCase().replace(/^0x/, "").padStart(64, "0") }, "latest"] },
    { method: "eth_call", params: [{ to: input.vault, data: SELECTORS.maxRedeem + input.vault.toLowerCase().replace(/^0x/, "").padStart(64, "0") }, "latest"] },
    { method: "eth_call", params: [{ to: input.vault, data: SELECTORS.previewRedeem + oneShareForPreview.replace(/^0x/, "") }, "latest"] },
  );

  // wrapper-signature read (last position): only meaningful when both vaults
  // are present.
  let wrapperSignatureIndex = -1;
  if (hasInfraVault) {
    wrapperSignatureIndex = calls.length;
    calls.push({
      method: "eth_call",
      params: [{ to: input.infraVault, data: encodeBalanceOf(input.vault) }, "latest"],
    });
  }

  // Step 4: execute the batch. Failure here = RPC degraded mid-flight.
  let results: RpcCallResult[];
  let truncated = false;
  try {
    const batchResult = await ethBatchCall(rpcCtx.url, calls, 10);
    results = batchResult.results;
    truncated = batchResult.truncated;
  } catch (err) {
    return makeAllNullState(
      chain,
      input,
      new RpcAllFailedError(chain, [rpcCtx.url], err),
      block,
      rpcCtx.url,
    );
  }

  if (truncated) {
    warnings.push({
      severity: "warn",
      code: "rpc-batch-truncated",
      detail: `RPC ${rpcCtx.url} returned fewer results than requested (${results.filter((r) => r.result !== undefined || r.error !== undefined).length}/${calls.length})`,
      nextProbe: `try a different RPC for ${chain}; current RPC may be silently truncating large batches — consider lowering chunkSize or using a paid endpoint`,
    });
  }

  // ---------------------------------------------------------------------------
  // Compose Safe state (indices 0..3 always present)
  // ---------------------------------------------------------------------------
  const safeCode = results[0]?.result ?? null;
  const safeBytecodePresent = !!safeCode && safeCode !== "0x";
  const safeBytecodeSize = safeCode && safeCode !== "0x" ? (safeCode.length - 2) / 2 : 0;
  const safeIsProxy = isSafeProxyBytecode(safeCode);
  const safeMasterCopy = decodeAddress(results[1]?.result);
  const safeSingletonKnown = safeMasterCopy ? KNOWN_SAFE_SINGLETONS[safeMasterCopy] ?? null : null;
  const safeAssetBalance = decodeUint256(results[2]?.result);
  const safeTotalAssetsAtAddress = decodeUint256(results[3]?.result);

  const safe: SafeState = {
    address: input.address,
    bytecodePresent: safeBytecodePresent,
    bytecodeSize: safeBytecodeSize,
    isSafeProxy: safeIsProxy,
    singleton: safeMasterCopy,
    singletonKnown: safeSingletonKnown,
    assetBalance: safeAssetBalance,
  };

  if (!safeBytecodePresent) {
    warnings.push({
      severity: "error",
      code: "safe-no-bytecode",
      detail: `metavault.address ${input.address} has no bytecode at block ${block}`,
      nextProbe: "API may be referencing an uninstantiated vault; verify on the chain's block explorer that the address was ever deployed",
    });
  } else if (!safeIsProxy) {
    warnings.push({
      severity: "warn",
      code: "safe-non-proxy",
      detail: `metavault.address ${input.address} bytecode does not match Safe Proxy pattern (size=${safeBytecodeSize}, masterCopy probe=${safeMasterCopy ?? "null"})`,
      nextProbe: "could be a custom multisig OR API field semantics changed; trace deployment txn on the block explorer",
    });
  }

  if (safeMasterCopy && !safeSingletonKnown) {
    warnings.push({
      severity: "info",
      code: "safe-singleton-unknown",
      detail: `Safe singleton ${safeMasterCopy} is not in KNOWN_SAFE_SINGLETONS`,
      nextProbe: "update KNOWN_SAFE_SINGLETONS in src/chain-reads.ts after verifying the implementation against Gnosis Safe canonical deployments",
    });
  }

  // Role-inversion detection (round-2 N13): if `metavault.address` (the Safe)
  // responds to ERC-4626 totalAssets() AND it doesn't look like a Safe Proxy,
  // the API field semantics may have flipped (`address` and `vault` swapped).
  // This is a structural safety stop — emit error and let the caller decide.
  if (safeBytecodePresent && !safeIsProxy && safeTotalAssetsAtAddress !== null) {
    warnings.push({
      severity: "error",
      code: "role-inversion-detected",
      detail: `metavault.address ${input.address} responds to totalAssets() (returned ${safeTotalAssetsAtAddress}) AND fails Safe Proxy bytecode check — Spectra API field semantics may have changed`,
      nextProbe: "halt further chain reasoning until investigated; verify against Spectra docs and recent vault deployments — `vault` and `address` may have been swapped",
    });
  }

  // ---------------------------------------------------------------------------
  // Compose infraVault state (only when input.infraVault present)
  // ---------------------------------------------------------------------------
  let infraVault: InfraVaultState | null = null;
  if (hasInfraVault) {
    const code = results[infraStart + 0]?.result ?? null;
    const bytecodePresent = !!code && code !== "0x";
    const bytecodeSize = code && code !== "0x" ? (code.length - 2) / 2 : 0;
    const totalAssets = decodeUint256(results[infraStart + 1]?.result);
    const totalSupply = decodeUint256(results[infraStart + 2]?.result);
    const asset = decodeAddress(results[infraStart + 3]?.result);
    const decimals = decodeUint8(results[infraStart + 4]?.result);
    const name = decodeString(results[infraStart + 5]?.result);
    const symbol = decodeString(results[infraStart + 6]?.result);
    const owner = decodeAddress(results[infraStart + 7]?.result);
    const paused = decodeBool(results[infraStart + 8]?.result);
    const selfAssetBalance = decodeUint256(results[infraStart + 9]?.result);

    infraVault = {
      address: input.infraVault!,
      bytecodePresent,
      bytecodeSize,
      totalAssets,
      totalSupply,
      asset,
      decimals,
      name,
      symbol,
      owner,
      paused,
      selfAssetBalance,
    };

    if (!bytecodePresent) {
      warnings.push({
        severity: "error",
        code: "infravault-no-bytecode",
        detail: `infraVault ${input.infraVault} has no bytecode at block ${block}`,
        nextProbe: "primary accounting source missing; treat all chain-side TVL claims as unverifiable until investigated",
      });
    }
    if (asset && asset.toLowerCase() !== input.underlying.address.toLowerCase()) {
      warnings.push({
        severity: "error",
        code: "asset-mismatch-infravault",
        detail: `infraVault.asset()=${asset} but input.underlying=${input.underlying.address}`,
        nextProbe: "vault corruption OR API field swap; verify via positions[0].underlying and the Spectra API response shape",
      });
    }
    if (owner && owner.toLowerCase() !== input.address.toLowerCase()) {
      warnings.push({
        severity: "warn",
        code: "owner-mismatch",
        detail: `infraVault.owner()=${owner} but Safe address=${input.address}`,
        nextProbe: "ownership transfer OR API drift; check transactionQueue for governance changes affecting infraVault ownership",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Compose secondaryVault state (always present)
  // ---------------------------------------------------------------------------
  const secCode = results[secondaryStart + 0]?.result ?? null;
  const secBytecodePresent = !!secCode && secCode !== "0x";
  const secBytecodeSize = secCode && secCode !== "0x" ? (secCode.length - 2) / 2 : 0;
  const secTotalAssets = decodeUint256(results[secondaryStart + 1]?.result);
  const secTotalSupply = decodeUint256(results[secondaryStart + 2]?.result);
  const secAsset = decodeAddress(results[secondaryStart + 3]?.result);
  const secDecimals = decodeUint8(results[secondaryStart + 4]?.result);
  const secName = decodeString(results[secondaryStart + 5]?.result);
  const secSymbol = decodeString(results[secondaryStart + 6]?.result);
  const secSelfAssetBalance = decodeUint256(results[secondaryStart + 7]?.result);
  // Phase 2: capacity reads (BLOCKER #4). Many implementations revert when
  // called by/for an address with zero shares — that surfaces as `result.error`
  // and `decodeUint256` returns null. The footer treats null as "unverifiable"
  // and skips the line; healthy capacity reads surface as a number.
  const secMaxWithdrawSelf = decodeUint256(results[secondaryStart + 8]?.result);
  const secMaxRedeemSelf = decodeUint256(results[secondaryStart + 9]?.result);
  const secPreviewRedeemOneShare = decodeUint256(results[secondaryStart + 10]?.result);
  const wrapperShareBalance =
    wrapperSignatureIndex >= 0 ? decodeUint256(results[wrapperSignatureIndex]?.result) : null;

  const secondaryVault: SecondaryVaultState = {
    address: input.vault,
    bytecodePresent: secBytecodePresent,
    bytecodeSize: secBytecodeSize,
    totalAssets: secTotalAssets,
    totalSupply: secTotalSupply,
    asset: secAsset,
    decimals: secDecimals,
    name: secName,
    symbol: secSymbol,
    selfAssetBalance: secSelfAssetBalance,
    infraVaultShareBalance: wrapperShareBalance,
    maxWithdrawSelf: secMaxWithdrawSelf,
    maxRedeemSelf: secMaxRedeemSelf,
    previewRedeemOneShare: secPreviewRedeemOneShare,
  };

  if (!secBytecodePresent) {
    warnings.push({
      severity: "warn",
      code: "secondaryvault-no-bytecode",
      detail: `secondaryVault ${input.vault} has no bytecode at block ${block}`,
      nextProbe: "outer wrapper missing; users have no entry point even though infraVault may still be functional — confirm deployment status",
    });
  }
  if (secAsset && secAsset.toLowerCase() !== input.underlying.address.toLowerCase()) {
    warnings.push({
      severity: "warn",
      code: "asset-mismatch-secondaryvault",
      detail: `secondaryVault.asset()=${secAsset} but input.underlying=${input.underlying.address}`,
      nextProbe: "wrapper asset mismatch — possible deprecated outer vault; check infraVault.asset for canonical truth",
    });
  }

  // Pre-onboarding heuristic (round-2 N3): the heuristic uses `> 0n` (NOT
  // `!== 0n`). `null !== 0n` is `true`, which would falsely fire pre-onboarding
  // when infraVault reads return null due to RPC partial failure. `null > 0n`
  // is `false` — RPC failure should NOT fire pre-onboarding signal.
  const isPreOnboarding =
    safeBytecodePresent &&
    secTotalSupply === 0n &&
    infraVault !== null &&
    infraVault.totalSupply !== null &&
    infraVault.totalSupply > 0n;

  if (isPreOnboarding) {
    warnings.push({
      severity: "info",
      code: "pre-onboarding-state",
      detail: "secondaryVault has 0 supply; infraVault populated. Vault is in pre-onboarding state.",
      nextProbe: "expected for HIDDEN vaults; cross-check api.status field — if status is VISIBLE, investigate why outer wrapper has no shares",
    });
  }

  // Accounting-state-zero (round-2 N3 sibling): all accounting contracts show
  // null/zero supply, and we already established Safe bytecode is present.
  // This is distinct from pre-onboarding (where infraVault has supply) and
  // distinct from rpc-all-failed (where the engine never got here).
  const isAccountingZero =
    safeBytecodePresent &&
    secTotalSupply === 0n &&
    (infraVault === null || infraVault.totalSupply === null || infraVault.totalSupply === 0n) &&
    !isPreOnboarding;

  if (isAccountingZero && hasInfraVault) {
    warnings.push({
      severity: "warn",
      code: "accounting-state-zero",
      detail: "all vault accounting contracts show null/zero supply — possible deployment failure or RPC partial outage",
      nextProbe: "trace the deployment txn for ownership transfer or revert; if deployment is healthy, retry chain reads with a different RPC",
    });
  }

  // Wrapper-signature check (OQ-J resolution).
  //
  // When pre-onboarding fires, the wrapper-signature is mechanically zero
  // (secondaryVault has no shares yet), and `wrapper-signature-broken` would
  // be redundant noise. Pre-onboarding is the more-informative finding;
  // suppress wrapper-signature-broken under that condition. The prohibition
  // info-warning is still useful as a runtime reminder when the engine has
  // read the secondaryVault block at all.
  if (
    secondaryVault.infraVaultShareBalance !== null &&
    infraVault?.totalSupply != null &&
    !isPreOnboarding
  ) {
    if (isWrapperSignatureBroken(secondaryVault.infraVaultShareBalance, infraVault.totalSupply)) {
      const pct =
        infraVault.totalSupply === 0n
          ? 0
          : Number((secondaryVault.infraVaultShareBalance * 10000n) / infraVault.totalSupply) / 100;
      warnings.push({
        severity: "warn",
        code: "wrapper-signature-broken",
        detail: `secondaryVault holds ${pct.toFixed(1)}% of infraVault shares — expected ≥99%`,
        nextProbe: "topology may have shifted; secondaryVault role assumptions invalid; revisit OQ-J trail in docs/onchain-metavault-verification-spec.md",
      });
    } else {
      // Always emit info reminder when the secondaryVault block was read AND
      // signature is healthy. The prohibition is type-comment-baked (see
      // SecondaryVaultState in src/types.ts) — this is the runtime echo.
      warnings.push({
        severity: "info",
        code: "secondaryvault-reasoning-prohibited",
        detail:
          "secondaryVault accounting is wrapper-scope; do not directly compare its totalAssets against infraVault or api.tvl.underlying",
        nextProbe:
          "OQ-L tracks the residual provenance gap; agents should reason on infraVault.totalAssets only. See spec §11.",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Modifiers (data-only — no on-chain reads in Phase 1)
  // ---------------------------------------------------------------------------
  const modifiers = projectModifierAddresses(input.modifier);
  const remoteModifiers: Record<string, ModifierAddresses> = {};
  if (input.remote) {
    for (const [chainId, entry] of Object.entries(input.remote)) {
      const projected = projectModifierAddresses(entry?.modifier);
      if (projected) {
        remoteModifiers[chainId] = projected;
        warnings.push({
          severity: "info",
          code: "remote-modifier-detected",
          detail: `vault has cross-chain governance on chainId ${chainId}`,
          nextProbe: `check remote.${chainId}.modifier reads if audit context demands cross-chain governance verification (Phase 1: data-only capture)`,
        });
      }
    }
  }

  return {
    chain,
    block,
    rpcUsed: rpcCtx.url,
    fetchedAt,
    safe,
    infraVault,
    secondaryVault,
    modifiers,
    remoteModifiers,
    warnings,
  };
}

// =============================================================================
// Curator-tempo cache (Phase 2, spec BLOCKER #7 / OQ-E promoted)
// =============================================================================
//
// Curators look at dashboards every few minutes; the chain block hasn't moved
// meaningfully (mainnet ~12s/block, Base ~2s/block) but the RPC bill compounds
// fast. A 5-minute TTL is the curator-tempo sweet spot: stale-tolerant for
// human consumption, fresh enough that a new audit signal surfaces within a
// session.
//
// Key shape: `{chain}:{vault.address}:{block}` — scoped to the input we
// actually batched against. Block is included so different consumers asking
// for different blocks don't collide.
//
// Cache only applies to the implicit "latest" read path (Phase 2 default). If
// historical-block reads are added later, those should be cached forever (block
// is final) — but Phase 2 only exposes "latest" so we don't yet need that
// branch. Dissolution: if Phase 5 adds historical reads, split this into two
// caches with distinct TTL policies.
//
// Failures NOT silent: cache misses + RPC failures still log to `console.error`
// via `withRpcFallback` upstream.

const CHAIN_TRUTH_TTL_MS = 5 * 60 * 1000; // 5 minutes — see header comment

interface CacheEntry {
  /** Wall-clock ms when this entry was stored. */
  storedAt: number;
  /** The cached state (a frozen MetaVaultChainState). */
  state: MetaVaultChainState;
}

/**
 * Bounded LRU cache for chain-truth reads. The size cap prevents unbounded
 * growth in long-running processes; it's generous (50 entries) since each
 * entry is small (~3 KB) and eviction is O(1) amortized.
 *
 * `Map` preserves insertion order, so the LRU eviction loop drops the
 * oldest-inserted entry when we exceed the cap.
 */
const CHAIN_TRUTH_CACHE = new Map<string, CacheEntry>();
const CHAIN_TRUTH_CACHE_MAX = 50;

function cacheKey(chain: ChainKey, vaultAddress: string, block: number | "latest"): string {
  return `${chain}:${vaultAddress.toLowerCase()}:${block}`;
}

/**
 * Read MetaVault chain state with a 5-minute curator-tempo cache.
 *
 * Cache hit ⇒ return cached state, no RPC. Cache miss ⇒ run the engine, store,
 * return. `forceRefresh: true` bypasses the cache and re-runs.
 *
 * The cache is keyed on `(chain, vault, block)`. Because Phase 2 only exposes
 * "latest" reads, the block tag is the literal string "latest" and the TTL is
 * what gates staleness. When the engine runs, it returns a concrete block
 * number — but we deliberately don't re-key by that, because the next request
 * with the same input/timestamp would also be `latest` and we want it to hit
 * the cache.
 *
 * Spec line: BLOCKER #7 (D-Curator1, OQ-E promoted from Phase 5 to Phase 2).
 */
export async function readMetaVaultChainStateCached(
  chain: ChainKey,
  input: ChainReadInput,
  opts: { forceRefresh?: boolean } = {},
): Promise<MetaVaultChainState> {
  const key = cacheKey(chain, input.vault, "latest");
  const now = Date.now();

  if (!opts.forceRefresh) {
    const hit = CHAIN_TRUTH_CACHE.get(key);
    if (hit && now - hit.storedAt < CHAIN_TRUTH_TTL_MS) {
      // LRU touch: re-insert to move to most-recent.
      CHAIN_TRUTH_CACHE.delete(key);
      CHAIN_TRUTH_CACHE.set(key, hit);
      return hit.state;
    }
  }

  // Cache miss (or expired, or forced refresh).
  const state = await readMetaVaultChainState(chain, input);

  // Don't cache hard-failed reads; the next caller deserves a retry.
  const allFailed = state.warnings.some((w) => w.code === "rpc-all-failed");
  if (!allFailed) {
    CHAIN_TRUTH_CACHE.set(key, { storedAt: now, state });
    // LRU eviction: drop oldest until we're at cap.
    while (CHAIN_TRUTH_CACHE.size > CHAIN_TRUTH_CACHE_MAX) {
      const firstKey = CHAIN_TRUTH_CACHE.keys().next().value;
      if (firstKey === undefined) break;
      CHAIN_TRUTH_CACHE.delete(firstKey);
    }
  }

  return state;
}

/** Test-only: clear the cache. Production code should never call this. */
export function _clearChainTruthCacheForTest(): void {
  CHAIN_TRUTH_CACHE.clear();
}

/** Test-only: inspect cache size. */
export function _chainTruthCacheSizeForTest(): number {
  return CHAIN_TRUTH_CACHE.size;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * The graceful-degradation tail: every RPC failed (or the batch threw mid-
 * flight). Returns a state with all-null reads and a single `rpc-all-failed`
 * warning carrying the full audit trail in `attemptedUrls`.
 *
 * `block` and `rpcUsed` are passed in when we got far enough to know them
 * (mid-flight failure); otherwise `0` and `""` signal they were unverifiable.
 */
function makeAllNullState(
  chain: ChainKey,
  input: ChainReadInput,
  err: RpcAllFailedError,
  block = 0,
  rpcUsed = "",
): MetaVaultChainState {
  return {
    chain,
    block,
    rpcUsed,
    fetchedAt: Date.now(),
    safe: {
      address: input.address,
      bytecodePresent: false,
      bytecodeSize: 0,
      isSafeProxy: false,
      singleton: null,
      singletonKnown: null,
      assetBalance: null,
    },
    infraVault: null,
    secondaryVault: null,
    modifiers: null,
    remoteModifiers: {},
    warnings: [
      {
        severity: "error",
        code: "rpc-all-failed",
        detail: `all RPCs failed for ${chain}: ${err.message} (tried ${err.attemptedUrls.length} endpoint(s))`,
        nextProbe: `use a premium RPC (Alchemy, Infura) for chain ${chain}; chain-reads degraded for the dashboard render. Failed URLs: ${err.attemptedUrls.join(", ") || "(none configured)"}`,
      },
    ],
  };
}

/** Project the live API modifier shape (free-form record) onto the engine's
 *  fixed-shape view. Keeps roles.{default,pool,swap} explicit so consumers can
 *  type-check; everything else stays accessible via the original input. */
function projectModifierAddresses(
  m: ChainReadInput["modifier"] | undefined,
): ModifierAddresses | null {
  if (!m) return null;
  const roles = m.roles ?? {};
  const delay = m.delay ?? {};
  const result: ModifierAddresses = {
    rolesDefault: typeof roles.default === "string" ? roles.default : null,
    rolesPool: typeof roles.pool === "string" ? roles.pool : null,
    rolesSwap: typeof roles.swap === "string" ? roles.swap : null,
    delayDefault: typeof delay.default === "string" ? delay.default : null,
  };
  // If every projected slot is null AND there are no other keys, treat as empty.
  if (
    !result.rolesDefault &&
    !result.rolesPool &&
    !result.rolesSwap &&
    !result.delayDefault &&
    Object.keys(roles).length === 0 &&
    Object.keys(delay).length === 0
  ) {
    return null;
  }
  return result;
}
