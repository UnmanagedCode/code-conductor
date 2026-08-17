// Asserting a live DOM node against null with assert.equal makes node serialize
// the node, walking its circular ownerDocument/Window graph: the failing file
// stalls 33-120s and aborts, so every later test in it silently never runs.
// Supplying a message makes it worse, not better — the rule is unconditional on
// arity; deepStrictEqual does not stall at all, it grows unboundedly until the
// OS kills the process. See docs/architecture.md for the measurements.
// These helpers compare without handing the node to assert, and summarize it
// into a short string for the message instead.
import { AssertionError } from 'node:assert/strict';

function describeFound(value) {
  if (value && typeof value === 'object' && typeof value.nodeType === 'number') {
    const tag = String(value.tagName || value.nodeName).toLowerCase();
    const id = value.id ? `#${value.id}` : '';
    const cls = value.className
      ? `.${String(value.className).trim().split(/\s+/).join('.')}`
      : '';
    return `<${tag}${id}${cls}>`;
  }
  return typeof value === 'object' ? Object.prototype.toString.call(value) : String(value);
}

export function assertNull(value, label) {
  if (value === null) return;
  throw new AssertionError({
    message: `${label} — expected null, found ${describeFound(value)}`,
    stackStartFn: assertNull,
  });
}

export function assertUndefined(value, label) {
  if (value === undefined) return;
  throw new AssertionError({
    message: `${label} — expected undefined, found ${describeFound(value)}`,
    stackStartFn: assertUndefined,
  });
}
