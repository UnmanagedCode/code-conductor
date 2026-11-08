import { describe, expect, it } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { ConversationModel, type ToolNode } from './model';
import { feed, tool, toolResult } from './testkit';
import { flush, renderModel } from './renderModel';
import { JSON_TREE_MAX_CHARS } from './jsonTree';
import { RUN_CODE_TOOL } from './format';

const GENERIC = 'mcp__foo__bar';

function findTool(nodes: any[]): ToolNode | null {
  for (const n of nodes) {
    if (n.type === 'tool') return n;
    const found = findTool(n.children ?? []);
    if (found) return found;
  }
  return null;
}

async function show(m: ConversationModel) {
  const r = renderModel(m);
  await flush();
  const ag = within(r.root).queryByRole('button', { name: /actions?/ });
  if (ag?.getAttribute('data-state') === 'closed') fireEvent.click(ag);
  for (const t of r.root.querySelectorAll('[data-tool-trigger]')) if (t.getAttribute('data-state') === 'closed') fireEvent.click(t);
  await flush();
  return r;
}
function modelOf(name: string, input: Record<string, unknown>, result: unknown = null) {
  const m = new ConversationModel();
  feed(m, [...tool('m1', 0, 't1', name, { result: null, input }), ...(result === null ? [] : [toolResult({ toolUseId: 't1', content: result })])]);
  return m;
}
const q = (root: Element, sel: string) => root.querySelector(sel) as HTMLElement | null;
const qa = (root: Element, sel: string) => [...root.querySelectorAll(sel)] as HTMLElement[];
const header = (root: Element, label: string) =>
  qa(root, '[data-json-header]').find((h) => h.querySelector('button')?.getAttribute('aria-label') === label)!;
const expanded = (root: Element, label: string) => header(root, label).querySelector('button')!.getAttribute('aria-expanded');
const click = async (el: Element) => { fireEvent.click(el); await flush(); };

describe('a generic tool call\'s arguments', () => {
  it('render as a JSON tree inside the Arguments details, with no <pre>', async () => {
    const { root } = await show(modelOf(GENERIC, { name: 'x', n: 1.5, list: [1, 'a'] }));
    const args = q(root, '[data-tool-args]')!;
    expect(qa(args, '[data-json-tree]')).toHaveLength(1);
    expect(qa(args, 'pre')).toHaveLength(0);
    expect(qa(args, '[data-tok]').map((t) => [t.getAttribute('data-tok'), t.textContent])).toEqual([
      ['key', '"name"'], ['string', '"x"'], ['key', '"n"'], ['number', '1.5'], ['key', '"list"'], ['number', '1'], ['string', '"a"'],
    ]);
  });

  it('stay plain text while only partialJson has arrived', async () => {
    const m = new ConversationModel();
    feed(m, [
      { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 't1', name: GENERIC },
      { kind: 'tool_use_input_delta', msgId: 'm1', blockIdx: 0, toolUseId: 't1', partialJson: '{"a": {"b": [1, ' },
    ] as any);
    expect(findTool(m.items)!.input).toBeNull();
    const { root } = await show(m);
    const args = q(root, '[data-tool-args]')!;
    expect(qa(args, '[data-json-tree]')).toHaveLength(0);
    expect(q(args, 'pre')!.textContent).toBe('{"a": {"b": [1, ');
  });

  it('fall back to plain text when the input cannot be stringified, without throwing', async () => {
    const m = modelOf(GENERIC, {});
    const node = findTool(m.items)!;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    node.input = circular;
    node.partialJson = '{"raw":1}';
    const { root } = await show(m);
    const args = q(root, '[data-tool-args]')!;
    expect(qa(args, '[data-json-tree]')).toHaveLength(0);
    expect(q(args, 'pre')!.textContent).toBe('{"raw":1}');
  });

  it('fall back to plain text past JSON_TREE_MAX_CHARS', async () => {
    const big = 'x'.repeat(JSON_TREE_MAX_CHARS);
    const { root } = await show(modelOf(GENERIC, { big }));
    const args = q(root, '[data-tool-args]')!;
    expect(qa(args, '[data-json-tree]')).toHaveLength(0);
    expect(q(args, 'pre')!.textContent).toContain(big);
  });
});

describe('specialised argument renderers are not trees', () => {
  const cases: [string, string, Record<string, unknown>, string][] = [
    ['Bash', 'Bash', { command: 'ls -la' }, 'ls -la'],
    ['send_prompt', 'mcp__code-conductor__send_prompt', { text: 'hello there', id: 'a' }, 'hello there'],
    ['run_code', RUN_CODE_TOOL, { code: 'return 1;' }, 'return'],
    ['Edit', 'Edit', { file_path: '/f.ts', old_string: 'a', new_string: 'b' }, '/f.ts'],
    ['Write', 'Write', { file_path: '/g.ts', content: 'one\ntwo' }, '/g.ts'],
    ['NotebookEdit', 'NotebookEdit', { notebook_path: '/n.ipynb', new_source: 'x = 1' }, '/n.ipynb'],
  ];
  for (const [label, name, input, shownText] of cases) {
    it(label, async () => {
      const { root } = await show(modelOf(name, input));
      const args = q(root, '[data-tool-args]') ?? root;
      expect(qa(root, '[data-json-tree]')).toHaveLength(0);
      expect(args.textContent).toContain(shownText);
    });
  }
});

describe('argument folds', () => {
  // 250 numbers push the tree past the small-tree gate, so only shallow containers start open: "a" (depth 1) open, "b" (depth 2) closed.
  const nested = { a: { b: { c: Array.from({ length: 250 }, (_, i) => i) } } };

  it('persist on the node and across a remount, against the default either way', async () => {
    const m = modelOf(GENERIC, nested);
    const first = await show(m);
    let args = q(first.root, '[data-tool-args]')!;
    expect(expanded(args, '"a"')).toBe('true');
    expect(expanded(args, '"b"')).toBe('false');
    await click(header(args, '"b"'));
    await click(header(args, '"a"'));
    expect(expanded(args, '"a"')).toBe('false');
    expect(Object.values(findTool(m.items)!.reader.argsFolds).sort()).toEqual([false, true]);
    first.unmount();

    const second = await show(m);
    args = q(second.root, '[data-tool-args]')!;
    expect(expanded(args, '"a"')).toBe('false');
    // "b" was opened, but sits under the folded "a": open "a" again and "b" is still open.
    await click(header(args, '"a"'));
    expect(expanded(args, '"b"')).toBe('true');
  });

  it('are independent of result folds that share a container id', async () => {
    const same = { x: { y: 1 } };
    const m = modelOf(GENERIC, same, [{ type: 'text', text: JSON.stringify(same) }]);
    const { root } = await show(m);
    const args = q(root, '[data-tool-args]')!;
    const res = q(root, '[data-tool-result]')!;
    expect(expanded(args, '"x"')).toBe('true');
    expect(expanded(res, '"x"')).toBe('true');

    await click(header(args, '"x"'));
    expect(expanded(args, '"x"')).toBe('false');
    expect(expanded(res, '"x"')).toBe('true');
    expect(findTool(m.items)!.result!.reader.folds).toEqual({});

    await click(header(res, '"x"'));
    await click(header(args, '"x"'));
    expect(expanded(args, '"x"')).toBe('true');
    expect(expanded(res, '"x"')).toBe('false');
  });
});
