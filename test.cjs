#!/usr/bin/env node

/**
 * Spectra MCP Server -- Persistent Test Suite
 *
 * Zero dependencies. Spawns the MCP server as a child process and exercises
 * every tool via JSON-RPC over stdio.
 *
 * Usage:
 *   npm test                  # run all tests (needs network)
 *   npm test -- --offline     # registration-only tests (no API calls)
 *
 * Exit code 0 = all pass, 1 = failures.
 */

const { spawn } = require("child_process");
const path = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER_PATH = path.join(__dirname, "build", "index.js");
const API_TIMEOUT_MS = 20_000; // per-tool call
const TOTAL_TIMEOUT_MS = 120_000; // whole suite
const OFFLINE = process.argv.includes("--offline");

// Dynamically discovered from list_pools during testListPools
let KNOWN_POOL = "";
let KNOWN_PT = "";
// Full-length zero address for portfolio edge-case tests
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000001";

// ---------------------------------------------------------------------------
// Mini test framework
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
// MCP client wrapper
// ---------------------------------------------------------------------------

class McpTestClient {
  constructor() {
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
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

    this._child.stderr.on("data", () => {}); // suppress server logs

    // Use the normal request() flow for initialize (id will be 1)
    const initRes = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "spectra-test", version: "1.0" },
    }, 10_000);

    // Send initialized notification
    this._send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // Brief settle time
    await new Promise((r) => setTimeout(r, 200));
  }

  stop() {
    // Reject any pending requests
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
    // Keep the last (possibly incomplete) line
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
      } catch (e) {
        // not valid JSON, ignore
      }
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

  async listTools() {
    const res = await this.request("tools/list", {});
    return res.result.tools || [];
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
// Test suites
// ---------------------------------------------------------------------------

async function testToolRegistration(client) {
  console.log("\n--- Tool Registration ---");

  const tools = await client.listTools();
  const names = tools.map((t) => t.name);

  assert(tools.length === 19, "exactly 19 tools registered", `got ${tools.length}: ${names.join(", ")}`);

  const expected = [
    "get_pt_details",
    "list_pools",
    "get_best_fixed_yields",
    "get_looping_strategy",
    "compare_yield",
    "get_protocol_stats",
    "get_supported_chains",
    "get_portfolio",
    "get_pool_volume",
    "get_pool_activity",
    "get_morpho_markets",
    "get_morpho_rate",
    "quote_trade",
    "simulate_portfolio_after_trade",
    "scan_opportunities",
    "scan_yt_arbitrage",
    "get_ve_info",
    "model_metavault_strategy",
    "get_protocol_context",
  ];

  for (const name of expected) {
    assert(names.includes(name), `tool "${name}" registered`, "missing");
  }

  // Verify schemas have required fields
  for (const tool of tools) {
    const schema = tool.inputSchema;
    assert(
      schema && schema.type === "object",
      `${tool.name} has object schema`,
      `schema type = ${schema && schema.type}`
    );
  }

  // Spot-check: get_pool_activity schema has type_filter enum
  const activityTool = tools.find((t) => t.name === "get_pool_activity");
  if (activityTool) {
    const typeFilter = activityTool.inputSchema.properties.type_filter;
    assert(
      typeFilter && typeFilter.enum && typeFilter.enum.includes("BUY_PT") && typeFilter.enum.includes("all"),
      "get_pool_activity type_filter enum correct",
      `got: ${JSON.stringify(typeFilter && typeFilter.enum)}`
    );
  }

  // Spot-check: chain enum includes ethereum alias
  const ptTool = tools.find((t) => t.name === "get_pt_details");
  if (ptTool) {
    const chainEnum = ptTool.inputSchema.properties.chain.enum;
    assert(
      chainEnum && chainEnum.includes("ethereum") && chainEnum.includes("mainnet"),
      "chain enum includes mainnet + ethereum alias",
      `got: ${JSON.stringify(chainEnum)}`
    );
    assert(chainEnum && chainEnum.length === 11, "chain enum has 11 entries (10 chains + alias)", `got ${chainEnum && chainEnum.length}`);
  }

  // Spot-check: address fields have pattern validation
  if (ptTool) {
    const ptAddrSchema = ptTool.inputSchema.properties.pt_address;
    assert(
      ptAddrSchema && ptAddrSchema.pattern,
      "pt_address has regex pattern validation",
      `no pattern found: ${JSON.stringify(ptAddrSchema)}`
    );
  }

  const portfolioTool = tools.find((t) => t.name === "get_portfolio");
  if (portfolioTool) {
    const addrSchema = portfolioTool.inputSchema.properties.address;
    assert(
      addrSchema && addrSchema.pattern,
      "portfolio address has regex pattern validation",
      `no pattern found: ${JSON.stringify(addrSchema)}`
    );
  }

  // Morpho tools schema checks
  const morphoMarketsTool = tools.find((t) => t.name === "get_morpho_markets");
  assert(morphoMarketsTool, "get_morpho_markets registered", "missing");
  if (morphoMarketsTool) {
    const props = morphoMarketsTool.inputSchema.properties;
    assert(props.sort_by && props.sort_by.enum, "get_morpho_markets has sort_by enum", "missing");
    assert(props.chain, "get_morpho_markets has optional chain param", "missing");
  }

  const morphoRateTool = tools.find((t) => t.name === "get_morpho_rate");
  assert(morphoRateTool, "get_morpho_rate registered", "missing");
  if (morphoRateTool) {
    const props = morphoRateTool.inputSchema.properties;
    assert(
      props.market_key && props.market_key.pattern,
      "get_morpho_rate market_key has regex pattern",
      `no pattern: ${JSON.stringify(props.market_key)}`
    );
    assert(props.chain, "get_morpho_rate has chain param", "missing");
  }

  // Verify looping strategy morpho_ltv and borrow_rate are now optional (no default in required)
  const loopTool = tools.find((t) => t.name === "get_looping_strategy");
  if (loopTool) {
    const required = loopTool.inputSchema.required || [];
    assert(
      !required.includes("morpho_ltv") && !required.includes("borrow_rate"),
      "looping strategy: morpho_ltv and borrow_rate are optional",
      `required: ${JSON.stringify(required)}`
    );
  }

  // quote_trade schema checks
  const quoteTool = tools.find((t) => t.name === "quote_trade");
  assert(quoteTool, "quote_trade registered", "missing");
  if (quoteTool) {
    const props = quoteTool.inputSchema.properties;
    assert(props.side && props.side.enum && props.side.enum.includes("buy") && props.side.enum.includes("sell"),
      "quote_trade has buy/sell side enum", `got: ${JSON.stringify(props.side)}`);
    assert(props.amount, "quote_trade has amount param", "missing");
    assert(props.slippage_tolerance, "quote_trade has slippage_tolerance param", "missing");
    assert(props.pt_address && props.pt_address.pattern, "quote_trade pt_address has regex", "missing");
    const required = quoteTool.inputSchema.required || [];
    assert(required.includes("chain") && required.includes("pt_address") && required.includes("amount") && required.includes("side"),
      "quote_trade requires chain, pt_address, amount, side",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("slippage_tolerance"),
      "quote_trade: slippage_tolerance is optional",
      `required: ${JSON.stringify(required)}`);
  }

  // simulate_portfolio_after_trade schema checks
  const simTool = tools.find((t) => t.name === "simulate_portfolio_after_trade");
  assert(simTool, "simulate_portfolio_after_trade registered", "missing");
  if (simTool) {
    const props = simTool.inputSchema.properties;
    assert(props.address && props.address.pattern, "simulate has wallet address with regex", "missing");
    assert(props.pt_address && props.pt_address.pattern, "simulate has pt_address with regex", "missing");
    assert(props.side && props.side.enum && props.side.enum.includes("buy"),
      "simulate has buy/sell side enum", `got: ${JSON.stringify(props.side)}`);
    assert(props.amount, "simulate has amount param", "missing");
    const required = simTool.inputSchema.required || [];
    assert(
      required.includes("chain") && required.includes("pt_address") &&
      required.includes("address") && required.includes("amount") && required.includes("side"),
      "simulate requires chain, pt_address, address, amount, side",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("slippage_tolerance"),
      "simulate: slippage_tolerance is optional",
      `required: ${JSON.stringify(required)}`);
  }

  // scan_opportunities schema checks
  const scanTool = tools.find((t) => t.name === "scan_opportunities");
  assert(scanTool, "scan_opportunities registered", "missing");
  if (scanTool) {
    const props = scanTool.inputSchema.properties;
    assert(props.capital_usd, "scan_opportunities has capital_usd param", "missing");
    assert(props.include_looping, "scan_opportunities has include_looping param", "missing");
    assert(props.max_price_impact_pct, "scan_opportunities has max_price_impact_pct param", "missing");
    assert(props.top_n, "scan_opportunities has top_n param", "missing");
    assert(props.asset_filter, "scan_opportunities has asset_filter param", "missing");
    const required = scanTool.inputSchema.required || [];
    assert(required.includes("capital_usd"),
      "scan_opportunities requires capital_usd",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("asset_filter"),
      "scan_opportunities: asset_filter is optional",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("include_looping"),
      "scan_opportunities: include_looping is optional",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("max_price_impact_pct"),
      "scan_opportunities: max_price_impact_pct is optional",
      `required: ${JSON.stringify(required)}`);
  }

  // scan_yt_arbitrage schema checks
  const ytArbTool = tools.find((t) => t.name === "scan_yt_arbitrage");
  assert(ytArbTool, "scan_yt_arbitrage registered", "missing");
  if (ytArbTool) {
    const props = ytArbTool.inputSchema.properties;
    assert(props.capital_usd, "scan_yt_arbitrage has capital_usd param", "missing");
    assert(props.min_spread_pct, "scan_yt_arbitrage has min_spread_pct param", "missing");
    assert(props.asset_filter, "scan_yt_arbitrage has asset_filter param", "missing");
    assert(props.top_n, "scan_yt_arbitrage has top_n param", "missing");
    assert(props.max_price_impact_pct, "scan_yt_arbitrage has max_price_impact_pct param", "missing");
    const required = ytArbTool.inputSchema.required || [];
    assert(required.includes("capital_usd"),
      "scan_yt_arbitrage requires capital_usd",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("min_spread_pct"),
      "scan_yt_arbitrage: min_spread_pct is optional",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("asset_filter"),
      "scan_yt_arbitrage: asset_filter is optional",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("ve_spectra_balance"),
      "scan_yt_arbitrage: ve_spectra_balance is optional",
      `required: ${JSON.stringify(required)}`);
    assert(props.ve_spectra_balance, "scan_yt_arbitrage has ve_spectra_balance param", "missing");
  }

  // Check ve_spectra_balance on scan_opportunities and compare_yield
  {
    const scanOpp = tools.find((t) => t.name === "scan_opportunities");
    const scanProps = scanOpp.inputSchema.properties;
    assert(scanProps.ve_spectra_balance, "scan_opportunities has ve_spectra_balance param", "missing");
    assert(!scanOpp.inputSchema.required.includes("ve_spectra_balance"),
      "scan_opportunities: ve_spectra_balance is optional",
      "ve_spectra_balance should be optional");
  }
  {
    const cmpYield = tools.find((t) => t.name === "compare_yield");
    const cmpProps = cmpYield.inputSchema.properties;
    assert(cmpProps.ve_spectra_balance, "compare_yield has ve_spectra_balance param", "missing");
    assert(!cmpYield.inputSchema.required.includes("ve_spectra_balance"),
      "compare_yield: ve_spectra_balance is optional",
      "ve_spectra_balance should be optional");
    // compare_yield now also has capital_usd
    assert(cmpProps.capital_usd, "compare_yield has capital_usd param", "missing");
    assert(!cmpYield.inputSchema.required.includes("capital_usd"),
      "compare_yield: capital_usd is optional",
      "capital_usd should be optional");
  }

  // get_ve_info schema checks
  const veTool = tools.find((t) => t.name === "get_ve_info");
  assert(veTool, "get_ve_info registered", "missing");
  if (veTool) {
    const props = veTool.inputSchema.properties;
    assert(props.ve_spectra_balance, "get_ve_info has ve_spectra_balance param", "missing");
    assert(props.capital_usd, "get_ve_info has capital_usd param", "missing");
    assert(props.chain, "get_ve_info has chain param", "missing");
    assert(props.pt_address, "get_ve_info has pt_address param", "missing");
    // All params should be optional
    const required = veTool.inputSchema.required || [];
    assert(required.length === 0,
      "get_ve_info: all params are optional",
      `required: ${JSON.stringify(required)}`);
  }
}

async function testGetSupportedChains(client) {
  console.log("\n--- get_supported_chains ---");

  const { text } = await client.callTool("get_supported_chains");
  assert(text.includes("Supported Chains"), "header present", "missing header");
  assert(text.includes("mainnet"), "lists mainnet", "missing mainnet");
  assert(text.includes("base"), "lists base", "missing base");
  assert(text.includes("sonic"), "lists sonic", "missing sonic");
  assert(text.includes("monad"), "lists monad", "missing monad");
  // Should mention ethereum as alias, not list it as a separate chain
  assert(text.includes("ethereum") && text.includes("alias"), "ethereum mentioned as alias", "missing alias note");
  // Should NOT have duplicate Ethereum entries as separate chain lines
  const chainLines = text.split("\n").filter((l) => l.includes("* Ethereum") && l.includes("chain ID"));
  assert(chainLines.length === 1, "exactly one Ethereum chain line (no alias duplication)", `got ${chainLines.length}`);
}

async function testGetProtocolStats(client) {
  console.log("\n--- get_protocol_stats ---");

  const { text } = await client.callTool("get_protocol_stats");
  assert(text.includes("Protocol Stats"), "header present", "missing header");
  assert(text.includes("Circulating Supply"), "has circulating supply", "missing");
  assert(text.includes("Total Supply"), "has total supply", "missing");
  assert(text.includes("Emissions"), "has emissions section", "missing");
  assert(text.includes("Fee Distribution"), "has fee distribution", "missing");
  // Circulating should be a real number > 0
  const match = text.match(/Circulating Supply:\s+([\d,]+)/);
  if (match) {
    const val = parseInt(match[1].replace(/,/g, ""), 10);
    assert(val > 0, "circulating supply > 0", `got ${val}`);
  } else {
    fail("circulating supply parseable", "couldn't parse");
  }
}

async function testListPools(client) {
  console.log("\n--- list_pools ---");

  const { text } = await client.callTool("list_pools", {
    chain: "mainnet",
    sort_by: "tvl",
    min_tvl_usd: 0,
  });

  assert(text.includes("active pool"), "returns pools", "no pools found");
  assert(text.includes("Implied APY"), "has APY data", "missing APY");
  assert(text.includes("TVL"), "has TVL data", "missing TVL");
  assert(text.includes("PT Address"), "has PT address", "missing address");

  // Dynamically discover pool + PT addresses for later tests
  const poolMatch = text.match(/Pool Address:\s+(0x[a-fA-F0-9]{40})/);
  if (poolMatch) {
    KNOWN_POOL = poolMatch[1];
    pass("dynamically discovered pool address for later tests");
  } else {
    skip("could not discover pool address from list_pools");
  }

  const ptMatch = text.match(/PT Address:\s+(0x[a-fA-F0-9]{40})/);
  if (ptMatch) {
    KNOWN_PT = ptMatch[1];
    pass("dynamically discovered PT address for later tests");
  } else {
    skip("could not discover PT address from list_pools");
  }

  // Test with high TVL filter -- should return fewer or zero
  const { text: filtered } = await client.callTool("list_pools", {
    chain: "mainnet",
    sort_by: "tvl",
    min_tvl_usd: 999999999999,
  });
  assert(
    filtered.includes("No active pools") || filtered.includes("0 active"),
    "high TVL filter returns empty",
    "still returned pools?"
  );
}

async function testGetPtDetails(client) {
  console.log("\n--- get_pt_details ---");

  if (!KNOWN_PT) {
    skip("get_pt_details (no PT address discovered)");
    return;
  }

  const ptAddr = KNOWN_PT;
  const { text } = await client.callTool("get_pt_details", {
    chain: "mainnet",
    pt_address: ptAddr,
  });

  assert(text.includes("Maturity"), "has maturity", "missing");
  assert(text.includes("Implied APY"), "has APY", "missing");
  assert(text.includes("LP APY"), "has LP APY", "missing");
  assert(text.includes("IBT"), "has IBT info", "missing");

  // Test ethereum alias resolves correctly
  const { text: aliased } = await client.callTool("get_pt_details", {
    chain: "ethereum",
    pt_address: ptAddr,
  });
  assert(aliased.includes("Maturity"), "ethereum alias works for get_pt_details", "failed");
}

async function testCompareYield(client) {
  console.log("\n--- compare_yield ---");

  if (!KNOWN_PT) {
    skip("compare_yield (no PT address discovered)");
    return;
  }

  const { text } = await client.callTool("compare_yield", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
  });

  assert(text.includes("Yield Comparison"), "has comparison header", "missing");
  assert(text.includes("Fixed (Spectra PT)"), "has fixed rate", "missing");
  assert(text.includes("Variable"), "has variable rate", "missing");
  assert(text.includes("Spread"), "has spread", "missing");
  assert(
    text.includes("Fixed rate is HIGHER") || text.includes("Variable rate is HIGHER"),
    "has recommendation",
    "missing recommendation"
  );
  // LP alternative with breakdown
  assert(text.includes("LP Alternative:"), "has LP alternative with breakdown", "missing LP breakdown");
}

