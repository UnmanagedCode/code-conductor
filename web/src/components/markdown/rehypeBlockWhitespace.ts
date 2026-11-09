// The transcript's text and the plan card render `Markdown` under `whitespace-pre-wrap`, so a single newline a person
// typed stays a line break; under it the "\n" text nodes mdast-util-to-hast puts between blocks would show as blank
// lines. This plugin removes them for every caller; a newline inside a paragraph is untouched.
import type { Element, ElementContent, Root, RootContent } from 'hast';

/** Elements that lay out as blocks inside a list item. */
const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'pre', 'blockquote', 'table', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Containers whose whitespace-only text is never content. */
const CONTAINERS = new Set(['blockquote', 'ul', 'ol', 'table', 'thead', 'tbody', 'tr']);

export const isWhitespace = (n: RootContent | ElementContent | undefined): boolean =>
  n?.type === 'text' && !/[^ \t\n\f\r]/.test(n.value);
export const isBlock = (n: RootContent | ElementContent | undefined): n is Element =>
  n?.type === 'element' && BLOCK_TAGS.has(n.tagName);

/** Drops whitespace-only text under the root and block containers, and beside a block inside a list item. Iterative. */
export function rehypeBlockWhitespace() {
  return (tree: Root) => {
    const stack: (Root | Element)[] = [tree];
    while (stack.length) {
      const node = stack.pop()!;
      const container = node.type === 'root' || CONTAINERS.has(node.tagName);
      if (container || node.tagName === 'li') {
        const kids: (RootContent | ElementContent)[] = node.children;
        node.children = kids.filter((c, i) => !isWhitespace(c) || (!container && !isBlock(kids[i - 1]) && !isBlock(kids[i + 1]))) as never;
      }
      for (const c of node.children) if (c.type === 'element') stack.push(c);
    }
  };
}
