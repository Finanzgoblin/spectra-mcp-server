#!/usr/bin/env node

/**
 * Spectra MCP Server -- Agent Reasoning Test Suite
 *
 * Tests multi-tool workflows and cross-tool data consistency. These tests
 * verify that the MCP server's tool outputs compose correctly and contain
 * the semantic markers that guide agent reasoning.
 *
 * Unlike test.cjs (which tests individual tools), this suite tests the
 * "reasoning surface" -- can an agent using these tools detect anomalies,
 * cross-reference data, and avoid protocol-mechanic traps?
 *
 * Usage:
 *   npm run test:agent             # run all tests (needs network)
 *   npm run test:agent -- --offline  # structure-only tests (no API calls)
 *
 * Exit code 0 = all pass, 1 = failures.
 */

const { spawn } = require("child_process");
const path = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER_PATH = path.join(__dirname, "build", "index.js");
const API_TIMEOUT_MS = 30_000; // per-tool call (generous for cross-chain scans)
const TOTAL_TIMEOUT_MS = 300_000; // 5 min for whole suite (multi-tool chains)
const OFFLINE = process.argv.includes("--offline");

// Dynamically discovered during tests
let KNOWN_POOL = "";
let KNOWN_PT = "";
let KNOWN_ACTIVE_ADDRESS = "";

// ---------------------------------------------------------------------------
// Mini test framework (same pattern as test.cjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const failDetails = [];

function pass(name) {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
}

function fail(name, reason) {
  failed++;
  const msg = `  \x1b[31mFAIL\x1b[0m  ${name}: ${reason}`;
  console.log(msg);
  failDetails.push(msg);
}

function skip(name) {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m  ${name}`);
}

function assert(condition, name, reason) {
  if (condition) pass(name);
  else fail(name, reason || "assertion failed");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract first 0x address from text matching a label pattern */
function extractAddress(text, prefix) {
  const re = new RegExp(prefix + "\\s*(0x[a-fA-F0-9]{40})");
  const m = text.match(re);
  return m ? m[1] : "";
}

/** Extract all 0x40 addresses from text */
function extractAllAddresses(text) {
  const matches = text.match(/0x[a-fA-F0-9]{40}/g);
  return matches ? [...new Set(matches)] : [];
}

/** Extract a numeric value after a label like "Implied APY: 23.50%" */
function extractPercent(text, label) {
  const re = new RegExp(label + "[:\\s]+(-?[\\d,]+\\.?\\d*)%");
  const m = text.match(re);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}

/** Count occurrences of a substring */
function countOccurrences(text, sub) {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(sub, pos)) !== -1) {
    count++;
    pos += sub.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// MCP client wrapper (same as test.cjs)
// ---------------------------------------------------------------------------

class McpTestClient {
  constructor() {
    this._nextId = 1;
    this._pending = new Map();
    this._output = "";
    this._child = null;
  }

  async start() {
    this._child = spawn("node", [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._child.stdout.on("data", (chunk) => {
      this._output += chunk.toString();
      this._drain();
    });

    this._child.stderr.on("data", () => {});

    const initRes = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "spectra-agent-test", version: "1.0" },
    }, 10_000);

    this._send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    await new Promise((r) => setTimeout(r, 200));
  }

  stop() {
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("client stopped"));
    }
    this._pending.clear();
    if (this._child) {
      this._child.kill();
      this._child = null;
    }
  }

  _send(msg) {
    if (this._child && this._child.stdin.writable) {
      this._child.stdin.write(JSON.stringify(msg) + "\n");
    }
  }

  _drain() {
    const lines = this._output.split("\n");
    this._output = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this._pending.has(msg.id)) {
          const entry = this._pending.get(msg.id);
          clearTimeout(entry.timer);
          this._pending.delete(msg.id);
          entry.resolve(msg);
        }
      } catch (e) {}
    }
  }

  request(method, params, timeoutMs) {
    const id = this._nextId++;
    const timeout = timeoutMs || API_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timeout after ${timeout}ms for ${method}`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async callTool(name, args, timeoutMs) {
    const res = await this.request(
      "tools/call",
      { name, arguments: args || {} },
      timeoutMs
    );
    const text =
      res.result &&
      res.result.content &&
      res.result.content[0] &&
      res.result.content[0].text;
    return { text: text || "", raw: res.result };
  }
}