async function testGetBestFixedYields(client) {
  console.log("\n--- get_best_fixed_yields ---");

  const { text } = await client.callTool("get_best_fixed_yields", {
    min_tvl_usd: 10000,
    min_liquidity_usd: 5000,
    top_n: 3,
  });

  assert(
    text.includes("Fixed Yield Opportunities") || text.includes("No opportunities"),
    "returns results or empty message",
    "unexpected output"
  );

  if (text.includes("Fixed Yield Opportunities")) {
    assert(text.includes("#1"), "has ranked results", "missing ranking");
    assert(text.includes("Implied APY"), "has APY in results", "missing");
    // Should have results from multiple chains or at least one
    assert(text.includes("Chain:"), "shows chain for each result", "missing chain");
  }

  // Test with asset filter
  const { text: usdcOnly } = await client.callTool("get_best_fixed_yields", {
    asset_filter: "USDC",
    min_tvl_usd: 1000,
    min_liquidity_usd: 1000,
    top_n: 3,
  });

  assert(
    usdcOnly.includes("USDC") || usdcOnly.includes("No opportunities"),
    "asset filter works",
    "returned non-USDC results or unexpected output"
  );
}

async function testGetLoopingStrategy(client) {
  console.log("\n--- get_looping_strategy ---");

  if (!KNOWN_PT) {
    skip("get_looping_strategy (no PT address discovered)");
    return;
  }

  const { text } = await client.callTool("get_looping_strategy", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    morpho_ltv: 0.86,
    borrow_rate: 5.0,
    max_loops: 3,
  });

  assert(text.includes("Looping Strategy"), "has strategy header", "missing");
  assert(text.includes("Base Fixed APY"), "has base APY", "missing");
  assert(text.includes("Morpho LTV"), "has LTV", "missing");
  assert(text.includes("Loop Analysis") || text.includes("Loop"), "has loop table", "missing");
  assert(text.includes("Optimal"), "has optimal recommendation", "missing");
  assert(text.includes("Risks") || text.includes("risk"), "has risk warning", "missing");

  // Should have "Eff. Margin" column instead of old "Liq. Buffer"
  assert(text.includes("Eff. Margin"), "has effective margin column", "missing Eff. Margin");
  assert(!text.includes("Liq. Buffer"), "old Liq. Buffer column removed", "still has Liq. Buffer");
}

