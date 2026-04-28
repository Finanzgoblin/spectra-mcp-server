/**
 * Scar loading + reinforcement-weighted ranking.
 *
 * Port of Helsinki's `dialectician-lib.mjs:loadScars()` (shipped April 17, 2026).
 * The system's long-term memory should track what keeps being re-taught, not just
 * what was said most recently. Recency × reinforcement weighting selects scars
 * by what the system itself has confirmed as load-bearing through repetition.
 *
 * The weighting formula:
 *
 *   weight = exp(-ageDays / 30) × (1 + log2(1 + reinforceCount))
 *
 * - 30-day recency halflife (a 30-day-old scar is at e^-1 ≈ 0.37 of fresh).
 * - Logarithmic reinforcement dampening (1 reinforcement = ×2, 3 = ×3, 7 = ×4).
 * - A scar reinforced 3+ times from 30+ days ago beats a one-time recent correction.
 *
 * Open emergence: the lens roster of an audit can read the system's accumulated
 * scars and prioritize accordingly. The Diverger's "what would consensus kill?"
 * question runs against the system's history of contradictions, not against the
 * lens's own static categorical apparatus.
 *
 * Dissolution condition: if after three months the top-N weighted scars don't
 * include the most-reinforced ones, the formula is wrong. Revert to recency-only.
 *
 * Source: `Finanzgoblin/soul/scar-weighting-wisdom.md`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Types ---------------------------------------------------------------

export interface Scar {
  /** Stable identifier from frontmatter `name:` (or filename stem if missing). */
  name: string;
  /** One-line description from frontmatter `description:` (empty string if missing). */
  description: string;
  /** Frontmatter `type:` (e.g. "feedback", "project"). Empty if missing. */
  type: string;
  /** Optional pointer to an earlier scar this one reinforces (frontmatter `reinforces:`). */
  reinforces?: string;
  /** Count of OTHER scars whose `reinforces` field names this scar's `name`. */
  reinforceCount: number;
  /** Age in days, derived from frontmatter `date:` if present, else file mtime. */
  ageDays: number;
  /** Computed weight: recency × (1 + log2(1 + reinforceCount)). */
  weight: number;
  /** Full prose body (post-frontmatter). */
  body: string;
  /** Absolute path to the source file. */
  filePath: string;
}

export interface ScarLoadOpts {
  /** Override default memory directory. Falls back to env `SCAR_DIR` then computed default. */
  scarDir?: string;
  /** Limit to top-N scars by weight (default: all). */
  topN?: number;
  /** Filter by frontmatter `type`. Use "all" to disable. Default: "feedback". */
  filterType?: string;
  /** Restrict file scan to filenames matching this prefix (default: "feedback_"). */
  filenamePrefix?: string;
  /** For tests: override "now" timestamp in milliseconds (default: Date.now()). */
  now?: number;
}

// --- Pure helpers --------------------------------------------------------

/**
 * Compute scar weight from age + reinforcement count.
 *
 * Negative inputs are clamped to 0 to avoid pathological values
 * (a future-dated scar shouldn't get weight > 1; a negative reinforcement
 * count is meaningless).
 */
export function computeWeight(ageDays: number, reinforceCount: number): number {
  const safeAge = Math.max(0, ageDays);
  const safeCount = Math.max(0, reinforceCount);
  const recency = Math.exp(-safeAge / 30);
  const reinforcement = 1 + Math.log2(1 + safeCount);
  return recency * reinforcement;
}

/**
 * Parse YAML-ish frontmatter at the top of a markdown file.
 *
 * Supports the simple subset used by terminal feedback files:
 *   ---
 *   key: value
 *   ---
 *   <body>
 *
 * Values are trimmed strings. Quotes around values are preserved (caller must strip).
 * Unknown keys land in the meta dict; nothing is rejected.
 *
 * NOT a full YAML parser — does not handle nested structures, multiline values,
 * or anchors. Sufficient for the current scar format; expand if needed later.
 */
export function parseFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const meta: Record<string, string> = {};
  if (!content.startsWith("---")) {
    return { meta, body: content };
  }
  const lines = content.split(/\r?\n/);
  // Find closing delimiter
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // No closing delimiter: treat as body only
    return { meta, body: content };
  }
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  return { meta, body };
}