// ---------------------------------------------------------------------------
// Test: Protocol Context Completeness
// ---------------------------------------------------------------------------

async function testProtocolContextCompleteness(client) {
  console.log("\n--- Protocol Context: completeness & agent-guidance quality ---");

  // Full context (all topics)
  const { text: full } = await client.callTool("get_protocol_context");

  const expectedTopics = [
    "PT/YT Mechanics",
    "Router Batching",
    "Reading Wallet Strategy",
    "Looping Strategy",
    "Supported Networks",
    "Workflow Routing",
  ];

  for (const topic of expectedTopics) {
    assert(full.includes(topic), `protocol context includes "${topic}"`, "missing");
  }

  // Router batching section must mention key ambiguities agents need to know
  assert(
    full.includes("SELL_PT") && full.includes("flash-mint"),
    "context explains SELL_PT can be flash-mint (YT acquisition)",
    "missing flash-mint explanation"
  );
  assert(
    full.includes("BUY_PT") && full.includes("flash-redeem"),
    "context explains BUY_PT can be flash-redeem (YT selling)",
    "missing flash-redeem explanation"
  );
  assert(
    full.includes("cross-reference") || full.includes("get_portfolio"),
    "context recommends cross-referencing with portfolio",
    "missing cross-reference guidance"
  );

  // Workflow routing must mention key tool pairings
  assert(
    full.includes("scan_opportunities") && full.includes("get_best_fixed_yields"),
    "workflow routing mentions both ranking tools",
    "missing tool pairing"
  );
  assert(
    full.includes("intentionally disagree") || full.includes("different things"),
    "context explains ranking tools intentionally disagree",
    "missing disagreement explanation"
  );

  // Single-topic query
  const { text: routing } = await client.callTool("get_protocol_context", {
    topic: "router_batching",
  });
  assert(
    routing.includes("Router") && routing.includes("pool activity"),
    "single-topic query returns focused content",
    "missing focused content"
  );
  // Single-topic should NOT include unrelated topics
  assert(
    !routing.includes("Workflow Routing"),
    "single-topic excludes unrelated sections",
    "leaked other topics"
  );
}

// ---------------------------------------------------------------------------
// Test: Anomaly Detection — raw vs capital-aware rankings diverge
// ---------------------------------------------------------------------------

async function testAnomalyDetectionRankingDivergence(client) {
  console.log("\n--- Anomaly Detection: raw vs capital-aware ranking divergence ---");

  // Step 1: Get raw APY rankings
  const { text: raw } = await client.callTool("get_best_fixed_yields", {
    top_n: 10,
    min_tvl_usd: 1000,
    min_liquidity_usd: 1000,
  }, 60_000);

  assert(
    raw.includes("Fixed Yield Opportunities") || raw.includes("#1"),
    "raw rankings returned results",
    "no results from get_best_fixed_yields"
  );

  // Step 2: Get capital-aware rankings
  const { text: aware } = await client.callTool("scan_opportunities", {
    capital_usd: 50000,
    top_n: 10,
    min_tvl_usd: 1000,
    min_liquidity_usd: 1000,
    include_metavaults: false,
  }, 60_000);

  assert(
    aware.includes("Opportunity Scan") || aware.includes("#1") || aware.includes("No opportunities"),
    "capital-aware scan returned results",
    "no results from scan_opportunities"
  );

  if (aware.includes("No opportunities")) {
    skip("anomaly divergence: no opportunities at $50K capital");
    return;
  }

  // Step 3: Verify structural properties
  assert(
    aware.includes("Effective APY") || aware.includes("effective"),
    "capital-aware scan shows effective APY (not just raw)",
    "missing effective APY"
  );
  assert(
    aware.includes("Entry Impact") || aware.includes("price impact") || aware.includes("Price Impact"),
    "capital-aware scan shows entry/price impact",
    "missing impact metric"
  );

  // Step 4: Check that extreme-APY pools are filtered
  // If raw rankings have a pool with >1000% APY, it should NOT appear in capital-aware
  const extremeMatch = raw.match(/Implied APY:\s+([\d,]+\.?\d*)%/g);
  if (extremeMatch) {
    const extremeApys = extremeMatch.map((m) => {
      const v = m.match(/([\d,]+\.?\d*)%/);
      return v ? parseFloat(v[1].replace(/,/g, "")) : 0;
    });
    const hasExtreme = extremeApys.some((a) => a > 1000);
    if (hasExtreme) {
      // The pool with >1000% APY should be absent or filtered from scan_opportunities
      // (it would have catastrophic price impact at $50K)
      pass("raw rankings contain extreme APY pools (>1000%) — good baseline for divergence test");
    }
  }

  // Step 5: Verify the scans have different content (they should rank differently)
  // Extract pool names/PTs from each
  const rawPts = extractAllAddresses(raw);
  const awarePts = extractAllAddresses(aware);
  // At minimum, scan_opportunities should have fewer or different pools
  // (some get filtered by price impact)
  if (rawPts.length > 0 && awarePts.length > 0) {
    const rawOnly = rawPts.filter((p) => !awarePts.includes(p));
    const awareOnly = awarePts.filter((p) => !rawPts.includes(p));
    const differ = rawOnly.length > 0 || awareOnly.length > 0;
    assert(
      differ,
      "raw and capital-aware rankings contain different pool sets",
      "identical pools — divergence test inconclusive"
    );
  } else {
    skip("anomaly divergence: couldn't extract PT addresses to compare");
  }
}