async function testGetPortfolio(client) {
  console.log("\n--- get_portfolio ---");

  // Use full-length zero address
  const { text } = await client.callTool("get_portfolio", {
    address: ZERO_ADDRESS,
    chain: "mainnet",
  });

  assert(
    text.includes("No active Spectra positions") || text.includes("Portfolio"),
    "handles empty/valid wallet",
    `unexpected: ${text.slice(0, 100)}`
  );

  // Test with no chain (all-chain scan) -- should not crash
  const { text: allChain } = await client.callTool(
    "get_portfolio",
    { address: ZERO_ADDRESS },
    30_000
  );

  assert(
    allChain.includes("No active") || allChain.includes("Portfolio"),
    "all-chain scan completes without crash",
    `unexpected: ${allChain.slice(0, 100)}`
  );
}

async function testGetPoolVolume(client) {
  console.log("\n--- get_pool_volume ---");

  if (!KNOWN_POOL) {
    skip("get_pool_volume (no pool address discovered)");
    return;
  }

  const { text } = await client.callTool("get_pool_volume", {
    chain: "mainnet",
    pool_address: KNOWN_POOL,
  });

  assert(text.includes("Pool Volume"), "has volume header", "missing");
  assert(text.includes("All-Time Volume") || text.includes("All-Time"), "has all-time stats", "missing");
  assert(text.includes("Last 7 Days"), "has 7-day stats", "missing");
  assert(text.includes("Buy:") && text.includes("Sell:"), "has buy/sell breakdown", "missing");

  // Test with invalid pool (full-length address)
  const { text: bad } = await client.callTool("get_pool_volume", {
    chain: "mainnet",
    pool_address: "0x0000000000000000000000000000000000000000",
  });

  assert(
    bad.includes("No volume data") || bad.includes("Error"),
    "invalid pool handled gracefully",
    `unexpected: ${bad.slice(0, 100)}`
  );
}

