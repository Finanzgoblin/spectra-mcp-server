# MetaVault MCP - Tool Implementation Guide

**Purpose**: This guide documents the complete patterns for building new MCP tools for the curator-risk-tools team.

**Audience**: Implementers building `morpho_monitor_risk` and related tools.

---

## Table of Contents

1. [Tool Registration Pattern](#tool-registration-pattern)
2. [Zod Schema Pattern](#zod-schema-pattern)
3. [API Call Patterns](#api-call-patterns)
4. [Output Formatting](#output-formatting)
5. [Error Handling](#error-handling)
6. [Type Definitions](#type-definitions)
7. [Working with Morpho Data](#working-with-morpho-data)
8. [Project Integration](#project-integration)

---

## Tool Registration Pattern

### Basic Structure

Every tool file exports a single `register(server)` function that registers one or more tools with the MCP server.

**Example from `morpho.ts`**:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { /* imports */ } from "../config.js";
import { /* imports */ } from "../api.js";
import { /* imports */ } from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "tool_name",
    `Full multi-line description of what the tool does.

    Can include:
    - Protocol context
    - Key concepts
    - Next steps (workflow routing)`,
    {
      // Zod schema for parameters (see next section)
      param1: z.string().describe("Description"),
      param2: z.number().optional().describe("Description"),
    },
    async ({ param1, param2 }) => {
      try {
        // Implementation
        const text = "...";
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // Second tool (optional)
  server.tool("second_tool_name", ...);
}
```

### Registration in `index.ts`

In `src/index.ts`, import and call the register function:

```typescript
import { register as registerCuratorRisk } from "./tools/risk_monitor.js";

// ... later, in main server setup ...
registerCuratorRisk(server);
```

### Return Type Pattern

All tools return an MCP ToolResult:

```typescript
{
  content: [{ type: "text" as const, text: string }],
  isError?: boolean  // true if this is an error response
}
```

**Key points**:
- Always include `type: "text" as const`
- Use plain text for output (markdown formatting is allowed)
- Set `isError: true` for error responses
- No JSON return — format everything as human-readable text

---

## Zod Schema Pattern

### Common Parameter Types

**Chain selection** (required or optional):

```typescript
chain: CHAIN_ENUM.describe("The blockchain network"),
// OR optional:
chain: CHAIN_ENUM.optional().describe("The blockchain network. Omit to scan all chains."),
```

**EVM addresses**:

```typescript
address: EVM_ADDRESS.describe("The wallet address (0x...)"),
// EVM_ADDRESS is pre-defined in config.ts as:
// z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address...")
```

**Numbers with bounds**:

```typescript
capital_usd: z
  .number()
  .gt(0)  // greater than
  .lt(1)  // less than
  .describe("Amount in USD"),

top_n: z
  .number()
  .min(1)
  .max(50)
  .default(10)
  .describe("Number of results (default 10, max 50)"),
```

**Enums**:

```typescript
sort_by: z
  .enum(["supply", "borrow_apy", "utilization"])
  .default("supply")
  .describe("Sort order"),
```

**Optional with defaults**:

```typescript
min_supply_usd: z
  .number()
  .default(0)
  .describe("Minimum supply in USD (default 0)"),

category: z
  .string()
  .max(100)
  .optional()
  .describe("Filter by category"),
```

**Complex patterns** (like Morpho market keys):

```typescript
market_key: z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid Morpho market key")
  .describe("The Morpho market unique key (0x + 64 hex chars)"),
```

### Schema Best Practices

1. **Always describe parameters** — agents need to understand what each parameter does
2. **Use defaults** where sensible — `.default(10)` is better than `.optional()`
3. **Add bounds** — `.min()`, `.max()`, `.gt()`, `.lt()` prevent invalid states
4. **Use enums** — don't accept free-text choices, enumerate them
5. **Reference types** — use `CHAIN_ENUM` and `EVM_ADDRESS` from config.ts, not re-defined regexes

---

## API Call Patterns

### Spectra API Calls

`fetchSpectra(path)` is the main pattern. It's defined in `src/api.ts`:

```typescript
import { fetchSpectra } from "../api.js";

// Example: fetch a specific PT
const ptData = await fetchSpectra(`/${network}/pt/${ptAddress}`);
// Path format: /NETWORK/ENDPOINT
// NETWORK: "ethereum", "base", "arbitrum", etc. (resolved via resolveNetwork())
// ENDPOINT: "pools", "pt/{address}", etc.

// Parse response
const pt = parsePtResponse(ptData);  // handles wrapping
```

### Morpho GraphQL Calls

```typescript
import { fetchMorpho, sanitizeGraphQL, MORPHO_MARKET_FIELDS } from "../api.js";

// Example: query markets
const query = `{
  markets(
    where: {
      search: "${sanitizeGraphQL(userInput)}"  // ALWAYS sanitize user input
      chainId_in: [${chainIds.join(",")}]
    }
    first: ${Math.min(top_n, 50)}
    orderBy: SupplyAssetsUsd
    orderDirection: Desc
  ) {
    items { ${MORPHO_MARKET_FIELDS} }
    pageInfo { count countTotal }
  }
}`;

const data = await fetchMorpho(query);
const items: MorphoMarket[] = data?.markets?.items || [];
```

**Key patterns**:

- `sanitizeGraphQL(str)` escapes quotes and backslashes to prevent injection
- `MORPHO_MARKET_FIELDS` is a pre-built fragment with all standard market fields
- Always use `try/catch` and `Promise.all()` for parallel requests
- Chain IDs come from `MORPHO_CHAIN_IDS` (config.ts)

### Parallel Data Fetching

```typescript
// Good: fetch multiple independent pieces in parallel
const [morphoData, spectraPtAddrs, vaultData] = await Promise.all([
  fetchMorpho(marketQuery),
  fetchSpectraPtAddresses(),
  fetchMorphoVaults(chain),
]);

// Then process the results
```

### Best-Effort Secondary Calls

When fetching secondary data that might fail, wrap in try/catch:

```typescript
// Best-effort: if this fails, core output still works
try {
  const suppliers = await fetchMorphoMarketSuppliers(market_key, morphoId, 5);
  // ... process suppliers ...
} catch {
  // Silently skip — this is secondary enrichment, not core data
}
```

---

## Output Formatting

### Imports

```typescript
import {
  formatUsd,           // $1,234.56
  formatPct,           // 12.34%
  formatDate,          // YYYY-MM-DD
  daysToMaturity,      // integer days
  formatBalance,       // raw BigInt string → number
  formatTokenAmount,   // bigint with decimals → "1,234.5678"
  // ... domain-specific formatters:
  formatMorphoMarketSummary,
  formatMorphoLltv,
  formatMorphoSupplierAnalysis,
  // etc.
} from "../formatters.js";
```

### Text Output Structure

Always organize output with:

1. **Header**: what was found, scope, filters applied
2. **Results**: one item per section, separated by blank lines
3. **Footer**: next steps (workflow routing)

**Example**:

```typescript
const lines: string[] = [];

// Header
lines.push(`Found ${items.length} opportunities (capital: ${formatUsd(capital_usd)}):\n`);

// Results
for (const item of items) {
  lines.push(formatOpportunitySummary(item));
  if (item.hints && item.hints.length > 0) {
    lines.push(item.hints.join("\n"));
  }
  lines.push(""); // blank line between items
}

// Footer
lines.push(`--- Next Steps ---`);
lines.push(`• View rates: morpho_get_rate(chain="${chain}", market_key=KEY)`);
lines.push(`• Model leverage: spectra_get_looping_strategy(chain="${chain}", pt_address=PT_ADDRESS)`);

const text = lines.join("\n");
return { content: [{ type: "text" as const, text }] };
```

### Formatting Primitives

**USD**:
```typescript
formatUsd(1234.56)  // "$1,234.56"
```

**Percentage**:
```typescript
formatPct(12.3456)  // "12.35%"
```

**Dates**:
```typescript
formatDate(timestamp)       // "2026-03-06"
daysToMaturity(timestamp)   // 42
```

**Balances/Amounts**:
```typescript
formatBalance(rawString, decimals)        // string (BigInt) → number
formatTokenAmount(rawBigInt, decimals)    // bigint → "1,234.5678"
```

### Empty Result Handling

When no results are found, return helpful context instead of empty:

```typescript
if (items.length === 0) {
  const lines = [
    `No opportunities found for ${scope}${filter ? ` matching "${filter}"` : ""}.`,
    ``,
    `--- What This Means ---`,
    `Explanation of why nothing was found.`,
    `• Suggestion 1: try a different filter`,
    `• Suggestion 2: consider alternative strategy`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
```

### Compact Output Mode

Some tools support a `compact: boolean` flag. Use compact formatters:

```typescript
export function formatScanOpportunityCompact(opp: ScanOpportunity, rank: number): string {
  const loopTag = opp.looping ? ` | Loop ${formatPct(...)}` : "";
  return `#${rank} ${opp.pt.name} | ${...}${loopTag}`;
}

// Usage:
if (compact) {
  summaries = items.map((item, i) => formatCompact(item, i + 1));
} else {
  summaries = items.map((item) => formatFull(item));
}
```

---

## Error Handling

### Standard Error Pattern

```typescript
try {
  // ... do work ...
} catch (e: any) {
  const text = `Error fetching X: ${e.message}`;
  return { content: [{ type: "text" as const, text }], isError: true };
}
```

### Validation Errors

For known invalid inputs (before API calls):

```typescript
if (!chain) {
  const text = `Morpho is not tracked for ${chain}. Supported: ${Object.keys(MORPHO_CHAIN_IDS).join(", ")}.`;
  return { content: [{ type: "text" as const, text }], isError: true };
}
```

### Best-Effort Graceful Degradation

For secondary enrichment (that shouldn't block primary output):

```typescript
// Best-effort: if this fails, core output still works
let suppliers: MorphoMarketSupplier[] = [];
try {
  suppliers = await fetchMorphoMarketSuppliers(market_key, morphoId, 5);
} catch {
  // Skip silently — this is enrichment, not core
}

// Always include suppliers in output, even if empty
if (suppliers.length > 0) {
  lines.push(`  Suppliers: ${suppliers.length}`);
}
```

---

## Type Definitions

### Where Types Live

- **Spectra types**: `src/types.ts` (SpectraPt, SpectraPool, SpectraMetavault, etc.)
- **Morpho types**: `src/types.ts` (MorphoMarket, MorphoVault, MorphoUserPositions, etc.)
- **Strategy types**: `src/types.ts` (ScanOpportunity, YtArbitrageOpportunity, etc.)

### Key Types for Curator Risk

For the `morpho_monitor_risk` tool, you'll likely need:

```typescript
// From types.ts
export interface MorphoUserMarketPosition {
  market: {
    uniqueKey: string;
    collateralAsset: MorphoAsset | null;
    loanAsset: MorphoAsset;
    lltv: string;  // BigInt string, divide by 1e18
    chain: { id: number; network: string };
  };
  supplyAssets: number;
  supplyAssetsUsd: number;
  borrowAssets: number;
  borrowAssetsUsd: number;
  collateralAssets: number;
  collateralAssetsUsd: number;
  isSpectraPt: boolean;  // tagged if collateral is Spectra PT
  healthFactor?: number; // (collateralUsd * lltv) / borrowUsd
}

export interface MorphoUserVaultPosition {
  vault: { /* vault metadata */ };
  assetsUsd: number;
  shares: number;
}

export interface MorphoUserPositions {
  address: string;
  chain: string;
  chainId: number;
  marketPositions: MorphoUserMarketPosition[];
  vaultPositions: MorphoUserVaultPosition[];
  totals: {
    supplyUsd: number;
    borrowUsd: number;
    collateralUsd: number;
    vaultUsd: number;
    netUsd: number;
  };
}

// MetaVault types
export interface SpectraMetavault {
  address: string;
  name: string;
  // ... curator info, TVL, APY, positions, bridge data, etc.
}
```

### Creating New Types

If you need types that don't exist, add them to `src/types.ts` with documentation:

```typescript
/** Curator risk status with health signals and alerts. */
export interface CuratorRiskMonitor {
  curator: string;        // wallet address
  vault: SpectraMetavault;
  morphoPositions: MorphoUserPositions;
  riskLevel: "GREEN" | "YELLOW" | "RED";
  healthScore: number;    // 0-100, higher is safer
  alerts: CuratorAlert[];
}

export interface CuratorAlert {
  severity: "INFO" | "WARNING" | "CRITICAL";
  category: string;       // "health_factor", "utilization", "rates", etc.
  message: string;
  suggestedAction?: string;
}
```

---

## Working with Morpho Data

### Fetching Morpho Positions

Use the `fetchMorphoUserPositions()` helper in `api.ts`:

```typescript
import { fetchMorphoUserPositions } from "../api.js";

const raw = await fetchMorphoUserPositions(address, morphoChainId);

// raw contains:
// - marketPositions: array of user's lending/borrowing positions
// - vaultPositions: array of vault deposits
```

### Calculating Health Factors

```typescript
// Health factor = (collateral USD * LLTV) / borrow USD
// < 1.0 = liquidatable
// < 1.3 = dangerously close

import { formatMorphoLltv } from "../formatters.js";

const lltv = formatMorphoLltv(market.lltv);  // convert BigInt string to decimal
const healthFactor = borrowUsd > 0.01
  ? (collateralUsd * lltv) / borrowUsd
  : undefined;

// Flag danger zones
if (healthFactor && healthFactor < 1.3) {
  warnings.push(`⚠️ Health factor: ${healthFactor.toFixed(2)} (liquidatable at 1.0)`);
}
```

### Spread Analysis (PT yield vs borrow rate)

```typescript
// Spread = PT implied APY - Morpho borrow rate
// Positive = looping is profitable
// Negative = borrowing costs exceed yield

const ptData = await fetchSpectra(`/${network}/pt/${ptAddress}`);
const pt = parsePtResponse(ptData);
const impliedApy = pt?.pools?.[0]?.impliedApy || 0;

const borrowApy = market.state?.borrowApy || 0;
const spread = impliedApy - borrowApy * 100;

if (spread > 0) {
  console.log(`✓ Looping is profitable: ${formatPct(spread)} spread`);
} else {
  console.log(`✗ Looping is unprofitable: ${formatPct(spread)} spread`);
}
```

### Querying Market Suppliers

```typescript
import { fetchMorphoMarketSuppliers } from "../api.js";

const suppliers = await fetchMorphoMarketSuppliers(market_key, morphoChainId, top_n);
// Returns: array of { address, supplyAssetsUsd, borrowAssetsUsd, isVault, vaultName?, ... }

// Identify loopers (both collateral and borrows)
const loopers = suppliers.filter(s => s.collateralUsd > 0 && s.borrowAssetsUsd > 0);
```

---

## Project Integration

### File Structure

```
src/
├── index.ts                           # Main server + tool registration
├── config.ts                          # Chains, constants, Zod schemas
├── types.ts                           # All TypeScript interfaces
├── api.ts                             # API call helpers (Spectra, Morpho, etc.)
├── formatters.ts                      # Text formatting functions
├── tools/
│   ├── morpho.ts                      # Morpho tools (6 tools)
│   ├── metavault.ts                   # MetaVault tools (3 tools)
│   ├── pt.ts                          # PT & pool discovery (4 tools)
│   ├── portfolio.ts                   # User positions (1 tool)
│   ├── pool.ts                        # Pool activity (3 tools)
│   ├── risk_monitor.ts        # [NEW] Your tool file
│   └── ...
└── CLAUDE.md                          # Project-specific instructions
```

### Building `risk_monitor.ts`

**Filename**: `src/tools/risk_monitor.ts`

**Template**:

```typescript
/**
 * Tools: morpho_monitor_risk, curator_health_snapshot
 *
 * morpho_monitor_risk — Analyzes curator wallet Morpho positions + MetaVault
 * holdings to compute risk metrics and alert on dangerous states.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHAIN_ENUM, EVM_ADDRESS, resolveNetwork, MORPHO_CHAIN_IDS } from "../config.js";
import type { /* needed types */ } from "../types.js";
import {
  fetchMorphoUserPositions,
  fetchMetavaults,
  /* other helpers */
} from "../api.js";
import {
  formatUsd,
  formatPct,
  /* other formatters */
} from "../formatters.js";

export function register(server: McpServer): void {
  server.tool(
    "morpho_monitor_risk",
    `Analyze a curator's risk profile...`,
    {
      curator_address: EVM_ADDRESS.describe("The curator's wallet address (0x...)"),
      metavault_address: EVM_ADDRESS.optional().describe("Optional: specific MetaVault to analyze"),
      chain: CHAIN_ENUM.optional().describe("Optional: specific chain to scan"),
    },
    async ({ curator_address, metavault_address, chain }) => {
      try {
        // Fetch data in parallel
        const [morphoPos, metavaults] = await Promise.all([
          fetchMorphoUserPositions(curator_address, morphoChainId),
          metavault_address ? fetchMetavault(metavault_address) : [],
        ]);

        // Compute risk metrics
        const riskLevel = computeRiskLevel(morphoPos);
        const alerts = generateAlerts(morphoPos);

        // Format output
        const lines = [
          `== Curator Risk Monitor ==`,
          `Address: ${curator_address}`,
          `Risk Level: ${riskLevel}`,
          ``,
          `--- Alerts ---`,
          ...alerts.map(a => `⚠️  ${a.message}`),
        ];

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}

// Helper functions (defined below server.tool calls)
function computeRiskLevel(pos: MorphoUserPositions): string {
  // ... implementation
}

function generateAlerts(pos: MorphoUserPositions): Alert[] {
  // ... implementation
}
```

### Register in `index.ts`

```typescript
import { register as registerCuratorRisk } from "./tools/risk_monitor.js";

// ... in main() ...
registerCuratorRisk(server);  // Add this line
```

### Run Tests

```bash
# Compile TypeScript
npx tsc --noEmit

# Run integration tests (if morpho_monitor_risk is included)
npm test

# Run unit tests
npm run test:unit

# Build MCP server
npm run build
```

---

## Checklist for New Tools

- [ ] **File created**: `src/tools/risk_monitor.ts`
- [ ] **Export `register(server)`**: single function, no default export
- [ ] **Zod schemas**: all parameters validated with `.describe()` for agents
- [ ] **Try/catch**: all async operations wrapped
- [ ] **Parallel fetching**: independent API calls use `Promise.all()`
- [ ] **Formatters**: use existing functions, no hardcoded formatting
- [ ] **Empty results**: helpful context when no data found
- [ ] **Types defined**: new types added to `src/types.ts` if needed
- [ ] **Imports added**: register function called in `src/index.ts`
- [ ] **TypeScript compiles**: `npx tsc --noEmit` passes
- [ ] **Next steps included**: footer with workflow routing suggestions
- [ ] **Error messages**: human-readable, not stack traces

---

## Common Gotchas

### 1. **Morpho Chain IDs**
Not all Spectra chains have Morpho markets. Check `MORPHO_CHAIN_IDS` in config.ts.

```typescript
const morphoId = MORPHO_CHAIN_IDS[network];
if (!morphoId) {
  return { content: [{ type: "text" as const, text: "No Morpho on this chain" }], isError: true };
}
```

### 2. **BigInt String Conversion**
Morpho returns large numbers as BigInt strings. Use helpers:

```typescript
import { formatBalance, formatMorphoLltv } from "../formatters.js";

const lltv = formatMorphoLltv(market.lltv);  // "9223372036854775807" → 0.86
```

### 3. **GraphQL Injection**
Always sanitize user input in GraphQL:

```typescript
import { sanitizeGraphQL } from "../api.js";

const search = `PT-${sanitizeGraphQL(userFilter)}`;  // prevents injection
```

### 4. **Router-Mediated Transactions**
When analyzing pool activity, remember most Spectra operations go through the Router. Use `spectra_get_pool_activity` (API-based, resolves Router) instead of raw RPC calls for user-specific activity.

### 5. **Expired Pools**
The Spectra API only returns active pools. For matured positions, use `spectra_get_address_activity` or `spectra_get_portfolio` which fetch the portfolio endpoint.

### 6. **Async/Await**
All tool handlers are `async`. Use `await` for API calls, never `.then()`.

```typescript
async ({ param1 }) => {
  const data = await fetchSpectra(`/path`);  // good
  // NOT: fetchSpectra(...).then(...)
}
```

---

## References

- **CLAUDE.md**: Project-specific instructions (Router mechanics, expired pools, etc.)
- **config.ts**: All chain/endpoint constants, Zod schemas
- **formatters.ts**: All text formatting helpers
- **api.ts**: All API call helpers (Spectra, Morpho, Pendle, Merkl)
- **types.ts**: All TypeScript interfaces
- **morpho.ts**: Reference implementation (6 tools, complex queries, parallel fetching)
- **metavault.ts**: Reference for MetaVault + Morpho integration
