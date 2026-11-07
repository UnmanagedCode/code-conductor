// A headless run end to end: a real `node server.ts --prompt …` on a fresh
// projects root with the fake CLI. Stdout carries exactly the one result
// object; every log line, the listening banner included, goes to stderr; the
// restart route refuses while the run is live; SIGINT mid-turn exits 130.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { HEADLESS_FRAGMENT } from '../src/headless/fragment.ts';

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

function headless(t, home, scenario, args) {
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

async function until(pred, what, timeout = 30_000) {
  const start = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
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

test('mid-run, the restart route refuses 409; SIGINT then exits 130 with a signal object', async (t) => {
  const home = await freshHome(t);
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
  run.child.kill('SIGINT');
  const { code } = await run.closed;
  assert.equal(code, 130, run.out.stderr);
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
