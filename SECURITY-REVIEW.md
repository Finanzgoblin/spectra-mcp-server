# Security Code Review — Spectra MCP Server

**Date:** 2026-02-28
**Scope:** Full codebase (`src/`, `package.json`, `tsconfig.json`, `package-lock.json`)

---

## Executive Summary

The codebase demonstrates **strong security practices** overall. Input validation is comprehensive (Zod schemas on every tool), GraphQL injection is properly mitigated, and there are no hardcoded secrets or dangerous code execution patterns. One **HIGH-severity SSRF vulnerability** exists in the user-supplied `rpc_url` parameter, and there are 3 known dependency vulnerabilities (all low/moderate, all fixable).

---

## Findings

### 1. SSRF via User-Supplied `rpc_url` — HIGH

**File:** `src/tools/onchain.ts` (line ~354-416)
**Also affects:** `src/config.ts:257` (`resolveRpcUrl`)

The `rpc_url` parameter is validated with Zod's `.url()` but this only checks URL format. An attacker can supply arbitrary URLs pointing to internal services:

```
get_onchain_activity(
  chain="base",
  pool_address="0x...",
  rpc_url="http://169.254.169.254/latest/meta-data/"  // AWS metadata
)
```

The server will make POST requests to the supplied URL via `fetchBlockNumber()`, `fetchLogs()`, etc.

**Recommendation:**
- Validate the URL hostname against private/reserved IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)
- Or maintain a whitelist of allowed RPC provider domains
- Or resolve DNS first and reject private IPs (prevents DNS rebinding partially)

---

### 2. Dependency Vulnerabilities — LOW/MODERATE

`npm audit` reports 3 vulnerabilities, all fixable via `npm audit fix`:

| Package | Severity | Issue |
|---------|----------|-------|
| **ajv** 7.0.0-alpha.0 – 8.17.1 | Moderate | ReDoS when using `$data` option ([GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6)) |
| **hono** <4.11.10 | Low | Timing comparison hardening in basicAuth/bearerAuth ([GHSA-gq3j-xvxp-8hrf](https://github.com/advisories/GHSA-gq3j-xvxp-8hrf)) |
| **qs** 6.7.0 – 6.14.1 | Low | arrayLimit bypass in comma parsing allows DoS ([GHSA-w7fw-mjwx-w883](https://github.com/advisories/GHSA-w7fw-mjwx-w883)) |

**Recommendation:** Run `npm audit fix` to update affected packages.

---

### 3. `tsconfig.json` — `skipLibCheck: true` — INFO

**File:** `tsconfig.json:10`

`skipLibCheck: true` suppresses type-checking in `node_modules`. While common for build performance, it can mask type errors in dependencies that might indicate subtle bugs or mismatches. Not a direct security vulnerability.

**Status:** Acceptable for this project size.

---

## Areas Reviewed — No Issues Found

### Input Validation — SECURE

All tool parameters are validated via Zod schemas before use:
- EVM addresses: `EVM_ADDRESS` regex (`/^0x[a-fA-F0-9]{40}$/`)
- Chain names: `CHAIN_ENUM` (strict enum)
- Numeric bounds: `.min()` / `.max()` on all integer parameters
- Optional parameters: Explicitly marked with `.optional()`

### GraphQL Injection — MITIGATED

All user input interpolated into GraphQL queries passes through `sanitizeGraphQL()` (`src/api.ts:161-163`), which strips `\`, `"`, newlines, `{}`, `()`, `[]`, and `#`. Applied consistently at:
- `src/api.ts:186` (single PT lookup)
- `src/api.ts:225` (batch PT lookup)
- `src/tools/morpho.ts:78` (symbol filter)
- `src/tools/morpho.ts:193` (market key)

### URL Construction — SECURE

- All API base URLs are hardcoded constants (`SPECTRA_API`, `MORPHO_GRAPHQL`, `PENDLE_API`)
- Path parameters (chain, address) are validated by Zod before URL interpolation
- No path traversal vectors

### Denial of Service — MITIGATED

- Block range scanning capped: `MAX_TOTAL_BLOCK_RANGE = 500_000` blocks
- Lookback capped: `.max(720)` hours
- Morpho batch queries capped: `ptAddresses.slice(0, 200)`
- Result limits bounded: `top_n` capped at 50, activity limits capped at 200
- Multi-chain scans use `Promise.allSettled()` (one chain failure doesn't block others)
- All fetch operations have `AbortSignal.timeout(15_000ms)`

### Sensitive Data — SECURE

- No API keys, tokens, or secrets hardcoded in source
- No `.env` files in the repository
- All API endpoints are public (no auth required)
- Only public contract addresses stored (veSPECTRA, RPC URLs)
- Error messages don't leak sensitive internals

### Code Execution — SECURE

- No `eval()`, `Function()`, `child_process`, `exec()`, or dynamic code execution
- No unsafe deserialization patterns

### Package-Lock Integrity — SECURE

- All 94 packages have SHA-512 integrity hashes
- All packages resolve to `https://registry.npmjs.org` (no non-standard registries)
- No `preinstall`/`postinstall`/`install` lifecycle scripts in any dependency

### Authentication & Access Control — N/A

The MCP server runs over stdio (local IPC) and does not expose network endpoints. Authentication is handled by the MCP client/host. No access control issues within the server itself.

---

## Positive Security Observations

- Consistent Zod validation across all 15+ tool files
- Proper GraphQL sanitization with dedicated `sanitizeGraphQL()` function
- Safe URL construction — no path traversal vectors
- Bounded operations — all loops/arrays have caps
- No hardcoded secrets or sensitive data
- No eval() or Function() usage
- `Promise.allSettled()` for resilience (one failure doesn't cascade)
- Best-effort error handling doesn't expose internal details
- Timeout protection on all fetch operations (`AbortSignal.timeout()`)
- Retry logic with backoff for transient network failures
- Response body truncation in error logs (`raw.slice(0, 80)`)

---

## Recommendations (Priority Order)

1. **[HIGH]** Fix SSRF in `rpc_url` parameter — add private IP range validation or domain whitelist
2. **[LOW]** Run `npm audit fix` to resolve 3 known dependency vulnerabilities
3. **[INFO]** Consider adding rate limiting if the server is ever exposed beyond local stdio
