// The instance status predicates. A leaf, so `src/instances.ts`'s collaborators
// can ask them without importing back into `instances.ts` (an import cycle).

// The two terminal statuses. Exported because "is this worker dead?" is asked
// on two MCP surfaces that MUST agree — list_projects' `live N`
// (liveCountForProject) and whether a worker lands in list_sessions' live rows
// (src/mcp/handlers.ts) — and a second spelling of the rule is how they would
// drift apart. A dead instance retained in byId (persistent exits are kept
// indefinitely, so respawn can resume them) is NOT a live worker.
export function isDeadStatus(status: unknown): boolean {
  return status === 'exited' || status === 'crashed';
}
