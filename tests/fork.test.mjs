// End-to-end REST coverage of POST /api/instances/:id/fork. Seeds a session
// jsonl, spawns a --resume instance, calls /fork, and asserts:
//   - the original session jsonl is untouched
//   - a new sessionId is materialised with the prefix
//   - a new instance summary is returned and its ring buffer reflects only
//     the surviving prefix

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
  const file = path.join(sessionDir, `${sid}.jsonl`);
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { projectPath, sessionDir, file };
}

test('fork preserves original session and spawns a new instance against the prefix', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'fffffff1-2222-3333-4444-555555555555';
    const { sessionDir, file } = await seedSession({
      ctx, projectName: 'forkable', sid,
      lines: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
          { type: 'text', text: 'first reply' },
        ] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
        { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [
          { type: 'text', text: 'second reply' },
        ] } },
      ],
    });
    const originalBytes = await fs.readFile(file);

    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'forkable', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201);
    assert.ok(fk.body.newSessionId && fk.body.newSessionId !== sid);
    assert.equal(fk.body.droppedText, 'second');
    assert.ok(fk.body.instance && fk.body.instance.id !== id, 'new instance summary returned');

    // Original session jsonl is byte-identical.
    const after = await fs.readFile(file);
    assert.equal(originalBytes.toString(), after.toString(),
      'original session jsonl is untouched');

    // The fork jsonl exists with the prefix.
    const newFile = path.join(sessionDir, `${fk.body.newSessionId}.jsonl`);
    const newPersisted = await fs.readFile(newFile, 'utf8');
    const userUuids = newPersisted.split('\n').filter(l => l.trim())
      .map(l => JSON.parse(l))
      .filter(o => o.type === 'user' && typeof o.message?.content === 'string')
      .map(o => o.uuid);
    assert.deepEqual(userUuids, ['u1'], 'only the first user prompt survives');

    // The new instance, once it boots, has a ring with one user_echo
    // (matching the prefix).
    const newId = fk.body.instance.id;
    await waitFor(() => ctx.instances.get(newId).status === 'idle');
    const ring = ctx.instances.get(newId).ringSnapshot();
    const echoes = ring.filter(ev => ev.kind === 'user_echo').map(ev => ev.text);
    assert.deepEqual(echoes, ['first']);

    // Original instance is still alive and serving its full history.
    const original = ctx.instances.get(id);
    const originalEchoes = original.ringSnapshot().filter(ev => ev.kind === 'user_echo').map(ev => ev.text);
    assert.deepEqual(originalEchoes, ['first', 'second'],
      'original instance ring buffer is untouched');
  } finally { await ctx.close(); }
});

test('fork on a temp session is refused 400', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'tempfork' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'tempfork', temp: true,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle' && ctx.instances.get(id).sessionId);

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 0 });
    assert.equal(fk.status, 400);
  } finally { await ctx.close(); }
});
