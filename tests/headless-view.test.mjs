// `node server.ts --view` end to end: a real process over a root a headless run
// finished, with the fake CLI. A replay serves the run's session view-only and
// focused, starts no CLI, leaves the session store byte-identical, and ends on a
// signal with one `stopped` object. The fake CLI writes no transcript, so each
// fixture seeds the one the CLI would have written, at the session's backing id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { waitFor } from './poll.mjs';
import { encodeCwd } from '../src/projects.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.resolve(__dirname, '..', 'server.ts');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.mjs');
const HOLDER = path.join(__dirname, 'rootLockHolder.mjs');
const fx = (n) => path.join(__dirname, 'fixtures', n);
const BANNER = /code-conductor listening on http:\/\/127\.0\.0\.1:(\d+)\n/;
const SEEDED = 'REPLAY-MARKER finished';

async function freshHome(t) {
  const home = await mkdtemp('headless-view-');
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function spawnServer(t, home, args, env = {}) {
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
      FAKE_CLAUDE_SCENARIO: fx('scenario-basic.json'),
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

const until = (pred, what, timeout = 30_000) => waitFor(pred, { timeout, interval: 50, label: what });

function onlyJson(stdout) {
  const lines = stdout.split('\n');
  assert.equal(lines.length, 2, `one line then the newline: ${JSON.stringify(stdout)}`);
  return JSON.parse(lines[0]);
}

// A finished headless run on `home`: its session's public id, and the transcript
// its CLI would have written seeded under the segment's backing id.
async function finishedRun(t, home) {
  const run = spawnServer(t, home, ['--prompt', 'say hi and finish'], { FAKE_CLAUDE_ARGV_DUMP: path.join(home, 'run-argv') });
  const { code } = await run.closed;
  assert.equal(code, 0, run.out.stderr);
  const sessionId = onlyJson(run.out.stdout).sessionId;
  const store = path.join(home, 'project', '.code-conductor');
  const rec = JSON.parse(fs.readFileSync(path.join(store, 'sessions.json'), 'utf8')).sessions[sessionId];
  const dir = path.join(home, '.claude', 'projects', encodeCwd(path.join(fs.realpathSync(path.join(home, 'project')), '.conduct')));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.current}.jsonl`), [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'say hi and finish' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: SEEDED }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { sessionId, backingId: rec.current, store };
}

async function startReplay(t, home, args, env) {
  const view = spawnServer(t, home, ['--view', ...args], env);
  const port = Number((await until(() => BANNER.exec(view.out.stderr), 'the listening banner'))[1]);
  return { view, base: `http://127.0.0.1:${port}` };
}

// Invariant: a replay serves the finished session view-only and focused, starts
// no CLI by any route, leaves sessions.json byte-identical, and a SIGINT ends it
// with exit 0 and one `stopped` object naming the session.
test('replay serves the finished session read-only, spawns nothing, and stops on SIGINT', async (t) => {
  const home = await freshHome(t);
  const { sessionId, store } = await finishedRun(t, home);
  assert.ok(fs.existsSync(path.join(home, 'run-argv')), 'positive control: the run itself invoked the fake CLI');
  const before = fs.readFileSync(path.join(store, 'sessions.json'));
  const dump = path.join(home, 'view-argv');
  const { view, base } = await startReplay(t, home, [], { FAKE_CLAUDE_ARGV_DUMP: dump });
  assert.match(view.out.stderr, new RegExp(`viewing session ${sessionId}`));
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.capabilities.viewOnly, true);
  assert.deepEqual(health.focus, { sessionId });
  assert.deepEqual(await (await fetch(`${base}/api/instances`)).json(), []);
  const post = await fetch(`${base}/api/instances`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resume: sessionId }) });
  assert.equal(post.status, 409);
  assert.equal((await post.json()).code, 'VIEW_REPLAY_NO_LAUNCH');
  const events = await fetch(`${base}/api/sessions/${sessionId}/lineage-events`);
  assert.equal(events.status, 200);
  assert.ok(JSON.stringify(await events.json()).includes(SEEDED), 'the seeded transcript is served');
  view.child.kill('SIGINT');
  const { code } = await view.closed;
  assert.equal(code, 0, view.out.stderr);
  const res = onlyJson(view.out.stdout);
  assert.equal(res.reason, 'stopped');
  assert.equal(res.exitCode, 0);
  assert.equal(res.sessionId, sessionId);
  assert.equal(res.error, null);
  assert.equal(fs.existsSync(dump), false, 'no CLI was ever invoked');
  assert.ok(fs.readFileSync(path.join(store, 'sessions.json')).equals(before), 'sessions.json is byte-identical');
});

// Invariant: SIGTERM is the replay's normal end too.
test('SIGTERM ends a replay with exit 0 and a stopped object', async (t) => {
  const home = await freshHome(t);
  const { sessionId } = await finishedRun(t, home);
  const { view } = await startReplay(t, home, []);
  view.child.kill('SIGTERM');
  const { code } = await view.closed;
  assert.equal(code, 0, view.out.stderr);
  const res = onlyJson(view.out.stdout);
  assert.equal(res.reason, 'stopped');
  assert.equal(res.sessionId, sessionId);
});

// Invariant: --session accepts a segment id and advertises the session's public id.
test('--session <segment id> shows the public id', async (t) => {
  const home = await freshHome(t);
  const { sessionId, backingId } = await finishedRun(t, home);
  const { view, base } = await startReplay(t, home, ['--session', backingId]);
  assert.deepEqual((await (await fetch(`${base}/api/health`)).json()).focus, { sessionId });
  view.child.kill('SIGINT');
  await view.closed;
});

// Invariant: a refusal to pick a session exits 4 with one no_session object naming why.
test('an unknown --session: exit 4, no_session naming the id', async (t) => {
  const home = await freshHome(t);
  await finishedRun(t, home);
  const view = spawnServer(t, home, ['--view', '--session', 'no-such-session']);
  const { code } = await view.closed;
  assert.equal(code, 4, view.out.stderr);
  const res = onlyJson(view.out.stdout);
  assert.equal(res.reason, 'no_session');
  assert.equal(res.exitCode, 4);
  assert.match(res.error, /no-such-session/);
});

test('a fresh root with no recorded run: exit 4, no_session', async (t) => {
  const home = await freshHome(t);
  const view = spawnServer(t, home, ['--view']);
  const { code } = await view.closed;
  assert.equal(code, 4, view.out.stderr);
  const res = onlyJson(view.out.stdout);
  assert.equal(res.reason, 'no_session');
  assert.match(res.error, /--session/);
});

// Invariant: a replay takes the root lock like any server, so a held root is exit 7.
test('a held root: exit 7, a root_held object', async (t) => {
  const home = await freshHome(t);
  const holder = spawn(process.execPath, [HOLDER, path.join(home, 'project')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    let buf = '';
    holder.stdout.setEncoding('utf8').on('data', (c) => { buf += c; if (/HELD 1\n/.test(buf)) resolve(); });
    holder.once('exit', () => reject(new Error(`holder exited: ${buf}`)));
  });
  const view = spawnServer(t, home, ['--view']);
  const { code } = await view.closed;
  assert.equal(code, 7, view.out.stderr);
  const res = onlyJson(view.out.stdout);
  assert.equal(res.reason, 'root_held');
  assert.equal(res.exitCode, 7);
});
