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
