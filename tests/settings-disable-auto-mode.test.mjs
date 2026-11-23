// INVARIANT: every variant of the `--settings` JSON cc builds disables Claude
// Code's auto mode — no combination of hook URL, redirect or conductor drops
// it. 'disable' is the CLI's own protocol value (its only accepted one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettingsJSON } from '../src/settings.ts';

const URL_ = 'http://h';
const rows = [
  ['conductor, no redirect', { hookCallbackUrl: URL_, conductor: true }],
  ['conductor, redirect', { hookCallbackUrl: URL_, conductor: true, redirect: true }],
  ['worker, no redirect', { hookCallbackUrl: URL_ }],
  ['worker, redirect', { hookCallbackUrl: URL_, redirect: true }],
  ['conductor, no hook URL', { conductor: true }],
  ['worker, no hook URL', {}],
];

for (const [name, opts] of rows) {
  test(`disableAutoMode is set top-level: ${name}`, () => {
    const s = JSON.parse(buildSettingsJSON(opts));
    assert.equal(s.disableAutoMode, 'disable');
  });
}

test('a redirected session\'s permissions block holds only deny, beside the top-level key', () => {
  const s = JSON.parse(buildSettingsJSON({ hookCallbackUrl: URL_, redirect: true }));
  assert.deepEqual(Object.keys(s.permissions), ['deny']);
  assert.equal(s.disableAutoMode, 'disable');
});
