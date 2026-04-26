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
