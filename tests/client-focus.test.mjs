// shared/focus.ts: the client's focus state. DOM-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusFromHealth, focusFromSearch, focusState, serverFocus, pageFocus, setFocus, setPageFocus, subscribeFocus } from '../shared/focus.ts';

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

// Invariant: only a named session is a URL marker — a non-empty `focus` value,
// percent-decoded, the first when the key repeats; an empty or absent key is none.
test('focusFromSearch reads a named session and nothing else', () => {
  assert.deepEqual(focusFromSearch('?focus=a'), { sessionId: 'a' });
  assert.deepEqual(focusFromSearch('?focus=a%2Fb%20c'), { sessionId: 'a/b c' });
  assert.deepEqual(focusFromSearch('?x=1&focus=a'), { sessionId: 'a' });
  assert.deepEqual(focusFromSearch('?focus=a&focus=b'), { sessionId: 'a' });
  for (const s of ['?focus=', '?', '', '?other=1', '?focus']) assert.equal(focusFromSearch(s), null, JSON.stringify(s));
});

// Invariant: the server's focus beats the page's, and the page's outlives a
// server change; listeners fire on each real change of either and not on a repeat.
test('the page focus is the fallback under the server focus', () => {
  setFocus(null); setPageFocus(null);
  let n = 0;
  const off = subscribeFocus(() => { n++; });
  try {
    setPageFocus({ sessionId: 'S' });
    assert.equal(n, 1);
    assert.deepEqual(focusState(), { sessionId: 'S' });
    assert.equal(serverFocus(), null);
    assert.deepEqual(pageFocus(), { sessionId: 'S' });
    setPageFocus({ sessionId: 'S' });
    assert.equal(n, 1, 'same value: no notification');
    setFocus({ sessionId: 'R' });
    assert.equal(n, 2);
    assert.deepEqual(focusState(), { sessionId: 'R' });
    setFocus({ sessionId: null });
    assert.deepEqual(focusState(), { sessionId: null }, 'a waiting server focus still wins');
    setFocus(null);
    assert.deepEqual(focusState(), { sessionId: 'S' }, 'the page focus remains');
    setPageFocus(null);
    assert.equal(focusState(), null);
    assert.equal(n, 5);
  } finally { off(); setFocus(null); setPageFocus(null); }
});
