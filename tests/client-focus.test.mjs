// shared/focus.ts: the client's focus state. DOM-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusFromHealth, focusState, setFocus, subscribeFocus } from '../shared/focus.ts';

// Invariant: the focus is read off a health body's `focus` key, keeping a string
// or null sessionId; an absent or malformed key is "not in focus mode".
test('focusFromHealth keeps the sessionId, string or null', () => {
  assert.deepEqual(focusFromHealth({ focus: { sessionId: 'a' } }), { sessionId: 'a' });
  assert.deepEqual(focusFromHealth({ focus: { sessionId: null } }), { sessionId: null });
});
test('focusFromHealth is null when the key is absent or malformed', () => {
  assert.equal(focusFromHealth({}), null);
  assert.equal(focusFromHealth(null), null);
  assert.equal(focusFromHealth({ focus: 'x' }), null);
  assert.equal(focusFromHealth({ focus: {} }), null);
  assert.equal(focusFromHealth({ focus: { sessionId: 3 } }), null);
});

// Invariant: listeners fire only on a real change, and stop after unsubscribe.
test('setFocus notifies only on change', () => {
  setFocus(null);
  let n = 0;
  const off = subscribeFocus(() => { n++; });
  setFocus({ sessionId: null });
  assert.equal(n, 1);
  setFocus({ sessionId: null });
  assert.equal(n, 1, 'same value: no notification');
  setFocus({ sessionId: 'a' });
  assert.equal(n, 2);
  assert.deepEqual(focusState(), { sessionId: 'a' });
  setFocus(null);
  assert.equal(n, 3);
  setFocus(null);
  assert.equal(n, 3);
  off();
  setFocus({ sessionId: 'b' });
  assert.equal(n, 3, 'unsubscribed');
  setFocus(null);
});
