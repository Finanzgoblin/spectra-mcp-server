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
  type RawEventLog,
  fetchBlockNumber,
  fetchLogs,
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
  MetaVaultEventResult,
  ModifierAddresses,
  ParsedDepositEvent,
  ParsedTransferEvent,
  ParsedWithdrawEvent,
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
  // Phase 3 — event topic0 hashes (verified against ERC-4626 EIP / ERC-20).
  // These are full 32-byte keccak256 hashes (not 4-byte selectors), so they
  // sit in `topics[0]` of an emitted log. Co-located here for one place to
  // grep when audit asks "what does the engine match against?"
  // keccak256("Deposit(address,address,uint256,uint256)")
  DepositTopic:  "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7",
  // keccak256("Withdraw(address,address,address,uint256,uint256)")
  WithdrawTopic: "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db",
  // keccak256("Transfer(address,address,uint256)")
  TransferTopic: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
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
 * Price feed outage detection: the upstream API has reported `price.usd === 0`
 * while chain state is healthy. Renders to a "Price feed outage" warning in
 * the chain-truth footer; tvl.underlying remains trustworthy from chain even
 * when tvl.usd collapses with the feed.
 *
 * Anchor: SOUL.md STAK incident — "I trusted the API and didn't check the
 * chain. The DeFiLlama price feed is down."
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
  const secPreviewRedeemBatch1 = decodeUint256(results[secondaryStart + 10]?.result);
  const wrapperShareBalance =
    wrapperSignatureIndex >= 0 ? decodeUint256(results[wrapperSignatureIndex]?.result) : null;

  // ===========================================================================
  // Decimals-aware previewRedeem retry (correctness fix)
  //
  // Batch 1 sent `previewRedeem(1 * 10^underlying.decimals)`. This is correct
  // ONLY when the wrapper's share-decimals equal underlying decimals — true for
  // all 6 currently-deployed Spectra MetaVaults (verified empirically). For a
  // future MetaVault with non-matching decimals, the batch-1 input is
  // wrong-magnitude and the result is meaningless. The cross-check in
  // formatters.ts would then either trivially "agree" (both wrong in the same
  // direction) or always fire the disagreement suffix.
  //
  // Three branches:
  //   (a) secDecimals == underlying.decimals  → batch-1 result is correct, use as-is
  //   (b) secDecimals != underlying.decimals  → retry previewRedeem with 1 * 10^secDecimals; emit `wrapper-decimals-divergence`
  //   (c) secDecimals == null but bytecode present → suppress; emit `wrapper-decimals-unknown`
  //
  // Cost: zero extra round-trips in branch (a). One extra eth_call only when
  // wrapper decimals diverge — which is rare today, but the fix keeps the
  // cross-check meaningful for future divergent wrappers.
  //
  // Dissolution: if Spectra publishes a MetaVault contract ABI with deterministic
  // decimals semantics, this branch logic becomes redundant and the read can
  // collapse back into batch 1.
  // ===========================================================================
  let secPreviewFinal: bigint | null = secPreviewRedeemBatch1;
  if (secBytecodePresent) {
    if (secDecimals === null) {
      // (c) bytecode exists but decimals() failed to decode — input scale unverifiable
      secPreviewFinal = null;
      warnings.push({
        severity: "info",
        code: "wrapper-decimals-unknown",
        detail: `secondaryVault ${input.vault} has bytecode but decimals() did not decode at block ${block} — previewRedeemOneShare suppressed`,
        nextProbe:
          "verify the wrapper exposes ERC-20 decimals(); if it does, the RPC may have truncated this read — retry on a different RPC",
      });
    } else if (secDecimals !== input.underlying.decimals) {
      // (b) divergent decimals — retry previewRedeem with correct share-decimals
      const oneShareInShareDecimals =
        "0x" + (10n ** BigInt(secDecimals)).toString(16).padStart(64, "0");
      const data =
        SELECTORS.previewRedeem + oneShareInShareDecimals.replace(/^0x/, "");
      try {
        const retryBatch = await ethBatchCall(
          rpcCtx.url,
          [{ method: "eth_call", params: [{ to: input.vault, data }, "latest"] }],
          10,
        );
        secPreviewFinal = decodeUint256(retryBatch.results[0]?.result);
      } catch {
        // Single-call retry failed — graceful degradation (cross-check skipped)
        secPreviewFinal = null;
      }
      warnings.push({
        severity: "warn",
        code: "wrapper-decimals-divergence",
        detail: `secondaryVault decimals=${secDecimals}, underlying decimals=${input.underlying.decimals} — previewRedeem reconstructed with share-decimals; per-share render must scale by share-decimals not underlying-decimals`,
        nextProbe:
          "wrapper convention diverges from underlying decimals — verify intentional; if unintentional, the topology may have shifted (audit the wrapper deployment)",
      });
    }
    // (a) implicit: secDecimals === input.underlying.decimals → keep batch-1 result
  }

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
    previewRedeemOneShare: secPreviewFinal,
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
// Phase 3 — event decoders (ERC-4626 Deposit/Withdraw, ERC-20 Transfer)
// =============================================================================
//
// Each decoder returns null on malformed input. The orchestrator filters nulls
// and emits a single `event-decode-failed` info-warning when ≥1 log was
// dropped — silent corruption is the failure mode these checks guard against.
// The constraints encoded:
//   - topics[0] must match the expected event hash (caller is supposed to have
//     filtered, but we re-check defensively).
//   - indexed-arg count: Deposit=2, Withdraw=3, Transfer=2.
//   - data block length: ABI-encoded uint256 args at exactly 32 bytes each.
//
// Why pure functions: the decoders are exported for unit testing, and they
// don't need RPC context. The engine orchestrates the eth_getLogs calls and
// hands raw logs in; everything in this section operates on already-fetched
// data.

