/**
 * Avant burn-order chain-truth verifier (Theme E first slice).
 *
 * What this resolves:
 *   The Spectra API surfaces avant `externalPositions` for MetaVaults that
 *   have queued an avUSDx → avUSD redemption ("burn order") on Avalanche.
 *   The API renders `settle ~7d`, but that's the nominal cooldown from
 *   Avant's docs — it does NOT reflect (a) whether the order is genuinely
 *   still pending on-chain, (b) the on-chain amount in flight, (c) the
 *   provider attribution, (d) whether the contract is paused, or (e) where
 *   the order sits in the global request counter.
 *
 *   This verifier is one batched eth_call per order against Avant's
 *   RequestsManager on Avalanche, returning a small structured result that
 *   the engine appends as a `[chain-truth …]` line under the position render.
 *
 * What this does NOT resolve (honest unobservables):
 *   - **Submission timestamp**: the on-chain `Request` struct does NOT carry
 *     a `submittedAt`. Avant's interface is:
 *         struct Request {
 *           uint256 id;
 *           address provider;
 *           State state;       // CREATED=0, COMPLETED=1, CANCELLED=2
 *           uint256 amount;
 *           address token;
 *           uint256 minExpectedAmount;
 *         }
 *     Submission is observable only via the `BurnRequestCreated(id,...)`
 *     event log, and walking `eth_getLogs` backward to find a single
 *     historical event is too expensive for a per-position verifier (RPC
 *     log windows are typically 2048 blocks on public Avalanche endpoints).
 *     We surface what's cheap and high-signal; submission time stays in
 *     `observationBoundaries.unobservable` per the avant metadata entry.
 *
 *   - **7-day cooldown enforcement**: the contract has NO `block.timestamp +
 *     7 days` modifier. `completeBurn(...)` is gated by `SERVICE_ROLE` only —
 *     Avant's off-chain service decides when to settle. The "1 week" is
 *     operational policy, not a contract-encoded rule. This is named in the
 *     avant metadata's `interpretationNote`.
 *
 * Sources & verification:
 *   - Contract address: 0x4C129d3aA27272211D151CA39a0a01E4C16Fc887
 *     (labeled "MAX avUSD - Requests Manager" on
 *      https://docs.avantprotocol.com/security/contract-addresses,
 *      verified 2026-04-26).
 *   - Verified source on Avalanche C-Chain explorer (RouteScan ABI snapshot
 *     2026-04-26). Contract name: `RequestsManager`. Solidity 0.8.28.
 *   - Selectors computed via independent keccak256:
 *       burnRequests(uint256)        = 0x6406c10c
 *       burnRequestsCounter()        = 0x5c6a9384
 *       paused()                     = 0x5c975abb
 *   - Event topic0:
 *       BurnRequestCreated(uint256,address,address,uint256,uint256)
 *         = 0x09fdc4f6581c246c961bfa60d4a4d0d0f26a4bc0d47082a0f628bc8c92ea98f4
 *
 * Live verification (2026-04-26, block ~83,939,127):
 *   - burnRequestsCounter() = 0x347 (839)
 *   - burnRequests(796) → state=CREATED, provider=0x5e93…29b9a (gamisUSDC),
 *       amount=161,206,816,890,645,500,000,000 wei (≈161,206.82 avUSDx)
 *   - burnRequests(789) → state=CREATED, provider=0x5e93…29b9a, amount matches API
 *   - burnRequests(779) → state=CREATED, provider=0x5e93…29b9a, amount matches API
 *
 * Engine boundary: pure async function. No singletons, no shared state.
 * Per-call timeout 15s (Promise.race with cleared `setTimeout` to prevent
 * the timer leak pattern from earlier theme phases). Failures degrade to
 * a structured error result; never throws at the engine boundary.
 *
 * 60-day dissolution review (Diverger Round-6 backport from pendle-verifier
 * — the second slice taught the first what it should have done):
 *   - If telemetry shows zero `verify_externals=true` invocations against
 *     avant positions within 60 days of ship (b7e6046 + 85d4dea), the
 *     verifier is fossil and should be folded into list-mode default OR
 *     removed alongside the dashboard's verify_externals flag.
 *   - If Avant migrates settlement to a contract-encoded timer (per-order
 *     ETA exposed via a new contract method), collapse the `[✓ eligible]`
 *     qualifier to plain `[✓]` and surface the on-chain ETA timestamp.
 *   - If Avant publishes a verified ABI under a stable URL (or a
 *     curator-context plumbing arrives that exposes provider attribution
 *     without the per-position `provider` field), revisit the selector
 *     hand-rolling here.
 *   - If `AVANT_AMOUNT_DRIFT_TOLERANCE_PPM = 100n` produces false-positive
 *     drift warnings on >5% of healthy live reads over 7 days, recalibrate
 *     and consider promoting the constant into metadata.ts as
 *     `InterpretedValue<bigint>` (Diverger Round-5 follow-up — also
 *     justified once a third verifier needs its own PPM tolerance).
 */

