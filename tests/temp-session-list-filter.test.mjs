import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// Bug repro: a live temp session's jsonl on disk used to leak into the
// regular Sessions list (`listSessions` scans the directory unfiltered).
// The sidebar would show the row as a stopped session; clicking it tried
// to resume the sessionId, but the live temp instance was still attached,
// triggering a 409 conflict. The fix filters out live-temp sessionIds in
// the three GET endpoints that build the list.

async function setupWithProject(name = 'tempfilter') {
  const ctx = await bootServer({ scenarioPath: SCENARIO });
  const created = await api(ctx.baseUrl, 'POST', '/api/projects', { name });
  assert.equal(created.status, 201);
  return ctx;
}

test('temp session jsonl is filtered out of GET /api/projects/:name/sessions while live', async () => {
  const { baseUrl, instances, claudeProjectsRoot, close } = await setupWithProject();
  try {
    // Spawn a temp instance.
    const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'tempfilter', temp: true });
    assert.equal(tempRes.status, 201);
    const tempId = tempRes.body.id;
    const tempInst = instances.get(tempId);
    await waitFor(() => tempInst.status === 'idle' && tempInst.sessionId);
    const tempSid = tempInst.sessionId;

    // Spawn a NON-temp instance in the same project so the sessions
    // listing has a non-temp entry to keep around as a control.
    const normalRes = await api(baseUrl, 'POST', '/api/instances', { project: 'tempfilter' });
    assert.equal(normalRes.status, 201);
    const normalInst = instances.get(normalRes.body.id);
    await waitFor(() => normalInst.status === 'idle' && normalInst.sessionId);
    const normalSid = normalInst.sessionId;

    // Materialize both jsonls (CLI normally writes these; the fake CLI
    // doesn't, so we write directly into ~/.claude/projects/<encoded>/).
    const dir = path.join(claudeProjectsRoot, encodeCwd(tempInst.cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${tempSid}.jsonl`),
      '{"type":"user","uuid":"u1","message":{"role":"user","content":"hello temp"}}\n',
    );
    await fs.writeFile(
      path.join(dir, `${normalSid}.jsonl`),
      '{"type":"user","uuid":"u2","message":{"role":"user","content":"hello normal"}}\n',
    );

    const list = await api(baseUrl, 'GET', '/api/projects/tempfilter/sessions');
    assert.equal(list.status, 200);
    const sids = list.body.map(s => s.sessionId);
    assert.ok(!sids.includes(tempSid), `temp sessionId ${tempSid} must NOT be in regular sessions list`);
    assert.ok(sids.includes(normalSid), `normal sessionId ${normalSid} must be in regular sessions list`);

    // The summary endpoint must also exclude the temp jsonl from the count.
    const projList = await api(baseUrl, 'GET', '/api/projects');
    const proj = projList.body.find(p => p.name === 'tempfilter');
    assert.ok(proj, 'project present in /api/projects');
    assert.equal(proj.sessions.count, 1, 'count excludes live-temp jsonl, includes normal one');

    // After the temp instance is killed, its jsonl is deleted by the
    // existing temp cleanup, so it does not reappear in the list.
    const del = await api(baseUrl, 'DELETE', `/api/instances/${tempId}`);
    assert.equal(del.status, 200);
    await waitFor(async () => {
      try { await fs.access(path.join(dir, `${tempSid}.jsonl`)); return false; }
      catch { return true; }
    });

    const list2 = await api(baseUrl, 'GET', '/api/projects/tempfilter/sessions');
    const sids2 = list2.body.map(s => s.sessionId);
    assert.ok(!sids2.includes(tempSid), 'temp sessionId stays out after kill (jsonl deleted)');
    assert.ok(sids2.includes(normalSid), 'normal sessionId still there');
  } finally { await close(); }
});

test('temp session jsonl that survives on disk reappears in the list after the live instance exits', async () => {
  // Defensive: if someone hand-writes a jsonl with the same sessionId as a
  // dead temp instance (unusual, but the filter must not be sticky), the
  // listing should pick it up again the moment the instance is gone.
  const { baseUrl, instances, claudeProjectsRoot, close } = await setupWithProject('tempfilter2');
  try {
    const tempRes = await api(baseUrl, 'POST', '/api/instances', { project: 'tempfilter2', temp: true });
    const tempInst = instances.get(tempRes.body.id);
    await waitFor(() => tempInst.status === 'idle' && tempInst.sessionId);
    const tempSid = tempInst.sessionId;
    const cwd = tempInst.cwd;

    // Filtered while alive.
    let list = await api(baseUrl, 'GET', '/api/projects/tempfilter2/sessions');
    assert.equal(list.body.find(s => s.sessionId === tempSid), undefined);

    // Kill, then re-create a jsonl by hand with the same sid.
    await api(baseUrl, 'DELETE', `/api/instances/${tempRes.body.id}`);
    await waitFor(() => instances.get(tempRes.body.id) === undefined);
    const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${tempSid}.jsonl`),
      '{"type":"user","uuid":"u1","message":{"role":"user","content":"resurrected"}}\n',
    );

    list = await api(baseUrl, 'GET', '/api/projects/tempfilter2/sessions');
    const sids = list.body.map(s => s.sessionId);
    assert.ok(sids.includes(tempSid), 'jsonl appears once no live temp instance owns it');
  } finally { await close(); }
});
