// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { defaultOpen, detectJson, JSON_TREE_MAX_CHARS, parseJsonTree, toResultParts, type JsonNode } from './jsonTree';

const walk = (n: JsonNode, out: JsonNode[] = []): JsonNode[] => {
  const stack = [n];
  while (stack.length) {
    const x = stack.pop()!;
    out.push(x);
    if (x.kind === 'object') for (let i = x.entries.length - 1; i >= 0; i--) stack.push(x.entries[i].value);
    else if (x.kind === 'array') for (let i = x.items.length - 1; i >= 0; i--) stack.push(x.items[i]);
  }
  return out;
};

describe('detectJson', () => {
  it('accepts an object or array root, whitespace around it allowed', () => {
    for (const s of ['{}', '[]', '{"a":1}', '  [1,2]\n']) expect(detectJson(s), s).not.toBeNull();
  });

  it('refuses scalars, empty input, malformed JSON, trailing content and two values', () => {
    const bad = ['42', '"s"', 'true', 'null', '', '{"a":}', "{'a':1}", '[1,]', '{"a":1} x', '{"a":1}{"b":2}', 'NaN', '[01]',
      '{"a":"x\ny"}', '{"a":"\\x"}', '{"a":1,}', '[1 2]', '{"a" 1}', '{1:2}', '[', '{"a":"\\u12"}', '[-]', '[1.]', '[.5]', '[+1]'];
    for (const s of bad) expect(detectJson(s), JSON.stringify(s)).toBeNull();
  });

  it('refuses valid JSON one character over the size gate and accepts it at the gate', () => {
    const at = `["${'x'.repeat(JSON_TREE_MAX_CHARS - 4)}"]`;
    expect(at.length).toBe(JSON_TREE_MAX_CHARS);
    expect(detectJson(at)).not.toBeNull();
    expect(detectJson(`["${'x'.repeat(JSON_TREE_MAX_CHARS - 3)}"]`)).toBeNull();
  });
});

describe('parseJsonTree fidelity', () => {
  it('keeps key order (integer-like keys included) and duplicate keys', () => {
    const doc = parseJsonTree('{"b":1,"2":2,"1":3,"b":4}')!;
    expect(doc.root.kind === 'object' && doc.root.entries.map((e) => e.key)).toEqual(['"b"', '"2"', '"1"', '"b"']);
  });

  it('keeps the raw text of scalars: big integers, trailing zeros, exponents, escapes', () => {
    const doc = parseJsonTree('[12345678901234567890,1.0,1e3,-0,"a\\nb\\u00e9","  a  b ",true,false,null]')!;
    const items = doc.root.kind === 'array' ? doc.root.items : [];
    expect(items.map((i) => [i.kind, 'text' in i ? i.text : ''])).toEqual([
      ['number', '12345678901234567890'], ['number', '1.0'], ['number', '1e3'], ['number', '-0'],
      ['string', '"a\\nb\\u00e9"'], ['string', '"  a  b "'], ['boolean', 'true'], ['boolean', 'false'], ['null', 'null'],
    ]);
  });

  it('numbers nodes by pre-order index, counts them in size, and records depth and source span', () => {
    const src = '{"a":[1,{"b":2}],"c":3}';
    const doc = parseJsonTree(src)!;
    const nodes = walk(doc.root);
    expect(nodes.map((n) => n.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(doc.size).toBe(6);
    expect(nodes.map((n) => n.depth)).toEqual([0, 1, 2, 2, 3, 1]);
    const arr = nodes[1];
    expect(arr.kind === 'array' && src.slice(arr.start, arr.end)).toBe('[1,{"b":2}]');
  });
});

describe('parseJsonTree totality', () => {
  it('parses nesting far past the call stack without throwing, the deepest node at depth n-1', () => {
    for (const n of [20_000, 100_000]) {
      const doc = parseJsonTree('['.repeat(n) + ']'.repeat(n))!;
      expect(doc.size).toBe(n);
      let node: JsonNode = doc.root;
      let depth = 0;
      while (node.kind === 'array' && node.items.length) { node = node.items[0]; depth++; }
      expect(depth).toBe(n - 1);
      expect(node.depth).toBe(n - 1);
    }
  });

  it('returns null for unbalanced deep input instead of throwing', () => {
    expect(detectJson('['.repeat(20_000))).toBeNull();
    expect(detectJson('['.repeat(20_000) + ']'.repeat(19_999))).toBeNull();
  });
});

describe('defaultOpen', () => {
  const arrayOf = (n: number, body: string) => `[${Array.from({ length: n }, () => body).join(',')}]`;

  it('opens every container of a small tree', () => {
    const doc = parseJsonTree('{"a":{"b":{"c":{"d":[1]}}}}')!;
    expect(walk(doc.root).filter((n) => n.kind === 'object' || n.kind === 'array').map((n) => defaultOpen(n, doc))).toEqual([true, true, true, true, true]);
  });

  it('in a large tree opens only depth < 2 and at most 50 children', () => {
    const doc = parseJsonTree(`{"deep":{"mid":{"x":${arrayOf(250, '1')}}},"wide":${arrayOf(51, '1')},"edge":${arrayOf(50, '1')}}`)!;
    const root = doc.root as Extract<JsonNode, { kind: 'object' }>;
    const by = Object.fromEntries(root.entries.map((e) => [e.key, e.value]));
    expect(doc.size).toBeGreaterThan(200);
    expect(defaultOpen(root, doc)).toBe(true);
    expect(defaultOpen(by['"deep"'], doc)).toBe(true);
    const mid = (by['"deep"'] as Extract<JsonNode, { kind: 'object' }>).entries[0].value;
    expect(mid.depth).toBe(2);
    expect(defaultOpen(mid, doc)).toBe(false);
    expect(defaultOpen(by['"wide"'], doc)).toBe(false);
    expect(defaultOpen(by['"edge"'], doc)).toBe(true);
  });
});

describe('toResultParts', () => {
  it('merges all-text blocks into one part joined by newlines', () => {
    expect(toResultParts(['a', '42', 'b'])).toEqual([{ kind: 'text', text: 'a\n42\nb' }]);
    expect(toResultParts([])).toEqual([]);
  });

  it('keeps block order around JSON blocks', () => {
    const parts = toResultParts(['{"a":1}', 'out']);
    expect(parts.map((p) => p.kind)).toEqual(['json', 'text']);
    expect(toResultParts(['x', '[1]', 'y', 'z']).map((p) => [p.kind, p.text])).toEqual([['text', 'x'], ['json', '[1]'], ['text', 'y\nz']]);
    expect(toResultParts(['{}', '[]']).map((p) => p.kind)).toEqual(['json', 'json']);
  });
});
