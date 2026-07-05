// MCP tool result shaping. The MCP server wraps every handler return into the
// JSON-RPC tools/call `content[]` array. Most tools return a plain object that
// becomes a single compact-JSON block. Tools that carry a large text body
// (file contents, a unified diff, assistant prose) instead return a
// `textPayload(meta, bodies)` so the server can emit a compact-JSON metadata
// block PLUS one raw, UNESCAPED text block per body — far cheaper and more
// legible for the consuming LLM than escaping the body into a JSON string.

const PAYLOAD = Symbol('mcpTextPayload');

// Returns a tagged wrapper. `meta` → ONE compact-JSON block (content[0]); each
// entry of `bodies` → ONE raw text block appended after it, in order. The
// Symbol key is non-enumerable to JSON.stringify and can't collide with a
// handler's real data, so a handler can never accidentally trip this path.
export function textPayload(meta, bodies) {
  const arr = bodies == null ? [] : (Array.isArray(bodies) ? bodies : [bodies]);
  return { [PAYLOAD]: true, meta, bodies: arr };
}

export function isTextPayload(v) {
  return !!v && typeof v === 'object' && v[PAYLOAD] === true;
}

// Flatten a (meta, bodies) payload into the single string an LLM would read off
// the wire: the compact-JSON metadata block followed by each raw body block, in
// order — mirroring how the MCP server emits them as separate content[] blocks
// (src/mcp/server.js). Used to fold a default get_recent_messages result inline
// into the idle-subscription wake stub without re-deriving its shape.
export function flattenPayload(meta, bodies) {
  const arr = bodies == null ? [] : (Array.isArray(bodies) ? bodies : [bodies]);
  return [JSON.stringify(meta ?? null), ...arr.map(String)].join('\n\n');
}

// Map a handler error's HTTP-ish statusCode to a stable machine code. Returns
// null when there's no recognized status (the error surfaces as prose only).
export function codeForStatus(s) {
  return ({ 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT', 500: 'INTERNAL' })[s] ?? null;
}
