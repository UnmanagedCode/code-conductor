// A live headless run under each `--ui` mode, end to end: a real
// `node server.ts --prompt …` with the fake CLI (scenario-ui-mode.json: the
// root's run turn stays open until its next prompt), driven through cc's REAL
// client modules (tests/headlessProcess.mjs nodeClient). A client-side refusal
// is proven twice: the send rejects with ViewOnlyError, and its text never
// reaches any CLI's stdin (FAKE_CLAUDE_TRANSCRIPT, which root and workers share),
// read after a positive-control send that did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  freshHome as scratchHome, spawnServer, until, onlyJson, fx, baseOf, nodeClient,
  mcpCall, spawnWorker, liveRow, stdinText,
} from './headlessProcess.mjs';

const freshHome = (t) => scratchHome(t, 'ui-mode-live-');

// A live run under `ui` (none: the default), its root mid-turn and focused.
async function liveRun(t, ui) {
  const home = await freshHome(t);
  const transcript = path.join(home, 'cli-stdin.jsonl');
  const run = spawnServer(t, home, ['--prompt', 'stay busy', ...(ui ? ['--ui', ui] : [])], {
    FAKE_CLAUDE_SCENARIO: fx('scenario-ui-mode.json'),
    FAKE_CLAUDE_TRANSCRIPT: transcript,
  });
  const base = await baseOf(run);
  const root = await until(async () => (await (await fetch(`${base}/api/instances`)).json())
    .find((r) => r.project === '.conduct' && r.status === 'turn'), 'the root mid-turn');
  await until(async () => (await (await fetch(`${base}/api/health`)).json()).focus?.sessionId === root.sessionId, 'the focus on the root');
  return { home, run, base, root, transcript };
}

const refused = (p) => assert.rejects(p, (e) => e?.code === 'VIEW_ONLY');

async function completes(run) {
  const { code } = await run.closed;
  assert.equal(code, 0, run.out.stderr);
  const res = onlyJson(run.out.stdout);
  assert.equal(res.reason, 'completed');
  return res;
}

// Invariant: a live run defaults to `view`: health says view and focuses the
// root, the client's root prompt is refused and never reaches the CLI, and the
// run still completes (exit 0) when the root is ended over MCP.
test('default: view — the root prompt is refused client-side; the run completes', async (t) => {
  const { run, base, root, transcript } = await liveRun(t);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.uiMode, 'view');
  assert.deepEqual(health.focus, { sessionId: root.sessionId });
  assert.match(run.out.stderr, /headless: UI mode view/);
  const client = await nodeClient(t, base);
  await client.ready();
  await refused(client.ws.send('prompt', { id: root.id, text: 'REFUSED-ROOT-TEXT' }, { ack: true }));
  await mcpCall(base, 'send_prompt', { sessionId: root.sessionId, text: 'MCP-ENDS-IT' });
  await until(() => stdinText(transcript).includes('MCP-ENDS-IT'), 'positive control: the MCP send reached the root');
  assert.ok(!stdinText(transcript).includes('REFUSED-ROOT-TEXT'), 'the refused prompt never reached a CLI');
  client.close();
  await completes(run);
});

// Invariant: an explicit `--ui view` equals the default: health says view and
// the root prompt is refused client-side.
test('--ui view equals the default', async (t) => {
  const { run, base, root, transcript } = await liveRun(t, 'view');
  assert.equal((await (await fetch(`${base}/api/health`)).json()).uiMode, 'view');
  const client = await nodeClient(t, base);
  await client.ready();
  await refused(client.ws.send('prompt', { id: root.id, text: 'REFUSED-ROOT-TEXT' }, { ack: true }));
  await mcpCall(base, 'send_prompt', { sessionId: root.sessionId, text: 'MCP-ENDS-IT' });
  await until(() => stdinText(transcript).includes('MCP-ENDS-IT'), 'positive control');
  assert.ok(!stdinText(transcript).includes('REFUSED-ROOT-TEXT'));
  client.close();
  await completes(run);
});

// Invariant: under `--ui interact` only the focused root is controllable: the
// client's root prompt is accepted and reaches the root's stdin, a worker the
// root spawned has its prompt refused client-side (never written), and the
// human's steer leaves completion alone — the run ends `completed`, exit 0.
test('--ui interact: the root prompt is accepted, a worker\'s refused; the run completes', async (t) => {
  const { run, base, root, transcript } = await liveRun(t, 'interact');
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.uiMode, 'interact');
  assert.deepEqual(health.focus, { sessionId: root.sessionId });
  const worker = await spawnWorker(base, root.sessionId);
  const client = await nodeClient(t, base);
  await client.ready();
  await refused(client.ws.send('prompt', { id: worker.id, text: 'REFUSED-WORKER-TEXT' }, { ack: true }));
  const ack = await client.ws.send('prompt', { id: root.id, text: 'ROOT-STEER-FROM-UI' }, { ack: true });
  assert.equal(ack.ok, true);
  await until(() => stdinText(transcript).includes('ROOT-STEER-FROM-UI'), 'the root prompt reached the root');
  assert.ok(!stdinText(transcript).includes('REFUSED-WORKER-TEXT'), 'the worker prompt never reached a CLI');
  client.close();
  await completes(run);
});

// Invariant: a live run under `--ui full` controls every session: a worker's
// client prompt is accepted and reaches the worker.
test('--ui full: a worker\'s client prompt is accepted', async (t) => {
  const { run, base, root, transcript } = await liveRun(t, 'full');
  assert.equal((await (await fetch(`${base}/api/health`)).json()).uiMode, 'full');
  const worker = await spawnWorker(base, root.sessionId);
  const client = await nodeClient(t, base);
  await client.ready();
  const ack = await client.ws.send('prompt', { id: worker.id, text: 'WORK-ITEM from the UI' }, { ack: true });
  assert.equal(ack.ok, true);
  await until(() => stdinText(transcript).includes('WORK-ITEM from the UI'), 'the worker prompt reached the worker');
  await liveRow(base, worker.sessionId, 'turn');
  client.close();
  run.child.kill('SIGINT');
  await run.closed;
});
