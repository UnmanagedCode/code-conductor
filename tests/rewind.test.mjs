// End-to-end REST coverage of POST /api/instances/:id/rewind. Seeds a
// jsonl on disk (the fake-claude doesn't write one), spawns a --resume
// instance against it, calls the endpoint, and asserts the ring buffer
// + jsonl reflect the rewind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

async function seedSession({ ctx, projectName, sid, lines }) {
  await api(ctx.baseUrl, 'POST', '/api/projects', { name: projectName });
  const projectPath = path.join(ctx.projectsRoot, projectName);
  const sessionDir = path.join(ctx.claudeProjectsRoot, encodeCwd(projectPath));
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, `${sid}.jsonl`),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n',
  );
  return { projectPath, sessionDir };
}

function collectEvents(instances) {
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
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'rrrrrrrr-2222-3333-4444-555555555555';
    const { sessionDir } = await seedSession({
      ctx, projectName: 'rewindable', sid,
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

    const events = collectEvents(ctx.instances);
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'rewindable', mode: 'bypassPermissions', resume: sid,
    });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    // Sanity: pre-rewind ring has 2 user_echoes.
    const preEchoes = events.filter(e => e.id === id && e.ev.kind === 'user_echo').length;
    assert.equal(preEchoes, 2, 'two user_echoes replayed from history');

    // Rewind at index 1 → drop the 2nd user prompt + everything after.
    let snapshotResetSeen = 0;
    ctx.instances.on('snapshot_reset', (snap) => {
      if (snap.id === id) snapshotResetSeen++;
    });
    const rew = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 1 });
    assert.equal(rew.status, 200);
    assert.equal(rew.body.droppedText, 'second prompt');

    // snapshot_reset fired once for this instance.
    assert.equal(snapshotResetSeen, 1, 'snapshot_reset emitted exactly once');

    await waitFor(() => ctx.instances.get(id).status === 'idle');

    // After rewind: ring has events from re-replayed truncated history.
    const postRing = ctx.instances.get(id).ringSnapshot();
    const postEchoes = postRing.filter(ev => ev.kind === 'user_echo').map(ev => ev.text);
    assert.deepEqual(postEchoes, ['first prompt'],
      'only the first user_echo survives in the new ring');

    // On-disk jsonl is truncated.
    const persisted = await fs.readFile(path.join(sessionDir, `${sid}.jsonl`), 'utf8');
    const userLines = userPromptLines(persisted);
    assert.equal(userLines.length, 1, 'only one user prompt survives on disk');
    assert.equal(userLines[0].uuid, 'u1');
  } finally { await ctx.close(); }
});

test('rewind during a running turn is refused 409', async () => {
  // The instances scenario has a 2nd turn that pauses mid-stream (no
  // turn_end) until an interrupt arrives — perfect for catching the
  // instance in `turn` status.
  const ctx = await bootServer({ scenarioPath: path.join(__dirname, 'fixtures', 'scenario-instance.json') });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'demo' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'demo', mode: 'bypassPermissions',
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle' && ctx.instances.get(id).sessionId);

    // First turn ends cleanly, second turn hangs in the scenario.
    await ctx.instances.get(id).prompt('first');
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    await ctx.instances.get(id).prompt('hang');
    await waitFor(() => ctx.instances.get(id).status === 'turn');

    const rew = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 0 });
    assert.equal(rew.status, 409, 'rewind refuses while a turn is running');
  } finally { await ctx.close(); }
});

test('rewind on a temp session is refused 400', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'tempd' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'tempd', temp: true,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle' && ctx.instances.get(id).sessionId);

    const rew = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 0 });
    assert.equal(rew.status, 400, 'temp session rewinds are refused');
  } finally { await ctx.close(); }
});

test('rewind with out-of-range index returns 400', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'oor-2222-3333-4444-555555555555';
    await seedSession({
      ctx, projectName: 'rangey', sid,
      lines: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'only' } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
          { type: 'text', text: 'reply' },
        ] } },
      ],
    });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'rangey', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const rew = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/rewind`, { userMessageIndex: 5 });
    assert.equal(rew.status, 400);
  } finally { await ctx.close(); }
});
