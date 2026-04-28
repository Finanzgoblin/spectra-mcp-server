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

/**
 * PointsMultiplier — a single points-program entry (PR-L of hardcode-vs-generalize-spec.md, §3).
 *
 * Captures the originating scar (Avant points 40x for LPs / 60x for YT holders rendered via
 * inline literals across many sites). The class:
 *   - `program`: name of the points program (e.g., "Avant points")
 *   - `scope`: which holder class earns it ("lp" / "yt" / "vault")
 *   - `amount`: the multiplier (40 = "40x")
 *   - `source`: SourcedValue OR InterpretedValue for `amount` — provenance chain
 *   - `validUntil?`: ISO date — when set, render `[stale since X]` past it
 *
 * Invariant (R2-BL-6, zod-enforced): `source.value === amount`. Drift between the
 * cited source and the rendered amount is annotated `[CLAIMED:X, OBSERVED:Y]` at
 * the consumer; the class itself doesn't accept the discrepancy silently.
 */
export type PointsMultiplierScope = "lp" | "yt" | "vault";

export interface PointsMultiplier {
  program: string;
  scope: PointsMultiplierScope;
  amount: number;
  source: MaybeInterpretedValue<number>;
  /** ISO date `YYYY-MM-DD`. When past, render `[stale since X]` suffix. */
  validUntil?: string;
}

/**
 * 6-way rolloverPolicy enum (P7-BL-4 of hardcode-vs-generalize-spec.md):
 *
 * - `auto`: protocol auto-rolls (e.g., Spectra MetaVault auto-rollover)
 * - `manual_to_successor`: holder must manually roll to a successor (e.g., Pendle next-maturity PT)
 * - `redeem_to_underlying`: burn → cooldown → claim same underlying (e.g., Avant)
 * - `expire_to_lp_share`: position expires into an LP share with no burn/cooldown (hypothetical Cork-style)
 * - `redeem_no_cooldown`: instant burn-to-stable (hypothetical)
 * - `unknown`: catch-all for `_unknown` and protocols whose policy isn't yet observed
 *
 * The 6-way enum captures architecturally-distinct settlement semantics. Adding a 7th category triggers
 * dissolution per spec §10.
 */
export type RolloverPolicy =
  | "auto"
  | "manual_to_successor"
  | "redeem_to_underlying"
  | "expire_to_lp_share"
  | "redeem_no_cooldown"
  | "unknown";

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
    /**
     * P7-BL-4 of hardcode-vs-generalize-spec.md: dissolves the
     * `engine.ts:317 CCTP_PROTOCOLS` ReadonlySet hardcode. When `true`, a
     * cross-chain `lp_exit_samechain` cost-model resolves to
     * `lp_exit_crosschain_cctp` per `classifyForStress`.
     */
    useCctp?: boolean;
  };

  actionItems?: {
    maturityFieldPath?: string;
    maturityThresholdsDays?: {
      urgent?: number;
      upcoming?: number;
      upcomingMax?: number;
    };
  };

  /**
   * Protocol's YT fee rate (decimal, e.g. 0.05 = 5%) charged on YT yield.
   * REQUIRED for non-`_unknown` protocols (zod-enforced at registry load).
   * Undefined for `_unknown` → `formatYTFeeLabel` renders `"?% on YT yield"`.
   * NEVER `0` for non-`_unknown` (would silently lie about ammunition value).
   */
  ytFeeRate?: SourcedValue<number>;

  /**
   * Short tag used in compact renders (e.g. `"[A]"` for Avant, `"[P]"` for Pendle).
   * Optional; consumers fall back to first-letter-uppercase of `meta.label` when absent.
   */
  shortTag?: string;

  /** 6-way enum capturing settlement semantics. See `RolloverPolicy` doc. */
  rolloverPolicy?: RolloverPolicy;

  /**
   * Per-protocol points-program multipliers. PR-L of hardcode-vs-generalize-spec.md
   * (originating scar). When position-side multipliers are missing/empty, consumers
   * fall back to this metadata via `formatPointsMultipliers` (with `[REFERENCE-ONLY]`
   * prefix when position is expired/in-cooldown).
   */
  pointsMultipliers?: PointsMultiplier[];

  /**
   * Per-protocol verifier configuration (PR-G of hardcode-vs-generalize-spec.md).
   *
   * Centralizes the inputs that verifier implementations currently hardcode in
   * their own files (timeout, drift tolerance, on-chain contract addresses by
   * chainId). Cross-validation lives in `verifier-registry.ts` (R2-BL-4): every
   * registered verifier must have `meta.verifier.contracts` populated, otherwise
   * registry-load throws.
   *
   * Adding a multi-chain Avant deployment = one row addition to `contracts`,
   * not a verifier-code edit.
   */
  verifier?: VerifierConfig;

  observationBoundaries: {
    unobservable: string[];
    mitigations?: string[];
    dissolution?: string[];
  };
}

/**
 * Verifier configuration shape (PR-G).
 *
 * - `timeoutMs`: per-call timeout for the on-chain verification (default 15s).
 * - `amountDriftTolerancePpm`: PPM-bounded tolerance for amount-comparison drift.
 *   bigint to preserve precision against on-chain decimals (token-amount math
 *   loses precision in JS number).
 * - `contracts`: per-chain dict of role-name → contract address. Roles like
 *   `requestManager`, `marketState`, etc. are protocol-specific and
 *   self-documented at the verifier site.
 */
export interface VerifierConfig {
  timeoutMs: number;
  amountDriftTolerancePpm: bigint;
  contracts: Record<string, Record<string, string>>;
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
          useCctp: z.boolean().optional(),
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
      // ytFeeRate: REQUIRED for non-`_unknown` (BL-1 of hardcode-vs-generalize-spec.md).
      // For `_unknown`, the relaxed schema (allowEmptySource: true) makes it optional,
      // so `_unknown.ytFeeRate` is undefined → `formatYTFeeLabel` renders "?% on YT yield".
      ytFeeRate: opts.allowEmptySource
        ? sourcedValueSchema(z.number(), opts).optional()
        : sourcedValueSchema(z.number()),
      shortTag: z.string().min(1).optional(),
      rolloverPolicy: z
        .enum([
          "auto",
          "manual_to_successor",
          "redeem_to_underlying",
          "expire_to_lp_share",
          "redeem_no_cooldown",
          "unknown",
        ])
        .optional(),
      // PR-L: pointsMultipliers + R2-BL-6 invariant `source.value === amount`.
      // Enforced via .superRefine across the array — if any entry violates,
      // registry-load throws.
      pointsMultipliers: z
        .array(
          z
            .object({
              program: z.string().min(1),
              scope: z.enum(["lp", "yt", "vault"]),
              amount: z.number(),
              source: maybeInterpretedValueSchema(z.number(), opts),
              validUntil: ISO_DATE.optional(),
            })
            .strict()
            .refine((pm) => pm.source.value === pm.amount, {
              message: "PointsMultiplier invariant: source.value must equal amount (R2-BL-6)",
            }),
        )
        .optional(),
      // PR-G: verifier config. Consumers that register a ProtocolVerifier must
      // populate this; cross-validation in `verifier-registry.ts` enforces the
      // contract at module-load.
      verifier: z
        .object({
          timeoutMs: z.number().int().positive(),
          amountDriftTolerancePpm: z.bigint(),
          contracts: z.record(z.string(), z.record(z.string(), z.string())),
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
