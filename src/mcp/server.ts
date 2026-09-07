// MCP (Model Context Protocol) server, mounted at /mcp on the orchestrator's
// existing http server. Streamable HTTP transport, JSON-RPC 2.0 over POST,
// no SSE — every tool result fits in a single application/json response.
//
// Exposes the orchestrator's verbs (spawn / list / send_prompt / read
// transcript / worktree ops) as MCP tools so a Claude session can drive
// the orchestrator directly via `claude mcp add --transport http
// code-conductor http://127.0.0.1:8787/mcp`.

import express from 'express';
import { buildTools } from './tools.ts';
import { isTextPayload, isTextResult, codeForStatus } from './content.ts';
import { validateArgs } from './argValidation.ts';
import { SESSION_PREFIX_MIN } from '../instances.ts';
import { createPlaybookGate, type PlaybookGate } from './playbookGate.ts';
import type { InstanceManagerLike } from '../instanceTypes.ts';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'code-conductor';
const SERVER_VERSION = '0.1.0';
const JSONRPC = '2.0';

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// The per-request context handed to every tool handler: `tools` is the
// per-request composition (core tools + this caller's plugin tools) that both
// tools/list and tools/call read; `instances`/`callerId` are the caller-
// resolved handles the handlers consume.
interface McpCtx {
  instances?: InstanceManagerLike | null;
  tools: McpTool[];
  callerId: string | null;
  playbookGate: PlaybookGate;
}

// The tool shape the transport itself needs — deliberately broader than the
// registry's `Tool` (tools.ts) so BOTH core tools (inputSchema typed as a
// Record, handler ctx `ToolCtx`) and plugin tools (inputSchema: unknown,
// handler ctx narrowed to `{callerId}`) satisfy it without a cast. `handler`'s
// ctx is McpCtx (a supertype of both) so the assignment is contravariantly
// sound in each direction.
interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler(args: unknown, ctx: McpCtx): Promise<unknown>;
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean };
}

// The plugin-host surface this module composes tools from — `init` + `toolsFor`
// are the only two members the per-request composition touches. Structural:
// the real createPluginHost return satisfies it.
interface McpPluginHostLike {
  init(): Promise<void>;
  toolsFor(): Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    handler: (args: unknown, ctx: { callerId: string | null }) => Promise<unknown>;
  }>;
}

function rpcResult(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSONRPC, id, result };
}
function rpcError(id: unknown, code: number, message: string, data?: unknown): JsonRpcResponse {
  const err: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: JSONRPC, id, error: err };
}

// The one narrowing predicate for every wire-boundary value this module reads
// (msg, args, params, schema sub-fields): a non-null, non-array object.
function isJsonRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// The record-shaped view of an unknown value, `{}` for anything else — the
// wire boundary is `unknown`, so every optional-field read goes through this
// (or isJsonRecord) rather than a cast.
function asRecord(v: unknown): Record<string, unknown> {
  return isJsonRecord(v) ? v : {};
}

// The numeric HTTP-ish statusCode on a thrown value, or null — the narrowing
// point for the tools/call error envelope (catch variables are `unknown`
// under strict).
function errStatus(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const sc = (e as { statusCode?: unknown }).statusCode;
  return typeof sc === 'number' ? sc : null;
}

// The `code` on a thrown value (handlers throw Object.assign(new Error, {code})),
// or undefined — same idiom as routes.ts / handlers.ts.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}

// The message prose for the tools/call error envelope: a thrown value's
// `message` when it has one (Error or not), else its String() coercion —
// matches the original `e?.message ?? String(e)` reading.
function errMsg(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(e);
}

// A string `message` on a thrown value, or undefined — the dispatch-level
// fallback feeds 'internal error' (original `e?.message ?? 'internal error'`).
function errMessage(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    return typeof m === 'string' ? m : undefined;
  }
  return undefined;
}

// The id of a non-JSON-RPC request (used only for the -32600 error reply).
function rpcRequestId(msg: unknown): unknown {
  return isJsonRecord(msg) ? msg.id : undefined;
}

