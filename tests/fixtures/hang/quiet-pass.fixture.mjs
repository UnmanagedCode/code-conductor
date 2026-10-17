// A completely HEALTHY file whose output the quiet reporter must hold back.
//
// Each marker is written by a different writer: console.log arrives as a
// `test:stdout` event, the raw fd-2 write as a `test:stderr` one, and
// tests/runner-quiet.test.mjs asserts that neither reaches the runner's output on a
// passing run while both do under CC_TEST_VERBOSE=1. The skip and the todo are
// the two per-test lines a quiet run still prints, so they sit inside the
// describe to prove they are printed WITHOUT its `▶` header.
import { describe, test } from 'node:test';
import { writeSync } from 'node:fs';

describe('quiet-pass group', () => {
  test('quiet-pass: writes to both streams', () => {
    console.log('quiet-pass: stdout marker');
    writeSync(2, 'quiet-pass: stderr marker\n');
  });
  test('quiet-pass: skipped', { skip: 'quiet-pass skip reason' }, () => {});
  test('quiet-pass: todo', { todo: 'quiet-pass todo reason' }, () => {});
});
