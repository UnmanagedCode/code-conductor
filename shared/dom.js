// The one DOM builder for the whole client.
//
// A LEAF module by necessity, not by taste: blocks.js imports
// renderMarkdownInto from markdown.js, so an `el` living in blocks.js and
// imported by markdown.js would make blocks → markdown → blocks a cycle.
// dom.js imports nothing, so every consumer can reach it.
//
// Signature is attrs-first — `el(tag, attrs, ...children)`. `attrs` is
// mandatory in practice: pass `{}` when there are none, because a first
// argument that is a string or an element is read as an attribute bag and
// either sets numeric attributes (0="t", 1="e", …) or drops the child
// silently. tests/markdown-attr-surface.test.mjs pins both failure modes.

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}