// True when a tool's inputSchema declares `prop` with a truthy value — the
// schema gate for the prefix-resolution chokepoint below. Driven off the schema
// so a future tool declaring `provenance` is resolved without another edit here.
function hasSchemaProperty(schema: unknown, prop: string): boolean {
  if (!isJsonRecord(schema)) return false;
  const props = schema.properties;
  if (!isJsonRecord(props)) return false;
  return prop in props && !!props[prop];
}

// The SESSION_AMBIGUOUS soft refusal, shared by every prefix-resolution site
// below so the wording has one home. `where` names the argument the ambiguous
// prefix came from; `sessionId` echoes the input verbatim whatever argument that
// was.
//
// `matches` carries public ids WHOLE, never a slice. A public id is 8 chars only
// until a mint-time collision extends it to 13 or to the full backing id
// (PUBLIC_ID_LEN_EXTENDED, src/sessionLineage.ts) — and two 13-char ids share
// their first 8, so slicing would print the same candidate twice and tell the
// caller to disambiguate between two identical strings. For the ordinary 8-char
// id this is byte-identical to what a slice produced.
function ambiguousRefusal(
  ref: { ambiguous: string[]; tooShort: boolean }, input: string, where: string,
): Record<string, unknown> {
  const matches = ref.ambiguous;
  const reason = ref.tooShort
    ? `session prefix "${input}" (${where}) is too short — pass at least ${SESSION_PREFIX_MIN} characters or a full sessionId. Candidates: ${matches.join(', ')}.`
    : `session prefix "${input}" (${where}) matches ${ref.ambiguous.length} sessions — pass more characters or a full sessionId. Candidates: ${matches.join(', ')}.`;
  return { ok: false, code: 'SESSION_AMBIGUOUS', sessionId: input, reason, matches };
}

