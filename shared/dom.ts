// The one DOM builder for the whole client.
//
// A LEAF module by necessity, not by taste: blocks.js imports
// renderMarkdownInto from markdown.ts, so an `el` living in blocks.js and
// imported by markdown.ts would make blocks → markdown → blocks a cycle.
// dom.ts imports nothing, so every consumer can reach it.
//
// Signature is attrs-first — `el(tag, attrs, ...children)`. `attrs` is
// mandatory in practice: pass `{}` when there are none, because a first
// argument that is a string or an element is read as an attribute bag and
// either sets numeric attributes (0="t", 1="e", …) or drops the child
// silently. tests/markdown-attr-surface.test.mjs pins both failure modes.

//
// Values are stringified as the DOM would (String() is its DOMString
// conversion), so a number attribute reads as it always did.
export type AttrValue = string | number | boolean | null | undefined | EventListener | Record<string, string>;
export type Child = Node | string | null | undefined | false;

export function el(tag: string, attrs: Record<string, AttrValue> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = String(v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}
