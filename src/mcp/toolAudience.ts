// Which sessions are offered an MCP tool, core or plugin. A leaf module (no
// imports) so the core registry, the manifest validator and the MCP bridge can
// share it.

export const TOOL_AUDIENCES = ['all', 'conductor', 'worker'] as const;
export type ToolAudience = (typeof TOOL_AUDIENCES)[number];

// Who is calling: a .conduct session, any other live session, or no session
// (`/mcp` with no `<sessionId>`).
export type CallerKind = 'conductor' | 'worker' | 'anonymous';

// THE audience predicate. Anonymous callers are unrestricted: audience steers
// managed sessions only and is not an access-control boundary (/mcp has no auth).
export function audienceAdmits(audience: ToolAudience, kind: CallerKind): boolean {
  return kind === 'anonymous' || audience === 'all' || audience === kind;
}
