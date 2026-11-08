// run_code end to end (src/codeMode/): a program runs in a child process as the
// calling session and its calls go through the same gate as direct ones.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { api, waitFor } from './helpers.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { bootWithSession, spawnIdle, runCodeRest, runCodeText, pidAlive } from './codeModeClient.mjs';
import { RUN_RESULT_CAP, RUN_LOGS_CAP } from '../src/codeMode/limits.ts';

let srv, inst, sid, planSid;

before(async () => {
  ({ srv, inst, sid } = await bootWithSession());
  planSid = (await spawnIdle(srv, 'rc-proj', 'plan')).sessionId;
});
after(async () => { await srv?.close(); });

const run = (code, extra) => runCodeRest(srv, sid, code, extra);

test('a program returns the same count a direct call does, in one call', async () => {
  const direct = await (await fetch(`${srv.baseUrl}/mcp/${sid}/tools/list_projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  const { status, body } = await run('return (await cc.list_projects()).projects.length');
  assert.equal(status, 200);
  assert.equal(body.error, undefined);
  assert.equal(body.exitCode, 0);
  assert.equal(body.result, String(direct.projects.length));
});

test('the working directory is the session\'s, and logs stay apart from the result', async () => {
  const { body } = await run("console.log('hello'); console.error('oops'); return process.cwd()");
  assert.equal(JSON.parse(body.result), await fs.realpath(inst.cwd));
  assert.match(body.logs, /hello/);
  assert.match(body.logs, /oops/);
  assert.doesNotMatch(body.result, /hello/);
});

test('a program that returns nothing has a null result', async () => {
  const { body } = await run('await cc.list_projects();');
  assert.equal(body.result, null);
  assert.equal(body.error, undefined);
  assert.equal(body.exitCode, 0);
});

test('a tool refusal throws a ConductorError (status 200) and the tool call itself is not an error', async () => {
  const { status, body } = await run("await cc.describe_playbook({ id: 'no-such-playbook' });");
  assert.equal(status, 200);
  assert.notEqual(body.ok, false, 'run_code itself answered');
  assert.notEqual(body.exitCode, 0);
  assert.equal(body.error.name, 'ConductorError');
  assert.equal(body.error.code, 'PLAYBOOK_UNKNOWN');
  assert.equal(body.error.status, 200);
  assert.equal(body.result, null);
});

test('a refusal a program catches does not fail the run', async () => {
  const { body } = await run(`try { await cc.describe_playbook({ id: 'nope' }); } catch (e) { return [e.code, e.status]; }`);
  assert.deepEqual(JSON.parse(body.result), ['PLAYBOOK_UNKNOWN', 200]);
  assert.equal(body.exitCode, 0);
});

test('a malformed call is a fault (status 400) the program can catch', async () => {
  const { body } = await run(`try { await cc.call('list_projects', { bogus: 1 }); } catch (e) { return [e.code, e.status]; }`);
  assert.deepEqual(JSON.parse(body.result), ['ARGS_INVALID', 400]);
});

test('a non-serializable return is the run\'s TypeError, not a crash', async () => {
  const { body } = await run('return 1n;');
  assert.equal(body.error.name, 'TypeError');
  assert.equal(body.result, null);
});

test('a SyntaxError in the program is reported as the run\'s error', async () => {
  const { body } = await run('return (;');
  assert.equal(body.error.name, 'SyntaxError');
  assert.notEqual(body.exitCode, 0);
});

test('an uncaught rejection after the function returned still reports one result', async () => {
  const { body } = await run('Promise.reject(new Error("late")); await new Promise(r => setTimeout(r, 50)); return 1;');
  assert.ok(body.error || body.result === '1', 'one outcome was delivered');
});

test('an oversize return is cut with a marker, truncated, and its full length', async () => {
  const { body } = await run(`return 'x'.repeat(${RUN_RESULT_CAP * 2})`);
  assert.equal(body.truncated, true);
  assert.equal(body.resultChars, RUN_RESULT_CAP * 2 + 2);
  assert.match(body.result, /… \[result cut at \d+ of \d+ chars — return less\]$/);
  assert.equal(body.exitCode, 0);
});

test('oversize logs are head-capped and flagged, and the result survives them', async () => {
  const { body } = await run(`console.log('y'.repeat(${RUN_LOGS_CAP * 3})); return 'kept'`);
  assert.equal(body.logsTruncated, true);
  assert.ok(Buffer.byteLength(body.logs) <= RUN_LOGS_CAP);
  assert.equal(body.result, '"kept"');
});

test('the text view is a metadata block, then the result raw, then the logs raw', async () => {
  const result = await runCodeText(srv, sid, "console.log('L'); return { a: 'b' }");
  const [meta, res, logs] = result.content.map(c => c.text);
  const m = JSON.parse(meta);
  assert.equal(m.exitCode, 0);
  assert.equal(m.timedOut, false);
  assert.equal(m.result, undefined);
  assert.equal(m.logs, undefined);
  assert.equal(res, '{"a":"b"}');
  assert.equal(logs.trim(), 'L');
});

test('an unknown literal tool refuses the whole program and nothing ran', async () => {
  const before = (await api(srv.baseUrl, 'GET', '/api/workspaces')).body;
  const { status, body } = await run("await cc.create_workspace({ name: 'side' }); await cc.nope();");
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'TOOL_UNKNOWN');
  assert.equal(body.unknown[0].path, 'cc.nope');
  assert.deepEqual((await api(srv.baseUrl, 'GET', '/api/workspaces')).body, before, 'the workspace was not created');
});

test('a near-miss tool name carries a suggestion', async () => {
  const { body } = await run('await cc.list_projcts();');
  assert.equal(body.code, 'TOOL_UNKNOWN');
  assert.deepEqual(body.unknown[0].suggestions, ['cc.list_projects']);
});

test('a computed unknown name falls through to the runtime TOOL_UNKNOWN (404)', async () => {
  const { body } = await run(`const n = 'nope_' + 1; try { await cc.call(n); } catch (e) { return [e.code, e.status]; }`);
  assert.deepEqual(JSON.parse(body.result), ['TOOL_UNKNOWN', 404]);
});

test('timeout kills the whole process group, reports timedOut with a null exit code, and cc stays responsive', async () => {
  const { body } = await run(`
    const { spawn } = await import('node:child_process');
    const c = spawn('sleep', ['30'], { stdio: 'ignore' });
    console.log(JSON.stringify({ pid: process.pid, child: c.pid }));
    while (true) {}
  `, { timeoutMs: 2000 });
  assert.equal(body.timedOut, true);
  assert.equal(body.exitCode, null);
  const { pid, child } = JSON.parse(body.logs.trim().split('\n')[0]);
  await waitFor(() => !pidAlive(pid) && !pidAlive(child));
  const health = await fetch(`${srv.baseUrl}/api/health`);
  assert.equal(health.status, 200);
});

test('the run token is revoked once the run ends', async () => {
  const { body } = await run('return [process.env.CC_RUN_URL, process.env.CC_RUN_TOKEN]');
  const [url, token] = JSON.parse(body.result);
  const res = await fetch(`${url}/tools/list_projects`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-run-token': token }, body: '{}' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'RUN_TOKEN_INVALID');
});

test('run_code inside a program is refused SCRIPT_NESTED', async () => {
  const { body } = await run("await cc.run_code({ code: 'return 1' });");
  assert.equal(body.error.code, 'SCRIPT_NESTED');
  const viaCall = await run("await cc.call('run_code', { code: 'return 1' });");
  assert.equal(viaCall.body.error.code, 'SCRIPT_NESTED');
});

test('a run result delivered twice is refused, and one without a token is refused', async () => {
  const { body } = await run(`
    const post = () => fetch(process.env.CC_RUN_URL + '/run-result', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cc-run-token': process.env.CC_RUN_TOKEN },
      body: JSON.stringify({ result: '"early"', resultChars: 7, truncated: false }) });
    const first = await post();
    const second = await post();
    const anon = await fetch(process.env.CC_RUN_URL + '/run-result', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    console.log(JSON.stringify([first.status, second.status, (await second.json()).code, anon.status]));
    return 'late';
  `);
  assert.equal(body.exitCode, 0, JSON.stringify(body));
  assert.deepEqual(JSON.parse(body.logs.trim().split('\n')[0]), [204, 409, 'RUN_RESULT_DELIVERED', 403]);
  assert.equal(body.result, '"early"', 'the first delivery is the result, not the later return');
});

test('a run-result body that is not the outcome shape is refused 400', async () => {
  const { body } = await run(`
    const res = await fetch(process.env.CC_RUN_URL + '/run-result', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cc-run-token': process.env.CC_RUN_TOKEN },
      body: JSON.stringify({ result: 5 }) });
    return res.status;
  `);
  assert.equal(body.result, '400');
});

test('an anonymous caller is refused: run_code runs as a session', async () => {
  const { body } = await runCodeRest(srv, null, 'return 1');
  assert.equal(body.ok, false);
  assert.match(body.reason, /caller identity missing/);
});

test('plan mode: the child can read and call cc but cannot write files or start processes', async () => {
  const dir = await mkdtemp('cc-rc-plan-');
  const target = path.join(dir, 'x.txt');
  const code = `
    const fs = await import('node:fs');
    const out = {};
    try { fs.writeFileSync(${JSON.stringify(target)}, 'no'); out.write = 'allowed'; } catch (e) { out.write = e.code; }
    try { (await import('node:child_process')).execSync('true'); out.exec = 'allowed'; } catch (e) { out.exec = e.code; }
    out.read = fs.readFileSync('/etc/hostname', 'utf8').length > 0 || 'empty';
    out.cc = (await cc.list_projects()).projects.length > 0;
    return out;
  `;
  const { body } = await runCodeRest(srv, planSid, code);
  assert.equal(body.error, undefined, JSON.stringify(body));
  assert.deepEqual(JSON.parse(body.result), { write: 'ERR_ACCESS_DENIED', exec: 'ERR_ACCESS_DENIED', read: true, cc: true });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('control: the same write from a bypassPermissions session succeeds', async () => {
  const dir = await mkdtemp('cc-rc-bypass-');
  const target = path.join(dir, 'x.txt');
  const { body } = await run(`(await import('node:fs')).writeFileSync(${JSON.stringify(target)}, 'yes'); return 1`);
  assert.equal(body.error, undefined);
  assert.equal(await fs.readFile(target, 'utf8'), 'yes');
});

test('a program whose event loop empties before it returns is reported NoResult', async () => {
  const { body } = await run('await new Promise(() => {});');
  assert.equal(body.error.name, 'NoResult');
  assert.notEqual(body.exitCode, 0);
  assert.equal(body.timedOut, false);
});
