/**
 * Tool: spectra_get_gauge_votes
 *
 * Unlocks the 95% of governance/voting-incentives data we were throwing away.
 * Shows where veSPECTRA votes go, what bribes exist, SPECTRA emissions per pool,
 * and voting APRs. Essential for veSPECTRA strategy.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchSpectra } from "../api.js";
import { formatPct, formatUsd } from "../formatters.js";

interface GaugeEntry {
  address: string;
  chainId: number;
  symbol: string;
  maturity: string;
  votes: string;
  votingApr: { rewards: number; fees: number; total: number };
  votingRewards: Array<{
    address: string;
    symbol: string;
    amount: string;
    price: number;
    value: number;
  }>;
  totalVotingRewards: number;
  votingFees: Array<{
    address: string;
    symbol: string;
    amount: string;
    price: number;
    value: number;
  }>;
  totalVotingFees: number;
  lpIncentives: {
    symbol: string;
    amount: string;
    price: number;
    value: number;
  };
  votingFeesAddress: string;
  votingRewardsAddress: string;
}

interface GovernanceResponse {
  block: { timestamp: number; number: number };
  totalVotingPower: string;
  totalVotes: string;
  totalEmissions: { amount: string; value: number };
  avgVotingApr: { rewards: number; fees: number; total: number };
  totalVotingFees: number;
  totalVotingRewards: number;
  reduceIncentives: { symbol: string; price: number; value: number };
  data: GaugeEntry[];
}

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum", 8453: "Base", 42161: "Arbitrum", 10: "Optimism",
  43114: "Avalanche", 146: "Sonic", 14: "Flare", 56: "BSC",
};

function parseVotes(v: string): number {
  try { return parseFloat(v) / 1e18; } catch { return 0; }
}

export function register(server: McpServer): void {
  server.tool(
    "spectra_get_gauge_votes",
    `Full veSPECTRA governance dashboard: gauge vote distribution, voting APRs,
bribe incentives, and SPECTRA emissions per pool.

Shows where veSPECTRA holders direct their votes, what rewards they earn for
voting, and how SPECTRA emissions are distributed across pools. Essential for:
- Deciding where to direct veSPECTRA votes for maximum return
- Finding pools with active bribe markets (voting incentives)
- Understanding emission concentration and governance dynamics
- Evaluating bribe efficiency ($ per vote)

The voting APR is what veSPECTRA holders earn by directing votes to a gauge:
  voting APR = (voting rewards + swap fees) / vote value

Bribe efficiency = total voting rewards / total votes (in $).
Higher efficiency = more reward per unit of voting power directed.

Use spectra_get_ve_info for your personal boost calculation.
Use spectra_list_pools to see the pools behind these gauges.
Use spectra_list_expiring_pools to check gauge status for expiring pools.`,
    {
      sort_by: z.enum(["votes", "voting_apr", "emissions", "bribes"]).default("votes").describe(
        "Sort gauges by: votes (total voting power), voting_apr (voter return), emissions (SPECTRA directed), bribes (voting rewards value). Default: votes."
      ),
      top_n: z.number().int().min(1).max(100).default(20).describe(
        "Number of gauges to show (default 20, max 100)."
      ),
      chain_filter: z.number().int().optional().describe(
        "Filter to a specific chain ID (e.g., 1 for Ethereum, 8453 for Base). Omit for all chains."
      ),
      min_votes: z.number().default(0).describe(
        "Minimum votes (in SPECTRA, not wei) to include. Default 0."
      ),
    },
    async ({ sort_by, top_n, chain_filter, min_votes }) => {
      try {
        const rawArr = await fetchSpectra("/governance/voting-incentives") as any;

        // The endpoint returns an array of epochs, newest last. Use the latest epoch.
        const raw: GovernanceResponse | undefined = Array.isArray(rawArr) ? rawArr[rawArr.length - 1] : rawArr;
        if (!raw || !Array.isArray(raw.data)) {
          return { content: [{ type: "text" as const, text: "Governance voting-incentives endpoint returned no data." }] };
        }

        // Parse and filter gauges
        let gauges = raw.data.map((g) => ({
          ...g,
          votesNum: parseVotes(g.votes),
        }));

        if (chain_filter !== undefined) {
          gauges = gauges.filter((g) => g.chainId === chain_filter);
        }
        if (min_votes > 0) {
          gauges = gauges.filter((g) => g.votesNum >= min_votes);
        }

        // Sort
        switch (sort_by) {
          case "voting_apr":
            gauges.sort((a, b) => (b.votingApr?.total || 0) - (a.votingApr?.total || 0));
            break;
          case "emissions":
            gauges.sort((a, b) => (b.lpIncentives?.value || 0) - (a.lpIncentives?.value || 0));
            break;
          case "bribes":
            gauges.sort((a, b) => (b.totalVotingRewards || 0) - (a.totalVotingRewards || 0));
            break;
          default: // votes
            gauges.sort((a, b) => b.votesNum - a.votesNum);
        }

        const shown = gauges.slice(0, top_n);

        // Protocol-level stats
        const totalVotingPower = parseVotes(raw.totalVotingPower);
        const totalVotes = parseVotes(raw.totalVotes);
        const participation = totalVotingPower > 0 ? (totalVotes / totalVotingPower) * 100 : 0;
        const snapshotDate = new Date(raw.block.timestamp * 1000).toISOString().split("T")[0];

        const lines: string[] = [];
        lines.push(`== veSPECTRA Gauge Votes ==`);
        lines.push(`  Snapshot: Block ${raw.block.number} (${snapshotDate})`);
        lines.push(`  Total Voting Power: ${totalVotingPower.toLocaleString("en-US", { maximumFractionDigits: 0 })} veSPECTRA`);
        lines.push(`  Total Votes Cast: ${totalVotes.toLocaleString("en-US", { maximumFractionDigits: 0 })} veSPECTRA (${formatPct(participation)} participation)`);
        lines.push(`  Weekly Emissions: ${parseFloat(raw.totalEmissions.amount || "0").toLocaleString("en-US", { maximumFractionDigits: 0 })} SPECTRA (${formatUsd(raw.totalEmissions.value)})`);
        lines.push(`  SPECTRA Price: $${raw.reduceIncentives?.price?.toFixed(6) || "?"}`);
        lines.push(`  Avg Voting APR: ${formatPct(raw.avgVotingApr.total * 100)} (rewards ${formatPct(raw.avgVotingApr.rewards * 100)} + fees ${formatPct(raw.avgVotingApr.fees * 100)})`);
        lines.push(`  Total Voting Rewards: ${formatUsd(raw.totalVotingRewards)} | Fees: ${formatUsd(raw.totalVotingFees)}`);
        lines.push(``);

        // Emission concentration analysis
        const topVotesPct = shown.length > 0 && totalVotes > 0
          ? (shown.slice(0, 3).reduce((s, g) => s + g.votesNum, 0) / totalVotes) * 100
          : 0;
        if (topVotesPct > 50) {
          lines.push(`  ⚠ Top 3 gauges control ${formatPct(topVotesPct)} of all votes — concentrated governance`);
        } else if (topVotesPct > 0) {
          lines.push(`  Top 3 gauges: ${formatPct(topVotesPct)} of votes — ${topVotesPct < 30 ? "distributed" : "moderately concentrated"}`);
        }
        lines.push(``);

        // Per-gauge detail
        lines.push(`--- Gauges (${shown.length} of ${gauges.length}, sorted by ${sort_by}) ---`);
        lines.push(``);

        // Show maturity status for every gauge — the data speaks, not a binary tag.
        // Open emergence: an agent seeing "matured 47d ago" and "matures in 180d"
        // can reason about the temporal dimension. The days-since or days-until
        // IS the information. No threshold decides what's "expired enough" to flag.
        const nowSec = Math.floor(Date.now() / 1000);

        for (let i = 0; i < shown.length; i++) {
          const g = shown[i];
          const chainName = CHAIN_NAMES[g.chainId] || `Chain ${g.chainId}`;
          const maturityTs = g.maturity ? parseInt(g.maturity) : 0;
          const maturityDate = maturityTs > 0 ? new Date(maturityTs * 1000).toISOString().split("T")[0] : "?";
          const votePct = totalVotes > 0 ? (g.votesNum / totalVotes) * 100 : 0;

          // Temporal context: how far from maturity, in which direction
          let maturityContext = "";
          if (maturityTs > 0) {
            const daysDelta = Math.round((maturityTs - nowSec) / 86400);
            maturityContext = daysDelta < 0
              ? ` (matured ${Math.abs(daysDelta)}d ago)`
              : ` (${daysDelta}d to maturity)`;
          }
          lines.push(`  #${i + 1} ${g.symbol || g.address.slice(0, 10)} (${chainName}) — ${maturityDate}${maturityContext}`);
          lines.push(`    Pool: ${g.address}`);
          lines.push(`    Votes: ${g.votesNum.toLocaleString("en-US", { maximumFractionDigits: 0 })} veSPECTRA (${formatPct(votePct)} of total)`);
          lines.push(`    Voting APR: ${formatPct((g.votingApr?.total || 0) * 100)} (rewards ${formatPct((g.votingApr?.rewards || 0) * 100)} + fees ${formatPct((g.votingApr?.fees || 0) * 100)})`);

          // SPECTRA emissions to this gauge
          if (g.lpIncentives) {
            const emAmt = parseFloat(g.lpIncentives.amount || "0");
            lines.push(`    LP Emissions: ${emAmt.toLocaleString("en-US", { maximumFractionDigits: 0 })} SPECTRA/wk (${formatUsd(g.lpIncentives.value)})`);
          }

          // Voting rewards (bribes)
          if (g.votingRewards && g.votingRewards.length > 0) {
            const rewardLines = g.votingRewards
              .filter((r) => r.value > 0)
              .map((r) => `${parseFloat(r.amount).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${r.symbol} (${formatUsd(r.value)})`);
            if (rewardLines.length > 0) {
              lines.push(`    Bribes: ${rewardLines.join(", ")} | Total: ${formatUsd(g.totalVotingRewards)}`);
            }
            // Bribe efficiency
            if (g.votesNum > 0 && g.totalVotingRewards > 0) {
              const spectraPrice = raw.reduceIncentives?.price || 0;
              const voteValueUsd = g.votesNum * spectraPrice;
              if (voteValueUsd > 0) {
                const efficiency = g.totalVotingRewards / voteValueUsd;
                lines.push(`    Bribe Efficiency: ${formatUsd(g.totalVotingRewards)} rewards / ${formatUsd(voteValueUsd)} votes = ${efficiency.toFixed(2)}x`);
              }
            }
          } else {
            lines.push(`    Bribes: none`);
          }

          // Swap fees
          if (g.totalVotingFees > 0) {
            lines.push(`    Swap Fees to Voters: ${formatUsd(g.totalVotingFees)}`);
          }

          lines.push(``);
        }

        // Maturity distribution — how many gauges point at past vs future pools
        const maturedCount = shown.filter(g => {
          const ts = g.maturity ? parseInt(g.maturity) : 0;
          return ts > 0 && ts < nowSec;
        }).length;
        if (maturedCount > 0) {
          const maturedPct = (maturedCount / shown.length * 100).toFixed(0);
          lines.push(`Maturity distribution: ${maturedCount}/${shown.length} gauges (${maturedPct}%) point at pools that have already matured.`);
          lines.push(``);
        }

        // Open emergence: what the data surface doesn't show
        lines.push(`── Observation Boundary ──`);
        lines.push(`This snapshot shows the CURRENT vote distribution and reward structure.`);
        lines.push(`It cannot detect: vote migration trends (are whales rotating?), bribe`);
        lines.push(`sustainability (will these rewards persist next epoch?), or whether`);
        lines.push(`high voting APR reflects genuine protocol demand vs temporary promotion.`);
        lines.push(`Cross-reference with spectra_get_pool_activity on high-voted gauges to`);
        lines.push(`see if trading activity justifies the emission allocation.`);
        lines.push(``);

        lines.push(`--- Next Steps ---`);
        lines.push(`  • Boost calc: spectra_get_ve_info(wallet_address=YOUR_ADDR)`);
        lines.push(`  • Pool details: spectra_get_pt_details(chain=CHAIN, pt_address=ADDR)`);
        lines.push(`  • Expiring gauges: spectra_list_expiring_pools(threshold_days=30)`);
        lines.push(`  • Protocol stats: spectra_get_protocol_stats()`);

        const text = lines.join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
