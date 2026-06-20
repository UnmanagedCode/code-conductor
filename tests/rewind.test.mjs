// End-to-end REST coverage of POST /api/instances/:id/rewind. Seeds a
// jsonl on disk (the fake-claude doesn't write one), spawns a --resume
// instance against it, calls the endpoint, and asserts the ring buffer
// + jsonl reflect the rewind.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');
const SCENARIO_INSTANCE = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;
before(async () => { ctx = await bootServer({ scenarioPath: SCENARIO }); ({ baseUrl, instances } = ctx); });
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot, claudeProjectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

async function seedSession({ projectName, sid, lines }) {
  await api(baseUrl, 'POST', '/api/projects', { name: projectName });
  const projectPath = path.join(projectsRoot, projectName);
  const sessionDir = path.join(claudeProjectsRoot, encodeCwd(projectPath));
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, `${sid}.jsonl`),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n',
  );
  return { projectPath, sessionDir };
}

function collectEvents() {
  const events = [];
  instances.on('event', ({ id, ev }) => events.push({ id, ev }));
  return events;
}

function userPromptLines(persisted) {
  return persisted.split('\n').filter(l => l.trim().length)
    .map(l => JSON.parse(l))
    .filter(o =>
      o.type === 'user' && o.message
      && (typeof o.message.content === 'string'
          || (Array.isArray(o.message.content) && o.message.content.some(b => b?.type === 'text'))));
}

test('rewind drops the chosen user message + tail, ring is rebuilt from truncated jsonl', async () => {
  const sid = 'rrrrrrrr-2222-3333-4444-555555555555';
  const { sessionDir } = await seedSession({
    projectName: 'rewindable', sid,
    lines: [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first prompt' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
        { type: 'text', text: 'first reply' },
      ] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second prompt' } },
      { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [
        { type: 'text', text: 'second reply' },
      ] } },
    ],
  });

  const events = collectEvents();
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'rewindable', mode: 'bypassPermissions', resume: sid,
  });
  assert.equal(r.status, 201);
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle');

  // Sanity: pre-rewind ring has 2 user_echoes.
  const preEchoes = events.filter(e => e.id === id && e.ev.kind === 'user_echo').length;
  assert.equal(preEchoes, 2, 'two user_echoes replayed from history');

  // Rewind at index 1 → drop the 2nd user prompt + everything after.
  const resets = [];
  instances.on('snapshot_reset', (snap) => {
    if (snap.id === id) resets.push(snap);
  });
  const rew = await api(baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 1 });
  assert.equal(rew.status, 200);
  assert.equal(rew.body.droppedText, 'second prompt');

  // snapshot_reset fired once for this instance, and carries droppedText
  // on the frame so the client can prefill the composer without waiting
  // on the rewind HTTP response.
  assert.equal(resets.length, 1, 'snapshot_reset emitted exactly once');
  assert.equal(resets[0].droppedText, 'second prompt',
    'droppedText rides on the snapshot_reset frame');

  await waitFor(() => instances.get(id).status === 'idle');

  // After rewind: ring has events from re-replayed truncated history.
  const postRing = instances.get(id).ringSnapshot();
  const postEchoes = postRing.filter(ev => ev.kind === 'user_echo').map(ev => ev.text);
  assert.deepEqual(postEchoes, ['first prompt'],
    'only the first user_echo survives in the new ring');

  // On-disk jsonl is truncated.
  const persisted = await fs.readFile(path.join(sessionDir, `${sid}.jsonl`), 'utf8');
  const userLines = userPromptLines(persisted);
  assert.equal(userLines.length, 1, 'only one user prompt survives on disk');
  assert.equal(userLines[0].uuid, 'u1');
});

test('rewind to index 0 wipes the session and respawns under the same sessionId', async () => {
  // Empty-prefix case: --resume <sid> against a zero-line jsonl would crash
  // the real CLI, so the orchestrator deletes the file and respawns with
  // --session-id under the same id. The URL anchor stays valid and the
  // instance lands back at idle, ready for a fresh first turn.
  const sid = '00000000-2222-3333-4444-555555555555';
  const { sessionDir } = await seedSession({
    projectName: 'wipeable', sid,
    lines: [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'only prompt' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
        { type: 'text', text: 'only reply' },
      ] } },
    ],
  });

  const events = collectEvents();
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'wipeable', mode: 'bypassPermissions', resume: sid,
  });
  assert.equal(r.status, 201);
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle');

  const resets = [];
  instances.on('snapshot_reset', (snap) => {
    if (snap.id === id) resets.push(snap);
  });
  const rew = await api(baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 0 });
  assert.equal(rew.status, 200);
  assert.equal(rew.body.droppedText, 'only prompt');
  assert.equal(resets.length, 1, 'snapshot_reset emitted exactly once');
  assert.equal(resets[0].droppedText, 'only prompt',
    'droppedText rides on the snapshot_reset frame');

  await waitFor(() => instances.get(id).status === 'idle');

  // Same sessionId — URL anchor preserved.
  assert.equal(instances.get(id).sessionId, sid);

  // No user_echo events in the rebuilt ring.
  const postRing = instances.get(id).ringSnapshot();
  const postEchoes = postRing.filter(ev => ev.kind === 'user_echo');
  assert.equal(postEchoes.length, 0, 'ring has no surviving user_echo');

  // The empty jsonl was deleted (the fresh subprocess hasn't written its
  // own yet — fake-claude only writes when the scenario tells it to).
  const exists = await fs.stat(path.join(sessionDir, `${sid}.jsonl`)).then(() => true, () => false);
  assert.equal(exists, false, 'empty jsonl was deleted');

  // Sanity: events were observed (collectEvents is a smoke check that the
  // bus stayed alive across the wipe + respawn).
  assert.ok(events.length > 0, 'event bus still streaming after wipe');
});