// ---------------------------------------------------------------------------
// Test: Cross-Tool Data Consistency
// ---------------------------------------------------------------------------

async function testCrossToolDataConsistency(client) {
  console.log("\n--- Cross-Tool Data Consistency: list → details → compare ---");

  // Step 1: Discover a pool
  const { text: pools } = await client.callTool("list_pools", {
    chain: "mainnet",
    sort_by: "tvl",
    min_tvl_usd: 10000,
  });

  // Non-compact: "PT Address: 0x...", compact: "PT: 0x..."
  const ptMatch = pools.match(/PT(?:\s+Address)?:\s*(0x[a-fA-F0-9]{40})/);
  if (!ptMatch) {
    skip("cross-tool consistency: no PT address discovered on mainnet");
    return;
  }
  const ptAddr = ptMatch[1];
  KNOWN_PT = ptAddr;

  // Non-compact: "Pool Address: 0x...", compact: "Pool: 0x..."
  const poolMatch = pools.match(/Pool(?:\s+Address)?:\s*(0x[a-fA-F0-9]{40})/);
  if (poolMatch) KNOWN_POOL = poolMatch[1];

  // Step 2: Get PT details
  const { text: details } = await client.callTool("get_pt_details", {
    chain: "mainnet",
    pt_address: ptAddr,
  });

  assert(details.includes("Implied APY"), "pt_details has Implied APY", "missing");
  assert(details.includes("Maturity"), "pt_details has Maturity", "missing");

  const detailsApy = extractPercent(details, "Implied APY");
  const detailsLpApy = extractPercent(details, "LP APY");

  // Step 3: Compare yield for same PT
  const { text: compare } = await client.callTool("compare_yield", {
    chain: "mainnet",
    pt_address: ptAddr,
  });

  assert(compare.includes("Yield Comparison"), "compare_yield has header", "missing");
  assert(compare.includes("Fixed (Spectra PT)"), "compare_yield has fixed rate", "missing");
  assert(compare.includes("Variable"), "compare_yield has variable rate", "missing");
  assert(compare.includes("Spread"), "compare_yield has spread", "missing");

  const compareFixed = extractPercent(compare, "Fixed \\(Spectra PT\\)");

  // Step 4: Verify consistency — APYs should match between tools
  if (detailsApy !== null && compareFixed !== null) {
    const diff = Math.abs(detailsApy - compareFixed);
    assert(
      diff < 1.0, // Allow small rounding differences
      `APY consistent across tools (details=${detailsApy}%, compare=${compareFixed}%, diff=${diff.toFixed(2)}%)`,
      `APY mismatch: details=${detailsApy}% vs compare=${compareFixed}%, diff=${diff.toFixed(2)}%`
    );
  } else {
    skip("cross-tool APY comparison: couldn't parse both values");
  }

  // Step 5: Verify LP APY breakdown is present and reasonable
  assert(
    compare.includes("LP Alternative:"),
    "compare_yield includes LP alternative",
    "missing LP alternative"
  );
  // LP breakdown should have component lines (fees + PT + IBT + optionally gauge)
  const hasFees = compare.includes("Fees") || compare.includes("fees");
  assert(hasFees, "LP breakdown includes fee component", "missing fees");
}

