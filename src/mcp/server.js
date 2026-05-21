// MCP (Model Context Protocol) server, mounted at /mcp on the orchestrator's
// existing http server. Streamable HTTP transport, JSON-RPC 2.0 over POST,
// no SSE — every tool result fits in a single application/json response.
//
// Exposes the orchestrator's verbs (spawn / list / send_prompt / read
// transcript / worktree ops) as MCP tools so a Claude session can drive
// the orchestrator directly via `claude mcp add --transport http
// claude-orch http://127.0.0.1:8787/mcp`.

import express from 'express';
import { buildTools } from './tools.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'claude-orch';
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
// named properties, scalar types, required keys. Returns null on success
// or a string describing the first violation. No $ref / oneOf / anyOf —
// the registry doesn't use those.
function validateArgs(schema, args) {
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
    if (!p) continue; // tolerant of extras
    const t = p.type;
    if (t && !typeMatches(t, v)) {
      return `argument '${k}' must be ${Array.isArray(t) ? t.join(' | ') : t}`;
    }
    if (p.enum && !p.enum.includes(v)) {
      return `argument '${k}' must be one of ${JSON.stringify(p.enum)}`;
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
      }));
      return rpcResult(id, { tools });
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = ctx.tools.find(t => t.name === name);
      if (!tool) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        });
      }
      const v = validateArgs(tool.inputSchema, args);
      if (v) {
        return rpcResult(id, {
          content: [{ type: 'text', text: v }],
          isError: true,
        });
      }
      try {
        const result = await tool.handler(args, ctx);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }],
        });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: 'text', text: e?.message ?? String(e) }],
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

export function buildMcpRouter({ instances }) {
  const r = express.Router();
  r.use(express.json({ limit: '8mb' }));

  const tools = buildTools();
  const ctx = { instances, tools };

  r.post('/', async (req, res) => {
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
