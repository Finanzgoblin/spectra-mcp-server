/**
 * PROTOCOL_METADATA registry.
 *
 * Spec: docs/protocols-metadata-spec.md §4.
 *
 * Three entries in Phase 1: `avant`, `pendle`, `_unknown`. Every numeric
 * constant that doesn't appear verbatim in a cited source is typed as
 * `InterpretedValue<T>` to protect against attribution creep (a protocol
 * team reading "we pin 7 days" when their docs say "one week").
 */

import type { ProtocolMeta, SourcedValue, InterpretedValue } from "./types.js";

const AVANT_COOLDOWN_DOCS = "https://docs.avantprotocol.com/overview/core-tokens#avusdx";
const PENDLE_AMM_DOCS = "https://docs.pendle.finance/ProtocolMechanics/Mechanisms/AMM";

export const PROTOCOL_METADATA: Record<string, ProtocolMeta> = {
  avant: {
    name: "avant",
    label: "avant",
    homeDocsUrl: "https://docs.avantprotocol.com",
    oneSentenceIntro:
      "Avant's avUSDx is a yield-bearing wrapper of avUSD; redemption burns the wrapper and queues the underlying for a ~1-week cooldown before claim.",
    display: {
      primaryTemplate: "burn:{burnt.symbol} → claim:{claim.symbol}",
      contextFields: [
        { path: "orderId", label: "order", format: "number" },
        { path: "source", format: "plain" },
      ],
    },
    stressSettlement: {
      windowLabel: {
        value: "one-week cooldown per Avant docs",
        sourceUrl: AVANT_COOLDOWN_DOCS,
        sourceVerifiedOn: "2026-04-23",
      } satisfies SourcedValue<string>,
      settlementWindow: {
        typical: {
          value: 7,
          interpretedFrom: {
            value: "requires a burn request, which initiates a one-week cooldown period",
            sourceUrl: AVANT_COOLDOWN_DOCS,
            sourceVerifiedOn: "2026-04-23",
          },
          interpretationNote:
            "One week interpreted as 7 calendar days. Avant's prose is nominal-path; operational variance under queue pressure is unobserved.",
          sourceVerifiedOn: "2026-04-23",
        } satisfies InterpretedValue<number>,
        floor: {
          value: 7,
          sourceUrl: AVANT_COOLDOWN_DOCS,
          sourceVerifiedOn: "2026-04-23",
        } satisfies SourcedValue<number>,
        ceiling: {
          value: "unknown",
          reason:
            "Queue depth under stress not exposed in Avant's public API; extended waits possible during redemption spikes.",
        },
      },
      costModel: "zero",
    },
    // No actionItems — `updatedAt` on externalPositions[] is indexer-write time,
    // not submission time, so maturity thresholds cannot be computed honestly.
    observationBoundaries: {
      unobservable: [
        "Burn submission block timestamp (Avant exposes only indexer snapshot time)",
        "Queue position relative to Avant's current head orderId",
        "Per-order expected settlement time under stress (only nominal 1-week is guaranteed)",
      ],
      mitigations: [
        "For submission timestamp: query Avant's redemption contract on Avalanche via RPC (contract addresses in Avant docs § Core Tokens).",
        "For queue position: fetch current head orderId from Avant's contract and compare against position's orderId (delta approximates queue depth).",
        "For stress-path timing: monitor Avant's redemption completion events over a rolling window; skew from nominal indicates queue pressure.",
      ],
      dissolution: [
        "Avant changes cooldown window from 1 week (re-verify + update interpretationNote)",
        "New Avant source types appear beyond 'avusdx-burn' (new contextFields needed)",
      ],
    },
  },

  pendle: {
    name: "pendle",
    label: "pendle",
    homeDocsUrl: "https://docs.pendle.finance",
    oneSentenceIntro:
      "Pendle LP provides liquidity to a Pendle market; exit is instant via AMM swap but incurs price impact sized by pool depth.",
    display: {
      primaryTemplate: "{market.name}",
      contextFields: [
        { path: "market.maturity", label: "matures", format: "date" },
        // `market.aggregatedApy` is decimal (0.085) in raw externalPositions[] —
        // `pct100` multiplies by 100. Engine consumes the raw path, NOT the
        // pre-multiplied `pendleEnrichment` map (HS-1).
        { path: "market.aggregatedApy", label: "LP APY", format: "pct100" },
      ],
    },
    stressSettlement: {
      windowLabel: {
        value: "instant AMM exit with price impact",
        sourceUrl: PENDLE_AMM_DOCS,
        sourceVerifiedOn: "2026-04-23",
      } satisfies SourcedValue<string>,
      settlementWindow: {
        typical: {
          value: 0,
          sourceUrl: PENDLE_AMM_DOCS,
          sourceVerifiedOn: "2026-04-23",
        } satisfies SourcedValue<number>,
      },
      costModel: "lp_exit_samechain",
      stressExclude: true,
    },
    actionItems: {
      maturityFieldPath: "market.maturity",
      maturityThresholdsDays: { urgent: 7, upcoming: 14, upcomingMax: 30 },
    },
    observationBoundaries: {
      unobservable: [
        "Current Pendle pool depth at exit time (snapshot liquidity used)",
        "vePENDLE boost applicable to this curator at exit",
      ],
      mitigations: [
        "For live depth: query Pendle's market contract via `getReserves()` or use the Pendle API's live market endpoint.",
        "For vePENDLE boost: read the curator's vePENDLE balance from Ethereum mainnet and apply Pendle's boost formula.",
      ],
      dissolution: [
        "Pendle adds post-maturity settlement delay",
        "Pendle emissions structure changes such that aggregatedApy becomes misleading beyond current prose note",
      ],
    },
  },

  _unknown: {
    name: "_unknown",
    label: "?",
    homeDocsUrl: "",
    oneSentenceIntro:
      "An externalPosition protocol that this registry has not yet mapped. Value is visible; shape is not interpreted.",
    display: {
      primaryTemplate: "⚠ UNMAPPED PROTOCOL — position renders raw; see drift footer",
      contextFields: [],
    },
    stressSettlement: {
      windowLabel: {
        value: "unknown — excluded from all stress tiers",
        sourceUrl: "",
        sourceVerifiedOn: "2026-04-23",
      } satisfies SourcedValue<string>,
      settlementWindow: {
        typical: {
          value: 0,
          sourceUrl: "",
          sourceVerifiedOn: "2026-04-23",
        } satisfies SourcedValue<number>,
        ceiling: {
          value: "unknown",
          reason: "No metadata entry; all settlement properties unobserved.",
        },
      },
      costModel: "zero",
      stressExclude: true,
    },
    observationBoundaries: {
      unobservable: ["Everything protocol-specific — no metadata registered"],
      mitigations: [
        "Author a metadata entry per PR template surfaced by DriftCollector.aggregate(). Required fields are enforced by zod at registry load.",
      ],
      dissolution: [
        "A protocol rendered via _unknown for >7 days in live data MUST have a metadata entry authored (DS-2 trigger)",
      ],
    },
  },
};
