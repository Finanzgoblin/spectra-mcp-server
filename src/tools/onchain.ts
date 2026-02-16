/**
 * Tool: get_onchain_activity
 *
 * Fetches historical pool activity directly from on-chain event logs via eth_getLogs.
 * Fills the gap when the Spectra API's activity endpoint returns empty or incomplete
 * data (it only stores a limited time window of recent transactions).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork, CHAIN_BLOCK_TIMES, resolveRpcUrl } from "../config.js";
import { fetchBlockNumber, fetchBlockTimestamp, fetchLogs } from "../api.js";
import { formatDate, formatTokenAmount, formatActivityType } from "../formatters.js";

// =============================================================================
// Curve StableSwap-NG Event Signatures (keccak256 pre-computed)
// =============================================================================
// Topic0 values for eth_getLogs filtering. Computed from keccak256 of canonical
// ABI event signatures. These are permanent — ABI events never change for
// deployed contracts.
//
// Verified against real Spectra Curve pools on Base (Feb 2026):
//   TokenExchange:      33 matches across 4 pools
//   AddLiquidity:       33 matches across 4 pools
//   RemoveLiquidity:     8 matches across 4 pools
//   RemoveLiquidityOne:  8 matches across 4 pools

const EVENT_TOPICS = {
  // TokenExchange(address buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)
  TokenExchange: "0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140",

  // AddLiquidity(address provider, uint256[] token_amounts, uint256[] fees, uint256 invariant, uint256 token_supply)
  AddLiquidity: "0x189c623b666b1b45b83d7178f39b8c087cb09774317ca2f53c2d3c3726f222a2",

  // RemoveLiquidity(address provider, uint256[] token_amounts, uint256[] fees, uint256 token_supply)
  RemoveLiquidity: "0x347ad828e58cbe534d8f6b67985d791360756b18f0d95fd9f197a66cc46480ea",

  // RemoveLiquidityOne(address provider, int128 token_id, uint256 token_amount, uint256 coin_amount, uint256 token_supply)
  RemoveLiquidityOne: "0x6f48129db1f37ccb9cc5dd7e119cb32750cabdf75b48375d730d26ce3659bbe1",
} as const;

// All event topic0 values as an OR filter for eth_getLogs
const ALL_EVENT_TOPICS = Object.values(EVENT_TOPICS);

// =============================================================================
// ABI Decoding Helpers (pure hex parsing, no ethers/viem)
// =============================================================================

/** Extract a 32-byte hex word from log data at a given word index. */
function readWord(data: string, wordIndex: number): string {
  // data starts with "0x", each word is 64 hex chars
  const start = 2 + wordIndex * 64;
  return data.slice(start, start + 64);
}

/** Extract an address from a 32-byte padded topic or data word. */
function wordToAddress(hex32: string): string {
  return "0x" + hex32.slice(24).toLowerCase();
}

/** Parse a 32-byte word as uint256 (bigint). */
function wordToUint256(hex32: string): bigint {
  return BigInt("0x" + hex32);
}

/** Parse a 32-byte word as int128 (for Curve pool indices, always 0 or 1). */
function wordToInt128(hex32: string): number {
  const val = BigInt("0x" + hex32);
  // Two's complement for negative values (shouldn't happen for pool indices)
  if (val > BigInt("0x7fffffffffffffffffffffffffffffff")) {
    return Number(val - BigInt("0x100000000000000000000000000000000"));
  }
  return Number(val);
}

// =============================================================================
// Decoded Activity Types
// =============================================================================

type ActivityType = "BUY_PT" | "SELL_PT" | "AMM_ADD_LIQUIDITY" | "AMM_REMOVE_LIQUIDITY";

interface DecodedActivity {
  type: ActivityType;
  from: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  // Token amounts (raw, in native decimals)
  amount0?: bigint;  // IBT amount
  amount1?: bigint;  // PT amount
  // For TokenExchange: direction indicators
  soldId?: number;   // 0=IBT, 1=PT
  boughtId?: number; // 0=IBT, 1=PT
  timestamp?: number; // filled via block timestamp lookup
}

