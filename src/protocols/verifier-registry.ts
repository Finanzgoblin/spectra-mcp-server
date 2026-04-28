/**
 * Verifier registry — strategy dispatch for protocol chain-truth verification.
 *
 * Adding a new verifier (the entire onboarding step):
 *   1. Implement `ProtocolVerifier` in a sibling file (e.g. `pendle-verifier.ts`).
 *      The interface mandates `name`, `positionKey`, `verify` — zod-style
 *      compile-time enforcement of the contract.
 *   2. Add the strategy to `VERIFIERS` below.
 *   3. The engine.ts render path + the metavault.ts worker pool both
 *      consume the registry — no edits to either file needed.
 *
 * Two invariants:
 *   - The `name` of a verifier MUST match the `PROTOCOL_METADATA[name]` key
 *     for the protocol it verifies. The registry tests assert this.
 *   - At most ONE verifier per protocol name. Duplicate registration is a
 *     load-time error.
 */

import type { ProtocolVerifier } from "./verifier-types.js";
import { avantVerifier } from "./avant-verifier.js";
import { pendleVerifier } from "./pendle-verifier.js";
// PR-G of hardcode-vs-generalize-spec.md (R2-BL-4): cross-validation lives
// HERE, not in registry.ts. Importing getMeta one-way avoids the circular
// dependency that would otherwise materialize if registry.ts validated
// verifiers (registry → verifier-registry → registry). Co-location with the
// verifier list keeps the contract obvious to readers.
import { getMeta } from "./registry.js";

/**
 * The strategy list. Order is irrelevant (lookups are by name). Adding
 * pendle, parallel, midas, etc. is a one-line append here.
 */
const VERIFIERS: ReadonlyArray<ProtocolVerifier> = [
  avantVerifier,
  pendleVerifier,
];

const BY_NAME: ReadonlyMap<string, ProtocolVerifier> = (() => {
  const m = new Map<string, ProtocolVerifier>();
  for (const v of VERIFIERS) {
    if (m.has(v.name)) {
      throw new Error(
        `[verifier-registry] duplicate verifier registration for protocol "${v.name}"`,
      );
    }
    m.set(v.name, v);
  }
  return m;
})();

// PR-G cross-validation IIFE — runs at module load. Every registered verifier
// must have `meta.verifier` populated with a non-empty `contracts` record.
// This contract prevents the runtime crash class:
//   `meta.verifier?.contracts?.["43114"]?.requestManager` resolves `undefined`
// at the verifier site even though both schema-validation and
// verifier-registration succeeded. Spec critical invariant 4 (R2-BL-4).
(function crossValidate(): void {
  for (const v of VERIFIERS) {
    const meta = getMeta(v.name);
    if (!meta.verifier) {
      throw new Error(
        `[verifier-registry] verifier "${v.name}" registered but meta.verifier missing — populate PROTOCOL_METADATA.${v.name}.verifier per PR-G`,
      );
    }
    if (
      !meta.verifier.contracts ||
      Object.keys(meta.verifier.contracts).length === 0
    ) {
      throw new Error(
        `[verifier-registry] verifier "${v.name}" has empty contracts in metadata — at minimum, declare per-chain entries (even empty role dicts indicate verifier-driven resolution)`,
      );
    }
  }
})();

/** Returns the verifier for a protocol, or undefined if none registered. */
export function getVerifier(protocol: string): ProtocolVerifier | undefined {
  return BY_NAME.get(protocol);
}

/** True when the registry has a verifier for the protocol. */
export function hasVerifier(protocol: string): boolean {
  return BY_NAME.has(protocol);
}

/** All registered verifier names. Stable order matches `VERIFIERS` array. */
export function listVerifierNames(): ReadonlyArray<string> {
  return VERIFIERS.map((v) => v.name);
}

/** All registered verifiers. Stable order. For tests + introspection. */
export function listVerifiers(): ReadonlyArray<ProtocolVerifier> {
  return VERIFIERS;
}
