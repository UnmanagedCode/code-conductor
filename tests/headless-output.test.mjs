// The headless result in each --output-format (src/headless/result.ts →
// renderResult): `json` is today's object byte for byte, `stream-json` the
// marked final line, `text` the result text with the error on stderr.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatResult, renderResult } from '../src/headless/result.ts';

const RESULT = { reason: 'completed', exitCode: 0, sessionId: 's-1', text: 'hi', costUsd: 0.25, durationMs: 1200, error: null };
const FAILED = { reason: 'conductor_error', exitCode: 3, sessionId: null, text: null, costUsd: null, durationMs: null, error: 'it broke' };

// Invariant: the default output's bytes are unchanged.
test('json renders today\'s one object, byte for byte, with no stderr', () => {
  const o = renderResult(RESULT, 'json');
  assert.equal(o.stdout, '{"reason":"completed","exitCode":0,"sessionId":"s-1","text":"hi","costUsd":0.25,"durationMs":1200,"error":null}\n');
  assert.equal(o.stdout, formatResult(RESULT));
  assert.equal(o.stderr, null);
});

// Invariant: stream-json's final line is one line, marked cc_result first, then
// today's fields in today's order with today's values.
test('stream-json renders one cc_result line: type first, then today\'s keys in order', () => {
  for (const r of [RESULT, FAILED]) {
    const o = renderResult(r, 'stream-json');
    assert.equal(o.stderr, null);
    assert.ok(o.stdout.endsWith('\n'));
    assert.equal(o.stdout.indexOf('\n'), o.stdout.length - 1, 'exactly one line');
    const parsed = JSON.parse(o.stdout);
    assert.deepEqual(Object.keys(parsed), ['type', 'reason', 'exitCode', 'sessionId', 'text', 'costUsd', 'durationMs', 'error']);
    assert.deepEqual(parsed, { type: 'cc_result', ...r });
  }
});

// Invariant: text carries only the result text; the error goes to stderr, and
// only when there is one.
test('text renders the result text alone, and an error line on stderr only when there is an error', () => {
  assert.deepEqual(renderResult(RESULT, 'text'), { stdout: 'hi\n', stderr: null });
  const failed = renderResult(FAILED, 'text');
  assert.equal(failed.stdout, '', 'null text leaves stdout empty');
  assert.equal(failed.stderr, 'headless: conductor_error: it broke\n');
  const partial = renderResult({ ...FAILED, text: 'partial' }, 'text');
  assert.equal(partial.stdout, 'partial\n');
  assert.match(partial.stderr, /conductor_error: it broke/);
});
