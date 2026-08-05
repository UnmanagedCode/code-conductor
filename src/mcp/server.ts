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
import { isTextPayload, codeForStatus } from './content.ts';
import { SESSION_PREFIX_MIN } from '../instances.ts';
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
  toolsFor(callerId: string): Array<{
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

// Shallow JSON-Schema validation. Covers the shapes we use: object with
// named properties, scalar types, required keys, plus the constraint keywords
// our schemas declare (enum, pattern, min/maxLength, minimum/maximum, array
// items.type). Returns null on success or a string describing the first
// violation. No $ref / oneOf / anyOf — the registry doesn't use those.
// Unknown properties are rejected (clean MCP contract — no silent drops).
function validateArgs(schema: unknown, args: unknown, toolName: unknown): string | null {
  if (!isJsonRecord(schema) || schema.type !== 'object') return null;
  const a = args ?? {};
  if (!isJsonRecord(a)) return 'arguments must be an object';
  const req = Array.isArray(schema.required) ? schema.required : [];
  for (const k of req) {
    if (typeof k !== 'string' || !(k in a)) return `missing required argument: ${k}`;
  }
  const props = asRecord(schema.properties);
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (!p) {
      const allowed = Object.keys(props).join(', ') || '(none)';
      return `unexpected argument '${k}' — not a recognized parameter for ${toolName ?? 'this tool'}. Allowed: ${allowed}`;
    }
    const viol = checkConstraints(k, v, asRecord(p));
    if (viol) return viol;
  }
  return null;
}

// Validate a single value against its property schema. Returns a violation
// string or null. Skips constraint checks when the type doesn't match the
// constraint's domain (the type error already fired, or the keyword is N/A).
function checkConstraints(k: string, v: unknown, p: Record<string, unknown>): string | null {
  const t = p.type;
  if (t && !typeMatches(t, v)) {
    return `argument '${k}' must be ${Array.isArray(t) ? t.join(' | ') : t}`;
  }
  const en = p.enum;
  if (typeof en === 'string' && en) {
    if (!en.includes(String(v))) return `argument '${k}' must be one of ${JSON.stringify(en)}`;
  } else if (Array.isArray(en) && !en.includes(v)) {
    return `argument '${k}' must be one of ${JSON.stringify(en)}`;
  }
  if (typeof v === 'string') {
    if (typeof p.minLength === 'number' && v.length < p.minLength) {
      return `argument '${k}' must be at least ${p.minLength} character(s)`;
    }
    if (typeof p.maxLength === 'number' && v.length > p.maxLength) {
      return `argument '${k}' must be at most ${p.maxLength} character(s)`;
    }
    if (typeof p.pattern === 'string' && !new RegExp(p.pattern).test(v)) {
      return `argument '${k}' must match ${p.pattern}`;
    }
  }
  if (typeof v === 'number') {
    if (typeof p.minimum === 'number' && v < p.minimum) {
      return `argument '${k}' must be >= ${p.minimum}`;
    }
    if (typeof p.maximum === 'number' && v > p.maximum) {
      return `argument '${k}' must be <= ${p.maximum}`;
    }
  }
  if (Array.isArray(v) && isJsonRecord(p.items) && p.items.type) {
    for (let i = 0; i < v.length; i++) {
      if (!typeMatches(p.items.type, v[i])) {
        return `argument '${k}[${i}]' must be ${p.items.type}`;
      }
    }
  }
  return null;
}

function typeMatches(t: unknown, v: unknown): boolean {
  const ts: unknown[] = Array.isArray(t) ? t : [t];
  for (const one of ts) {
    if (one === 'string' && typeof v === 'string') return true;
    if (one === 'number' && typeof v === 'number') return true;
    if (one === 'integer' && Number.isInteger(v)) return true;
    if (one === 'boolean' && typeof v === 'boolean') return true;
    if (one === 'object' && v && typeof v === 'object' && !Array.isArray(v)) return true;
    if (one === 'array' && Array.isArray(v)) return true;
    if (one === 'null' && v === null) return true;
  }
  return false;
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

// True when a tool's inputSchema declares a `sessionId` property with a
// truthy value — the schema gate for the prefix-resolution chokepoint below.
function hasSessionIdProperty(schema: unknown): boolean {
  if (!isJsonRecord(schema)) return false;
  const props = schema.properties;
  if (!isJsonRecord(props)) return false;
  return 'sessionId' in props && !!props.sessionId;
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
          && hasSessionIdProperty(tool.inputSchema)
          && isJsonRecord(args)
          && typeof args.sessionId === 'string' && args.sessionId) {
        const ref = ctx.instances.resolveSessionRef(args.sessionId);
        if (ref && 'ambiguous' in ref) {
          const matches = ref.ambiguous.map(s => s.slice(0, 8));
          const reason = ref.tooShort
            ? `session prefix "${args.sessionId}" is too short — pass at least ${SESSION_PREFIX_MIN} characters or a full sessionId. Candidates: ${matches.join(', ')}.`
            : `session prefix "${args.sessionId}" matches ${ref.ambiguous.length} sessions — pass more characters or a full sessionId. Candidates: ${matches.join(', ')}.`;
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify({
              ok: false, code: 'SESSION_AMBIGUOUS', sessionId: args.sessionId, reason, matches,
            }) }],
          });
        }
        if (ref?.sessionId && ref.sessionId !== args.sessionId) {
          args = { ...args, sessionId: ref.sessionId };
        }
      }
      try {
        const result = await tool.handler(args, ctx);
        let content: Array<{ type: 'text'; text: string }>;
        if (isTextPayload(result)) {
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
        tools = [...coreTools, ...pluginHost.toolsFor(callerId ?? '')];
      } catch (e) {
        console.warn('mcp: plugin tool composition failed:', errMessage(e) || e);
      }
    }
    const ctx: McpCtx = { instances, tools, callerId };
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