/**
 * Decode a raw event log into a DecodedActivity.
 * Returns null if the event is unrecognized or malformed.
 */
function decodeEventLog(log: { topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }): DecodedActivity | null {
  const topic0 = log.topics[0];
  const blockNumber = Number(BigInt(log.blockNumber));
  const logIndex = Number(BigInt(log.logIndex));
  const txHash = log.transactionHash;

  try {
    if (topic0 === EVENT_TOPICS.TokenExchange) {
      // TokenExchange: topic1 = buyer (indexed), data = [sold_id, tokens_sold, bought_id, tokens_bought]
      const from = log.topics[1] ? wordToAddress(log.topics[1].slice(2)) : "unknown";
      const soldId = wordToInt128(readWord(log.data, 0));
      const tokensSold = wordToUint256(readWord(log.data, 1));
      const boughtId = wordToInt128(readWord(log.data, 2));
      const tokensBought = wordToUint256(readWord(log.data, 3));

      // Curve pool index: 0 = IBT, 1 = PT
      // BUY_PT = sell IBT (index 0) to buy PT (index 1)
      // SELL_PT = sell PT (index 1) to buy IBT (index 0)
      const type: ActivityType = soldId === 0 && boughtId === 1 ? "BUY_PT" : "SELL_PT";

      return {
        type,
        from,
        blockNumber,
        txHash,
        logIndex,
        amount0: soldId === 0 ? tokensSold : tokensBought,   // IBT amount
        amount1: soldId === 1 ? tokensSold : tokensBought,   // PT amount
        soldId,
        boughtId,
      };
    }

    if (topic0 === EVENT_TOPICS.AddLiquidity) {
      // AddLiquidity: topic1 = provider (indexed), data = ABI-encoded dynamic arrays
      const from = log.topics[1] ? wordToAddress(log.topics[1].slice(2)) : "unknown";
      // For 2-token Curve pools: data layout is complex with dynamic arrays.
      // The token_amounts array starts at the offset pointed to by word 0.
      // Simplified: for StableSwap-NG 2-token pools, the data layout is:
      //   word0: offset to token_amounts (usually 0xa0 = 160 = 5 words)
      //   word1: offset to fees
      //   word2: invariant
      //   word3: token_supply
      //   word4: token_amounts length (= 2 for 2-token pool)
      //   word5: token_amounts[0] (IBT)
      //   word6: token_amounts[1] (PT)
      // Read the offset, then the array elements
      const arrOffset = Number(wordToUint256(readWord(log.data, 0))) / 32;
      const arrLen = Number(wordToUint256(readWord(log.data, arrOffset)));
      const amount0 = arrLen >= 1 ? wordToUint256(readWord(log.data, arrOffset + 1)) : 0n;
      const amount1 = arrLen >= 2 ? wordToUint256(readWord(log.data, arrOffset + 2)) : 0n;

      return {
        type: "AMM_ADD_LIQUIDITY",
        from,
        blockNumber,
        txHash,
        logIndex,
        amount0,
        amount1,
      };
    }

    if (topic0 === EVENT_TOPICS.RemoveLiquidity) {
      // RemoveLiquidity: topic1 = provider (indexed), data = ABI-encoded dynamic arrays
      const from = log.topics[1] ? wordToAddress(log.topics[1].slice(2)) : "unknown";
      const arrOffset = Number(wordToUint256(readWord(log.data, 0))) / 32;
      const arrLen = Number(wordToUint256(readWord(log.data, arrOffset)));
      const amount0 = arrLen >= 1 ? wordToUint256(readWord(log.data, arrOffset + 1)) : 0n;
      const amount1 = arrLen >= 2 ? wordToUint256(readWord(log.data, arrOffset + 2)) : 0n;

      return {
        type: "AMM_REMOVE_LIQUIDITY",
        from,
        blockNumber,
        txHash,
        logIndex,
        amount0,
        amount1,
      };
    }

    if (topic0 === EVENT_TOPICS.RemoveLiquidityOne) {
      // RemoveLiquidityOne(address provider, int128 token_id, uint256 token_amount, uint256 coin_amount, uint256 token_supply)
      // topic1 = provider (indexed), data = [token_id, token_amount, coin_amount, token_supply]
      const from = log.topics[1] ? wordToAddress(log.topics[1].slice(2)) : "unknown";
      const tokenId = wordToInt128(readWord(log.data, 0));
      const tokenAmount = wordToUint256(readWord(log.data, 1));
      const coinAmount = wordToUint256(readWord(log.data, 2));

      return {
        type: "AMM_REMOVE_LIQUIDITY",
        from,
        blockNumber,
        txHash,
        logIndex,
        // tokenId = which coin was withdrawn. tokenAmount = LP burned, coinAmount = tokens received
        amount0: tokenId === 0 ? coinAmount : 0n,  // IBT received
        amount1: tokenId === 1 ? coinAmount : 0n,  // PT received
      };
    }
  } catch (err) {
    console.error(`Failed to decode event log at block ${blockNumber}:`, err instanceof Error ? err.message : err);
  }

  return null;
}