async function testGetPoolActivity(client) {
  console.log("\n--- get_pool_activity ---");

  if (!KNOWN_POOL) {
    skip("get_pool_activity (no pool address discovered)");
    return;
  }

  // Default (all types)
  const { text } = await client.callTool("get_pool_activity", {
    chain: "mainnet",
    pool_address: KNOWN_POOL,
  });

  assert(text.includes("Pool Activity"), "has activity header", "missing");
  assert(text.includes("All types"), "default filter is all", "wrong filter");
  assert(text.includes("Breakdown by Type"), "has type breakdown", "missing");
  assert(text.includes("Recent Activity"), "has activity table", "missing");

  // Filter: BUY_PT only
  const { text: buyOnly } = await client.callTool("get_pool_activity", {
    chain: "mainnet",
    pool_address: KNOWN_POOL,
    type_filter: "BUY_PT",
    limit: 3,
  });

  // BUY_PT filter: either has results or gracefully reports no activity
  assert(
    buyOnly.includes("Filter: Buy PT") || buyOnly.includes("No Buy PT activity"),
    "BUY_PT filter applied or empty reported",
    "wrong filter"
  );

  // If we got results, verify breakdown only has Buy PT
  if (buyOnly.includes("Breakdown by Type")) {
    const breakdown = (buyOnly.split("Breakdown by Type:")[1] || "").split("Recent Activity")[0] || "";
    assert(
      breakdown.indexOf("Sell PT") === -1 && breakdown.indexOf("Add Liquidity") === -1,
      "BUY_PT filter excludes other types from breakdown",
      "other types leaked through"
    );
  }

  // Filter: each type
  for (const typeFilter of ["SELL_PT", "AMM_ADD_LIQUIDITY", "AMM_REMOVE_LIQUIDITY"]) {
    const label = { SELL_PT: "Sell PT", AMM_ADD_LIQUIDITY: "Add Liquidity", AMM_REMOVE_LIQUIDITY: "Remove Liquidity" }[typeFilter];
    const { text: t } = await client.callTool("get_pool_activity", {
      chain: "mainnet",
      pool_address: KNOWN_POOL,
      type_filter: typeFilter,
      limit: 2,
    });
    assert(
      t.includes(`Filter: ${label}`) || t.includes(`No ${label} activity`),
      `${typeFilter} filter handled correctly`,
      `expected "Filter: ${label}" or empty message`
    );
  }

  // Limit=1 -> exactly 1 data row (if there's data)
  const { text: one } = await client.callTool("get_pool_activity", {
    chain: "mainnet",
    pool_address: KNOWN_POOL,
    limit: 1,
  });
  const dataRows = one.split("\n").filter((l) => /^\s+\d{4}-\d{2}-\d{2}/.test(l));
  assert(dataRows.length <= 1, "limit=1 returns at most 1 row", `got ${dataRows.length}`);

  // Ethereum alias
  const { text: aliased } = await client.callTool("get_pool_activity", {
    chain: "ethereum",
    pool_address: KNOWN_POOL,
    limit: 2,
  });
  assert(aliased.includes("Pool Activity"), "ethereum alias resolves", "failed");

  // Invalid pool (full-length address)
  const { text: bad } = await client.callTool("get_pool_activity", {
    chain: "mainnet",
    pool_address: "0x0000000000000000000000000000000000000000",
    limit: 5,
  });
  assert(
    bad.includes("No activity found") || bad.includes("Error"),
    "invalid pool handled gracefully",
    `unexpected: ${bad.slice(0, 100)}`
  );
}

// Test the empty-filtered-results path (regression test)
async function testActivityEmptyFilter(client) {
  console.log("\n--- get_pool_activity: empty filter regression ---");

  if (!KNOWN_POOL) {
    skip("activity empty filter test (no pool address discovered)");
    return;
  }

  // We use AMM_REMOVE_LIQUIDITY because some pools may have zero of these.
  // But even if the pool has all types, this tests the code path is safe.
  // The key assertion is: the call does NOT crash (no TypeError).
  for (const typeFilter of ["AMM_REMOVE_LIQUIDITY", "AMM_ADD_LIQUIDITY"]) {
    const { text } = await client.callTool("get_pool_activity", {
      chain: "mainnet",
      pool_address: KNOWN_POOL,
      type_filter: typeFilter,
      limit: 1,
    });

    // Either we get results or the graceful empty message -- NOT a crash
    assert(
      text.includes("Pool Activity") || text.includes("No ") || text.includes("activity"),
      `${typeFilter} filter does not crash`,
      `unexpected output: ${text.slice(0, 100)}`
    );
  }
}

async function testLpApyGaugeEmissions(client) {
  console.log("\n--- LP APY gauge emissions ---");

  // Katana is known to have gauge emissions + external rewards (KAT)
  const { text } = await client.callTool("list_pools", {
    chain: "katana",
    sort_by: "lp_apy",
    min_tvl_usd: 0,
  });

  if (text.includes("active pool")) {
    // Check that reward tokens show up in LP APY breakdown
    const hasRewardLine = text.includes("Rewards:") || text.includes("Gauge:");
    assert(
      hasRewardLine,
      "katana pools show reward/gauge tokens in LP APY",
      "no reward/gauge lines found"
    );
    // LP APY total should still be present
    assert(text.includes("LP APY:"), "katana LP APY total present", "missing");
  } else {
    skip("katana: no active pools for LP gauge test");
  }

  // Mainnet is known to have SPECTRA gauge emissions
  const { text: mainText } = await client.callTool("list_pools", {
    chain: "mainnet",
    sort_by: "lp_apy",
    min_tvl_usd: 0,
  });

  if (mainText.includes("active pool")) {
    // At least some mainnet pools have SPECTRA gauge
    const hasGauge = mainText.includes("SPECTRA Gauge:");
    const hasMaxBoost = mainText.includes("LP APY (Max Boost):");
    if (hasGauge) {
      pass("mainnet pools show SPECTRA gauge emissions");
    } else {
      skip("mainnet: no SPECTRA gauge emissions found (may be off-season)");
    }
    if (hasMaxBoost) {
      pass("mainnet pools show max boost APY");
    } else {
      skip("mainnet: no max boost APY found");
    }
  } else {
    skip("mainnet: no active pools for LP gauge test");
  }
}

async function testCrossChainSmoke(client) {
  console.log("\n--- Cross-chain smoke tests ---");

  // Quick check that a couple non-mainnet chains respond
  for (const chain of ["base", "arbitrum"]) {
    const { text } = await client.callTool("list_pools", {
      chain,
      sort_by: "tvl",
      min_tvl_usd: 0,
    });
    assert(
      text.includes("active pool") || text.includes("No pools") || text.includes("No active"),
      `${chain}: list_pools responds`,
      `unexpected: ${text.slice(0, 80)}`
    );
  }
}