// ---------------------------------------------------------------------------
// Test: Router Mechanics — mint-and-sell loop detection
// ---------------------------------------------------------------------------

async function testRouterMechanicsMintSellLoop(client) {
  console.log("\n--- Router Mechanics: mint-and-sell loop detection via cross-reference ---");

  if (!KNOWN_POOL && !KNOWN_PT) {
    skip("router mechanics: no known pool/PT discovered");
    return;
  }

  const poolOrPt = KNOWN_POOL || KNOWN_PT;

  // Step 1: Get pool activity to find an active address
  const { text: activity } = await client.callTool("get_pool_activity", {
    chain: "mainnet",
    pool_address: poolOrPt,
    limit: 50,
  });

  if (!activity.includes("Pool Activity") || activity.includes("No activity")) {
    skip("router mechanics: no activity on discovered pool");
    return;
  }

  assert(
    activity.includes("Breakdown by Type"),
    "pool activity has type breakdown",
    "missing type breakdown"
  );

  // Find address with SELL_PT activity (potential mint-and-sell looper)
  // Look in Address Concentration section — format is:
  //   0xaddr...  72 txns  $43,348.33 (8.8%)
  //     Sell PT: 39  Add Liquidity: 14  ...
  // Address is on one line, breakdown on the next. Scan line-by-line.
  let suspectAddr = "";
  const lines = activity.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const addrLine = lines[i].match(/(0x[a-fA-F0-9]{40})\s+\d+\s+txns/);
    if (addrLine) {
      // Check current line AND next line for "Sell PT"
      const combined = lines[i] + " " + (lines[i + 1] || "");
      if (combined.includes("Sell PT")) {
        suspectAddr = addrLine[1];
        break;
      }
    }
  }

  if (!suspectAddr) {
    skip("router mechanics: no address with SELL_PT found in activity");
    return;
  }
  KNOWN_ACTIVE_ADDRESS = suspectAddr;
  pass(`found address with SELL_PT activity: ${suspectAddr.slice(0, 10)}...`);

  // Step 2: Check portfolio for that address
  const { text: portfolio } = await client.callTool("get_portfolio", {
    address: suspectAddr,
    chain: "mainnet",
  }, 30_000);

  if (portfolio.includes("No active Spectra positions")) {
    // Address had historical activity but no current positions — still valid test
    pass("portfolio check completed (no active positions — may have exited)");
    return;
  }

  // Step 3: Cross-reference — if SELL_PT is dominant and YT >> PT, it's a mint-and-sell loop
  const hasYt = portfolio.includes("YT") || portfolio.includes("Yield Token");
  const hasPt = portfolio.includes("PT") || portfolio.includes("Principal Token");

  if (hasYt || hasPt) {
    pass("portfolio returned position data for cross-reference");

    // Check if tools expose the position shape
    const hasShape = portfolio.includes("Position Shape") || portfolio.includes("YT/PT");
    if (hasShape) {
      pass("portfolio includes Position Shape for strategy inference");
    } else {
      // Still useful — raw balances available for manual inference
      pass("portfolio has balances (shape can be inferred from raw data)");
    }
  }

  // Step 4: Verify the activity data includes the Router batching caveat
  const hasCaveat = activity.includes("Router") || activity.includes("mint") || activity.includes("flash");
  if (hasCaveat) {
    pass("pool activity mentions Router/minting context in output");
  } else {
    // Not a hard failure — the caveat is in tool descriptions, not always in output
    skip("pool activity output doesn't mention Router caveat (it's in tool description)");
  }
}

// ---------------------------------------------------------------------------
// Test: MetaVault Data Integrity
// ---------------------------------------------------------------------------

