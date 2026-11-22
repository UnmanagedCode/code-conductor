// A headless run end to end: a real `node server.ts --prompt …` on a fresh
// projects root with the fake CLI. Stdout carries exactly the one result
// object (or, per --output-format, the text or the stream-json lines); every
// log line, the listening banner included, goes to stderr; the restart route
// refuses while the run is live; SIGINT mid-turn exits 130; a stream reader
// that goes away ends the run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { HEADLESS_FRAGMENT } from '../src/headless/fragment.ts';
import { waitFor } from './poll.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.resolve(__dirname, '..', 'server.ts');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.mjs');
const fx = (n) => path.join(__dirname, 'fixtures', n);
const BANNER = /code-conductor listening on http:\/\/127\.0\.0\.1:(\d+)\n/;

async function freshHome(t) {
  const home = await mkdtemp('headless-e2e-');
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function headless(t, home, scenario, args, { env = {} } = {}) {
  const child = spawn(process.execPath, [SERVER_TS, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PORT: '0',
      HOST: '127.0.0.1',
      PROJECTS_ROOT: path.join(home, 'project'),
      CLAUDE_PROJECTS_ROOT: path.join(home, '.claude', 'projects'),
      CLAUDE_BIN: `${process.execPath} ${FAKE_CLAUDE}`,
      FAKE_CLAUDE_SCENARIO: scenario,
      FAKE_CLAUDE_TRANSCRIPT: path.join(home, 'root-stdin.jsonl'),
      ORCH_IDLE_DRAIN_SETTLE_MS: '100',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (c) => { out.stdout += c; });
  child.stderr.setEncoding('utf8').on('data', (c) => { out.stderr += c; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } });
  return { child, out, closed };
}

function until(pred, what, timeout = 30_000) {
  return waitFor(pred, { timeout, interval: 50, label: what });
}

function onlyJson(stdout) {
  const lines = stdout.split('\n');
  assert.equal(lines.length, 2, `one line then the newline: ${JSON.stringify(stdout)}`);
  return JSON.parse(lines[0]);
}

test('a completed run: exit 0, the one result object on stdout, every log line on stderr', async (t) => {
  const home = await freshHome(t);
  const run = headless(t, home, fx('scenario-basic.json'), ['--prompt', 'say hi and finish']);
  const { code } = await run.closed;
  assert.equal(code, 0, run.out.stderr);
  const res = onlyJson(run.out.stdout);
  assert.equal(res.reason, 'completed');
  assert.equal(res.exitCode, 0);
  assert.equal(res.text, 'Hello, world!');
  assert.equal(typeof res.sessionId, 'string');
  assert.equal(typeof res.costUsd, 'number');
  assert.equal(typeof res.durationMs, 'number');
  assert.equal(res.error, null);
  assert.match(run.out.stderr, BANNER);
  assert.match(run.out.stderr, /headless: UI at http:\/\/127\.0\.0\.1:\d+\n/);
  assert.doesNotMatch(run.out.stdout, /listening on/);
  const sent = fs.readFileSync(path.join(home, 'root-stdin.jsonl'), 'utf8');
  assert.ok(sent.includes(JSON.stringify(`${HEADLESS_FRAGMENT}\n\nsay hi and finish`).slice(1, -1)), 'the root got the fragment then the prompt');
});

// Invariant (the restart and shutdown refusals): a headless run refuses both
// before any step. Invariant (the lifecycle skip): a headless boot neither
// consumes nor rewrites the interactive server's resume manifest or running
// record — both are byte-identical after the run.
test('mid-run, the restart and shutdown routes refuse 409; the resume files are left alone; SIGINT then exits 130 with a signal object', async (t) => {
  const home = await freshHome(t);
  const store = path.join(home, 'project', '.code-conductor');
  fs.mkdirSync(store, { recursive: true });
  const planted = {
    'pending-resume.json': JSON.stringify({ writtenAt: 'x', deliver: 'gated', instances: [{ project: 'gone', sessionId: 'aaaa', group: 'other' }] }),
    'running-sessions.json': JSON.stringify({ writtenAt: 'x', instances: [{ project: 'gone', sessionId: 'bbbb', group: 'other' }], clis: [] }),
  };
  for (const [name, body] of Object.entries(planted)) fs.writeFileSync(path.join(store, name), body);
  const run = headless(t, home, fx('scenario-headless-root-gated.json'), ['--prompt', 'stay busy']);
  const port = Number((await until(() => BANNER.exec(run.out.stderr), 'the listening banner'))[1]);
  const base = `http://127.0.0.1:${port}`;
  await until(async () => {
    const rows = await (await fetch(`${base}/api/instances`)).json();
    return rows.some((r) => r.project === '.conduct' && r.status === 'turn');
  }, 'the root mid-turn');
  const restart = await fetch(`${base}/api/admin/restart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(restart.status, 409);
  assert.equal((await restart.json()).code, 'RESTART_DISABLED_HEADLESS');
  const shutdown = await fetch(`${base}/api/admin/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(shutdown.status, 409);
  assert.equal((await shutdown.json()).code, 'SHUTDOWN_DISABLED_HEADLESS');
  run.child.kill('SIGINT');
  const { code } = await run.closed;
  assert.equal(code, 130, run.out.stderr);
  for (const [name, body] of Object.entries(planted)) assert.equal(fs.readFileSync(path.join(store, name), 'utf8'), body, name);
  const res = onlyJson(run.out.stdout);
  assert.equal(res.reason, 'signal');
  assert.equal(res.exitCode, 130);
  assert.match(res.error, /SIGINT/);
  assert.equal(res.text, 'Dispatching.');
});

// A cost read that fails (here costs.jsonl turned into a directory once the
// root is busy) costs the result its costUsd and nothing else.
async function runWithBrokenCosts(t, finishRun) {
  const home = await freshHome(t);
  const run = headless(t, home, fx('scenario-headless-root-gated.json'), ['--prompt', 'stay busy']);
  const port = Number((await until(() => BANNER.exec(run.out.stderr), 'the listening banner'))[1]);
  const base = `http://127.0.0.1:${port}`;
  const row = await until(async () => {
    const rows = await (await fetch(`${base}/api/instances`)).json();
    return rows.find((r) => r.project === '.conduct' && r.status === 'turn');
  }, 'the root mid-turn');
  const costs = path.join(home, 'project', '.code-conductor', 'costs.jsonl');
  fs.rmSync(costs, { recursive: true, force: true });
  fs.mkdirSync(costs);
  await finishRun({ run, base, row });
  const { code } = await run.closed;
  return { code, out: run.out };
}

test('a cost read that fails on completion: still one completed object, costUsd null, the failure on stderr', async (t) => {
  const { code, out } = await runWithBrokenCosts(t, async ({ base, row }) => {
    // send_prompt with no caller is the user's own send; it ends the open root turn.
    const res = await fetch(`${base}/mcp?format=text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_prompt', arguments: { sessionId: row.sessionId, text: 'wrap up' } } }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(code, 0, out.stderr);
  const res = onlyJson(out.stdout);
  assert.equal(res.reason, 'completed');
  assert.equal(res.costUsd, null);
  assert.equal(res.text, 'Waiting on the worker.');
  assert.match(out.stderr, /reading the run's cost failed/);
});

test('a cost read that fails on a signal: still one signal object, exit 130', async (t) => {
  const { code, out } = await runWithBrokenCosts(t, async ({ run }) => { run.child.kill('SIGINT'); });
  assert.equal(code, 130, out.stderr);
  const res = onlyJson(out.stdout);
  assert.equal(res.reason, 'signal');
  assert.equal(res.costUsd, null);
  assert.equal(out.stderr.match(/reading the run's cost failed/g)?.length, 1, 'the failed read is logged once');
});

// The root's open turn ended through MCP send_prompt with no caller: the user's own send.
async function sendPrompt(base, sessionId, text) {
  const res = await fetch(`${base}/mcp?format=text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_prompt', arguments: { sessionId, text } } }),
  });
  assert.equal(res.status, 200);
}

const streamLines = (stdout) => {
  assert.ok(stdout.endsWith('\n'), JSON.stringify(stdout.slice(-200)));
  return stdout.slice(0, -1).split('\n').map((l) => JSON.parse(l));
};

// Invariant: the default output is unchanged — an explicit json run prints the
// same one object, in the same key order, as the default.
test('--output-format json prints the default\'s object, same key order', async (t) => {
  const keys = [];
  for (const extra of [[], ['--output-format', 'json']]) {
    const home = await freshHome(t);
    const run = headless(t, home, fx('scenario-basic.json'), ['--prompt', 'say hi', ...extra]);
    const { code } = await run.closed;
    assert.equal(code, 0, run.out.stderr);
    const res = onlyJson(run.out.stdout);
    assert.equal(res.reason, 'completed');
    keys.push(Object.keys(res));
  }
  assert.deepEqual(keys[1], keys[0]);
  assert.deepEqual(keys[0], ['reason', 'exitCode', 'sessionId', 'text', 'costUsd', 'durationMs', 'error']);
});

// Invariant (spec 3 framing, final-line ordering): stream-json is the root
// CLI's lines, then exactly one final cc_result line; no banner on stdout.
test('stream-json: the root CLI\'s lines, then one cc_result line last', async (t) => {
  const home = await freshHome(t);
  const run = headless(t, home, fx('scenario-basic.json'), ['--prompt', 'say hi', '--output-format', 'stream-json']);
  const { code } = await run.closed;
  assert.equal(code, 0, run.out.stderr);
  assert.doesNotMatch(run.out.stdout, /listening on/);
  const lines = streamLines(run.out.stdout);
  const last = lines.at(-1);
  assert.deepEqual({ type: last.type, reason: last.reason, text: last.text }, { type: 'cc_result', reason: 'completed', text: 'Hello, world!' });
  assert.equal(typeof last.sessionId, 'string');
  const before = lines.slice(0, -1);
  assert.ok(!before.some((l) => l.type === 'cc_result'), 'cc_result only once, last');
  assert.ok(before.some((l) => l.type === 'system' && l.subtype === 'init'), 'a system/init precedes it');
  assert.ok(before.some((l) => l.type === 'result'), 'a CLI result line precedes it');
  assert.ok(!before.some((l) => 'cc_session_id' in l), 'root-only lines carry no labels');
});

// Invariant: with --include-workers every streamed line carries the six labels;
// a lone root is the conductor with no parent, named by cc_result's sessionId.
test('stream-json --include-workers: every CLI line labelled as the root conductor', async (t) => {
  const home = await freshHome(t);
  const run = headless(t, home, fx('scenario-basic.json'), ['--prompt', 'say hi', '--output-format', 'stream-json', '--include-workers']);
  const { code } = await run.closed;
  assert.equal(code, 0, run.out.stderr);
  const lines = streamLines(run.out.stdout);
  const last = lines.at(-1);
  assert.equal(last.type, 'cc_result');
  assert.ok(!('cc_session_id' in last), 'cc_result carries no labels');
  const before = lines.slice(0, -1);
  assert.ok(before.length > 0);
  for (const l of before) {
    for (const k of ['cc_session_id', 'cc_parent_session_id', 'cc_root_session_id', 'cc_role', 'cc_project', 'cc_worktree']) assert.ok(k in l, `${k} in ${JSON.stringify(l)}`);
    assert.equal(l.cc_role, 'conductor');
    assert.equal(l.cc_parent_session_id, null);
    assert.equal(l.cc_session_id, last.sessionId);
    assert.equal(l.cc_root_session_id, last.sessionId);
  }
});

// Invariant: text prints the result text alone.
test('text: stdout is exactly the result text', async (t) => {
  const home = await freshHome(t);
  const run = headless(t, home, fx('scenario-basic.json'), ['--prompt', 'say hi', '--output-format', 'text']);
  const { code } = await run.closed;
  assert.equal(code, 0, run.out.stderr);
  assert.equal(run.out.stdout, 'Hello, world!\n');
});

// Invariant: a signal mid-run still ends the stream with its cc_result line.
test('stream-json, SIGINT mid-turn: exit 130, the last line a signal cc_result', async (t) => {
  const home = await freshHome(t);
  const run = headless(t, home, fx('scenario-headless-root-gated.json'), ['--prompt', 'stay busy', '--output-format', 'stream-json']);
  const port = Number((await until(() => BANNER.exec(run.out.stderr), 'the listening banner'))[1]);
  await until(async () => {
    const rows = await (await fetch(`http://127.0.0.1:${port}/api/instances`)).json();
    return rows.some((r) => r.project === '.conduct' && r.status === 'turn');
  }, 'the root mid-turn');
  run.child.kill('SIGINT');
  const { code } = await run.closed;
  assert.equal(code, 130, run.out.stderr);
  const last = streamLines(run.out.stdout).at(-1);
  assert.equal(last.type, 'cc_result');
  assert.equal(last.reason, 'signal');
});

// Invariant: a stream consumer that goes away ends the run promptly as a
// conductor_error — no hang, no spending on until completion, and never the
// catch-all.
test('stream-json, the reader closes mid-run: exit 3 well inside the settle window, no catch-all', async (t) => {
  const home = await freshHome(t);
  const run = headless(t, home, fx('scenario-headless-root-gated.json'), ['--prompt', 'stay busy', '--output-format', 'stream-json'],
    { env: { ORCH_IDLE_DRAIN_SETTLE_MS: '30000' } });
  await until(() => run.out.stdout.length > 0, 'the first streamed line');
  const port = Number((await until(() => BANNER.exec(run.out.stderr), 'the listening banner'))[1]);
  const base = `http://127.0.0.1:${port}`;
  const row = await until(async () => {
    const rows = await (await fetch(`${base}/api/instances`)).json();
    return rows.find((r) => r.project === '.conduct' && r.status === 'turn');
  }, 'the root mid-turn');
  run.child.stdout.destroy();
  const t0 = Date.now();
  await sendPrompt(base, row.sessionId, 'wrap up');
  const { code } = await run.closed;
  assert.ok(Date.now() - t0 < 15_000, `exited after ${Date.now() - t0} ms`);
  assert.equal(code, 3, run.out.stderr);
  // The mid-run diagnostic (onStdoutError), distinct from finish's
  // undelivered-result line, which also says "stdout closed".
  const midRun = run.out.stderr.search(/headless: stdout closed \([^)]+\); ending the run\n/);
  assert.ok(midRun >= 0, run.out.stderr);
  // onStdoutError logs before run.fail; finish (and its delivery-failure line)
  // only follows the run's async end. The later line is checked for order only:
  // the process exits right after writing it.
  const undelivered = run.out.stderr.indexOf('headless: the result was not delivered');
  if (undelivered >= 0) assert.ok(midRun < undelivered, run.out.stderr);
  assert.doesNotMatch(run.out.stderr, /unexpected failure/);
});
