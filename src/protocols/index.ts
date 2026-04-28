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
  PointsMultiplier,
  PointsMultiplierScope,
  RolloverPolicy,
  VerifierConfig,
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

// Generic verifier dispatch (Theme E architecture):
export type {
  ProtocolVerifier,
  VerifierResult,
  ChainTruthMap,
} from "./verifier-types.js";
export {
  getVerifier,
  hasVerifier,
  listVerifierNames,
  listVerifiers,
} from "./verifier-registry.js";

// Avant verifier — exported for direct unit testing. Production callers
// (engine, metavault) consume via getVerifier("avant"); they never reference
// avant-specific symbols. To add a new protocol, implement ProtocolVerifier
// in a sibling file and register in verifier-registry.ts.
export {
  verifyAvantPosition,
  formatAvantVerification,
  decodeBurnRequest,
  avantVerifier,
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

// Pendle verifier — exported for direct unit testing. Production callers
// consume via getVerifier("pendle"); see avant-verifier comment above for
// the dispatch contract.
export {
  verifyPendlePosition,
  formatPendleVerification,
  decodePendleMarketState,
  chainIdToSlug,
  pendleVerifier,
  PENDLE_MARKET_SELECTORS,
  PENDLE_VERIFY_TIMEOUT_MS,
} from "./pendle-verifier.js";
export type {
  PendleVerification,
  PendleVerificationOk,
  PendleVerificationFailed,
} from "./pendle-verifier.js";
