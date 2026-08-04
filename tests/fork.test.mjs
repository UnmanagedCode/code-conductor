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
import { WebSocket } from 'ws';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';
import { addBackend, addCustomModel, resolveContextWindowTokens } from '../src/appSettings.js';
import { getSessionBackend } from '../src/sessionBackends.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-resume.json');

// Minimal WS client (mirrors tests/ws.test.mjs) so we can assert what the
// subscribe `snapshot` frame carries.
function wsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on('message', (raw) => {
      try { messages.push(JSON.parse(raw.toString())); }
      catch { messages.push(raw.toString()); }
    });
    ws.once('open', () => resolve({
      ws,
      messages,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() { return new Promise(r => { ws.once('close', r); ws.close(); }); },
      wait(predicate, timeout = 4000) {
        return waitFor(() => messages.find(predicate), { timeout });
      },
    }));
    ws.once('error', reject);
  });
}

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

test('fork prefill rides the new instance\'s first snapshot frame, consumed once', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'fffffff2-2222-3333-4444-555555555555';
    await seedSession({
      ctx, projectName: 'forkprefill', sid,
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

    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'forkprefill', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201);
    const newId = fk.body.instance.id;
    // Server stored the prefill on the new instance for its first snapshot.
    assert.equal(ctx.instances.get(newId).pendingPrefill, 'second',
      'dropped prompt stashed on the new instance server-side');

    // First subscribe: the snapshot carries droppedText inline (no HTTP-body
    // handshake needed) — this is the fork composer prefill.
    const c1 = await wsClient(ctx.wsUrl);
    c1.send({ t: 'subscribe', id: newId });
    const snap1 = await c1.wait(m => m.t === 'snapshot' && m.id === newId);
    assert.equal(snap1.droppedText, 'second',
      'fork prefill rides the new instance\'s first snapshot frame');
    await c1.close();

    // Consumed once: a fresh subscribe must NOT re-deliver droppedText, so a
    // page reload / reconnect after the first snapshot never clobbers edits.
    assert.equal(ctx.instances.get(newId).pendingPrefill, null,
      'prefill cleared after the first snapshot');
    const c2 = await wsClient(ctx.wsUrl);
    c2.send({ t: 'subscribe', id: newId });
    const snap2 = await c2.wait(m => m.t === 'snapshot' && m.id === newId);
    assert.equal('droppedText' in snap2, false,
      'second snapshot omits droppedText (consumed once)');
    await c2.close();
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


// ── the fork must carry the BACKEND ──────────────────────────────────────
// forkSessionAtUserMessage copies the jsonl but writes no backend sidecar for
// the new sessionId, so create()'s sidecar recovery finds nothing. If the fork
// route omits `backend`, the new instance silently falls back to the identity
// `claude` backend while keeping the substitution backend's foreign model id —
// and because that model is non-null, the BACKEND_MODEL_MISSING guard never
// fires, so it launches a real `claude --model <foreign-id>` against the
// Anthropic account. Deliberately a USER-DEFINED backend with a `[1m]`-tagged
// model, so a tag-stripping or `=== 'ollama'` regression also fails here.
test('fork carries backend + exact model + capacity to the new instance', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await addBackend({
      id: 'codex', label: 'Codex',
      template: 'codexctl run claude --model {model} --', env: [],
    });
    await addCustomModel({ label: 'Sol', model: 'gpt-5.6-sol[1m]', backend: 'codex', contextWindow: 1_000_000 });

    const sid = 'fffffff5-2222-3333-4444-555555555555';
    await seedSession({
      ctx, projectName: 'forkbackend', sid,
      lines: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'r1' }] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
      ],
    });

    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'forkbackend', mode: 'bypassPermissions', resume: sid,
      backend: 'codex', model: 'gpt-5.6-sol[1m]',
    });
    assert.equal(r.status, 201);
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    assert.equal(r.body.backend, 'codex');
    assert.equal(r.body.contextWindowTokens, 1_000_000);

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201);

    const forked = fk.body.instance;
    assert.equal(forked.backend, 'codex', 'the fork must not fall back to the real claude backend');
    assert.equal(forked.model, 'gpt-5.6-sol[1m]', 'the registry key survives the fork byte-exact');
    assert.equal(forked.contextWindowTokens, 1_000_000);

    // …and it actually launched through the backend's template, not bare claude.
    const newInst = ctx.instances.get(forked.id);
    await waitFor(() => newInst.status === 'idle');
    assert.equal(newInst._spawnArgv[0], 'codexctl',
      'the forked subprocess must launch from the backend template');
    assert.ok(newInst._spawnArgv.includes('gpt-5.6-sol[1m]'));
  } finally { await ctx.close(); }
});

