// `cc.describe_tools()`: the in-script tool lookup. It is a run-scoped tool —
// composed into a request only when it carries a run token — so it is never in
// tools/list or the REST listing. Its source is the request's own live
// composition, so it cannot drift from what a call resolves.

import type { CodeModeCtx, ToolView } from './ctx.ts';
import { RESERVED_METHODS } from './runtimeApi.ts';
import { SUMMARY_CAP } from './limits.ts';
import { renderSignature } from './tsSignature.ts';
import { pascal } from './typeModel.ts';

const DETAILS = ['names', 'summary', 'full'] as const;
type Detail = typeof DETAILS[number];

export interface ToolEntry {
  method: string;
  name: string;
  namespace: string | null;
  scriptable: boolean;
  description?: string;
  signature?: string;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PLUGIN_SEP = '__';
// Tools a program never lists: this one, and the one that is refused inside a run.
const HIDDEN = new Set(['describe_tools', 'run_code']);

function firstSentence(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  const s = m ? m[1] : flat;
  return s.length > SUMMARY_CAP ? `${s.slice(0, SUMMARY_CAP - 1)}…` : s;
}

// The script path a tool is called by. A plugin whose id spells a reserved
// method (`call`) is reachable only through cc.call.
function methodOf(wire: string, ns: string | null, tool: string): string {
  if (ns === null) return `cc.${wire}`;
  if (RESERVED_METHODS.includes(ns)) return `cc.call('${wire}', args)`;
  if (IDENT.test(ns) && IDENT.test(tool)) return `cc.${ns}.${tool}`;
  return `cc['${wire.slice(0, wire.indexOf(PLUGIN_SEP))}']['${tool}']`;
}

// How a program spells the call, `(args)` included: what the run_code-only
// refusal tells a caller who used the wire name outside a program.
export function callSpellingOf(wire: string): string {
  const sep = wire.indexOf(PLUGIN_SEP);
  const ns = wire.slice(0, sep).replaceAll('-', '_');
  const m = methodOf(wire, ns, wire.slice(sep + PLUGIN_SEP.length));
  return RESERVED_METHODS.includes(ns) ? m : `${m}(args)`;
}

function signatureOf(t: ToolView, ns: string | null, tool: string): string {
  const fnName = tool.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
  try {
    return renderSignature({
      fnName,
      typeBase: pascal(ns ?? '') + pascal(tool),
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    });
  } catch (e) {
    console.error(`describe_tools: no signature for '${t.name}':`, e instanceof Error ? e.message : e);
    return `declare function ${fnName}(args?: unknown): Promise<unknown>; // signature unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function entryOf(t: ToolView, scriptable: boolean, detail: Detail): ToolEntry {
  const sep = t.name.indexOf(PLUGIN_SEP);
  const ns = sep < 0 ? null : t.name.slice(0, sep).replaceAll('-', '_');
  const tool = sep < 0 ? t.name : t.name.slice(sep + PLUGIN_SEP.length);
  const entry: ToolEntry = { method: methodOf(t.name, ns, tool), name: t.name, namespace: ns, scriptable };
  if (detail === 'summary') entry.description = firstSentence(t.description);
  if (detail === 'full') {
    entry.description = t.description;
    entry.signature = signatureOf(t, ns, tool);
  }
  return entry;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export async function describeTools(args: unknown, ctx: CodeModeCtx): Promise<{ tools: ToolEntry[] }> {
  const a = isRecord(args) ? args : {};
  const detail: Detail = DETAILS.includes(a.detail as Detail) ? a.detail as Detail : 'summary';
  const names = Array.isArray(a.names) ? new Set(a.names.filter((n): n is string => typeof n === 'string')) : null;
  const namespace = typeof a.namespace === 'string' ? a.namespace.replaceAll('-', '_') : null;
  const words = typeof a.query === 'string' ? a.query.toLowerCase().split(/\s+/).filter(Boolean) : [];

  const sources: Array<{ tool: ToolView; scriptable: boolean }> = [
    ...(ctx.tools ?? []).filter(t => !HIDDEN.has(t.name)).map(tool => ({ tool, scriptable: true })),
    ...[...(ctx.textOnlyTools ?? new Map<string, ToolView>()).values()].map(tool => ({ tool, scriptable: false })),
  ];
  // Plugin members read as tools: the same view, under their wire name.
  for (const [id, members] of ctx.runCodeMembers ?? []) {
    for (const m of members) {
      sources.push({ tool: { name: `${id}${PLUGIN_SEP}${m.name}`, description: m.description, inputSchema: m.inputSchema, outputSchema: m.outputSchema }, scriptable: true });
    }
  }
  const tools: ToolEntry[] = [];
  for (const { tool, scriptable } of sources) {
    const entry = entryOf(tool, scriptable, 'names');
    if (namespace !== null && entry.namespace !== namespace) continue;
    if (names && !names.has(entry.name) && !names.has(entry.method)) continue;
    if (words.length > 0) {
      const hay = `${tool.name} ${tool.description}`.toLowerCase();
      if (!words.every(w => hay.includes(w))) continue;
    }
    tools.push(detail === 'names' ? entry : entryOf(tool, scriptable, detail));
  }
  return { tools };
}

export const describeToolsTool = {
  name: 'describe_tools',
  description: 'List what a run_code program can call: method path, the name cc.call takes, namespace, and — by detail — summary or TypeScript signature.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Every whitespace-separated word must occur in the tool name or description (case-insensitive).' },
      names: { type: 'array', items: { type: 'string' }, description: 'Wire names or method paths to keep.' },
      namespace: { type: 'string', description: "A plugin namespace, `code_kanban` or `code-kanban`." },
      detail: { type: 'string', enum: [...DETAILS], description: "'names', 'summary' (default) or 'full' (whole description plus a TypeScript signature)." },
    },
  },
  handler: describeTools,
};
