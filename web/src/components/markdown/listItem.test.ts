// The listItem handler: mdast-util-to-hast's own output, without its per-item rescan of the whole list's looseness
// (which made a tight list of n items cost O(n²) to convert).
import { describe, expect, it } from 'vitest';
import { toHast } from 'mdast-util-to-hast';
import type { List, ListItem, Root } from 'mdast';
import { listItem } from './listItem';

const item = (text: string, extra: Partial<ListItem> = {}): ListItem =>
  ({ type: 'listItem', spread: false, children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }], ...extra });
const root = (...lists: List[]): Root => ({ type: 'root', children: lists });
const list = (items: ListItem[], extra: Partial<List> = {}): List => ({ type: 'list', ordered: false, spread: false, children: items, ...extra });

describe('listItem handler', () => {
  // Pins: the handler converts every list shape exactly as mdast-util-to-hast's default does.
  it.each([
    { kind: 'tight', tree: root(list([item('a'), item('b'), item('c')])) },
    { kind: 'loose by the list', tree: root(list([item('a'), item('b')], { spread: true })) },
    { kind: 'loose by one item', tree: root(list([item('a'), item('b', { spread: true }), item('c')])) },
    { kind: 'loose by an item of two blocks', tree: root(list([item('a'), { ...item('b'), spread: undefined, children: [...item('b').children, ...item('c').children] }])) },
    { kind: 'task items', tree: root(list([item('a', { checked: true }), item('b', { checked: false })])) },
    { kind: 'ordered from 3', tree: root(list([item('a'), item('b')], { ordered: true, start: 3 })) },
    { kind: 'nested', tree: root(list([{ ...item('a'), children: [...item('a').children, list([item('x', { spread: true }), item('y')])] }, item('b')])) },
  ])('$kind converts as the default does', ({ tree }) => {
    expect(toHast(structuredClone(tree), { handlers: { listItem } })).toEqual(toHast(structuredClone(tree)));
  });

  // Pins: converting a tight list reads each item's looseness a bounded number of times, not once per sibling.
  it('a tight list of n items reads looseness linearly in n', () => {
    const n = 400;
    let reads = 0;
    const items = Array.from({ length: n }, (_, i) => new Proxy(item(`i${i}`), {
      get(target, key, receiver) {
        if (key === 'spread') reads++;
        return Reflect.get(target, key, receiver);
      },
    }));
    toHast(root(list(items)), { handlers: { listItem } });
    expect(reads).toBeLessThanOrEqual(2 * n);
  });
});
