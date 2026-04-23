/**
 * Core types + zod schemas for the protocols registry.
 *
 * Spec: docs/protocols-metadata-spec.md §3.
 *
 * The TS interfaces are the compile-time shape; the zod schemas run at registry
 * load time to refuse a legitimately-typed but semantically-wrong entry (e.g.
 * `SourcedValue<number>` for Avant's interpreted 7 — the compiler accepts it,
 * zod rejects it because `_unknown` is the only entry allowed to carry an
 * empty `sourceUrl` for a non-interpreted numeric).
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Value types — what's stated vs what's interpreted
// ────────────────────────────────────────────────────────────────────────────

export interface SourcedValue<T> {
  value: T;
  sourceUrl: string;
  sourceVerifiedOn: string;
}

export interface InterpretedValue<T> {
  value: T;
  interpretedFrom: SourcedValue<string>;
  interpretationNote: string;
  sourceVerifiedOn: string;
}

export type MaybeInterpretedValue<T> = SourcedValue<T> | InterpretedValue<T>;

// ────────────────────────────────────────────────────────────────────────────
// Render spec types
// ────────────────────────────────────────────────────────────────────────────

export type FormatHint = "pct100" | "pct1" | "usd" | "date" | "number" | "plain";

export interface FieldSpec {
  path: string;
  label?: string;
  format: FormatHint;
}

export type CostModelName =
  | "zero"
  | "lp_exit_samechain"
  | "lp_exit_crosschain_cctp"
  | "liquidation";

export type CostFn = (args: {
  amountUsd: number;
  poolLiquidityUsd?: number;
  stressMultiplier?: number;
}) => number;

export interface SettlementWindow {
  typical: MaybeInterpretedValue<number>;
  floor?: SourcedValue<number>;
  ceiling?: { value: "unknown"; reason: string };
}

export interface RenderContext {
  viewMode: "curator" | "consumer";
  seenProtocols?: Set<string>;
}

export interface ProtocolMeta {
  name: string;
  label: string;
  homeDocsUrl: string;
  oneSentenceIntro: string;

  display: {
    primaryTemplate: string;
    contextFields: readonly FieldSpec[];
  };

  stressSettlement: {
    windowLabel: MaybeInterpretedValue<string>;
    settlementWindow: SettlementWindow;
    costModel: CostModelName;
    stressExclude?: boolean;
  };

  actionItems?: {
    maturityFieldPath?: string;
    maturityThresholdsDays?: {
      urgent?: number;
      upcoming?: number;
      upcomingMax?: number;
    };
  };

  observationBoundaries: {
    unobservable: string[];
    mitigations?: string[];
    dissolution?: string[];
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Zod schemas — validate at registry load time
// ────────────────────────────────────────────────────────────────────────────

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "ISO date YYYY-MM-DD" });

/**
 * Factory: a `SourcedValue<T>` whose `sourceUrl` must be a real URL *unless*
 * the entry is `_unknown` (which uses empty sentinels). The registry passes
 * `allowEmptySource: true` only for the `_unknown` fallback; everything else
 * is rejected when the URL is missing.
 */
export function sourcedValueSchema<T extends z.ZodTypeAny>(
  inner: T,
  opts: { allowEmptySource?: boolean } = {},
): z.ZodType<SourcedValue<z.infer<T>>> {
  const urlSchema = opts.allowEmptySource
    ? z.string()
    : z.string().url();
  const dateSchema = opts.allowEmptySource
    ? z.string()
    : ISO_DATE;
  return z
    .object({
      value: inner,
      sourceUrl: urlSchema,
      sourceVerifiedOn: dateSchema,
    })
    .strict() as z.ZodType<SourcedValue<z.infer<T>>>;
}

export function interpretedValueSchema<T extends z.ZodTypeAny>(
  inner: T,
): z.ZodType<InterpretedValue<z.infer<T>>> {
  return z
    .object({
      value: inner,
      interpretedFrom: sourcedValueSchema(z.string()),
      interpretationNote: z.string().min(1),
      sourceVerifiedOn: ISO_DATE,
    })
    .strict() as z.ZodType<InterpretedValue<z.infer<T>>>;
}

export function maybeInterpretedValueSchema<T extends z.ZodTypeAny>(
  inner: T,
  opts: { allowEmptySource?: boolean } = {},
): z.ZodType<MaybeInterpretedValue<z.infer<T>>> {
  return z.union([
    sourcedValueSchema(inner, opts),
    interpretedValueSchema(inner),
  ]) as z.ZodType<MaybeInterpretedValue<z.infer<T>>>;
}

export const FormatHintSchema = z.enum([
  "pct100",
  "pct1",
  "usd",
  "date",
  "number",
  "plain",
]);

export const FieldSpecSchema = z
  .object({
    path: z.string().min(1),
    label: z.string().optional(),
    format: FormatHintSchema,
  })
  .strict();

export const CostModelNameSchema = z.enum([
  "zero",
  "lp_exit_samechain",
  "lp_exit_crosschain_cctp",
  "liquidation",
]);

export function settlementWindowSchema(
  opts: { allowEmptySource?: boolean } = {},
): z.ZodType<SettlementWindow> {
  return z
    .object({
      typical: maybeInterpretedValueSchema(z.number(), opts),
      floor: sourcedValueSchema(z.number(), opts).optional(),
      ceiling: z
        .object({
          value: z.literal("unknown"),
          reason: z.string().min(1),
        })
        .strict()
        .optional(),
    })
    .strict() as z.ZodType<SettlementWindow>;
}

export const RenderContextSchema = z
  .object({
    viewMode: z.enum(["curator", "consumer"]),
    seenProtocols: z.instanceof(Set).optional(),
  })
  .strict();

export function protocolMetaSchema(
  opts: { allowEmptySource?: boolean } = {},
): z.ZodType<ProtocolMeta> {
  return z
    .object({
      name: z.string().min(1),
      label: z.string().min(1),
      homeDocsUrl: opts.allowEmptySource ? z.string() : z.string().url(),
      oneSentenceIntro: z.string().min(1),
      display: z
        .object({
          primaryTemplate: z.string().min(1),
          contextFields: z.array(FieldSpecSchema).readonly(),
        })
        .strict(),
      stressSettlement: z
        .object({
          windowLabel: maybeInterpretedValueSchema(z.string(), opts),
          settlementWindow: settlementWindowSchema(opts),
          costModel: CostModelNameSchema,
          stressExclude: z.boolean().optional(),
        })
        .strict(),
      actionItems: z
        .object({
          maturityFieldPath: z.string().optional(),
          maturityThresholdsDays: z
            .object({
              urgent: z.number().optional(),
              upcoming: z.number().optional(),
              upcomingMax: z.number().optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
      observationBoundaries: z
        .object({
          unobservable: z.array(z.string()),
          mitigations: z.array(z.string()).optional(),
          dissolution: z.array(z.string()).optional(),
        })
        .strict(),
    })
    .strict() as z.ZodType<ProtocolMeta>;
}
