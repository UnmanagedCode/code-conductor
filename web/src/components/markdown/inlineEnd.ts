// Where a text block's read-aloud control goes: a slot at the inline end of the rendered markdown's last line of
// prose. The walk follows the last block down through quotes and list items (nested lists included) to a paragraph
// or a list item whose content ends inline; a block ending in anything else (heading, code, table, rule, an HTML
// block's literal text) has no inline end, and the control takes a row of its own.
import type { Element, ElementContent, Root, RootContent } from 'hast';
import { isBlock, isWhitespace } from './rehypeBlockWhitespace';

const lastContent = (n: Root | Element): RootContent | ElementContent | undefined =>
  n.children.findLast((c) => !isWhitespace(c));

/** The element whose inline content ends `root`'s last block; null when it has none. Iterative. */
export function inlineEndHost(root: Root): Element | null {
  let cur = lastContent(root);
  for (;;) {
    if (cur?.type !== 'element') return null;
    switch (cur.tagName) {
      case 'p': return cur;
      case 'blockquote': cur = lastContent(cur); break;
      case 'ul': case 'ol': cur = cur.children.findLast((c) => c.type === 'element' && c.tagName === 'li'); break;
      case 'li': {
        const last = lastContent(cur);
        if (!isBlock(last)) return cur;
        cur = last;
        break;
      }
      default: return null;
    }
  }
}

/** Appends an empty `span[data-speak-slot]` at the inline end of the last block, when it has one. */
export function rehypeInlineEnd() {
  return (tree: Root) => {
    inlineEndHost(tree)?.children.push({ type: 'element', tagName: 'span', properties: { dataSpeakSlot: '' }, children: [] });
  };
}