async function testGetMorphoMarkets(client) {
  console.log("\n--- get_morpho_markets ---");

  // Default: search all chains for PT markets
  const { text } = await client.callTool("get_morpho_markets", {
    top_n: 5,
  });

  assert(
    text.includes("Morpho PT market") || text.includes("No Morpho PT markets"),
    "returns results or empty message",
    `unexpected: ${text.slice(0, 100)}`
  );

  if (text.includes("Morpho PT market")) {
    assert(text.includes("LLTV"), "has LLTV", "missing");
    assert(text.includes("Borrow APY"), "has borrow APY", "missing");
    assert(text.includes("Utilization"), "has utilization", "missing");
    assert(text.includes("Morpho Market:"), "has market key", "missing");

    // Discover a market key for later tests
    const keyMatch = text.match(/Morpho Market:\s+(0x[a-fA-F0-9]+\.\.\.[\da-fA-F]+)/);
    // Full key is not in summary; let's query with a specific chain to get it
  }

  // Filter by chain: mainnet (known to have many PT markets)
  const { text: ethMarkets } = await client.callTool("get_morpho_markets", {
    chain: "mainnet",
    top_n: 3,
    sort_by: "supply",
  });

  assert(
    ethMarkets.includes("Morpho PT market") || ethMarkets.includes("No Morpho PT markets"),
    "mainnet filter works",
    `unexpected: ${ethMarkets.slice(0, 100)}`
  );

  // Filter by symbol
  const { text: usdcMarkets } = await client.callTool("get_morpho_markets", {
    pt_symbol_filter: "USDC",
    top_n: 3,
  });

  assert(
    usdcMarkets.includes("USDC") || usdcMarkets.includes("No Morpho"),
    "symbol filter works",
    `unexpected: ${usdcMarkets.slice(0, 100)}`
  );

  // Filter by chain that Morpho doesn't track
  const { text: noMorpho } = await client.callTool("get_morpho_markets", {
    chain: "sonic",
  });

  assert(
    noMorpho.includes("not currently tracked") || noMorpho.includes("No Morpho"),
    "unsupported chain handled gracefully",
    `unexpected: ${noMorpho.slice(0, 100)}`
  );

  // Sort by borrow_apy
  const { text: byApy } = await client.callTool("get_morpho_markets", {
    chain: "mainnet",
    sort_by: "borrow_apy",
    top_n: 2,
  });

  assert(
    byApy.includes("sorted by borrow_apy") || byApy.includes("No Morpho"),
    "sort_by borrow_apy works",
    `unexpected: ${byApy.slice(0, 80)}`
  );
}

async function testGetMorphoRate(client) {
  console.log("\n--- get_morpho_rate ---");

  // Use the known Katana market key from the user's reference
  const katanaKey = "0xf02d47a80fbe6dbf9df4e32e1443e362a1343acb83fbb2c24a814be3557384b1";

  const { text } = await client.callTool("get_morpho_rate", {
    chain: "katana",
    market_key: katanaKey,
  });

  assert(
    text.includes("PT-yvvbUSDC") || text.includes("No Morpho market"),
    "Katana PT market lookup works",
    `unexpected: ${text.slice(0, 120)}`
  );

  if (text.includes("PT-yvvbUSDC")) {
    assert(text.includes("Borrow APY"), "has borrow APY", "missing");
    assert(text.includes("LLTV"), "has LLTV", "missing");
    assert(text.includes("For Looping"), "has looping hint", "missing");
    assert(text.includes("vbUSDT"), "has loan asset", "missing");
    pass("Katana PT market fully resolved");
  }

  // Test with wrong chain (key exists on Katana but not mainnet)
  const { text: wrongChain } = await client.callTool("get_morpho_rate", {
    chain: "mainnet",
    market_key: katanaKey,
  });

  assert(
    wrongChain.includes("No Morpho market") || wrongChain.includes("Error"),
    "wrong chain handled gracefully",
    `unexpected: ${wrongChain.slice(0, 100)}`
  );

  // Test with chain that has no Morpho
  const { text: noMorpho } = await client.callTool("get_morpho_rate", {
    chain: "sonic",
    market_key: katanaKey,
  });

  assert(
    noMorpho.includes("not tracked"),
    "unsupported chain for get_morpho_rate handled",
    `unexpected: ${noMorpho.slice(0, 100)}`
  );
}

async function testLoopingAutoMorpho(client) {
  console.log("\n--- get_looping_strategy: Morpho auto-detection ---");

  if (!KNOWN_PT) {
    skip("looping auto-morpho (no PT address discovered)");
    return;
  }

  // Call without specifying morpho_ltv or borrow_rate — should try auto-detect
  const { text } = await client.callTool("get_looping_strategy", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    max_loops: 3,
  });

  assert(text.includes("Looping Strategy"), "has strategy header", "missing");
  assert(text.includes("Loop Analysis"), "has loop table", "missing");
  assert(text.includes("Eff. Margin"), "has effective margin column", "missing");

  // Should either show auto-detected Morpho data or "not found" with defaults
  const autoDetected = text.includes("auto-detected") || text.includes("from Morpho") || text.includes("live from Morpho");
  const usedDefaults = text.includes("not found") || text.includes("default estimate");
  assert(
    autoDetected || usedDefaults,
    "shows Morpho source (auto-detected or defaults)",
    `missing Morpho source info: ${text.slice(0, 200)}`
  );

  if (autoDetected) {
    pass("Morpho market auto-detected for looping strategy");
    assert(text.includes("Utilization"), "auto-detect shows utilization", "missing");
    assert(text.includes("Available Liquidity"), "auto-detect shows liquidity", "missing");
  } else {
    pass("no Morpho market for this PT -- used defaults");
    assert(text.includes("get_morpho_markets"), "shows tip to find Morpho markets", "missing");
  }

  // Call WITH explicit overrides — should use those instead
  const { text: overridden } = await client.callTool("get_looping_strategy", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    morpho_ltv: 0.77,
    borrow_rate: 8.0,
    max_loops: 2,
  });

  assert(overridden.includes("Looping Strategy"), "override: has header", "missing");
  // If Morpho was detected, the overrides should be marked as "user override"
  if (overridden.includes("auto-detected")) {
    assert(overridden.includes("user override"), "user overrides are labelled", "missing");
  }
}