const HEX_RE_64 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Extract an indexed-arg address from a topic word (32-byte left-padded
 * address). Reuses `decodeAddress` so the upper-12-byte zero guard applies —
 * if the topic is not a clean ABI-encoded address, return null.
 */
function decodeAddressTopic(topic: string | undefined | null): string | null {
  if (!topic || !HEX_RE_64.test(topic)) return null;
  return decodeAddress(topic);
}

/**
 * Read a 32-byte uint256 word from `data` starting at `byteOffset`. Returns
 * null on out-of-bounds or malformed hex. `data` is the full data block
 * including the `0x` prefix.
 */
function readUint256At(data: string | undefined | null, byteOffset: number): bigint | null {
  if (!data || !data.startsWith("0x")) return null;
  const start = 2 + byteOffset * 2;
  const end = start + 64;
  if (data.length < end) return null;
  const word = "0x" + data.slice(start, end);
  return decodeUint256(word);
}

/** Decode an ERC-4626 `Deposit(address sender, address owner, uint256 assets, uint256 shares)` log.
 *  - topics[0] = DepositTopic
 *  - topics[1] = sender (indexed)
 *  - topics[2] = owner (indexed)
 *  - data = (assets || shares), 64 bytes total. */
export function decodeDepositLog(log: RawEventLog): ParsedDepositEvent | null {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 3) return null;
  if (log.topics[0]?.toLowerCase() !== SELECTORS.DepositTopic) return null;
  const sender = decodeAddressTopic(log.topics[1]);
  const owner = decodeAddressTopic(log.topics[2]);
  if (!sender || !owner) return null;
  const assets = readUint256At(log.data, 0);
  const shares = readUint256At(log.data, 32);
  if (assets === null || shares === null) return null;
  let blockNumber: number;
  let logIndex: number;
  try {
    blockNumber = Number(BigInt(log.blockNumber));
    logIndex = Number(BigInt(log.logIndex));
  } catch {
    return null;
  }
  return {
    sender,
    owner,
    assets,
    shares,
    blockNumber,
    transactionHash: log.transactionHash,
    logIndex,
  };
}

/** Decode an ERC-4626 `Withdraw(address sender, address receiver, address owner, uint256 assets, uint256 shares)` log.
 *  - topics[0] = WithdrawTopic
 *  - topics[1] = sender (indexed)
 *  - topics[2] = receiver (indexed)
 *  - topics[3] = owner (indexed)
 *  - data = (assets || shares), 64 bytes total. */
