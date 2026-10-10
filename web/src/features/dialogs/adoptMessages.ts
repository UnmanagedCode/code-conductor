// The adopt route's refusals, worded for this dialog. Two server reasons end in
// a remedy clause aimed at an MCP caller (a field name, a protocol flag); the
// dialog swaps that tail for the remedy it actually offers. Everything else
// renders verbatim.
export const REFUSAL_OVERRIDES = [
  {
    code: 'TRANSCRIPT_DIR_COLLISION',
    serverTail: ' Pick another name.',
    remedy: ' Pick a different directory, or delete the record that holds that transcript key.',
  },
  {
    code: 'PROJECT_PLACEMENT_IN_USE',
    serverTail: " — delete them first, or pass onStaleRecord:'replace' to discard them along with the rest of its stored state.",
    remedy: ' — delete them first, or choose Replace below.',
  },
];

export function messageFor(result: { reason?: unknown; code?: string } | null | undefined): string {
  const reason = typeof result?.reason === 'string' ? result.reason : '';
  if (!reason) return 'The server refused the adoption without giving a reason.';
  const override = REFUSAL_OVERRIDES.find((o) => o.code === result?.code);
  if (override && reason.endsWith(override.serverTail)) return reason.slice(0, -override.serverTail.length) + override.remedy;
  return reason;
}
