/**
 * OQ-L probe — residual infraVault holders.
 *
 * RELIC-WHEN: Theme E ships its external-position-provenance engine
 * (enumerates `(holder, share-token, attribution)` for any whitelisted
 * module). At that point this is one specialization of a more general
 * substrate; rename or retire then. The Diverger Round-7 audit named this
 * dissolution explicitly — externalizing it from the soul-stratigraphy
 * into the substrate itself.
 *
 * SUBSTRATE GAP (Diverger Round-7 protected finding, documented honest):
 *   This probe finds MINT RECIPIENTS (Transfer-from-zero at infraVault),
 *   not all current non-known holders. If a residual share holder received
 *   their shares via Transfer-FROM-WRAPPER (or any non-mint transfer)
 *   rather than a direct mint, this probe will NOT find them. The
 *   `wrapper-signature` check at chain-reads.ts confirms residuals exist
 *   today (gamisUSDC wrapper holds 99.97%, leaving ~0.03% non-wrapper-held)
 *   — so any "0 residuals found" result must be read as "0 mint-recipients
 *   in scanned window," not "no residual holders." Conclusive enumeration
 *   requires either (a) full Transfer-history scan + per-holder net-balance
 *   aggregation (heavy), or (b) off-chain holder index, or (c) hint from
 *   Spectra API. The substrate as built is correct for what it does;
 *   what it does is not the same as conclusive OQ-L resolution.
 *
 * Substrate for the open question OQ-L (per docs/onchain-metavault-verification-spec.md
 * §11): "After OQ-J resolution, [a Spectra MetaVault] holds 99.97% of infraVault
 * shares. The remaining ~1,704 shares (~$1.74K) are held by other addresses
 * NOT at curator or Safe. Cheap probe: scan `Transfer(from=0, to=*)` events
 * at infraVault to identify minted-to addresses."
 *
 * This module ships the SUBSTRATE — a pure investigation function. There is
 * NO MCP tool registration. The architectural truth is:
 *
 *   The function sees addresses and cannot attribute provenance. That is the
 *   boundary. Output is `{addresses, balances, mint metadata}`. Stakeholder
 *   framing ("collaborative disclosure", "surveillance avoidance") is
 *   consumer-layer prose, not engine concern.
 *
 * Why no MCP tool surface (yet):
 *   Public tool surface for residual-holders enumeration creates a
 *   surveillance shape that is irreversibly different from a private
 *   investigation. The probe runs via direct invocation in a test or one-off
 *   script. If Spectra/Gaspard later confirms topology and wants public
 *   verifiability, the tool surface lands then — not before.
 *
 * Algorithm:
 *   1. Call `readInfraVaultMintEvents` to get every `Transfer(from=0x0, to=*)`
 *      event at the share token over the requested block range.
 *   2. Set-difference recipients vs `knownHolders` (lowercased) → candidate
 *      residual addresses.
 *   3. For each candidate, call `infraVault.balanceOf(addr)` at the CURRENT
 *      block (latest). Point-in-time read, not a historical sum — because
 *      shares can transfer or burn between mint and now, the only way to
 *      enumerate currently-held residual shares is to ask the contract now.
 *   4. Filter to addresses with non-zero current balance.
 *   5. Aggregate (count, total, smallest, largest).
 *
 * Honest narrowings (DeFi-analyst tagging):
 *   - [on-chain] mint events, balanceOf reads. RPC + block at result top.
 *   - [unknown] WHO an address is. Provenance attribution requires off-chain
 *     context; the engine cannot resolve it.
 *   - [partial] if `partialCoverage` warning fires, the mint scan missed
 *     chunks — residual list is a LOWER BOUND, not exhaustive. A future mint
 *     in a missed chunk to an unknown holder would not appear.
 *
 * Failure contract:
 *   NEVER throws at the function boundary. RPC failures, decode failures,
 *   and partial coverage all surface as warnings on the result. Empty
 *   `residuals` with a `partialCoverage` warning means "could be no
 *   residuals OR coverage was incomplete" — caller MUST check.
 */

import { ethCallWithFallback } from "../api.js";
import {
  type InfraVaultMintEventResult,
  decodeUint256,
  readInfraVaultMintEvents,
  SELECTORS,
} from "../chain-reads.js";
import type { ChainKey } from "../config.js";
import type { ChainReadWarning, ParsedTransferEvent } from "../types.js";

/** Per-call timeout for `balanceOf` reads (sub-PR 1+2 lesson — clear timer in
 *  finally to avoid timer leak). Unused directly; `ethCallWithFallback` already
 *  applies `FETCH_TIMEOUT_MS`, but we keep this constant as the architectural
 *  intent if a future call path stops going through that helper. */
const BALANCE_OF_TIMEOUT_MS = 15_000;
void BALANCE_OF_TIMEOUT_MS; // referenced for documentation only

/** A single residual holder: an address that received at least one infraVault
 *  share via mint AND currently holds a non-zero balance, AND is NOT in the
 *  caller-supplied `knownHolders` set. Provenance (who they are, why they
 *  hold) is OUT OF SCOPE — that's an off-chain attribution layer. */