import { resolveRpcUrlsWithFallbacks, FETCH_TIMEOUT_MS } from "../config.js";
import { withRpcFallback } from "../api.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Avant RequestsManager on Avalanche (C-Chain), source: docs.avantprotocol.com/security/contract-addresses (2026-04-26). */
export const AVANT_REQUESTS_MANAGER_AVAX = "0x4c129d3aa27272211d151ca39a0a01e4c16fc887" as const;

/** Selectors — first 4 bytes of keccak256(signature). Independently computed. */
export const AVANT_SELECTORS = {
  burnRequests:        "0x6406c10c", // burnRequests(uint256)
  burnRequestsCounter: "0x5c6a9384", // burnRequestsCounter()
  paused:              "0x5c975abb", // paused()
} as const;

/** State enum mirrored from IRequestsManager.sol. */
export const AVANT_REQUEST_STATE = {
  CREATED:   0,
  COMPLETED: 1,
  CANCELLED: 2,
} as const;
export type AvantRequestState =
  (typeof AVANT_REQUEST_STATE)[keyof typeof AVANT_REQUEST_STATE];

/** Per-order verification timeout. Single batched eth_call → 15s is plenty. */
export const AVANT_VERIFY_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export interface AvantVerificationOk {
  kind: "ok";
  /** The Avant on-chain requestId we read (NOT the Spectra-API `orderId`). */
  requestId: number;
  /** State enum value (CREATED/COMPLETED/CANCELLED). */
  state: AvantRequestState;
  /** Provider address — should match the MetaVault that submitted the burn. */
  provider: string;
  /** avUSDx amount being burnt, in wei (18 decimals). */
  amountWei: bigint;
  /** Withdrawal token address (avUSD). */
  token: string;
  /** Minimum acceptable claim amount in avUSD wei (slippage guard). */
  minExpectedAmountWei: bigint;
  /** Total burn requests ever created — head of the global counter. */
  burnRequestsCounter: number;
  /**
   * Orders submitted at or after this one (rough upper bound on queue depth
   * BEHIND this order). NOT pending count — completed/cancelled orders also
   * increment the counter. Reported as a raw observable; consumer-side
   * interpretation is delegated to renderer/agent.
   */
  ordersSubmittedAfter: number;
  /** Contract-level pause flag. Settlement is blocked while true. */
  paused: boolean;
  /** Avalanche block number at read time (for reproducibility). */
  blockRead: number;
  /** Which RPC URL produced the answer (audit trail). */
  rpcUrl: string;
}

export interface AvantVerificationFailed {
  kind: "failed";
  requestId: number;
  /** Short, single-line error suitable for inline render. */
  error: string;
}

export type AvantVerification = AvantVerificationOk | AvantVerificationFailed;

// ─────────────────────────────────────────────────────────────────────────────
// Calldata + decoding helpers (intentionally local — avoid importing
// chain-reads.ts to keep this slice independent + cheap to test).
// ─────────────────────────────────────────────────────────────────────────────

function pad32(hex: string): string {
  const clean = hex.toLowerCase().replace(/^0x/, "");
  return clean.padStart(64, "0");
}

