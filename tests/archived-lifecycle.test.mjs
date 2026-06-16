import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor } from './helpers.mjs';
import { encodeCwd } from '../src/projects.js';
import { isArchived } from '../src/archivedSessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// Materialise a fake .jsonl for an instance (fake-claude doesn't write to
// ~/.claude/projects, so we do it ourselves to exercise the archive paths).
async function materializeJsonl(claudeProjectsRoot, cwd, sid, content = '{"type":"user","uuid":"u1"}\n') {
  const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  await fs.writeFile(file, content);
  return file;
}

test('archive endpoint keeps .jsonl, marks archived, and the session leaves the normal list', async () => {
  const { baseUrl, instances, claudeProjectsRoot, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'arclife' });
    // A non-temp session — the new "remove" must archive any session.
    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'arclife', temp: false });
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;
    const cwd = inst.cwd;
    const jsonlFile = await materializeJsonl(claudeProjectsRoot, cwd, sid);

    // Archive via the endpoint (force=1 to stop the still-live instance).
    let r = await api(baseUrl, 'POST', `/api/projects/arclife/sessions/${sid}/archive`);
    if (r.status === 409) r = await api(baseUrl, 'POST', `/api/projects/arclife/sessions/${sid}/archive?force=1`);
    assert.equal(r.status, 200);

    // .jsonl kept; archived flag set.
    await fs.access(jsonlFile);
    await waitFor(async () => (await isArchived(sid)));
    assert.equal(await isArchived(sid), true);

    // Excluded from the default session list; visible via includeArchived=1.
    const listRes = await api(baseUrl, 'GET', '/api/projects/arclife/sessions');
    assert.ok(!listRes.body.find(s => s.sessionId === sid), 'archived session absent from default list');
    const inclRes = await api(baseUrl, 'GET', '/api/projects/arclife/sessions?includeArchived=1');
    const found = inclRes.body.find(s => s.sessionId === sid);
    assert.ok(found && found.archived === true, 'session flagged archived with includeArchived=1');

    // GET /api/archived groups it under its project.
    const arch = await api(baseUrl, 'GET', '/api/archived');
    assert.equal(arch.status, 200);
    const group = arch.body.groups.find(g => g.project === 'arclife');
    assert.ok(group, 'project group present in /api/archived');
    const gs = group.sessions.find(s => s.sessionId === sid);
    assert.ok(gs, 'archived session present in its project group');
    assert.equal(gs.worktreeName, null);
  } finally { await close(); }
});

test('restore drops the session from /api/archived and clears the archived flag', async () => {
  const { baseUrl, instances, claudeProjectsRoot, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'arclife2' });
    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'arclife2', temp: false });
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;
    await materializeJsonl(claudeProjectsRoot, inst.cwd, sid);

    let r = await api(baseUrl, 'POST', `/api/projects/arclife2/sessions/${sid}/archive`);
    if (r.status === 409) r = await api(baseUrl, 'POST', `/api/projects/arclife2/sessions/${sid}/archive?force=1`);
    assert.equal(r.status, 200);
    await waitFor(async () => (await isArchived(sid)));

    const restore = await api(baseUrl, 'POST', `/api/projects/arclife2/sessions/${sid}/restore`);
    assert.equal(restore.status, 200);
    assert.equal(await isArchived(sid), false);

    const arch = await api(baseUrl, 'GET', '/api/archived');
    const group = arch.body.groups.find(g => g.project === 'arclife2');
    assert.ok(!group, 'project no longer present in /api/archived once its only session is restored');
  } finally { await close(); }
});

test('permanent delete from the archive removes the .jsonl AND unmarks archived (no dangling entry)', async () => {
  const { baseUrl, instances, claudeProjectsRoot, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'arclife3' });
    const res = await api(baseUrl, 'POST', '/api/instances', { project: 'arclife3', temp: false });
    const inst = instances.get(res.body.id);
    await waitFor(() => inst.status === 'idle' && inst.sessionId);
    const sid = inst.sessionId;
    const jsonlFile = await materializeJsonl(claudeProjectsRoot, inst.cwd, sid);

    let r = await api(baseUrl, 'POST', `/api/projects/arclife3/sessions/${sid}/archive`);
    if (r.status === 409) r = await api(baseUrl, 'POST', `/api/projects/arclife3/sessions/${sid}/archive?force=1`);
    assert.equal(r.status, 200);
    await waitFor(async () => (await isArchived(sid)));

    // The instance is gone now (archive stopped it); plain DELETE deletes.
    let del = await api(baseUrl, 'DELETE', `/api/projects/arclife3/sessions/${sid}`);
    if (del.status === 409) del = await api(baseUrl, 'DELETE', `/api/projects/arclife3/sessions/${sid}?force=1`);
    assert.equal(del.status, 200);

    // .jsonl gone, and the archived set no longer references the sid.
    await assert.rejects(() => fs.access(jsonlFile), 'jsonl permanently removed');
    assert.equal(await isArchived(sid), false, 'archived set must not keep a dangling sid');

    const arch = await api(baseUrl, 'GET', '/api/archived');
    const group = arch.body.groups.find(g => g.project === 'arclife3');
    assert.ok(!group, 'deleted session no longer surfaced in /api/archived');
  } finally { await close(); }
});

test('archive of a non-existent session returns 404', async () => {
  const { baseUrl, close } = await bootServer({ scenarioPath: SCENARIO });
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'arclife4' });
    const ghost = 'dddddddd-eeee-ffff-0000-111111111111';
    const r = await api(baseUrl, 'POST', `/api/projects/arclife4/sessions/${ghost}/archive`);
    assert.equal(r.status, 404);
    assert.equal(await isArchived(ghost), false, 'a missing session must not be marked archived');
  } finally { await close(); }
});
