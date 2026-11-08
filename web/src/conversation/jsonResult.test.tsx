import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { ConversationModel, type ResultNode } from './model';
import { feed, tool, toolResult } from './testkit';
import { flush, renderModel } from './renderModel';
import { MAX_TREE_DEPTH } from './jsonTree';

const TOOL = 'mcp__code-conductor__project_bash';
const text = (t: string) => ({ type: 'text', text: t });

/** The first result node under `nodes`, looking through assistant and group children and a tool's result. */
function findResult(nodes: any[]): ResultNode | null {
  for (const n of nodes) {
    if (n.type === 'result') return n;
    const found = findResult([...(n.children ?? []), ...(n.result ? [n.result] : [])]);
    if (found) return found;
  }
  return null;
}

async function shown(content: unknown) {
  const m = new ConversationModel();
  feed(m, [...tool('m1', 0, 't1', TOOL, { result: null, input: { command: 'x' } }), toolResult({ toolUseId: 't1', content })]);
  const r = renderModel(m);
  await flush();
  const ag = within(r.root).getByRole('button', { name: /actions?/ });
  if (ag.getAttribute('data-state') === 'closed') fireEvent.click(ag);
  for (const t of r.root.querySelectorAll('[data-tool-trigger]')) if (t.getAttribute('data-state') === 'closed') fireEvent.click(t);
  await flush();
  return { m, root: r.root, unmount: r.unmount, result: () => findResult(m.items)! };
}
const click = async (el: Element) => { fireEvent.click(el); await flush(); };
const q = (root: Element, sel: string) => root.querySelector(sel) as HTMLElement | null;
const qa = (root: Element, sel: string) => [...root.querySelectorAll(sel)] as HTMLElement[];
const header = (root: Element, label: string) =>
  qa(root, '[data-json-header]').find((h) => h.querySelector('button')?.getAttribute('aria-label') === label)!;
const resultPres = (root: Element) => qa(root, '[data-tool-result] pre');

afterEach(() => { vi.unstubAllGlobals(); });