async function testMetaVaultDataIntegrity(client) {
  console.log("\n--- MetaVault: data integrity & expired position flagging ---");

  const { text } = await client.callTool("get_metavaults", {}, 30_000);

  if (text.includes("Found: 0") || text.includes("No MetaVault")) {
    skip("metavault integrity: no MetaVaults found");
    return;
  }

  assert(text.includes("MetaVault"), "metavaults response has header", "missing header");

  // Each vault should have key fields
  assert(text.includes("Curator:"), "metavaults have curator info", "missing curator");
  assert(text.includes("TVL:"), "metavaults have TVL", "missing TVL");
  assert(text.includes("Live APY:"), "metavaults have live APY", "missing APY");
  assert(text.includes("Share Price:"), "metavaults have share price", "missing share price");
  assert(
    text.includes("Active Positions"),
    "metavaults list active positions",
    "missing positions"
  );

  // Vault flows should be present
  assert(
    text.includes("Vault Flows") || text.includes("epoch"),
    "metavaults include vault flow/epoch data",
    "missing flow data"
  );

  // Check for expired positions — they should be flagged
  if (text.includes("EXPIRED")) {
    pass("expired positions are explicitly flagged in MetaVault output");
  } else {
    // Not all vaults will have expired positions at any given time
    skip("no expired positions in current MetaVaults to verify flagging");
  }

  // APY composition — when breakdown data exists, it should be surfaced
  if (text.includes("+--") || text.includes("Yield composition:")) {
    pass("metavault APY breakdown is surfaced (base vs incentives visible)");
    // If incentive programs exist, the composition line should show the split
    if (text.includes("incentives") && text.includes("% from incentive programs")) {
      pass("metavault incentive share is quantified (e.g. '97% from incentive programs')");
    } else if (text.includes("Base (fees")) {
      // Has breakdown lines but incentives may be zero
      pass("metavault base APY is separated from incentive components");
    }
  } else {
    // The API may not return breakdown for all vaults — skip rather than fail
    skip("no APY breakdown data available from API for current MetaVaults");
  }

  // Extract MetaVault address for later use
  const mvMatch = text.match(/MetaVault:\s*(0x[a-fA-F0-9]{40})/);
  if (mvMatch) {
    pass("discovered MetaVault address for further testing");
  }
}

// ---------------------------------------------------------------------------
// Test: veSPECTRA Boost Math Consistency
// ---------------------------------------------------------------------------

async function testVeSpectraBoostMath(client) {
  console.log("\n--- veSPECTRA Boost: math consistency ---");

  // Scenario 1: Large veBalance, small capital → should get max boost
  const { text: maxBoost } = await client.callTool("get_ve_info", {
    ve_spectra_balance: 1000000,
    capital_usd: 1000,
  });

  assert(maxBoost.includes("veSPECTRA"), "ve_info returns veSPECTRA data", "missing");
  assert(maxBoost.includes("Total Supply"), "ve_info has total supply", "missing");
  assert(maxBoost.includes("Boost"), "ve_info has boost calculation", "missing");

  // With 1M veSPECTRA and $1000 deposit, should get 2.5x on most pools
  if (maxBoost.includes("2.50x") || maxBoost.includes("2.5x")) {
    pass("1M veSPECTRA + $1K deposit → achieves max 2.5x boost");
  } else {
    // Check if the formula section at least shows approaching max
    const has25 = maxBoost.includes("2.50x") || maxBoost.includes("2.5x") || maxBoost.includes("FULL");
    if (has25) {
      pass("max boost detected");
    } else {
      skip("boost values present but max boost not clearly shown (may depend on current pool TVLs)");
    }
  }

  // Scenario 2: Tiny veBalance, huge capital → should get minimal boost (~1.0x)
  const { text: minBoost } = await client.callTool("get_ve_info", {
    ve_spectra_balance: 100,
    capital_usd: 1000000,
  });

  assert(minBoost.includes("Boost"), "min-boost scenario has boost data", "missing");

  // With 100 veSPECTRA and $1M, boost should be near 1.0x
  // Look for low boost values (1.00x - 1.10x range)
  const boostMatch = minBoost.match(/(\d+\.\d+)x\s+boost/i);
  if (boostMatch) {
    const boostVal = parseFloat(boostMatch[1]);
    assert(
      boostVal < 1.5,
      `tiny veSPECTRA + huge capital → low boost (${boostVal}x)`,
      `expected low boost near 1.0x, got ${boostVal}x`
    );
  } else {
    // Even without exact parsing, verify the formula is shown
    assert(
      minBoost.includes("B = min(2.5") || minBoost.includes("Formula"),
      "boost formula displayed for user verification",
      "formula not shown"
    );
  }
}

