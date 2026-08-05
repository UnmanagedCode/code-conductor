// MCP tool forwarding — turns each enabled plugin's manifest-declared tools
// into entries shaped exactly like the core tools in src/mcp/tools.ts
// (`{name, description, inputSchema, handler}`), namespaced
// `<plugin-id>__<tool>`. The MCP server composes them per request via
// pluginHost.toolsFor(callerId); tools of every enabled plugin are visible
// to every caller (disabled plugins' tools are simply absent, so tools/call
// refuses them as unknown with zero extra code).
//
// Wire contract with the child (pinned): POST <endpoint> with
// {tool, arguments, caller:{sessionId, project}} → HTTP 200 for EVERY
// well-formed tool invocation, body {result:<any JSON>} or
// {error:"<message>"} — unknown tool, bad args and tool-level failures are
// all 200+{error}. A non-200 from the child means a transport-level
// failure only (malformed envelope, plugin bug) and maps to an HTTP-coded
// error; 200+{error} maps to a plain tool error with no status code.
//
// Additive to that contract: a success body may use {text, meta?} instead
// of {result} to get raw, UNESCAPED text blocks (see makeHandler below).
import { textPayload } from '../mcp/content.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import type { PluginMcp } from './manifest.ts';

export interface McpBridgeDeps {
  instances: InstanceManagerLike | null | undefined;
  listMcpPlugins: () => Array<{ id: string; manifest: { mcp: PluginMcp | null } }>;
  ensureStarted: (pluginId: string) => Promise<void>;
  portFor: (pluginId: string) => number | null;
  reportUpstreamFailure: (pluginId: string) => void;
}

export function createMcpBridge({ instances, listMcpPlugins, ensureStarted, portFor, reportUpstreamFailure }: McpBridgeDeps) {
  // callerId → project of the live/known session, or undefined when the
  // caller can't be resolved (stale ?caller=). Used only to attribute the
  // forwarded call — never for visibility.
  function callerProject(callerId: string): string | undefined {
    return instances?.anyForSession?.(callerId)?.project;
  }

  // Every enabled plugin's tools are visible to EVERY caller — the
  // conductor/UI and workers in any project. (v1 shipped per-project
  // scoping; live validation showed plugin tools are wanted everywhere, so
  // the manifest `scope` field is accepted but inert.) The callerId param
  // stays in the signature — it's the registry's stable surface and keeps
  // the per-request composition site in mcp/server.ts unchanged.
  function toolsFor(_callerId: string) {
    const out: Array<{ name: string; description: string; inputSchema: unknown; handler: (args: unknown, ctx: { callerId: string | null }) => Promise<unknown> }> = [];
    for (const entry of listMcpPlugins()) {
      const mcp = entry.manifest.mcp;
      if (!mcp) continue;
      for (const t of mcp.tools) {
        out.push({
          name: `${entry.id}__${t.name}`,
          description: t.description,
          inputSchema: t.inputSchema,
          handler: makeHandler(entry.id, t.name),
        });
      }
    }
    return out;
  }

  function makeHandler(pluginId: string, toolName: string) {
    return async (args: unknown, ctx: { callerId: string | null }): Promise<unknown> => {
      await ensureStarted(pluginId); // lazy start on first tool call
      // Manifest of the ACTIVE checkout — ensureStarted re-read it.
      const entry = listMcpPlugins().find(e => e.id === pluginId);
      const mcp = entry?.manifest.mcp;
      if (!mcp) throw withStatus(500, `plugin '${pluginId}' no longer declares mcp`);
      const port = portFor(pluginId);
      if (port == null) throw withStatus(500, `plugin '${pluginId}' has no running backend`);
      const caller = {
        sessionId: ctx.callerId ?? null,
        project: ctx.callerId != null ? (callerProject(ctx.callerId) ?? null) : null,
      };

      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${port}${mcp.endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool: toolName, arguments: args ?? {}, caller }),
          signal: AbortSignal.timeout(mcp.timeoutMs),
        });
      } catch (e) {
        const err = e as { name?: unknown };
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          throw withStatus(504, `plugin '${pluginId}' tool '${toolName}' timed out after ${mcp.timeoutMs}ms`);
        }
        reportUpstreamFailure(pluginId);
        throw withStatus(502, `plugin '${pluginId}' unreachable: ${(e as Error).message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw withStatus(500, `plugin '${pluginId}' MCP endpoint returned HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ''}`);
      }
      let body: unknown;
      try { body = await res.json(); }
      catch { throw withStatus(500, `plugin '${pluginId}' MCP endpoint returned non-JSON`); }
      if (body && typeof body === 'object' && (body as { error?: unknown }).error != null) {
        throw new Error(String((body as { error: unknown }).error)); // tool-level failure: no HTTP status
      }
      // Opt-in raw-text channel (additive to the pinned contract): instead of
      // `result`, a child may return `text` (one string OR a list of strings)
      // plus optional `meta`, to have them emitted as raw, UNESCAPED content
      // blocks after a compact-JSON meta block. The child says `text` because
      // that channel only ever carries text; textPayload's param is `bodies`
      // because it's generic (file bodies, diffs, prose). `text` wins if both
      // are sent; absent `text` → today's `result` path.
      const rec = body as { text?: unknown; meta?: unknown; result?: unknown };
      if (rec.text !== undefined) return textPayload(rec.meta ?? null, rec.text);
      return rec.result;
    };
  }

  return { toolsFor };
}

function withStatus(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
