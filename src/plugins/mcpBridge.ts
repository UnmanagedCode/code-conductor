// MCP tool forwarding — turns each enabled plugin's manifest-declared tools
// into entries shaped exactly like the core tools in src/mcp/tools.ts
// (`{name, description, inputSchema, outputSchema?, handler}`), namespaced
// `<plugin-id>__<tool>`. The MCP server composes them per request via
// pluginHost.toolsFor(); tools of every enabled plugin are visible to every
// caller — hence no caller argument (disabled plugins' tools are simply
// absent, so tools/call refuses them as unknown with zero extra code). A tool
// without an `outputSchema` is text-only: the server leaves it out of json
// format (src/mcp/server.ts composeTools).
//
// Wire contract with the child (pinned; docs/plugins.md): POST <endpoint> with
// {tool, arguments, caller:{sessionId, project}, format:'text'|'json'} → HTTP
// 200 for EVERY well-formed tool invocation — unknown tool, bad args and
// tool-level failures are all 200+{error, code?, details?}. A non-200 from the child
// means a transport-level failure only (malformed envelope, plugin bug) and
// maps to an HTTP-coded error. The 200 body, checked in this order:
//   1. {error, code?, details?}  (any format) — a tool error. A `code`
//      matching PLUGIN_ERROR_CODE_RE and a `details` JSON object ride on the
//      thrown error; a malformed code or a non-object details is
//      PLUGIN_REPLY_INVALID. Any other key is dropped.
//   2. format json     — {structured} only, an object valid against the tool's
//      outputSchema; returned as is (the server's structuredContent).
//   3. format text, typed tool   — {text, meta?} only.
//   4. format text, untyped tool — the legacy body: `text` wins, else `result`;
//      a `structured` key is the wrong shape for the format.
// Any other body is PLUGIN_REPLY_INVALID (HTTP-500-coded, logged).
import { httpError } from '../httpError.ts';
import { humanizeDuration } from '../duration.ts';
import { textPayload, textResult } from '../mcp/content.ts';
import { validate } from '../mcp/jsonSchemaSubset.ts';
import type { McpFormat } from '../mcp/limits.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';
import type { PluginMcp } from './manifest.ts';

// A plugin's own error code: an upper-snake identifier, cc's codes included.
export const PLUGIN_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

// How many validate() errors a schema-mismatch reason quotes.
const QUOTED_SCHEMA_ERRORS = 3;

type HandlerCtx = { callerId: string | null; format: McpFormat };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function kindOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

// A reply whose shape breaks the wire contract: a plugin defect, surfaced
// loudly on every channel rather than reshaped.
function replyInvalid(reason: string): Error {
  console.error(`mcp: PLUGIN_REPLY_INVALID — ${reason}`);
  return httpError(500, reason, { code: 'PLUGIN_REPLY_INVALID' });
}

export interface McpBridgeDeps {
  instances: InstanceManagerLike | null | undefined;
  listMcpPlugins: () => Array<{ id: string; manifest: { mcp: PluginMcp | null } }>;
  ensureStarted: (pluginId: string) => Promise<void>;
  portFor: (pluginId: string) => number | null;
  reportUpstreamFailure: (pluginId: string) => void;
}