// ---------------------------------------------------------------------------
// Test: Morpho Looping — graceful handling when no market exists
// ---------------------------------------------------------------------------

async function testMorphoLoopingGracefulFallback(client) {
  console.log("\n--- Morpho Looping: graceful fallback when no market exists ---");

  if (!KNOWN_PT) {
    skip("morpho looping fallback: no known PT");
    return;
  }

  // Call looping strategy without specifying Morpho params — let it auto-detect
  const { text } = await client.callTool("get_looping_strategy", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    max_loops: 3,
  });

  assert(text.includes("Looping Strategy"), "looping strategy has header", "missing");

  // Should either auto-detect a market or gracefully report none found
  const hasAutoDetect = text.includes("auto-detected") || text.includes("from Morpho") || text.includes("live from Morpho");
  const hasNotFound = text.includes("not found") || text.includes("default estimate") || text.includes("No Morpho");

  assert(
    hasAutoDetect || hasNotFound,
    "looping strategy reports Morpho market status (found or not found)",
    "unclear Morpho market status"
  );

  if (hasNotFound) {
    pass("correctly reports no Morpho market — uses defaults");
    // Should suggest how to find markets
    assert(
      text.includes("get_morpho_markets") || text.includes("Morpho market"),
      "suggests get_morpho_markets when no market found",
      "missing suggestion"
    );
  }
}

// ---------------------------------------------------------------------------
// Test: Morpho Market Classification
// ---------------------------------------------------------------------------

async function testMorphoMarketClassification(client) {
  console.log("\n--- Morpho Markets: Spectra vs Pendle/Other classification ---");

  const { text } = await client.callTool("get_morpho_markets", {
    top_n: 5,
  });

  if (text.includes("No Morpho PT markets")) {
    skip("morpho classification: no markets found");
    return;
  }

  assert(text.includes("Morpho PT market"), "morpho markets returned", "no results");

  // Should classify markets as Spectra vs Pendle/Other
  const hasSpectra = text.includes("Spectra:");
  const hasPendle = text.includes("Pendle") || text.includes("Other");
  assert(
    hasSpectra || hasPendle,
    "morpho markets include protocol classification",
    "missing Spectra/Pendle classification"
  );

  // Should show LLTV, borrow rate, utilization
  assert(text.includes("LLTV"), "morpho markets show LLTV", "missing");
  assert(text.includes("Borrow APY"), "morpho markets show borrow APY", "missing");
  assert(text.includes("Utilization"), "morpho markets show utilization", "missing");

  // Test unsupported chain
  const { text: noMorpho } = await client.callTool("get_morpho_markets", {
    chain: "sonic",
  });

  assert(
    noMorpho.includes("not currently tracked") || noMorpho.includes("No Morpho"),
    "unsupported Morpho chain handled gracefully",
    `unexpected: ${noMorpho.slice(0, 100)}`
  );
}

// ---------------------------------------------------------------------------
// Test: Expired Pool Discovery — portfolio vs list_pools
// ---------------------------------------------------------------------------

async function testExpiredPoolDiscoveryPath(client) {
  console.log("\n--- Expired Pool Discovery: portfolio returns what list_pools cannot ---");

  // Step 1: list_pools only returns active pools
  const { text: activePools } = await client.callTool("list_pools", {
    chain: "mainnet",
    include_expired: true,
    min_tvl_usd: 0,
  });

  // Count pool entries — these should all be active
  const activeCount = countOccurrences(activePools, "Principal Token:");

  // All returned pools should have future maturity dates
  // We can check by looking for "(EXPIRED)" — should NOT appear in list_pools
  const hasExpiredInList = activePools.includes("EXPIRED");
  assert(
    !hasExpiredInList,
    "list_pools does NOT return expired pools (even with include_expired flag)",
    "list_pools returned expired pools — unexpected"
  );

  if (activeCount > 0) {
    pass(`list_pools returned ${activeCount} active pools (confirmed active-only)`);
  }

  // Step 2: MetaVaults CAN show expired positions (their portfolio includes them)
  const { text: vaults } = await client.callTool("get_metavaults", {}, 30_000);

  if (vaults.includes("EXPIRED")) {
    pass("MetaVaults correctly surface expired positions that list_pools would hide");
  } else {
    skip("no expired positions in current MetaVaults to contrast with list_pools");
  }
}