// Maximum total block range per invocation (prevents timeout on large scans)
const MAX_TOTAL_BLOCK_RANGE = 50_000;

// =============================================================================
// Tool Registration
// =============================================================================

export function register(server: McpServer): void {
  server.tool(
    "get_onchain_activity",
    `Fetch historical pool activity directly from on-chain event logs via eth_getLogs.
Use this when the API-based get_pool_activity returns empty or incomplete data
(the API only stores a limited time window of recent transactions).

Reads Curve StableSwap-NG events (TokenExchange, AddLiquidity, RemoveLiquidity)
directly from the blockchain. Returns raw token amounts (not USD values — USD
conversion is not available from on-chain data alone).

The rpc_url parameter lets you supply an RPC endpoint for any chain, including
chains without hardcoded RPCs (e.g., Katana, Monad). If omitted, falls back to
the server's default public RPC for the chain (if available).

Block range strategy:
- Specify from_block/to_block for exact ranges
- Or specify lookback_hours to scan the last N hours (converted to blocks using
  estimated block times — approximate, not exact)
- Default: last ~24 hours if no range is specified

Limitations:
- No USD values (only raw token amounts in native decimals)
- Block timestamps are fetched for first/last block only (time range display)
- Public RPCs may rate-limit large scans; use a premium RPC for deep history
- Maximum ${MAX_TOTAL_BLOCK_RANGE.toLocaleString()} blocks per request (to prevent timeout)

Use get_pool_activity for recent data with USD values and rich analysis.
Use this tool for historical data beyond the API's retention window.`,
    {
      chain: CHAIN_ENUM.describe("The blockchain network"),
      pool_address: EVM_ADDRESS.describe("The Curve pool contract address (0x...). Must be the pool address, not a PT address."),
      rpc_url: z
        .string()
        .url()
        .optional()
        .describe(
          "RPC endpoint URL. Overrides the default public RPC for this chain. " +
          "Required for chains without default RPCs (katana, monad). " +
          "Use a premium RPC (Alchemy, Infura) for better reliability on large scans."
        ),
      from_block: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Start block number. If omitted, calculated from lookback_hours."),
      to_block: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("End block number. If omitted, uses the latest block."),
      lookback_hours: z
        .number()
        .min(1)
        .max(720)
        .default(24)
        .describe(
          "Hours to look back from current block (default 24, max 720 = 30 days). " +
          "Ignored if from_block is provided. Converted to blocks using estimated block times."
        ),
      address: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .optional()
        .describe("Filter events to a specific address (matches buyer/provider in events)."),
      type_filter: z
        .enum(["BUY_PT", "SELL_PT", "AMM_ADD_LIQUIDITY", "AMM_REMOVE_LIQUIDITY", "all"])
        .default("all")
        .describe("Filter by activity type. Default: all."),
      limit: z
        .number()
        .max(200)
        .default(50)
        .describe("Maximum number of events to return (default 50, max 200)."),
    },
    async ({ chain, pool_address, rpc_url, from_block, to_block, lookback_hours, address, type_filter, limit }) => {
      try {
        const network = resolveNetwork(chain);
        const rpcUrl = resolveRpcUrl(chain, rpc_url);

        if (!rpcUrl) {
          return {
            content: [{
              type: "text" as const,
              text: `No RPC URL available for ${chain}. Provide an rpc_url parameter, or use get_pool_activity for API-based data.\n` +
                `Chains with default RPCs: mainnet, base, arbitrum, optimism, avalanche, sonic, bsc, flare.`,
            }],
            isError: true,
          };
        }

        // --- Get current block ---
        const currentBlock = await fetchBlockNumber(rpcUrl);
        if (currentBlock === null) {
          return {
            content: [{
              type: "text" as const,
              text: `Failed to fetch current block number from RPC (${rpc_url ? "provided URL" : "default for " + chain}). ` +
                `The RPC may be down or rate-limited. Try a different rpc_url, or provide explicit from_block/to_block.`,
            }],
            isError: true,
          };
        }

        // --- Compute block range ---
        let effectiveFrom: number;
        let effectiveTo: number;

        if (from_block !== undefined) {
          effectiveFrom = from_block;
        } else {
          const blockTime = CHAIN_BLOCK_TIMES[network] || 2;
          const blocksToScan = Math.ceil(lookback_hours * 3600 / blockTime);
          effectiveFrom = Math.max(0, currentBlock - blocksToScan);
        }

        effectiveTo = to_block !== undefined ? to_block : currentBlock;

        // Cap range
        const requestedRange = effectiveTo - effectiveFrom;
        let rangeCapped = false;
        if (requestedRange > MAX_TOTAL_BLOCK_RANGE) {
          effectiveFrom = effectiveTo - MAX_TOTAL_BLOCK_RANGE;
          rangeCapped = true;
        }

        const totalRange = effectiveTo - effectiveFrom;

        // --- Fetch event logs ---
        const [rawLogs, chunksOk, chunksTotal] = await fetchLogs(
          rpcUrl,
          pool_address,
          [ALL_EVENT_TOPICS],  // topic0 OR filter
          effectiveFrom,
          effectiveTo,
        );

        // --- Decode logs ---
        const decoded: DecodedActivity[] = [];
        for (const log of rawLogs) {
          const activity = decodeEventLog(log);
          if (activity) decoded.push(activity);
        }

        // --- Filter by address ---
        let filtered = decoded;
        const addressFilter = address?.toLowerCase();
        if (addressFilter) {
          filtered = filtered.filter((e) => e.from === addressFilter);
        }

        // --- Filter by type ---
        if (type_filter !== "all") {
          filtered = filtered.filter((e) => e.type === type_filter);
        }

        // --- Fetch timestamps for time range display ---
        let startTimestamp: number | null = null;
        let endTimestamp: number | null = null;
        if (filtered.length > 0) {
          const [ts1, ts2] = await Promise.all([
            fetchBlockTimestamp(rpcUrl, filtered[0].blockNumber),
            filtered.length > 1
              ? fetchBlockTimestamp(rpcUrl, filtered[filtered.length - 1].blockNumber)
              : Promise.resolve(null),
          ]);
          startTimestamp = ts1;
          endTimestamp = ts2 ?? ts1;

          // Assign timestamps to decoded entries (first and last are exact, rest interpolated)
          if (startTimestamp !== null) {
            filtered[0].timestamp = startTimestamp;
          }
          if (endTimestamp !== null && filtered.length > 1) {
            filtered[filtered.length - 1].timestamp = endTimestamp;
          }
        }

        // --- Empty results ---
        if (filtered.length === 0) {
          const filterDesc = addressFilter
            ? `address ${address}` : type_filter !== "all"
            ? formatActivityType(type_filter) + " events" : "events";
          const lines = [
            `No ${filterDesc} found for pool ${pool_address} on ${chain}.`,
            `  Block Range: ${effectiveFrom.toLocaleString()} -> ${effectiveTo.toLocaleString()} (${totalRange.toLocaleString()} blocks)`,
            `  RPC: ${rpc_url ? "provided" : "default (" + chain + ")"}`,
            `  Chunks: ${chunksOk}/${chunksTotal} succeeded`,
            ``,
            `Suggestions:`,
            `  • Try a larger lookback_hours (current: ${lookback_hours}h, max: 720h)`,
            `  • Verify this is the Curve pool address, not the PT address`,
            `  • Check get_pool_activity for API-based recent data`,
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        // --- Clamp output ---
        const clampedLimit = Math.min(Math.max(1, limit), 200);
        const shown = filtered.slice(-clampedLimit); // most recent N events

        // --- Aggregate stats ---
        const typeCounts: Record<string, number> = {};
        for (const e of filtered) {
          typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
        }

        // Unique addresses
        const uniqueAddrs = new Set(filtered.map((e) => e.from));

        // --- Format output ---
        const rpcLabel = rpc_url ? "provided" : `default (${chain})`;
        const timeRange = startTimestamp && endTimestamp
          ? `${formatDate(startTimestamp)} -> ${formatDate(endTimestamp)}`
          : "timestamps unavailable";

        const lines: string[] = [
          `-- On-Chain Activity: ${pool_address.slice(0, 10)}...${pool_address.slice(-6)} --`,
          `  Chain: ${chain}`,
          `  RPC: ${rpcLabel}`,
          ...(addressFilter ? [`  Address: ${address}`] : []),
          `  Block Range: ${effectiveFrom.toLocaleString()} -> ${effectiveTo.toLocaleString()} (${totalRange.toLocaleString()} blocks)`,
          `  Time Range: ${timeRange}`,
          ...(rangeCapped ? [`  ⚠ Block range was capped to ${MAX_TOTAL_BLOCK_RANGE.toLocaleString()} blocks (requested ${requestedRange.toLocaleString()}). Use explicit from_block/to_block for deeper history.`] : []),
          `  Chunks: ${chunksOk}/${chunksTotal} succeeded`,
          `  Total Events: ${filtered.length} (decoded from ${rawLogs.length} raw logs)`,
          `  Filter: ${type_filter === "all" ? "All types" : formatActivityType(type_filter)}`,
          `  Unique Addresses: ${uniqueAddrs.size}`,
          ``,
          `  Breakdown by Type:`,
        ];

        for (const [t, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
          lines.push(`    ${formatActivityType(t).padEnd(22)} ${count} events`);
        }

        // Event table
        lines.push(``);
        lines.push(`  Events (${shown.length} of ${filtered.length}):`);
        lines.push(`  ${"Block".padEnd(12)} ${"Type".padEnd(18)} ${"IBT Amount".padEnd(20)} ${"PT Amount".padEnd(20)} ${"From".padEnd(14)} ${"Tx Hash"}`);
        lines.push(`  ${"─".repeat(96)}`);

        for (const e of shown) {
          const block = e.blockNumber.toLocaleString().padEnd(12);
          const actType = formatActivityType(e.type).padEnd(18);
          // Display token amounts — we don't know decimals, so show raw with 18 assumed
          // Most Spectra pools use 18-decimal IBTs. The output clearly states these are raw amounts.
          const ibt = e.amount0 !== undefined ? formatTokenAmount(e.amount0, 18).padEnd(20) : "—".padEnd(20);
          const pt = e.amount1 !== undefined ? formatTokenAmount(e.amount1, 18).padEnd(20) : "—".padEnd(20);
          const from = `${e.from.slice(0, 6)}...${e.from.slice(-4)}`.padEnd(14);
          const hash = `${e.txHash.slice(0, 10)}...`;
          lines.push(`  ${block} ${actType} ${ibt} ${pt} ${from} ${hash}`);
        }

        // Notes
        lines.push(``);
        lines.push(`  Note: Token amounts assume 18 decimals (standard for most Spectra IBTs/PTs).`);
        lines.push(`  Use get_pt_details to confirm actual decimals and current prices.`);

        // Next steps
        lines.push(``);
        lines.push(`--- Next Steps ---`);
        lines.push(`• Rich analysis (USD values, cycles): get_pool_activity(chain="${chain}", pool_address="${pool_address}")`);
        lines.push(`• Current holdings: get_portfolio(address="ADDRESS")`);
        lines.push(`• Pool rates & decimals: get_pt_details(chain="${chain}", pt_address="PT_ADDRESS")`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error fetching on-chain activity: ${e.message}` }],
          isError: true,
        };
      }
    }
  );
}
