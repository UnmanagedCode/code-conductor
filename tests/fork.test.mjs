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
import { bootServer, api, waitFor, settledSessionBackend } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';
import { addBackend, addCustomModel, resolveContextWindowTokens } from '../src/appSettings.ts';
import { isTemp, markTemp } from '../src/tempSessions.ts';
import { isArchived } from '../src/archivedSessions.ts';

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

test('a fork mints its OWN public id and never joins its ancestor\'s lineage', async () => {
  // Fork is mechanically near-identical to prune — both copy a jsonl to a
  // server-minted UUID — but it NEVER kills the source, so it leaves TWO live
  // sessions from one ancestor. That violates "one public id ↔ at most one live
  // session", which is why a fork must never enter its ancestor's lineage. If
  // provenance is ever wanted it is a separate ancestry pointer, not a segment.
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'fffffff9-2222-3333-4444-555555555555';
    await seedSession({
      ctx, projectName: 'forklineage', sid,
      lines: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'r1' }] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
        { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'r2' }] } },
      ],
    });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'forklineage', mode: 'bypassPermissions', resume: sid,
    });
    const parent = ctx.instances.get(r.body.id);
    await waitFor(() => parent.status === 'idle');
    // Resumed from a seeded jsonl with no lineage row, so its public id is the
    // full UUID it already had (the store's base case).
    assert.equal(parent.sessionId, sid);

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${parent.id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201);
    const child = ctx.instances.get(fk.body.instance.id);
    await waitFor(() => child.status === 'idle');

    // BOTH are live at once — the property that makes lineage membership illegal.
    assert.ok(parent.proc, 'the ancestor is still running');
    assert.ok(child.proc, 'and so is the fork');

    // The fork has its own identity, and neither resolves to the other.
    assert.notEqual(child.sessionId, parent.sessionId);
    assert.equal(child.sessionId, fk.body.newSessionId,
      'the fork\'s public id is its own fresh id (base case: no row, so id == filename)');
    const { segmentsFor, publicIdFor, resolveBacking } = await import('../src/sessionLineage.ts');
    assert.deepEqual(await segmentsFor(parent.sessionId), [],
      'the ancestor gained no segment — a fork is not a rotation');
    assert.deepEqual(await segmentsFor(child.sessionId), []);
    assert.equal(await publicIdFor(child.backingSessionId), child.sessionId,
      'the fork does not resolve to its ancestor');
    assert.equal(await resolveBacking(parent.sessionId), parent.sessionId,
      'and the ancestor still resolves to its own transcript, not the fork\'s');

    // Addressing either id reaches exactly one instance.
    assert.deepEqual(ctx.instances.idsForSession(parent.sessionId), [parent.id]);
    assert.deepEqual(ctx.instances.idsForSession(child.sessionId), [child.id]);
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

// ── temp sessions ────────────────────────────────────────────────────────
// A fork of a temp session is itself temp, and the source is left alone. The
// two footprints are disjoint by construction: the fork READS the source jsonl
// and writes only the new id's jsonl + metadata, while a temp source's on-exit
// archive touches only the sub-agent dir and the marker stores, both keyed on
// the SOURCE id — and no temp jsonl is ever deleted.

// The temp marker lands via a fire-and-forget `markTemp()` in spawn(), so a
// NEGATIVE assertion ("this id is not temp") has to be ordered after any write
// the store already has queued. Every mutation runs on one per-process write
// chain, so awaiting a mutation enqueued now resolves only once the ones ahead
// of it have written. A positive assertion can just waitFor the marker.
const FLUSH_SENTINEL = 'f1u5hf1u-5hf1-u5hf-1u5h-f1u5hf1u5hf1';
async function flushTempStore() { await markTemp(FLUSH_SENTINEL); }