export function decodeWithdrawLog(log: RawEventLog): ParsedWithdrawEvent | null {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 4) return null;
  if (log.topics[0]?.toLowerCase() !== SELECTORS.WithdrawTopic) return null;
  const sender = decodeAddressTopic(log.topics[1]);
  const receiver = decodeAddressTopic(log.topics[2]);
  const owner = decodeAddressTopic(log.topics[3]);
  if (!sender || !receiver || !owner) return null;
  const assets = readUint256At(log.data, 0);
  const shares = readUint256At(log.data, 32);
  if (assets === null || shares === null) return null;
  let blockNumber: number;
  let logIndex: number;
  try {
    blockNumber = Number(BigInt(log.blockNumber));
    logIndex = Number(BigInt(log.logIndex));
  } catch {
    return null;
  }
  return {
    sender,
    receiver,
    owner,
    assets,
    shares,
    blockNumber,
    transactionHash: log.transactionHash,
    logIndex,
  };
}

/** Decode an ERC-20 `Transfer(address from, address to, uint256 value)` log.
 *  - topics[0] = TransferTopic
 *  - topics[1] = from (indexed)
 *  - topics[2] = to (indexed)
 *  - data = value (32 bytes). */
export function decodeTransferLog(
  log: RawEventLog,
  tokenAddress: string,
): ParsedTransferEvent | null {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 3) return null;
  if (log.topics[0]?.toLowerCase() !== SELECTORS.TransferTopic) return null;
  const from = decodeAddressTopic(log.topics[1]);
  const to = decodeAddressTopic(log.topics[2]);
  if (!from || !to) return null;
  const value = readUint256At(log.data, 0);
  if (value === null) return null;
  let blockNumber: number;
  let logIndex: number;
  try {
    blockNumber = Number(BigInt(log.blockNumber));
    logIndex = Number(BigInt(log.logIndex));
  } catch {
    return null;
  }
  return {
    from,
    to,
    value,
    blockNumber,
    transactionHash: log.transactionHash,
    logIndex,
    tokenAddress: tokenAddress.toLowerCase(),
  };
}

// =============================================================================
// Phase 3 — readMetaVaultEvents
// =============================================================================
//
// Two parallel event traces: ERC-4626 Deposit/Withdraw on the share-emitting
// vault (infraVault primary, fall back to vault when no infraVault), and
// ERC-20 Transfer on the underlying where the Safe is `from` or `to`.
//
// Address-targeted filtering for the Safe trace uses topics[1] (`from`) and
// topics[2] (`to`) in two separate `eth_getLogs` calls. This is the cheap-RPC
// path: the RPC does the filtering server-side and we only transfer matching
// logs. Without it, fetching all Transfer events of a hot stablecoin across a
// 500K block range would be unworkable.
//
// Block range cap: 500K (matches `spectra_get_onchain_activity` cap and
// existing `MAX_TOTAL_BLOCK_RANGE` in src/tools/onchain.ts). Exceeding the cap
// emits `block-range-too-large` and the engine clamps `effectiveTo` to
// `fromBlock + 500_000` — graceful degradation, NEVER throws. The caller sees
// what was actually scanned in `result.toBlock`.
//
// Failures NOT silent: per-RPC errors land in `console.error` via
// `withRpcFallback`; per-chunk errors land in `console.error` inside
// `fetchLogs` (existing behavior). Unrecoverable cases (no RPC reachable for
// blockNumber probe) emit `rpc-all-failed` and return empty arrays — same
// graceful-degradation contract as `readMetaVaultChainState`.
//
// Empty result is valid: zero events in the range returns empty arrays + zero
// warnings (besides any rpc-fallback-used info). Don't confuse "nothing
// happened in this range" with "something went wrong."

/** Maximum block range per call (matches src/tools/onchain.ts MAX_TOTAL_BLOCK_RANGE). */
const MAX_EVENT_BLOCK_RANGE = 500_000;

/** Pad an EVM address to a 32-byte topic word (lowercase, zero-padded left). */
function addressToTopic(address: string): string {
  return "0x" + "0".repeat(24) + address.toLowerCase().replace(/^0x/, "");
}

