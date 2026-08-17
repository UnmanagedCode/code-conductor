// The single DOM-node predicate + short-summary formatter, shared by
// `tests/dom-assert.mjs` (the assertNull/assertUndefined helpers) and
// `tests/dom-assert-tripwire.mjs` (the runtime backstop preloaded into every
// test child).
//
// THIS MODULE MUST HAVE ZERO IMPORTS. The tripwire is loaded via `--import`
// before any test file runs. `tests/dom-assert.mjs` imports
// `node:assert/strict`, and instantiating assert's ESM namespace during the
// preload snapshots its named exports BEFORE the tripwire patches them — after
// which `import { strictEqual } from 'node:assert'` in a test file silently
// bypasses the patch (measured). So the predicate cannot live in
// `dom-assert.mjs`, and nothing reachable from here may import `node:assert`.
//
// `describeFound` lives here rather than in `dom-assert.mjs` for the same
// reason: both consumers need it, and only one of them may touch assert's ESM
// namespace. One implementation, one predicate, two consumers.

// Two signals, not one: `nodeType` alone would also classify a plain
// `{ nodeType: 1 }` object literal as a node, and the tripwire changes
// behaviour for whatever this classifies. There are no `nodeType:`-bearing
// object literals in `tests/*.mjs` outside the guard's own fixtures, so the
// second signal is behaviour-neutral today and narrows the "merely looks
// node-ish" surface.
export function isDomNode(value) {
  return !!value && typeof value === 'object'
    && typeof value.nodeType === 'number'
    && typeof value.nodeName === 'string';
}

// Summarize a node as `<tag#id.class>` WITHOUT handing it to assert: the whole
// point is that the circular ownerDocument/Window graph never crosses the
// per-file child-process boundary.
export function describeFound(value) {
  if (isDomNode(value)) {
    const tag = String(value.tagName || value.nodeName).toLowerCase();
    const id = value.id ? `#${value.id}` : '';
    const cls = value.className
      ? `.${String(value.className).trim().split(/\s+/).join('.')}`
      : '';
    return `<${tag}${id}${cls}>`;
  }
  return typeof value === 'object' ? Object.prototype.toString.call(value) : String(value);
}
