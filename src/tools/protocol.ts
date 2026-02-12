/**
 * Tools: get_protocol_stats, get_supported_chains
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SUPPORTED_CHAINS, API_NETWORKS, PROTOCOL_CONSTANTS } from "../config.js";
import { fetchSpectraAppNumber } from "../api.js";
import { formatPct } from "../formatters.js";

export function register(server: McpServer): void {
  // ===========================================================================
  // get_protocol_stats
  // ===========================================================================

  server.tool(
    "get_protocol_stats",
    `Get Spectra protocol-wide statistics: SPECTRA token supply, circulating supply,
current weekly emissions, rebase formula, and general protocol info.
Use this for questions about SPECTRA tokenomics or protocol health.

Protocol context:
- Rebase distributes additional SPECTRA to veSPECTRA holders. The formula is highly
  non-linear: (veSPECTRA/totalSPECTRA)^3. At 10% lock rate, rebase captures ~0.1% of
  emissions. At 50% lock rate, rebase captures ~12.5%. This incentivizes high ve
  participation.
- Weekly emissions decay exponentially and eventually stabilize.
- Gauge emissions boost LP APY across all pools (see LP APY breakdown in pool tools).

Use get_ve_info for live veSPECTRA data and boost calculations.`,
    {},
    async () => {
      try {
        const [circulating, total] = await Promise.all([
          fetchSpectraAppNumber("/spectra/circulating-supply"),
          fetchSpectraAppNumber("/spectra/total-supply"),
        ]);

        const lockRate = total > 0 ? ((total - circulating) / total * 100) : 0;

        const { emissions, fees, governance } = PROTOCOL_CONSTANTS;
        const epochStart = new Date(emissions.epochStart).getTime();
        const now = Date.now();
        const weeksSinceStart = Math.floor((now - epochStart) / (7 * 24 * 60 * 60 * 1000));
        const weeklyEmissions = emissions.base * Math.pow(emissions.decay, emissions.offset + weeksSinceStart);

        const lines = [
          `-- Spectra Protocol Stats --`,
          ``,
          `  SPECTRA Token:`,
          `    Circulating Supply: ${circulating.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
          `    Total Supply: ${total.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
          `    Max Supply: ${PROTOCOL_CONSTANTS.maxSupply.toLocaleString("en-US")}`,
          `    Effective Lock Rate: ${formatPct(lockRate)}`,
          ``,
          `  Emissions:`,
          `    Current Week (#${weeksSinceStart}): ${weeklyEmissions.toLocaleString("en-US", { maximumFractionDigits: 0 })} SPECTRA`,
          `    Formula: ${emissions.base.toLocaleString()} x ${emissions.decay}^(${emissions.offset} + week)`,
          `    Stabilizes at: ${emissions.stabilizesAt}`,
          ``,
          `  Rebase Formula:`,
          `    (veSPECTRA.totalSupply / SPECTRA.totalSupply)^3 x 0.5 x weekly emissions`,
          ``,
          `  Fee Distribution (SGP-6):`,
          `    ${fees.swapToVoters * 100}% swap fees -> veSPECTRA voters`,
          `    ${fees.swapToLPs * 100}% swap fees -> LPs`,
          `    ${fees.swapToCurve * 100}% swap fees -> Curve DAO`,
          `    ${fees.ytToTreasury * 100}% YT fees -> DAO Treasury (in ETH)`,
          ``,
          `  Governance: ${governance.model}`,
          `  Lock: Up to ${governance.maxLock}, max ${governance.maxBoost}`,
          `  Gauge Epochs: ${governance.gaugeEpoch}`,
          ``,
          `  Links:`,
          `    App: https://app.spectra.finance`,
          `    Docs: https://docs.spectra.finance`,
          `    Governance: https://gov.spectra.finance`,
        ];

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        const text = `Error fetching protocol stats: ${e.message}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    }
  );

  // ===========================================================================
  // get_supported_chains
  // ===========================================================================

  server.tool(
    "get_supported_chains",
    `List all blockchain networks supported by Spectra Finance.
Use this as a starting point to discover what's available.

Not all chains have identical feature coverage. Morpho looping markets currently exist
on mainnet, base, arbitrum, and katana. veSPECTRA governance lives on Base.`,
    {},
    async () => {
      const lines = [
        `Spectra Finance -- Supported Chains:`,
        ``,
        ...API_NETWORKS.map(
          (key) => `  * ${SUPPORTED_CHAINS[key].name} (chain ID: ${SUPPORTED_CHAINS[key].id}) -- use "${key}" in queries`
        ),
        ``,
        `  Tip: "ethereum" is also accepted as an alias for "mainnet".`,
        ``,
        `Tip: Use get_best_fixed_yields to scan all chains at once (raw APY ranking),`,
        `or scan_opportunities for capital-aware analysis with price impact and looping.`,
        `Use list_pools with a specific chain to see available pools.`,
      ];

      const text = lines.join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