async function dispatch(msg: unknown, ctx: McpCtx): Promise<JsonRpcResponse | null> {
  if (!isJsonRecord(msg) || msg.jsonrpc !== JSONRPC) {
    return rpcError(rpcRequestId(msg) ?? null, -32600, 'invalid JSON-RPC request');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  // Methods that are notifications-only (no response per spec).
  if (method === 'notifications/initialized' || method === 'initialized') {
    return null;
  }

  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    if (method === 'ping') {
      return rpcResult(id, {});
    }
    if (method === 'tools/list') {
      const tools = ctx.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
      return rpcResult(id, { tools });
    }
    if (method === 'tools/call') {
      const p = asRecord(params);
      const name = p.name;
      let args: unknown = p.arguments ?? {};
      const tool = ctx.tools.find(t => t.name === name);
      if (!tool) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        });
      }
      const v = validateArgs(tool.inputSchema, args, name);
      if (v) {
        return rpcResult(id, {
          content: [{ type: 'text', text: v }],
          isError: true,
        });
      }
      // sessionId prefix resolution — the single, uniform chokepoint for every
      // worker-addressing tool. Accept any unambiguous prefix of a sessionId in
      // place of the full 36-char UUID, resolved to the canonical full id before
      // the handler touches the registry. Non-destructive: only rewrites on a
      // confident prefix→full resolution; exact ids and no-matches pass through
      // unchanged so the handler's existing SESSION_NOT_LIVE / SESSION_UNKNOWN /
      // on-disk lookup paths still run. The only new outcome is SESSION_AMBIGUOUS,
      // serialized exactly like a handler soft-refusal (no isError).
      if (ctx.instances?.resolveSessionRef
          && hasSchemaProperty(tool.inputSchema, 'sessionId')
          && isJsonRecord(args)
          && typeof args.sessionId === 'string' && args.sessionId) {
        const ref = ctx.instances.resolveSessionRef(args.sessionId);
        if (ref && 'ambiguous' in ref) {
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(ambiguousRefusal(ref, args.sessionId, 'sessionId')) }],
          });
        }
        if (ref?.sessionId && ref.sessionId !== args.sessionId) {
          args = { ...args, sessionId: ref.sessionId };
        }
      }
      // `provenance` values are sessionIds too (the {stage: sessionId} map — see
      // src/playbooks.ts), so they get the SAME prefix treatment. Without this
      // the conductor would have to pass full 36-char UUIDs there while every
      // other worker reference takes 8 chars.
      // Ordering is load-bearing: this must run before the policy checkpoint
      // below, which compares these values against the projection's full ids.
      if (ctx.instances?.resolveSessionRef
          && hasSchemaProperty(tool.inputSchema, 'provenance')
          && isJsonRecord(args) && isJsonRecord(args.provenance)) {
        const resolved: Record<string, unknown> = { ...args.provenance };
        for (const [stage, value] of Object.entries(args.provenance)) {
          if (typeof value !== 'string' || !value) continue;
          const ref = ctx.instances.resolveSessionRef(value);
          if (ref && 'ambiguous' in ref) {
            return rpcResult(id, {
              content: [{ type: 'text', text: JSON.stringify(ambiguousRefusal(ref, value, `provenance.${stage}`)) }],
            });
          }
          if (ref?.sessionId) resolved[stage] = ref.sessionId;
        }
        args = { ...args, provenance: resolved };
      }
      // `forward.sessionId` (send_prompt) is a worker handle too, nested one
      // level deep, so the top-level chokepoint above misses it. Mirrors the
      // `provenance` loop; NOT generalised into one loop with the others — the
      // four sites differ in shape (scalar, map, nested, and `resume`'s
      // two-answer resolver) and the ordering comment above is load-bearing for
      // `provenance`.
      if (ctx.instances?.resolveSessionRef
          && hasSchemaProperty(tool.inputSchema, 'forward')
          && isJsonRecord(args) && isJsonRecord(args.forward)
          && typeof args.forward.sessionId === 'string' && args.forward.sessionId) {
        const ref = ctx.instances.resolveSessionRef(args.forward.sessionId);
        if (ref && 'ambiguous' in ref) {
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(ambiguousRefusal(ref, args.forward.sessionId, 'forward.sessionId')) }],
          });
        }
        if (ref?.sessionId) args = { ...args, forward: { ...args.forward, sessionId: ref.sessionId } };
      }
      // `resume` (spawn_instance) is a worker handle too — it just declares
      // `resume` rather than `sessionId`, so the top-level block above misses it.
      // TWO differences from the three sites above, both explained at
      // InstanceManager.resolveResumeRef:
      //   • it resolves over `byId` UNION the lineage store, because the ordinary
      //     resume target — a killed conductor worker, or any worker after an
      //     orchestrator restart — is not in `byId` at all;
      //   • it REWRITES THE ARG ONLY FOR A PREFIX. An exact segment id is left
      //     verbatim, because `resume` feeds create(), and create() opens the
      //     segment it is named; the public id the policy gate needs travels
      //     BESIDE it (`resumeHandle`) rather than in its place. Overwriting it
      //     would silently redirect the resume to the session's newest transcript.
      // Async, which is free here: this arm already awaits the gate and the
      // handler below.
      let resumeHandle: string | undefined;
      if (ctx.instances?.resolveResumeRef
          && hasSchemaProperty(tool.inputSchema, 'resume')
          && isJsonRecord(args)
          && typeof args.resume === 'string' && args.resume) {
        const ref = await ctx.instances.resolveResumeRef(args.resume);
        if (ref && 'ambiguous' in ref) {
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(ambiguousRefusal(ref, args.resume, 'resume')) }],
          });
        }
        if (ref) {
          resumeHandle = ref.handle;
          if (ref.resume !== args.resume) args = { ...args, resume: ref.resume };
        }
      }
      // Playbook policy — the ONE enforcement point, deliberately AFTER
      // validateArgs and after EVERY prefix-resolution pass above, and BEFORE
      // the handler. Inert unless the caller is a conductor with enforcement on;
      // see src/mcp/playbookGate.ts.
      const gate = await ctx.playbookGate.check({ toolName: name, args, callerId: ctx.callerId, resumeHandle });
      if ('refusal' in gate) {
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(gate.refusal) }] });
      }
      args = gate.args;
      try {
        const result = await tool.handler(args, ctx);
        // Ledger the move only now that it has actually happened. A throw skips
        // this entirely (see the catch below); a soft refusal is filtered inside
        // commit().
        if (gate.commit) await gate.commit(result);
        let content: Array<{ type: 'text'; text: string }>;
        if (isTextResult(result)) {
          // The rendering IS the whole result — one raw block, no metadata
          // block to parse (src/mcp/content.ts).
          content = [{ type: 'text', text: result.text }];
        } else if (isTextPayload(result)) {
          // Multi-block: compact-JSON metadata block, then one raw text block
          // per body, in order. Lets the LLM read file/diff/message bodies
          // un-escaped while still parsing structured metadata from content[0].
          content = [{ type: 'text', text: JSON.stringify(result.meta ?? null) }];
          for (const b of result.bodies) content.push({ type: 'text', text: String(b) });
        } else {
          content = [{ type: 'text', text: JSON.stringify(result ?? null) }];
        }
        return rpcResult(id, { content });
      } catch (e) {
        // Errors read best as prose for an LLM (content[0]); a structured
        // {error, code, statusCode} block follows for machine handling.
        const sc = errStatus(e);
        const code = errCode(e) ?? codeForStatus(sc);
        const msg = errMsg(e);
        const prose = sc ? `${msg} (HTTP ${sc})` : msg;
        return rpcResult(id, {
          content: [
            { type: 'text', text: prose },
            { type: 'text', text: JSON.stringify({ error: msg, ...(code ? { code } : {}), ...(sc ? { statusCode: sc } : {}) }) },
          ],
          isError: true,
        });
      }
    }
    if (isNotification) return null;
    return rpcError(id, -32601, `method not found: ${method}`);
  } catch (e) {
    if (isNotification) return null;
    return rpcError(id, -32603, errMessage(e) ?? 'internal error');
  }
}

