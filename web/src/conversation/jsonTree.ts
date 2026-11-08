// A lossless, iterative JSON parser for tool results: it keeps the raw source text of every
// scalar and key and only re-lays the whitespace, so what the reader sees is what the tool emitted
// (no big-integer rounding, `1.0` stays `1.0`, key order and duplicate keys are kept). An explicit
// stack, no recursion, so arbitrarily deep nesting cannot overflow the call stack.

export const JSON_TREE_MAX_CHARS = 65_536;
export const SMALL_TREE_NODES = 200;
export const DEFAULT_OPEN_DEPTH = 2;
export const DEFAULT_OPEN_MAX_CHILDREN = 50;
export const MAX_TREE_DEPTH = 100;

export type JsonScalarKind = 'string' | 'number' | 'boolean' | 'null';
export type JsonNode =
  | { id: number; depth: number; kind: JsonScalarKind; text: string }
  | { id: number; depth: number; kind: 'object'; start: number; end: number; entries: { key: string; value: JsonNode }[] }
  | { id: number; depth: number; kind: 'array'; start: number; end: number; items: JsonNode[] };
export type JsonContainer = Extract<JsonNode, { kind: 'object' | 'array' }>;
export type JsonDoc = { root: JsonNode; size: number };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX = /^[0-9a-fA-F]{4}$/;

export const childCount = (n: JsonContainer): number => (n.kind === 'object' ? n.entries.length : n.items.length);

type Frame = { node: JsonContainer; state: 'start' | 'next' | 'value'; key: string | null };

/** Parses `src` strictly (RFC 8259); null unless its root is an object or array. Throws on malformed input. */
export function parseJsonTree(src: string): JsonDoc | null {
  let i = 0;
  let nextId = 0;
  const len = src.length;
  const ws = () => { while (i < len) { const c = src.charCodeAt(i); if (c === 32 || c === 10 || c === 13 || c === 9) i++; else break; } };
  const fail = (what: string): never => { throw new SyntaxError(`${what} at ${i}`); };
  const readString = (): string => {
    const from = i;
    i++;
    for (;;) {
      if (i >= len) fail('unterminated string');
      const c = src.charCodeAt(i);
      if (c === 34) { i++; return src.slice(from, i); }
      if (c < 0x20) fail('control character in string');
      if (c === 92) {
        const e = src[i + 1];
        if (e === 'u') { if (!HEX.test(src.slice(i + 2, i + 6))) fail('bad unicode escape'); i += 6; }
        else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail('bad escape');
      } else i++;
    }
  };
  const readScalar = (depth: number): JsonNode => {
    const c = src[i];
    const id = nextId++;
    if (c === '"') return { id, depth, kind: 'string', text: readString() };
    for (const lit of ['true', 'false', 'null'] as const) {
      if (src.startsWith(lit, i)) { i += lit.length; return { id, depth, kind: lit === 'null' ? 'null' : 'boolean', text: lit }; }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(src);
    if (!m) return fail('unexpected token');
    i += m[0].length;
    return { id, depth, kind: 'number', text: m[0] };
  };

  ws();
  if (src[i] !== '{' && src[i] !== '[') return null;
  const stack: Frame[] = [];
  let root: JsonNode | null = null;
  const attach = (node: JsonNode) => {
    const f = stack[stack.length - 1];
    if (!f) { root = node; return; }
    if (f.node.kind === 'array') f.node.items.push(node);
    else f.node.entries.push({ key: f.key!, value: node });
    f.state = 'next';
  };
  const readValue = () => {
    ws();
    const c = src[i];
    if (c === '{' || c === '[') {
      const id = nextId++;
      const node: JsonContainer = c === '{'
        ? { id, depth: stack.length, kind: 'object', start: i, end: i, entries: [] }
        : { id, depth: stack.length, kind: 'array', start: i, end: i, items: [] };
      i++;
      attach(node);
      stack.push({ node, state: 'start', key: null });
    } else attach(readScalar(stack.length));
  };

  readValue();
  while (stack.length) {
    const f = stack[stack.length - 1];
    ws();
    const c = src[i];
    const close = f.node.kind === 'object' ? '}' : ']';
    if (f.state === 'value') { readValue(); continue; }
    if (c === close) {
      i++;
      f.node.end = i;
      stack.pop();
      continue;
    }
    if (f.state === 'next') {
      if (c !== ',') fail('expected , or ' + close);
      i++;
    }
    if (f.node.kind === 'object') {
      ws();
      if (src[i] !== '"') fail('expected key');
      f.key = readString();
      ws();
      if (src[i] !== ':') fail('expected :');
      i++;
    }
    f.state = 'value';
  }
  ws();
  if (i !== len) fail('trailing content');
  return { root: root!, size: nextId };
}

/** The tree for `text`, or null when it is not an object/array, is malformed, or is over the size gate. */
export function detectJson(text: string): JsonDoc | null {
  if (text.length > JSON_TREE_MAX_CHARS) return null;
  try { return parseJsonTree(text); } catch { return null; }
}

/** Whether a container starts open: all of a small tree, else only the shallow, narrow ones. */
export function defaultOpen(node: JsonNode, doc: JsonDoc): boolean {
  if (node.kind !== 'object' && node.kind !== 'array') return false;
  if (doc.size <= SMALL_TREE_NODES) return true;
  return node.depth < DEFAULT_OPEN_DEPTH && childCount(node) <= DEFAULT_OPEN_MAX_CHILDREN;
}

export type ResultPart = { kind: 'text'; text: string } | { kind: 'json'; text: string; doc: JsonDoc };

/** One part per JSON block; adjacent non-JSON blocks merge with '\n', as the plain rendering joins them. */
export function toResultParts(texts: string[]): ResultPart[] {
  const parts: ResultPart[] = [];
  for (const text of texts) {
    const doc = detectJson(text);
    if (doc) { parts.push({ kind: 'json', text, doc }); continue; }
    const last = parts[parts.length - 1];
    if (last?.kind === 'text') last.text += '\n' + text;
    else parts.push({ kind: 'text', text });
  }
  return parts;
}
