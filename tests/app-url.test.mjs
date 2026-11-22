// Invariant: appUrlFrom puts an app path under the directory of the page it is
// loaded from, so one build serves at root or under any prefix; it keeps query
// and hash, and refuses anything that is not a '/'-led app path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appUrlFrom, appUrl } from '../shared/appUrl.ts';

test('appUrlFrom: at root a path is unchanged', () => {
  assert.equal(appUrlFrom('http://h/', '/api/x'), '/api/x');
  assert.equal(appUrlFrom('http://h/index.html', '/ws'), '/ws');
});

test('appUrlFrom: under a prefix the page directory leads, whatever the page file is', () => {
  assert.equal(appUrlFrom('http://h/p/q/', '/api/x'), '/p/q/api/x');
  assert.equal(appUrlFrom('http://h/p/q/index.html', '/api/x'), '/p/q/api/x');
  assert.equal(appUrlFrom('http://h/p/q/', '/'), '/p/q/');
});

test('appUrlFrom: query and hash are preserved', () => {
  assert.equal(appUrlFrom('http://h/p/q/', '/api/x?a=1&b=2#frag'), '/p/q/api/x?a=1&b=2#frag');
});

test('appUrlFrom: a path that is not "/"-led, or is "//"-led, throws', () => {
  for (const bad of ['api/x', '//evil.example/x', 'http://h/x', '']) {
    assert.throws(() => appUrlFrom('http://h/p/q/', bad), /not an app path/, JSON.stringify(bad));
  }
});

test('appUrl: with no document it is the identity', () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(appUrl('/api/x'), '/api/x');
});
