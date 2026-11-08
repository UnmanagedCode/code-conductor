// How run_code's result is assembled from the process's exit and what it
// delivered (src/codeMode/runCode.ts → assembleResult), including a delivery
// the program wrote itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleResult } from '../src/codeMode/runCode.ts';
import { MCP_RESULT_CHAR_BUDGET } from '../src/mcp/content.ts';
import {
  RUN_RESULT_CAP, RUN_LOGS_CAP, RUN_ERROR_MESSAGE_CAP, RUN_ERROR_FIELD_CAP, RUN_META_HEADROOM,
} from '../src/codeMode/limits.ts';

const exec = (over = {}) => ({
  code: 0, stdout: '', stderr: '', output: '', timedOut: false, truncated: false, durationMs: 5, spawnError: null, ...over,
});
const textChars = (r) => {
  const t = r.text();
  return JSON.stringify(t.meta).length + t.bodies.reduce((n, b) => n + String(b).length, 0);
};

test('a timed-out run has no error, a null exit code, and a present null result', () => {
  const r = assembleResult(exec({ code: 124, timedOut: true }), undefined, false);
  assert.equal(r.json.timedOut, true);
  assert.equal(r.json.exitCode, null);
  assert.equal(r.json.error, undefined, 'not NoResult: the timeout speaks');
  assert.ok('result' in r.json);
  assert.equal(r.json.result, null);
});

test('a cancelled run reports Cancelled, a null exit code and a present null result', () => {
  const r = assembleResult(exec({ code: 143 }), undefined, true);
  assert.deepEqual(r.json.error, { name: 'Cancelled', message: 'the run was cancelled before it finished', code: 'RUN_CANCELLED' });
  assert.equal(r.json.exitCode, null);
  assert.ok('result' in r.json);
  assert.equal(r.json.result, null);
});

test('a launch that failed is a SpawnError with its message and a null exit code', () => {
  const r = assembleResult(exec({ code: 1, spawnError: 'spawn node ENOENT' }), undefined, false);
  assert.deepEqual(r.json.error, { name: 'SpawnError', message: 'spawn node ENOENT' });
  assert.equal(r.json.exitCode, null);
});

test('a process that exits with nothing delivered is NoResult carrying its exit code', () => {
  const r = assembleResult(exec({ code: 13 }), undefined, false);
  assert.equal(r.json.error.name, 'NoResult');
  assert.match(r.json.error.message, /code 13/);
});

test('a delivered error wins over the process facts', () => {
  const r = assembleResult(exec({ code: 1 }), { result: null, resultChars: 0, truncated: false, error: { name: 'E', message: 'm' } }, false);
  assert.deepEqual(r.json.error, { name: 'E', message: 'm' });
});

test('a hostile delivery is re-capped: result, error name, message and code', () => {
  const r = assembleResult(exec({ output: 'l'.repeat(RUN_LOGS_CAP * 2), truncated: true, code: 1 }), {
    result: 'r'.repeat(500_000), resultChars: 1, truncated: false,
    error: { name: 'N'.repeat(60_000), message: 'm'.repeat(60_000), code: 'C'.repeat(60_000), status: 200 },
  }, false);
  assert.equal(r.json.truncated, true, 'an oversize result is flagged cut');
  assert.equal(r.json.resultChars, 500_000, 'with its real length');
  assert.ok(r.json.result.length <= RUN_RESULT_CAP + 120);
  assert.match(r.json.result, /… \[result cut at \d+ of 500000 chars — return less\]$/);
  assert.equal(r.json.error.name.length, RUN_ERROR_FIELD_CAP);
  assert.equal(r.json.error.code.length, RUN_ERROR_FIELD_CAP);
  assert.equal(r.json.error.message.length, RUN_ERROR_MESSAGE_CAP);
  assert.ok(textChars(r) <= MCP_RESULT_CHAR_BUDGET, `${textChars(r)} chars`);
  assert.ok(RUN_RESULT_CAP + 120 + RUN_LOGS_CAP + RUN_ERROR_MESSAGE_CAP + 2 * RUN_ERROR_FIELD_CAP + RUN_META_HEADROOM <= MCP_RESULT_CHAR_BUDGET, 'the caps still sum inside the budget');
});

test('a well-formed delivery passes through unchanged', () => {
  const r = assembleResult(exec(), { result: '{"a":1}', resultChars: 7, truncated: false }, false);
  assert.equal(r.json.result, '{"a":1}');
  assert.equal(r.json.truncated, false);
  assert.equal(r.json.resultChars, undefined);
});
