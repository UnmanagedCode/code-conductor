// Display parse of a tool's wire name — the single owner of how a tool-call
// name reads in the UI. DOM-free; `ToolName` (web/src/conversation/tools.tsx)
// builds the node from it.
//
// Wire shapes (all `__`-delimited):
//   mcp__code-conductor__<core_tool>          core tool — no `__` in the name (src/mcp/tools.ts)
//   mcp__code-conductor__<plugin-id>__<tool>  plugin tool (toolsFor, src/plugins/mcpBridge.ts);
//                                             the id matches SLUG_RE, so it holds no `_`,
//                                             while the tool may contain `__`
//   mcp__<server>__<tool>                     any other MCP server; the Claude CLI maps
//                                             non-[A-Za-z0-9_-] to `_`, claude.ai connectors
//                                             arrive as `claude_ai_<Name>`
//   anything else                             built-in (Bash, Read, …), shown verbatim
// A name that fits none of the mcp shapes renders verbatim too.

// Mirrors the pinned server name in buildMcpConfigJSON (src/settings.ts); the
// browser can't import src/.
export const CC_MCP_SERVER = 'code-conductor';

function sentence(s: string): string | null {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : null;
}

function stripCode(id: string): string {
  return id.startsWith('code-') && id.length > 5 ? id.slice(5) : id;
}

function serverChip(s: string): string {
  const base = s.startsWith('claude_ai_') && s.length > 10 ? s.slice(10) : s;
  return base.replace(/_+/g, ' ').trim() || s;
}

export type ToolNameParts = {
  raw: string | null | undefined;
  kind: 'builtin' | 'cc' | 'plugin' | 'mcp';
  chip: string | null;
  label: string;
};

export function formatToolName(raw: string | null | undefined): ToolNameParts {
  if (typeof raw !== 'string' || !raw) return { raw, kind: 'builtin', chip: null, label: raw || 'tool' };
  const verbatim: ToolNameParts = { raw, kind: 'builtin', chip: null, label: raw };
  if (!raw.startsWith('mcp__')) return verbatim;
  const rest = raw.slice(5);
  const i = rest.indexOf('__');
  if (i <= 0) return verbatim;
  const server = rest.slice(0, i);
  const tail = rest.slice(i + 2);
  if (!tail) return verbatim;
  if (server === CC_MCP_SERVER) {
    const j = tail.indexOf('__');
    if (j === -1) {
      const label = sentence(tail);
      return label ? { raw, kind: 'cc', chip: 'cc', label } : verbatim;
    }
    const tool = tail.slice(j + 2);
    const label = j > 0 && tool ? sentence(tool) : null;
    return label ? { raw, kind: 'plugin', chip: stripCode(tail.slice(0, j)), label } : verbatim;
  }
  const label = sentence(tail);
  return label ? { raw, kind: 'mcp', chip: serverChip(server), label } : verbatim;
}

// The one-line text form, for surfaces that render plain text (the action-group tally).
export function toolNamePlain(raw: string | null | undefined): string {
  const { chip, label } = formatToolName(raw);
  return chip ? `${chip}: ${label}` : label;
}
