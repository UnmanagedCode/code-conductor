// MCP tool forwarding — turns each enabled plugin's manifest-declared tools
// into entries shaped exactly like the core tools in src/mcp/tools.js
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

export function createMcpBridge({ instances, listMcpPlugins, ensureStarted, portFor, reportUpstreamFailure }) {
  // callerId → project of the live/known session, or undefined when the
  // caller can't be resolved (stale ?caller=). Used only to attribute the
  // forwarded call — never for visibility.
  function callerProject(callerId) {
    return instances?.anyForSession?.(callerId)?.project;
  }

  // Every enabled plugin's tools are visible to EVERY caller — the
  // conductor/UI and workers in any project. (v1 shipped per-project
  // scoping; live validation showed plugin tools are wanted everywhere, so
  // the manifest `scope` field is accepted but inert.) The callerId param
  // stays in the signature — it's the registry's stable surface and keeps
  // the per-request composition site in mcp/server.js unchanged.
  function toolsFor(_callerId) {
    const out = [];
    for (const entry of listMcpPlugins()) {
      for (const t of entry.manifest.mcp.tools) {
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

  function makeHandler(pluginId, toolName) {
    return async (args, ctx) => {
      await ensureStarted(pluginId); // lazy start on first tool call
      // Manifest of the ACTIVE checkout — ensureStarted re-read it.
      const entry = listMcpPlugins().find(e => e.id === pluginId);
      const mcp = entry?.manifest.mcp;
      if (!mcp) throw withStatus(500, `plugin '${pluginId}' no longer declares mcp`);
      const port = portFor(pluginId);
      const caller = {
        sessionId: ctx.callerId ?? null,
        project: ctx.callerId != null ? (callerProject(ctx.callerId) ?? null) : null,
      };

      let res;
      try {
        res = await fetch(`http://127.0.0.1:${port}${mcp.endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool: toolName, arguments: args ?? {}, caller }),
          signal: AbortSignal.timeout(mcp.timeoutMs),
        });
      } catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
          throw withStatus(504, `plugin '${pluginId}' tool '${toolName}' timed out after ${mcp.timeoutMs}ms`);
        }
        reportUpstreamFailure(pluginId);
        throw withStatus(502, `plugin '${pluginId}' unreachable: ${e.message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw withStatus(500, `plugin '${pluginId}' MCP endpoint returned HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ''}`);
      }
      let body;
      try { body = await res.json(); }
      catch { throw withStatus(500, `plugin '${pluginId}' MCP endpoint returned non-JSON`); }
      if (body && typeof body === 'object' && body.error != null) {
        throw new Error(String(body.error)); // tool-level failure: no HTTP status
      }
      return body?.result;
    };
  }

  return { toolsFor };
}

function withStatus(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