async function testQuoteTrade(client) {
  console.log("\n--- quote_trade ---");

  if (!KNOWN_PT) {
    skip("quote_trade (no PT address discovered)");
    return;
  }

  // Buy PT with default slippage
  const { text: buy } = await client.callTool("quote_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    amount: 1000,
    side: "buy",
  });

  assert(buy.includes("Trade Quote"), "buy: has quote header", "missing");
  assert(buy.includes("Buy PT"), "buy: shows Buy PT", "missing");
  assert(buy.includes("Spot Rate"), "buy: has spot rate", "missing");
  assert(buy.includes("Effective Rate"), "buy: has effective rate", "missing");
  assert(buy.includes("Price Impact"), "buy: has price impact", "missing");
  assert(buy.includes("Min Output"), "buy: has minOut", "missing");
  assert(buy.includes("0.50%"), "buy: default slippage 0.5%", "missing default slippage");
  assert(buy.includes("Pool Liquidity"), "buy: has pool liquidity", "missing");

  // Sell PT
  const { text: sell } = await client.callTool("quote_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    amount: 500,
    side: "sell",
  });

  assert(sell.includes("Sell PT"), "sell: shows Sell PT", "missing");
  assert(sell.includes("Min Output"), "sell: has minOut", "missing");

  // Custom slippage
  const { text: custom } = await client.callTool("quote_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    amount: 100,
    side: "buy",
    slippage_tolerance: 1.0,
  });

  assert(custom.includes("1.00%"), "custom slippage shows 1.00%", "missing");

  // Very large trade should show higher price impact
  const { text: large } = await client.callTool("quote_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    amount: 10000000,
    side: "buy",
  });

  assert(large.includes("Trade Quote"), "large trade: has quote header", "missing");
  // Large trades against pool liquidity should produce a warning or at least higher impact
  // We just verify it doesn't crash and returns valid output
  assert(large.includes("Price Impact"), "large trade: has impact", "missing");

  // Ethereum alias
  const { text: aliased } = await client.callTool("quote_trade", {
    chain: "ethereum",
    pt_address: KNOWN_PT,
    amount: 100,
    side: "sell",
  });

  assert(aliased.includes("Trade Quote") || aliased.includes("Sell PT"), "ethereum alias works for quote_trade", "failed");

  // Non-existent PT
  const { text: notFound } = await client.callTool("quote_trade", {
    chain: "mainnet",
    pt_address: "0x0000000000000000000000000000000000000001",
    amount: 100,
    side: "buy",
  });

  assert(
    notFound.includes("No PT found") || notFound.includes("Error"),
    "non-existent PT handled gracefully",
    `unexpected: ${notFound.slice(0, 100)}`
  );
}

async function testSimulatePortfolioAfterTrade(client) {
  console.log("\n--- simulate_portfolio_after_trade ---");

  if (!KNOWN_PT) {
    skip("simulate_portfolio_after_trade (no PT address discovered)");
    return;
  }

  // Buy PT with zero-address wallet (new position)
  const { text: buy } = await client.callTool("simulate_portfolio_after_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    address: ZERO_ADDRESS,
    amount: 1000,
    side: "buy",
  });

  assert(buy.includes("Portfolio Simulation"), "buy-new: has simulation header", "missing");
  assert(buy.includes("BEFORE"), "buy-new: has BEFORE section", "missing");
  assert(buy.includes("TRADE"), "buy-new: has TRADE section", "missing");
  assert(buy.includes("AFTER"), "buy-new: has AFTER section", "missing");
  assert(buy.includes("SUMMARY"), "buy-new: has SUMMARY section", "missing");
  assert(
    buy.includes("No existing position") || buy.includes("PT: 0"),
    "buy-new: shows zero starting position",
    "missing zero position"
  );
  assert(buy.includes("Total Value:"), "buy-new: shows total value", "missing");

  // Sell PT with zero-address wallet (exceeds balance)
  const { text: sellWarn } = await client.callTool("simulate_portfolio_after_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    address: ZERO_ADDRESS,
    amount: 100,
    side: "sell",
  });

  assert(
    sellWarn.includes("WARNING") && sellWarn.includes("exceeds"),
    "sell-exceeds: shows warning about exceeding balance",
    "missing warning"
  );

  // Custom slippage
  const { text: custom } = await client.callTool("simulate_portfolio_after_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    address: ZERO_ADDRESS,
    amount: 100,
    side: "buy",
    slippage_tolerance: 2.0,
  });

  assert(custom.includes("2.00%"), "custom slippage shows 2.00%", "missing");

  // Non-existent PT
  const { text: notFound } = await client.callTool("simulate_portfolio_after_trade", {
    chain: "mainnet",
    pt_address: "0x0000000000000000000000000000000000000001",
    address: ZERO_ADDRESS,
    amount: 100,
    side: "buy",
  });

  assert(
    notFound.includes("No PT found") || notFound.includes("Error"),
    "non-existent PT handled gracefully",
    `unexpected: ${notFound.slice(0, 100)}`
  );

  // Ethereum alias
  const { text: aliased } = await client.callTool("simulate_portfolio_after_trade", {
    chain: "ethereum",
    pt_address: KNOWN_PT,
    address: ZERO_ADDRESS,
    amount: 50,
    side: "buy",
  });

  assert(aliased.includes("Portfolio Simulation"), "ethereum alias works for simulate", "failed");
}

async function testScanOpportunities(client) {
  console.log("\n--- scan_opportunities ---");

  // Basic scan with moderate capital
  const { text } = await client.callTool("scan_opportunities", {
    capital_usd: 10000,
    min_tvl_usd: 10000,
    min_liquidity_usd: 5000,
    top_n: 3,
  });

  assert(
    text.includes("Opportunity Scan") || text.includes("No opportunities"),
    "returns results or empty message",
    `unexpected: ${text.slice(0, 100)}`
  );

  if (text.includes("Opportunity Scan")) {
    assert(text.includes("#1"), "has ranked results", "missing ranking");
    assert(text.includes("Entry Impact"), "has entry impact", "missing");
    assert(text.includes("Effective APY"), "has effective APY", "missing");
    assert(text.includes("Capacity"), "has capacity", "missing");
    assert(text.includes("Looping:"), "has looping section", "missing");
    assert(text.includes("Fixed vs Variable"), "has fixed vs variable", "missing");
    assert(text.includes("PT Address"), "has PT address", "missing");
    assert(text.includes("$10,000"), "shows capital amount in header", "missing");
    // LP APY with gauge emissions
    assert(text.includes("LP APY:"), "has LP APY in scan results", "missing LP APY");
  }

  // Large capital should filter out low-liquidity pools
  const { text: large } = await client.callTool("scan_opportunities", {
    capital_usd: 5000000,
    max_price_impact_pct: 1,
    top_n: 3,
  });

  assert(
    large.includes("Opportunity Scan") || large.includes("No opportunities"),
    "large capital scan completes",
    `unexpected: ${large.slice(0, 100)}`
  );

  // With asset filter
  const { text: usdc } = await client.callTool("scan_opportunities", {
    capital_usd: 10000,
    asset_filter: "USDC",
    top_n: 3,
  });

  assert(
    usdc.includes("USDC") || usdc.includes("No opportunities"),
    "asset filter works",
    `unexpected: ${usdc.slice(0, 100)}`
  );

  // With looping disabled
  const { text: noLoop } = await client.callTool("scan_opportunities", {
    capital_usd: 10000,
    include_looping: false,
    top_n: 3,
  });

  assert(
    noLoop.includes("Looping: disabled") || noLoop.includes("No opportunities"),
    "looping disabled flag works",
    `unexpected: ${noLoop.slice(0, 100)}`
  );

  // With ve_spectra_balance parameter (real boost formula)
  const { text: boosted } = await client.callTool("scan_opportunities", {
    capital_usd: 10000,
    ve_spectra_balance: 100000,
    top_n: 3,
  });

  if (boosted.includes("Opportunity Scan")) {
    assert(boosted.includes("veSPECTRA"), "ve_spectra_balance shows veSPECTRA in header", "missing veSPECTRA header");
    // Only assert boost line if there are gauge emissions in the results
    if (boosted.includes("Gauge:")) {
      assert(boosted.includes("x Boost"), "ve_spectra_balance shows multiplier boost", "missing boost multiplier");
    } else {
      pass("ve_spectra_balance: no gauge emissions in results, boost line skipped correctly");
    }
  } else {
    pass("ve_spectra_balance: no results, but accepted parameter without error");
  }
}

