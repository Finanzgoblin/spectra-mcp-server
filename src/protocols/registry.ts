/**
 * Registry access — `getMeta` + zod validation + freshness warnings.
 *
 * Spec: docs/protocols-metadata-spec.md §4 registry validation + §6.
 *
 * At module load:
 *   1. Every entry is zod-validated. `_unknown` uses a relaxed schema that
 *      permits empty `sourceUrl` sentinels; all other entries require a real
 *      URL and ISO date.
 *   2. Entries with `sourceVerifiedOn > 180 days` emit a single stderr line
 *      per protocol. Never throws — staleness is a signal, not a fatal.
 */

import { PROTOCOL_METADATA } from "./metadata.js";
import { protocolMetaSchema } from "./types.js";
import type { ProtocolMeta } from "./types.js";

const STALENESS_WARN_DAYS = 180;

function collectVerifiedOnDates(meta: ProtocolMeta): string[] {
  const out: string[] = [];
  const wl = meta.stressSettlement.windowLabel;
  if (wl.sourceVerifiedOn) out.push(wl.sourceVerifiedOn);
  const t = meta.stressSettlement.settlementWindow.typical;
  if (t.sourceVerifiedOn) out.push(t.sourceVerifiedOn);
  const floor = meta.stressSettlement.settlementWindow.floor;
  if (floor?.sourceVerifiedOn) out.push(floor.sourceVerifiedOn);
  return out;
}

function daysSince(isoDate: string, nowMs: number): number {
  const t = Date.parse(isoDate + "T00:00:00Z");
  if (Number.isNaN(t)) return 0;
  return Math.floor((nowMs - t) / 86_400_000);
}

function validateAndWarn(): void {
  const strictSchema = protocolMetaSchema();
  const relaxedSchema = protocolMetaSchema({ allowEmptySource: true });
  const nowMs = Date.now();

  for (const [key, meta] of Object.entries(PROTOCOL_METADATA)) {
    const schema = key === "_unknown" ? relaxedSchema : strictSchema;
    const parsed = schema.safeParse(meta);
    if (!parsed.success) {
      throw new Error(
        `Protocol metadata invalid for "${key}": ${parsed.error.message}`,
      );
    }
    if (key === "_unknown") continue;
    const dates = collectVerifiedOnDates(meta);
    const oldest = dates.reduce((max, d) => Math.max(max, daysSince(d, nowMs)), 0);
    if (oldest > STALENESS_WARN_DAYS) {
      process.stderr.write(
        `[protocols/registry] stale metadata: ${key} sourceVerifiedOn is ${oldest}d old (threshold ${STALENESS_WARN_DAYS}d) — re-verify at source.\n`,
      );
    }
  }
}

validateAndWarn();

export function getMeta(name: string): ProtocolMeta {
  return PROTOCOL_METADATA[name] ?? PROTOCOL_METADATA._unknown;
}

/**
 * CamelCase API display-name → lowercase registry key.
 *
 * Verified across base/katana/flare/mainnet fixtures, April 27 2026.
 * Add new entries when fixtures surface new `position.ibt.protocol` values.
 */
export const PROTOCOL_NAME_ALIASES: Record<string, string> = {
  "Avant": "avant",
  "Pendle": "pendle",
  "Parallel Protocol": "parallel",
  "IPOR Fusion": "ipor_fusion",
  "Ether.fi": "ether_fi",
  "Firelight": "firelight",
  "Yearn": "yearn",
  "Aegis": "aegis",
  "Lucidly": "lucidly",
};

/**
 * Normalize a display-name protocol identifier to a registry-key shape.
 *
 * Trim semantics: input is `.trim()`-ed FIRST before alias lookup. The Spectra
 * API is not under our control; a stray space in `position.ibt.protocol` (e.g.
 * `"Avant "`) would otherwise bypass `PROTOCOL_NAME_ALIASES["Avant"]`, fall
 * through to `"avant_"`, and produce a false `_unknown` from `getMeta` — i.e.,
 * PR5 would fire "(registry: pending)" on a fully-mapped protocol. Caught by
 * Sonnet+soul depth-pass during Phase 0 audit (April 27, 2026).
 *
 * Lookup order:
 *   1. Trim whitespace.
 *   2. Empty (or whitespace-only) → return `""`. Caller's `getMeta` falls through
 *      to `_unknown`.
 *   3. Exact match in PROTOCOL_NAME_ALIASES (handles multi-word + special chars).
 *   4. Lowercase + spaces-to-underscores fallback.
 *
 * Dissolution: when a fixture surfaces a value not in the alias map AND the
 * lowercased version doesn't match a registry entry, add an explicit alias
 * here. metadata.ts:188-189 documents the 7-day prose dissolution intent;
 * runtime telemetry for alias-map drift is not yet wired (deferred to PR5).
 *
 * Known fragility (deferred to PR5 ship-time): the lowercase-fallback uses
 * `replace(/\s+/g, "_")` only — it does NOT replace dots. An API casing shift
 * like `"Ether.Fi"` (capital F) would lowercase-fold to `"ether.fi"` (literal
 * dot) and miss the registered key `"ether_fi"`. Caught by Diverger (April 27).
 */
export function normalizeProtocolName(displayName: string): string {
  const trimmed = displayName?.trim() ?? "";
  if (!trimmed) return "";
  if (PROTOCOL_NAME_ALIASES[trimmed]) return PROTOCOL_NAME_ALIASES[trimmed];
  return trimmed.toLowerCase().replace(/\s+/g, "_");
}
