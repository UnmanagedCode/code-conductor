// MCP tool result shaping. The MCP server wraps every handler return into the
// JSON-RPC tools/call `content[]` array. Most tools return a plain object that
// becomes a single compact-JSON block. The recon read tools instead return a
// `renderedResult(text, structured)` — plain text in content[], the object in
// `structuredContent`. Tools that carry a large text body
// (file contents, a unified diff, assistant prose) instead return a
// `textPayload(meta, bodies)` so the server can emit a compact-JSON metadata
// block PLUS one raw, UNESCAPED text block per body — far cheaper and more
// legible for the consuming LLM than escaping the body into a JSON string.

const PAYLOAD = Symbol('mcpTextPayload');

export interface TextPayload {
  [PAYLOAD]: true;
  meta: unknown;
  bodies: unknown[];
}

// Returns a tagged wrapper. `meta` → ONE compact-JSON block (content[0]); each
// entry of `bodies` → ONE raw text block appended after it, in order. The
// Symbol key is non-enumerable to JSON.stringify and can't collide with a
// handler's real data, so a handler can never accidentally trip this path.
export function textPayload(meta: unknown, bodies: unknown): TextPayload {
  const arr = bodies == null ? [] : (Array.isArray(bodies) ? bodies : [bodies]);
  return { [PAYLOAD]: true, meta, bodies: arr };
}

export function isTextPayload(v: unknown): v is TextPayload {
  return !!v && typeof v === 'object' && (v as Partial<TextPayload>)[PAYLOAD] === true;
}

// The recon read tools' channel — the inverse of textPayload. Their payload is
// nested JSON an LLM reads badly, so the TEXT is primary (content[0], the whole
// content[]) and the object moves out of content[] entirely into MCP
// `structuredContent`, where a programmatic consumer still gets every field.
// `structured` must be an object: the MCP spec types structuredContent as one,
// so an array payload is wrapped under a named key by its handler.
const RENDERED = Symbol('mcpRenderedResult');

export interface RenderedResult {
  [RENDERED]: true;
  text: string;
  structured: Record<string, unknown>;
}

export function renderedResult(text: string, structured: Record<string, unknown>): RenderedResult {
  return { [RENDERED]: true, text, structured };
}

export function isRenderedResult(v: unknown): v is RenderedResult {
  return !!v && typeof v === 'object' && (v as Partial<RenderedResult>)[RENDERED] === true;
}

// Flatten a (meta, bodies) payload into the single string an LLM would read off
// the wire: the compact-JSON metadata block followed by each raw body block, in
// order — mirroring how the MCP server emits them as separate content[] blocks
// (src/mcp/server.ts). Used to fold a default get_recent_messages result inline
// into the idle-subscription wake stub without re-deriving its shape.
export function flattenPayload(meta: unknown, bodies: unknown): string {
  const arr = bodies == null ? [] : (Array.isArray(bodies) ? bodies : [bodies]);
  return [JSON.stringify(meta ?? null), ...arr.map(String)].join('\n\n');
}

// Map a handler error's HTTP-ish statusCode to a stable machine code. Returns
// null when there's no recognized status (the error surfaces as prose only).
export function codeForStatus(s: unknown): string | null {
  const codes: Record<string, string> = {
    '400': 'BAD_REQUEST',
    '404': 'NOT_FOUND',
    '409': 'CONFLICT',
    '500': 'INTERNAL',
  };
  return codes[String(s)] ?? null;
}
