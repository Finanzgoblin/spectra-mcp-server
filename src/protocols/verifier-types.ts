/**
 * Generic protocol-verifier interface (Theme E architectural revise).
 *
 * Replaces the avant-coupled shape that shipped in b7e6046:
 *   - `ExternalChainTruthMap = { avant?: Map<number, AvantVerification> }`
 *   - hardcoded `meta.name === "avant"` branch in engine.ts render
 *   - hardcoded avant-specific worker pool in metavault.ts
 *
 * with:
 *   - `ProtocolVerifier` interface — each protocol implements its own
 *   - `Map<string, VerifierResult>` keyed by `<protocol>:<positionKey>`
 *   - generic dispatch in engine.ts + metavault.ts
 *
 * Adding a new protocol verifier (e.g. pendle, parallel) is now zero-touch
 * for engine.ts and metavault.ts: implement `ProtocolVerifier`, register in
 * verifier-registry.ts, done. The same pattern as `PROTOCOL_METADATA` —
 * registry of strategies, not a switch statement.
 *
 * Why a separate file from types.ts: types.ts holds compile-time metadata
 * shapes (SourcedValue, ProtocolMeta, FieldSpec). Verifier types are
 * runtime/async — different concern, different lifecycle.
 */

import type { TypedExternalPosition } from "./engine.js";

/**
 * Result of one position's chain-truth verification.
 *
 * Shape is intentionally protocol-agnostic: every verifier returns a
 * pre-rendered `line` (the `[chain-truth ...]` glyph string) so the engine
 * doesn't need protocol-specific render code. Per-protocol payload can ride
 * along in `extra` for downstream consumers (stress test, etc.).
 */
export interface VerifierResult {
  /** "ok" if chain reads succeeded; "failed" on any error path. */
  kind: "ok" | "failed";
  /** Protocol name, matches metadata.ts key (e.g. "avant"). */
  protocol: string;
  /** Pre-rendered glyph line, e.g. "[chain-truth ✓ eligible] state=CREATED | ...". */
  line: string;
  /**
   * Optional structured payload — for downstream consumers that want to
   * react to the verification (stress test reweighting, alerting). Engine
   * itself doesn't read this. Each protocol owns its own extra shape.
   */
  extra?: unknown;
}

/**
 * Strategy interface implemented by each protocol's verifier file.
 *
 * `name` matches the corresponding `PROTOCOL_METADATA[name]` entry.
 * `positionKey` produces a stable key from a position; engine + metavault
 *   use it to look up the verification result in the chain-truth map.
 *   Returns null when the position can't be verified by this protocol
 *   (e.g. avant external missing requestId).
 * `verify` runs the chain reads. MUST NOT throw — return a `failed` result
 *   on any error. Bounded internally (timeout, RPC fallback, decoder
 *   safety). The engine treats verifiers as opaque async black boxes.
 */
export interface ProtocolVerifier {
  /** Protocol name. Matches metadata.ts key. */
  readonly name: string;
  /**
   * Build a stable position key for the chain-truth map. Format
   * convention: `<protocol>:<id>` (e.g. `avant:796`). Must be deterministic
   * — same position → same key across calls. Returns null when the
   * position is malformed for this protocol (verifier is skipped).
   */
  positionKey(position: TypedExternalPosition): string | null;
  /**
   * Verify one position. Never throws. Bounded internally. Returns a
   * `VerifierResult` whose `protocol === this.name`.
   */
  verify(position: TypedExternalPosition): Promise<VerifierResult>;
}

/**
 * Map of position-key → verification result. Replaces the protocol-coupled
 * `ExternalChainTruthMap`. Engine.ts + metavault.ts populate + read this
 * generically; per-protocol logic lives only in the registered verifier.
 */
export type ChainTruthMap = Map<string, VerifierResult>;