describe('a JSON tool result', () => {
  const SRC = '{"name":"x","note":"  a  b ","n":1.50,"ok":true,"none":null,"list":[1,"a"],"obj":{}}';

  it('renders as an indented tree with a token kind per value, losslessly', async () => {
    const { root } = await shown([text(SRC)]);
    const tree = q(root, '[data-json-tree]')!;
    expect(qa(tree, '[data-tok]').map((t) => [t.getAttribute('data-tok'), t.textContent])).toEqual([
      ['key', '"name"'], ['string', '"x"'], ['key', '"note"'], ['string', '"  a  b "'], ['key', '"n"'], ['number', '1.50'], ['key', '"ok"'], ['boolean', 'true'],
      ['key', '"none"'], ['null', 'null'], ['key', '"list"'], ['number', '1'], ['string', '"a"'], ['key', '"obj"'],
    ]);
    const lineOf = (tok: Element) => tok.parentElement!.textContent!;
    expect(lineOf(qa(tree, '[data-tok="key"]')[2])).toMatch(/^ {2}"n"/);
    expect(lineOf(qa(tree, '[data-tok="number"]')[1])).toMatch(/^ {4}1,/);
    const strip = (s: string) => s.replace(/\s+/g, '');
    expect(strip(tree.textContent!)).toBe(strip(SRC));
  });

  it('an MCP block array with one JSON text block is a tree and no <pre>', async () => {
    const { root } = await shown([text('{"a":[1]}')]);
    expect(qa(root, '[data-json-tree]')).toHaveLength(1);
    expect(resultPres(root)).toHaveLength(0);
  });

  it('folds and unfolds a container by its header, summarising it while collapsed', async () => {
    const { root } = await shown([text(SRC)]);
    const btn = () => header(root, '"list"').querySelector('button')!;
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(root.textContent).toContain('"a"');
    await click(header(root, '"list"'));
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(root.textContent).not.toContain('"a"');
    expect(q(root, '[data-json-summary]')!.textContent).toBe('[…]');
    expect(header(root, '"list"').textContent).toContain('2 items');
    await click(header(root, '"list"'));
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(root.textContent).toContain('"a"');
  });

  it('a collapsed object reads {…} with its key count; singular counts read 1 key and 1 item', async () => {
    const { root } = await shown([text('{"o":{"p":1,"q":2},"one":{"r":1},"arr":[1]}')]);
    const summaryOf = async (label: string) => {
      await click(header(root, label));
      const h = header(root, label);
      const summary = q(h, '[data-json-summary]')!.textContent!;
      return [summary, h.textContent!.slice(h.textContent!.indexOf(summary) + summary.length).trim().replace(/,$/, '')];
    };
    expect(await summaryOf('"o"')).toEqual(['{…}', '2 keys']);
    expect(await summaryOf('"one"')).toEqual(['{…}', '1 key']);
    expect(await summaryOf('"arr"')).toEqual(['[…]', '1 item']);
  });

  it("the chevron button toggles exactly once (its click bubbles to the header)", async () => {
    const { root } = await shown([text(SRC)]);
    const btn = header(root, '"list"').querySelector('button')!;
    expect(btn.getAttribute('type')).toBe('button');
    await click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('a click does not toggle while text is selected', async () => {
    const { root } = await shown([text(SRC)]);
    const h = header(root, '"list"');
    const sel = vi.spyOn(window, 'getSelection').mockReturnValue({ rangeCount: 1, isCollapsed: false } as unknown as Selection);
    await click(h);
    expect(h.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
    sel.mockRestore();
    await click(h);
    expect(h.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('empty containers render inline with no toggle', async () => {
    const { root } = await shown([text(SRC)]);
    expect(header(root, '"obj"')).toBeUndefined();
    expect(q(root, '[data-json-tree]')!.textContent).toContain('"obj": {}');
  });

  it('a small payload starts fully open; a large one starts with depth-2 containers collapsed', async () => {
    const small = await shown([text('{"a":{"b":{"c":[1]}}}')]);
    expect(qa(small.root, '[data-json-node]').every((n) => n.getAttribute('data-json-open') === 'true')).toBe(true);
    small.unmount();
    const big = JSON.stringify({ a: { b: { c: [1] }, k: Array.from({ length: 300 }, (_, i) => i) } });
    const { root } = await shown([text(big)]);
    const nodes = qa(root, '[data-json-node]');
    expect(nodes.map((n) => n.getAttribute('data-json-open'))).toEqual(['true', 'true', 'false', 'false']);
    expect(nodes[2].textContent).toMatch(/…/);
  });
});

describe('fold state on the node', () => {
  it('survives closing and reopening the tool card, and records the fold on the result node', async () => {
    const { root, result } = await shown([text('{"a":[1],"b":2}')]);
    await click(header(root, '"a"'));
    expect(Object.values(result().reader.folds)).toEqual([false]);
    const trig = q(root, '[data-tool-trigger]')!;
    await click(trig);
    expect(q(root, '[data-json-tree]')).toBeNull();
    await click(trig);
    expect(header(root, '"a"').querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('a fresh model starts at the default', async () => {
    const { root } = await shown([text('{"a":[1],"b":2}')]);
    expect(header(root, '"a"').querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('mixed content', () => {
  it('keeps block order: the tree, then the plain text', async () => {
    const { root } = await shown([text('{"exitCode":0}'), text('line1\nline2')]);
    const tree = q(root, '[data-json-tree]')!;
    const pre = resultPres(root)[0];
    expect(pre.textContent).toBe('line1\nline2');
    expect(tree.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(resultPres(root)).toHaveLength(1);
  });

  it('truncates a long text block beside a tree; Show full output reveals it and leaves the tree', async () => {
    const long = 'z'.repeat(5000);
    const { root } = await shown([text('{"exitCode":0}'), text(long)]);
    expect(resultPres(root)[0].textContent!.length).toBeLessThan(5000);
    await click(within(root).getByRole('button', { name: 'Show full output' }));
    expect(resultPres(root)[0].textContent).toBe(long);
    expect(within(root).queryByRole('button', { name: 'Show full output' })).toBeNull();
    expect(qa(root, '[data-json-tree]')).toHaveLength(1);
  });
});

describe('content that is not a JSON object or array', () => {
  it('renders the single plain <pre>, no tree', async () => {
    for (const body of ['{"a":', '42']) {
      const { root, unmount } = await shown(body);
      expect(qa(root, '[data-json-tree]')).toHaveLength(0);
      expect(resultPres(root).map((p) => p.textContent)).toEqual([body]);
      unmount();
    }
  });

  it('a valid JSON block over the size gate is plain, truncated, with Show full output', async () => {
    const big = JSON.stringify({ k: 'v'.repeat(70_000) });
    const { root } = await shown([text(big)]);
    expect(qa(root, '[data-json-tree]')).toHaveLength(0);
    expect(resultPres(root)[0].textContent!.length).toBeLessThan(big.length);
    await click(within(root).getByRole('button', { name: 'Show full output' }));
    expect(resultPres(root)[0].textContent).toBe(big);
  });
});

describe('inert output', () => {
  it('string values are text: no image or link is created', async () => {
    const { root } = await shown([text('{"a":"<img src=x onerror=alert(1)>","b":"javascript:alert(1)"}')]);
    const tree = q(root, '[data-json-tree]')!;
    expect(tree.querySelector('img, a, script')).toBeNull();
    expect(tree.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(tree.textContent).toContain('javascript:alert(1)');
  });
});

describe('Copy JSON', () => {
  it('copies the exact source block even with the root collapsed', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const src = '{ "a" : [1,\n 2],  "big": 12345678901234567890 }';
    const { root } = await shown([text(src)]);
    await click(header(root, 'JSON'));
    expect(q(root, '[data-json-node]')!.getAttribute('data-json-open')).toBe('false');
    await click(within(root).getByRole('button', { name: 'Copy JSON' }));
    expect(writeText).toHaveBeenCalledWith(src);
  });
});

describe('a depth-capped keyed container', () => {
  it('keeps its key and trailing comma on the raw line when it has a following sibling', async () => {
    const N = 120;
    // Every level has a following sibling, so the container capped at MAX_TREE_DEPTH is not the last member of its parent.
    const src = '{"a":'.repeat(N) + '1' + ',"s":0}'.repeat(N);
    const { root, m, result } = await shown([text(src)]);
    const folds: Record<string, boolean> = {};
    for (let id = 0; id < 3 * N; id++) folds[`0:${id}`] = true;
    m.setReader(result(), { folds });
    await flush();
    const raw = qa(root, '[data-tok="raw"]');
    expect(raw).toHaveLength(1);
    const line = raw[0].parentElement!;
    expect(line.querySelector('[data-tok="key"]')!.textContent).toBe('"a"');
    expect(line.textContent!.endsWith('},')).toBe(true);
    const left = N - MAX_TREE_DEPTH;
    expect(raw[0].textContent).toBe('{"a":'.repeat(left) + '1' + ',"s":0}'.repeat(left));
  });
});

describe('very deep nesting', () => {
  const DEEP = '['.repeat(20_000) + ']'.repeat(20_000);

  it('renders at the default folds without throwing', async () => {
    const { root } = await shown([text(DEEP)]);
    expect(qa(root, '[data-json-tree]')).toHaveLength(1);
  });

  it('with every container opened, stops at the depth cap and shows the rest as one raw source line', async () => {
    const { root, m, result } = await shown([text(DEEP)]);
    const node = result();
    const folds: Record<string, boolean> = {};
    for (let id = 0; id < 20_000; id++) folds[`0:${id}`] = true;
    m.setReader(node, { folds });
    await flush();
    expect(qa(root, '[data-json-node]').length).toBeLessThanOrEqual(MAX_TREE_DEPTH + 1);
    expect(qa(root, '[data-json-node]').length).toBeGreaterThan(MAX_TREE_DEPTH - 1);
    const raw = qa(root, '[data-tok="raw"]');
    expect(raw).toHaveLength(1);
    expect(raw[0].textContent).toBe('['.repeat(20_000 - MAX_TREE_DEPTH) + ']'.repeat(20_000 - MAX_TREE_DEPTH));
  });
});
