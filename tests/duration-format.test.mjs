// Pins the humanizeDuration contract, which conductor-facing timeout text
// (the heartbeat "did NOT finish" stub, the plugin MCP 504) renders through.
//
// Each case below pins one invariant of that contract: the unit spellings, the
// largest-first ordering, the drop-zero-components rule, truncation (never
// over-report a window), the sub-second floor, and the degenerate inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeDuration } from '../src/duration.ts';

test('renders whole minutes and hours with no spaces or ms', () => {
  // Unit spellings + the reported bug's own value: 1800000ms must read as 30m.
  assert.equal(humanizeDuration(1_800_000), '30m');
  assert.equal(humanizeDuration(45_000), '45s');
  assert.equal(humanizeDuration(1_000), '1s');
});

test('components run largest-first', () => {
  assert.equal(humanizeDuration(5_400_000), '1h30m');
  assert.equal(humanizeDuration(90_000), '1m30s');
});

test('zero components are dropped, not rendered as 0', () => {
  // 2h, not 2h0m0s — and an hour+seconds gap skips the empty minutes slot.
  assert.equal(humanizeDuration(7_200_000), '2h');
  assert.equal(humanizeDuration(3_605_000), '1h5s');
  assert.equal(humanizeDuration(3_600_000), '1h');
});

test('all three components appear when all are non-zero', () => {
  assert.equal(humanizeDuration(3_661_000), '1h1m1s');
});

test('truncates to whole seconds — never over-reports a window', () => {
  // 1999ms is 1s, not 2s: a rounded render would claim a longer wait than
  // the heartbeat actually gave.
  assert.equal(humanizeDuration(1_999), '1s');
  assert.equal(humanizeDuration(59_999), '59s');
  assert.equal(humanizeDuration(119_999), '1m59s');
});

test('sub-second renders <1s — ms are never shown', () => {
  assert.equal(humanizeDuration(150), '<1s');
  assert.equal(humanizeDuration(999), '<1s');
  assert.equal(humanizeDuration(1), '<1s');
});

test('zero, negative and non-finite floor to 0s', () => {
  for (const bad of [0, -1, -1_800_000, NaN, Infinity, -Infinity]) {
    assert.equal(humanizeDuration(bad), '0s', `input ${bad}`);
  }
});

test('no output ever contains "ms" or a space', () => {
  for (const ms of [150, 1_999, 45_000, 90_000, 3_661_000, 5_400_000, 1_800_000, 0, -5]) {
    const out = humanizeDuration(ms);
    assert.ok(!/\s/.test(out), `"${out}" has whitespace`);
    assert.ok(!/ms/.test(out), `"${out}" renders milliseconds`);
  }
});