export function buildMcpRouter({ instances, pluginHost }: { instances?: InstanceManagerLike | null; pluginHost?: McpPluginHostLike | null }): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: '8mb' }));

  const coreTools = buildTools();
  // One gate per router: it holds the folded ledger projection, and it subscribes
  // to the manager's status stream for retire / enforcement-toggle events.
  const playbookGate = createPlaybookGate({ instances });

  r.post('/', async (req, res) => {
    // Each spawned worker registers the MCP URL with its own stable INSTANCE id
    // baked into `?caller=` (see Instance.spawn). Resolve it HERE — the single
    // boundary — to that instance's CURRENT sessionId, so `callerId` stays a valid
    // sessionId for every downstream handler even after a `/clear` rotates the
    // session in place (the baked instanceId never changes; its sessionId does).
    // An absent param, or a handle that names no live instance, yields callerId=null
    // and any caller-dependent tool errors with a clear message.
    const callerHandle = typeof req.query.caller === 'string' && req.query.caller
      ? req.query.caller : null;
    const callerId = instances ? instances.callerSessionId(callerHandle) : null;
    // Per-request tool composition: core tools + the plugin tools visible to
    // this caller (scoping + dynamism land in this one line; tools/list and
    // tools/call read ctx.tools unchanged). init() is memoized — after the
    // first request it's a resolved promise. A plugin-subsystem failure must
    // never take the core tools down with it.
    let tools: McpTool[] = coreTools;
    if (pluginHost) {
      try {
        await pluginHost.init();
        tools = [...coreTools, ...pluginHost.toolsFor()];
      } catch (e) {
        console.warn('mcp: plugin tool composition failed:', errMessage(e) || e);
      }
    }
    const ctx: McpCtx = { instances, tools, callerId, playbookGate };
    const body: unknown = req.body;
    // Batch: array of requests → array of responses (notifications dropped).
    if (Array.isArray(body)) {
      const out: JsonRpcResponse[] = [];
      for (const msg of body) {
        const r1 = await dispatch(msg, ctx);
        if (r1) out.push(r1);
      }
      if (out.length === 0) {
        res.status(202).end();
        return;
      }
      res.json(out);
      return;
    }
    const r1 = await dispatch(body, ctx);
    if (!r1) {
      res.status(202).end();
      return;
    }
    res.json(r1);
  });

  // GET would be the SSE long-poll channel for server→client notifications.
  // We don't emit any, so reject explicitly rather than hanging the client.
  r.get('/', (req, res) => {
    res.status(405).json({ error: 'GET /mcp not supported (no server notifications in v1)' });
  });

  return r;
}