export interface ResidualHolder {
  /** Lowercased EVM address. */
  address: string;
  /** Current `balanceOf(address)` at the time of probe (latest block). */
  currentBalance: bigint;
  /** Block number of the FIRST observed mint to this address in the scanned
   *  range. Useful for "when did they first appear?" — but NOT a holding-since
   *  signal (they may have transferred out and back). */
  firstMintAtBlock: number;
  /** Tx hash of the first observed mint. Pair with `firstMintAtBlock` for a
   *  one-click chain-explorer link. */
  firstMintTxHash: string;
  /** Total shares minted TO this address in the scanned range. May exceed
   *  `currentBalance` (if they transferred out) or be less (if they received
   *  via transfer rather than mint). Information signal only — NEVER reconcile
   *  against `currentBalance` for accounting. */
  totalMintedToAddressInRange: bigint;
}

/** Aggregated stats over the residual set. All values are infraVault SHARE
 *  units (raw, not human-decoded — caller decides whether to render in
 *  underlying or shares). */
export interface ResidualAggregations {
  count: number;
  totalShares: bigint;
  smallestShares: bigint;
  largestShares: bigint;
  /** Address holding the largest residual position (lowercased). null when
   *  the residual set is empty. */
  topHolder: string | null;
}

/** Output of `findResidualInfraVaultHolders`. */
export interface ResidualHolderResult {
  chain: ChainKey;
  infraVaultAddress: string;
  /** Block range that was scanned for mint events. `toBlock` reflects the
   *  effective range after any 500K cap clamping — see chain-reads warnings. */
  fromBlock: number;
  toBlock: number;
  /** RPC URL used by the mint-event scan (empty string if bootstrap failed). */
  rpcUsedForEvents: string;
  /** Total unique addresses observed in mint events (pre-knownHolders filter).
   *  Diagnostic — lets the caller see "how big was the funnel?" before
   *  set-difference. */
  uniqueMintRecipients: number;
  /** Addresses removed by the `knownHolders` filter. Diagnostic. */
  excludedKnownHolders: number;
  /** Residual addresses with non-zero current balance, sorted by
   *  `currentBalance` descending. */
  residuals: ResidualHolder[];
  aggregations: ResidualAggregations;
  /** Forwarded warnings from the mint-event scan + any new warnings the
   *  investigation surfaced (e.g., balanceOf RPC failures for individual
   *  candidates). */
  warnings: ChainReadWarning[];
}

/** ABI-encode a `balanceOf(address)` calldata: selector + 32-byte zero-padded
 *  address. (Chain-reads.ts has a private copy of this; we re-define here to
 *  keep the investigation file independent of that internal helper.) */
function encodeBalanceOf(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return SELECTORS.balanceOf + clean.padStart(64, "0");
}

/**
 * Find residual holders of an infraVault's shares — addresses NOT in the
 * `knownHolders` set that currently hold a non-zero balance and received at
 * least one share via mint in the scanned range.
 *
 * Pure function: no console output, no formatting, no prose. The caller (test,
 * one-off script, or future tool surface) renders the result.
 *
 * @param chain Chain key (e.g., "base"). RPC fallback list resolved internally.
 * @param infraVaultAddress The share token to investigate. Lowercased internally.
 * @param knownHolders Addresses to EXCLUDE from the residual set (e.g., outer
 *               wrapper, curator EOA, Safe). Lowercased internally before
 *               set-difference. The caller is responsible for knowing which
 *               addresses they consider "known" — this function does NOT
 *               attribute provenance.
 * @param fromBlock Inclusive lower bound for the mint-event scan. Pass the
 *               infraVault deployment block for full history.
 * @param toBlock Inclusive upper bound. Will be clamped to `fromBlock + 500K`
 *               by `readInfraVaultMintEvents` if the range exceeds
 *               MAX_EVENT_BLOCK_RANGE — caller MUST check `result.toBlock`
 *               and re-call with a sliding window for full coverage.
 *
 * @returns Residual holders + aggregations + warnings. NEVER throws.
 */