function encodeBurnRequestsCall(requestId: number): string {
  const idHex = BigInt(requestId).toString(16);
  return AVANT_SELECTORS.burnRequests + pad32(idHex);
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

/**
 * ABI-decode the 192-byte tuple returned by `burnRequests(uint256)`:
 *   slot 0 (32B): id
 *   slot 1 (32B): provider (right-aligned address with 12-byte zero pad)
 *   slot 2 (32B): state (uint8 right-aligned)
 *   slot 3 (32B): amount
 *   slot 4 (32B): token (right-aligned address with 12-byte zero pad)
 *   slot 5 (32B): minExpectedAmount
 *
 * Returns null on any shape violation (length mismatch, malformed address
 * padding, state out of range). All failures collapse into a single-shape
 * failure surfaced at the verifier boundary.
 */
export function decodeBurnRequest(hex: string): {
  id: bigint;
  provider: string;
  state: AvantRequestState;
  amount: bigint;
  token: string;
  minExpectedAmount: bigint;
} | null {
  if (!hex || !hex.startsWith("0x")) return null;
  // 6 × 32-byte words = 192 bytes = 384 hex chars + 0x prefix = 386
  if (hex.length !== 386) return null;
  const body = hex.slice(2);
  const word = (i: number) => "0x" + body.slice(i * 64, (i + 1) * 64);

  const id = decodeWordToBigInt(word(0));
  if (id == null) return null;

  // Provider — upper-12-byte zero guard prevents corrupted-bytes-as-address.
  const providerWord = word(1).slice(2);
  if (providerWord.slice(0, 24) !== "000000000000000000000000") return null;
  const provider = "0x" + providerWord.slice(24);

  const stateBig = decodeWordToBigInt(word(2));
  if (stateBig == null) return null;
  if (stateBig < 0n || stateBig > 2n) return null;
  const state = Number(stateBig) as AvantRequestState;

  const amount = decodeWordToBigInt(word(3));
  if (amount == null) return null;

  const tokenWord = word(4).slice(2);
  if (tokenWord.slice(0, 24) !== "000000000000000000000000") return null;
  const token = "0x" + tokenWord.slice(24);

  const minExpectedAmount = decodeWordToBigInt(word(5));
  if (minExpectedAmount == null) return null;

  return { id, provider, state, amount, token, minExpectedAmount };
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC plumbing — three batched calls per verification
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
 * Send three eth_call requests + one eth_blockNumber as a single JSON-RPC
 * batch. Avalanche public RPC accepts batches of this size easily. The
 * response is sorted by `id` to tolerate spec-permitted reordering.
 */
async function fetchBatch(rpcUrl: string, requestId: number): Promise<{
  burnRequest: string | null;
  counter: string | null;
  paused: string | null;
  block: number;
}> {
  const calls: BatchEntry[] = [
    {
      jsonrpc: "2.0",
      id: 0,
      method: "eth_call",
      params: [
        { to: AVANT_REQUESTS_MANAGER_AVAX, data: encodeBurnRequestsCall(requestId) },
        "latest",
      ],
    },
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: AVANT_REQUESTS_MANAGER_AVAX, data: AVANT_SELECTORS.burnRequestsCounter },
        "latest",
      ],
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_call",
      params: [
        { to: AVANT_REQUESTS_MANAGER_AVAX, data: AVANT_SELECTORS.paused },
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
  if (ent0?.error) throw new Error(`burnRequests reverted: ${ent0.error.message ?? "unknown"}`);
  if (ent1?.error) throw new Error(`counter reverted: ${ent1.error.message ?? "unknown"}`);
  if (ent2?.error) throw new Error(`paused reverted: ${ent2.error.message ?? "unknown"}`);
  if (ent3?.error) throw new Error(`block fetch failed: ${ent3.error.message ?? "unknown"}`);
  return {
    burnRequest: ent0?.result ?? null,
    counter: ent1?.result ?? null,
    paused: ent2?.result ?? null,
    block: ent3?.result ? Number(BigInt(ent3.result)) : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public verifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a single Avant burn order on Avalanche.
 *
 * Caller passes the on-chain `requestId` (NOT the Spectra-API `orderId` —
 * the API surfaces both fields; engine wiring chooses `requestId` because
 * it's the contract mapping key. See engine.ts for the field selection).
 *
 * Returns:
 *   - { kind: "ok", … } on a clean batched read.
 *   - { kind: "failed", error } on RPC failure, decode failure, or timeout.
 *
 * Never throws. Per-order timeout 15s. Uses `withRpcFallback` so a primary
 * RPC outage falls through to public alternatives (Avalanche has 1 fallback
 * configured: `avalanche-c-chain-rpc.publicnode.com`).
 */
export async function verifyAvantPosition(
  requestId: number,
  options: { overrideRpcUrl?: string } = {},
): Promise<AvantVerification> {
  // Defensive guard (Sonnet+depth audit N4): requestId 0 is never a real
  // avant order — Avant's contract starts ID at 1 (verified by reading
  // burnRequests(0) returning all-zero against the verified contract). 0
  // would also pass the structural decode and surface as a zero-address
  // ok-result, which is misleading. Reject explicitly.
  if (!Number.isFinite(requestId) || requestId <= 0 || !Number.isInteger(requestId)) {
    return {
      kind: "failed",
      requestId,
      error: `invalid requestId: ${requestId}`,
    };
  }

  const rpcs = resolveRpcUrlsWithFallbacks("avalanche", options.overrideRpcUrl);
  if (rpcs.length === 0) {
    return {
      kind: "failed",
      requestId,
      error: "no RPC URLs configured for avalanche",
    };
  }

  // Per-order timeout: race the batched RPC against a hard deadline. Mirror
  // the timer-leak fix from sub-PRs 1+2: store the timer handle and clear
  // in `finally` regardless of who wins, so a slow RPC winning doesn't
  // leave a pending timer holding the event loop.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await withRpcFallback(
      rpcs,
      async (rpcUrl) => {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(new Error(`avant-verify timed out after ${AVANT_VERIFY_TIMEOUT_MS}ms`)),
            AVANT_VERIFY_TIMEOUT_MS,
          );
        });
        try {
          const batch = await Promise.race([fetchBatch(rpcUrl, requestId), timeoutPromise]);
          // Decode burnRequests tuple
          const decoded = decodeBurnRequest(batch.burnRequest ?? "");
          if (!decoded) {
            // Empty result (id=0 tuple) means the request doesn't exist OR
            // the contract hasn't materialized the mapping for this slot.
            // Treat as not-found to avoid silently rendering all-zeros.
            return {
              kind: "failed",
              requestId,
              error: "request not found on-chain",
            } satisfies AvantVerificationFailed;
          }
          // Decode counter and paused
          const counterBig = decodeWordToBigInt(batch.counter);
          if (counterBig == null) {
            return {
              kind: "failed",
              requestId,
              error: "counter decode failed",
            } satisfies AvantVerificationFailed;
          }
          const counter = Number(counterBig);
          const pausedBig = decodeWordToBigInt(batch.paused);
          if (pausedBig == null) {
            return {
              kind: "failed",
              requestId,
              error: "paused decode failed",
            } satisfies AvantVerificationFailed;
          }
          const paused = pausedBig !== 0n;
          // Sanity: counter should be >= requestId (mapping was populated).
          // If it isn't, something is structurally wrong — surface as failed
          // rather than render misleading queue math.
          if (counter < requestId) {
            return {
              kind: "failed",
              requestId,
              error: `counter ${counter} < requestId ${requestId}`,
            } satisfies AvantVerificationFailed;
          }
          // Ensure the on-chain id matches the queried id (defense against
          // RPC returning a wrong response).
          if (decoded.id !== BigInt(requestId)) {
            return {
              kind: "failed",
              requestId,
              error: `id mismatch: chain=${decoded.id}, queried=${requestId}`,
            } satisfies AvantVerificationFailed;
          }
          const ok: AvantVerificationOk = {
            kind: "ok",
            requestId,
            state: decoded.state,
            provider: decoded.provider,
            amountWei: decoded.amount,
            token: decoded.token,
            minExpectedAmountWei: decoded.minExpectedAmount,
            burnRequestsCounter: counter,
            ordersSubmittedAfter: Math.max(0, counter - requestId),
            paused,
            blockRead: batch.block,
            rpcUrl,
          };
          return ok;
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          timeoutId = undefined;
        }
      },
      `avant-verify request=${requestId}`,
    );
  } catch (err: unknown) {
    return {
      kind: "failed",
      requestId,
      error: (err as Error)?.message?.slice(0, 120) ?? "unknown error",
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Render helpers — used by engine.ts to inline a chain-truth line under
// each avant external position. Lives here so the format stays co-located
// with the verifier semantics.
// ─────────────────────────────────────────────────────────────────────────────

const STATE_NAMES: Record<AvantRequestState, string> = {
  [AVANT_REQUEST_STATE.CREATED]:   "CREATED",
  [AVANT_REQUEST_STATE.COMPLETED]: "COMPLETED",
  [AVANT_REQUEST_STATE.CANCELLED]: "CANCELLED",
};

/**
 * Amount-drift tolerance, relative parts-per-million.
 *
 * The Spectra API truncates `burnt.balance` to a smaller-precision wei
 * representation than the contract's actual storage value. Observed drift
 * on gamisUSDC orders 779/789/796 (2026-04-26): on-chain values exceed
 * API values by ~10^11 wei (sub-$0.001 on $191K-$2M positions, i.e.
 * ~5×10^-7 relative). Strict equality flags every position as ⚠ even
 * though no curator would act on it.
 *
 * 100 ppm = 0.01% relative tolerance. This catches real divergence
 * (re-burn, partial-completion, indexer staleness on the order of
 * dollars per million) while rejecting display rounding artifacts.
 *
 * Dissolution: if the API ever upgrades to native bigint precision
 * (no more rounding), this can drop to strict equality. If observed
 * drift in production exceeds 100 ppm without a real underlying cause,
 * recalibrate.
 */
export const AVANT_AMOUNT_DRIFT_TOLERANCE_PPM = 100n;

/** Returns true when on-chain and API amounts differ by more than the PPM tolerance. */
export function isAmountDriftSignificant(chainWei: bigint, apiWei: bigint): boolean {
  if (chainWei === apiWei) return false;
  const denom = chainWei > apiWei ? chainWei : apiWei;
  if (denom === 0n) return chainWei !== apiWei;
  const delta = chainWei > apiWei ? chainWei - apiWei : apiWei - chainWei;
  // delta / denom > 100ppm  ⇔  delta * 1_000_000 > denom * 100
  return delta * 1_000_000n > denom * AVANT_AMOUNT_DRIFT_TOLERANCE_PPM;
}

/**
 * Format a verification result as a single chain-truth line for the engine
 * to append under the protocol render. Three glyphs:
 *
 *   [chain-truth ✓] state=CREATED | counter=839 (43 after) | paused=false | block N
 *   [chain-truth ⚠] state=COMPLETED on-chain — Spectra API stale
 *   [chain-truth ✗] {short error}
 *
 * The ⚠ glyph fires when the on-chain state contradicts the API's
 * "still-pending" rendering (state ≠ CREATED OR paused=true OR
 * provider doesn't match the expected vault OR amount drifts >100 ppm).
 */
export function formatAvantVerification(
  v: AvantVerification,
  expectedProvider?: string,
  expectedAmountWei?: bigint,
): string {
  if (v.kind === "failed") {
    return `[chain-truth ✗] ${v.error}`;
  }
  const stateName = STATE_NAMES[v.state] ?? `STATE(${v.state})`;
  const warnings: string[] = [];

  if (v.state !== AVANT_REQUEST_STATE.CREATED) {
    warnings.push(`state=${stateName} on-chain (API renders pending)`);
  }
  if (v.paused) {
    warnings.push("contract paused — settlement blocked");
  }
  if (
    expectedProvider &&
    expectedProvider.toLowerCase() !== v.provider.toLowerCase()
  ) {
    warnings.push(
      `provider mismatch: chain=${v.provider.slice(0, 10)} vs expected=${expectedProvider.slice(0, 10)}`,
    );
  }
  if (
    expectedAmountWei != null &&
    isAmountDriftSignificant(v.amountWei, expectedAmountWei)
  ) {
    // PPM-bounded — see AVANT_AMOUNT_DRIFT_TOLERANCE_PPM rationale.
    warnings.push(`amount drift: chain=${v.amountWei} vs api=${expectedAmountWei}`);
  }

  if (warnings.length > 0) {
    return `[chain-truth ⚠] ${warnings.join("; ")} | counter=${v.burnRequestsCounter} (${v.ordersSubmittedAfter} after) | block ${v.blockRead}`;
  }
  // Glyph note (Diverger Round-5 protected finding): "✓ eligible" not "✓"
  // because Avant's `completeBurn` is gated by SERVICE_ROLE — settlement
  // happens at Avant's off-chain operations team's discretion, NOT on a
  // contract-encoded timer. The verifier confirms eligibility (state=CREATED,
  // not paused, queue position observable). It does NOT confirm progress
  // toward settlement. Curators reading three plain "✓" glyphs against
  // "settle ~7d" prose would receive false confirmation that settlement is
  // timer-gated. The "eligible" qualifier prevents that lie-by-omission.
  //
  // Dissolution: when Avant publishes a contract method exposing per-order
  // operational ETA (or migrates settlement to a timer-gated mechanism),
  // collapse to plain "✓" with the relevant on-chain timestamp.
  return `[chain-truth ✓ eligible] state=${stateName} | counter=${v.burnRequestsCounter} (${v.ordersSubmittedAfter} after) | paused=${v.paused} | block ${v.blockRead}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProtocolVerifier strategy — generic dispatch entry point
// ─────────────────────────────────────────────────────────────────────────────
//
// All avant-specific glue lives below this line. Engine.ts + metavault.ts
// consume `avantVerifier` via the registry's `getVerifier("avant")` — they
// never reference avant-specific symbols directly. To add a new protocol
// (pendle, parallel, etc.), implement `ProtocolVerifier` in a sibling file
// and register it in verifier-registry.ts. No engine/tool edits required.

import type { ProtocolVerifier, VerifierResult } from "./verifier-types.js";
import type { TypedExternalPosition } from "./engine.js";

/**
 * Extract the on-chain `requestId` from a Spectra-API avant external position.
 * Returns null when the field is missing or malformed (e.g., raw API drift).
 *
 * IMPORTANT: requestId (the on-chain mapping key in Avant's RequestsManager)
 * is distinct from orderId (Avant's off-chain order tracker that the
 * Spectra API also surfaces). Verifier MUST use requestId.
 */
function extractAvantRequestId(position: TypedExternalPosition): number | null {
  const raw = (position as { requestId?: unknown }).requestId;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return null;
  return raw;
}

/** Avant-specific expected-value extraction for the formatter cross-checks. */
function extractAvantExpected(
  position: TypedExternalPosition,
): { provider?: string; amountWei?: bigint } {
  const providerRaw = (position as { provider?: unknown }).provider;
  const provider = typeof providerRaw === "string" ? providerRaw : undefined;
  const burnt = (position as { burnt?: { balance?: unknown } }).burnt;
  let amountWei: bigint | undefined;
  if (burnt && typeof burnt.balance === "string") {
    try {
      amountWei = BigInt(burnt.balance);
    } catch {
      amountWei = undefined;
    }
  }
  return { provider, amountWei };
}

/**
 * Avant verifier strategy. Implements `ProtocolVerifier` over
 * `verifyAvantPosition` + `formatAvantVerification`. The engine + tools
 * dispatch through this; the avant-specific functions remain exported
 * for direct unit testing (avant-verifier.test.ts) but are not consumed
 * from outside the protocols/ directory anymore.
 */
export const avantVerifier: ProtocolVerifier = {
  name: "avant",

  positionKey(position) {
    const requestId = extractAvantRequestId(position);
    return requestId == null ? null : `avant:${requestId}`;
  },

  async verify(position): Promise<VerifierResult> {
    const requestId = extractAvantRequestId(position);
    if (requestId == null) {
      return {
        kind: "failed",
        protocol: "avant",
        line: "[chain-truth ✗] avant: missing or malformed requestId",
      };
    }
    const { provider, amountWei } = extractAvantExpected(position);
    const v = await verifyAvantPosition(requestId);
    const line = formatAvantVerification(v, provider, amountWei);
    return {
      kind: v.kind === "ok" ? "ok" : "failed",
      protocol: "avant",
      line,
      extra: v,
    };
  },
};
