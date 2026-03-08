#!/usr/bin/env node

/**
 * MetaVault MCP Server -- Persistent Test Suite
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
const API_TIMEOUT_MS = 45_000; // per-tool call
const TOTAL_TIMEOUT_MS = 600_000; // whole suite
const OFFLINE = process.argv.includes("--offline");

// Dynamically discovered from spectra_list_pools during testListPools
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
      clientInfo: { name: "metavault-test", version: "1.0" },
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

  assert(tools.length === 50, "exactly 50 tools registered", `got ${tools.length}: ${names.join(", ")}`);

  const expected = [
    "spectra_get_pt_details",
    "spectra_list_pools",
    "spectra_get_best_fixed_yields",
    "spectra_get_looping_strategy",
    "spectra_compare_yield",
    "spectra_get_protocol_stats",
    "spectra_list_chains",
    "spectra_get_portfolio",
    "spectra_get_pool_volume",
    "spectra_get_pool_activity",
    "spectra_get_address_activity",
    "morpho_list_markets",
    "morpho_get_rate",
    "morpho_get_market_suppliers",
    "morpho_list_vaults",
    "morpho_get_positions",
    "morpho_get_history",
    "spectra_quote_trade",
    "spectra_simulate_trade",
    "spectra_scan_opportunities",
    "spectra_scan_yt_arbitrage",
    "spectra_get_ve_info",
    "spectra_list_metavaults",
    "spectra_model_metavault",
    "spectra_get_curator_dashboard",
    "mv_get_protocol_context",
    "pendle_list_markets",
    "mv_compare_yield",
    "mv_scan_curator_opportunities",
    "spectra_get_onchain_activity",
    "spectra_get_pool_capacity",
    "mv_check_ibt_health",
    "spectra_get_yield_curve",
    "morpho_monitor_risk",
    "spectra_stress_test_vault",
    "mv_plan_rollover",
    "mv_get_curator_portfolio",
    "spectra_list_expiring_pools",
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

  // Spot-check: spectra_get_pool_activity schema has type_filter enum
  const activityTool = tools.find((t) => t.name === "spectra_get_pool_activity");
  if (activityTool) {
    const typeFilter = activityTool.inputSchema.properties.type_filter;
    assert(
      typeFilter && typeFilter.enum && typeFilter.enum.includes("BUY_PT") && typeFilter.enum.includes("all"),
      "spectra_get_pool_activity type_filter enum correct",
      `got: ${JSON.stringify(typeFilter && typeFilter.enum)}`
    );
  }

  // Spot-check: chain enum includes ethereum alias
  const ptTool = tools.find((t) => t.name === "spectra_get_pt_details");
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

  const portfolioTool = tools.find((t) => t.name === "spectra_get_portfolio");
  if (portfolioTool) {
    const addrSchema = portfolioTool.inputSchema.properties.address;
    assert(
      addrSchema && addrSchema.pattern,
      "portfolio address has regex pattern validation",
      `no pattern found: ${JSON.stringify(addrSchema)}`
    );
  }

  // Morpho tools schema checks
  const morphoMarketsTool = tools.find((t) => t.name === "morpho_list_markets");
  assert(morphoMarketsTool, "morpho_list_markets registered", "missing");
  if (morphoMarketsTool) {
    const props = morphoMarketsTool.inputSchema.properties;
    assert(props.sort_by && props.sort_by.enum, "morpho_list_markets has sort_by enum", "missing");
    assert(props.chain, "morpho_list_markets has optional chain param", "missing");
  }

  const morphoRateTool = tools.find((t) => t.name === "morpho_get_rate");
  assert(morphoRateTool, "morpho_get_rate registered", "missing");
  if (morphoRateTool) {
    const props = morphoRateTool.inputSchema.properties;
    assert(
      props.market_key && props.market_key.pattern,
      "morpho_get_rate market_key has regex pattern",
      `no pattern: ${JSON.stringify(props.market_key)}`
    );
    assert(props.chain, "morpho_get_rate has chain param", "missing");
  }

  // Verify looping strategy morpho_ltv and borrow_rate are now optional (no default in required)
  const loopTool = tools.find((t) => t.name === "spectra_get_looping_strategy");
  if (loopTool) {
    const required = loopTool.inputSchema.required || [];
    assert(
      !required.includes("morpho_ltv") && !required.includes("borrow_rate"),
      "looping strategy: morpho_ltv and borrow_rate are optional",
      `required: ${JSON.stringify(required)}`
    );
  }

  // spectra_quote_trade schema checks
  const quoteTool = tools.find((t) => t.name === "spectra_quote_trade");
  assert(quoteTool, "spectra_quote_trade registered", "missing");
  if (quoteTool) {
    const props = quoteTool.inputSchema.properties;
    assert(props.side && props.side.enum && props.side.enum.includes("buy") && props.side.enum.includes("sell"),
      "spectra_quote_trade has buy/sell side enum", `got: ${JSON.stringify(props.side)}`);
    assert(props.amount, "spectra_quote_trade has amount param", "missing");
    assert(props.slippage_tolerance, "spectra_quote_trade has slippage_tolerance param", "missing");
    assert(props.pt_address && props.pt_address.pattern, "spectra_quote_trade pt_address has regex", "missing");
    const required = quoteTool.inputSchema.required || [];
    assert(required.includes("chain") && required.includes("pt_address") && required.includes("amount") && required.includes("side"),
      "spectra_quote_trade requires chain, pt_address, amount, side",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("slippage_tolerance"),
      "spectra_quote_trade: slippage_tolerance is optional",
      `required: ${JSON.stringify(required)}`);
  }

  // spectra_simulate_trade schema checks
  const simTool = tools.find((t) => t.name === "spectra_simulate_trade");
  assert(simTool, "spectra_simulate_trade registered", "missing");
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

  // spectra_scan_opportunities schema checks
  const scanTool = tools.find((t) => t.name === "spectra_scan_opportunities");
  assert(scanTool, "spectra_scan_opportunities registered", "missing");
  if (scanTool) {
    const props = scanTool.inputSchema.properties;
    assert(props.capital_usd, "spectra_scan_opportunities has capital_usd param", "missing");
    assert(props.include_looping, "spectra_scan_opportunities has include_looping param", "missing");
    assert(props.max_price_impact_pct, "spectra_scan_opportunities has max_price_impact_pct param", "missing");
    assert(props.top_n, "spectra_scan_opportunities has top_n param", "missing");
    assert(props.asset_filter, "spectra_scan_opportunities has asset_filter param", "missing");
    const required = scanTool.inputSchema.required || [];
    assert(required.includes("capital_usd"),
      "spectra_scan_opportunities requires capital_usd",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("asset_filter"),
      "spectra_scan_opportunities: asset_filter is optional",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("include_looping"),
      "spectra_scan_opportunities: include_looping is optional",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("max_price_impact_pct"),
      "spectra_scan_opportunities: max_price_impact_pct is optional",
      `required: ${JSON.stringify(required)}`);
  }

  // spectra_scan_yt_arbitrage schema checks
  const ytArbTool = tools.find((t) => t.name === "spectra_scan_yt_arbitrage");
  assert(ytArbTool, "spectra_scan_yt_arbitrage registered", "missing");
  if (ytArbTool) {
    const props = ytArbTool.inputSchema.properties;
    assert(props.capital_usd, "spectra_scan_yt_arbitrage has capital_usd param", "missing");
    assert(props.min_spread_pct, "spectra_scan_yt_arbitrage has min_spread_pct param", "missing");
    assert(props.asset_filter, "spectra_scan_yt_arbitrage has asset_filter param", "missing");
    assert(props.top_n, "spectra_scan_yt_arbitrage has top_n param", "missing");
    assert(props.max_price_impact_pct, "spectra_scan_yt_arbitrage has max_price_impact_pct param", "missing");
    const required = ytArbTool.inputSchema.required || [];
    assert(required.includes("capital_usd"),
      "spectra_scan_yt_arbitrage requires capital_usd",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("min_spread_pct"),
      "spectra_scan_yt_arbitrage: min_spread_pct is optional",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("asset_filter"),
      "spectra_scan_yt_arbitrage: asset_filter is optional",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("ve_spectra_balance"),
      "spectra_scan_yt_arbitrage: ve_spectra_balance is optional",
      `required: ${JSON.stringify(required)}`);
    assert(props.ve_spectra_balance, "spectra_scan_yt_arbitrage has ve_spectra_balance param", "missing");
  }

  // Check ve_spectra_balance on spectra_scan_opportunities and spectra_compare_yield
  {
    const scanOpp = tools.find((t) => t.name === "spectra_scan_opportunities");
    const scanProps = scanOpp.inputSchema.properties;
    assert(scanProps.ve_spectra_balance, "spectra_scan_opportunities has ve_spectra_balance param", "missing");
    assert(!scanOpp.inputSchema.required.includes("ve_spectra_balance"),
      "spectra_scan_opportunities: ve_spectra_balance is optional",
      "ve_spectra_balance should be optional");
  }
  {
    const cmpYield = tools.find((t) => t.name === "spectra_compare_yield");
    const cmpProps = cmpYield.inputSchema.properties;
    assert(cmpProps.ve_spectra_balance, "spectra_compare_yield has ve_spectra_balance param", "missing");
    assert(!cmpYield.inputSchema.required.includes("ve_spectra_balance"),
      "spectra_compare_yield: ve_spectra_balance is optional",
      "ve_spectra_balance should be optional");
    // spectra_compare_yield now also has capital_usd
    assert(cmpProps.capital_usd, "spectra_compare_yield has capital_usd param", "missing");
    assert(!cmpYield.inputSchema.required.includes("capital_usd"),
      "spectra_compare_yield: capital_usd is optional",
      "capital_usd should be optional");
  }

  // spectra_get_ve_info schema checks
  const veTool = tools.find((t) => t.name === "spectra_get_ve_info");
  assert(veTool, "spectra_get_ve_info registered", "missing");
  if (veTool) {
    const props = veTool.inputSchema.properties;
    assert(props.ve_spectra_balance, "spectra_get_ve_info has ve_spectra_balance param", "missing");
    assert(props.capital_usd, "spectra_get_ve_info has capital_usd param", "missing");
    assert(props.chain, "spectra_get_ve_info has chain param", "missing");
    assert(props.pt_address, "spectra_get_ve_info has pt_address param", "missing");
    // All params should be optional
    const required = veTool.inputSchema.required || [];
    assert(required.length === 0,
      "spectra_get_ve_info: all params are optional",
      `required: ${JSON.stringify(required)}`);
  }
}

async function testGetSupportedChains(client) {
  console.log("\n--- spectra_list_chains ---");

  const { text } = await client.callTool("spectra_list_chains");
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
  console.log("\n--- spectra_get_protocol_stats ---");

  const { text } = await client.callTool("spectra_get_protocol_stats");
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
  console.log("\n--- spectra_list_pools ---");

  const { text } = await client.callTool("spectra_list_pools", {
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
    skip("could not discover pool address from spectra_list_pools");
  }

  const ptMatch = text.match(/PT Address:\s+(0x[a-fA-F0-9]{40})/);
  if (ptMatch) {
    KNOWN_PT = ptMatch[1];
    pass("dynamically discovered PT address for later tests");
  } else {
    skip("could not discover PT address from spectra_list_pools");
  }

  // Test with high TVL filter -- should return fewer or zero
  const { text: filtered } = await client.callTool("spectra_list_pools", {
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
  console.log("\n--- spectra_get_pt_details ---");

  if (!KNOWN_PT) {
    skip("spectra_get_pt_details (no PT address discovered)");
    return;
  }

  const ptAddr = KNOWN_PT;
  const { text } = await client.callTool("spectra_get_pt_details", {
    chain: "mainnet",
    pt_address: ptAddr,
  });

  assert(text.includes("Maturity"), "has maturity", "missing");
  assert(text.includes("Implied APY"), "has APY", "missing");
  assert(text.includes("LP APY"), "has LP APY", "missing");
  assert(text.includes("IBT"), "has IBT info", "missing");

  // Test ethereum alias resolves correctly
  const { text: aliased } = await client.callTool("spectra_get_pt_details", {
    chain: "ethereum",
    pt_address: ptAddr,
  });
  assert(aliased.includes("Maturity"), "ethereum alias works for spectra_get_pt_details", "failed");
}

async function testCompareYield(client) {
  console.log("\n--- spectra_compare_yield ---");

  if (!KNOWN_PT) {
    skip("spectra_compare_yield (no PT address discovered)");
    return;
  }

  const { text } = await client.callTool("spectra_compare_yield", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
  });

  assert(text.includes("Yield Comparison"), "has comparison header", "missing");
  assert(text.includes("Fixed (Spectra PT)"), "has fixed rate", "missing");
  assert(text.includes("Variable"), "has variable rate", "missing");
  assert(text.includes("Spread"), "has spread", "missing");
  assert(
    text.includes("Spread after entry cost") || text.includes("Spread before entry cost") || text.includes("Spread:"),
    "has spread analysis",
    "missing spread analysis"
  );
  // LP alternative with breakdown
  assert(text.includes("LP Alternative:"), "has LP alternative with breakdown", "missing LP breakdown");
}

async function testGetBestFixedYields(client) {
  console.log("\n--- spectra_get_best_fixed_yields ---");

  const { text } = await client.callTool("spectra_get_best_fixed_yields", {
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
  const { text: usdcOnly } = await client.callTool("spectra_get_best_fixed_yields", {
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
  console.log("\n--- spectra_get_looping_strategy ---");

  if (!KNOWN_PT) {
    skip("spectra_get_looping_strategy (no PT address discovered)");
    return;
  }

  const { text } = await client.callTool("spectra_get_looping_strategy", {
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
  assert(text.includes("Highest net APY"), "has highest net APY row", "missing");
  assert(text.includes("Risks") || text.includes("risk"), "has risk warning", "missing");

  // Should have "Eff. Margin" column instead of old "Liq. Buffer"
  assert(text.includes("Eff. Margin"), "has effective margin column", "missing Eff. Margin");
  assert(!text.includes("Liq. Buffer"), "old Liq. Buffer column removed", "still has Liq. Buffer");
}

async function testGetPortfolio(client) {
  console.log("\n--- spectra_get_portfolio ---");

  // Use full-length zero address
  const { text } = await client.callTool("spectra_get_portfolio", {
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
    "spectra_get_portfolio",
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
  console.log("\n--- spectra_get_pool_volume ---");

  if (!KNOWN_POOL) {
    skip("spectra_get_pool_volume (no pool address discovered)");
    return;
  }

  const { text } = await client.callTool("spectra_get_pool_volume", {
    chain: "mainnet",
    pool_address: KNOWN_POOL,
  });

  assert(text.includes("Pool Volume"), "has volume header", "missing");
  assert(text.includes("All-Time Volume") || text.includes("All-Time"), "has all-time stats", "missing");
  assert(text.includes("Last 7 Days"), "has 7-day stats", "missing");
  assert(text.includes("Buy:") && text.includes("Sell:"), "has buy/sell breakdown", "missing");

  // Test with invalid pool (full-length address)
  const { text: bad } = await client.callTool("spectra_get_pool_volume", {
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
  console.log("\n--- spectra_get_pool_activity ---");

  if (!KNOWN_POOL) {
    skip("spectra_get_pool_activity (no pool address discovered)");
    return;
  }

  // Default (all types)
  const { text } = await client.callTool("spectra_get_pool_activity", {
    chain: "mainnet",
    pool_address: KNOWN_POOL,
  });

  assert(text.includes("Pool Activity"), "has activity header", "missing");
  assert(text.includes("All types"), "default filter is all", "wrong filter");
  assert(text.includes("Breakdown by Type"), "has type breakdown", "missing");
  assert(text.includes("Recent Activity"), "has activity table", "missing");

  // Filter: BUY_PT only
  const { text: buyOnly } = await client.callTool("spectra_get_pool_activity", {
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
    const { text: t } = await client.callTool("spectra_get_pool_activity", {
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
  const { text: one } = await client.callTool("spectra_get_pool_activity", {
    chain: "mainnet",
    pool_address: KNOWN_POOL,
    limit: 1,
  });
  const dataRows = one.split("\n").filter((l) => /^\s+\d{4}-\d{2}-\d{2}/.test(l));
  assert(dataRows.length <= 1, "limit=1 returns at most 1 row", `got ${dataRows.length}`);

  // Ethereum alias
  const { text: aliased } = await client.callTool("spectra_get_pool_activity", {
    chain: "ethereum",
    pool_address: KNOWN_POOL,
    limit: 2,
  });
  assert(aliased.includes("Pool Activity"), "ethereum alias resolves", "failed");

  // Invalid pool (full-length address)
  const { text: bad } = await client.callTool("spectra_get_pool_activity", {
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
  console.log("\n--- spectra_get_pool_activity: empty filter regression ---");

  if (!KNOWN_POOL) {
    skip("activity empty filter test (no pool address discovered)");
    return;
  }

  // We use AMM_REMOVE_LIQUIDITY because some pools may have zero of these.
  // But even if the pool has all types, this tests the code path is safe.
  // The key assertion is: the call does NOT crash (no TypeError).
  for (const typeFilter of ["AMM_REMOVE_LIQUIDITY", "AMM_ADD_LIQUIDITY"]) {
    const { text } = await client.callTool("spectra_get_pool_activity", {
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
  const { text } = await client.callTool("spectra_list_pools", {
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
  const { text: mainText } = await client.callTool("spectra_list_pools", {
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

async function testListPendleMarkets(client) {
  console.log("\n--- pendle_list_markets ---");

  // Single chain
  const { text } = await client.callTool("pendle_list_markets", {
    chain: "mainnet",
    top_n: 5,
    compact: true,
  });
  const hasResults = text.includes("Pendle Markets") || text.includes("No active");
  assert(hasResults, "pendle_list_markets: returns valid output", `unexpected: ${text.slice(0, 120)}`);

  // Should show chain coverage info
  if (text.includes("Pendle Markets")) {
    assert(text.includes("Chain Coverage"), "pendle_list_markets: shows chain coverage", "missing");
    assert(text.includes("Next Steps"), "pendle_list_markets: has next steps", "missing");
  }

  // All chains scan
  const { text: allChains } = await client.callTool("pendle_list_markets", {
    top_n: 3,
    compact: true,
  });
  const allOk = allChains.includes("Pendle Markets") || allChains.includes("No active");
  assert(allOk, "pendle_list_markets: all-chain scan works", `unexpected: ${allChains.slice(0, 120)}`);

  // Asset filter
  const { text: filtered } = await client.callTool("pendle_list_markets", {
    chain: "mainnet",
    asset_filter: "USD",
    top_n: 3,
    compact: true,
  });
  const filterOk = filtered.includes("Pendle Markets") || filtered.includes("No active");
  assert(filterOk, "pendle_list_markets: asset filter works", `unexpected: ${filtered.slice(0, 120)}`);

  // Pendle-only chain (mantle has Pendle but not Spectra)
  const { text: mantleText } = await client.callTool("pendle_list_markets", {
    chain: "mantle",
    top_n: 3,
    compact: true,
    min_tvl_usd: 0,
    min_liquidity_usd: 0,
  });
  const mantleOk = mantleText.includes("Pendle Markets") || mantleText.includes("No active");
  assert(mantleOk, "pendle_list_markets: pendle-only chain (mantle) works", `unexpected: ${mantleText.slice(0, 120)}`);
}

async function testComparePendleSpectra(client) {
  console.log("\n--- mv_compare_yield ---");

  // Mainnet comparison
  const { text } = await client.callTool("mv_compare_yield", {
    chain: "mainnet",
    min_tvl_usd: 0,
    min_liquidity_usd: 0,
  });
  const hasOutput = text.includes("Spectra vs Pendle") || text.includes("Error");
  assert(hasOutput, "mv_compare_yield: returns valid output", `unexpected: ${text.slice(0, 120)}`);

  if (text.includes("Spectra vs Pendle")) {
    // Should show pool counts
    assert(text.includes("Spectra pools:"), "mv_compare_yield: shows Spectra pool count", "missing");
    assert(text.includes("Pendle markets:"), "mv_compare_yield: shows Pendle market count", "missing");

    // Should have at least one section (matched, spectra-only, or pendle-only)
    const hasSection = text.includes("Matched Comparisons") ||
      text.includes("Spectra-Only") ||
      text.includes("Pendle-Only");
    assert(hasSection, "mv_compare_yield: has at least one comparison section", "missing all sections");

    // Next steps
    assert(text.includes("Next Steps"), "mv_compare_yield: has next steps", "missing");
  }

  // With asset filter
  const { text: filtered } = await client.callTool("mv_compare_yield", {
    chain: "base",
    asset_filter: "ETH",
    min_tvl_usd: 0,
    min_liquidity_usd: 0,
  });
  const filterOk = filtered.includes("Spectra vs Pendle");
  assert(filterOk, "mv_compare_yield: asset filter on base works", `unexpected: ${filtered.slice(0, 120)}`);
  if (filtered.includes("Asset filter")) {
    assert(filtered.includes("ETH"), "mv_compare_yield: shows asset filter value", "missing");
  }

  // Compact mode
  const { text: compact } = await client.callTool("mv_compare_yield", {
    chain: "mainnet",
    compact: true,
    min_tvl_usd: 0,
    min_liquidity_usd: 0,
  });
  assert(compact.includes("Spectra vs Pendle"), "mv_compare_yield: compact mode works", `unexpected: ${compact.slice(0, 120)}`);
}

async function testCuratorScan(client) {
  console.log("\n--- mv_scan_curator_opportunities ---");

  // Basic scan with small capital
  const { text } = await client.callTool("mv_scan_curator_opportunities", {
    capital_usd: 50000,
    top_n: 5,
    compact: true,
  });

  // Should return results from both protocols
  const hasResults = text.includes("Curator Opportunity Scan") || text.includes("No opportunities");
  assert(hasResults, "mv_scan_curator_opportunities: returns valid output", `unexpected: ${text.slice(0, 120)}`);

  // If we got results, check protocol tags are present
  if (text.includes("Curator Opportunity Scan")) {
    const hasSpectraOrPendle = text.includes("[S]") || text.includes("[P]");
    assert(hasSpectraOrPendle, "mv_scan_curator_opportunities: has protocol tags", "missing [S] or [P] tags");

    const hasLegend = text.includes("Protocol Legend");
    assert(hasLegend, "mv_scan_curator_opportunities: has protocol legend", "missing legend");

    const hasNextSteps = text.includes("Next Steps");
    assert(hasNextSteps, "mv_scan_curator_opportunities: has next steps", "missing");
  }

  // With asset filter
  const { text: filtered } = await client.callTool("mv_scan_curator_opportunities", {
    capital_usd: 50000,
    asset_filter: "USDC",
    top_n: 3,
    compact: true,
  });
  const filterOk = filtered.includes("Curator Opportunity Scan") || filtered.includes("No opportunities");
  assert(filterOk, "mv_scan_curator_opportunities: asset filter works", `unexpected: ${filtered.slice(0, 120)}`);

  // mv_compare_yield now shows maturity match quality
  const { text: compared } = await client.callTool("mv_compare_yield", {
    chain: "mainnet",
    min_tvl_usd: 0,
    min_liquidity_usd: 0,
  });
  const comparedOk = compared.includes("Spectra vs Pendle") || compared.includes("No active");
  assert(comparedOk, "mv_compare_yield: responds with maturity matching", `unexpected: ${compared.slice(0, 120)}`);
  if (compared.includes("Matched Comparisons")) {
    const hasMatchQuality = compared.includes("exact") || compared.includes("close") || compared.includes("loose");
    assert(hasMatchQuality, "mv_compare_yield: shows match quality", "missing match quality labels");
  }

  // Protocol context has cross-protocol curator workflow
  const { text: ctx } = await client.callTool("mv_get_protocol_context", {
    topic: "workflow_routing",
  });
  assert(ctx.includes("mv_scan_curator_opportunities"), "protocol context references mv_scan_curator_opportunities", "missing in workflow_routing");
}

async function testCrossChainSmoke(client) {
  console.log("\n--- Cross-chain smoke tests ---");

  // Quick check that a couple non-mainnet chains respond
  for (const chain of ["base", "arbitrum"]) {
    const { text } = await client.callTool("spectra_list_pools", {
      chain,
      sort_by: "tvl",
      min_tvl_usd: 0,
    });
    assert(
      text.includes("active pool") || text.includes("No pools") || text.includes("No active"),
      `${chain}: spectra_list_pools responds`,
      `unexpected: ${text.slice(0, 80)}`
    );
  }
}


async function testGetMorphoMarkets(client) {
  console.log("\n--- morpho_list_markets ---");

  // Default: search all chains for PT markets
  const { text } = await client.callTool("morpho_list_markets", {
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
  const { text: ethMarkets } = await client.callTool("morpho_list_markets", {
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
  const { text: usdcMarkets } = await client.callTool("morpho_list_markets", {
    pt_symbol_filter: "USDC",
    top_n: 3,
  });

  assert(
    usdcMarkets.includes("USDC") || usdcMarkets.includes("No Morpho"),
    "symbol filter works",
    `unexpected: ${usdcMarkets.slice(0, 100)}`
  );

  // Filter by chain that Morpho doesn't track
  const { text: noMorpho } = await client.callTool("morpho_list_markets", {
    chain: "sonic",
  });

  assert(
    noMorpho.includes("not currently tracked") || noMorpho.includes("No Morpho"),
    "unsupported chain handled gracefully",
    `unexpected: ${noMorpho.slice(0, 100)}`
  );

  // Sort by borrow_apy
  const { text: byApy } = await client.callTool("morpho_list_markets", {
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
  console.log("\n--- morpho_get_rate ---");

  // Use the known Katana market key from the user's reference
  const katanaKey = "0xf02d47a80fbe6dbf9df4e32e1443e362a1343acb83fbb2c24a814be3557384b1";

  const { text } = await client.callTool("morpho_get_rate", {
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
  const { text: wrongChain } = await client.callTool("morpho_get_rate", {
    chain: "mainnet",
    market_key: katanaKey,
  });

  assert(
    wrongChain.includes("No Morpho market") || wrongChain.includes("Error"),
    "wrong chain handled gracefully",
    `unexpected: ${wrongChain.slice(0, 100)}`
  );

  // Test with chain that has no Morpho
  const { text: noMorpho } = await client.callTool("morpho_get_rate", {
    chain: "sonic",
    market_key: katanaKey,
  });

  assert(
    noMorpho.includes("not tracked"),
    "unsupported chain for morpho_get_rate handled",
    `unexpected: ${noMorpho.slice(0, 100)}`
  );
}

async function testLoopingAutoMorpho(client) {
  console.log("\n--- spectra_get_looping_strategy: Morpho auto-detection ---");

  if (!KNOWN_PT) {
    skip("looping auto-morpho (no PT address discovered)");
    return;
  }

  // Call without specifying morpho_ltv or borrow_rate — should try auto-detect
  const { text } = await client.callTool("spectra_get_looping_strategy", {
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
    assert(text.includes("morpho_list_markets"), "shows tip to find Morpho markets", "missing");
  }

  // Call WITH explicit overrides — should use those instead
  const { text: overridden } = await client.callTool("spectra_get_looping_strategy", {
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

async function testGetMorphoMarketSuppliers(client) {
  console.log("\n--- morpho_get_market_suppliers ---");

  // Use mainnet with a discovered market key when possible, fall back to a known katana key
  let testChain = "mainnet";
  let testKey = "0x09c2ecea058050d726f4c7df77d7a0af0e6a4cbc1949c3a7cd44cf245e2ef312";

  // Try to discover a real market key from morpho_list_markets
  const { text: marketsText } = await client.callTool("morpho_list_markets", {
    top_n: 1,
  });
  const keyMatch = marketsText.match(/Morpho Market:\s+(0x[a-fA-F0-9]+\.\.\.[a-fA-F0-9]+)/);
  if (keyMatch) {
    // Reconstruct full key from the abbreviated form — not possible, use katana key
    // Instead check if we can extract a full key from the raw output
    const fullKeyMatch = marketsText.match(/0x([a-fA-F0-9]{64})/);
    if (fullKeyMatch) {
      testKey = fullKeyMatch[0];
      // Detect chain from output
      if (marketsText.includes("katana")) testChain = "katana";
      else if (marketsText.includes("base")) testChain = "base";
      else if (marketsText.includes("arbitrum")) testChain = "arbitrum";
    }
  }

  const { text } = await client.callTool("morpho_get_market_suppliers", {
    chain: testChain,
    market_key: testKey,
  });

  // Accept: supplier analysis, market not found, or API error (Morpho API can be flaky)
  assert(
    text.includes("Supply-Side Analysis") || text.includes("No Morpho market") || text.includes("Error"),
    "has supplier analysis, market not found, or error",
    `unexpected: ${text.slice(0, 200)}`
  );

  if (text.includes("Supply-Side Analysis")) {
    assert(text.includes("Total Supply"), "has total supply", "missing");
    assert(text.includes("Utilization"), "has utilization", "missing");
    assert(text.includes("Supply APY"), "has supply APY", "missing");
    // Either has suppliers or says none found
    assert(
      text.includes("Top Suppliers") || text.includes("No supply-side positions"),
      "has supplier list or empty notice",
      "missing"
    );
  }

  // Test with chain that has no Morpho
  const { text: noMorpho } = await client.callTool("morpho_get_market_suppliers", {
    chain: "sonic",
    market_key: testKey,
  });
  assert(
    noMorpho.includes("not tracked"),
    "unsupported chain for morpho_get_market_suppliers handled",
    `unexpected: ${noMorpho.slice(0, 100)}`
  );
}

async function testGetMorphoVaults(client) {
  console.log("\n--- morpho_list_vaults ---");

  // Query mainnet vaults (most likely to have vaults)
  const { text } = await client.callTool("morpho_list_vaults", {
    chain: "mainnet",
  });

  assert(
    text.includes("Morpho Vaults") || text.includes("No Morpho vaults"),
    "has vault listing or empty notice",
    `unexpected: ${text.slice(0, 200)}`
  );

  if (text.includes("Morpho Vaults")) {
    assert(text.includes("AUM"), "has AUM", "missing");
    assert(text.includes("APY"), "has APY", "missing");
  }

  // Test with asset filter
  const { text: filtered } = await client.callTool("morpho_list_vaults", {
    chain: "mainnet",
    asset_filter: "USDC",
  });
  assert(
    filtered.includes("Morpho Vaults") || filtered.includes("No Morpho vaults"),
    "filtered vault listing works",
    `unexpected: ${filtered.slice(0, 200)}`
  );

  // Test unsupported chain
  const { text: noMorpho } = await client.callTool("morpho_list_vaults", {
    chain: "sonic",
  });
  assert(
    noMorpho.includes("not tracked"),
    "unsupported chain for morpho_list_vaults handled",
    `unexpected: ${noMorpho.slice(0, 100)}`
  );
}

async function testQuoteTrade(client) {
  console.log("\n--- spectra_quote_trade ---");

  if (!KNOWN_PT) {
    skip("spectra_quote_trade (no PT address discovered)");
    return;
  }

  // Buy PT with default slippage
  const { text: buy } = await client.callTool("spectra_quote_trade", {
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
  const { text: sell } = await client.callTool("spectra_quote_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    amount: 500,
    side: "sell",
  });

  assert(sell.includes("Sell PT"), "sell: shows Sell PT", "missing");
  assert(sell.includes("Min Output"), "sell: has minOut", "missing");

  // Custom slippage
  const { text: custom } = await client.callTool("spectra_quote_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    amount: 100,
    side: "buy",
    slippage_tolerance: 1.0,
  });

  assert(custom.includes("1.00%"), "custom slippage shows 1.00%", "missing");

  // Very large trade should show higher price impact
  const { text: large } = await client.callTool("spectra_quote_trade", {
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
  const { text: aliased } = await client.callTool("spectra_quote_trade", {
    chain: "ethereum",
    pt_address: KNOWN_PT,
    amount: 100,
    side: "sell",
  });

  assert(aliased.includes("Trade Quote") || aliased.includes("Sell PT"), "ethereum alias works for spectra_quote_trade", "failed");

  // Non-existent PT
  const { text: notFound } = await client.callTool("spectra_quote_trade", {
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
  console.log("\n--- spectra_simulate_trade ---");

  if (!KNOWN_PT) {
    skip("spectra_simulate_trade (no PT address discovered)");
    return;
  }

  // Buy PT with zero-address wallet (new position)
  const { text: buy } = await client.callTool("spectra_simulate_trade", {
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
  const { text: sellWarn } = await client.callTool("spectra_simulate_trade", {
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
  const { text: custom } = await client.callTool("spectra_simulate_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    address: ZERO_ADDRESS,
    amount: 100,
    side: "buy",
    slippage_tolerance: 2.0,
  });

  assert(custom.includes("2.00%"), "custom slippage shows 2.00%", "missing");

  // Non-existent PT
  const { text: notFound } = await client.callTool("spectra_simulate_trade", {
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
  const { text: aliased } = await client.callTool("spectra_simulate_trade", {
    chain: "ethereum",
    pt_address: KNOWN_PT,
    address: ZERO_ADDRESS,
    amount: 50,
    side: "buy",
  });

  assert(aliased.includes("Portfolio Simulation"), "ethereum alias works for simulate", "failed");
}

async function testScanOpportunities(client) {
  console.log("\n--- spectra_scan_opportunities ---");

  // Basic scan with moderate capital
  const { text } = await client.callTool("spectra_scan_opportunities", {
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
    assert(text.includes("Yield Dimensions"), "has yield dimensions", "missing");
    assert(text.includes("PT Address"), "has PT address", "missing");
    assert(text.includes("$10,000"), "shows capital amount in header", "missing");
    // LP APY with gauge emissions
    assert(text.includes("LP APY:"), "has LP APY in scan results", "missing LP APY");
  }

  // Large capital should filter out low-liquidity pools
  const { text: large } = await client.callTool("spectra_scan_opportunities", {
    capital_usd: 5000000,
    max_price_impact_pct: 1,
    top_n: 3,
  });

  assert(
    large.includes("Opportunity Scan") || large.includes("No opportunities") || large.includes("No PT pool"),
    "large capital scan completes",
    `unexpected: ${large.slice(0, 100)}`
  );

  // With asset filter
  const { text: usdc } = await client.callTool("spectra_scan_opportunities", {
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
  const { text: noLoop } = await client.callTool("spectra_scan_opportunities", {
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
  const { text: boosted } = await client.callTool("spectra_scan_opportunities", {
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

  // Phase 2: cross-protocol pointer in Next Steps
  if (text.includes("Next Steps")) {
    assert(text.includes("mv_scan_curator_opportunities"), "spectra_scan_opportunities next steps mention cross-protocol scanner", "missing");
  }
}

async function testScanYtArbitrage(client) {
  console.log("\n--- spectra_scan_yt_arbitrage ---");

  // Basic scan with moderate capital
  const { text } = await client.callTool("spectra_scan_yt_arbitrage", {
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
      text.includes("positive spread") || text.includes("negative spread") || text.includes("Spread"),
      "has spread info",
      "missing spread"
    );
    assert(text.includes("Break-Even") || text.includes("Capacity"), "has capital-aware metrics", "missing");
    assert(text.includes("PT Address"), "has PT address", "missing");
    assert(text.includes("$10,000"), "shows capital in header", "missing");
    // LP APY with gauge emissions
    assert(text.includes("LP APY:"), "has LP APY in YT arb results", "missing LP APY");
  }

  // With asset filter
  const { text: usdc } = await client.callTool("spectra_scan_yt_arbitrage", {
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
  const { text: highThresh } = await client.callTool("spectra_scan_yt_arbitrage", {
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
  const { text: ytBoosted } = await client.callTool("spectra_scan_yt_arbitrage", {
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
  console.log("\n--- spectra_get_ve_info ---");

  // Basic call: no params, just totalSupply
  const { text } = await client.callTool("spectra_get_ve_info", {});

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
  const { text: boostTable } = await client.callTool("spectra_get_ve_info", {
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
    const { text: poolBoost } = await client.callTool("spectra_get_ve_info", {
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
    skip("spectra_get_ve_info with pool (no PT address discovered)");
  }

  // Balance without capital_usd should prompt for capital
  const { text: noCapital } = await client.callTool("spectra_get_ve_info", {
    ve_spectra_balance: 100000,
  });

  assert(noCapital.includes("Provide capital_usd"), "prompts for capital_usd when missing", "missing prompt");
}

async function testGetMetavaults(client) {
  console.log("\n--- spectra_list_metavaults ---");

  // Single chain: base (known to have MetaVaults from OpenAPI example)
  const { text } = await client.callTool("spectra_list_metavaults", {
    chain: "base",
  }, 30_000);

  assert(
    text.includes("MetaVaults") || text.includes("MetaVault"),
    "returns MetaVaults header",
    `unexpected: ${text.slice(0, 100)}`
  );

  if (text.includes("Found: 0")) {
    pass("base: no MetaVaults found (may not be deployed yet)");
  } else if (text.includes("Found:")) {
    assert(text.includes("Curator:"), "has curator info", "missing");
    assert(text.includes("TVL:"), "has TVL data", "missing");
    assert(text.includes("Live APY:"), "has live APY", "missing");
    assert(text.includes("MetaVault:"), "has MetaVault address", "missing");
    assert(text.includes("Underlying:"), "has underlying info", "missing");
    assert(text.includes("Next Steps"), "has next steps", "missing");
    pass("base: MetaVaults found with expected fields");
  }

  // All chains scan
  const { text: allChains } = await client.callTool("spectra_list_metavaults", {}, 60_000);

  assert(
    allChains.includes("MetaVaults (all chains)"),
    "all-chain scan has correct header",
    `unexpected: ${allChains.slice(0, 100)}`
  );

  // Schema checks
  const tools = await client.listTools();
  const mvTool = tools.find((t) => t.name === "spectra_list_metavaults");
  assert(mvTool, "spectra_list_metavaults registered", "missing");
  if (mvTool) {
    const props = mvTool.inputSchema.properties;
    assert(props.chain, "spectra_list_metavaults has chain param", "missing");
    const required = mvTool.inputSchema.required || [];
    assert(!required.includes("chain"), "spectra_list_metavaults: chain is optional", `required: ${JSON.stringify(required)}`);
  }
}

async function testModelMetavaultStrategy(client) {
  console.log("\n--- spectra_model_metavault ---");

  // Basic: vault economics + looping table
  const { text: basic } = await client.callTool("spectra_model_metavault", {
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
  assert(basic.includes("Highest net APY:"), "has highest net APY loop", "missing");
  assert(basic.includes("Rollover Advantage"), "has rollover advantage", "missing");
  assert(basic.includes("Risks"), "has risk notes", "missing");

  // Verify math: gross = 12 + 3 = 15%, net = 15 * 0.9 = 13.5%
  assert(basic.includes("15.00%"), "gross vault APY is 15%", "missing");
  assert(basic.includes("13.50%"), "net vault APY is 13.5%", "missing");

  // With PT comparison
  const { text: compare } = await client.callTool("spectra_model_metavault", {
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
  const { text: curator } = await client.callTool("spectra_model_metavault", {
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
  const { text: unprofitable } = await client.callTool("spectra_model_metavault", {
    base_apy: 5,
    borrow_rate: 8,
  });
  assert(unprofitable.includes("MetaVault Strategy Model"), "unprofitable case still returns", "missing");
  // At loop 0 there's no borrow cost, so loop 0 should be optimal
  assert(unprofitable.includes("Highest net APY: 0 loops"), "highest net APY is 0 loops when borrow > base", `got: ${unprofitable.match(/Highest net APY:.*/)?.[0]}`);

  // No YT compounding, no external deposits (minimal params)
  const { text: minimal } = await client.callTool("spectra_model_metavault", {
    base_apy: 10,
  });
  assert(minimal.includes("MetaVault Strategy Model"), "minimal params work", "missing");
  assert(!minimal.includes("YT→LP Compounding"), "no YT compounding line when 0", "should be absent");
  assert(!minimal.includes("Curator Economics"), "no curator economics without capital_usd", "should be absent");

  // Schema: spectra_model_metavault now has chain and metavault_address
  const tools = await client.listTools();
  const mvModelTool = tools.find((t) => t.name === "spectra_model_metavault");
  if (mvModelTool) {
    const props = mvModelTool.inputSchema.properties;
    assert(props.chain, "spectra_model_metavault has chain param", "missing");
    assert(props.metavault_address, "spectra_model_metavault has metavault_address param", "missing");
    assert(props.metavault_address.pattern, "metavault_address has regex pattern", "missing");
    const required = mvModelTool.inputSchema.required || [];
    assert(!required.includes("base_apy"), "spectra_model_metavault: base_apy is optional (can be auto-fetched)", `required: ${JSON.stringify(required)}`);
    assert(!required.includes("chain"), "spectra_model_metavault: chain is optional", `required: ${JSON.stringify(required)}`);
    assert(!required.includes("metavault_address"), "spectra_model_metavault: metavault_address is optional", `required: ${JSON.stringify(required)}`);
  }

  // Error case: no base_apy and no metavault_address
  const { text: noApy, raw: noApyRaw } = await client.callTool("spectra_model_metavault", {});
  assert(
    noApy.includes("base_apy is required") || (noApyRaw && noApyRaw.isError),
    "error when no base_apy and no metavault_address",
    `unexpected: ${noApy.slice(0, 100)}`
  );

  // Next steps should mention spectra_list_metavaults
  assert(basic.includes("spectra_list_metavaults"), "next steps mention spectra_list_metavaults", "missing");

  // Next steps should mention cross-protocol scanner
  assert(basic.includes("mv_scan_curator_opportunities"), "next steps mention mv_scan_curator_opportunities", "missing");

  // ── Phase 2: Blended allocation (Spectra + Pendle) ──

  // Blended allocation with pendle_allocation_pct
  const { text: blended } = await client.callTool("spectra_model_metavault", {
    base_apy: 12,
    pendle_allocation_pct: 30,
    pendle_lp_apy: 8,
  });
  assert(blended.includes("Allocation Model"), "blended has Allocation Model section", "missing");
  assert(blended.includes("Spectra LP"), "blended shows Spectra LP line", "missing");
  assert(blended.includes("Pendle LP"), "blended shows Pendle LP line", "missing");
  assert(blended.includes("70% allocation"), "blended shows Spectra allocation pct", "missing");
  assert(blended.includes("30% allocation"), "blended shows Pendle allocation pct", "missing");
  assert(blended.includes("Blended Base APY"), "blended shows blended base APY", "missing");
  assert(blended.includes("manual rollover"), "blended warns about Pendle manual rollover", "missing");
  // Math: blended = 12 * 0.7 + 8 * 0.3 = 8.4 + 2.4 = 10.8%
  assert(blended.includes("10.80%"), "blended base APY is 10.8%", `got: ${blended.match(/Blended Base APY:.*/)?.[0]}`);

  // Validation: pendle_allocation_pct > 0 without pendle_lp_apy
  const { text: noLpApy, raw: noLpApyRaw } = await client.callTool("spectra_model_metavault", {
    base_apy: 12,
    pendle_allocation_pct: 30,
  });
  assert(
    noLpApy.includes("pendle_lp_apy is required") || (noLpApyRaw && noLpApyRaw.isError),
    "error when pendle_allocation_pct > 0 but no pendle_lp_apy",
    `unexpected: ${noLpApy.slice(0, 100)}`
  );

  // Zero allocation (default): no Allocation Model section
  assert(!minimal.includes("Allocation Model"), "no Allocation Model section when pendle_allocation_pct=0", "should be absent");

  // Schema: new params exist
  if (mvModelTool) {
    const props = mvModelTool.inputSchema.properties;
    assert(props.pendle_allocation_pct, "spectra_model_metavault has pendle_allocation_pct param", "missing");
    assert(props.pendle_lp_apy, "spectra_model_metavault has pendle_lp_apy param", "missing");
    const required = mvModelTool.inputSchema.required || [];
    assert(!required.includes("pendle_allocation_pct"), "pendle_allocation_pct is optional", `required: ${JSON.stringify(required)}`);
    assert(!required.includes("pendle_lp_apy"), "pendle_lp_apy is optional", `required: ${JSON.stringify(required)}`);
  }
}

async function testGetAddressActivity(client) {
  console.log("\n--- spectra_get_address_activity ---");

  // Use zero address (should find no activity, but shouldn't crash)
  const { text: noActivity } = await client.callTool("spectra_get_address_activity", {
    address: ZERO_ADDRESS,
    chain: "mainnet",
  }, 30_000);

  assert(
    noActivity.includes("No pool activity found") || noActivity.includes("Address Activity Scan"),
    "zero address returns no activity or scan results",
    `unexpected: ${noActivity.slice(0, 100)}`
  );

  // Schema check: must have address param with regex
  const tools = await client.listTools();
  const addrActTool = tools.find((t) => t.name === "spectra_get_address_activity");
  assert(addrActTool, "spectra_get_address_activity registered", "missing");

  if (addrActTool) {
    const props = addrActTool.inputSchema.properties;
    assert(props.address && props.address.pattern, "spectra_get_address_activity address has regex", "missing");
    assert(props.chain, "spectra_get_address_activity has optional chain param", "missing");
    assert(props.min_volume_usd, "spectra_get_address_activity has min_volume_usd param", "missing");

    const required = addrActTool.inputSchema.required || [];
    assert(required.includes("address"), "spectra_get_address_activity requires address", `required: ${JSON.stringify(required)}`);
    assert(!required.includes("chain"), "spectra_get_address_activity: chain is optional", `required: ${JSON.stringify(required)}`);
    assert(!required.includes("min_volume_usd"), "spectra_get_address_activity: min_volume_usd is optional", `required: ${JSON.stringify(required)}`);
  }

  // Test all-chain scan with zero address (should complete without crash, may be slow)
  const { text: allChain } = await client.callTool("spectra_get_address_activity", {
    address: ZERO_ADDRESS,
  }, 60_000);

  assert(
    allChain.includes("No pool activity found") || allChain.includes("Address Activity Scan"),
    "all-chain address scan completes without crash",
    `unexpected: ${allChain.slice(0, 100)}`
  );

  // If we have a known pool with activity, try scanning mainnet for a real active address
  // We'll pick an address from spectra_get_pool_activity's Address Concentration if available
  if (KNOWN_POOL) {
    const { text: poolAct } = await client.callTool("spectra_get_pool_activity", {
      chain: "mainnet",
      pool_address: KNOWN_POOL,
      limit: 5,
    });

    // Extract an active address from the Address Concentration section
    const addrMatch = poolAct.match(/\s+(0x[a-fA-F0-9]{40})\s+\d+ txns/);
    if (addrMatch) {
      const activeAddr = addrMatch[1];
      const { text: realScan } = await client.callTool("spectra_get_address_activity", {
        address: activeAddr,
        chain: "mainnet",
      }, 30_000);

      assert(
        realScan.includes("Address Activity Scan") || realScan.includes("No pool activity"),
        "real address scan returns valid output",
        `unexpected: ${realScan.slice(0, 100)}`
      );

      if (realScan.includes("Address Activity Scan")) {
        assert(realScan.includes("Pools with Activity"), "shows pool count", "missing");
        assert(realScan.includes("Volume:"), "shows volume per pool", "missing");
        assert(realScan.includes("Cross-Pool Totals"), "shows cross-pool totals", "missing");
        assert(realScan.includes("spectra_get_pool_activity"), "shows tip for deep analysis", "missing");
        pass("real address activity scan verified");
      } else {
        pass("real address had no activity on mainnet (valid empty result)");
      }
    } else {
      skip("could not extract active address from pool activity");
    }
  }
}

async function testGetCuratorDashboard(client) {
  console.log("\n--- spectra_get_curator_dashboard ---");

  // Schema checks
  const tools = await client.listTools();
  const dashTool = tools.find((t) => t.name === "spectra_get_curator_dashboard");
  assert(dashTool, "spectra_get_curator_dashboard registered", "missing");
  if (dashTool) {
    const props = dashTool.inputSchema.properties;
    assert(props.chain, "spectra_get_curator_dashboard has chain param", "missing");
    assert(props.metavault_address, "spectra_get_curator_dashboard has metavault_address param", "missing");
    assert(props.curator_fee_pct, "spectra_get_curator_dashboard has curator_fee_pct param", "missing");
    const required = dashTool.inputSchema.required || [];
    assert(required.includes("chain"), "spectra_get_curator_dashboard: chain is required", `required: ${JSON.stringify(required)}`);
    assert(required.includes("metavault_address"), "spectra_get_curator_dashboard: metavault_address is required", `required: ${JSON.stringify(required)}`);
    assert(!required.includes("curator_fee_pct"), "spectra_get_curator_dashboard: curator_fee_pct is optional", `required: ${JSON.stringify(required)}`);
  }

  // Live test: fetch all MetaVaults to find a real address, then call dashboard
  const { text: mvList } = await client.callTool("spectra_list_metavaults", {});
  const mvAddrMatch = mvList.match(/MetaVault:\s*(0x[a-fA-F0-9]{40})/);
  const mvChainMatch = mvList.match(/Chain:\s*(\w+)/);
  if (mvAddrMatch && mvChainMatch) {
    const mvAddr = mvAddrMatch[1];
    const mvChain = mvChainMatch[1];
    const { text: dash } = await client.callTool("spectra_get_curator_dashboard", {
      chain: mvChain,
      metavault_address: mvAddr,
    });
    assert(dash.includes("Curator Dashboard"), "has dashboard header", `unexpected: ${dash.slice(0, 100)}`);
    assert(dash.includes("Vault Health"), "has vault health section", "missing");
    assert(dash.includes("Positions") || dash.includes("Pool Allocations"), "has positions section", "missing");
    assert(dash.includes("Fee Revenue"), "has fee revenue section", "missing");
    assert(dash.includes("Next Steps"), "has next steps", "missing");
    assert(dash.includes("spectra_model_metavault"), "next steps mention strategy tool", "missing");
    // Phase 2: protocol tags — all current positions should be [Spectra]
    assert(dash.includes("[Spectra]") || dash.includes("No active pool"), "positions have [Spectra] protocol tag or no positions", "missing protocol tag");
    // Phase 2: cross-protocol pointer in dashboard next steps
    assert(dash.includes("mv_scan_curator_opportunities"), "dashboard next steps mention cross-protocol scanner", "missing");
    // Vault allocation: positions should show percentage + USD allocation, or "No active pool"
    const hasAllocation = dash.includes("% |") && dash.includes("$");
    assert(hasAllocation || dash.includes("No active pool"), "positions show allocation % + USD or no positions", "neither found");
  } else {
    skip("no MetaVaults found for live dashboard test");
  }

  // Error case: invalid address
  const { text: errText, isError } = await client.callTool("spectra_get_curator_dashboard", {
    chain: "base",
    metavault_address: "0x0000000000000000000000000000000000000000",
  });
  assert(errText.includes("not found"), "error for unknown metavault", `unexpected: ${errText.slice(0, 100)}`);
}

async function testOnChainQuoting(client) {
  console.log("\n--- on-chain Curve get_dy() quoting ---");

  if (!KNOWN_PT) {
    skip("on-chain quoting (no PT address discovered)");
    return;
  }

  // A normal-sized buy should attempt on-chain quoting
  const { text: buy } = await client.callTool("spectra_quote_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    amount: 100,
    side: "buy",
  });

  // Either on-chain or estimated — both are valid
  const isOnChain = buy.includes("on-chain");
  const isEstimated = buy.includes("estimated") || buy.includes("constant-product");
  assert(
    isOnChain || isEstimated,
    "quote indicates source (on-chain or estimated)",
    `no source indicator found`
  );

  if (isOnChain) {
    pass("on-chain Curve get_dy() quote returned successfully");
    assert(buy.includes("StableSwap-NG"), "on-chain quote mentions StableSwap-NG source", "missing");
    assert(buy.includes("derived from on-chain"), "on-chain price impact is derived", "missing");
  } else {
    pass("on-chain quoting fell back to math estimate (RPC may be unavailable)");
  }

  // A sell should also work
  const { text: sell } = await client.callTool("spectra_quote_trade", {
    chain: "mainnet",
    pt_address: KNOWN_PT,
    amount: 100,
    side: "sell",
  });

  assert(
    sell.includes("on-chain") || sell.includes("estimated") || sell.includes("constant-product"),
    "sell quote also indicates source",
    "missing source indicator"
  );
}

async function testGetOnchainActivity(client) {
  console.log("\n--- spectra_get_onchain_activity ---");

  // Test with a known Spectra pool on Base (has default RPC)
  // Use a small lookback to keep it fast
  if (!KNOWN_POOL) {
    skip("spectra_get_onchain_activity: no KNOWN_POOL discovered");
    return;
  }

  const { text } = await client.callTool("spectra_get_onchain_activity", {
    chain: "base",
    pool_address: KNOWN_POOL,
    lookback_hours: 48,
    limit: 10,
  });

  // Could be empty (no activity in 48h) or have results
  assert(
    text.includes("On-Chain Activity") || text.includes("No ") || text.includes("events"),
    "on-chain activity response has expected structure",
    `unexpected: ${text.slice(0, 200)}`
  );
  assert(
    text.includes("Block Range") || text.includes("blocks"),
    "on-chain activity mentions block range",
    `missing block range: ${text.slice(0, 200)}`
  );
  assert(
    text.includes("Chunks") || text.includes("chunks"),
    "on-chain activity mentions chunk status",
    `missing chunks: ${text.slice(0, 200)}`
  );

  // Test error case: chain with no RPC and no override (monad has no default RPC)
  const { text: noRpc } = await client.callTool("spectra_get_onchain_activity", {
    chain: "monad",
    pool_address: "0x0000000000000000000000000000000000000001",
    lookback_hours: 1,
  });
  assert(
    noRpc.includes("No RPC") || noRpc.includes("rpc_url"),
    "no-RPC chain returns helpful error",
    `unexpected: ${noRpc.slice(0, 200)}`
  );

  // Test schema: verify rpc_url param exists
  const tools = await client.listTools();
  const onchainTool = tools.find((t) => t.name === "spectra_get_onchain_activity");
  assert(onchainTool, "spectra_get_onchain_activity registered", "missing");
  if (onchainTool) {
    const props = onchainTool.inputSchema.properties;
    assert(props.rpc_url, "has rpc_url param", "missing");
    assert(props.from_block, "has from_block param", "missing");
    assert(props.to_block, "has to_block param", "missing");
    assert(props.lookback_hours, "has lookback_hours param", "missing");
    assert(props.address, "has address filter param", "missing");
    assert(props.type_filter && props.type_filter.enum, "has type_filter enum", "missing");
    assert(props.pt_address, "has pt_address param", "missing");
    assert(props.pool_address, "has pool_address param", "missing");
    const required = onchainTool.inputSchema.required || [];
    assert(required.includes("chain"),
      "requires chain",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("pool_address"),
      "pool_address is optional (at least one of pool_address/pt_address needed)",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("pt_address"),
      "pt_address is optional (at least one of pool_address/pt_address needed)",
      `required: ${JSON.stringify(required)}`);
    assert(!required.includes("rpc_url"),
      "rpc_url is optional",
      `required: ${JSON.stringify(required)}`);
    // type_filter should include the new PT vault event types
    const typeEnum = props.type_filter.enum;
    assert(typeEnum.includes("MINT_PT_YT"), "type_filter includes MINT_PT_YT", `enum: ${JSON.stringify(typeEnum)}`);
    assert(typeEnum.includes("REDEEM_PT"), "type_filter includes REDEEM_PT", `enum: ${JSON.stringify(typeEnum)}`);
    assert(typeEnum.includes("YIELD_CLAIMED"), "type_filter includes YIELD_CLAIMED", `enum: ${JSON.stringify(typeEnum)}`);
  }

  // Test: neither pool_address nor pt_address → error
  const { text: noAddr } = await client.callTool("spectra_get_onchain_activity", {
    chain: "base",
  });
  assert(
    noAddr.includes("At least one of pool_address or pt_address"),
    "error when neither pool_address nor pt_address provided",
    `unexpected: ${noAddr.slice(0, 200)}`
  );
}

async function testGetExpiringPools(client) {
  console.log("\n--- spectra_list_expiring_pools ---");

  // Default call — scan all chains, 21-day threshold
  const { text } = await client.callTool("spectra_list_expiring_pools", {}, 60_000);
  // Should return valid output (either expiring pools or "No pools expiring")
  assert(
    text.includes("Expiring Pools") || text.includes("No pools expiring"),
    "returns valid response",
    `unexpected output: ${text.slice(0, 150)}`
  );

  // If there are expiring pools, check structure
  if (text.includes("Expiring Pools")) {
    assert(text.includes("CRITICAL") || text.includes("WARNING") || text.includes("ALERT"),
      "has urgency labels", "missing urgency grouping");
    assert(text.includes("IBT:"), "has IBT info", "missing IBT info");
    assert(text.includes("Chain ID:"), "has chain ID", "missing chain ID");
    // Readiness assessment
    assert(text.includes("Readiness:"), "has readiness assessment", "missing readiness line");
    assert(
      text.includes("Readiness: OK") || text.includes("Readiness: CAUTION") || text.includes("Readiness: WARNING"),
      "readiness has valid level",
      "unexpected readiness format"
    );
    // Successor cross-reference
    assert(text.includes("Successor:"), "has per-pool successor status", "missing successor line");
    // Operator checklist
    assert(text.includes("Operator Checklist"), "has operator checklist", "missing operator checklist");
    assert(
      text.includes("Deploy successor pool") || text.includes("Submit gauge proposal") || text.includes("Ready for migration"),
      "has actionable checklist items",
      "missing checklist categorization"
    );
    // Next steps with tool calls
    assert(text.includes("Next Steps"), "has next steps section", "missing next steps");
  }

  // Compact mode
  const { text: compact } = await client.callTool("spectra_list_expiring_pools", {
    compact: true,
  }, 60_000);
  assert(
    compact.includes("Expiring Pools") || compact.includes("No pools expiring"),
    "compact mode returns valid response",
    `unexpected: ${compact.slice(0, 150)}`
  );
  if (compact.includes("Expiring Pools")) {
    assert(compact.includes("Urg"), "compact has table header", "missing table header");
    assert(compact.includes("Succ"), "compact has successor column", "missing successor column in compact");
    assert(compact.includes("Gauge"), "compact has gauge column", "missing gauge column in compact");
    assert(compact.includes("Rdy"), "compact has readiness column", "missing readiness column in compact");
  }

  // Very short threshold — should return empty or very few
  const { text: short } = await client.callTool("spectra_list_expiring_pools", {
    threshold_days: 1,
  }, 60_000);
  assert(
    short.includes("Expiring Pools") || short.includes("No pools expiring"),
    "1-day threshold returns valid response",
    `unexpected: ${short.slice(0, 150)}`
  );

  // Very long threshold — should find more pools
  const { text: long } = await client.callTool("spectra_list_expiring_pools", {
    threshold_days: 180,
  }, 60_000);
  assert(
    long.includes("Expiring Pools") || long.includes("No pools expiring"),
    "180-day threshold returns valid response",
    `unexpected: ${long.slice(0, 150)}`
  );

  // If both short and long returned pools, long should have >= short count
  const shortCount = (short.match(/Readiness:/g) || []).length;
  const longCount = (long.match(/Readiness:/g) || []).length;
  if (shortCount > 0 && longCount > 0) {
    assert(longCount >= shortCount, "longer threshold finds >= pools", `${longCount} < ${shortCount}`);
  }

  // Single chain filter
  const { text: chainFilter } = await client.callTool("spectra_list_expiring_pools", {
    threshold_days: 365,
    chain: "mainnet",
  }, 60_000);
  assert(
    chainFilter.includes("Expiring Pools") || chainFilter.includes("No pools expiring"),
    "chain filter returns valid response",
    `unexpected: ${chainFilter.slice(0, 150)}`
  );
  // If it found pools, verify they're all on mainnet (no other chain names in pool entries)
  if (chainFilter.includes("Expiring Pools") && chainFilter.includes("on mainnet")) {
    assert(!chainFilter.includes("Chain ID: 8453"), "mainnet filter excludes base (8453)", "found base chain in mainnet-only results");
  }

  // High TVL filter
  const { text: highTvl } = await client.callTool("spectra_list_expiring_pools", {
    threshold_days: 365,
    min_tvl_usd: 999999999999,
  }, 60_000);
  assert(
    highTvl.includes("No pools expiring"),
    "extreme TVL filter returns empty",
    `expected no pools with TVL > $999B: ${highTvl.slice(0, 150)}`
  );
}

async function testMalformedAddresses(client) {
  console.log("\n--- Malformed address validation ---");

  // Too short
  const { text: tooShort } = await client.callTool("spectra_get_pt_details", {
    chain: "mainnet",
    pt_address: "0x1234",
  });
  assert(
    tooShort.includes("Invalid") || tooShort.includes("error") || tooShort.includes("Error"),
    "too-short address rejected",
    `unexpected: ${tooShort.slice(0, 100)}`
  );

  // Non-hex characters
  const { text: nonHex } = await client.callTool("spectra_get_pt_details", {
    chain: "mainnet",
    pt_address: "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
  });
  assert(
    nonHex.includes("Invalid") || nonHex.includes("error") || nonHex.includes("Error"),
    "non-hex address rejected",
    `unexpected: ${nonHex.slice(0, 100)}`
  );

  // Missing 0x prefix
  const { text: noPrefix } = await client.callTool("spectra_get_pt_details", {
    chain: "mainnet",
    pt_address: "1234567890abcdef1234567890abcdef12345678",
  });
  assert(
    noPrefix.includes("Invalid") || noPrefix.includes("error") || noPrefix.includes("Error"),
    "missing-0x-prefix address rejected",
    `unexpected: ${noPrefix.slice(0, 100)}`
  );

  // Too long
  const { text: tooLong } = await client.callTool("spectra_get_pt_details", {
    chain: "mainnet",
    pt_address: "0x00000000000000000000000000000000000000000000",
  });
  assert(
    tooLong.includes("Invalid") || tooLong.includes("error") || tooLong.includes("Error"),
    "too-long address rejected",
    `unexpected: ${tooLong.slice(0, 100)}`
  );

  // Empty string
  const { text: empty } = await client.callTool("spectra_get_pt_details", {
    chain: "mainnet",
    pt_address: "",
  });
  assert(
    empty.includes("Invalid") || empty.includes("error") || empty.includes("Error"),
    "empty address rejected",
    `unexpected: ${empty.slice(0, 100)}`
  );

  // Morpho market_key: too short (should be 64 hex chars)
  const { text: shortKey } = await client.callTool("morpho_get_rate", {
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
  console.log("MetaVault MCP Server -- Test Suite");
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

      // spectra_list_pools must run before pool-dependent tests (discovers KNOWN_POOL)
      await testListPools(client);

      // Tools that use discovered pool address
      await testGetPoolVolume(client);
      await testGetPoolActivity(client);
      await testActivityEmptyFilter(client);
      await testGetAddressActivity(client);

      // Tools that need a PT address (discovered from spectra_list_pools)
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
      await testGetMorphoMarketSuppliers(client);
      await testGetMorphoVaults(client);
      await testLoopingAutoMorpho(client);

      // Trade quoting & simulation
      await testQuoteTrade(client);
      await testOnChainQuoting(client);
      await testSimulatePortfolioAfterTrade(client);

      // Strategy scanner
      await testScanOpportunities(client);

      // YT arbitrage scanner
      await testScanYtArbitrage(client);

      // veSPECTRA info
      await testGetVeInfo(client);

      // LP APY gauge emissions
      await testLpApyGaugeEmissions(client);

      // MetaVault API + strategy modeler + curator dashboard
      await testGetMetavaults(client);
      await testModelMetavaultStrategy(client);
      await testGetCuratorDashboard(client);

      // Pendle tools (standalone)
      await testListPendleMarkets(client);
      await testComparePendleSpectra(client);

      // Cross-protocol curator scanner
      await testCuratorScan(client);

      // Smoke test other chains
      await testCrossChainSmoke(client);

      // On-chain activity (eth_getLogs)
      await testGetOnchainActivity(client);

      // Expiry monitor
      await testGetExpiringPools(client);

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
