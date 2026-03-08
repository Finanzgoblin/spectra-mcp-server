/**
 * Dynamic tool auto-discovery — replaces manual import/register boilerplate.
 *
 * Scans the `tools/` directory for .js files at startup, imports each module,
 * and calls its `register(server)` export. New tools are picked up automatically
 * after rebuild — no edits to index.ts required.
 *
 * Convention: each file in src/tools/ must export `register(server: McpServer)`.
 * Files without a `register` export are skipped with a warning.
 * Test files (*.test.ts) are excluded.
 */

import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function discoverAndRegisterTools(server: McpServer): Promise<void> {
  const toolsDir = join(__dirname, "tools");
  let files: string[];

  try {
    files = await readdir(toolsDir);
  } catch (err) {
    console.error(`[tool-loader] Failed to read tools directory: ${err}`);
    return;
  }

  // Only .js files (compiled from .ts), exclude tests
  const toolFiles = files
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .sort(); // deterministic registration order

  let registered = 0;
  const skipped: string[] = [];

  for (const file of toolFiles) {
    try {
      const modulePath = join(toolsDir, file);
      const mod = await import(pathToFileURL(modulePath).href);

      if (typeof mod.register === "function") {
        mod.register(server);
        registered++;
      } else {
        skipped.push(file);
      }
    } catch (err) {
      console.error(`[tool-loader] Failed to load ${file}: ${err}`);
    }
  }

  console.error(`[tool-loader] Registered ${registered} tool modules` +
    (skipped.length > 0 ? ` (skipped ${skipped.length} without register export: ${skipped.join(", ")})` : ""));
}
