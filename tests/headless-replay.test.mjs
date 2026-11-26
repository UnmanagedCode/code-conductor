// `node server.ts --replay` end to end: a real process over a root a headless
// run finished, with the fake CLI. A replay under the default `--ui view`
// serves the run's session read-only and focused, starts no CLI, leaves the
// session store byte-identical, and ends on a signal with one `stopped` object.
// The fake CLI writes no transcript, so each fixture seeds the one the CLI
// would have written, at the session's backing id (tests/headlessProcess.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freshHome as scratchHome, spawnServer, onlyJson, finishedRun, baseOf, SEEDED } from './headlessProcess.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOLDER = path.join(__dirname, 'rootLockHolder.mjs');
const freshHome = (t) => scratchHome(t, 'headless-replay-');

async function startReplay(t, home, args, env) {
  const view = spawnServer(t, home, ['--replay', ...args], env);
  return { view, base: await baseOf(view) };
}

// Invariant: a replay (default `--ui view`) serves the finished session
// read-only and focused, advertises uiMode view, starts no CLI by any route,
// leaves sessions.json byte-identical, and a SIGINT ends it with exit 0 and one
// `stopped` object naming the session.
test('replay serves the finished session read-only, spawns nothing, and stops on SIGINT', async (t) => {
  const home = await freshHome(t);
  const { sessionId, store } = await finishedRun(t, home);
  assert.ok(fs.existsSync(path.join(home, 'run-argv')), 'positive control: the run itself invoked the fake CLI');
  const before = fs.readFileSync(path.join(store, 'sessions.json'));
  const dump = path.join(home, 'view-argv');
  const { view, base } = await startReplay(t, home, [], { FAKE_CLAUDE_ARGV_DUMP: dump });
  assert.match(view.out.stderr, new RegExp(`replaying session ${sessionId} \\(--ui view\\)`));
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.uiMode, 'view');
  assert.equal('viewOnly' in health.capabilities, false);
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
  const view = spawnServer(t, home, ['--replay', '--session', 'no-such-session']);
  const { code } = await view.closed;
  assert.equal(code, 4, view.out.stderr);
  const res = onlyJson(view.out.stdout);
  assert.equal(res.reason, 'no_session');
  assert.equal(res.exitCode, 4);
  assert.match(res.error, /no-such-session/);
});

// Invariant: a root no headless run has recorded refuses the replay (exit 4),
// asking for --session.
test('a fresh root with no recorded run: exit 4, no_session', async (t) => {
  const home = await freshHome(t);
  const view = spawnServer(t, home, ['--replay']);
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
  const view = spawnServer(t, home, ['--replay']);
  const { code } = await view.closed;
  assert.equal(code, 7, view.out.stderr);
  const res = onlyJson(view.out.stdout);
  assert.equal(res.reason, 'root_held');
  assert.equal(res.exitCode, 7);
});
