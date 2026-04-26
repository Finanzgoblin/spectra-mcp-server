/**
 * Engine — pure functions that consume PROTOCOL_METADATA.
 *
 * Spec: docs/protocols-metadata-spec.md §6.
 *
 * API surfaces:
 *   - renderExternalPosition(ext, tvlUsd, ctx, drift?)   — consumer- or curator-shaped line
 *   - classifyForStress(ext, vaultHomeChainId)           — tier + cost-model resolution
 *   - generateActionItems(ext, nowMs)                    — maturity threshold alerts
 *   - describeProtocolWindow(protocolName)               — prose binding helper (PR2b)
 *   - effectiveValueAsString(v)                          — MaybeInterpretedValue<T> → string
 *   - DriftCollector                                     — per-call aggregation of _unknown hits
 */

import { PROTOCOL_METADATA } from "./metadata.js";
import { COST_MODELS } from "./cost-models.js";
import type {
  FieldSpec,
  CostModelName,
  MaybeInterpretedValue,
  ProtocolMeta,
  RenderContext,
  SettlementWindow,
} from "./types.js";
import { formatUsd, formatPct, formatDate } from "../primitives.js";
import {
  type AvantVerification,
  formatAvantVerification,
} from "./avant-verifier.js";

// ────────────────────────────────────────────────────────────────────────────
// Drift visibility — read once at module load. Silent default; tests/CI set loud.
// ────────────────────────────────────────────────────────────────────────────

const DRIFT_VISIBILITY: "silent" | "loud" =
  (process.env.DRIFT_VISIBILITY === "loud" ? "loud" : "silent");

// ────────────────────────────────────────────────────────────────────────────
// Minimal `ext` shape this engine consumes. Kept deliberately loose — the spine
// is `protocol + chainId + valueUsd`, everything else flows through the
// template resolver via dot-paths.
// ────────────────────────────────────────────────────────────────────────────

