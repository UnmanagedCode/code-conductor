// MCP tool result shaping. The MCP server wraps every handler return into the
// JSON-RPC tools/call `content[]` array. Most tools return a plain object that
// becomes a single compact-JSON block. The read tools whose whole answer is a
// rendering instead return a `textResult(text)` — one plain-text block, no JSON
// at all (see its comment below). Tools that carry a large text body (file
// contents, a unified diff, assistant prose) instead return a
// `textPayload(meta, bodies)` so the server can emit a compact-JSON metadata
// block PLUS one raw, UNESCAPED text block per body — far cheaper and more
// legible for the consuming LLM than escaping the body into a JSON string.

// THE MCP RESULT BUDGET: the most text (summed `content[].text` length) one
// tool result may carry. The Claude Code harness caps an MCP result at
// MAX_MCP_OUTPUT_TOKENS (default 25,000 tokens); a result whose chars/4
// estimate is at most half that is accepted without counting, while a larger
// one is token-counted and, over the limit, rejected outright
// ("result (N characters) exceeds maximum allowed tokens"). 50,000 chars is
// therefore the largest result every harness default accepts unconditionally.
export const MCP_RESULT_CHAR_BUDGET = 50_000;

// The budget for a raw body beside a metadata block whose one unbounded field is
// a path (PATH_MAX). A byte cap also bounds UTF-16 length (every code unit is
// at least one UTF-8 byte), so a byte cap at this value keeps the result inside
// the char budget.
export const MCP_BODY_BUDGET = MCP_RESULT_CHAR_BUDGET - 8 * 1024;

// The longest prefix of `s` that fits `maxBytes` of UTF-8, cut on a character
// boundary (never mid-sequence, so decoding adds no replacement char).
export function utf8Prefix(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let n = Math.max(0, maxBytes);
  while (n > 0 && (buf[n] & 0xc0) === 0x80) n--;
  return buf.subarray(0, n).toString('utf8');
}

// The summed text length of a (meta, bodies) payload exactly as the MCP server
// emits it — the quantity MCP_RESULT_CHAR_BUDGET bounds.
export function payloadChars(meta: unknown, bodies: unknown[]): number {
  let n = JSON.stringify(meta ?? null).length;
  for (const b of bodies) n += String(b).length;
  return n;
}

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

// The rendered read tools' channel — the recon read tools plus
// describe_playbook's success path: the whole result IS a plain-text rendering,
// emitted as one raw block with no metadata block at all. Same Symbol-tag
// discipline as textPayload, and for the same reason — the default path
// JSON-stringifies, so a bare string cannot express this, and sniffing
// `typeof result === 'string'` would silently reshape any plugin that returns a
// string through the bridge's `result` passthrough (src/plugins/mcpBridge.ts).
const TEXT_RESULT = Symbol('mcpTextResult');

export interface TextResult {
  [TEXT_RESULT]: true;
  text: string;
}

export function textResult(text: string): TextResult {
  return { [TEXT_RESULT]: true, text };
}

export function isTextResult(v: unknown): v is TextResult {
  return !!v && typeof v === 'object' && (v as Partial<TextResult>)[TEXT_RESULT] === true;
}

// Flatten a (meta, bodies) payload into the single string an LLM would read off
// the wire: the compact-JSON metadata block followed by each raw body block, in
// order — mirroring how the MCP server emits them as separate content[] blocks
// (src/mcp/server.ts). Used to fold a default get_recent_messages result inline
// into the idle-wake stub without re-deriving its shape. `renderWakeBodyInto`
// (public/foldedText.js) treats line 1 of that stub's body as the whole
// metadata block; without this being always a single line, a future
// multi-line meta rendering would silently break the client.
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
