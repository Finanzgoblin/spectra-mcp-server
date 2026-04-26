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
  ExternalChainTruthMap,
} from "./engine.js";
export { getMeta } from "./registry.js";
export {
  verifyAvantPosition,
  formatAvantVerification,
  decodeBurnRequest,
  AVANT_REQUESTS_MANAGER_AVAX,
  AVANT_SELECTORS,
  AVANT_REQUEST_STATE,
  AVANT_VERIFY_TIMEOUT_MS,
} from "./avant-verifier.js";
export type {
  AvantVerification,
  AvantVerificationOk,
  AvantVerificationFailed,
  AvantRequestState,
} from "./avant-verifier.js";
