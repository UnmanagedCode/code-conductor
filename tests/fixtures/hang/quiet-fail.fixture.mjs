// A file with ONE failing test between two passing ones, each logging a marker.
//
// The quiet reporter flushes a failing file whole, so every marker — the one
// written BEFORE the failure included — and the `✔`/`▶` lines around the
// failure must all reach the runner's output. Those inline `▶`/`✖` lines are what
// code-mutant's node-test adapter rebuilds `describe > name` paths from.
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { writeSync } from 'node:fs';

describe('quiet-fail group', () => {
  test('quiet-fail: passes before the failure', () => {
    console.log('quiet-fail: before stdout');
    writeSync(2, 'quiet-fail: before stderr\n');
  });
  test('quiet-fail: fails', () => {
    console.log('quiet-fail: failing stdout');
    assert.fail('quiet-fail: deliberate failure');
  });
  test('quiet-fail: passes after the failure', () => {
    console.log('quiet-fail: after stdout');
  });
});
