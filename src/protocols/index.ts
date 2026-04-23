/**
 * Protocols registry — barrel export.
 *
 * Spec: docs/protocols-metadata-spec.md §2 + §6.
 */

export type {
  SourcedValue,
  InterpretedValue,
  MaybeInterpretedValue,
  FieldSpec,
  FormatHint,
  CostModelName,
  CostFn,
  SettlementWindow,
  RenderContext,
  ProtocolMeta,
} from "./types.js";

export {
  sourcedValueSchema,
  interpretedValueSchema,
  maybeInterpretedValueSchema,
  FormatHintSchema,
  FieldSpecSchema,
  CostModelNameSchema,
  settlementWindowSchema,
  RenderContextSchema,
  protocolMetaSchema,
} from "./types.js";

export { PROTOCOL_METADATA } from "./metadata.js";
export { COST_MODELS } from "./cost-models.js";
export {
  renderExternalPosition,
  classifyForStress,
  generateActionItems,
  describeProtocolWindow,
  effectiveValueAsString,
  DriftCollector,
} from "./engine.js";
export type {
  TypedExternalPosition,
  StressClassification,
  DriftWarning,
} from "./engine.js";
export { getMeta } from "./registry.js";
