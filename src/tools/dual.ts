/**
 * Dual-layer response helper for MCP tools.
 *
 * Every tool returns two content blocks:
 *   Block 0: Human-readable formatted text (unchanged from before)
 *   Block 1: JSON envelope with typed structured data for programmatic consumption
 *
 * Zero dependencies. No schema validation on the envelope.
 */

export interface DualEnvelope<T = unknown> {
  tool: string;
  ts: number;
  params: Record<string, unknown>;
  data: T;
}

export function dual<T>(text: string, envelope: DualEnvelope<T>, opts?: { isError?: boolean }) {
  return {
    content: [
      { type: "text" as const, text },
      { type: "text" as const, text: JSON.stringify(envelope) },
    ],
    ...(opts?.isError ? { isError: true as const } : {}),
  };
}
