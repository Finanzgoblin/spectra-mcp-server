# Codebase Coherence Audit

**Date:** 2026-03-08
**Scope:** Full codebase — tool registrations, shared modules, cross-tool patterns, types, documentation accuracy, TypeScript safety

---

## Executive Summary

The MetaVault MCP codebase is **well-structured and highly coherent** overall. The dynamic tool loader (`tool_loader.ts`) eliminates registration boilerplate, all 50 tools are properly registered and match their documentation, and shared modules enforce consistent patterns. Security posture is strong (GraphQL sanitization, no raw `eval`/`exec`, validated inputs).

The audit identified **no critical bugs** but found documentation inaccuracies in CLAUDE.md, dead code (unused formatters/types/exports), and minor inconsistencies worth cleaning up.

---

## Findings

### 1. DOCUMENTATION INACCURACIES (CLAUDE.md)

#### 1a. Wrong API base URL
**File:** `CLAUDE.md:101`
**Issue:** States `Spectra API base: https://app.spectra.finance/api/v1/` but `fetchSpectra()` uses `SPECTRA_API` = `https://api.spectra.finance/v1` (from `config.ts:19-20`). The `app.spectra.finance` URL is used by the *secondary* function `fetchSpectraAppNumber()` for app-specific numeric endpoints.
**Fix:** Change to `https://api.spectra.finance/v1` (the primary API base) and note the app API separately if needed.

#### 1b. Misleading network names list
**File:** `CLAUDE.md:102`
**Issue:** States `Network names in API: ethereum, base, arbitrum, ...` but the API actually uses `mainnet`, not `ethereum`. The `resolveNetwork()` function maps the user-facing `ethereum` alias to `mainnet` before API calls. `API_NETWORKS` explicitly filters out `ethereum` to avoid double-counting.
**Fix:** Change `ethereum` to `mainnet` in the network list, and note that `ethereum` is a user-facing alias resolved by `resolveNetwork()`.

### 2. DEAD CODE — UNUSED EXPORTS

#### 2a. Unused type: `BorrowRateAnalysis`
**File:** `src/types.ts:815`
**Issue:** `export interface BorrowRateAnalysis` is defined but never referenced anywhere — not in types.ts itself, not in any tool, not in any test.
**Severity:** Low (dead code)

#### 2b. Unused formatters (6 functions)
**File:** `src/formatters.ts`
**Functions never imported by any tool or test:**
- `computeReallocatableUsd` — defined but never used anywhere
- `formatMorphoVaultAllocationEnriched` — defined but never used anywhere
- `formatYtArbitrageOpportunity` — defined but never used anywhere (note: `formatYtArbCompact` IS used)
- `formatMetavaultSummary` — defined but never used anywhere
- `formatMetavaultCompact` — defined but never used anywhere
- `formatMetavaultScanEntry` — defined but never used anywhere

**Functions used only in test files (not in actual tools):**
- `computeLpApyAtBoost` — tested in `formatters.test.ts` but never called by any tool
- `formatLpApyLines` — tested in `formatters.test.ts` but never called by any tool

**Severity:** Low (code bloat, maintenance burden)

#### 2c. Unnecessarily exported API functions
**File:** `src/api.ts`
- `extractPoolAddressFromReasonKey` (line 2143) — exported but only used internally within `api.ts` (by `parseMerklRewards`)
- `parseWei` (line 2154) — exported but only used internally within `api.ts`

**Severity:** Cosmetic (unnecessary `export` keyword; functions work fine)

#### 2d. Unnecessarily exported config constants
**File:** `src/config.ts`
- `SPECTRA_BASE` (line 19) — exported but never imported elsewhere (only used to derive `SPECTRA_API` in the same file)
- `SPECTRA_APP_BASE` (line 22) — exported but never imported elsewhere (only used to derive `SPECTRA_APP_API`)
- `CONFIG_VERIFIED_DATES` (line 346) — exported but only used internally by `checkConfigStaleness()`

**Severity:** Cosmetic

### 3. MINOR CODE ISSUES

#### 3a. Dead logic in risk_monitor.ts
**File:** `src/tools/risk_monitor.ts:61`
```typescript
const hasKey = Object.keys(MORPHO_CHAIN_IDS).some(
  (k) => k === chain || k === (chain === "mainnet" ? "ethereum" : chain),
);
```
**Issue:** The second condition `k === (chain === "mainnet" ? "ethereum" : chain)` tries to find key `"ethereum"` in `MORPHO_CHAIN_IDS` when chain is `"mainnet"`. But `MORPHO_CHAIN_IDS` uses `mainnet` as a key, not `ethereum`. The first condition `k === chain` already catches `mainnet`. The second condition is dead code and misleading — it suggests `MORPHO_CHAIN_IDS` might have an `ethereum` key, which it doesn't.
**Fix:** Simplify to `MORPHO_CHAIN_IDS.hasOwnProperty(chain)` or use `resolveNetwork(chain)` first.