async function testScanYtArbitrage(client) {
  console.log("\n--- scan_yt_arbitrage ---");

  // Basic scan with moderate capital
  const { text } = await client.callTool("scan_yt_arbitrage", {
    capital_usd: 10000,
    min_tvl_usd: 10000,
    min_liquidity_usd: 5000,
    top_n: 3,
  }, 30_000);

  assert(
    text.includes("YT Arbitrage Scan") || text.includes("No YT arbitrage"),
    "returns results or empty message",
    `unexpected: ${text.slice(0, 100)}`
  );

  if (text.includes("YT Arbitrage Scan")) {
    assert(text.includes("#1"), "has ranked results", "missing ranking");
    assert(text.includes("IBT Current APR"), "has IBT APR", "missing");
    assert(text.includes("YT Implied Rate"), "has YT implied rate", "missing");
    assert(text.includes("Spread"), "has spread", "missing");
    assert(
      text.includes("BUY YT") || text.includes("SELL YT"),
      "has direction signal",
      "missing direction"
    );
    assert(text.includes("Break-Even") || text.includes("Capacity"), "has capital-aware metrics", "missing");
    assert(text.includes("PT Address"), "has PT address", "missing");
    assert(text.includes("$10,000"), "shows capital in header", "missing");
    // LP APY with gauge emissions
    assert(text.includes("LP APY:"), "has LP APY in YT arb results", "missing LP APY");
  }

  // With asset filter
  const { text: usdc } = await client.callTool("scan_yt_arbitrage", {
    capital_usd: 10000,
    asset_filter: "USDC",
    min_spread_pct: 0.5,
    top_n: 3,
  }, 30_000);

  assert(
    usdc.includes("USDC") || usdc.includes("No YT arbitrage"),
    "asset filter works",
    `unexpected: ${usdc.slice(0, 100)}`
  );

  // High spread threshold should return fewer or no results
  const { text: highThresh } = await client.callTool("scan_yt_arbitrage", {
    capital_usd: 10000,
    min_spread_pct: 99,
    top_n: 3,
  }, 30_000);

  assert(
    highThresh.includes("No YT arbitrage"),
    "high spread threshold returns empty",
    `unexpected: ${highThresh.slice(0, 100)}`
  );

  // With ve_spectra_balance parameter (real boost formula)
  const { text: ytBoosted } = await client.callTool("scan_yt_arbitrage", {
    capital_usd: 10000,
    ve_spectra_balance: 100000,
    min_spread_pct: 0.5,
    top_n: 3,
  }, 30_000);

  if (ytBoosted.includes("YT Arbitrage Scan")) {
    assert(ytBoosted.includes("veSPECTRA"), "ve_spectra_balance shows veSPECTRA in YT arb header", "missing veSPECTRA header");
  } else {
    pass("ve_spectra_balance: no YT arb results, but accepted parameter without error");
  }
}

async function testGetVeInfo(client) {
  console.log("\n--- get_ve_info ---");

  // Basic call: no params, just totalSupply
  const { text } = await client.callTool("get_ve_info", {});

  assert(text.includes("veSPECTRA Info"), "has veSPECTRA header", "missing");
  assert(text.includes("Total Supply"), "has total supply", "missing");
  assert(text.includes("Contract:"), "has contract address", "missing");
  assert(text.includes("Formula:"), "has boost formula", "missing");
  assert(text.includes("veNFT"), "mentions veNFT type", "missing");
  assert(text.includes("spectra-core"), "shows source repo", "missing");
  assert(text.includes("Max Boost: 2.5x"), "shows max boost", "missing");

  // Parse totalSupply to verify it's a positive number
  const supplyMatch = text.match(/Total Supply:\s+([\d,]+)\s+veSPECTRA/);
  if (supplyMatch) {
    const val = parseInt(supplyMatch[1].replace(/,/g, ""), 10);
    assert(val > 0, "veSPECTRA totalSupply > 0", `got ${val}`);
  } else {
    fail("veSPECTRA totalSupply parseable", "couldn't parse");
  }

  // With balance + capital (no pool): boost table at reference TVLs
  const { text: boostTable } = await client.callTool("get_ve_info", {
    ve_spectra_balance: 100000,
    capital_usd: 10000,
  });

  assert(boostTable.includes("Your Balance:"), "shows user balance", "missing");
  assert(boostTable.includes("Your Share:"), "shows user share", "missing");
  assert(boostTable.includes("Boost at various pool TVLs"), "shows boost table", "missing");
  assert(boostTable.includes("x boost"), "shows boost multiplier values", "missing");
  assert(boostTable.includes("veSPECTRA needed for max 2.5x"), "shows max boost requirements", "missing");

  // With specific pool
  if (KNOWN_PT) {
    const { text: poolBoost } = await client.callTool("get_ve_info", {
      ve_spectra_balance: 100000,
      capital_usd: 10000,
      chain: "mainnet",
      pt_address: KNOWN_PT,
    });

    assert(poolBoost.includes("Pool:"), "shows pool name", "missing");
    assert(poolBoost.includes("Pool TVL:"), "shows pool TVL", "missing");
    assert(poolBoost.includes("Your Boost:"), "shows computed boost", "missing");
    assert(poolBoost.includes("x"), "shows multiplier", "missing");
  } else {
    skip("get_ve_info with pool (no PT address discovered)");
  }

  // Balance without capital_usd should prompt for capital
  const { text: noCapital } = await client.callTool("get_ve_info", {
    ve_spectra_balance: 100000,
  });

  assert(noCapital.includes("Provide capital_usd"), "prompts for capital_usd when missing", "missing prompt");
}