test('the forked sessionId is recorded in the backend sidecar, so a later cold resume finds it', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await addBackend({
      id: 'codex2', label: 'Codex 2',
      template: 'codexctl run claude --model {model} --', env: [],
    });
    await addCustomModel({ label: 'Sol2', model: 'gpt-5.6-sol[1m]', backend: 'codex2', contextWindow: 1_000_000 });

    const sid = 'fffffff6-2222-3333-4444-555555555555';
    await seedSession({
      ctx, projectName: 'forksidecar', sid,
      lines: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'r1' }] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
      ],
    });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'forksidecar', mode: 'bypassPermissions', resume: sid,
      backend: 'codex2', model: 'gpt-5.6-sol[1m]',
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201);
    const newSid = fk.body.newSessionId;
    await waitFor(() => ctx.instances.get(fk.body.instance.id)?.status === 'idle');

    // Written by spawn(), which is what makes the fork resumable on its own
    // later — without it the fork resolves to `claude` on the next cold resume.
    await waitFor(async () => !!(await getSessionBackend(newSid)));
    assert.deepEqual(await getSessionBackend(newSid), {
      backend: 'codex2', model: 'gpt-5.6-sol[1m]', contextWindowTokens: 1_000_000,
    });
  } finally { await ctx.close(); }
});


// ── the live registry WINS over a carried capacity ───────────────────────
// `create()` documents `resolveContextWindowTokens(...) ?? carried` — live first,
// carried only as a fallback. Every other test has carried == live, or live ==
// null, so the two sources never disagree and the precedence passes with the
// operands swapped. This is the only test where they differ AND live resolves.
test('a fork prefers the live registry window over the carried one when they disagree', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await addBackend({
      id: 'codex3', label: 'Codex 3',
      template: 'codexctl run claude --model {model} --', env: [],
    });
    // The row's CURRENT window. The source instance will carry a different one.
    await addCustomModel({ label: 'Sol3', model: 'gpt-5.6-sol[1m]', backend: 'codex3', contextWindow: 400_000 });
    assert.equal(resolveContextWindowTokens({ backend: 'codex3', model: 'gpt-5.6-sol[1m]' }), 400_000);

    const sid = 'fffffff7-2222-3333-4444-555555555555';
    await seedSession({
      ctx, projectName: 'forkprec', sid,
      lines: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'r1' }] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
      ],
    });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'forkprec', mode: 'bypassPermissions', resume: sid,
      backend: 'codex3', model: 'gpt-5.6-sol[1m]',
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    // Force a DISAGREEMENT: the source instance carries a stale 999_999 (the shape
    // a session gets when it was created while the row declared something else),
    // while the registry now says 400_000.
    const src = ctx.instances.get(id);
    src.contextWindowTokens = 999_999;

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201);

    // The fork must adopt the registry's CURRENT number, not the value it was
    // handed. A user who corrects a model's window in Settings expects the next
    // spawn to use the correction; carrying-wins would pin the stale one forever.
    assert.equal(fk.body.instance.contextWindowTokens, 400_000,
      'live registry resolution wins over the carried fallback when both resolve');
    assert.notEqual(fk.body.instance.contextWindowTokens, 999_999);
  } finally { await ctx.close(); }
});
