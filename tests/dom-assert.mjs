// Asserting a live DOM node against null with assert.equal makes node serialize
// the node, walking its circular ownerDocument/Window graph: the failing file
// stalls 33-120s and aborts, so every later test in it silently never runs.
// Supplying a message makes it worse, not better — the rule is unconditional on
// arity; deepStrictEqual does not stall at all, it grows unboundedly until the
// OS kills the process. See docs/architecture.md for the measurements.
// These helpers compare without handing the node to assert, and summarize it
// into a short string for the message instead.
// The node predicate and the `<tag#id.class>` formatter are shared with
// `tests/dom-assert-tripwire.mjs` via `tests/domNode.mjs` — see that file for
// why they cannot live here (this module imports node:assert/strict, and the
// tripwire preload must not instantiate assert's ESM namespace).
import { AssertionError } from 'node:assert/strict';
import { describeFound } from './domNode.mjs';

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