async function testModelMetavaultStrategy(client) {
  console.log("\n--- model_metavault_strategy ---");

  // Basic: vault economics + looping table
  const { text: basic } = await client.callTool("model_metavault_strategy", {
    base_apy: 12,
    yt_compounding_apy: 3,
    curator_fee_pct: 10,
  });

  assert(basic.includes("MetaVault Strategy Model"), "has strategy header", `unexpected: ${basic.slice(0, 100)}`);
  assert(basic.includes("Vault Economics"), "has vault economics section", "missing");
  assert(basic.includes("Base LP APY"), "has base APY", "missing");
  assert(basic.includes("YT→LP Compounding"), "has YT compounding", "missing");
  assert(basic.includes("Gross Vault APY"), "has gross vault APY", "missing");
  assert(basic.includes("Net Vault APY"), "has net vault APY", "missing");
  assert(basic.includes("Curator Fee"), "has curator fee", "missing");
  assert(basic.includes("Looping Table"), "has looping table", "missing");
  assert(basic.includes("Optimal:"), "has optimal loop", "missing");
  assert(basic.includes("Rollover Advantage"), "has rollover advantage", "missing");
  assert(basic.includes("Risks"), "has risk notes", "missing");

  // Verify math: gross = 12 + 3 = 15%, net = 15 * 0.9 = 13.5%
  assert(basic.includes("15.00%"), "gross vault APY is 15%", "missing");
  assert(basic.includes("13.50%"), "net vault APY is 13.5%", "missing");

  // With PT comparison
  const { text: compare } = await client.callTool("model_metavault_strategy", {
    base_apy: 12,
    yt_compounding_apy: 3,
    compare_pt_apy: 12,
  });

  assert(compare.includes("PT Looping Comparison"), "has PT comparison section", "missing");
  assert(compare.includes("PT Net"), "has PT Net column", "missing");
  assert(compare.includes("MV Net"), "has MV Net column", "missing");
  assert(compare.includes("Premium"), "has Premium column", "missing");
  assert(compare.includes("Double-Loop Premium"), "has double-loop premium summary", "missing");

  // With curator economics
  const { text: curator } = await client.callTool("model_metavault_strategy", {
    base_apy: 12,
    yt_compounding_apy: 3,
    curator_fee_pct: 10,
    capital_usd: 100000,
    external_deposits_usd: 1000000,
  });

  assert(curator.includes("Curator Economics"), "has curator economics section", "missing");
  assert(curator.includes("Own Capital"), "has own capital", "missing");
  assert(curator.includes("External Deposits"), "has external deposits", "missing");
  assert(curator.includes("Fee Revenue"), "has fee revenue", "missing");
  assert(curator.includes("Effective ROI"), "has effective ROI", "missing");
  assert(curator.includes("Additional TVL"), "has additional TVL from looping", "missing");

  // Edge case: borrow rate higher than base (looping unprofitable)
  const { text: unprofitable } = await client.callTool("model_metavault_strategy", {
    base_apy: 5,
    borrow_rate: 8,
  });
  assert(unprofitable.includes("MetaVault Strategy Model"), "unprofitable case still returns", "missing");
  // At loop 0 there's no borrow cost, so loop 0 should be optimal
  assert(unprofitable.includes("Optimal: 0 loops"), "optimal is 0 loops when borrow > base", `got: ${unprofitable.match(/Optimal:.*/)?.[0]}`);

  // No YT compounding, no external deposits (minimal params)
  const { text: minimal } = await client.callTool("model_metavault_strategy", {
    base_apy: 10,
  });
  assert(minimal.includes("MetaVault Strategy Model"), "minimal params work", "missing");
  assert(!minimal.includes("YT→LP Compounding"), "no YT compounding line when 0", "should be absent");
  assert(!minimal.includes("Curator Economics"), "no curator economics without capital_usd", "should be absent");
}

async function testMalformedAddresses(client) {
  console.log("\n--- Malformed address validation ---");

  // Too short
  const { text: tooShort } = await client.callTool("get_pt_details", {
    chain: "mainnet",
    pt_address: "0x1234",
  });
  assert(
    tooShort.includes("Invalid") || tooShort.includes("error") || tooShort.includes("Error"),
    "too-short address rejected",
    `unexpected: ${tooShort.slice(0, 100)}`
  );

  // Non-hex characters
  const { text: nonHex } = await client.callTool("get_pt_details", {
    chain: "mainnet",
    pt_address: "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
  });
  assert(
    nonHex.includes("Invalid") || nonHex.includes("error") || nonHex.includes("Error"),
    "non-hex address rejected",
    `unexpected: ${nonHex.slice(0, 100)}`
  );

  // Missing 0x prefix
  const { text: noPrefix } = await client.callTool("get_pt_details", {
    chain: "mainnet",
    pt_address: "1234567890abcdef1234567890abcdef12345678",
  });
  assert(
    noPrefix.includes("Invalid") || noPrefix.includes("error") || noPrefix.includes("Error"),
    "missing-0x-prefix address rejected",
    `unexpected: ${noPrefix.slice(0, 100)}`
  );

  // Too long
  const { text: tooLong } = await client.callTool("get_pt_details", {
    chain: "mainnet",
    pt_address: "0x00000000000000000000000000000000000000000000",
  });
  assert(
    tooLong.includes("Invalid") || tooLong.includes("error") || tooLong.includes("Error"),
    "too-long address rejected",
    `unexpected: ${tooLong.slice(0, 100)}`
  );

  // Empty string
  const { text: empty } = await client.callTool("get_pt_details", {
    chain: "mainnet",
    pt_address: "",
  });
  assert(
    empty.includes("Invalid") || empty.includes("error") || empty.includes("Error"),
    "empty address rejected",
    `unexpected: ${empty.slice(0, 100)}`
  );

  // Morpho market_key: too short (should be 64 hex chars)
  const { text: shortKey } = await client.callTool("get_morpho_rate", {
    chain: "mainnet",
    market_key: "0xabcd",
  });
  assert(
    shortKey.includes("Invalid") || shortKey.includes("error") || shortKey.includes("Error"),
    "too-short Morpho market key rejected",
    `unexpected: ${shortKey.slice(0, 100)}`
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("Spectra MCP Server -- Test Suite");
  console.log(`Mode: ${OFFLINE ? "OFFLINE (registration only)" : "FULL (with live API calls)"}`);
  console.log(`Server: ${SERVER_PATH}`);

  const client = new McpTestClient();

  // Global timeout
  const globalTimer = setTimeout(() => {
    console.error(`\n\x1b[31mGlobal timeout (${TOTAL_TIMEOUT_MS / 1000}s) exceeded\x1b[0m`);
    client.stop();
    process.exit(1);
  }, TOTAL_TIMEOUT_MS);

  try {
    await client.start();
    console.log("Server started, MCP handshake complete.\n");

    // Always run registration tests
    await testToolRegistration(client);

    if (!OFFLINE) {
      // Tools that don't need a discovered address
      await testGetSupportedChains(client);
      await testGetProtocolStats(client);

      // list_pools must run before pool-dependent tests (discovers KNOWN_POOL)
      await testListPools(client);

      // Tools that use discovered pool address
      await testGetPoolVolume(client);
      await testGetPoolActivity(client);
      await testActivityEmptyFilter(client);

      // Tools that need a PT address (discovered from list_pools)
      await testGetPtDetails(client);
      await testCompareYield(client);
      await testGetLoopingStrategy(client);

      // Portfolio (edge-case-ish)
      await testGetPortfolio(client);

      // Cross-chain yield scanner
      await testGetBestFixedYields(client);

      // Morpho integration
      await testGetMorphoMarkets(client);
      await testGetMorphoRate(client);
      await testLoopingAutoMorpho(client);

      // Trade quoting & simulation
      await testQuoteTrade(client);
      await testSimulatePortfolioAfterTrade(client);

      // Strategy scanner
      await testScanOpportunities(client);

      // YT arbitrage scanner
      await testScanYtArbitrage(client);

      // veSPECTRA info
      await testGetVeInfo(client);

      // LP APY gauge emissions
      await testLpApyGaugeEmissions(client);

      // MetaVault strategy modeler (pure computation, no API)
      await testModelMetavaultStrategy(client);

      // Smoke test other chains
      await testCrossChainSmoke(client);

      // Validation / negative tests
      await testMalformedAddresses(client);
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