/**
 * Phase 3 — fetch decoded ERC-4626 Deposit/Withdraw + ERC-20 Safe Transfer
 * events for a MetaVault.
 *
 * Targets the `infraVault` for share events when present (the primary
 * aggregate; spec PR2). Falls back to `vault` (secondaryVault) when no
 * infraVault is supplied — that's the wrapper, but it's the only ERC-4626
 * surface we have to look at.
 *
 * The Safe-side trace queries `Transfer` events on the underlying token
 * filtered by `topics[1] = padded(safe)` (from-side) and `topics[2] = padded(safe)`
 * (to-side) in two separate calls. Results are merged + sorted by (block, logIndex).
 *
 * Failure modes:
 *   - RPC bootstrap fails (no URL responds to `eth_blockNumber`) → returns
 *     empty arrays + a single `rpc-all-failed` warning.
 *   - Range exceeds 500K → clamps `toBlock` to `fromBlock + 500K`, emits
 *     `block-range-too-large`, continues with the clamped range.
 *   - Per-chunk eth_getLogs fails → logged to `console.error` by the existing
 *     `fetchLogs` helper; the chunk is skipped, partial results returned.
 *     No engine-level warning is emitted for that — `fetchLogs` is the audit
 *     trail here (it logs the failed block range with a chain explorer-friendly
 *     message). Adding a duplicate warning would be noise.
 *   - Decoders drop ≥1 malformed log → emits `event-decode-failed` info.
 */