// Two user prompts so a fork at index 1 copies a non-trivial prefix.
const TEMP_SEED_LINES = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
    { type: 'text', text: 'first reply' },
  ] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
  { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [
    { type: 'text', text: 'second reply' },
  ] } },
];
// The transcript half of what forkSessionAtUserMessage writes for
// `userMessageIndex: 1` over the seed above: the first two lines verbatim
// (neither carries a `sessionId` field to rewrite). The resume-picker metadata
// appended after them is asserted separately — its shape belongs to
// writeSessionMetadata, not to what a fork copies.
const TEMP_SEED_PREFIX = TEMP_SEED_LINES.slice(0, 2).map(l => JSON.stringify(l));
const SESSION_METADATA_TYPES = new Set(['last-prompt', 'permission-mode']);

test('fork on a temp session succeeds, and the fork is itself temp', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'fffffff9-2222-3333-4444-555555555555';
    const { file } = await seedSession({
      ctx, projectName: 'tempfork', sid, lines: TEMP_SEED_LINES,
    });
    const originalBytes = await fs.readFile(file);

    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'tempfork', temp: true, resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201, 'a temp session is forkable');
    assert.ok(fk.body.newSessionId && fk.body.newSessionId !== sid);
    assert.equal(fk.body.instance.temp, true, 'the fork summary reports temp');

    // …and durably, not just on the summary: spawn() persists the marker.
    await waitFor(() => isTemp(fk.body.newSessionId));

    // The source is untouched — still temp, not archived, byte-identical.
    assert.equal(await isTemp(sid), true, 'source stays temp');
    assert.equal(await isArchived(sid), false, 'source is not archived by the fork');
    assert.equal((await fs.readFile(file)).toString(), originalBytes.toString(),
      'source jsonl is byte-identical');
  } finally { await ctx.close(); }
});

test('a fork of a non-temp session is not temp', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'fffffffa-2222-3333-4444-555555555555';
    await seedSession({ ctx, projectName: 'persistfork', sid, lines: TEMP_SEED_LINES });

    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'persistfork', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201);
    assert.equal(fk.body.instance.temp, false, 'temp-ness is inherited, not asserted');

    await flushTempStore();
    assert.equal(await isTemp(fk.body.newSessionId), false,
      'no temp marker is written for a fork of a persistent session');
  } finally { await ctx.close(); }
});

test('the fork of a temp session is archived on its own exit, like any other temp session', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'fffffffb-2222-3333-4444-555555555555';
    const { sessionDir } = await seedSession({
      ctx, projectName: 'tempforklife', sid, lines: TEMP_SEED_LINES,
    });

    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'tempforklife', temp: true, resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201);
    const newSid = fk.body.newSessionId;
    const newId = fk.body.instance.id;
    await waitFor(() => ctx.instances.get(newId) && ctx.instances.get(newId).status === 'idle');

    const del = await api(ctx.baseUrl, 'DELETE', `/api/instances/${newId}`);
    assert.equal(del.status, 200);

    // The child runs the whole temp lifecycle, not just the flag: unmarked
    // temp, marked archived, jsonl retained (archived sessions stay resumable),
    // and dropped from byId so no ghost row survives.
    await waitFor(() => isArchived(newSid));
    assert.equal(await isTemp(newSid), false, 'the fork is unmarked temp on exit');
    await fs.access(path.join(sessionDir, `${newSid}.jsonl`));
    assert.equal(ctx.instances.get(newId), undefined, 'the fork is evicted from byId');
  } finally { await ctx.close(); }
});