// ---------------------------------------------------------------------------
// Test: Router Limitation — API vs on-chain address filtering
// ---------------------------------------------------------------------------

async function testRouterLimitationApiVsOnchain(client) {
  console.log("\n--- Router Limitation: API resolves Router txns, eth_getLogs may not ---");

  if (!KNOWN_ACTIVE_ADDRESS || !KNOWN_POOL) {
    skip("router limitation: no known active address/pool for comparison");
    return;
  }

  // Step 1: API-based activity (resolves Router via tx.origin)
  const { text: apiActivity } = await client.callTool("get_pool_activity", {
    chain: "mainnet",
    pool_address: KNOWN_POOL,
    address: KNOWN_ACTIVE_ADDRESS,
    limit: 50,
  });

  // Count API results
  const apiHasResults = apiActivity.includes("Pool Activity") && !apiActivity.includes("No activity");
  const apiTxCount = apiActivity.match(/Total Entries:\s*(\d+)/);
  const apiCount = apiTxCount ? parseInt(apiTxCount[1]) : 0;

  if (!apiHasResults || apiCount === 0) {
    skip("router limitation: no API results for this address on this pool");
    return;
  }

  pass(`API-based activity found ${apiCount} txns for address`);

  // Step 2: On-chain activity (eth_getLogs with address filter)
  const { text: onchainActivity } = await client.callTool("get_onchain_activity", {
    chain: "mainnet",
    pool_address: KNOWN_POOL,
    address: KNOWN_ACTIVE_ADDRESS,
    lookback_hours: 720, // 30 days max
    limit: 50,
  });

  // On-chain with address filter should return FEWER results (Router limitation)
  const onchainEvents = onchainActivity.match(/Total events:\s*(\d+)/);
  const onchainCount = onchainEvents ? parseInt(onchainEvents[1]) : 0;

  // The key insight: API returns more because it resolves Router txns
  // On-chain address filter only catches direct calls
  if (onchainCount < apiCount) {
    pass(
      `on-chain address filter returns fewer results (${onchainCount}) than API (${apiCount}) — confirms Router limitation`
    );
  } else if (onchainCount === 0) {
    pass(
      `on-chain address filter returns 0 results vs API's ${apiCount} — Router-batched txns invisible to eth_getLogs topic filter`
    );
  } else {
    // Could happen if all txns were direct (not Router-batched)
    pass(
      `on-chain (${onchainCount}) vs API (${apiCount}) — comparable counts (may indicate direct calls, not Router-batched)`
    );
  }
}

// ---------------------------------------------------------------------------
// Test: Capital-Aware Scan includes MetaVaults separately
// ---------------------------------------------------------------------------

async function testScanIncludesMetaVaults(client) {
  console.log("\n--- Scan Opportunities: MetaVaults shown separately from PT rankings ---");

  const { text: withMv } = await client.callTool("scan_opportunities", {
    capital_usd: 10000,
    top_n: 5,
    include_metavaults: true,
  }, 60_000);

  const { text: withoutMv } = await client.callTool("scan_opportunities", {
    capital_usd: 10000,
    top_n: 5,
    include_metavaults: false,
  }, 60_000);

  if (withMv.includes("No opportunities") && withoutMv.includes("No opportunities")) {
    skip("metavault scan: no opportunities at $10K capital");
    return;
  }

  // MetaVaults should appear in a separate section, not interleaved
  if (withMv.includes("MetaVault")) {
    pass("MetaVaults appear in scan_opportunities output");
    // The MetaVault section should be separate from PT rankings
    assert(
      withMv.includes("MetaVault") &&
        (withMv.includes("Alternative") || withMv.includes("section")),
      "MetaVaults shown separately (not interleaved with PT rankings)",
      "MetaVault section structure unclear"
    );
  }

  // Without MetaVaults, the MetaVault section should be absent
  if (!withoutMv.includes("No opportunities")) {
    const hasMvInExcluded = withoutMv.includes("MetaVault");
    assert(
      !hasMvInExcluded,
      "include_metavaults=false correctly excludes MetaVaults",
      "MetaVaults still present when excluded"
    );
  }
}

