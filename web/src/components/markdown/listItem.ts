// mdast-util-to-hast's listItem handler asks, for every item, whether the whole list is loose, rescanning every
// sibling each time: a tight list of n items costs O(n²) to convert. This handler answers that once per list and
// hands the default a stand-in parent carrying the answer, so the output is the default's.
import { defaultHandlers, type Handler } from 'mdast-util-to-hast';
import type { List, ListItem } from 'mdast';

const looseness = new WeakMap<List, boolean>();

/** Whether `list` is loose, as mdast-util-to-hast decides it: spread itself, or any item spread or holding two blocks. */
function isLoose(list: List): boolean {
  let loose = looseness.get(list);
  if (loose === undefined) {
    loose = Boolean(list.spread) || list.children.some((i: ListItem) => (i.spread ?? i.children.length > 1));
    looseness.set(list, loose);
  }
  return loose;
}

export const listItem: Handler = (state, node, parent) =>
  defaultHandlers.listItem(state, node as ListItem, parent?.type === 'list' ? { type: 'list', spread: isLoose(parent as List), children: [] } : parent);