/**
 * Resolve the default scar directory.
 *
 * Precedence:
 *   1. Explicit opts.scarDir
 *   2. Env var SCAR_DIR
 *   3. Computed: ${HOME}/.claude/projects/${encoded-cwd}/memory
 *      where encoded-cwd replaces [\\/:] with "-" (Claude Code's project-path encoding).
 *
 * Open emergence note: a different project sets SCAR_DIR. The encoded-cwd
 * default works when the tool runs in-process from the project root.
 */
export function resolveScarDir(opts: ScarLoadOpts = {}): string {
  if (opts.scarDir) return opts.scarDir;
  if (process.env.SCAR_DIR) return process.env.SCAR_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const cwd = process.cwd();
  const encoded = cwd.replace(/[\\/:]/g, "-");
  return join(home, ".claude", "projects", encoded, "memory");
}

// --- Loader --------------------------------------------------------------

/**
 * Load scars from the memory directory, weight them, and return sorted by weight desc.
 *
 * Steps:
 *   1. List files in the scar directory matching `filenamePrefix` (default "feedback_").
 *   2. Read + parse frontmatter for each.
 *   3. Filter by `filterType` (default "feedback"; "all" disables).
 *   4. Compute ageDays from frontmatter `date:` or fall back to file mtime.
 *   5. Compute reinforceCount: count of OTHER scars whose `reinforces` names this scar's `name`.
 *   6. Compute weight via `computeWeight`.
 *   7. Sort by weight desc, optionally truncate to `topN`.
 *
 * Returns empty array (with no throw) if the directory doesn't exist —
 * the consumer can decide whether absence is a degraded state worth flagging.
 */
export async function loadScars(opts: ScarLoadOpts = {}): Promise<Scar[]> {
  const dir = resolveScarDir(opts);
  const filterType = opts.filterType ?? "feedback";
  const prefix = opts.filenamePrefix ?? "feedback_";
  const now = opts.now ?? Date.now();

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    // Directory missing or unreadable — return empty rather than throw.
    return [];
  }

  const candidates = files.filter((f) => f.startsWith(prefix) && f.endsWith(".md"));

  // First pass: read + parse all candidates so reinforceCount can be tallied.
  const parsed: Array<{
    file: string;
    filePath: string;
    meta: Record<string, string>;
    body: string;
    mtimeMs: number;
  }> = [];
  for (const file of candidates) {
    const filePath = join(dir, file);
    let content: string;
    let mtimeMs: number;
    try {
      content = await readFile(filePath, "utf8");
      const st = await stat(filePath);
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // skip unreadable files
    }
    const { meta, body } = parseFrontmatter(content);
    parsed.push({ file, filePath, meta, body, mtimeMs });
  }

  // Filter by type.
  const typed = filterType === "all"
    ? parsed
    : parsed.filter((p) => (p.meta.type ?? "") === filterType);

  // Tally reinforcement counts: any scar whose `reinforces:` matches another's `name`.
  const reinforceCounts = new Map<string, number>();
  for (const p of parsed) {
    const target = p.meta.reinforces;
    if (target) {
      reinforceCounts.set(target, (reinforceCounts.get(target) ?? 0) + 1);
    }
  }

  // Build Scar objects with weights.
  const scars: Scar[] = typed.map((p) => {
    const name = p.meta.name || p.file.replace(/\.md$/, "");
    // Date resolution: explicit `date:` (ISO or yyyy-mm-dd) > file mtime
    let dateMs = p.mtimeMs;
    if (p.meta.date) {
      const parsedDate = Date.parse(p.meta.date);
      if (!Number.isNaN(parsedDate)) dateMs = parsedDate;
    }
    const ageDays = (now - dateMs) / 86400000;
    const reinforceCount = reinforceCounts.get(name) ?? 0;
    return {
      name,
      description: p.meta.description ?? "",
      type: p.meta.type ?? "",
      reinforces: p.meta.reinforces || undefined,
      reinforceCount,
      ageDays,
      weight: computeWeight(ageDays, reinforceCount),
      body: p.body,
      filePath: p.filePath,
    };
  });

  scars.sort((a, b) => b.weight - a.weight);

  if (opts.topN !== undefined && opts.topN > 0) {
    return scars.slice(0, opts.topN);
  }
  return scars;
}
