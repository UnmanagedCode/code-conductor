import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.ts';
import { isArchived } from '../src/sessionStore.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// A live normal session's jsonl on disk is kept out of the Sessions list
// (`listSessions` scans the directory unfiltered): listed, the sidebar would
// show it as a stopped session, and clicking it would try to resume a
// sessionId the live instance still holds — a 409. The three GET endpoints
// that build the list filter out live normal sessionIds.

async function setupWithProject(name = 'livefilter') {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const created = await api(ctx.baseUrl, 'POST', '/api/projects', { name });
  assert.equal(created.status, 201);
  return ctx;
}

test('a live normal session\'s jsonl is filtered out of GET /api/projects/:name/sessions', async () => {
  const { baseUrl, instances, claudeProjectsRoot, close } = await setupWithProject();
  try {
    // Spawn a normal instance.
    const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'livefilter' });
    assert.equal(normalRes.status, 201);
    const normalId = normalRes.body.id;
    const normalInst = instances.get(normalId);
    await waitFor(() => normalInst.status === 'idle' && normalInst.sessionId);
    const normalSid = normalInst.backingSessionId;   // the filename the filter matches
    const normalPublicId = normalInst.sessionId;     // what a listed row would carry

    // Spawn a persistent instance in the same project so the sessions
    // listing has a persistent entry to keep around as a control.
    const persistentRes = await api(baseUrl, 'POST', '/api/instances', { project: 'livefilter', persistent: true });
    assert.equal(persistentRes.status, 201);
    const persistentInst = instances.get(persistentRes.body.id);
    await waitFor(() => persistentInst.status === 'idle' && persistentInst.sessionId);
    const persistentSid = persistentInst.backingSessionId;   // the filename
    const persistentPublicId = persistentInst.sessionId;      // what a listed row carries

    // Materialize both jsonls (CLI normally writes these; the fake CLI
    // doesn't, so we write directly into ~/.claude/projects/<encoded>/).
    const dir = path.join(claudeProjectsRoot, encodeCwd(normalInst.cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${normalSid}.jsonl`),
      '{"type":"user","uuid":"u1","message":{"role":"user","content":"hello normal"}}\n',
    );
    await fs.writeFile(
      path.join(dir, `${persistentSid}.jsonl`),
      '{"type":"user","uuid":"u2","message":{"role":"user","content":"hello normal"}}\n',
    );

    const list = await api(baseUrl, 'GET', '/api/projects/livefilter/sessions');
    assert.equal(list.status, 200);
    const sids = list.body.map(s => s.sessionId);
    // The filter matches FILENAMES, the rows report PUBLIC ids — so neither form
    // of the excluded normal session appears, and the control does appear as its
    // public id (its backing id, being a different string, must not).
    assert.ok(!sids.includes(normalSid), `normal filename ${normalSid} must NOT be in the sessions list`);
    assert.ok(!sids.includes(normalPublicId), `normal public id ${normalPublicId} must NOT be in the sessions list`);
    assert.ok(sids.includes(persistentPublicId), `persistent sessionId ${persistentPublicId} must be in the sessions list`);
    assert.ok(!sids.includes(persistentSid), 'a listed row reports the public id, never the backing one');

    // The summary endpoint must also exclude the live normal jsonl from the count.
    const projList = await api(baseUrl, 'GET', '/api/projects');
    const proj = projList.body.find(p => p.name === 'livefilter');
    assert.ok(proj, 'project present in /api/projects');
    assert.equal(proj.sessions.count, 1, 'count excludes the live normal jsonl, includes the persistent one');

    // After the normal instance is killed, it is archived: the .jsonl is kept
    // but the session is excluded from the default list (archived sessions are
    // filtered server-side). It appears only with ?includeArchived=1.
    const del = await api(baseUrl, 'DELETE', `/api/instances/${normalId}`);
    assert.equal(del.status, 200);
    await waitFor(() => !instances.get(normalId));
    // Give the async archive write to the session store a moment to land.
    await waitFor(async () => isArchived(normalSid));

    // .jsonl is kept (archived, not deleted).
    await fs.access(path.join(dir, `${normalSid}.jsonl`));

    // Default list excludes archived sessions.
    const list2 = await api(baseUrl, 'GET', '/api/projects/livefilter/sessions');
    assert.ok(!list2.body.find(s => s.sessionId === normalPublicId), 'archived normal session absent from default list');
    assert.ok(list2.body.find(s => s.sessionId === persistentPublicId), 'persistent sessionId still there');

    // With includeArchived=1 it appears with archived:true.
    const list2incl = await api(baseUrl, 'GET', '/api/projects/livefilter/sessions?includeArchived=1');
    const entry = list2incl.body.find(s => s.sessionId === normalPublicId);
    assert.ok(entry, 'archived normal session appears with includeArchived=1');
    assert.equal(entry.archived, true, 'normal session is archived after kill');
  } finally { await close(); }
});

test('a normal session\'s jsonl that survives on disk reappears in the list after the live instance exits', async () => {
  // Defensive: if someone hand-writes a jsonl with the same sessionId as a
  // dead normal instance (unusual, but the filter must not be sticky), the
  // listing should pick it up again the moment the instance is gone.
  const { baseUrl, instances, claudeProjectsRoot, close } = await setupWithProject('livefilter2');
  try {
    const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'livefilter2' });
    const normalInst = instances.get(normalRes.body.id);
    await waitFor(() => normalInst.status === 'idle' && normalInst.sessionId);
    const normalSid = normalInst.backingSessionId;   // the filename
    const normalPublicId = normalInst.sessionId;     // what a listed row would carry
    const cwd = normalInst.cwd;

    // Filtered while alive.
    let list = await api(baseUrl, 'GET', '/api/projects/livefilter2/sessions');
    assert.equal(list.body.find(s => s.sessionId === normalPublicId), undefined);

    // Kill, then re-create a jsonl by hand with the same sid.
    // Killing a normal instance archives the session, so it is excluded from
    // the default list but visible via ?includeArchived=1.
    await api(baseUrl, 'DELETE', `/api/instances/${normalRes.body.id}`);
    await waitFor(() => instances.get(normalRes.body.id) === undefined);
    await waitFor(async () => isArchived(normalSid));
    const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${normalSid}.jsonl`),
      '{"type":"user","uuid":"u1","message":{"role":"user","content":"resurrected"}}\n',
    );

    // Default list excludes it (it is archived).
    list = await api(baseUrl, 'GET', '/api/projects/livefilter2/sessions');
    assert.equal(list.body.find(s => s.sessionId === normalPublicId), undefined, 'archived session absent from default list');
    // But it is reachable via includeArchived=1.
    const listIncl = await api(baseUrl, 'GET', '/api/projects/livefilter2/sessions?includeArchived=1');
    const sids = listIncl.body.map(s => s.sessionId);
    assert.ok(sids.includes(normalPublicId), 'jsonl accessible via includeArchived=1 once no live normal instance owns it');
  } finally { await close(); }
});
