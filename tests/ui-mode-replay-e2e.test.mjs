// A `--replay` under each `--ui` mode, end to end: a real `node server.ts`
// over a root a headless run finished (tests/headlessProcess.mjs finishedRun),
// with the fake CLI (scenario-ui-mode.json) for anything the replay launches,
// driven through cc's REAL client modules (nodeClient). Under `view` the replay
// is launchless; under `interact` / `full` it is a working conductor whose
// resumed root gets the headless ask policy, and a signal mid-turn
// force-interrupts the root before the `stopped` result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  freshHome as scratchHome, spawnServer, until, onlyJson, fx, baseOf, nodeClient,
  finishedRun, spawnWorker, liveRow, stdinText,
} from './headlessProcess.mjs';
import { HEADLESS_QUESTION_ANSWER } from '../src/headless/fragment.ts';
import { INTERRUPT_WAIT_MS } from '../src/headless/rootPolicy.ts';

const freshHome = (t) => scratchHome(t, 'ui-mode-replay-');
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function replay(t, ui) {
  const home = await freshHome(t);
  const { sessionId } = await finishedRun(t, home);
  const transcript = path.join(home, 'cli-stdin.jsonl');
  const argvDump = path.join(home, 'replay-argv');
  const proc = spawnServer(t, home, ['--replay', ...(ui ? ['--ui', ui] : [])], {
    FAKE_CLAUDE_SCENARIO: fx('scenario-ui-mode.json'),
    FAKE_CLAUDE_TRANSCRIPT: transcript,
    FAKE_CLAUDE_ARGV_DUMP: argvDump,
  });
  const base = await baseOf(proc);
  return { home, sessionId, proc, base, transcript, argvDump };
}

// Through the client's chokepoint: restore, then resume, the replayed root; its live row once idle.
async function resumeRoot(client, base, sessionId) {
  await client.http.apiFetch(`/api/projects/.conduct/sessions/${sessionId}/restore`, { method: 'POST' });
  await client.http.apiFetch('/api/instances', json({ project: '.conduct', resume: sessionId }));
  const row = await liveRow(base, sessionId, 'idle');
  await client.refresh();
  return row;
}

// Invariant: a `--replay` defaults to `view` and is launchless: health says
// view, a resume over REST is refused 409 VIEW_REPLAY_NO_LAUNCH, and no CLI is
// ever invoked.
test('--replay (default view): launchless', async (t) => {
  const { sessionId, proc, base, argvDump } = await replay(t);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.uiMode, 'view');
  assert.deepEqual(health.focus, { sessionId });
  const res = await fetch(`${base}/api/instances`, json({ project: '.conduct', resume: sessionId }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'VIEW_REPLAY_NO_LAUNCH');
  proc.child.kill('SIGINT');
  const { code } = await proc.closed;
  assert.equal(code, 0, proc.out.stderr);
  assert.equal(fs.existsSync(argvDump), false, 'no CLI was ever invoked');
});

// Invariant: `--replay --ui interact` is a working conductor for the focused
// root only: the client's restore and resume of the root pass its chokepoint
// and the root goes live; the root can spawn a worker (no 409); the worker's
// client prompt is refused; the root's client prompt passes and its tool
// question gets HEADLESS_QUESTION_ANSWER; restart and shutdown stay refused
// (409); and a SIGINT while the root is mid-turn exits 0 with one `stopped`
// object naming the session, within INTERRUPT_WAIT_MS plus slack.
test('--replay --ui interact: resume, spawn, ask policy, refusals, signal', async (t) => {
  const { sessionId, proc, base, transcript } = await replay(t, 'interact');
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.uiMode, 'interact');
  assert.deepEqual(health.focus, { sessionId });
  const client = await nodeClient(t, base);
  await client.ready();
  const root = await resumeRoot(client, base, sessionId);

  const worker = await spawnWorker(base, sessionId);
  await client.refresh();
  await assert.rejects(client.ws.send('prompt', { id: worker.id, text: 'REFUSED-WORKER-TEXT' }, { ack: true }), (e) => e?.code === 'VIEW_ONLY');

  await client.ws.send('prompt', { id: root.id, text: 'ASK-ME please' }, { ack: true });
  await until(() => stdinText(transcript).includes(HEADLESS_QUESTION_ANSWER), 'the headless answer reached the resumed root', 30_000);
  assert.ok(!stdinText(transcript).includes('REFUSED-WORKER-TEXT'), 'the worker prompt never reached a CLI');

  for (const action of ['restart', 'shutdown']) {
    const r = await fetch(`${base}/api/admin/${action}`, { method: 'POST' });
    assert.equal(r.status, 409, action);
  }

  await liveRow(base, sessionId, 'idle');
  await client.ws.send('prompt', { id: root.id, text: 'HOLD-THE-TURN' }, { ack: true });
  await liveRow(base, sessionId, 'turn');
  client.close();
  const t0 = Date.now();
  proc.child.kill('SIGINT');
  const { code } = await proc.closed;
  assert.equal(code, 0, proc.out.stderr);
  assert.ok(Date.now() - t0 < INTERRUPT_WAIT_MS + 10_000, `stopped within the interrupt bound (${Date.now() - t0}ms)`);
  const res = onlyJson(proc.out.stdout);
  assert.equal(res.reason, 'stopped');
  assert.equal(res.exitCode, 0);
  assert.equal(res.sessionId, sessionId);
});

// Invariant: `--replay --ui full` controls every session: after the root's
// resume and a worker spawn, the worker's client prompt is accepted and
// reaches the worker.
test('--replay --ui full: a worker\'s client prompt is accepted', async (t) => {
  const { sessionId, proc, base, transcript } = await replay(t, 'full');
  assert.equal((await (await fetch(`${base}/api/health`)).json()).uiMode, 'full');
  const client = await nodeClient(t, base);
  await client.ready();
  await resumeRoot(client, base, sessionId);
  const worker = await spawnWorker(base, sessionId);
  await client.refresh();
  const ack = await client.ws.send('prompt', { id: worker.id, text: 'WORK-ITEM from the replay UI' }, { ack: true });
  assert.equal(ack.ok, true);
  await until(() => stdinText(transcript).includes('WORK-ITEM from the replay UI'), 'the worker prompt reached the worker');
  client.close();
  proc.child.kill('SIGINT');
  await proc.closed;
});
