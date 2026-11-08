// The child-side half of code mode (src/codeMode/runtimeApi.ts) and the run
// registry (src/codeMode/runs.ts), with an injected fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCc, serializeOutcome, ConductorError, RUN_TOKEN_HEADER,
} from '../src/codeMode/runtimeApi.ts';
import { createRunRegistry } from '../src/codeMode/runs.ts';
import { RUN_RESULT_CAP, RUN_ERROR_MESSAGE_CAP, RUN_ERROR_FIELD_CAP } from '../src/codeMode/limits.ts';

function recorder(reply) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const { status = 200, body } = reply(url, calls.at(-1).body);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, cc: createCc({ url: 'http://h/mcp/sid', token: 'tok', fetch: fetchFn }) };
}

test('cc.<tool>(args) POSTs the REST alias with the run token and returns the JSON body', async () => {
  const { calls, cc } = recorder(() => ({ body: { projects: [1] } }));
  assert.deepEqual(await cc.list_projects({ a: 1 }), { projects: [1] });
  assert.equal(calls[0].url, 'http://h/mcp/sid/tools/list_projects');
  assert.equal(calls[0].init.headers[RUN_TOKEN_HEADER], 'tok');
  assert.deepEqual(calls[0].body, { a: 1 });
});

test('cc.<ns>.<tool> and cc["<id>"].<tool> both name <id>__<tool>, ns underscores read as hyphens', async () => {
  const { calls, cc } = recorder(() => ({ body: {} }));
  await cc.code_kanban.list_cards({});
  await cc['code-kanban'].list_cards({});
  await cc.call('code-kanban__list_cards', {});
  assert.deepEqual(calls.map(c => c.url), Array(3).fill('http://h/mcp/sid/tools/code-kanban__list_cards'));
});

test('cc.call defaults args to {}', async () => {
  const { calls, cc } = recorder(() => ({ body: {} }));
  await cc.call('x');
  assert.deepEqual(calls[0].body, {});
});

test('cc.describe_tools unwraps {tools}', async () => {
  const { calls, cc } = recorder(() => ({ body: { tools: [{ method: 'cc.a' }] } }));
  assert.deepEqual(await cc.describe_tools({ query: 'a' }), [{ method: 'cc.a' }]);
  assert.equal(calls[0].url, 'http://h/mcp/sid/tools/describe_tools');
});

test('a soft refusal (HTTP 200, ok:false) throws a ConductorError with status 200 and its details', async () => {
  const { cc } = recorder(() => ({ body: { ok: false, code: 'PLAYBOOK_UNKNOWN', reason: 'no such', details: { x: 1 } } }));
  await assert.rejects(cc.describe_playbook({}), (e) => {
    assert.ok(e instanceof ConductorError);
    assert.equal(e.name, 'ConductorError');
    assert.equal(e.code, 'PLAYBOOK_UNKNOWN');
    assert.equal(e.reason, 'no such');
    assert.equal(e.status, 200);
    assert.deepEqual(e.details, { x: 1 });
    return true;
  });
});

test('a fault (HTTP >= 400) throws with that status; a non-JSON body becomes HTTP_<status>', async () => {
  const a = recorder(() => ({ status: 404, body: { ok: false, code: 'TOOL_UNKNOWN', reason: 'unknown tool: nope' } }));
  await assert.rejects(a.cc.nope(), { code: 'TOOL_UNKNOWN', status: 404 });
  const b = recorder(() => ({ status: 502, body: '<html>bad gateway</html>' }));
  await assert.rejects(b.cc.x(), { code: 'HTTP_502', status: 502 });
});

test('awaiting cc or a member never treats it as a thenable; symbol keys are undefined', async () => {
  const { cc } = recorder(() => ({ body: {} }));
  assert.equal(cc.then, undefined);
  assert.equal(cc.x.then, undefined);
  assert.equal(cc[Symbol.iterator], undefined);
  assert.equal(await cc, cc);
});

test('serializeOutcome: a value is its JSON text with its length', () => {
  assert.deepEqual(serializeOutcome({ value: { a: [1] } }), { result: '{"a":[1]}', resultChars: 9, truncated: false });
});

test('serializeOutcome: no return value is a null result', () => {
  assert.deepEqual(serializeOutcome({ value: undefined }), { result: null, resultChars: 0, truncated: false });
});

test('serializeOutcome: a result over the cap is cut with a marker, truncated, and its full length', () => {
  const o = serializeOutcome({ value: 'x'.repeat(RUN_RESULT_CAP + 500) });
  const full = RUN_RESULT_CAP + 502;
  assert.equal(o.truncated, true);
  assert.equal(o.resultChars, full);
  assert.ok(o.result.startsWith('"xxx'));
  assert.ok(o.result.endsWith(`… [result cut at ${RUN_RESULT_CAP} of ${full} chars — return less]`));
});

test('serializeOutcome: a cut never splits a surrogate pair', () => {
  const o = serializeOutcome({ value: '😀'.repeat(RUN_RESULT_CAP) });
  assert.doesNotMatch(o.result, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test('serializeOutcome: a non-serializable value is a TypeError outcome, not a crash', () => {
  assert.equal(serializeOutcome({ value: 1n }).error.name, 'TypeError');
  const circular = {}; circular.self = circular;
  assert.equal(serializeOutcome({ value: circular }).error.name, 'TypeError');
});

test('serializeOutcome: a thrown ConductorError keeps name, code and status; the message is capped', () => {
  const e = new ConductorError('X_CODE', 'y'.repeat(RUN_ERROR_MESSAGE_CAP * 2), 200);
  const o = serializeOutcome({ thrown: e });
  assert.equal(o.result, null);
  assert.equal(o.error.name, 'ConductorError');
  assert.equal(o.error.code, 'X_CODE');
  assert.equal(o.error.status, 200);
  assert.equal(o.error.message.length, RUN_ERROR_MESSAGE_CAP);
});

test('serializeOutcome: a thrown error\'s name and code are capped too', () => {
  const e = Object.assign(new Error('m'), { name: 'N'.repeat(60_000), code: 'C'.repeat(60_000) });
  const o = serializeOutcome({ thrown: e });
  assert.equal(o.error.name.length, RUN_ERROR_FIELD_CAP);
  assert.equal(o.error.code.length, RUN_ERROR_FIELD_CAP);
});

test('serializeOutcome: a thrown non-Error is stringified', () => {
  assert.deepEqual(serializeOutcome({ thrown: 'boom' }).error, { name: 'Error', message: 'boom' });
});

test('run registry: the first delivery wins, close revokes and returns it', () => {
  const runs = createRunRegistry();
  const token = runs.open('caller');
  assert.deepEqual(runs.get(token), { callerId: 'caller' });
  const body = { result: '1', resultChars: 1, truncated: false };
  assert.equal(runs.deliver(token, body), 'ok');
  assert.equal(runs.deliver(token, { ...body, result: '2' }), 'delivered');
  assert.deepEqual(runs.close(token), body);
  assert.equal(runs.get(token), undefined);
  assert.equal(runs.deliver(token, body), 'unknown');
  assert.equal(runs.close(token), undefined);
});

test('run registry: tokens are distinct per run and unknown tokens are unknown', () => {
  const runs = createRunRegistry();
  assert.notEqual(runs.open('a'), runs.open('a'));
  assert.equal(runs.get('nope'), undefined);
  assert.equal(runs.deliver('nope', { result: null, resultChars: 0, truncated: false }), 'unknown');
});