export async function findResidualInfraVaultHolders(
  chain: ChainKey,
  infraVaultAddress: string,
  knownHolders: string[],
  fromBlock: number,
  toBlock: number,
): Promise<ResidualHolderResult> {
  const lowerInfra = infraVaultAddress.toLowerCase();
  const knownSet = new Set(knownHolders.map((h) => h.toLowerCase()));
  const warnings: ChainReadWarning[] = [];

  // Step 1 — fetch mint events from chain-reads. This is the SUBSTRATE.
  const mintScan: InfraVaultMintEventResult = await readInfraVaultMintEvents(
    chain,
    lowerInfra,
    fromBlock,
    toBlock,
  );
  warnings.push(...mintScan.warnings);

  // If the bootstrap failed (rpc-all-failed), we cannot continue. Return early
  // with empty residuals — the warning carries the audit trail.
  const bootstrapFailed = mintScan.warnings.some((w) => w.code === "rpc-all-failed");
  if (bootstrapFailed) {
    return {
      chain,
      infraVaultAddress: lowerInfra,
      fromBlock,
      toBlock: mintScan.toBlock,
      rpcUsedForEvents: mintScan.rpcUsed,
      uniqueMintRecipients: 0,
      excludedKnownHolders: 0,
      residuals: [],
      aggregations: {
        count: 0,
        totalShares: 0n,
        smallestShares: 0n,
        largestShares: 0n,
        topHolder: null,
      },
      warnings,
    };
  }

  // Step 2 — aggregate mint-event recipients. For each unique `to`, track:
  //   - the FIRST mint we saw (block, tx) — earliest provenance signal
  //   - the SUM of minted shares across all mints in range — diagnostic only
  // Mints are already sorted ascending by (block, logIndex) in chain-reads.
  interface MintAggregate {
    firstMintAtBlock: number;
    firstMintTxHash: string;
    totalMintedInRange: bigint;
  }
  const mintAggregates = new Map<string, MintAggregate>();
  for (const ev of mintScan.mintEvents as ParsedTransferEvent[]) {
    const to = ev.to.toLowerCase();
    const existing = mintAggregates.get(to);
    if (existing) {
      existing.totalMintedInRange += ev.value;
    } else {
      mintAggregates.set(to, {
        firstMintAtBlock: ev.blockNumber,
        firstMintTxHash: ev.transactionHash,
        totalMintedInRange: ev.value,
      });
    }
  }
  const uniqueMintRecipients = mintAggregates.size;

  // Step 3 — set-difference vs knownHolders.
  const candidates: string[] = [];
  let excludedKnownHolders = 0;
  for (const recipient of mintAggregates.keys()) {
    if (knownSet.has(recipient)) {
      excludedKnownHolders++;
      continue;
    }
    candidates.push(recipient);
  }

  // Step 4 — for each candidate, read `balanceOf(addr)` at latest. Sequential
  // (not parallel) to avoid hammering the RPC: the candidate set should be
  // small (residual = NOT in known set). If it grows past ~50, switch to
  // chunked parallel — but for OQ-L's expected 1-10 residuals, sequential is
  // fine and simplifies error handling.
  const residuals: ResidualHolder[] = [];
  let balanceOfFailures = 0;
  for (const addr of candidates) {
    const calldata = encodeBalanceOf(addr);
    let hex: string | null;
    try {
      // ethCallWithFallback already applies FETCH_TIMEOUT_MS per call and
      // walks the chain's RPC fallback list. Returns null on hard failure.
      hex = await ethCallWithFallback(chain, lowerInfra, calldata);
    } catch {
      hex = null;
    }
    if (hex === null) {
      balanceOfFailures++;
      continue;
    }
    const balance = decodeUint256(hex);
    if (balance === null) {
      balanceOfFailures++;
      continue;
    }
    if (balance === 0n) {
      // Received a mint at some point but no longer holds. Drop from residuals.
      continue;
    }
    const agg = mintAggregates.get(addr);
    if (!agg) continue; // defensive — should never happen
    residuals.push({
      address: addr,
      currentBalance: balance,
      firstMintAtBlock: agg.firstMintAtBlock,
      firstMintTxHash: agg.firstMintTxHash,
      totalMintedToAddressInRange: agg.totalMintedInRange,
    });
  }

  if (balanceOfFailures > 0) {
    // Distinct warning code (Sonnet+depth audit NB-1): mint-scan partial
    // coverage and balanceOf-read partial coverage are different failure
    // modes; consumers filtering by code must distinguish them.
    warnings.push({
      severity: "warn",
      code: "balanceof-partial-coverage",
      detail: `balanceOf reads failed for ${balanceOfFailures}/${candidates.length} candidate(s); residual list may be incomplete`,
      nextProbe: `retry with a more reliable RPC; treat the residual count as a LOWER BOUND until balanceOf coverage is complete`,
    });
  }

  // Step 5 — sort residuals by current balance descending; compute aggregations.
  residuals.sort((a, b) => {
    if (b.currentBalance > a.currentBalance) return 1;
    if (b.currentBalance < a.currentBalance) return -1;
    return 0;
  });

  let totalShares = 0n;
  let smallestShares = residuals.length > 0 ? residuals[0].currentBalance : 0n;
  let largestShares = 0n;
  let topHolder: string | null = null;
  for (const r of residuals) {
    totalShares += r.currentBalance;
    if (r.currentBalance > largestShares) {
      largestShares = r.currentBalance;
      topHolder = r.address;
    }
    if (r.currentBalance < smallestShares) smallestShares = r.currentBalance;
  }

  return {
    chain,
    infraVaultAddress: lowerInfra,
    fromBlock,
    toBlock: mintScan.toBlock,
    rpcUsedForEvents: mintScan.rpcUsed,
    uniqueMintRecipients,
    excludedKnownHolders,
    residuals,
    aggregations: {
      count: residuals.length,
      totalShares,
      smallestShares,
      largestShares,
      topHolder,
    },
    warnings,
  };
}