test('rewind during a running turn is refused 409', async () => {
  // The instances scenario has a 2nd turn that pauses mid-stream (no
  // turn_end) until an interrupt arrives — perfect for catching the
  // instance in `turn` status.
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = SCENARIO_INSTANCE;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions',
    });
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle' && instances.get(id).sessionId);

    // First turn ends cleanly, second turn hangs in the scenario.
    await instances.get(id).prompt('first');
    await waitFor(() => instances.get(id).status === 'idle');
    await instances.get(id).prompt('hang');
    await waitFor(() => instances.get(id).status === 'turn');

    const rew = await api(baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 0 });
    assert.equal(rew.status, 409, 'rewind refuses while a turn is running');
  } finally {
    process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

test('rewind on a temp session succeeds', async () => {
  const sid = 'tttttttt-2222-3333-4444-666666666666';
  await seedSession({
    projectName: 'tempd', sid,
    lines: [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first prompt' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
        { type: 'text', text: 'first reply' },
      ] } },
    ],
  });
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'tempd', temp: true, resume: sid,
  });
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle');

  const rew = await api(baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 0 });
  assert.equal(rew.status, 200, 'temp session rewind is allowed');
  assert.equal(rew.body.droppedText, 'first prompt');
});

test('user_echo events carry absolute userIndex; rewind by stamp survives ring trimming', async () => {
  // With a tiny ring cap, the earliest replayed user_echo bubbles are
  // evicted. The surviving echoes still carry their absolute `userIndex`
  // (stamped server-side at emit time), so a rewind anchored on a stamped
  // index truncates the RIGHT jsonl line — a client counting rendered
  // bubbles from 0 would hit the wrong one.
  const prevCap = process.env.ORCH_EVENT_RING_CAP;
  process.env.ORCH_EVENT_RING_CAP = '10';
  try {
    const sid = 'ssssssss-2222-3333-4444-555555555555';
    const lines = [];
    for (let i = 0; i < 12; i++) {
      lines.push({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `prompt ${i}` } });
      lines.push({ type: 'assistant', uuid: `a${i}`, message: { id: `m${i}`, role: 'assistant', content: [
        { type: 'text', text: `reply ${i}` },
      ] } });
    }
    const { sessionDir } = await seedSession({ projectName: 'stamped', sid, lines });

    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'stamped', mode: 'bypassPermissions', resume: sid,
    });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await waitFor(() => instances.get(id).status === 'idle');

    const ring = instances.get(id).ringSnapshot();
    const echoes = ring.filter(ev => ev.kind === 'user_echo');
    assert.ok(echoes.length > 0, 'some echoes retained');
    assert.ok(echoes.length < 12, 'early echoes were evicted by the cap');
    for (const e of echoes) assert.ok(Number.isInteger(e.userIndex), 'echo carries userIndex');
    // Stamps are absolute: the retained echo for "prompt N" has userIndex N.
    for (const e of echoes) {
      const n = Number(/^prompt (\d+)$/.exec(e.text)?.[1]);
      assert.equal(e.userIndex, n, `echo "${e.text}" stamped with absolute ordinal`);
    }
    const target = echoes[echoes.length - 1];
    assert.ok(target.userIndex > 0, 'last retained echo has a non-zero absolute index');

    // Rewind by the STAMPED index → drops exactly that prompt.
    const rew = await api(baseUrl, 'POST', `/api/instances/${id}/rewind`,
      { userMessageIndex: target.userIndex });
    assert.equal(rew.status, 200);
    assert.equal(rew.body.droppedText, target.text, 'rewind hit the stamped jsonl line');

    await waitFor(() => instances.get(id).status === 'idle');
    const persisted = await fs.readFile(path.join(sessionDir, `${sid}.jsonl`), 'utf8');
    assert.equal(userPromptLines(persisted).length, target.userIndex,
      'jsonl truncated exactly before the stamped prompt');

    // Post-rewind replay restarts the ordinals from 0.
    const postEchoes = instances.get(id).ringSnapshot().filter(ev => ev.kind === 'user_echo');
    if (postEchoes.length) {
      const last = postEchoes[postEchoes.length - 1];
      assert.equal(last.userIndex, target.userIndex - 1, 'counter reset by _wipeForResume');
    }
  } finally {
    if (prevCap === undefined) delete process.env.ORCH_EVENT_RING_CAP;
    else process.env.ORCH_EVENT_RING_CAP = prevCap;
  }
});

test('rewind with out-of-range index returns 400', async () => {
  const sid = 'oor-2222-3333-4444-555555555555';
  await seedSession({
    projectName: 'rangey', sid,
    lines: [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'only' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
        { type: 'text', text: 'reply' },
      ] } },
    ],
  });
  const r = await api(baseUrl, 'POST', '/api/instances', {
    project: 'rangey', mode: 'bypassPermissions', resume: sid,
  });
  const id = r.body.id;
  await waitFor(() => instances.get(id).status === 'idle');

  const rew = await api(baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 5 });
  assert.equal(rew.status, 400);
});