export function createMcpBridge({ instances, listMcpPlugins, ensureStarted, portFor, reportUpstreamFailure }: McpBridgeDeps) {
  // callerId → project of the live/known session, or undefined when the
  // caller's session is not known. Used only to attribute the
  // forwarded call — never for visibility.
  function callerProject(callerId: string): string | undefined {
    return instances?.anyForSession?.(callerId)?.project;
  }

  // Every enabled plugin's tools are visible to EVERY caller — the
  // conductor/UI and workers in any project. (v1 shipped per-project
  // scoping; live validation showed plugin tools are wanted everywhere, so
  // the manifest `mcp.scope` field is tolerated and dropped — see manifest.ts.)
  // Hence no caller parameter: there is nothing to scope by.
  function toolsFor() {
    const out: Array<{ name: string; description: string; inputSchema: unknown; outputSchema?: unknown; handler: (args: unknown, ctx: HandlerCtx) => Promise<unknown> }> = [];
    for (const entry of listMcpPlugins()) {
      const mcp = entry.manifest.mcp;
      if (!mcp) continue;
      for (const t of mcp.tools) {
        out.push({
          name: `${entry.id}__${t.name}`,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
          handler: makeHandler(entry.id, t.name),
        });
      }
    }
    return out;
  }

  function makeHandler(pluginId: string, toolName: string) {
    const where = `plugin '${pluginId}' tool '${toolName}'`;
    return async (args: unknown, ctx: HandlerCtx): Promise<unknown> => {
      await ensureStarted(pluginId); // lazy start on first tool call
      // Manifest of the ACTIVE checkout — ensureStarted re-read it.
      const entry = listMcpPlugins().find(e => e.id === pluginId);
      const mcp = entry?.manifest.mcp;
      if (!mcp) throw httpError(500, `plugin '${pluginId}' no longer declares mcp`);
      // The schema of the ACTIVE checkout: one that dropped it since the
      // server composed its tool list is text-only from now on.
      const outputSchema = mcp.tools.find(t => t.name === toolName)?.outputSchema;
      if (ctx.format === 'json' && !outputSchema) {
        throw Object.assign(new Error(`${where} no longer declares an outputSchema, so it is served in text format only — call it over JSON-RPC at /mcp?format=text`), { code: 'TOOL_UNAVAILABLE_IN_FORMAT' });
      }
      const port = portFor(pluginId);
      if (port == null) throw httpError(500, `plugin '${pluginId}' has no running backend`);
      const caller = {
        sessionId: ctx.callerId ?? null,
        project: ctx.callerId != null ? (callerProject(ctx.callerId) ?? null) : null,
      };

      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${port}${mcp.endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool: toolName, arguments: args ?? {}, caller, format: ctx.format }),
          signal: AbortSignal.timeout(mcp.timeoutMs),
        });
      } catch (e) {
        const err = e as { name?: unknown };
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          throw httpError(504, `plugin '${pluginId}' tool '${toolName}' timed out after ${humanizeDuration(mcp.timeoutMs)}`);
        }
        reportUpstreamFailure(pluginId);
        throw httpError(502, `plugin '${pluginId}' unreachable: ${(e as Error).message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw httpError(500, `plugin '${pluginId}' MCP endpoint returned HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ''}`);
      }
      let body: unknown;
      try { body = await res.json(); }
      catch { throw httpError(500, `plugin '${pluginId}' MCP endpoint returned non-JSON`); }
      const rec = isRecord(body) ? body : {};
      const keys = Object.keys(rec);
      // 1. A tool error, in any format.
      if (rec.error != null) {
        const code = rec.code;
        if (code != null && (typeof code !== 'string' || !PLUGIN_ERROR_CODE_RE.test(code))) {
          throw replyInvalid(`${where}: error carries an invalid code ${JSON.stringify(code)} (must match ${PLUGIN_ERROR_CODE_RE.source}): ${String(rec.error)}`);
        }
        if ('details' in rec && !isRecord(rec.details)) {
          throw replyInvalid(`${where}: error carries an invalid details (must be a JSON object, got ${kindOf(rec.details)}): ${String(rec.error)}`);
        }
        // No HTTP status: a tool-level failure.
        throw Object.assign(new Error(String(rec.error)),
          code != null ? { code } : {},
          'details' in rec ? { details: rec.details } : {});
      }
      // 2. json: the structured view alone, held to the advertised schema.
      if (ctx.format === 'json' && outputSchema) {
        if (keys.length !== 1 || keys[0] !== 'structured') {
          throw replyInvalid(`${where}: a json-format reply must be {structured} only; got keys: ${keys.join(', ')}`);
        }
        const structured = rec.structured;
        if (!isRecord(structured)) throw replyInvalid(`${where}: 'structured' must be a JSON object, got ${kindOf(structured)}`);
        const errors = validate(outputSchema, structured);
        if (errors.length > 0) {
          throw replyInvalid(`${where}: 'structured' does not match its outputSchema: ${errors.slice(0, QUOTED_SCHEMA_ERRORS).join('; ')}`);
        }
        return structured;
      }
      // 3. text, typed tool: {text, meta?} only. 4. text, untyped tool: the
      // legacy body, except a `structured` view, which this format never takes.
      if (outputSchema
        ? !('text' in rec) || keys.some(k => k !== 'text' && k !== 'meta')
        : 'structured' in rec) {
        throw replyInvalid(`${where}: a text-format reply must be {text, meta?}; got keys: ${keys.join(', ')}`);
      }
      // The raw-text channel: `text` (one string OR a list of strings) plus
      // optional `meta` is emitted as raw, UNESCAPED content blocks after a
      // compact-JSON meta block — except a single string with no (or null)
      // `meta`, which is the whole result as exactly one raw block
      // (textResult). That is decided here because textResult's Symbol tag
      // can't cross the child's JSON hop and only the bridge sees that `meta`
      // was omitted. `text` wins over a legacy `result`; absent `text` → the
      // `result` path (untyped tools only).
      if (rec.text !== undefined) {
        if (rec.meta == null && typeof rec.text === 'string') return textResult(rec.text);
        return textPayload(rec.meta ?? null, rec.text);
      }
      return rec.result;
    };
  }

  return { toolsFor };
}