#### 3b. Redundant `resolveNetwork()` calls in some tools
**Files:** `capacity.ts`, `ibt_health.ts`, `looping.ts`, `pool.ts`, `portfolio.ts`, `pt.ts`, `quote.ts`, `simulate.ts`, `strategy.ts`, `ve.ts`, `yt_arb.ts`
**Issue:** These tools call `resolveNetwork(chain)` before passing the chain to API functions from `api.ts`. But the API functions (`fetchSpectra`, `fetchMetavaults`, `scanAllChainPools`, etc.) already call `resolveNetwork()` internally. The double resolution is harmless (idempotent) but creates inconsistency — some tools resolve, others don't.
**Severity:** Cosmetic (no functional impact). The centralized approach (API functions resolve internally) is the better pattern. Tools that resolve manually do redundant work.

### 4. TYPESCRIPT TYPE SAFETY

**323 TypeScript errors** (with `--noEmit`), broken into categories:
- **229 × TS7031** (`Binding element implicitly has 'any' type`) — handler parameter destructuring in all tool files lacks explicit types. This is because the MCP SDK's `server.tool()` doesn't propagate Zod schema types to the handler callback. Functional but loses type safety inside handlers.
- **82 × TS2307** (`Cannot find module`) — all from missing `node_modules/` (uninstalled dependencies: `@modelcontextprotocol/sdk`, `zod`, `@types/node`). Not an actual code issue.
- **10 × TS2580** (`Cannot find name 'process'`) — consequence of missing `@types/node`.
- **2 × TS7006** (`Parameter implicitly has 'any' type`) — `uri` params in `server.resource()` callbacks in `index.ts`.

**Severity:** The TS7031 errors (229) represent a real type safety gap. All tool handler parameters are implicitly `any`, meaning typos or wrong property accesses inside handlers won't be caught by the compiler. This is a systemic pattern, not a bug — the MCP SDK doesn't infer Zod types into handlers.

### 5. COHERENCE POSITIVES (What's Working Well)

- **Tool registration:** All 36 tool files export `register()`. All 50 tools register successfully via dynamic discovery. Zero mismatches between registered names and `index.ts` documentation.
- **Naming conventions:** All tool names follow the prefix convention (`spectra_`, `morpho_`, `pendle_`, `mv_`). All user-facing parameters use `snake_case` consistently.
- **Shared module usage:** No tools use raw `fetch()` — all go through `fetchSpectra()`, `fetchPendle()`, or `fetchMorpho()`. GraphQL inputs are sanitized via `sanitizeGraphQL()`.
- **Security:** No `eval()`, `exec()`, or injection vectors found. Input validation via Zod schemas on all tool parameters.
- **Error handling:** All tools (except `context.ts`, which returns static text) use `isError: true` for error responses.
- **Version consistency:** `package.json` and `index.ts` both report `2.0.0`.
- **No TODOs/FIXMEs:** The codebase has zero leftover TODO or FIXME comments.
- **Cross-tool imports verified:** `simulate.ts` correctly imports `tryOnChainQuote` from `quote.ts`. `curator_scan.ts` imports from both Spectra and Pendle sources.
- **Chain alias handling:** `resolveNetwork("ethereum") → "mainnet"` is properly centralized in `config.ts` and applied in API functions.

### 6. STRUCTURAL OBSERVATIONS

#### 6a. Large file sizes
- `formatters.ts`: 180KB (2,851+ exported functions) — very large for a single module
- `api.ts`: 86KB — contains all API clients (Spectra, Morpho, Pendle, Merkl, RPC) in one file
- `pool.ts`: 54KB — 3 tools in one file
- `morpho.ts`: 42KB — 6 tools in one file

These aren't bugs but could benefit from decomposition for maintainability.

#### 6b. Test infrastructure
- Unit tests (`*.test.ts`) exist for `api.ts`, `config.ts`, and `formatters.ts`
- No unit tests for individual tool files in `src/tools/`
- Integration tests in `test.cjs` and agent tests in `test-agent.cjs` cover tool behavior end-to-end
- Subjective tests in `test-subjective.cjs` provide LLM-graded quality assessment

---

## Recommendations (Priority Order)

1. **Fix CLAUDE.md inaccuracies** (1a, 1b) — these actively mislead agents/developers
2. **Remove dead formatters** (2b) — 6 functions that no tool uses; reduces maintenance burden
3. **Simplify risk_monitor.ts dead logic** (3a) — misleading condition
4. **Remove orphaned `BorrowRateAnalysis` type** (2a)
5. **Consider un-exporting internal-only functions** (2c, 2d) — tighter API surface
6. **Long-term: Add explicit handler types** (4) — addresses the 229 TS7031 errors

---

*Audit performed against commit on branch `claude/codebase-coherence-audit-tfvtt`*
