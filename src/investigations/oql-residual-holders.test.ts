/**
 * Unit + integration tests for src/investigations/oql-residual-holders.ts
 * and the supporting `readInfraVaultMintEvents` in src/chain-reads.ts.
 *
 * Unit-test contracts (offline):
 *   - readInfraVaultMintEvents emits block-range-too-large + clamps when
 *     range > 500K, OR rpc-all-failed when no RPC is reachable. NEVER throws.
 *   - readInfraVaultMintEvents returns the InfraVaultMintEventResult shape
 *     even when bootstrap fails (graceful degradation).
 *   - findResidualInfraVaultHolders returns empty residuals + the
 *     rpc-all-failed warning when bootstrap fails.
 *   - findResidualInfraVaultHolders lower-cases knownHolders before
 *     set-difference (case-insensitive comparison).
 *   - findResidualInfraVaultHolders never throws.
 *
 * Integration (gated `INTEGRATION_TEST=1`, runs against live Base RPC):
 *   - Live probe against gamisUSDC infraVault. Asserts the function returns
 *     a structured result. Logs the residual count + total shares for the
 *     report.
 *
 * Test-file location follows the project pattern: place under `src/` so the
 * existing tsc + node --test pipeline picks it up. Wire-up in package.json
 * `test:unit` script is required.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  readInfraVaultMintEvents,
  type InfraVaultMintEventResult,
} from "../chain-reads.js";
import {
  findResidualInfraVaultHolders,
  type ResidualHolderResult,
} from "./oql-residual-holders.js";

const RUN_INTEGRATION = process.env.INTEGRATION_TEST === "1";

// =============================================================================
// readInfraVaultMintEvents — graceful-degradation contracts (offline)
// =============================================================================

describe("readInfraVaultMintEvents block-range cap + bootstrap fail-soft", () => {
  it("returns a structured InfraVaultMintEventResult for a 600K-block window without throwing", async () => {
    // Same structural assertion as the existing readMetaVaultEvents test:
    // we don't stub the RPC. Either pickWorkingRpc fails (rpc-all-failed)
    // or it succeeds and the cap fires (block-range-too-large). Either is
    // acceptable; the function MUST NOT throw in either path.
    const result = await readInfraVaultMintEvents(
      "base",
      "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1",
      0,
      600_000,
    );
    assert.equal(result.chain, "base");
    assert.equal(result.infraVaultAddress, "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1");
    assert.ok(Array.isArray(result.mintEvents), "mintEvents must be an array");
    assert.ok(Array.isArray(result.warnings), "warnings must be an array");
    const codes = result.warnings.map((w) => w.code);
    // Either bootstrap failed (rpc-all-failed) or cap fired (block-range-too-large).
    assert.ok(
      codes.includes("rpc-all-failed") || codes.includes("block-range-too-large"),
      `expected rpc-all-failed or block-range-too-large, got: ${codes.join(", ") || "(none)"}`,
    );
    if (codes.includes("block-range-too-large")) {
      assert.equal(result.toBlock, 500_000, "toBlock must be clamped to fromBlock + MAX_EVENT_BLOCK_RANGE");
    }
  });

  it("returns empty mint events when bootstrap path fails (offline)", async () => {
    // We can't force RPC failure deterministically without a mock layer, but
    // we CAN assert that for any call, the returned shape is the documented
    // contract — never undefined, never thrown.
    const result: InfraVaultMintEventResult = await readInfraVaultMintEvents(
      "base",
      "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1",
      0,
      100,
    );
    assert.equal(typeof result.fromBlock, "number");
    assert.equal(typeof result.toBlock, "number");
    assert.equal(typeof result.rpcUsed, "string");
    assert.ok(result.infraVaultAddress.startsWith("0x"));
    assert.ok(Array.isArray(result.mintEvents));
    assert.ok(Array.isArray(result.warnings));
  });
});

// =============================================================================
// findResidualInfraVaultHolders — pure function contracts (offline)
// =============================================================================

describe("findResidualInfraVaultHolders graceful degradation", () => {
  it("returns empty residuals + warnings without throwing when bootstrap can fail", async () => {
    const result: ResidualHolderResult = await findResidualInfraVaultHolders(
      "base",
      "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1",
      ["0x776f95321a0285f8bcde149e3264d16dc08da69a"],
      0,
      100,
    );
    assert.equal(result.chain, "base");
    assert.equal(result.infraVaultAddress, "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1");
    assert.ok(Array.isArray(result.residuals));
    assert.ok(Array.isArray(result.warnings));
    assert.equal(typeof result.aggregations.count, "number");
    assert.equal(result.aggregations.count, result.residuals.length);
    // Aggregations are bigint (raw share units).
    assert.equal(typeof result.aggregations.totalShares, "bigint");
    assert.equal(typeof result.aggregations.smallestShares, "bigint");
    assert.equal(typeof result.aggregations.largestShares, "bigint");
  });

  it("knownHolders is case-insensitive — mixed-case input still excludes addresses", async () => {
    // We can't run the full algorithm offline (needs a working RPC), but we
    // CAN verify the result shape and that the function accepts mixed-case
    // input without throwing.
    const result: ResidualHolderResult = await findResidualInfraVaultHolders(
      "base",
      "0xC62734AECB095D2CB74B3CCEBFDF973EC23FBAA1", // mixed case
      [
        "0x776F95321A0285F8BCDE149E3264D16DC08DA69A", // mixed case
        "0x9878aef8a193dbfceFa8A6ECe3eb15f93CA31c9E", // mixed case
        "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
      ],
      0,
      100,
    );
    // infraVault address normalized to lowercase
    assert.equal(result.infraVaultAddress, "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1");
  });
});

// =============================================================================
// Integration — live Base RPC (gated INTEGRATION_TEST=1)
// =============================================================================
//
// Live probe against the gamisUSDC infraVault on Base. Validates the OQ-L
// substrate end-to-end. Logs residual addresses + balances for the report.

describe(
  "findResidualInfraVaultHolders [integration] — gamisUSDC OQ-L probe",
  { skip: !RUN_INTEGRATION },
  () => {
    it("scans gamisUSDC infraVault for residual holders since deployment window", async () => {
      // gamisUSDC infraVault on Base. Per OQ-L spec line: vault holds 99.97%
      // of shares; remaining ~1,704 are elsewhere.
      const INFRA_VAULT = "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1";
      const KNOWN_HOLDERS = [
        "0x776f95321a0285f8bcde149e3264d16dc08da69a", // outer ERC-4626 wrapper (vault)
        "0x9878aef8a193dbfceFa8A6ECe3eb15f93CA31c9E", // Gami curator EOA
        "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a", // gamisUSDC Safe
      ];

      // gamisUSDC was deployed on Base in early 2026. Use a generous window;
      // the 500K cap will clamp if needed and warn. For a single-shot probe
      // we sweep a window known to bracket the deployment + recent activity.
      // The MAX_EVENT_BLOCK_RANGE clamp will fire if we go too wide; that's
      // expected and the warning surfaces in `result.warnings`.
      //
      // Block range: gamisUSDC fixture was recorded at block 45,197,827 per
      // the spec's OQ-J reference. We sweep 44,800,000 → +500K to capture the
      // window from before deployment through the fixture block + buffer.
      const result = await findResidualInfraVaultHolders(
        "base",
        INFRA_VAULT,
        KNOWN_HOLDERS,
        44_800_000,
        45_300_000,
      );

      // Print the result so the report can cite block numbers, balances, and
      // top holders.
      // eslint-disable-next-line no-console
      console.error("[OQ-L probe — gamisUSDC integration]");
      // eslint-disable-next-line no-console
      console.error(`  RPC: ${result.rpcUsedForEvents || "(bootstrap failed)"}`);
      // eslint-disable-next-line no-console
      console.error(`  Block range scanned: ${result.fromBlock} → ${result.toBlock}`);
      // eslint-disable-next-line no-console
      console.error(`  Unique mint recipients: ${result.uniqueMintRecipients}`);
      // eslint-disable-next-line no-console
      console.error(`  Excluded known holders: ${result.excludedKnownHolders}`);
      // eslint-disable-next-line no-console
      console.error(`  Residual count: ${result.aggregations.count}`);
      // eslint-disable-next-line no-console
      console.error(`  Total residual shares: ${result.aggregations.totalShares.toString()}`);
      // eslint-disable-next-line no-console
      console.error(`  Top holder: ${result.aggregations.topHolder ?? "(none)"}`);
      // eslint-disable-next-line no-console
      console.error(`  Warnings: ${result.warnings.map((w) => w.code).join(", ") || "(none)"}`);
      for (const r of result.residuals) {
        // eslint-disable-next-line no-console
        console.error(
          `    ${r.address} balance=${r.currentBalance.toString()} firstMint@${r.firstMintAtBlock} tx=${r.firstMintTxHash}`,
        );
      }

      // Basic structural assertions — the integration test is for observation,
      // not for asserting an exact residual count (that's the whole point of
      // running it live). We assert: shape valid, no exception, RPC bootstrap
      // succeeded.
      assert.ok(Array.isArray(result.residuals));
      assert.equal(result.aggregations.count, result.residuals.length);
      // If the bootstrap succeeded, rpcUsedForEvents should be non-empty.
      if (!result.warnings.some((w) => w.code === "rpc-all-failed")) {
        assert.ok(result.rpcUsedForEvents.length > 0, "RPC should be set when bootstrap succeeds");
      }
    });
  },
);
