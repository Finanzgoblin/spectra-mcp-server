/**
 * Fixture-recording script for Theme A Phase 1 chain-reads tests.
 *
 * Records the raw eth_call / eth_getCode batch results for the two reference
 * MetaVaults at their pinned blocks, plus the metadata Phase 1's tests assert
 * against. The fixtures are used by `src/chain-reads.test.ts` to drive
 * unit-test assertions WITHOUT requiring live RPC during normal test runs
 * (the integration mode is gated separately by `INTEGRATION_TEST=1`).
 *
 * Run with `tsx`:
 *   npx tsx tests/fixtures/record-chain-state.ts
 *
 * Why this script lives in `tests/fixtures/` (NOT compiled into `build/`):
 *   - It runs against real RPCs and would otherwise pollute the production
 *     build artifact with developer-only tooling.
 *   - It's a one-shot tool — when fixtures need refreshing (e.g. block
 *     pinning advances or topology changes), the operator runs it once and
 *     commits the JSON output.
 *
 * The two reference vaults:
 *   - CSfusionMVWETH on mainnet (block 24,962,385) — pre-onboarding state,
 *     Safe holds curator seed, secondaryVault supply 0.
 *   - gamisUSDC on Base (block 45,197,827) — fully-loaded state, secondary
 *     wraps 99.97% of primary's totalSupply.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Reference vaults (block-pinned)
// =============================================================================

interface RefVault {
  name: string;
  chain: "mainnet" | "base";
  rpcUrls: string[];
  block: number;
  blockHex: string;
  // ChainReadInput projection
  address: string;
  vault: string;
  infraVault: string;
  underlying: { address: string; decimals: number; symbol: string };
}

const REF_VAULTS: RefVault[] = [
  {
    name: "csfusionmvweth-mainnet-24962385",
    chain: "mainnet",
    rpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://rpc.ankr.com/eth",
      "https://1rpc.io/eth",
    ],
    block: 24962385,
    blockHex: "0x" + (24962385).toString(16),
    address: "0x3b1913e474c37cbcf375e644d1af51589d8e44ea",
    vault: "0xefda9a1d6b5f4a0279c05b616924776c4d9dc13d",
    infraVault: "0x2151c851c1808c6609f24535dd77d8216f17118f",
    underlying: { address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", decimals: 18, symbol: "WETH" },
  },
  {
    name: "gamisusdc-base-45197827",
    chain: "base",
    rpcUrls: [
      "https://base-rpc.publicnode.com",
      "https://1rpc.io/base",
    ],
    block: 45197827,
    blockHex: "0x" + (45197827).toString(16),
    address: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
    vault: "0x776f95321a0285f8bcde149e3264d16dc08da69a",
    infraVault: "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1",
    underlying: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC" },
  },
];

// =============================================================================
// Selectors (mirrored from src/chain-reads.ts to keep this script standalone)
// =============================================================================

const SELECTORS = {
  totalSupply: "0x18160ddd",
  totalAssets: "0x01e1d114",
  asset: "0x38d52e0f",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  balanceOf: "0x70a08231",
  owner: "0x8da5cb5b",
  paused: "0x5c975abb",
  masterCopy: "0xa619486e",
  // Phase 2 (BLOCKER #4) — capacity reads
  maxWithdraw: "0xce96cb77",
  maxRedeem: "0xd905777e",
  previewRedeem: "0x4cdad506",
} as const;

function encodeBalanceOf(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return SELECTORS.balanceOf + clean.padStart(64, "0");
}

// =============================================================================
// RPC plumbing
// =============================================================================

interface RpcCall {
  method: string;
  params: unknown[];
}

interface RpcCallResult {
  result?: string;
  error?: { code?: number; message?: string };
}

async function tryBatch(
  rpcUrl: string,
  calls: RpcCall[],
): Promise<RpcCallResult[] | null> {
  try {
    const body = calls.map((call, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: call.method,
      params: call.params,
    }));
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.error(`  ${rpcUrl}: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) {
      console.error(`  ${rpcUrl}: non-array response`);
      return null;
    }
    const arr = json as Array<{ id?: number; result?: string; error?: { code?: number; message?: string } }>;
    if (arr.length < calls.length) {
      console.error(`  ${rpcUrl}: short response (${arr.length}/${calls.length})`);
      return null;
    }
    const sorted: RpcCallResult[] = new Array(calls.length).fill({});
    for (const entry of arr) {
      if (typeof entry.id === "number" && entry.id >= 0 && entry.id < calls.length) {
        sorted[entry.id] = { result: entry.result, error: entry.error };
      }
    }
    return sorted;
  } catch (e) {
    console.error(`  ${rpcUrl}: ${(e as Error).message}`);
    return null;
  }
}

// Build the call list at a specific historical block. Order MUST match
// the engine in src/chain-reads.ts (see comments there for why).
//
// Phase 2 (BLOCKER #4): secondaryVault block grew from 8 to 11 calls
// (maxWithdraw(self), maxRedeem(self), previewRedeem(1 share)). The
// wrapper-signature call shifted from index 22 to index 25.
function buildCalls(rv: RefVault, blockTag: string): RpcCall[] {
  const oneShareForPreview =
    "0x" + (10n ** BigInt(rv.underlying.decimals)).toString(16).padStart(64, "0");
  const vaultAsHolder = rv.vault.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return [
    // [0..3] Safe block
    { method: "eth_getCode", params: [rv.address, blockTag] },
    { method: "eth_call", params: [{ to: rv.address, data: SELECTORS.masterCopy }, blockTag] },
    { method: "eth_call", params: [{ to: rv.underlying.address, data: encodeBalanceOf(rv.address) }, blockTag] },
    { method: "eth_call", params: [{ to: rv.address, data: SELECTORS.totalAssets }, blockTag] },
    // [4..13] infraVault block
    { method: "eth_getCode", params: [rv.infraVault, blockTag] },
    { method: "eth_call", params: [{ to: rv.infraVault, data: SELECTORS.totalAssets }, blockTag] },
    { method: "eth_call", params: [{ to: rv.infraVault, data: SELECTORS.totalSupply }, blockTag] },
    { method: "eth_call", params: [{ to: rv.infraVault, data: SELECTORS.asset }, blockTag] },
    { method: "eth_call", params: [{ to: rv.infraVault, data: SELECTORS.decimals }, blockTag] },
    { method: "eth_call", params: [{ to: rv.infraVault, data: SELECTORS.name }, blockTag] },
    { method: "eth_call", params: [{ to: rv.infraVault, data: SELECTORS.symbol }, blockTag] },
    { method: "eth_call", params: [{ to: rv.infraVault, data: SELECTORS.owner }, blockTag] },
    { method: "eth_call", params: [{ to: rv.infraVault, data: SELECTORS.paused }, blockTag] },
    { method: "eth_call", params: [{ to: rv.underlying.address, data: encodeBalanceOf(rv.infraVault) }, blockTag] },
    // [14..24] secondaryVault block (Phase 2: +3 capacity reads)
    { method: "eth_getCode", params: [rv.vault, blockTag] },
    { method: "eth_call", params: [{ to: rv.vault, data: SELECTORS.totalAssets }, blockTag] },
    { method: "eth_call", params: [{ to: rv.vault, data: SELECTORS.totalSupply }, blockTag] },
    { method: "eth_call", params: [{ to: rv.vault, data: SELECTORS.asset }, blockTag] },
    { method: "eth_call", params: [{ to: rv.vault, data: SELECTORS.decimals }, blockTag] },
    { method: "eth_call", params: [{ to: rv.vault, data: SELECTORS.name }, blockTag] },
    { method: "eth_call", params: [{ to: rv.vault, data: SELECTORS.symbol }, blockTag] },
    { method: "eth_call", params: [{ to: rv.underlying.address, data: encodeBalanceOf(rv.vault) }, blockTag] },
    { method: "eth_call", params: [{ to: rv.vault, data: SELECTORS.maxWithdraw + vaultAsHolder }, blockTag] },
    { method: "eth_call", params: [{ to: rv.vault, data: SELECTORS.maxRedeem + vaultAsHolder }, blockTag] },
    { method: "eth_call", params: [{ to: rv.vault, data: SELECTORS.previewRedeem + oneShareForPreview.replace(/^0x/, "") }, blockTag] },
    // [25] wrapper-signature: infraVault.balanceOf(secondaryVault)
    { method: "eth_call", params: [{ to: rv.infraVault, data: encodeBalanceOf(rv.vault) }, blockTag] },
  ];
}

// Some RPCs reject historical state queries from public endpoints. Try the
// pinned block first; if that fails across all RPCs, fall back to "latest"
// and record the fact (the fixture will be advisory rather than canonical).
async function recordVault(rv: RefVault): Promise<{
  ok: boolean;
  pinned: boolean;
  rpcUsed: string | null;
  results: RpcCallResult[] | null;
}> {
  console.error(`\n[${rv.name}] recording at block ${rv.block} (${rv.blockHex})`);
  for (const url of rv.rpcUrls) {
    const calls = buildCalls(rv, rv.blockHex);
    const result = await tryBatch(url, calls);
    if (result) {
      const hasAny = result.some((r) => r.result && r.result !== "0x");
      if (hasAny) {
        console.error(`  pinned-block recorded via ${url}`);
        return { ok: true, pinned: true, rpcUsed: url, results: result };
      } else {
        console.error(`  ${url}: all results empty at pinned block`);
      }
    }
  }
  console.error(`  falling back to "latest" tag — fixture will be advisory`);
  for (const url of rv.rpcUrls) {
    const calls = buildCalls(rv, "latest");
    const result = await tryBatch(url, calls);
    if (result) {
      const hasAny = result.some((r) => r.result && r.result !== "0x");
      if (hasAny) {
        console.error(`  latest recorded via ${url}`);
        return { ok: true, pinned: false, rpcUsed: url, results: result };
      }
    }
  }
  return { ok: false, pinned: false, rpcUsed: null, results: null };
}

async function main() {
  for (const rv of REF_VAULTS) {
    const rec = await recordVault(rv);
    if (!rec.ok || !rec.results) {
      console.error(`[${rv.name}] FAILED to record across all RPCs`);
      continue;
    }
    const fixture = {
      name: rv.name,
      chain: rv.chain,
      block: rec.pinned ? rv.block : null,
      blockPinned: rec.pinned,
      rpcUsed: rec.rpcUsed,
      input: {
        address: rv.address,
        vault: rv.vault,
        infraVault: rv.infraVault,
        underlying: rv.underlying,
      },
      // Indices match the engine's call order — see src/chain-reads.ts for the layout.
      results: rec.results,
      recordedAt: new Date().toISOString(),
    };
    const outPath = resolve(__dirname, `${rv.name}.json`);
    writeFileSync(outPath, JSON.stringify(fixture, null, 2));
    console.error(`  wrote ${outPath}`);
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
