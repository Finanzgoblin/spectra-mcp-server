/**
 * Tool: mv_load_scars
 *
 * Exposes the system's accumulated learned-corrections (scars) to any agent
 * that wants to ground its reasoning in what the system has been re-taught.
 *
 * Designed for: substrate-diverse audit lenses (Builder, Breaker, Connector,
 * Inverter, Diverger). The Diverger's "what would consensus kill?" question
 * gets meaningfully sharper when it's reading the system's own history of
 * contradictions, not just the diff in front of it.
 *
 * Background: ports Helsinki's `dialectician-lib.mjs:loadScars()` (April 17,
 * 2026). The weighting `exp(-ageDays/30) × (1 + log2(1 + reinforceCount))`
 * makes load-bearing lessons stay alive based on how often they keep
 * being re-taught — not on how recently they were last said.
 *
 * Architectural note: this tool was added in response to the
 * hardcode-vs-generalize scar (April 27, 2026) — a 6-times-firing pattern that
 * the substrate-diverse 5-lens audit method missed across 5 phases because the
 * Diverger wasn't reading the active scar list. With this tool, lens prompts
 * can call `mv_load_scars` and incorporate the weighted scar list into their
 * audit. The fix is a port, not a new mechanism.
 *
 * Spec source: `~/soul/scar-weighting-wisdom.md`
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadScars, resolveScarDir, type Scar } from "../scars.js";

/**
 * Format one scar as a markdown section for tool output.
 *
 * The header line has all the metadata needed to act on the scar without
 * reading the body. Body is included only when explicitly requested
 * (it can be long, and most callers want the cue, not the full text).
 */
function formatScar(scar: Scar, opts: { includeBody: boolean }): string {
  const ageStr = scar.ageDays < 1
    ? "today"
    : scar.ageDays < 2
      ? "1d ago"
      : `${Math.round(scar.ageDays)}d ago`;
  const reinforceStr = scar.reinforceCount > 0
    ? `, reinforced ${scar.reinforceCount}×`
    : "";
  const reinforcesStr = scar.reinforces ? `, reinforces: ${scar.reinforces}` : "";

  const header = `### ${scar.name}  [weight: ${scar.weight.toFixed(3)}, age: ${ageStr}${reinforceStr}${reinforcesStr}]`;
  const desc = scar.description ? `\n${scar.description}` : "";
  const body = opts.includeBody && scar.body
    ? `\n\n${scar.body.trim()}`
    : "";
  return `${header}${desc}${body}`;
}

/**
 * Render the loaded scar list as a single markdown text block.
 *
 * Empty result is itself signal — the audit can decide whether the
 * absence of scars means "fresh slate" or "memory directory unreachable."
 * We surface the resolved directory path in the empty case so the caller
 * can debug a config issue.
 */
function renderScars(scars: Scar[], opts: { includeBody: boolean; resolvedDir: string }): string {
  if (scars.length === 0) {
    return `No scars loaded. Resolved directory: ${opts.resolvedDir}\n\nIf this is unexpected, set the SCAR_DIR environment variable to the memory directory containing feedback_*.md files, or pass scar_dir explicitly.`;
  }
  const lines: string[] = [
    `# Scars (${scars.length}, ranked by weight)`,
    "",
    `Weighting: \`exp(-ageDays/30) × (1 + log2(1 + reinforceCount))\``,
    "",
  ];
  for (const scar of scars) {
    lines.push(formatScar(scar, opts));
    lines.push("");
  }
  return lines.join("\n");
}

export function register(server: McpServer): void {
  server.tool(
    "mv_load_scars",
    `Load the system's accumulated scars (corrective lessons), weighted by recency × reinforcement.

Use this in audit lenses to ground reasoning in what the system has been re-taught.
Most useful for the Diverger lens: "what would consensus kill?" sharpens significantly
when read against the system's own history of contradictions.

Weighting formula: weight = exp(-ageDays/30) × (1 + log2(1 + reinforceCount))
- 30-day recency halflife.
- Logarithmic dampening on reinforcement (1 = ×2, 3 = ×3, 7 = ×4).
- A scar reinforced 3+ times from 30+ days ago beats a one-time recent correction.

Scar source: feedback_*.md files in the memory directory. Each file's frontmatter:
  ---
  name: <stable-id>
  description: <one-liner>
  type: feedback
  reinforces: <name-of-earlier-scar>   # optional; absent = independent
  date: <yyyy-mm-dd or ISO>            # optional; absent = falls back to file mtime
  ---

Default directory:
  \${HOME}/.claude/projects/\${encoded-cwd}/memory
Override via SCAR_DIR env var or scar_dir param.`,
    {
      top_n: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Limit to top N scars by weight. Omit for all."),
      include_body: z
        .boolean()
        .optional()
        .describe("Include full prose body of each scar. Default false (header + description only)."),
      filter_type: z
        .string()
        .optional()
        .describe(`Filter by frontmatter \`type:\` field. Default "feedback". Use "all" to disable.`),
      scar_dir: z
        .string()
        .optional()
        .describe("Override the scar directory. Falls back to SCAR_DIR env var, then computed default."),
    },
    async ({ top_n, include_body, filter_type, scar_dir }) => {
      try {
        const opts = {
          topN: top_n,
          includeBody: include_body ?? false,
          filterType: filter_type,
          scarDir: scar_dir,
        };
        const scars = await loadScars(opts);
        const resolvedDir = resolveScarDir(opts);
        const text = renderScars(scars, {
          includeBody: opts.includeBody,
          resolvedDir,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error loading scars: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );
}
