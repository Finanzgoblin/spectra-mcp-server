#!/usr/bin/env node

/**
 * Spectra MCP Server -- Automated Subjective Test Harness
 *
 * Parses 38 questions from AGENT-TESTS.md, calls MCP tools to gather data,
 * sends question + tool outputs to Claude for answering, then grades the
 * response against the rubric using a separate LLM judge call.
 *
 * Three-stage pipeline per question:
 *   1. Tool call -- pre-mapped MCP tools via McpTestClient
 *   2. Answer   -- Claude API (simulates agent reasoning over tool outputs)
 *   3. Grade    -- Claude API (LLM-as-judge against rubric)
 *
 * Usage:
 *   node test-subjective.cjs                         # run all 38 questions
 *   node test-subjective.cjs --tier 3                # run only Tier 3
 *   node test-subjective.cjs --question 29           # run only Q29
 *   node test-subjective.cjs --dry-run               # tool calls only, skip LLM
 *   node test-subjective.cjs --delay 2000            # ms between questions (default 1000)
 *   node test-subjective.cjs --answer-model claude-sonnet-4-20250514
 *   node test-subjective.cjs --grade-model claude-haiku-3-20240307
 *
 * Environment:
 *   ANTHROPIC_API_KEY          Required (unless --dry-run)
 *   SUBJECTIVE_ANSWER_MODEL    Override answer model
 *   SUBJECTIVE_GRADE_MODEL     Override grade model
 *
 * Exit code 0 = all pass (A+/A), 1 = any C/F grades.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER_PATH = path.join(__dirname, "build", "index.js");
const TOOL_TIMEOUT_MS = 60_000; // per-tool call (generous for cross-chain scans)
const TOTAL_TIMEOUT_MS = 1_200_000; // 20 min for whole suite
const MAX_ANSWER_TOKENS = 4000;
const MAX_GRADE_TOKENS = 300;

// Known address used in Tier 8/9 tests (from AGENT-TESTS.md)
const KNOWN_TEST_ADDRESS = "0xc0e88f859de5c9ebdddd7e5c4c46ab7fcecd65d7";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    tier: null,
    question: null,
    dryRun: false,
    delay: 1000,
    answerModel: process.env.SUBJECTIVE_ANSWER_MODEL || "claude-sonnet-4-20250514",
    gradeModel: process.env.SUBJECTIVE_GRADE_MODEL || "claude-haiku-3-20240307",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier" && args[i + 1]) opts.tier = parseInt(args[++i]);
    else if (args[i] === "--question" && args[i + 1]) opts.question = parseInt(args[++i]);
    else if (args[i] === "--dry-run") opts.dryRun = true;
    else if (args[i] === "--delay" && args[i + 1]) opts.delay = parseInt(args[++i]);
    else if (args[i] === "--answer-model" && args[i + 1]) opts.answerModel = args[++i];
    else if (args[i] === "--grade-model" && args[i + 1]) opts.gradeModel = args[++i];
  }
  return opts;
}

// ---------------------------------------------------------------------------
// MCP client wrapper (same pattern as test-agent.cjs)
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

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "spectra-subjective-test", version: "1.0" },
    }, 10_000);

    this._send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    await new Promise((r) => setTimeout(r, 200));
  }

  stop() {
    for (const [, entry] of this._pending) {
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
    const timeout = timeoutMs || TOOL_TIMEOUT_MS;
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
// AGENT-TESTS.md parser
// ---------------------------------------------------------------------------

function parseAgentTests(markdown) {
  const questions = [];

  // Find all tier headers with positions
  const tiers = [];
  const tierRegex = /^## Tier (\d+):\s*(.+)$/gm;
  let m;
  while ((m = tierRegex.exec(markdown))) {
    tiers.push({ num: parseInt(m[1]), title: m[2].trim(), pos: m.index });
  }

  // Find all question headers with positions
  const qHeaders = [];
  const qRegex = /^### Q(\d+):\s*(.+)$/gm;
  while ((m = qRegex.exec(markdown))) {
    qHeaders.push({ num: parseInt(m[1]), title: m[2].trim(), pos: m.index });
  }

  // Extract content for each question
  for (let i = 0; i < qHeaders.length; i++) {
    const start = qHeaders[i].pos;
    const end = i + 1 < qHeaders.length ? qHeaders[i + 1].pos : markdown.length;
    const section = markdown.slice(start, end);

    // Extract fields
    const promptMatch = section.match(/\*\*Prompt:\*\*\s*"([^"]+)"/);
    const testsMatch = section.match(/\*\*Tests:\*\*\s*(.+)/);
    const expectedMatch = section.match(/\*\*Expected:\*\*\s*([\s\S]+?)(?=\*\*Grading|\*\*Key failure)/);
    const gradingMatch = section.match(/\*\*Grading:\*\*\s*([\s\S]+?)(?=\*\*Key failure|---|\n## |\n### |$)/);
    const failureModeMatch = section.match(/\*\*Key failure mode:\*\*\s*([\s\S]+?)(?=---|$)/);

    // Count difficulty stars in title
    const starCount = (qHeaders[i].title.match(/⭐/g) || []).length;

    // Find which tier this question belongs to
    const tier = tiers.filter(t => t.pos < start).pop();

    questions.push({
      num: qHeaders[i].num,
      title: qHeaders[i].title.replace(/\s*⭐+$/, "").trim(),
      tier: tier ? tier.num : 0,
      tierTitle: tier ? tier.title : "",
      difficulty: starCount,
      prompt: promptMatch ? promptMatch[1].trim() : "",
      tests: testsMatch ? testsMatch[1].trim() : "",
      expected: expectedMatch ? expectedMatch[1].trim() : "",
      grading: gradingMatch ? gradingMatch[1].trim() : "",
      failureMode: failureModeMatch ? failureModeMatch[1].trim() : "",
    });
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Tool mapping per question
// ---------------------------------------------------------------------------

function buildToolMap(discovery) {
  const d = discovery;
  const STAK = d.stakPt;
  const PT = d.knownPt;
  const POOL = d.knownPool;
  const ADDR = d.knownActiveAddress;
  const KATANA_PT = d.katanaPt;
  const KATANA_POOL = d.katanaPool;
  const TEST_ADDR = KNOWN_TEST_ADDRESS;

  return {
    1: [{ tool: "spectra_list_chains", args: {} }],
    2: [{ tool: "spectra_get_best_fixed_yields", args: { top_n: 10, min_tvl_usd: 1000, min_liquidity_usd: 1000 } }],
    3: [{ tool: "spectra_list_pools", args: { chain: "mainnet" } }],
    4: [{ tool: "spectra_list_metavaults", args: {} }],
    5: [{ tool: "spectra_scan_opportunities", args: { capital_usd: 50000, top_n: 10, include_metavaults: false } }],
    6: [
      { tool: "mv_compare_yield", args: { chain: "mainnet", min_tvl_usd: 1000, min_liquidity_usd: 1000 } },
      { tool: "spectra_list_pools", args: { chain: "mainnet", min_tvl_usd: 1000 } },
    ],
    7: [
      { tool: "morpho_list_markets", args: { chain: "mainnet" } },
      ...(STAK ? [{ tool: "spectra_get_looping_strategy", args: { chain: "mainnet", pt_address: STAK } }] : []),
    ],
    8: [
      ...(PT ? [{ tool: "spectra_simulate_trade", args: {
        chain: "mainnet", pt_address: PT,
        address: "0x0000000000000000000000000000000000000000",
        amount: 500, side: "buy",
      }}] : []),
    ],
    9: [
      { tool: "mv_get_protocol_context", args: { topic: "router_batching" } },
      ...(POOL ? [{ tool: "spectra_get_pool_activity", args: { chain: "mainnet", pool_address: POOL, limit: 30 } }] : []),
    ],
    10: [{ tool: "mv_get_protocol_context", args: { topic: "pt_yt_mechanics" } }],
    11: [{ tool: "mv_get_protocol_context", args: { topic: "pt_yt_mechanics" } }],
    12: [{ tool: "mv_get_protocol_context", args: { topic: "router_batching" } }],
    13: [{ tool: "spectra_list_metavaults", args: {} }],
    14: [
      { tool: "spectra_get_best_fixed_yields", args: { top_n: 5, min_tvl_usd: 0, min_liquidity_usd: 0 } },
      { tool: "spectra_list_pools", args: { chain: "avalanche", min_tvl_usd: 0 } },
    ],
    15: [
      ...(PT ? [{ tool: "spectra_get_looping_strategy", args: { chain: "mainnet", pt_address: PT } }] : []),
    ],
    16: [{ tool: "spectra_list_metavaults", args: {} }],
    17: [
      ...(POOL && ADDR ? [{ tool: "spectra_get_pool_activity", args: { chain: "mainnet", pool_address: POOL, address: ADDR, limit: 50 } }] : []),
      ...(ADDR ? [{ tool: "spectra_get_portfolio", args: { address: ADDR, chain: "mainnet" } }] : []),
    ],
    18: [{ tool: "spectra_get_ve_info", args: { ve_spectra_balance: 1000000, capital_usd: 1000 } }],
    19: [
      ...(STAK ? [{ tool: "spectra_compare_yield", args: { chain: "mainnet", pt_address: STAK } }] : []),
      { tool: "spectra_scan_yt_arbitrage", args: { capital_usd: 10000, top_n: 5 } },
    ],
    20: [{ tool: "spectra_list_pools", args: { chain: "mainnet", min_tvl_usd: 0 } }],
    21: [{ tool: "spectra_list_chains", args: {} }],
    22: [
      ...(ADDR ? [
        { tool: "spectra_get_portfolio", args: { address: ADDR } },
        { tool: "spectra_get_address_activity", args: { address: ADDR } },
      ] : []),
    ],
    23: [
      { tool: "mv_get_protocol_context", args: { topic: "router_batching" } },
      ...(POOL && ADDR ? [{ tool: "spectra_get_onchain_activity", args: { chain: "mainnet", pool_address: POOL, address: ADDR, lookback_hours: 720, limit: 20 } }] : []),
    ],
    24: [{ tool: "spectra_list_metavaults", args: {} }],
    25: [
      { tool: "spectra_get_best_fixed_yields", args: { top_n: 10, min_tvl_usd: 1000, min_liquidity_usd: 1000 } },
      { tool: "spectra_scan_opportunities", args: { capital_usd: 10000, top_n: 10, include_metavaults: false } },
    ],
    26: [{ tool: "spectra_list_metavaults", args: {} }],
    27: [
      { tool: "spectra_list_pools", args: { chain: "katana", min_tvl_usd: 0 } },
      ...(KATANA_PT ? [{ tool: "spectra_get_pt_details", args: { chain: "katana", pt_address: KATANA_PT } }] : []),
    ],
    28: [
      { tool: "spectra_list_pools", args: { chain: "katana", min_tvl_usd: 0 } },
      { tool: "spectra_list_pools", args: { chain: "flare", min_tvl_usd: 0 } },
    ],
    29: [
      ...(POOL ? [{ tool: "spectra_get_pool_activity", args: { chain: "mainnet", pool_address: POOL, address: TEST_ADDR, limit: 50 } }] : []),
      { tool: "spectra_get_portfolio", args: { address: TEST_ADDR, chain: "mainnet" } },
    ],
    30: [{ tool: "mv_get_protocol_context", args: { topic: "router_batching" } }],
    31: [
      { tool: "spectra_get_address_activity", args: { address: TEST_ADDR } },
      { tool: "spectra_get_portfolio", args: { address: TEST_ADDR } },
    ],
    32: [
      ...(POOL ? [{ tool: "spectra_get_pool_activity", args: { chain: "mainnet", pool_address: POOL, address: TEST_ADDR, limit: 50 } }] : []),
      { tool: "spectra_get_portfolio", args: { address: TEST_ADDR, chain: "mainnet" } },
    ],
    33: [{ tool: "mv_get_protocol_context", args: { topic: "router_batching" } }],
    34: [
      ...(POOL ? [{ tool: "spectra_get_pool_activity", args: { chain: "mainnet", pool_address: POOL, address: TEST_ADDR, limit: 50 } }] : []),
    ],
    35: [
      ...(ADDR ? [{ tool: "spectra_get_portfolio", args: { address: ADDR, chain: "mainnet" } }] : []),
    ],
    36: [
      { tool: "mv_get_protocol_context", args: { topic: "deposit_path" } },
      { tool: "spectra_scan_opportunities", args: { capital_usd: 50000, top_n: 5 } },
      { tool: "mv_scan_curator_opportunities", args: { capital_usd: 50000, top_n: 5 } },
    ],
    37: [
      { tool: "spectra_scan_opportunities", args: { capital_usd: 10000, top_n: 5, include_metavaults: false } },
      { tool: "mv_get_protocol_context", args: { topic: "workflow_routing" } },
    ],
    38: [{ tool: "mv_get_protocol_context", args: { topic: "workflow_routing" } }],
  };
}

// ---------------------------------------------------------------------------
// Claude API client (zero deps, raw https)
// ---------------------------------------------------------------------------

function callClaude(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Promise.reject(new Error("ANTHROPIC_API_KEY not set"));
  }

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  return new Promise((resolve, reject) => {
    const doRequest = (retryCount) => {
      const req = https.request({
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 120_000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              // Retry on rate limit
              if (res.statusCode === 429 && retryCount < 1) {
                console.log("    [rate limited, retrying in 30s...]");
                setTimeout(() => doRequest(retryCount + 1), 30_000);
                return;
              }
              reject(new Error(`Claude API: ${parsed.error.message || JSON.stringify(parsed.error)}`));
              return;
            }
            const text = parsed.content && parsed.content[0] && parsed.content[0].text;
            resolve(text || "");
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Claude API timeout (120s)"));
      });
      req.write(body);
      req.end();
    };
    doRequest(0);
  });
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildAnswerPrompt(question, toolOutputs) {
  const toolContext = toolOutputs.length > 0
    ? toolOutputs.map((t, i) =>
      `--- Tool ${i + 1}: ${t.tool}(${JSON.stringify(t.args)}) ---\n${t.output}\n--- End Tool ${i + 1} ---`
    ).join("\n\n")
    : "(No tool outputs — this question tests pure reasoning.)";

  const system = `You are a DeFi analyst with access to Spectra Finance protocol data. You have called several tools and received their outputs below. Analyze the data and answer the user's question.

Rules:
- Base your answer ONLY on the tool outputs provided below. Do not invent data.
- When tool outputs present competing interpretations (A/B/C branches), preserve the ambiguity. Do not collapse to one interpretation without strong evidence.
- Flag anomalies (extreme APYs, tiny liquidity, broken IBT).
- Mention risks and caveats when discussing yield opportunities.
- Cross-reference data across tool outputs when multiple tools are provided.
- If tool outputs show observation coverage metrics, size your confidence to the coverage level.
- Explain protocol mechanics in plain language when relevant.
- Do NOT provide investment advice. Present analysis and let the user decide.

Tool Outputs:
${toolContext}`;

  return { system, user: question.prompt };
}

function buildGradePrompt(question, answer) {
  const system = `You are a strict evaluator grading an AI agent's response about the Spectra Finance DeFi protocol. You will be given a question, the expected behavior, a grading rubric, and the agent's actual answer.

Your job is to assign ONE grade following the rubric EXACTLY. Be strict — match the rubric criteria literally.

Grade scale:
- A+ = Perfect — deep protocol understanding, multi-tool cross-reference, appropriate caveats
- A  = Strong — correct reasoning, good tool usage, minor gaps
- B  = Adequate — gets basics right but misses nuance or doesn't cross-reference
- C  = Weak — parrots tool output without interpreting, or misuses tools
- F  = Fails — hallucinates data, gives dangerous advice, fundamentally misunderstands

Output format (EXACTLY this, nothing else):
GRADE: [one of: A+, A, B, C, F]
REASON: [one sentence explaining why this grade was chosen]`;

  const user = `QUESTION: "${question.prompt}"

EXPECTED BEHAVIOR:
${question.expected}

GRADING RUBRIC:
${question.grading}
${question.failureMode ? `\nKEY FAILURE MODE TO WATCH FOR: ${question.failureMode}` : ""}

AGENT'S ANSWER:
${answer}

Assign exactly one grade and give a one-sentence reason.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Grade parsing
// ---------------------------------------------------------------------------

function parseGrade(text) {
  const gradeMatch = text.match(/GRADE:\s*(A\+|A|B|C|F)/i);
  const reasonMatch = text.match(/REASON:\s*(.+)/i);
  return {
    grade: gradeMatch ? gradeMatch[1].toUpperCase().replace("A+", "A+") : "UNKNOWN",
    reason: reasonMatch ? reasonMatch[1].trim() : "Could not parse grader response",
  };
}

function gradeToSymbol(grade) {
  if (grade === "A+" || grade === "A") return "\u2705";  // ✅
  if (grade === "B") return "\u26A0\uFE0F";              // ⚠️
  if (grade === "C" || grade === "F") return "\u274C";    // ❌
  return "?";
}

function gradeToCategory(grade) {
  if (grade === "A+" || grade === "A") return "pass";
  if (grade === "B") return "partial";
  if (grade === "C" || grade === "F") return "fail";
  return "other";
}

// ---------------------------------------------------------------------------
// Discovery phase — find live addresses and pools
// ---------------------------------------------------------------------------

async function runDiscovery(client) {
  const result = {
    knownPt: null,
    knownPool: null,
    knownActiveAddress: null,
    stakPt: null,
    katanaPt: null,
    katanaPool: null,
  };

  console.log("Discovery phase...");

  // Discover mainnet pools
  try {
    const { text: pools } = await client.callTool("spectra_list_pools", {
      chain: "mainnet", sort_by: "tvl", min_tvl_usd: 10000,
    }, TOOL_TIMEOUT_MS);

    // Extract first PT address
    const ptMatch = pools.match(/PT(?:\s+Address)?:\s*(0x[a-fA-F0-9]{40})/);
    if (ptMatch) result.knownPt = ptMatch[1];

    // Extract first pool address
    const poolMatch = pools.match(/Pool(?:\s+Address)?:\s*(0x[a-fA-F0-9]{40})/);
    if (poolMatch) result.knownPool = poolMatch[1];

    // Find STAK PT — look for STAK in pool names/lines and grab the PT address near it
    const lines = pools.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/stak/i.test(lines[i])) {
        // Look at surrounding lines for a PT address
        const window = lines.slice(Math.max(0, i - 2), i + 5).join("\n");
        const stakPtMatch = window.match(/PT(?:\s+Address)?:\s*(0x[a-fA-F0-9]{40})/);
        if (stakPtMatch) {
          result.stakPt = stakPtMatch[1];
          break;
        }
      }
    }

    console.log(`  Mainnet: PT=${result.knownPt?.slice(0, 10) || "none"}... Pool=${result.knownPool?.slice(0, 10) || "none"}... STAK=${result.stakPt?.slice(0, 10) || "none"}...`);
  } catch (e) {
    console.log(`  Mainnet discovery failed: ${e.message}`);
  }

  // Discover active address from pool activity
  if (result.knownPool) {
    try {
      const { text: activity } = await client.callTool("spectra_get_pool_activity", {
        chain: "mainnet", pool_address: result.knownPool, limit: 50,
      }, TOOL_TIMEOUT_MS);

      // Look for address in Address Concentration section
      const addrMatch = activity.match(/(0x[a-fA-F0-9]{40})\s+\d+\s+txn/);
      if (addrMatch && addrMatch[1].toLowerCase() !== result.knownPool.toLowerCase()) {
        result.knownActiveAddress = addrMatch[1];
      }
      console.log(`  Active address: ${result.knownActiveAddress?.slice(0, 10) || "none"}...`);
    } catch (e) {
      console.log(`  Activity discovery failed: ${e.message}`);
    }
  }

  // Discover Katana pools
  try {
    const { text: katana } = await client.callTool("spectra_list_pools", {
      chain: "katana", min_tvl_usd: 0,
    }, TOOL_TIMEOUT_MS);

    const katPtMatch = katana.match(/PT(?:\s+Address)?:\s*(0x[a-fA-F0-9]{40})/);
    if (katPtMatch) result.katanaPt = katPtMatch[1];

    const katPoolMatch = katana.match(/Pool(?:\s+Address)?:\s*(0x[a-fA-F0-9]{40})/);
    if (katPoolMatch) result.katanaPool = katPoolMatch[1];

    console.log(`  Katana: PT=${result.katanaPt?.slice(0, 10) || "none"}...`);
  } catch (e) {
    console.log(`  Katana discovery failed: ${e.message}`);
  }

  console.log("");
  return result;
}

// ---------------------------------------------------------------------------
// Summary reporter
// ---------------------------------------------------------------------------

function printSummary(results, opts, durationMs) {
  const tierGroups = {};
  for (const r of results) {
    const tierKey = `Tier ${r.question.tier}: ${r.question.tierTitle}`;
    if (!tierGroups[tierKey]) tierGroups[tierKey] = [];
    tierGroups[tierKey].push(r);
  }

  console.log("\n========================================");
  console.log("SUBJECTIVE TEST RESULTS");
  console.log("========================================\n");

  for (const [tierName, items] of Object.entries(tierGroups)) {
    console.log(tierName);
    for (const r of items) {
      const sym = gradeToSymbol(r.grade);
      const stars = r.question.difficulty > 0 ? " " + "\u2B50".repeat(r.question.difficulty) : "";
      const qNum = `Q${r.question.num}`.padEnd(4);
      const title = r.question.title.slice(0, 44).padEnd(44);
      const grade = (r.grade || "?").padEnd(3);
      const reason = r.reason ? `  ${r.reason.slice(0, 60)}` : "";
      console.log(`  ${qNum} ${title} ${sym} ${grade}${reason}`);
    }
    console.log("");
  }

  // Totals
  let passCount = 0, partialCount = 0, failCount = 0, otherCount = 0;
  for (const r of results) {
    const cat = gradeToCategory(r.grade);
    if (cat === "pass") passCount++;
    else if (cat === "partial") partialCount++;
    else if (cat === "fail") failCount++;
    else otherCount++;
  }

  const total = results.length;
  const pctPass = total > 0 ? ((passCount / total) * 100).toFixed(1) : "0.0";
  const pctPartial = total > 0 ? ((partialCount / total) * 100).toFixed(1) : "0.0";
  const pctFail = total > 0 ? ((failCount / total) * 100).toFixed(1) : "0.0";
  const pctOther = total > 0 ? ((otherCount / total) * 100).toFixed(1) : "0.0";

  console.log("========================================");
  console.log("TOTALS");
  console.log(`  \u2705 Pass (A+/A):  ${passCount} / ${total}  (${pctPass}%)`);
  console.log(`  \u26A0\uFE0F Partial (B):  ${partialCount} / ${total}  (${pctPartial}%)`);
  console.log(`  \u274C Fail (C/F):   ${failCount} / ${total}  (${pctFail}%)`);
  if (otherCount > 0) {
    console.log(`  ? Error/Skip:   ${otherCount} / ${total}  (${pctOther}%)`);
  }
  console.log("");
  console.log(`  Target: \u226531/38 at \u2705`);
  console.log(`  Answer model: ${opts.answerModel}`);
  console.log(`  Grade model:  ${opts.gradeModel}`);
  if (durationMs) {
    const mins = Math.floor(durationMs / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);
    console.log(`  Duration: ${mins}m ${secs}s`);
  }
  console.log("========================================\n");
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  // Validate API key early (unless dry-run)
  if (!opts.dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable required.");
    console.error("Set it: export ANTHROPIC_API_KEY=sk-ant-...");
    console.error("Or use --dry-run to skip LLM calls.");
    process.exit(1);
  }

  // Global timeout
  const globalTimer = setTimeout(() => {
    console.error("\nGlobal timeout reached. Exiting.");
    process.exit(1);
  }, TOTAL_TIMEOUT_MS);

  // Step 1: Parse AGENT-TESTS.md
  const mdPath = path.join(__dirname, "AGENT-TESTS.md");
  const markdown = fs.readFileSync(mdPath, "utf-8");
  const allQuestions = parseAgentTests(markdown);
  console.log(`Parsed ${allQuestions.length} questions from AGENT-TESTS.md\n`);

  // Step 2: Filter by CLI flags
  let questions = allQuestions;
  if (opts.tier != null) questions = questions.filter(q => q.tier === opts.tier);
  if (opts.question != null) questions = questions.filter(q => q.num === opts.question);

  if (questions.length === 0) {
    console.error("No questions matched the filter.");
    clearTimeout(globalTimer);
    process.exit(1);
  }
  console.log(`Running ${questions.length} question(s)${opts.dryRun ? " [DRY RUN]" : ""}\n`);

  // Step 3: Start MCP server
  const client = new McpTestClient();
  await client.start();
  console.log("MCP server started.\n");

  // Step 4: Discovery phase
  const discovery = await runDiscovery(client);

  // Build tool map with discovered addresses
  const toolMap = buildToolMap(discovery);

  // Step 5: Run each question
  const results = [];

  for (const q of questions) {
    const stars = q.difficulty > 0 ? " " + "\u2B50".repeat(q.difficulty) : "";
    console.log(`--- Q${q.num}: ${q.title} (Tier ${q.tier}${stars}) ---`);

    // 5a: Call tools
    const tools = toolMap[q.num] || [];
    const toolOutputs = [];

    if (tools.length === 0) {
      console.log("  (no tool calls for this question)");
    }

    for (const tc of tools) {
      const argsStr = JSON.stringify(tc.args);
      const shortArgs = argsStr.length > 80 ? argsStr.slice(0, 77) + "..." : argsStr;
      console.log(`  Calling ${tc.tool}(${shortArgs})`);
      try {
        const { text } = await client.callTool(tc.tool, tc.args, TOOL_TIMEOUT_MS);
        // Truncate very long outputs to avoid blowing up Claude context
        const truncated = text.length > 15000 ? text.slice(0, 15000) + "\n\n[... output truncated to 15000 chars ...]" : text;
        toolOutputs.push({ tool: tc.tool, args: tc.args, output: truncated });
      } catch (e) {
        console.log(`    ERROR: ${e.message}`);
        toolOutputs.push({ tool: tc.tool, args: tc.args, output: `ERROR: ${e.message}` });
      }
    }

    // Dry run: skip LLM calls
    if (opts.dryRun) {
      console.log(`  [dry-run] ${toolOutputs.length} tool outputs collected\n`);
      results.push({ question: q, grade: "SKIP", reason: "dry-run mode" });
      continue;
    }

    // 5b: LLM answering step
    const { system: ansSys, user: ansUsr } = buildAnswerPrompt(q, toolOutputs);
    let answer;
    try {
      console.log(`  Answering with ${opts.answerModel}...`);
      answer = await callClaude(ansSys, ansUsr, opts.answerModel, MAX_ANSWER_TOKENS);
      const preview = answer.replace(/\n/g, " ").slice(0, 120);
      console.log(`  Answer: ${preview}...`);
    } catch (e) {
      console.log(`  Answer FAILED: ${e.message}`);
      results.push({ question: q, grade: "ERROR", reason: `Answer failed: ${e.message}` });
      continue;
    }

    // 5c: LLM grading step
    const { system: grdSys, user: grdUsr } = buildGradePrompt(q, answer);
    try {
      console.log(`  Grading with ${opts.gradeModel}...`);
      const gradeResponse = await callClaude(grdSys, grdUsr, opts.gradeModel, MAX_GRADE_TOKENS);
      const gradeResult = parseGrade(gradeResponse);
      const sym = gradeToSymbol(gradeResult.grade);
      console.log(`  Grade: ${sym} ${gradeResult.grade} \u2014 ${gradeResult.reason}`);
      results.push({ question: q, answer, ...gradeResult });
    } catch (e) {
      console.log(`  Grade FAILED: ${e.message}`);
      results.push({ question: q, answer, grade: "ERROR", reason: `Grade failed: ${e.message}` });
    }

    console.log("");

    // Rate limit delay between questions
    if (opts.delay > 0) {
      await new Promise(r => setTimeout(r, opts.delay));
    }
  }

  // Step 6: Summary
  client.stop();
  clearTimeout(globalTimer);

  const duration = Date.now() - startTime;
  printSummary(results, opts, duration);

  // Exit code: fail if any C or F grades
  const hasFailures = results.some(r => r.grade === "C" || r.grade === "F");
  process.exit(hasFailures ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