export interface TypedExternalPosition {
  protocol: string;
  chainId?: number;
  valueUsd?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface StressClassification {
  costModelName: CostModelName;
  settlementDaysTypical: number | "unknown";
  stressExclude: boolean;
  windowLabelRendered: string;
}

/**
 * Per-position chain-truth verification result map (Theme E first slice).
 *
 * The engine itself never makes RPC calls — verifications are computed at
 * the tool boundary (where flags + concurrency control + per-call timeouts
 * live) and passed in pre-resolved. This keeps the engine purely synchronous
 * and unit-testable without RPC mocking, mirroring the Phase-2 chain-truth
 * footer pattern.
 *
 * Map keys: `<protocol>:<id>` lowercased. Today only avant uses
 * `avant:<requestId>`. Pendle externals etc. would extend this with their
 * own protocol-prefixed keys in subsequent slices.
 */
export interface ExternalChainTruthMap {
  avant?: Map<number, AvantVerification>;
}

// ────────────────────────────────────────────────────────────────────────────
// Value extraction
// ────────────────────────────────────────────────────────────────────────────

export function effectiveValueAsString<T>(v: MaybeInterpretedValue<T>): string {
  return String(v.value);
}

function lookupByDotPath(root: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function formatByHint(raw: unknown, hint: FieldSpec["format"]): string {
  if (raw == null) return missingToken("");
  if (hint === "plain") return String(raw);
  // Non-finite coercion must render as missing, not crash (formatDate) or leak
  // "NaN"/"Infinity" literals (formatPct/formatUsd/String). Upstream API drift
  // can deliver NaN maturity or undefined-coerced numerics; treat as absent.
  const n = Number(raw);
  if (!Number.isFinite(n)) return missingToken("");
  switch (hint) {
    case "pct100":
      return formatPct(n * 100);
    case "pct1":
      return formatPct(n);
    case "usd":
      return formatUsd(n);
    case "date":
      return formatDate(n);
    case "number":
      return String(n);
  }
}

function missingToken(path: string): string {
  return DRIFT_VISIBILITY === "loud" ? `[MISSING:${path}]` : "?";
}

// ────────────────────────────────────────────────────────────────────────────
// Template resolver — single-brace {path}, `{{` for literal `{`.
// Precompiled once per template at module load over the frozen metadata set.
// ────────────────────────────────────────────────────────────────────────────

export type TemplateSegment =
  | { kind: "literal"; text: string }
  | { kind: "field"; path: string };

export function compileTemplate(template: string): TemplateSegment[] {
  const out: TemplateSegment[] = [];
  let i = 0;
  let buf = "";
  while (i < template.length) {
    const c = template[i];
    if (c === "{" && template[i + 1] === "{") {
      buf += "{";
      i += 2;
      continue;
    }
    if (c === "{") {
      if (buf.length > 0) {
        out.push({ kind: "literal", text: buf });
        buf = "";
      }
      const end = template.indexOf("}", i + 1);
      if (end === -1) {
        // Unterminated — treat the rest as literal.
        buf += template.slice(i);
        i = template.length;
        break;
      }
      const path = template.slice(i + 1, end);
      out.push({ kind: "field", path });
      i = end + 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  if (buf.length > 0) out.push({ kind: "literal", text: buf });
  return out;
}

const COMPILED_TEMPLATES: Map<string, TemplateSegment[]> = (() => {
  const m = new Map<string, TemplateSegment[]>();
  for (const meta of Object.values(PROTOCOL_METADATA)) {
    m.set(meta.name, compileTemplate(meta.display.primaryTemplate));
  }
  return m;
})();

function renderTemplate(meta: ProtocolMeta, ext: TypedExternalPosition): string {
  const segs = COMPILED_TEMPLATES.get(meta.name) ?? compileTemplate(meta.display.primaryTemplate);
  let out = "";
  for (const s of segs) {
    if (s.kind === "literal") {
      out += s.text;
    } else {
      const raw = lookupByDotPath(ext, s.path);
      out += raw == null ? missingToken(s.path) : String(raw);
    }
  }
  return out;
}

function renderContextFields(fields: readonly FieldSpec[], ext: TypedExternalPosition): string {
  if (fields.length === 0) return "";
  const parts: string[] = [];
  for (const f of fields) {
    const raw = lookupByDotPath(ext, f.path);
    const rendered = raw == null ? missingToken(f.path) : formatByHint(raw, f.format);
    parts.push(f.label ? `${f.label}=${rendered}` : rendered);
  }
  return parts.join(" | ");
}

// ────────────────────────────────────────────────────────────────────────────
// Freshness suffix
// ────────────────────────────────────────────────────────────────────────────

function daysSince(isoDate: string, nowMs: number = Date.now()): number {
  if (!isoDate) return Infinity;
  const t = Date.parse(isoDate + "T00:00:00Z");
  if (Number.isNaN(t)) return Infinity;
  return Math.floor((nowMs - t) / 86_400_000);
}

function renderFreshnessSuffix(meta: ProtocolMeta): string {
  if (meta.name === "_unknown") return "";
  const iso = meta.stressSettlement.windowLabel.sourceVerifiedOn;
  const age = daysSince(iso);
  if (age > 90 && iso) return ` (verified ${iso})`;
  return "";
}

// ────────────────────────────────────────────────────────────────────────────
// Settlement window rendering (consumer mode)
// ────────────────────────────────────────────────────────────────────────────

function renderSettlementRange(w: SettlementWindow): string {
  const typical = effectiveValueAsString(w.typical);
  const parts: string[] = [];
  if (w.floor) parts.push(`floor ${w.floor.value}d`);
  if (w.ceiling) parts.push(`ceiling ${w.ceiling.value} — ${w.ceiling.reason}`);
  if (parts.length === 0) return `~${typical}d`;
  return `~${typical}d (${parts.join("; ")})`;
}

// ────────────────────────────────────────────────────────────────────────────
// Public: renderExternalPosition
// ────────────────────────────────────────────────────────────────────────────

export function renderExternalPosition(
  ext: TypedExternalPosition,
  tvlUsd: number,
  ctx: RenderContext,
  driftCollector?: DriftCollector,
  chainTruth?: ExternalChainTruthMap,
): string {
  const meta = PROTOCOL_METADATA[ext.protocol] ?? PROTOCOL_METADATA._unknown;
  const isUnknown = meta.name === "_unknown";

  if (isUnknown && driftCollector) {
    driftCollector.record(ext.protocol, ext);
  }

  const primary = renderTemplate(meta, ext);
  const context = renderContextFields(meta.display.contextFields, ext);
  const valueStr = typeof ext.valueUsd === "number" ? formatUsd(ext.valueUsd) : missingToken("valueUsd");

  const shareSuffix =
    tvlUsd > 0 && typeof ext.valueUsd === "number"
      ? ` (${formatPct((ext.valueUsd / tvlUsd) * 100)})`
      : "";

  // Unknown protocols render loud inline warning, then raw valueUsd. Consumers
  // reading a drift footer won't reconcile it with a specific position — the
  // warning must be AT the line.
  if (isUnknown) {
    const line = `${primary} — ${valueStr}${shareSuffix} [protocol=${ext.protocol}]`;
    return line;
  }

  const lead: string[] = [];
  if (ctx.viewMode === "consumer") {
    const seen = ctx.seenProtocols ?? new Set<string>();
    if (!seen.has(meta.name)) {
      lead.push(meta.oneSentenceIntro);
      if (ctx.seenProtocols) ctx.seenProtocols.add(meta.name);
    }
  }

  const settlement =
    ctx.viewMode === "consumer"
      ? renderSettlementRange(meta.stressSettlement.settlementWindow)
      : `~${effectiveValueAsString(meta.stressSettlement.settlementWindow.typical)}d`;

  const freshness = ctx.viewMode === "curator" ? renderFreshnessSuffix(meta) : "";

  // `settle ~Nd` is appended in both viewModes. The VALUE is spec-licensed
  // (§0 SU-3 allows curator nominal-only render); the WORD and position are
  // builder-chosen and now load-bearing in snapshot tests. Revisit if a
  // curator reports the suffix as noise in dashboard output — the suffix
  // can become viewMode-conditional at that point without touching any
  // metadata entry (wave-2 hyperyellow finding).
  const body = context
    ? `${meta.label}: ${primary} — ${valueStr}${shareSuffix} | ${context} | settle ${settlement}${freshness}`
    : `${meta.label}: ${primary} — ${valueStr}${shareSuffix} | settle ${settlement}${freshness}`;

  // Chain-truth augmentation (Theme E first slice). Avant only this slice;
  // pendle verifier is a separate next-session slice. When the caller
  // provides a verification result, append it as a separate line under the
  // body. When no entry is present (off-flag, or per-position fetch
  // failure that wasn't even attempted), the line is omitted — render
  // stays identical to the pre-flag default.
  let chainTruthLine = "";
  if (chainTruth?.avant && meta.name === "avant") {
    const requestIdRaw = ext.requestId;
    const requestId = typeof requestIdRaw === "number" ? requestIdRaw : null;
    if (requestId != null) {
      const v = chainTruth.avant.get(requestId);
      if (v) {
        const expectedProvider = typeof ext.provider === "string" ? ext.provider : undefined;
        const burnt = ext.burnt as { balance?: string } | undefined;
        let expectedAmountWei: bigint | undefined;
        if (burnt && typeof burnt.balance === "string") {
          try {
            expectedAmountWei = BigInt(burnt.balance);
          } catch {
            expectedAmountWei = undefined;
          }
        }
        chainTruthLine = "\n    " + formatAvantVerification(v, expectedProvider, expectedAmountWei);
      }
    }
  }

  const fullBody = body + chainTruthLine;
  return lead.length > 0 ? `${lead.join(" ")}\n${fullBody}` : fullBody;
}

// ────────────────────────────────────────────────────────────────────────────
// classifyForStress — tier + cost-model resolution
// ────────────────────────────────────────────────────────────────────────────

const CCTP_PROTOCOLS: ReadonlySet<string> = new Set(["avant", "pendle"]);

export function classifyForStress(
  ext: TypedExternalPosition,
  vaultHomeChainId: number,
): StressClassification {
  const meta = PROTOCOL_METADATA[ext.protocol] ?? PROTOCOL_METADATA._unknown;
  let costModelName = meta.stressSettlement.costModel;

  const isCrossChain =
    typeof ext.chainId === "number" && ext.chainId !== vaultHomeChainId;

  if (
    costModelName === "lp_exit_samechain" &&
    isCrossChain &&
    CCTP_PROTOCOLS.has(meta.name)
  ) {
    costModelName = "lp_exit_crosschain_cctp";
  }

  // Runtime guard beyond the narrow union (HS-2). The union protects the
  // compiler; this protects runtime drift when metadata gets edited.
  if (!COST_MODELS[costModelName]) {
    throw new Error(`Unknown cost model: ${costModelName}`);
  }

  const typical = meta.stressSettlement.settlementWindow.typical.value;
  const ceiling = meta.stressSettlement.settlementWindow.ceiling;
  const settlementDaysTypical: number | "unknown" =
    ceiling?.value === "unknown" && meta.name === "_unknown"
      ? "unknown"
      : typical;

  const windowLabelRendered = effectiveValueAsString(meta.stressSettlement.windowLabel);

  return {
    costModelName,
    settlementDaysTypical,
    stressExclude: meta.stressSettlement.stressExclude ?? false,
    windowLabelRendered,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// generateActionItems — maturity threshold emitter
// ────────────────────────────────────────────────────────────────────────────

export function generateActionItems(
  ext: TypedExternalPosition,
  nowMs: number,
): string[] {
  const meta = PROTOCOL_METADATA[ext.protocol];
  const ai = meta?.actionItems;
  if (!ai?.maturityFieldPath) return [];

  const raw = lookupByDotPath(ext, ai.maturityFieldPath);
  if (raw == null) return [];
  const tsSec = Number(raw);
  if (!Number.isFinite(tsSec)) return [];

  const nowSec = Math.floor(nowMs / 1000);
  const deltaDays = (tsSec - nowSec) / 86400;

  const t = ai.maturityThresholdsDays ?? {};
  const urgent = t.urgent ?? 7;
  const upcoming = t.upcoming ?? 14;
  const upcomingMax = t.upcomingMax ?? 30;

  const tag = meta.label.toUpperCase();

  if (deltaDays < 0) return [`[${tag}-EXT EXPIRED]`];
  if (deltaDays <= urgent) return [`[${tag}-EXT URGENT]`];
  if (deltaDays <= upcoming) return [`[${tag}-EXT UPCOMING]`];
  if (deltaDays <= upcomingMax) return [`[${tag}-EXT UPCOMING]`];
  return [];
}

// ────────────────────────────────────────────────────────────────────────────
// describeProtocolWindow — prose binding helper (PR2b)
// ────────────────────────────────────────────────────────────────────────────

export function describeProtocolWindow(protocolName: string): string {
  const meta = PROTOCOL_METADATA[protocolName] ?? PROTOCOL_METADATA._unknown;
  return effectiveValueAsString(meta.stressSettlement.windowLabel);
}

// ────────────────────────────────────────────────────────────────────────────
// DriftCollector — per-call aggregation, never singleton
// ────────────────────────────────────────────────────────────────────────────

export interface DriftWarning {
  protocol: string;
  count: number;
  sampleFields: string[];
}

export class DriftCollector {
  private readonly byProtocol: Map<string, { count: number; fields: Set<string> }> = new Map();

  record(protocolName: string, position: TypedExternalPosition): void {
    const entry = this.byProtocol.get(protocolName) ?? { count: 0, fields: new Set<string>() };
    entry.count += 1;
    for (const k of Object.keys(position)) {
      if (k !== "protocol") entry.fields.add(k);
    }
    this.byProtocol.set(protocolName, entry);
  }

  aggregate(): DriftWarning[] {
    const out: DriftWarning[] = [];
    for (const [protocol, { count, fields }] of this.byProtocol) {
      out.push({ protocol, count, sampleFields: Array.from(fields).sort() });
    }
    out.sort((a, b) => a.protocol.localeCompare(b.protocol));
    return out;
  }
}
