/**
 * Tools: get_metavaults, model_metavault_strategy
 *
 * get_metavaults — Discovery tool for live MetaVaults from the Spectra API.
 * Lists all MetaVaults across chains with curator info, TVL, APY, and positions.
 *
 * model_metavault_strategy — Strategy modeler for MetaVault "double loop" economics.
 * Can auto-populate from live API data when chain + metavault_address are provided,
 * or run in pure computational mode with manual parameters.
 *
 * Dual Morpho Market Strategy for Curators:
 *
 *   Market A — PT / underlying (e.g. PT-ibUSDC / USDC):
 *     For external users. Users buy PT on Spectra, deposit as Morpho collateral,
 *     borrow underlying, buy more PT, loop. Drives PT demand, pool volume, and
 *     LP fee revenue. The curator can also supply the lending side (earn borrow rate
 *     on idle capital). This is the growth engine — it creates the flywheel.
 *
 *   Market B — MetaVault shares / underlying (e.g. MV-ibUSDC / USDC):
 *     For the curator (and sophisticated depositors). MetaVault shares are deposited
 *     as Morpho collateral, borrow underlying, deposit back into the vault, loop.
 *     This multiplies the curator's own capital efficiency. This is the capital
 *     efficiency play — it amplifies the curator's yield and fee revenue.
 *
 *   The two markets reinforce each other:
 *     1. Market A drives PT buying demand → more volume → more LP fees
 *     2. Higher LP fees boost the MetaVault base APY
 *     3. Curator loops MV shares (Market B) → deepens pool liquidity
 *     4. Deeper liquidity attracts more PT loopers (Market A)
 *     5. More external deposits into the vault → more fee revenue for the curator
 *
 * Curator Fee Model:
 *   The curator EARNS the performance fee (curator_fee_pct) on vault yield
 *   generated for external depositors. This is the curator's revenue stream
 *   for managing the vault — rolling LP positions, compounding YT, and
 *   maintaining allocations. Net Vault APY shown is what depositors receive
 *   AFTER the curator's fee has been deducted.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MetavaultLoopRow, MetavaultCuratorEconomics, SpectraMetavault } from "../types.js";
import { CHAIN_ENUM, EVM_ADDRESS, SUPPORTED_CHAINS } from "../config.js";
import { fetchMetavaults, fetchMetavaultsWithWarnings, scanAllMetavaults, fetchChainPoolAddresses, fetchMerklCampaigns, fetchPendleMarketDetail, lookupMerklCampaigns, fetchMerkl, parseMerklRewards } from "../api.js";
import type { MerklCampaign } from "../types.js";
import {
  formatPct,
  formatUsd,
  formatDate,
  daysToMaturity,
  cumulativeLeverageAtLoop,
  formatMetavaultStrategy,
  formatMetavaultList,
  formatCuratorDashboard,
  formatChainTruthFooter,
  CROSS_TOOL_THRESHOLDS,
} from "../formatters.js";
// PR-C: action-item prefix dispatch — replaces inline `[STATUS]` / `[OUTFLOWS]` /
// `[BRIDGE]` / `[INCENTIVE]` literals with central registry calls. The maturity
// emit-sites in this file (lines ~1071-1077) are NOT migrated here; PR-B1
// handles those with full rolloverPolicy-aware `formatMaturityActionItem`.
import { formatActionItemPrefix } from "../action-items/types.js";
import type { CuratorDashboardOpts, ChainTruthSummaryResult } from "../formatters.js";
import { generateActionItems } from "../protocols/engine.js";
import type { TypedExternalPosition, ExternalChainTruthMap } from "../protocols/engine.js";
import { getVerifier } from "../protocols/verifier-registry.js";
import type { ProtocolVerifier, VerifierResult } from "../protocols/verifier-types.js";
import { readMetaVaultChainStateCached, projectChainReadInput } from "../chain-reads.js";
// PR7a (discard-layer-spec): performance metrics moved to src/performance.ts.
// Functions were previously module-private; the export-refactor enables
// `formatMetavaultSummary` (in formatters.ts) to import the one-line variant
// without forming a tools/ → formatters/ dependency cycle.
import { computePerformanceMetrics, formatPerformanceMetrics } from "../performance.js";

function computeLoopRows(
  baseApy: number,
  borrowRate: number,
  morphoLtv: number,
  maxLoops: number,
): MetavaultLoopRow[] {
  const rows: MetavaultLoopRow[] = [];
  for (let i = 0; i <= maxLoops; i++) {
    const leverage = cumulativeLeverageAtLoop(morphoLtv, i);
    const grossApy = baseApy * leverage;
    const borrowCost = borrowRate * (leverage - 1);
    const netApy = grossApy - borrowCost;
    const debtRatio = leverage > 1
      ? (leverage - 1) / (leverage * morphoLtv)
      : 0;
    const effectiveMargin = (1 - debtRatio) * 100;
    rows.push({ loop: i, leverage, grossApy, netApy, effectiveMargin });
  }
  return rows;
}

function findOptimal(rows: MetavaultLoopRow[]): { loop: number; netApy: number; leverage: number } {
  let best = rows[0];
  for (const row of rows) {
    if (row.netApy > best.netApy) best = row;
  }
  return { loop: best.loop, netApy: best.netApy, leverage: best.leverage };
}

// PR7a (discard-layer-spec): `computePerformanceMetrics` and
// `formatPerformanceMetrics` MOVED to `src/performance.ts`. The dashboard
// consumer at the bottom of this file imports them now; no other consumer
// existed prior to the move, so the migration was a single import-site fix.

export function register(server: McpServer): void {

  // ─── get_metavaults ────────────────────────────────────────────────────

  server.tool(
    "spectra_list_metavaults",
    `List live MetaVaults from the Spectra API.

MetaVaults are ERC-7540 curated vaults that automate LP rollover and compound
YT yield back into LP positions. They are managed by curators who earn
performance fees on depositor yield.

Returns all MetaVaults with:
  - Curator info, TVL (with unallocated ratio when >5% undeployed, computed
    AFTER subtracting external positions so avant/pendle externals aren't
    mislabeled as idle)
  - Live APY breakdown + 30d avg (when available)
  - Active Spectra LP positions (PT markets the vault is deployed in)
  - External Positions: value held OUTSIDE Spectra LP (avant avUSDx-burn
    redemption-in-flight, pendle LP on other protocols). Surfaced per-protocol
    with graceful fallback for unknown protocols. This field is UNDOCUMENTED
    by Spectra — shape is inferred from observed data and may change.
  - Cross-chain module whitelist (remote.{chainId}.modules) showing enabled
    protocols per foreign chain (e.g., avant/parallel on Avalanche)
  - Status flag (VISIBLE / HIDDEN) — HIDDEN vaults are surfaced here but
    filtered out in the Spectra UI; the compact listing does not prefix the
    name with a status label (detail view only)
  - Underlying asset details
  - Vault flows: epoch-by-epoch deposit/withdrawal analysis
  - Bridge transactions: cross-chain CCTP transfers
  - Epoch history (rate snapshots)

Use this tool to discover which MetaVaults are live, then pass the address to
spectra_model_metavault for detailed strategy modeling or spectra_get_curator_dashboard
for the full operational view with action items.

To investigate curator activity (LP adds/removes, rebalancing), use spectra_get_address_activity
on the curator's EOA address — MetaVault operations go through the Spectra Router, so
the vault contract address won't appear in pool activity data.

When verify_onchain=true (off by default), each MetaVault gets a compact chain-truth
summary line probed via the same engine that powers spectra_get_curator_dashboard.
Useful for cross-chain triage when the dashboard isn't pre-rendered. Chain-read
failures degrade to a [chain-truth ✗] line per MV — they NEVER abort the rest of the
list. Concurrency is capped at 6 simultaneous reads to avoid RPC rate limits.`,
    {
      chain: CHAIN_ENUM
        .optional()
        .describe("Chain to query. Omit to scan all chains."),
      verify_onchain: z.boolean()
        .optional()
        .describe(
          "Verify each MetaVault on-chain (Safe + infraVault + secondaryVault) and append a compact chain-truth line per MV. Off by default — chain reads add latency and RPC pressure. Use when you need cross-chain triage without pre-rendering the curator dashboard for each MV. " +
          "When [chain-truth ✗] fires, promote to spectra_get_curator_dashboard for the failed chain to see the full footer with next-probe guidance. " +
          "Dissolution: if telemetry shows zero verify_onchain=true invocations within 60 days of ship, the flag is fossil — remove and consolidate into the curator_portfolio path (audit-noted by Diverger Round-4).",
        ),
    },
    async ({ chain, verify_onchain }) => {
      try {
        let entries: Array<{ metavault: any; chain: string }>;

        let failedChains: string[] = [];
        // Schema-drift warnings keyed by chain — surfaced in the output footer
        // so Richard sees shape changes the moment they happen, instead of
        // discovering them when a formatter crashes three weeks later.
        const schemaWarningsByChain = new Map<string, Array<{ path: string; message: string }>>();
        if (chain) {
          const { data, warnings } = await fetchMetavaultsWithWarnings(chain);
          entries = data.map((metavault) => ({ metavault, chain }));
          if (warnings.length > 0) schemaWarningsByChain.set(chain, warnings);
        } else {
          const result = await scanAllMetavaults();
          entries = result.metavaults;
          failedChains = result.failedChains;
          for (const [c, w] of result.warningsByChain) schemaWarningsByChain.set(c, w);
        }

        // Fetch Merkl campaigns for all position chains (parallel, best-effort)
        const positionChainIds = new Set<number>();
        for (const { metavault: mv } of entries) {
          for (const pos of mv.positions || []) {
            const pool = pos.pools?.[0];
            const cid = pool?.chainId || pos.chainId;
            if (cid) positionChainIds.add(cid);
          }
        }
        const merklMaps = new Map<number, Map<string, MerklCampaign[]>>();
        const merklWarnings: string[] = [];
        const merklResults = await Promise.allSettled(
          [...positionChainIds].map(async (chainId) => {
            const result = await fetchMerklCampaigns(chainId).catch(() => ({
              campaigns: new Map<string, MerklCampaign[]>(),
              available: false,
            }));
            return { chainId, campaigns: result.campaigns, available: result.available };
          })
        );
        for (const r of merklResults) {
          if (r.status === "fulfilled" && r.value.available) {
            merklMaps.set(r.value.chainId, r.value.campaigns);
          } else if (r.status === "fulfilled" && !r.value.available) {
            console.error(`[Merkl fallback] campaigns unavailable for chain ${r.value.chainId}`);
            merklWarnings.push(`⚠ Merkl campaign data unavailable for chain ${r.value.chainId} — reward sustainability unknown`);
          }
        }

        // ── Chain-truth probe (Theme A Phase 4) ──
        // Off by default. When on: parallel chain reads (capped at 6 in flight)
        // populate a per-MV summary map keyed `${chain}:${address}`. The map is
        // passed to formatMetavaultList; per-MV failures degrade to a [✗] line
        // and NEVER abort the rest of the list.
        //
        // PR0 invariant (graceful degradation): the entire block is wrapped so
        // a catastrophic engine failure never blocks the existing list output.
        // Per-MV failures are surfaced via Promise.allSettled at the inner level.
        let chainResults: Map<string, ChainTruthSummaryResult> | undefined;
        if (verify_onchain && entries.length > 0) {
          try {
            chainResults = new Map<string, ChainTruthSummaryResult>();
            const CONCURRENCY = 6;
            // Per-MV timeout: bounds worst-case latency on slow / unreachable
            // chains. The engine's own RPC fallback retries sequentially across
            // all configured RPCs (FETCH_TIMEOUT_MS=15s × N endpoints) and can
            // legitimately consume tens of seconds on degraded chains. 30s is
            // long enough for 2 sequential 15s timeouts (one fallback hop) and
            // short enough that a single bad chain doesn't blow up the list-view
            // budget. Audit-driven inline-fix (Sonnet+depth NB-2).
            const PER_MV_TIMEOUT_MS = 30_000;
            // Simple semaphore via index-driven workers — one worker dequeues
            // the next entry, runs the engine, writes to the shared map. No
            // additional dependency, no global mutable state.
            let cursor = 0;
            const runOne = async (): Promise<void> => {
              while (true) {
                const idx = cursor++;
                if (idx >= entries.length) return;
                const { metavault: mv, chain: mvChain } = entries[idx];
                const key = `${mvChain}:${mv.address.toLowerCase()}`;
                let timeoutId: ReturnType<typeof setTimeout> | undefined;
                try {
                  const chainInput = projectChainReadInput(mv);
                  // Race the engine call against a hard timeout. If timeout
                  // fires, the worker writes a failed entry and moves to the
                  // next MV — the in-flight engine call continues to its own
                  // resolution but its result is ignored.
                  //
                  // Timer-leak fix (Sonnet+depth audit B2): the setTimeout
                  // handle is stored and cleared in `finally` so the engine
                  // winning the race does not leave a 30s-lived timer holding
                  // the event loop reference. Long-running MCP server →
                  // accumulated dangling timers per call → real leak.
                  const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(
                      () =>
                        reject(
                          new Error(
                            `chain-read timed out after ${PER_MV_TIMEOUT_MS}ms`,
                          ),
                        ),
                      PER_MV_TIMEOUT_MS,
                    );
                  });
                  const state = await Promise.race([
                    readMetaVaultChainStateCached(
                      mvChain as any,
                      chainInput,
                      { forceRefresh: false },
                    ),
                    timeoutPromise,
                  ]);
                  chainResults!.set(key, {
                    kind: "ok",
                    state,
                    apiTvlUnderlying: mv.tvl?.underlying,
                    apiUnderlyingPriceUsd: mv.underlying?.price?.usd,
                  });
                } catch (err: any) {
                  // One MV's engine failure (or per-MV timeout) must NOT poison
                  // the rest. Capture the error in the map; the formatter
                  // renders [✗] for it.
                  console.error(
                    `[spectra_list_metavaults] chain-read failed for ${mv?.address || "?"} on ${mvChain}: ${err?.message || err}`,
                  );
                  chainResults!.set(key, {
                    kind: "failed",
                    error: err?.message || String(err),
                  });
                } finally {
                  // Clear the race timer regardless of who won. If the engine
                  // won, the timer is still pending and would fire later into
                  // a no-op; clearing prevents the leak. If the timer won, it
                  // already fired and clearTimeout is a safe no-op.
                  if (timeoutId !== undefined) clearTimeout(timeoutId);
                }
              }
            };
            const workers = Array.from(
              { length: Math.min(CONCURRENCY, entries.length) },
              () => runOne(),
            );
            await Promise.allSettled(workers);
          } catch (verifyErr) {
            // Catastrophic: log + continue without chain-truth annotations.
            // The existing list is still the load-bearing artifact.
            console.error(
              `[spectra_list_metavaults] verify_onchain block aborted: ${(verifyErr as Error)?.message ?? verifyErr}`,
            );
            chainResults = undefined;
          }
        }

        let text = formatMetavaultList(entries, chain, merklMaps.size > 0 ? merklMaps : undefined, merklWarnings.length > 0 ? merklWarnings : undefined, chainResults);
        if (failedChains.length > 0) {
          text += `\nNote: ${failedChains.length} chain(s) unreachable: ${failedChains.join(", ")}. MetaVaults on those chains may be missing.`;
        }
        // Surface schema drift to the user. This footer is the product —
        // it tells Richard the moment Spectra's response shape changes,
        // rather than letting the drift hide until a formatter crashes.
        if (schemaWarningsByChain.size > 0) {
          const totalIssues = [...schemaWarningsByChain.values()].reduce((a, w) => a + w.length, 0);
          const chainList = [...schemaWarningsByChain.keys()].join(", ");
          text += `\n\n⚠ Schema drift: ${totalIssues} field(s) did not match expected shape on ${chainList}.`;
          text += `\n  Output above may be incomplete where validation dropped malformed records.`;
          // Show up to 3 issues per chain so Richard can eyeball the class of drift
          for (const [c, warnings] of schemaWarningsByChain) {
            const sample = warnings.slice(0, 3).map((w) => `${w.path}: ${w.message}`).join("; ");
            const more = warnings.length > 3 ? ` (+${warnings.length - 3} more)` : "";
            text += `\n    ${c}: ${sample}${more}`;
          }
          text += `\n  If this persists, the Spectra API shape changed — update src/schemas/spectra.ts.`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching MetaVaults: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ─── model_metavault_strategy ──────────────────────────────────────────

  server.tool(
    "spectra_model_metavault",
    `Model a MetaVault "double loop" strategy for curators.

MetaVaults are ERC-7540 curated vaults that automate LP rollover and compound
YT yield back into LP positions. This tool models the economics of leveraging
MetaVault shares as collateral on Morpho (or similar lending markets).

Two modes:
  1. Live mode: Provide chain + metavault_address to auto-populate base_apy from
     the live MetaVault API. All other params can be overridden.
  2. Manual mode: Provide base_apy directly for hypothetical modeling.

The "double loop":
  Layer 1 (inside vault): YT yield → LP tokens (compounding loop, managed by curator)
  Layer 2 (on top):       MV shares → Morpho collateral → borrow → deposit back (leverage loop)

Because YT compounding raises the base yield, leverage multiplies a higher base —
creating a "double loop premium" over raw PT looping.

Dual Morpho Market Strategy:
  Curators should create TWO Morpho markets for maximum flywheel effect:
  Market A (PT / underlying): For external users to loop PT. Drives pool volume & LP fees.
  Market B (MV shares / underlying): For the curator to loop vault shares. Amplifies own capital.
  These markets reinforce each other — PT demand deepens the pool, deeper pool attracts more
  loopers, and the curator earns fees on all external deposits flowing through the vault.

Curator economics: The curator EARNS the performance fee on external deposits — this is
revenue for managing the vault (rolling positions, compounding YT, maintaining allocations).

Blended allocation: Supports modeling MetaVaults that allocate across both Spectra and
Pendle LP positions via pendle_allocation_pct and pendle_lp_apy parameters. Computes
blended base APY and warns about manual Pendle rollover requirements.`,
    {
      chain: CHAIN_ENUM
        .optional()
        .describe("Chain where the MetaVault lives. Required with metavault_address for live data."),
      metavault_address: EVM_ADDRESS
        .optional()
        .describe("MetaVault contract address. When provided with chain, auto-fetches live APY and TVL as base_apy. Use spectra_list_metavaults to discover addresses."),
      base_apy: z
        .number()
        .optional()
        .describe("Base LP APY the MetaVault targets (%), e.g. 12 for 12%. Auto-populated from live data when metavault_address is provided, or required in manual mode."),
      yt_compounding_apy: z
        .number()
        .default(0)
        .describe("Additional yield from YT→LP compounding (%), e.g. 3 for 3%. Default 0."),
      curator_fee_pct: z
        .number()
        .min(0)
        .max(100)
        .default(10)
        .describe("Performance fee the curator EARNS as % of vault yield (default 10%). E.g. 10 means curator collects 10% of gross yield as revenue, depositors receive the remaining 90%."),
      morpho_ltv: z
        .number()
        .gt(0)
        .lt(1)
        .default(0.86)
        .describe("Morpho LTV for MetaVault share collateral (0-1, default 0.86 = 86%)"),
      borrow_rate: z
        .number()
        .default(5)
        .describe("Morpho borrow rate in % APY (default 5%)"),
      max_loops: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum leverage loops to model (default 5)"),
      capital_usd: z
        .number()
        .positive()
        .optional()
        .describe("Curator's own capital in USD. Enables curator economics section."),
      external_deposits_usd: z
        .number()
        .min(0)
        .default(0)
        .describe("External deposits the curator attracts (USD). The curator earns performance fees on these deposits. Default 0."),
      days_to_maturity: z
        .number()
        .positive()
        .default(90)
        .describe("Average pool cycle length in days (default 90). Used for rollover advantage."),
      compare_pt_apy: z
        .number()
        .optional()
        .describe("If provided, show side-by-side comparison with raw PT looping at this APY (%)"),
      pendle_allocation_pct: z
        .number()
        .min(0)
        .max(100)
        .default(0)
        .describe("Percentage of vault capital allocated to Pendle LP positions (0-100, default 0). When >0, computes blended APY across Spectra and Pendle. Requires pendle_lp_apy."),
      pendle_lp_apy: z
        .number()
        .optional()
        .describe("Pendle LP APY (%) for the Pendle allocation. Required when pendle_allocation_pct > 0."),
    },
    async ({
      chain,
      metavault_address,
      base_apy,
      yt_compounding_apy,
      curator_fee_pct,
      morpho_ltv,
      borrow_rate,
      max_loops,
      capital_usd,
      external_deposits_usd,
      days_to_maturity,
      compare_pt_apy,
      pendle_allocation_pct,
      pendle_lp_apy,
    }) => {
      try {
        let resolvedBaseApy = base_apy;
        let liveDataNote = "";

        // Live mode: fetch metavault data from API
        if (metavault_address && chain) {
          const mvs = await fetchMetavaults(chain);
          const mv = mvs.find(
            (m) => m.address.toLowerCase() === metavault_address.toLowerCase()
          );
          if (mv) {
            const liveApy = mv.liveApy?.total || 0;
            if (resolvedBaseApy === undefined) {
              resolvedBaseApy = liveApy;
            }
            const tvlStr = formatUsd(mv.tvl?.usd || 0);
            const curatorName = mv.curator?.name || "Unknown";
            const noteLines = [
              `--- Live MetaVault Data ---`,
              `  Name: ${mv.metadata?.title || mv.name} (${mv.symbol})`,
              `  Chain: ${chain}`,
              `  Address: ${mv.address}`,
              `  Curator: ${curatorName}`,
              `  TVL: ${tvlStr}`,
              `  Live APY: ${formatPct(liveApy)}${resolvedBaseApy !== liveApy ? ` (overridden to ${formatPct(resolvedBaseApy!)})` : " (used as base_apy)"}`,
              `  Share Price: ${formatUsd(mv.price?.usd || 0)}`,
              `  Positions: ${mv.positions?.length || 0} active`,
            ];

            // Surface APY composition — let agent reason about what's base vs incentive
            const apyDetails = mv.liveApy?.details;
            if (apyDetails) {
              noteLines.push(``);
              noteLines.push(`  APY Composition:`);
              if (apyDetails.base != null) {
                noteLines.push(`    Base (fees + PT + IBT): ${formatPct(apyDetails.base)}`);
              }
              if (apyDetails.ibtRewards && Object.keys(apyDetails.ibtRewards).length > 0) {
                for (const [token, apy] of Object.entries(apyDetails.ibtRewards)) {
                  noteLines.push(`    ${token} (IBT reward): ${formatPct(apy)}`);
                }
              }
              if (apyDetails.mvRewards && Object.keys(apyDetails.mvRewards).length > 0) {
                for (const [token, apy] of Object.entries(apyDetails.mvRewards)) {
                  noteLines.push(`    ${token} (MetaVault reward): ${formatPct(apy)}`);
                }
              }
              if (apyDetails.boostedRewards && Object.keys(apyDetails.boostedRewards).length > 0) {
                for (const [token, range] of Object.entries(apyDetails.boostedRewards)) {
                  if (range.min == null && range.max == null) continue;
                  noteLines.push(`    ${token} Gauge: ${formatPct(range.min ?? 0)} -> ${formatPct(range.max ?? 0)}`);
                }
              }

              const baseApy = apyDetails.base || 0;
              if (liveApy > 0 && baseApy < liveApy) {
                const incentiveApy = liveApy - baseApy;
                const incentivePct = (incentiveApy / liveApy) * 100;
                noteLines.push(`    => ${formatPct(baseApy)} base + ${formatPct(incentiveApy)} incentives (${incentivePct.toFixed(0)}% from incentive programs)`);
              }
            }

            noteLines.push(``);
            liveDataNote = noteLines.join("\n");
          } else {
            liveDataNote = [
              `--- Live MetaVault Data ---`,
              `  MetaVault ${metavault_address} not found on ${chain}.`,
              `  Use spectra_list_metavaults to discover available MetaVaults.`,
              `  Falling back to manual base_apy.`,
              ``,
            ].join("\n");
          }
        } else if (metavault_address && !chain) {
          liveDataNote = [
            `--- Live MetaVault Data ---`,
            `  chain is required when metavault_address is provided.`,
            `  Use spectra_list_metavaults to find chain + address pairs.`,
            `  Falling back to manual base_apy.`,
            ``,
          ].join("\n");
        }

        // Require base_apy one way or another
        if (resolvedBaseApy === undefined) {
          const text = `Error: base_apy is required. Either provide it directly or supply chain + metavault_address to auto-fetch from the live API. Use spectra_list_metavaults to discover MetaVault addresses.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Validate Pendle allocation
        if (pendle_allocation_pct > 0 && pendle_lp_apy === undefined) {
          const text = `Error: pendle_lp_apy is required when pendle_allocation_pct > 0. Provide the Pendle LP APY (%) for the blended allocation model. Use pendle_list_markets to find Pendle LP APYs.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        // Blended base APY (Spectra + Pendle allocation)
        const spectraBaseApy = resolvedBaseApy;
        const blendedBaseApy = pendle_allocation_pct > 0
          ? (resolvedBaseApy * (100 - pendle_allocation_pct) / 100) + (pendle_lp_apy! * pendle_allocation_pct / 100)
          : resolvedBaseApy;

        // Vault economics
        const grossVaultApy = blendedBaseApy + yt_compounding_apy;
        const netVaultApy = grossVaultApy * (1 - curator_fee_pct / 100);

        // MetaVault looping table
        const rows = computeLoopRows(netVaultApy, borrow_rate, morpho_ltv, max_loops);
        const optimal = findOptimal(rows);

        // PT comparison (if requested)
        let comparePtRows: MetavaultLoopRow[] | undefined;
        let comparePtBest: { loop: number; netApy: number; leverage: number } | undefined;
        if (compare_pt_apy !== undefined) {
          comparePtRows = computeLoopRows(compare_pt_apy, borrow_rate, morpho_ltv, max_loops);
          comparePtBest = findOptimal(comparePtRows);
        }

        // Curator economics (if capital provided)
        let curator: MetavaultCuratorEconomics | undefined;
        if (capital_usd !== undefined) {
          const ownTvl = capital_usd * optimal.leverage;
          const additionalTvlFromLooping = capital_usd * (optimal.leverage - 1);
          const totalTvl = ownTvl + external_deposits_usd;
          const ownYieldUsd = capital_usd * optimal.netApy / 100;
          const grossYieldOnExternal = external_deposits_usd * grossVaultApy / 100;
          const curatorFeeRevenueUsd = grossYieldOnExternal * curator_fee_pct / 100;
          const effectiveCuratorApy = (ownYieldUsd + curatorFeeRevenueUsd) / capital_usd * 100;

          curator = {
            capitalUsd: capital_usd,
            externalDepositsUsd: external_deposits_usd,
            ownTvl,
            totalTvl,
            additionalTvlFromLooping,
            curatorFeeRevenueUsd,
            ownYieldUsd,
            effectiveCuratorApy,
          };
        }

        const text = formatMetavaultStrategy({
          baseApy: blendedBaseApy,
          ytCompoundingApy: yt_compounding_apy,
          curatorFeePct: curator_fee_pct,
          netVaultApy,
          grossVaultApy,
          morphoLtv: morpho_ltv,
          borrowRate: borrow_rate,
          borrowRateIsDefault: borrow_rate === 5, // default(5) — flag when using placeholder rate
          daysToMaturity: days_to_maturity,
          rows,
          bestLoop: optimal.loop,
          bestNetApy: optimal.netApy,
          bestLeverage: optimal.leverage,
          curator,
          comparePtApy: compare_pt_apy,
          comparePtRows,
          comparePtBestLoop: comparePtBest?.loop,
          comparePtBestNetApy: comparePtBest?.netApy,
          pendleAllocationPct: pendle_allocation_pct > 0 ? pendle_allocation_pct : undefined,
          pendleLpApy: pendle_allocation_pct > 0 ? pendle_lp_apy : undefined,
          spectraBaseApy: pendle_allocation_pct > 0 ? spectraBaseApy : undefined,
        });

        // Next-step hints
        const nextLines = [
          ``,
          `--- Next Steps ---`,
          `• List live MetaVaults: spectra_list_metavaults() for current vault data`,
          `• Find pools matching your target APY: spectra_scan_opportunities(capital_usd=${capital_usd || "YOUR_AMOUNT"}) for live pool data`,
          `• Check raw PT looping baseline: spectra_get_looping_strategy(chain=CHAIN, pt_address=PT_ADDRESS) for comparison`,
          `• Find Morpho markets: morpho_list_markets() to see which PTs have lending markets for Market A`,
          `• Cross-protocol scan: mv_scan_curator_opportunities(capital_usd=${capital_usd || "YOUR_AMOUNT"}) for unified Spectra + Pendle ranking`,
        ].join("\n");

        return { content: [{ type: "text" as const, text: liveDataNote + text + nextLines }] };
      } catch (e: any) {
        const text = `Error modeling MetaVault strategy: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ─── get_curator_dashboard ──────────────────────────────────────────────

  server.tool(
    "spectra_get_curator_dashboard",
    `Operational dashboard for MetaVault curators.

Aggregates vault health, position status, depositor flows, fee revenue estimates,
and actionable alerts into a single view. Designed for curators managing live
MetaVaults who need a quick operational overview.

Returns:
  - Vault health: TVL with unallocated ratio (undeployed capital AFTER subtracting
    external positions — shown when >5%), Status label for non-VISIBLE vaults,
    live APY with optional 30d avg suffix and APY composition (base vs incentives),
    share price
  - APY 4-number breakdown when live-vs-30d delta ≥ 0.5pp: shows base+incentive
    decomposition for both snapshots WITHOUT asserting causality (agents draw
    their own conclusions from the numbers)
  - Position status: each active PT position with maturity countdown, APY, and size.
    Positions approaching maturity are flagged (!!!=14d, !!=30d)
  - External Positions: value held OUTSIDE Spectra LP structure (avant
    avUSDx-burn redemption-in-flight, pendle LP on other protocols). Rendered
    per-protocol with graceful fallback for unknown protocols
  - Capital State decomposition line: when ≥1 of {expired-stuck, external}
    buckets populated, emits a single line showing deployed/expired-stuck/
    external/unallocated as % of TVL
  - Depositor flows: epoch-by-epoch net inflows/outflows with trend analysis
  - Fee revenue: estimated annual curator fee revenue (snapshot projection)
  - Action items: auto-generated alerts including [UNALLOC] (softened when
    external capital coexists), [STATUS] (HIDDEN vaults),
    [PENDLE-EXT URGENT/UPCOMING/EXPIRED] (external Pendle maturity), [EXPIRED]
    / [URGENT] / [SOON] / [UPCOMING] (Spectra LP maturity), [OUTFLOWS],
    [BRIDGE], [INCENTIVE], [PENDLE ROLLOVER]

Pool allocations show each position as a % of total vault TVL (e.g., "37.1% | $236K"),
sorted by size, with protocol tags ([Spectra]/[Pendle]/[Unknown]) on each position.
Unallocated liquidity is shown separately (and excludes capital deployed in
external positions — labeled as "unallocated" to distinguish from "idle").
When the API doesn't provide LP balance data for a position, it shows "?%".

Cross-chain positions: MetaVault positions may live on a different chain than the
MetaVault itself (e.g., Base MetaVault → Avalanche pools via CCTP bridge). Pool
addresses in positions are on the position's chain, not the MetaVault's home chain.

Epoch flows: Derived from asset snapshots and rate changes. Yield accrual is estimated
from share rate deltas — actual yield may differ. Use share price trend to corroborate.

Requires chain + metavault_address. Use spectra_list_metavaults to discover addresses.
Use spectra_model_metavault for leverage modeling after reviewing the dashboard.
Use spectra_get_pool_activity on specific pool addresses for trading pattern analysis.
Use spectra_get_address_activity on the curator's EOA for cross-pool curator activity.

When verify_externals=true (off by default), each avant external position is probed
on Avalanche's RequestsManager — confirms state (CREATED/COMPLETED/CANCELLED), provider
attribution, on-chain amount (with PPM tolerance for API rounding), global counter, and
pause flag. A [chain-truth ✓/⚠/✗] line is appended under each avant position. Per-order
failures degrade gracefully and never poison sibling positions or block the dashboard.
Pendle externals are NOT yet probed in this slice.`,
    {
      chain: CHAIN_ENUM
        .describe("The blockchain network where the MetaVault lives."),
      metavault_address: EVM_ADDRESS
        .describe("The MetaVault contract address. Use spectra_list_metavaults to discover addresses."),
      curator_fee_pct: z
        .number()
        .min(0)
        .max(100)
        .default(10)
        .describe("Curator performance fee as % of vault yield (default 10%). Used for fee revenue estimation."),
      verify_externals: z.boolean()
        .optional()
        .describe(
          "Verify each externalPosition on its target chain (Theme E). Today probes Avant burn orders against Avalanche RequestsManager — confirms state (CREATED/COMPLETED/CANCELLED), provider attribution, on-chain amount, queue counter, and pause flag. Off by default — adds RPC latency and pressure on each external. Use when an avant external is load-bearing for a curator decision (large redemption-in-flight, stuck claim, suspected stale API). " +
          "Per-position failures degrade to a [chain-truth ✗] line but never poison sibling positions. " +
          "Pendle external verification is a separate next-session slice. " +
          "Dissolution: if telemetry shows zero verify_externals=true invocations within 60 days of ship, the flag is fossil — fold the verifier into list-mode default or remove."
        ),
    },
    async ({ chain, metavault_address, curator_fee_pct, verify_externals }) => {
      try {
        const mvs = await fetchMetavaults(chain);
        const mv = mvs.find(
          (m) => m.address.toLowerCase() === metavault_address.toLowerCase()
        );

        if (!mv) {
          const text = `MetaVault ${metavault_address} not found on ${chain}.\nUse spectra_list_metavaults(chain="${chain}") to discover available MetaVaults.`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }

        const underlyingDecimals = mv.underlying?.decimals || 6;
        const underlyingPriceUsd = mv.underlying?.price?.usd || 0;
        const divisor = Math.pow(10, underlyingDecimals);
        const liveApyTotal = mv.liveApy?.total || 0;

        // ── Fetch known Spectra pool addresses for protocol detection ──
        // Best-effort: if fetch fails, fall back to heuristic-based detection.
        let spectraPoolAddresses: Set<string> = new Set();
        try {
          spectraPoolAddresses = await fetchChainPoolAddresses(chain);
        } catch {
          // Best-effort — fall back to heuristic
        }

        // ── Build positions with vault allocation ──────────────
        // The API provides LP balance in two places:
        //   1. pool.lpt.balance — standard location
        //   2. pos.balance — fallback when lpt.balance is missing (cross-chain positions)
        // Vault allocation = lpBalance * lpt.price.usd
        const positions = (mv.positions || []).map((pos) => {
          const pool = pos.pools?.[0];
          const matDays = daysToMaturity(pos.maturity);
          const expired = pos.maturity * 1000 <= Date.now();

          // Compute vault's allocation from API-provided LP balance + price
          let vaultAllocationUsd: number | null = null;
          const rawBalance = pool?.lpt?.balance || pos.balance;
          if (rawBalance && pool?.lpt?.price?.usd) {
            const decimals = pool.lpt.decimals || 18;
            const raw = BigInt(rawBalance);
            const divisor = 10n ** BigInt(decimals);
            const lpBalance = Number(raw / divisor) + Number(raw % divisor) / Number(divisor);
            vaultAllocationUsd = lpBalance * pool.lpt.price.usd;
          }

          // Protocol detection: multi-signal approach
          // 1. Pool address matches known Spectra pools → Spectra (most reliable)
          // 2. Has lpt data (Curve StableSwap LP token) → Spectra
          // 3. Symbol or name contains "pendle" → Pendle
          // 4. Default to "Unknown" if no signal matches (conservative)
          let protocol: "Spectra" | "Pendle" | "Unknown" = "Unknown";
          const poolAddr = pool?.address?.toLowerCase();
          if (poolAddr && spectraPoolAddresses.has(poolAddr)) {
            protocol = "Spectra";
          } else if (pool?.lpt) {
            protocol = "Spectra";
          } else if (
            pos.symbol?.toLowerCase().includes("pendle")
          ) {
            protocol = "Pendle";
          }

          // Parse YT data from API (balance + claimable/claimed yield + USD values)
          let ytData: { balance: number; claimable: number; claimed: number; valueUsd: number; claimableUsd: number; claimedUsd: number; ibtSymbol?: string } | undefined;
          if (pos.yt?.balance) {
            const ytDec = pos.yt.decimals || 18;
            const d = 10n ** BigInt(ytDec);
            const bal = BigInt(pos.yt.balance);
            const ytBalance = Number(bal / d) + Number(bal % d) / Number(d);
            const ytPriceUsd = pool?.ytPrice?.usd || 0;
            const ibtPriceUsd = (pos as any).ibt?.price?.usd || 0;
            const claimableTokens = pos.yt.yield?.claimable ? (() => { const v = BigInt(pos.yt.yield!.claimable); return Number(v / d) + Number(v % d) / Number(d); })() : 0;
            const claimedTokens = pos.yt.yield?.claimed ? (() => { const v = BigInt(pos.yt.yield!.claimed); return Number(v / d) + Number(v % d) / Number(d); })() : 0;
            ytData = {
              balance: ytBalance,
              claimable: claimableTokens,
              claimed: claimedTokens,
              valueUsd: ytBalance * ytPriceUsd,
              claimableUsd: claimableTokens * ibtPriceUsd,
              claimedUsd: claimedTokens * ibtPriceUsd,
              ibtSymbol: (pos as any).ibt?.symbol,
            };
          }

          return {
            symbol: pos.symbol,
            ptAddress: pos.address,
            poolAddress: pool?.address || null,
            maturityTimestamp: pos.maturity,
            daysToMaturity: matDays,
            expired,
            tvlUsd: pos.tvl?.usd || 0,
            vaultAllocationUsd,
            ptApy: pool?.ptApy || 0,
            lpApyTotal: pool?.lpApy?.total || 0,
            lpApyBoostedTotal: pool?.lpApy?.boostedTotal || null,
            protocol,
            yt: ytData,
          };
        });

        // Shared warnings array for Merkl + Pendle enrichment (non-silent failure)
        const dashMerklWarnings: string[] = [];

        // ── Pendle enrichment for Pendle positions ──────────────
        // Fetch full Pendle market data for positions tagged as Pendle.
        // This surfaces PENDLE incentives, LP APY breakdown, liquidity, and volume
        // that the Spectra API doesn't carry for cross-protocol positions.
        const pendleEnrichment = new Map<string, { swapFeeApy: number; pendleApy: number; impliedApy: number; aggregatedApy: number; maxBoostedApy: number; liquidity: number; tvl: number; volume: number }>();
        // PR-E (2026-04-28) note: this `protocol` field is the LOCAL dashboard
        // classification (`"Spectra" | "Pendle" | "Unknown"` per line 773), NOT the
        // schema-derived API field. PR-E parse-time normalization affects
        // `externalPositions[].protocol` and `pt.ibt.protocol`, not this local label
        // namespace. Capital-P stays correct here.
        const pendlePositions = positions.filter(p => p.protocol === "Pendle" && p.poolAddress);
        if (pendlePositions.length > 0) {
          const pendleResults = await Promise.allSettled(
            pendlePositions.map(async (pos) => {
              // Resolve position chain for Pendle API call
              const posChainEntry = Object.entries(SUPPORTED_CHAINS).find(([, v]) => {
                const posObj = (mv.positions || []).find(p => p.address === pos.ptAddress);
                return posObj?.chainId === v.id || posObj?.pools?.[0]?.chainId === v.id;
              });
              const posChain = posChainEntry?.[0] || chain;
              const market = await fetchPendleMarketDetail(posChain, pos.poolAddress!);
              if (market) {
                return { poolAddress: pos.poolAddress!, detail: market.details };
              }
              return null;
            })
          );
          for (let pi = 0; pi < pendleResults.length; pi++) {
            const r = pendleResults[pi];
            if (r.status === "fulfilled" && r.value) {
              const d = r.value.detail;
              pendleEnrichment.set(r.value.poolAddress.toLowerCase(), {
                swapFeeApy: d.swapFeeApy * 100,
                pendleApy: d.pendleApy * 100,
                impliedApy: d.impliedApy * 100,
                aggregatedApy: d.aggregatedApy * 100,
                maxBoostedApy: d.maxBoostedApy * 100,
                liquidity: d.liquidity,
                tvl: d.totalTvl,
                volume: d.tradingVolume,
              });
            } else {
              // Non-silent: log failed Pendle enrichment
              const failedPos = pendlePositions[pi];
              const reason = r.status === "rejected" ? r.reason?.message?.slice(0, 80) : "null response";
              console.error(`[Pendle enrichment] failed for ${failedPos?.symbol || failedPos?.poolAddress}: ${reason}`);
              dashMerklWarnings.push(`⚠ Pendle data unavailable for ${failedPos?.symbol || "position"} — LP breakdown incomplete`);
            }
          }
        }

        // ── Epoch flow analysis ────────────────────────────────
        const epochFlows: CuratorDashboardOpts["epochFlows"] = [];
        let lifetimeNetFlowUsd = 0;
        let lifetimeYieldUsd = 0;
        let firstRate = 0;
        let lastRate = 0;

        if (mv.epochs && mv.epochs.length >= 2) {
          const sorted = [...mv.epochs].sort((a, b) => a.timestamp - b.timestamp);
          firstRate = Number(sorted[0].rate) / divisor;
          lastRate = Number(sorted[sorted.length - 1].rate) / divisor;

          let cumulativeYield = 0;
          let cumulativeNetDeposits = 0;

          for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const curr = sorted[i];
            const prevAssets = Number(prev.assets) / divisor;
            const currAssets = Number(curr.assets) / divisor;
            const prevRate = Number(prev.rate) / divisor;
            const currRate = Number(curr.rate) / divisor;

            const assetDelta = currAssets - prevAssets;
            const yieldAccrual = prevRate > 0 ? prevAssets * (currRate - prevRate) / prevRate : 0;
            const netDeposits = assetDelta - yieldAccrual;

            cumulativeYield += yieldAccrual;
            cumulativeNetDeposits += netDeposits;

            epochFlows.push({
              fromDate: formatDate(prev.timestamp),
              toDate: formatDate(curr.timestamp),
              netDepositsUsd: netDeposits * underlyingPriceUsd,
              yieldAccruedUsd: yieldAccrual * underlyingPriceUsd,
              tvlAfterUsd: currAssets * underlyingPriceUsd,
              rateAfter: currRate,
            });
          }

          // Lifetime totals — accumulated from per-epoch calculations
          lifetimeYieldUsd = cumulativeYield * underlyingPriceUsd;
          lifetimeNetFlowUsd = cumulativeNetDeposits * underlyingPriceUsd;
        }

        // ── Bridge summary ─────────────────────────────────────
        const bridgeTxs = mv.bridge?.transactions || [];
        const bridgeDirections: CuratorDashboardOpts["bridgeDirections"] = [];
        if (bridgeTxs.length > 0) {
          const dirMap = new Map<string, { count: number; totalUsd: number }>();
          for (const tx of bridgeTxs) {
            // Use chain IDs since chainIdToName is private in formatters
            const key = `Chain ${tx.srcChainId} -> Chain ${tx.dstChainId}`;
            const entry = dirMap.get(key) || { count: 0, totalUsd: 0 };
            entry.count++;
            entry.totalUsd += tx.amountUsd || 0;
            dirMap.set(key, entry);
          }
          for (const [direction, { count, totalUsd }] of dirMap) {
            bridgeDirections.push({ direction, count, totalUsd });
          }
        }

        // ── Compute known allocation total ─────────────────────
        // externalPositions (avant burns, pendle LP) sit OUTSIDE the Spectra
        // positions array but INSIDE mv.tvl — subtract them so truly
        // unallocated cash is distinguishable from externally deployed capital.
        const knownAllocTotal = positions
          .filter(p => p.vaultAllocationUsd != null)
          .reduce((sum, p) => sum + p.vaultAllocationUsd!, 0);
        const externalTotalUsd = (mv.externalPositions || []).reduce(
          (s, e) => s + (e.valueUsd || 0),
          0,
        );
        const hasExternal = externalTotalUsd > 0;
        const vaultTvl = mv.tvl?.usd || 0;
        const idleLiquidityUsd = vaultTvl > 0
          ? Math.max(0, vaultTvl - knownAllocTotal - externalTotalUsd)
          : 0;
        const idlePct = vaultTvl > 0 ? idleLiquidityUsd / vaultTvl * 100 : 0;

        // ── Queued timelock transactions — staging signal ──────
        //
        // What this block surfaces: QUEUED actions from MetavaultSchema's
        // opaque `transactionQueue` passthrough. Observed live on Base Gami
        // as a `registerMarketAsMetavault(market=0x…)` sitting in a Safe
        // timelock with cooldown + execution window timestamps.
        //
        // Why this exists: a queued action tells us the curator has publicly
        // telegraphed a governance move N days ahead of execution. That
        // re-frames "unallocated capital" from "neglect" to "staging." The
        // [TIMELOCK] action item surfaces this directly; the `isStaging`
        // flag below feeds into the [UNALLOC] softening so the two signals
        // reinforce each other.
        //
        // Observation boundaries (what this can and CANNOT tell a reader):
        //   CAN: the queued function name, the chainId it targets, the
        //        cooldown-end and execution-max timestamps.
        //   CANNOT: the delay-module contract address, the cancellation
        //        authority (who can void the queue entry), the full
        //        calldata semantics (function args are not rendered —
        //        only the function name). A competitive-intel reader
        //        who needs those would cross-reference the raw API or
        //        Safe transaction builder directly.
        //   CANNOT: multi-action queue entries are collapsed to the first
        //        action's name. If a queued tx bundles a multisend, only
        //        the outer call is surfaced.
        //
        // Dialectic provenance: this surface was surfaced by Agent-A of
        // the Apr 23 cold-start audit ("the dashboard SEES the rotation
        // but doesn't NARRATE it") and adopted in its smaller form by
        // Breaker's rejection of Builder's 140-line full-schema proposal.
        // FU4 from the 5-lens; FU3' (softened verb on hasQueuedTimelock)
        // is the Inverter's protected finding propagated through here.
        const queuedTimelockTxns: Array<{
          chainIdStr: string;
          functionName: string;
          cooldownEndMs: number;
          executionMaxMs: number;
        }> = [];
        const tqRaw = (mv as any).transactionQueue as Record<string, any[]> | undefined;
        if (tqRaw && typeof tqRaw === "object") {
          for (const chainIdStr of Object.keys(tqRaw)) {
            const txs = tqRaw[chainIdStr];
            if (!Array.isArray(txs)) continue;
            for (const tx of txs) {
              if (tx?.status !== "QUEUED") continue;
              const cooldownMs = Number(tx?.cooldownEndTimestamp || 0) * 1000;
              const execMaxMs = Number(tx?.executionMaxTimestamp || 0) * 1000;
              const action = Array.isArray(tx?.actions) && tx.actions.length > 0 ? tx.actions[0] : null;
              const fn = action?.functionName || action?.description || "queued action";
              queuedTimelockTxns.push({
                chainIdStr,
                functionName: String(fn),
                cooldownEndMs: cooldownMs,
                executionMaxMs: execMaxMs,
              });
            }
          }
        }
        const hasQueuedTimelock = queuedTimelockTxns.length > 0;

        // ── Action items ───────────────────────────────────────
        const actionItems: string[] = [];

        // Status label — HIDDEN means not listed in the Spectra UI. Curators
        // should confirm intent; prospects reading the dashboard see it too.
        if (mv.status && mv.status !== "VISIBLE") {
          actionItems.push(`${formatActionItemPrefix("status")} Vault status is "${mv.status}" — not listed in Spectra frontend. Confirm intent.`);
        }

        // Queued timelock transactions — surface curator's pending governance
        // actions (registerMarketAsMetavault, etc.). This exposes capital
        // staging that would otherwise look like neglect. The cooldown/execution
        // window is the curator's declared intent in timestamp form.
        const nowMsForTimelock = Date.now();
        for (const tl of queuedTimelockTxns) {
          const chainName = SUPPORTED_CHAINS[Object.entries(SUPPORTED_CHAINS).find(([, v]) => v.id === Number(tl.chainIdStr))?.[0] || ""]?.name
            || `chain ${tl.chainIdStr}`;
          const daysToCooldown = Math.max(0, Math.ceil((tl.cooldownEndMs - nowMsForTimelock) / (86400 * 1000)));
          const daysToExpiry = Math.max(0, Math.ceil((tl.executionMaxMs - nowMsForTimelock) / (86400 * 1000)));
          const status = tl.cooldownEndMs > nowMsForTimelock
            ? `executable in ${daysToCooldown}d`
            : tl.executionMaxMs > nowMsForTimelock
              ? `EXECUTABLE NOW (window closes in ${daysToExpiry}d)`
              : `EXPIRED (execution window closed)`;
          actionItems.push(`[TIMELOCK] ${tl.functionName}() queued on ${chainName} — ${status}`);
        }

        // Unallocated liquidity warning — soften verb when staging signal exists
        // (external capital OR queued timelock). FU3' dialectic finding: a vault
        // with a queued registerMarketAsMetavault is staging unallocated capital
        // for the post-timelock deployment, even if no external position exists
        // yet. Hard verb would tell the curator to deploy capital that's already
        // committed to a specific post-timelock action.
        const isStaging = hasExternal || hasQueuedTimelock;
        if (idlePct > 20 && idleLiquidityUsd > 1000) {
          if (isStaging) {
            const stagingContext = hasExternal && hasQueuedTimelock
              ? `alongside ${formatUsd(externalTotalUsd)} in external positions and ${queuedTimelockTxns.length} queued timelock action(s)`
              : hasExternal
                ? `alongside ${formatUsd(externalTotalUsd)} in external positions`
                : `alongside ${queuedTimelockTxns.length} queued timelock action(s)`;
            actionItems.push(`[UNALLOC] ${idlePct.toFixed(0)}% of vault capital (${formatUsd(idleLiquidityUsd)}) is unallocated ${stagingContext}. Consider whether to deploy the unallocated slice.`);
          } else {
            actionItems.push(`[UNALLOC] ${idlePct.toFixed(0)}% of vault capital (${formatUsd(idleLiquidityUsd)}) is sitting unallocated. Deploy to active pools to generate yield.`);
          }
        }

        // Expiring positions
        for (const pos of positions) {
          if (pos.expired) {
            actionItems.push(`[EXPIRED] ${pos.symbol} has matured. Redeem and reallocate to a new pool.`);
          } else if (pos.daysToMaturity <= 7) {
            actionItems.push(`[URGENT] ${pos.symbol} expires in ${pos.daysToMaturity}d. Prepare rollover to next maturity.`);
          } else if (pos.daysToMaturity <= 14) {
            actionItems.push(`[SOON] ${pos.symbol} expires in ${pos.daysToMaturity}d. Plan rollover strategy.`);
          } else if (pos.daysToMaturity <= 30) {
            actionItems.push(`[UPCOMING] ${pos.symbol} expires in ${pos.daysToMaturity}d. Monitor for rollover timing.`);
          }
        }

        // No positions — only flag as "idle" when there's also no external
        // deployment. A vault with externalPositions but no Spectra positions
        // is not idle, just externally deployed.
        if (positions.length === 0 && !hasExternal) {
          actionItems.push(`[WARNING] No active positions. Vault capital may be sitting idle.`);
        }

        // Outflow trend
        if (epochFlows.length >= 3) {
          const recent = epochFlows.slice(-3);
          const allOutflows = recent.every(f => f.netDepositsUsd < 0);
          if (allOutflows) {
            actionItems.push(`${formatActionItemPrefix("outflows")} 3 consecutive epochs of net outflows. Review depositor retention.`);
          }
        }

        // Bridge pending
        if ((mv.bridge?.totalPendingUsd || 0) > 0) {
          actionItems.push(`${formatActionItemPrefix("bridge")} ${formatUsd(mv.bridge!.totalPendingUsd)} pending in cross-chain bridge transfers.`);
        }

        // High incentive dependency
        const apyBase = mv.liveApy?.details?.base || 0;
        if (liveApyTotal > 0 && apyBase > 0) {
          const incentiveShare = (liveApyTotal - apyBase) / liveApyTotal;
          if (incentiveShare > CROSS_TOOL_THRESHOLDS.INCENTIVE_SHARE_WARN_FRAC) {
            actionItems.push(`${formatActionItemPrefix("incentive")} ${(incentiveShare * 100).toFixed(0)}% of APY comes from incentive programs. Base yield is only ${formatPct(apyBase)}.`);
          }
        }

        // Pendle manual rollover warnings
        for (const pos of positions) {
          // Note (PR-E): this is the LOCAL dashboard classification (capital-P), not
          // the schema-normalized API field. See line 832 comment for the namespace
          // distinction.
          if (pos.protocol === "Pendle" && !pos.expired && pos.daysToMaturity <= 30) {
            actionItems.push(`[PENDLE ROLLOVER] ${pos.symbol} matures in ${pos.daysToMaturity}d — requires manual rollover (MetaVault auto-roll does not cover Pendle positions)`);
          }
        }

        // External position action items — registry-driven maturity alerts.
        // Spec §4: action items generated per protocol from metadata.actionItems.
        // §6: ordering preserved (appended after [INCENTIVE] check).
        // Note: Avant has NO actionItems (updatedAt is indexer-write time, not submission
        // time, per spec §4). Pendle actionItems are driven by market.maturity (seconds).
        const nowMs = Date.now();
        for (const e of (mv.externalPositions || [])) {
          const items = generateActionItems(e as TypedExternalPosition, nowMs);
          actionItems.push(...items);
        }

        // ── Merkl campaigns + unclaimed vault rewards ──────────
        // Fetch campaigns for all position chains (parallel, best-effort)
        const posChainIds = new Set<number>();
        for (const pos of mv.positions || []) {
          const pool = pos.pools?.[0];
          const cid = pool?.chainId || pos.chainId;
          if (cid) posChainIds.add(cid);
        }
        // Also include the vault's home chain
        const homeChainId = SUPPORTED_CHAINS[chain]?.id;
        if (homeChainId) posChainIds.add(homeChainId);

        const merklCampaignMaps = new Map<number, Map<string, MerklCampaign[]>>();
        const merklCampResults = await Promise.allSettled(
          [...posChainIds].map(async (chainId) => {
            const result = await fetchMerklCampaigns(chainId).catch(() => ({
              campaigns: new Map<string, MerklCampaign[]>(),
              available: false,
            }));
            return { chainId, campaigns: result.campaigns, available: result.available };
          })
        );
        for (const r of merklCampResults) {
          if (r.status === "fulfilled" && r.value.available) {
            merklCampaignMaps.set(r.value.chainId, r.value.campaigns);
          } else if (r.status === "fulfilled" && !r.value.available) {
            console.error(`[Merkl fallback] campaigns unavailable for chain ${r.value.chainId}`);
            dashMerklWarnings.push(`⚠ Merkl campaign data unavailable for chain ${r.value.chainId} — reward sustainability unknown`);
          }
        }

        // Build per-position campaign lookup
        const dashMerklByPool = new Map<string, MerklCampaign[]>();
        for (const pos of mv.positions || []) {
          const pool = pos.pools?.[0];
          const posChainId = pool?.chainId || pos.chainId;
          if (posChainId && pool?.address) {
            const chainMap = merklCampaignMaps.get(posChainId);
            if (chainMap) {
              const campaigns = lookupMerklCampaigns(chainMap, [pool.address]);
              if (campaigns.length > 0) {
                dashMerklByPool.set(pool.address.toLowerCase(), campaigns);
              }
            }
          }
        }

        // Fetch unclaimed Merkl rewards for the vault address on each position chain
        const poolAddressSet = new Set(
          (mv.positions || [])
            .map(p => p.pools?.[0]?.address?.toLowerCase())
            .filter(Boolean) as string[]
        );
        const vaultMerklRewards: Array<{ symbol: string; amount: number }> = [];
        const rewardFetchResults = await Promise.allSettled(
          [...posChainIds].map(async (chainId) => {
            const raw = await fetchMerkl(metavault_address, chainId);
            return { chainId, raw };
          })
        );
        for (const r of rewardFetchResults) {
          if (r.status === "fulfilled" && r.value.raw && Object.keys(r.value.raw).length > 0) {
            const parsed = parseMerklRewards(r.value.raw, poolAddressSet, chain);
            // Collect all matched + unmatched rewards
            for (const rewards of parsed.matched.values()) {
              for (const reward of rewards) {
                if (reward.unclaimed > 0) {
                  vaultMerklRewards.push({ symbol: reward.symbol, amount: reward.unclaimed });
                }
              }
            }
            for (const reward of parsed.unmatched) {
              if (reward.unclaimed > 0) {
                vaultMerklRewards.push({ symbol: reward.symbol, amount: reward.unclaimed });
              }
            }
          }
        }

        // ── Fee revenue estimate ───────────────────────────────
        let estimatedAnnualFeeRevenueUsd: number | null = null;
        if (mv.tvl?.usd && liveApyTotal > 0) {
          estimatedAnnualFeeRevenueUsd = (curator_fee_pct / 100) * (liveApyTotal / 100) * mv.tvl.usd;
        }

        // ── External chain-truth verification (Theme E architecture) ──
        // Off by default. When verify_externals=true, walks every external
        // position whose protocol has a registered verifier and probes
        // chain state via the strategy. Generic dispatch — adding pendle,
        // parallel, etc. needs no edits here. Per-position failures become
        // [chain-truth ✗] lines but never poison sibling positions or
        // block the dashboard. Concurrency capped at 4 simultaneous reads.
        // The whole block is try/catch — a catastrophic engine failure
        // never blocks the existing dashboard.
        let externalChainTruth: ExternalChainTruthMap | undefined;
        if (verify_externals && mv.externalPositions && mv.externalPositions.length > 0) {
          try {
            const truthMap = new Map<string, VerifierResult>();
            type Target = { verifier: ProtocolVerifier; position: TypedExternalPosition; key: string };
            const targets: Target[] = [];
            for (const ep of mv.externalPositions) {
              const verifier = getVerifier(ep.protocol);
              if (!verifier) continue;
              const key = verifier.positionKey(ep as TypedExternalPosition);
              if (key === null) continue;
              targets.push({ verifier, position: ep as TypedExternalPosition, key });
            }
            if (targets.length > 0) {
              const CONCURRENCY = 4;
              let cursor = 0;
              const runOne = async (): Promise<void> => {
                while (true) {
                  const idx = cursor++;
                  if (idx >= targets.length) return;
                  const { verifier, position, key } = targets[idx];
                  try {
                    // ProtocolVerifier.verify() is contract-bounded NOT to
                    // throw — it returns {kind:"failed",...} on any error.
                    // We still wrap in try/catch as defense-in-depth: a
                    // future verifier that violates the contract must not
                    // poison the worker pool.
                    const result = await verifier.verify(position);
                    truthMap.set(key, result);
                  } catch (err: any) {
                    console.error(
                      `[spectra_get_curator_dashboard] verifier "${verifier.name}" threw for key=${key}: ${err?.message || err}`,
                    );
                    truthMap.set(key, {
                      kind: "failed",
                      protocol: verifier.name,
                      line: `[chain-truth ✗] ${verifier.name}: ${(err?.message || String(err)).slice(0, 80)}`,
                    });
                  }
                }
              };
              const workers = Array.from(
                { length: Math.min(CONCURRENCY, targets.length) },
                () => runOne(),
              );
              await Promise.allSettled(workers);
            }
            if (truthMap.size > 0) {
              externalChainTruth = truthMap;
            }
          } catch (verifyErr) {
            console.error(
              `[spectra_get_curator_dashboard] verify_externals block aborted: ${(verifyErr as Error)?.message ?? verifyErr}`,
            );
            externalChainTruth = undefined;
          }
        }

        const dashOpts: CuratorDashboardOpts = {
          chain,
          metavaultAddress: metavault_address,
          curatorName: mv.curator?.name || "Unknown",
          curatorAddresses: mv.curator?.addresses || [],
          vaultName: mv.metadata?.title || mv.name,
          vaultSymbol: mv.symbol,
          underlyingSymbol: mv.underlying?.symbol || "?",
          underlyingDecimals,
          underlyingPriceUsd,
          tvlUsd: mv.tvl?.usd || 0,
          tvlUnderlying: mv.tvl?.underlying || 0,
          liveApyTotal,
          liveApyBoostedTotal: mv.liveApy?.boostedTotal || null,
          liveApyBase: mv.liveApy?.details?.base ?? null,
          apyDetails: mv.liveApy?.details,
          sharePriceUsd: mv.price?.usd || 0,
          sharePriceUnderlying: mv.price?.underlying || 0,
          status: mv.status,
          avgApy30dTotal: mv.avgApy30d?.total ?? undefined,
          avgApy30dBase: mv.avgApy30d?.details?.base ?? undefined,
          externalPositions: mv.externalPositions,
          positions,
          epochFlows,
          lifetimeNetFlowUsd,
          lifetimeYieldUsd,
          firstRate,
          lastRate,
          epochCount: mv.epochs?.length || 0,
          bridgeTxCount: bridgeTxs.length,
          bridgePendingUsd: mv.bridge?.totalPendingUsd || 0,
          bridgeDirections,
          actionItems,
          curatorFeePct: curator_fee_pct,
          estimatedAnnualFeeRevenueUsd,
          merklByPool: dashMerklByPool.size > 0 ? dashMerklByPool : undefined,
          vaultMerklRewards: vaultMerklRewards.length > 0 ? vaultMerklRewards : undefined,
          merklWarnings: dashMerklWarnings.length > 0 ? dashMerklWarnings : undefined,
          pendleEnrichment: pendleEnrichment.size > 0 ? pendleEnrichment : undefined,
          externalChainTruth,
        };

        let text = formatCuratorDashboard(dashOpts);

        // Append performance metrics if enough epoch data
        const perfMetrics = computePerformanceMetrics(mv.epochs || [], 5, underlyingDecimals);
        if (perfMetrics) {
          const perfText = formatPerformanceMetrics(perfMetrics);
          const nextStepsMarker = "--- Next Steps ---";
          const nextStepsIdx = text.indexOf(nextStepsMarker);
          if (nextStepsIdx >= 0) {
            text = text.slice(0, nextStepsIdx) + perfText + "\n\n" + text.slice(nextStepsIdx);
          } else {
            text += "\n" + perfText;
          }
        }

        // ── Chain truth footer (Theme A Phase 2) ──
        // Wrapped in try/catch — chain-truth must NEVER block the dashboard
        // render. Per PR0 + the graceful-degradation invariant: the existing
        // dashboard is the load-bearing artifact; chain truth is additive
        // confirmation. If the engine, the cache, or the formatter throws,
        // log to stderr and ship the dashboard without the footer.
        try {
          const chainInput = projectChainReadInput(mv);
          const chainState = await readMetaVaultChainStateCached(chain, chainInput, {
            forceRefresh: false,
          });
          const footerLines = formatChainTruthFooter(chainState, {
            viewMode: "curator",
            api: {
              tvlUnderlying: mv.tvl?.underlying,
              underlyingPriceUsd,
              underlyingSymbol: mv.underlying?.symbol,
            },
          });
          if (footerLines.length > 0) {
            text += "\n\n" + footerLines.join("\n");
          }
        } catch (footerErr) {
          // Failures NOT silent — but the dashboard ships either way.
          console.error(
            `[spectra_get_curator_dashboard] chain-truth footer suppressed: ${(footerErr as Error)?.message ?? footerErr}`,
          );
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error building curator dashboard: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