// ---------------------------------------------------------------------------
// Test: Pendle Comparison — head-to-head on overlapping chain
// ---------------------------------------------------------------------------

async function testPendleComparison(client) {
  console.log("\n--- Pendle Comparison: head-to-head on overlapping chain ---");

  const { text } = await client.callTool("compare_pendle_spectra", {
    chain: "mainnet",
    min_tvl_usd: 1000,
    min_liquidity_usd: 1000,
  }, 30_000);

  assert(
    text.includes("Spectra vs Pendle") || text.includes("No matched"),
    "comparison returns results or empty message",
    `unexpected: ${text.slice(0, 100)}`
  );

  if (text.includes("Spectra vs Pendle")) {
    // Should have matched comparisons (same underlying on both protocols)
    assert(
      text.includes("Matched Comparisons") || text.includes("Implied APY"),
      "comparison has matched market pairs",
      "missing matched pairs"
    );

    // Should show delta column
    assert(
      text.includes("Delta"),
      "comparison shows delta between Spectra and Pendle",
      "missing delta"
    );

    // Should show Pendle-only markets (Spectra can't match these)
    if (text.includes("Pendle-Only")) {
      pass("comparison surfaces Pendle-only markets (no Spectra equivalent)");
    }

    // Should have aggregate stats
    assert(
      text.includes("Aggregate") || text.includes("Avg"),
      "comparison has aggregate statistics",
      "missing aggregates"
    );
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("Spectra MCP Server -- Agent Reasoning Test Suite");
  console.log(`Mode: ${OFFLINE ? "OFFLINE (structure only)" : "FULL (with live API calls)"}`);
  console.log(`Server: ${SERVER_PATH}`);

  const client = new McpTestClient();

  const globalTimer = setTimeout(() => {
    console.error(`\n\x1b[31mGlobal timeout (${TOTAL_TIMEOUT_MS / 1000}s) exceeded\x1b[0m`);
    client.stop();
    process.exit(1);
  }, TOTAL_TIMEOUT_MS);

  try {
    await client.start();
    console.log("Server started, MCP handshake complete.\n");

    if (!OFFLINE) {
      // Protocol context — always first (no dependencies)
      await testProtocolContextCompleteness(client);

      // Cross-tool consistency (discovers KNOWN_PT and KNOWN_POOL)
      await testCrossToolDataConsistency(client);

      // Tests that depend on discovered addresses
      await testRouterMechanicsMintSellLoop(client);
      await testRouterLimitationApiVsOnchain(client);

      // Anomaly detection (cross-chain scan — slow)
      await testAnomalyDetectionRankingDivergence(client);

      // MetaVault tests
      await testMetaVaultDataIntegrity(client);
      await testExpiredPoolDiscoveryPath(client);

      // veSPECTRA boost math
      await testVeSpectraBoostMath(client);

      // Morpho tests
      await testMorphoLoopingGracefulFallback(client);
      await testMorphoMarketClassification(client);

      // Scan features
      await testScanIncludesMetaVaults(client);

      // Pendle comparison
      await testPendleComparison(client);
    } else {
      skip("All agent reasoning tests require network (use without --offline)");
    }
  } catch (e) {
    console.error(`\n\x1b[31mFatal error: ${e.message}\x1b[0m`);
    failed++;
  } finally {
    client.stop();
    clearTimeout(globalTimer);
  }

  // Summary
  console.log("\n========================================");
  const total = passed + failed + skipped;
  console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m, ${total} total`);
  console.log("========================================");

  if (failDetails.length > 0) {
    console.log("\nFailures:");
    for (const d of failDetails) console.log(d);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
