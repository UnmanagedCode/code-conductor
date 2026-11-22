import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBasePath, stripBasePath } from '../src/basePath.ts';

test('parseBasePath: unset, empty and "/" all mean root', () => {
  for (const v of [undefined, null, '', '/']) assert.equal(parseBasePath(v), '');
});

test('parseBasePath: one trailing slash is normalised away', () => {
  assert.equal(parseBasePath('/p/q/'), '/p/q');
  assert.equal(parseBasePath('/p/q'), '/p/q');
});

test('parseBasePath: refuses a value that is not a clean path prefix', () => {
  for (const bad of ['p/q', '/p//q', '/p/./q', '/p/../q', '//', '/p?x', '/p#x', '/p%20q', '/p q', '/p/q//']) {
    assert.throws(() => parseBasePath(bad), /CC_BASE_PATH/, bad);
  }
});

test('stripBasePath: a prefixed path loses the base, a root path is untouched', () => {
  assert.deepEqual(stripBasePath('/p/q', '/p/q/api/x?a=1'), { url: '/api/x?a=1' });
  assert.deepEqual(stripBasePath('/p/q', '/p/q/'), { url: '/' });
  assert.deepEqual(stripBasePath('/p/q', '/api/x'), { url: '/api/x' });
});

test('stripBasePath: a near-miss prefix is not stripped', () => {
  assert.deepEqual(stripBasePath('/p/q', '/p/qr/x'), { url: '/p/qr/x' });
});

test('stripBasePath: a bare base redirects to the trailing-slash form, query kept', () => {
  assert.deepEqual(stripBasePath('/p/q', '/p/q'), { redirect: '/p/q/' });
  assert.deepEqual(stripBasePath('/p/q', '/p/q?a=1'), { redirect: '/p/q/?a=1' });
});

test('stripBasePath: with no base it is the identity', () => {
  assert.deepEqual(stripBasePath('', '/p/q/api'), { url: '/p/q/api' });
});
