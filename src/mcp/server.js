// MCP (Model Context Protocol) server, mounted at /mcp on the orchestrator's
// existing http server. Streamable HTTP transport, JSON-RPC 2.0 over POST,
// no SSE — every tool result fits in a single application/json response.
//
// Exposes the orchestrator's verbs (spawn / list / send_prompt / read
// transcript / worktree ops) as MCP tools so a Claude session can drive
// the orchestrator directly via `claude mcp add --transport http
// code-conductor http://127.0.0.1:8787/mcp`.

import express from 'express';
import { buildTools } from './tools.js';
import { isTextPayload, codeForStatus } from './content.js';
import { SESSION_PREFIX_MIN } from '../instances.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'code-conductor';
const SERVER_VERSION = '0.1.0';
const JSONRPC = '2.0';

function rpcResult(id, result) {
  return { jsonrpc: JSONRPC, id, result };
}
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: JSONRPC, id, error: err };
}

// Shallow JSON-Schema validation. Covers the shapes we use: object with
// named properties, scalar types, required keys, plus the constraint keywords
// our schemas declare (enum, pattern, min/maxLength, minimum/maximum, array
// items.type). Returns null on success or a string describing the first
// violation. No $ref / oneOf / anyOf — the registry doesn't use those.
// Unknown properties are rejected (clean MCP contract — no silent drops).
function validateArgs(schema, args, toolName) {
  if (!schema || schema.type !== 'object') return null;
  const a = args ?? {};
  if (typeof a !== 'object' || Array.isArray(a)) return 'arguments must be an object';
  const req = Array.isArray(schema.required) ? schema.required : [];
  for (const k of req) {
    if (!(k in a)) return `missing required argument: ${k}`;
  }
  const props = schema.properties ?? {};
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (!p) {
      const allowed = Object.keys(props).join(', ') || '(none)';
      return `unexpected argument '${k}' — not a recognized parameter for ${toolName ?? 'this tool'}. Allowed: ${allowed}`;
    }
    const viol = checkConstraints(k, v, p);
    if (viol) return viol;
  }
  return null;
}

// Validate a single value against its property schema. Returns a violation
// string or null. Skips constraint checks when the type doesn't match the
// constraint's domain (the type error already fired, or the keyword is N/A).
function checkConstraints(k, v, p) {
  const t = p.type;
  if (t && !typeMatches(t, v)) {
    return `argument '${k}' must be ${Array.isArray(t) ? t.join(' | ') : t}`;
  }
  if (p.enum && !p.enum.includes(v)) {
    return `argument '${k}' must be one of ${JSON.stringify(p.enum)}`;
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
  if (Array.isArray(v) && p.items && p.items.type) {
    for (let i = 0; i < v.length; i++) {
      if (!typeMatches(p.items.type, v[i])) {
        return `argument '${k}[${i}]' must be ${p.items.type}`;
      }
    }
  }
  return null;
}

function typeMatches(t, v) {
  const ts = Array.isArray(t) ? t : [t];
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

async function dispatch(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== JSONRPC) {
    return rpcError(msg?.id ?? null, -32600, 'invalid JSON-RPC request');
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
      const name = params?.name;
      let args = params?.arguments ?? {};
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
          && tool.inputSchema?.properties?.sessionId
          && typeof args.sessionId === 'string' && args.sessionId) {
        const ref = ctx.instances.resolveSessionRef(args.sessionId);
        if (ref?.ambiguous) {
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
        let content;
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
        const sc = typeof e?.statusCode === 'number' ? e.statusCode : null;
        const code = e?.code ?? codeForStatus(sc);
        const msg = e?.message ?? String(e);
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
    return rpcError(id, -32603, e?.message ?? 'internal error');
  }
}

export function buildMcpRouter({ instances, pluginHost }) {
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
    let tools = coreTools;
    if (pluginHost) {
      try {
        await pluginHost.init();
        tools = [...coreTools, ...pluginHost.toolsFor(callerId)];
      } catch (e) {
        console.warn('mcp: plugin tool composition failed:', e?.message || e);
      }
    }
    const ctx = { instances, tools, callerId };
    const body = req.body;
    // Batch: array of requests → array of responses (notifications dropped).
    if (Array.isArray(body)) {
      const out = [];
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