export async function readMetaVaultEvents(
  chain: ChainKey,
  addresses: ChainReadInput,
  fromBlock: number,
  toBlock: number,
): Promise<MetaVaultEventResult> {
  const warnings: ChainReadWarning[] = [];

  // Resolve a working RPC up front. Same fail-soft contract as the state
  // engine: if every URL fails, return an empty result with rpc-all-failed.
  let rpcCtx: RpcContext;
  try {
    rpcCtx = await pickWorkingRpc(chain);
  } catch (err) {
    if (err instanceof RpcAllFailedError) {
      return makeAllNullEventResult(chain, addresses, fromBlock, toBlock, err);
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

  // Range-cap clamping. The cap is a graceful-degradation knob, not an error
  // — clamp + warn so the caller sees what was actually scanned.
  let effectiveTo = toBlock;
  if (toBlock > fromBlock && toBlock - fromBlock > MAX_EVENT_BLOCK_RANGE) {
    effectiveTo = fromBlock + MAX_EVENT_BLOCK_RANGE;
    warnings.push({
      severity: "warn",
      code: "block-range-too-large",
      detail: `requested ${toBlock - fromBlock} blocks exceeds ${MAX_EVENT_BLOCK_RANGE}-block cap; scanning ${fromBlock}..${effectiveTo}`,
      nextProbe: `re-call with a narrower window or paginate (current cap matches src/tools/onchain.ts MAX_TOTAL_BLOCK_RANGE)`,
    });
  }

  // Target for share events: prefer infraVault (primary aggregate). Fall back
  // to `vault` (secondaryVault) when no infraVault is supplied — it's a
  // wrapper, but it's the only surface we have. The share semantics differ
  // between layers, so emit an in-band info warning when the fallback fires
  // — `shareTokenAddress` alone is a passive signal a hurried consumer would
  // miss. Round-3 audit (Sonnet Bug 2 + Diverger SG-3 convergence).
  const hasInfraVault = !!addresses.infraVault && addresses.infraVault.length === 42;
  const shareTokenAddress = hasInfraVault ? addresses.infraVault! : addresses.vault;
  if (!hasInfraVault) {
    warnings.push({
      severity: "info",
      code: "share-events-fallback",
      detail: `infraVault not supplied; scanning vault (${addresses.vault}) for share events. Share semantics are wrapper-scope, not primary aggregate.`,
      nextProbe:
        "verify the upstream API populated `metavault.infraVault` for this vault — if absent intentionally (legacy topology), this warning is informational",
    });
  }
  const safeAddressPadded = addressToTopic(addresses.address);

  // Three eth_getLogs calls in parallel: Deposit-on-share, Withdraw-on-share,
  // Transfer-from-Safe, Transfer-to-Safe. The first two are at the share
  // token; the latter two are at the underlying (Safe is the indexed counter-
  // party). All four use `fetchLogs` — which already chunks at 2K blocks per
  // request internally and aggregates.
  const depositTopics: (string | string[] | null)[] = [SELECTORS.DepositTopic];
  const withdrawTopics: (string | string[] | null)[] = [SELECTORS.WithdrawTopic];
  const transferFromTopics: (string | string[] | null)[] = [
    SELECTORS.TransferTopic,
    safeAddressPadded,
  ];
  const transferToTopics: (string | string[] | null)[] = [
    SELECTORS.TransferTopic,
    null,
    safeAddressPadded,
  ];

  let depositRaw: RawEventLog[] = [];
  let withdrawRaw: RawEventLog[] = [];
  let transferFromRaw: RawEventLog[] = [];
  let transferToRaw: RawEventLog[] = [];

  try {
    const [d, w, tFrom, tTo] = await Promise.all([
      fetchLogs(rpcCtx.url, shareTokenAddress, depositTopics, fromBlock, effectiveTo),
      fetchLogs(rpcCtx.url, shareTokenAddress, withdrawTopics, fromBlock, effectiveTo),
      fetchLogs(rpcCtx.url, addresses.underlying.address, transferFromTopics, fromBlock, effectiveTo),
      fetchLogs(rpcCtx.url, addresses.underlying.address, transferToTopics, fromBlock, effectiveTo),
    ]);
    depositRaw = d[0];
    withdrawRaw = w[0];
    transferFromRaw = tFrom[0];
    transferToRaw = tTo[0];

    // Partial-coverage detection (round-3 audit S1 — STAK-class scar repeats).
    // `fetchLogs` returns `[allLogs, chunksSucceeded, chunksTotal]`; if any
    // chunk failed mid-scan, the result silently misses events from that
    // chunk's block window. A consumer reconciling deposits would see "no
    // deposits" on a vault that had them. The lesson Phase 2 taught about API
    // success ≠ chain truth applies here: chunk success ≠ complete coverage.
    const partialCoverage: Array<{ stream: string; ok: number; total: number }> = [];
    if (d[1] < d[2]) partialCoverage.push({ stream: "Deposit", ok: d[1], total: d[2] });
    if (w[1] < w[2]) partialCoverage.push({ stream: "Withdraw", ok: w[1], total: w[2] });
    if (tFrom[1] < tFrom[2]) partialCoverage.push({ stream: "Transfer (from-Safe)", ok: tFrom[1], total: tFrom[2] });
    if (tTo[1] < tTo[2]) partialCoverage.push({ stream: "Transfer (to-Safe)", ok: tTo[1], total: tTo[2] });
    if (partialCoverage.length > 0) {
      const detail = partialCoverage
        .map((p) => `${p.stream}: ${p.ok}/${p.total} chunks`)
        .join(", ");
      warnings.push({
        severity: "warn",
        code: "logs-partial-coverage",
        detail: `eth_getLogs partial coverage — ${detail}. Returned events may be incomplete.`,
        nextProbe:
          "narrow the block range to a smaller window, OR retry with a more reliable RPC. Treat 'no events' as 'unknown coverage' until the partial-coverage warning clears.",
      });
    }
  } catch (err) {
    // Whole-batch failure (network drop mid-flight). `fetchLogs` itself is
    // best-effort per-chunk, so reaching this branch implies a hard error
    // outside its retry envelope. Surface as rpc-all-failed and return empty.
    return makeAllNullEventResult(
      chain,
      addresses,
      fromBlock,
      effectiveTo,
      new RpcAllFailedError(chain, [rpcCtx.url], err),
    );
  }

  // Decode + drop nulls. Track decode-fail count so we can emit a single
  // info-warning if anything was dropped.
  let decodeFailures = 0;

  const depositEvents: ParsedDepositEvent[] = [];
  for (const raw of depositRaw) {
    const parsed = decodeDepositLog(raw);
    if (parsed) depositEvents.push(parsed);
    else decodeFailures++;
  }

  const withdrawEvents: ParsedWithdrawEvent[] = [];
  for (const raw of withdrawRaw) {
    const parsed = decodeWithdrawLog(raw);
    if (parsed) withdrawEvents.push(parsed);
    else decodeFailures++;
  }

  // Merge from-side + to-side Transfer logs, dedup by (txHash, logIndex) in
  // case the Safe self-transferred (rare but possible — same log would match
  // both filters). Sort ascending by (block, logIndex).
  const transferEventsRaw = [...transferFromRaw, ...transferToRaw];
  const seen = new Set<string>();
  const safeTransferEvents: ParsedTransferEvent[] = [];
  for (const raw of transferEventsRaw) {
    const parsed = decodeTransferLog(raw, addresses.underlying.address);
    if (!parsed) {
      decodeFailures++;
      continue;
    }
    const key = `${parsed.transactionHash}:${parsed.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    safeTransferEvents.push(parsed);
  }
  safeTransferEvents.sort((a, b) =>
    a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
  );

  if (decodeFailures > 0) {
    warnings.push({
      severity: "info",
      code: "event-decode-failed",
      detail: `${decodeFailures} raw log(s) failed to decode and were skipped (malformed topic count, hex, or ABI layout)`,
      nextProbe: `inspect the failed logs by re-fetching the same range via spectra_get_onchain_activity; verify the contract emits the canonical ERC-4626 / ERC-20 signature`,
    });
  }

  return {
    chain,
    fromBlock,
    toBlock: effectiveTo,
    rpcUsed: rpcCtx.url,
    shareTokenAddress,
    depositEvents,
    withdrawEvents,
    safeTransferEvents,
    warnings,
  };
}

/** Empty event result with a single `rpc-all-failed` warning — graceful tail
 *  for the Phase 3 engine when bootstrap fails. */
function makeAllNullEventResult(
  chain: ChainKey,
  addresses: ChainReadInput,
  fromBlock: number,
  toBlock: number,
  err: RpcAllFailedError,
): MetaVaultEventResult {
  const hasInfraVault = !!addresses.infraVault && addresses.infraVault.length === 42;
  const shareTokenAddress = hasInfraVault ? addresses.infraVault! : addresses.vault;
  return {
    chain,
    fromBlock,
    toBlock,
    rpcUsed: "",
    shareTokenAddress,
    depositEvents: [],
    withdrawEvents: [],
    safeTransferEvents: [],
    warnings: [
      {
        severity: "error",
        code: "rpc-all-failed",
        detail: `all RPCs failed for ${chain}: ${err.message} (tried ${err.attemptedUrls.length} endpoint(s))`,
        nextProbe: `use a premium RPC (Alchemy, Infura) for chain ${chain}; chain-reads degraded for events. Failed URLs: ${err.attemptedUrls.join(", ") || "(none configured)"}`,
      },
    ],
  };
}

// =============================================================================
// OQ-L probe — readInfraVaultMintEvents
//
// RELIC-WHEN: chain-reads gains a generic `readShareTokenMintEvents(chain,
// address, fromBlock, toBlock)` — same logic, parameterized over the reason
// for the scan. Rename or retire then. (Diverger Round-7 audit dissolution
// condition externalized into the substrate.)
// =============================================================================
//
// Sibling to `readMetaVaultEvents`, but TARGETED at a single share-token
// surface (the infraVault address) for `Transfer(from=0x0, to=*)` events ONLY.
// `readMetaVaultEvents` scans Transfer events at the UNDERLYING token (Safe-
// filtered) and Deposit/Withdraw events at the share token — neither covers
// the share-token MINT event surface OQ-L needs to enumerate every address
// that has ever received infraVault shares from the zero address.
//
// Why a separate function (and not a flag on `readMetaVaultEvents`)?
//   1. Different topic filter: `topics[1] = padded(0x0)`, no `to` filter.
//   2. Different consumer: investigation surface, not dashboard-render path.
//   3. Different prohibition: this surface enumerates ADDRESSES that hold
//      vault-scope receipts. Surfacing it casually creates a surveillance shape
//      `readMetaVaultEvents` doesn't have. Architect's call: keep them separate.
//
// Reuses everything `readMetaVaultEvents` reuses: `pickWorkingRpc`,
// `withRpcFallback` (transitively, via fetchLogs's chunking), `fetchLogs`'s
// 500K block range cap (MAX_EVENT_BLOCK_RANGE), `decodeTransferLog` for the
// log shape (Transfer is one ABI regardless of token).
//
// Failure modes (mirroring `readMetaVaultEvents`):
//   - RPC bootstrap fails → empty result + `rpc-all-failed` warning.
//   - Range > 500K → clamps `toBlock`, emits `block-range-too-large`, continues.
//   - Per-chunk fetchLogs fails → partial-coverage warning + audit log.
//   - Decoders drop ≥1 malformed log → emits `event-decode-failed` info.

/** Pre-computed zero-address topic word for mint-event filtering. */
const ZERO_ADDRESS_TOPIC = "0x" + "0".repeat(64);

/**
 * Output of `readInfraVaultMintEvents`. Mirrors `MetaVaultEventResult` shape
 * but narrowed to the single mint-event stream — no Deposit/Withdraw, no
 * underlying-token transfers. The address scanned is `infraVaultAddress`
 * (the share token); the only events returned are `Transfer(from=0x0, to=*)`.
 *
 * Empty `mintEvents` with empty `warnings` means "no mints in this range" —
 * a valid signal, not a failure. Inspect `warnings` to disambiguate.
 */
export interface InfraVaultMintEventResult {
  chain: ChainKey;
  fromBlock: number;
  /** Effective `toBlock` after any range-cap clamping. */
  toBlock: number;
  rpcUsed: string;
  /** The share-token contract that was scanned (the infraVault). */
  infraVaultAddress: string;
  mintEvents: ParsedTransferEvent[];
  warnings: ChainReadWarning[];
}

/**
 * Phase 3 sibling — fetch decoded `Transfer(from=0x0, to=*)` mint events at
 * the infraVault SHARE token over a block range.
 *
 * The single eth_getLogs filter is `[TransferTopic, padded(0x0), null]` —
 * `topics[1]` is the indexed `from` slot, pinned to the zero-address word.
 * `topics[2]` (`to`) is left wild. Logs are decoded via `decodeTransferLog`
 * (the same Transfer ABI that the underlying-side path uses) and returned in
 * (block, logIndex) ascending order.
 *
 * @param chain Chain to read from. RPC list resolved via the existing
 *              `resolveRpcUrlsWithFallbacks`.
 * @param infraVaultAddress The share token to scan. MUST be a 20-byte EVM
 *              address (no validation here; caller is the investigation
 *              substrate which already typechecks inputs).
 * @param fromBlock Inclusive lower bound. Pass the deployment block when
 *              you want full history; otherwise a recent window for a sweep.
 * @param toBlock Inclusive upper bound. Will be clamped to `fromBlock + 500K`
 *              with a `block-range-too-large` warning if the range exceeds
 *              MAX_EVENT_BLOCK_RANGE.
 *
 * @returns Mint events + warnings. NEVER throws at the function boundary.
 *          Bootstrap failure ⇒ empty result + `rpc-all-failed` warning.
 *          Partial-coverage chunk failures ⇒ warning + whatever chunks did
 *          succeed (do NOT treat empty `mintEvents` as conclusive).
 */
export async function readInfraVaultMintEvents(
  chain: ChainKey,
  infraVaultAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<InfraVaultMintEventResult> {
  const warnings: ChainReadWarning[] = [];

  // Step 1: RPC bootstrap. Same fail-soft contract as readMetaVaultEvents.
  let rpcCtx: RpcContext;
  try {
    rpcCtx = await pickWorkingRpc(chain);
  } catch (err) {
    if (err instanceof RpcAllFailedError) {
      return makeAllNullMintEventResult(chain, infraVaultAddress, fromBlock, toBlock, err);
    }
    throw err;
  }
  if (rpcCtx.fellBack) {
    warnings.push({
      severity: "info",
      code: "rpc-fallback-used",
      detail: `primary RPC failed; succeeded on ${rpcCtx.url}`,
      nextProbe:
        "check primary RPC health if pattern persists for >24h; consider promoting a fallback to primary in CHAIN_RPC_URLS",
    });
  }

  // Step 2: range-cap clamp. Same MAX_EVENT_BLOCK_RANGE as readMetaVaultEvents.
  let effectiveTo = toBlock;
  if (toBlock > fromBlock && toBlock - fromBlock > MAX_EVENT_BLOCK_RANGE) {
    effectiveTo = fromBlock + MAX_EVENT_BLOCK_RANGE;
    warnings.push({
      severity: "warn",
      code: "block-range-too-large",
      detail: `requested ${toBlock - fromBlock} blocks exceeds ${MAX_EVENT_BLOCK_RANGE}-block cap; scanning ${fromBlock}..${effectiveTo}`,
      nextProbe: `re-call with a narrower window or paginate (current cap matches src/tools/onchain.ts MAX_TOTAL_BLOCK_RANGE)`,
    });
  }

  // Step 3: fetch mint logs. Topic filter pins `from` to the zero-address word
  // and leaves `to` wild — exactly the `Transfer(from=0, to=*)` shape OQ-L spec
  // §11 calls for.
  const mintTopics: (string | string[] | null)[] = [
    SELECTORS.TransferTopic,
    ZERO_ADDRESS_TOPIC,
    null,
  ];

  let mintRaw: RawEventLog[] = [];
  try {
    const [logs, ok, total] = await fetchLogs(
      rpcCtx.url,
      infraVaultAddress,
      mintTopics,
      fromBlock,
      effectiveTo,
    );
    mintRaw = logs;

    // Partial-coverage detection — same shape as readMetaVaultEvents (round-3
    // audit S1 / STAK-class scar). chunk-success ≠ complete coverage; if any
    // chunk failed, surface it so the consumer doesn't reason on an incomplete
    // mint history.
    if (ok < total) {
      warnings.push({
        severity: "warn",
        code: "logs-partial-coverage",
        detail: `eth_getLogs partial coverage — Mint (Transfer-from-0): ${ok}/${total} chunks. Returned events may be incomplete.`,
        nextProbe:
          "narrow the block range to a smaller window, OR retry with a more reliable RPC. Treat 'no mints' as 'unknown coverage' until the partial-coverage warning clears.",
      });
    }
  } catch (err) {
    return makeAllNullMintEventResult(
      chain,
      infraVaultAddress,
      fromBlock,
      effectiveTo,
      new RpcAllFailedError(chain, [rpcCtx.url], err),
    );
  }

  // Step 4: decode. Drop nulls but track the count so a single info-warning
  // surfaces if anything was malformed.
  let decodeFailures = 0;
  const mintEvents: ParsedTransferEvent[] = [];
  for (const raw of mintRaw) {
    const parsed = decodeTransferLog(raw, infraVaultAddress);
    if (!parsed) {
      decodeFailures++;
      continue;
    }
    // Defense in depth: the topic filter already pinned `from = 0x0` at the
    // RPC level, but if a malformed log slipped through the upper-12-byte
    // guard in `decodeAddressTopic`, double-check the post-decode `from` is
    // the zero address before counting it as a mint.
    if (parsed.from !== "0x0000000000000000000000000000000000000000") {
      decodeFailures++;
      continue;
    }
    mintEvents.push(parsed);
  }

  // fetchLogs already sorts by (block, logIndex) — but we re-sort defensively
  // so contract holds independent of the helper's invariants.
  mintEvents.sort((a, b) =>
    a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
  );

  if (decodeFailures > 0) {
    warnings.push({
      severity: "info",
      code: "event-decode-failed",
      detail: `${decodeFailures} raw log(s) failed to decode (or non-zero from) and were skipped`,
      nextProbe: `inspect the failed logs by re-fetching the same range; verify the contract emits the canonical ERC-20 Transfer signature`,
    });
  }

  return {
    chain,
    fromBlock,
    toBlock: effectiveTo,
    rpcUsed: rpcCtx.url,
    infraVaultAddress: infraVaultAddress.toLowerCase(),
    mintEvents,
    warnings,
  };
}

/** Empty mint-event result with a single `rpc-all-failed` warning — the
 *  graceful tail when bootstrap fails or batch throws mid-flight. */
function makeAllNullMintEventResult(
  chain: ChainKey,
  infraVaultAddress: string,
  fromBlock: number,
  toBlock: number,
  err: RpcAllFailedError,
): InfraVaultMintEventResult {
  return {
    chain,
    fromBlock,
    toBlock,
    rpcUsed: "",
    infraVaultAddress: infraVaultAddress.toLowerCase(),
    mintEvents: [],
    warnings: [
      {
        severity: "error",
        code: "rpc-all-failed",
        detail: `all RPCs failed for ${chain}: ${err.message} (tried ${err.attemptedUrls.length} endpoint(s))`,
        nextProbe: `use a premium RPC (Alchemy, Infura) for chain ${chain}; mint-event scan degraded. Failed URLs: ${err.attemptedUrls.join(", ") || "(none configured)"}`,
      },
    ],
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