test('a temp source killed mid-fork does not corrupt the copy, and archives only itself', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'fffffffc-2222-3333-4444-555555555555';
    const { sessionDir, file } = await seedSession({
      ctx, projectName: 'tempforkrace', sid, lines: TEMP_SEED_LINES,
    });
    const originalBytes = await fs.readFile(file);

    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'tempforkrace', temp: true, resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    // Hold the instance: a temp session is evicted from byId the moment its
    // subprocess exits, which is exactly what this test provokes.
    const inst = ctx.instances.get(id);
    // Overlap the two on purpose — no await between them, so the source's
    // on-exit archive lands somewhere inside the fork's read/write window.
    const forking = inst.forkAtUserMessage(1);
    const killing = inst.kill({ graceMs: 0 });
    const [forked] = await Promise.all([forking, killing]);

    // Every assertion below holds under EVERY interleaving — none of them says
    // which operation landed first. That is the claim being pinned.
    const newFile = path.join(sessionDir, `${forked.newSessionId}.jsonl`);
    const copied = (await fs.readFile(newFile, 'utf8')).split('\n').filter(l => l.trim());
    assert.deepEqual(copied.slice(0, TEMP_SEED_PREFIX.length), TEMP_SEED_PREFIX,
      'the copy is the exact prefix, whatever the source subprocess was doing');
    // Nothing of the source's dying turn is folded in behind it — the only
    // lines past the prefix are the resume-picker anchor fork writes itself.
    assert.deepEqual(
      copied.slice(TEMP_SEED_PREFIX.length).map(l => JSON.parse(l).type).sort(),
      [...SESSION_METADATA_TYPES].sort(),
      'the copy carries nothing past the prefix but its own picker metadata');
    assert.equal((await fs.readFile(file)).toString(), originalBytes.toString(),
      'the source jsonl is byte-identical — the archive never deletes it');

    // Only the SOURCE moves: the archive's writes are keyed on the source id.
    await waitFor(() => isArchived(sid));
    assert.equal(await isTemp(sid), false, 'the source is unmarked temp by its own exit');
    assert.equal(await isArchived(forked.newSessionId), false,
      'the copy is not archived by the source\'s exit');
  } finally { await ctx.close(); }
});

// ── the `_mutating` interlock, now owned by Instance.forkAtUserMessage ────
// Fork reads a jsonl a concurrent rewind/prune may be rewriting, so it claims
// the same flag those two do. These three pin the guard sequence surviving on
// the instance rather than the route: refuse while the flag is held, release it
// on the way out, and refuse a session that has no jsonl to read yet.

test('fork refuses 409 while another rewrite holds the _mutating flag', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'fffffff8-2222-3333-4444-555555555555';
    await seedSession({
      ctx, projectName: 'forkbusy', sid,
      lines: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
          { type: 'text', text: 'first reply' },
        ] } },
      ],
    });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'forkbusy', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle' && ctx.instances.get(id).backingSessionId);

    // Stand in for a rewind/prune mid-flight on the same instance.
    ctx.instances.get(id)._mutating = true;
    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 0 });
    assert.equal(fk.status, 409);
    assert.match(fk.body.error, /another rewind\/fork\/prune is in progress/);
  } finally { await ctx.close(); }
});

test('a successful fork releases the _mutating flag', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    const sid = 'fffffff9-2222-3333-4444-555555555555';
    await seedSession({
      ctx, projectName: 'forkrelease', sid,
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
      project: 'forkrelease', mode: 'bypassPermissions', resume: sid,
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(fk.status, 201);
    assert.equal(ctx.instances.get(id)._mutating, false,
      'the finally released the flag, so a second fork is not locked out');

    // Proof the release is real and not just observably-false: fork again.
    const again = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 1 });
    assert.equal(again.status, 201);
  } finally { await ctx.close(); }
});

test('fork on an instance that never took a turn is refused 400', async () => {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(ctx.baseUrl, 'POST', '/api/projects', { name: 'forkvirgin' });
    const r = await api(ctx.baseUrl, 'POST', '/api/instances', {
      project: 'forkvirgin', mode: 'bypassPermissions',
    });
    const id = r.body.id;
    await waitFor(() => ctx.instances.get(id).status === 'idle');
    // launch() mints a backing id eagerly, so the "no jsonl to read yet" state
    // has to be staged directly — it is what an instance looks like before its
    // first turn has produced a transcript.
    ctx.instances.get(id).backingSessionId = null;

    const fk = await api(ctx.baseUrl, 'POST', `/api/instances/${id}/fork`, { userMessageIndex: 0 });
    assert.equal(fk.status, 400);
    assert.match(fk.body.error, /has not yet received a turn/);
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
    assert.deepEqual(await settledSessionBackend(newSid), {
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
