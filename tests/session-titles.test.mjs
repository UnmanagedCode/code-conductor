import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  setTitle, getTitle, deleteTitle, loadAll, MAX_TITLE_LEN,
} from '../src/sessionTitles.js';
import { orchStoreRoot, encodeCwd } from '../src/projects.js';
import { isArchived } from '../src/archivedSessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');

// One server shared across the file; each test gets a fresh PROJECTS_ROOT
// (so the session-titles / archived-sessions sidecars start empty — the
// "deleting last entry removes the sidecar" test depends on that) and the
// spawned instances are cleared between tests. The jsonl-planting tests use
// the per-test `projectsRoot` / `claudeProjectsRoot` vars set in beforeEach,
// NOT the boot-time roots. See helpers → freshProjectsRoot.
let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;
before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot, claudeProjectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

test('sessionTitles: set / get / delete round-trip persists to disk', async () => {
  {
    assert.equal(await getTitle('sid-A'), null);
    await setTitle('sid-A', 'hello world');
    assert.equal(await getTitle('sid-A'), 'hello world');

    // Verify disk shape
    const file = path.join(orchStoreRoot(), 'session-titles.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.titles['sid-A'], 'hello world');

    await deleteTitle('sid-A');
    assert.equal(await getTitle('sid-A'), null);
  }
});

test('sessionTitles: empty / whitespace title clears the entry', async () => {
  {
    await setTitle('sid-A', 'set me');
    assert.equal(await getTitle('sid-A'), 'set me');
    await setTitle('sid-A', '   ');
    assert.equal(await getTitle('sid-A'), null);
  }
});

test('sessionTitles: title is trimmed and length-capped', async () => {
  {
    await setTitle('sid-A', '  trim me  ');
    assert.equal(await getTitle('sid-A'), 'trim me');

    const long = 'x'.repeat(500);
    await setTitle('sid-B', long);
    const got = await getTitle('sid-B');
    assert.equal(got.length, MAX_TITLE_LEN);
    assert.equal(got, 'x'.repeat(MAX_TITLE_LEN));
  }
});

test('sessionTitles: concurrent writes do not lose entries', async () => {
  {
    await Promise.all([
      setTitle('sid-1', 'one'),
      setTitle('sid-2', 'two'),
      setTitle('sid-3', 'three'),
      setTitle('sid-4', 'four'),
      setTitle('sid-5', 'five'),
    ]);
    const all = await loadAll();
    assert.equal(all.get('sid-1'), 'one');
    assert.equal(all.get('sid-2'), 'two');
    assert.equal(all.get('sid-3'), 'three');
    assert.equal(all.get('sid-4'), 'four');
    assert.equal(all.get('sid-5'), 'five');
  }
});

test('sessionTitles: deleting last entry removes the sidecar file', async () => {
  {
    await setTitle('sid-A', 'only one');
    await deleteTitle('sid-A');
    const file = path.join(orchStoreRoot(), 'session-titles.json');
    let exists = true;
    try { await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
    assert.equal(exists, false, 'sidecar should be unlinked when empty');
  }
});

test('PUT /api/sessions/:sid/title sets and clears the title', async () => {
  {
    const set = await api(baseUrl, 'PUT', '/api/sessions/abc-123/title', { title: 'my label' });
    assert.equal(set.status, 200);
    assert.equal(set.body.ok, true);
    assert.equal(set.body.title, 'my label');
    assert.equal(set.body.maxLength, MAX_TITLE_LEN);
    assert.equal(await getTitle('abc-123'), 'my label');

    const cleared = await api(baseUrl, 'PUT', '/api/sessions/abc-123/title', { title: '' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.title, null);
    assert.equal(await getTitle('abc-123'), null);
  }
});

test('PUT /api/sessions/:sid/title rejects bad input', async () => {
  {
    const bad = await api(baseUrl, 'PUT', '/api/sessions/abc-123/title', { title: 42 });
    assert.equal(bad.status, 400);
    const badSid = await api(baseUrl, 'PUT', '/api/sessions/has space/title', { title: 'x' });
    assert.equal(badSid.status, 400);
  }
});

test('GET /api/projects/:name/sessions includes title alongside firstPrompt', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'titled' });

    // Plant a stub jsonl directly so we can assert listing behavior without
    // spawning a real instance — listSessionsForCwd reads the conventional
    // ~/.claude/projects/<encoded-cwd>/<sid>.jsonl path.
    const encoded = (path.join(projectsRoot, 'titled')).replace(/[^A-Za-z0-9-]/g, '-');
    const dir = path.join(claudeProjectsRoot, encoded);
    await fs.mkdir(dir, { recursive: true });
    const sid = 'sid-listed-1';
    const file = path.join(dir, `${sid}.jsonl`);
    await fs.writeFile(file, JSON.stringify({
      type: 'user', message: { role: 'user', content: 'opening prompt' },
    }) + '\n');

    await api(baseUrl, 'PUT', `/api/sessions/${sid}/title`, { title: 'My titled session' });

    const list = await api(baseUrl, 'GET', '/api/projects/titled/sessions');
    assert.equal(list.status, 200);
    const row = list.body.find(s => s.sessionId === sid);
    assert.ok(row, 'session row should exist in listing');
    assert.equal(row.title, 'My titled session');
    assert.equal(row.firstPrompt, 'opening prompt');
  }
});

test('deleting a session via DELETE /api/projects/:name/sessions/:sid also drops the title', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'titled-del' });
    const encoded = (path.join(projectsRoot, 'titled-del')).replace(/[^A-Za-z0-9-]/g, '-');
    const dir = path.join(claudeProjectsRoot, encoded);
    await fs.mkdir(dir, { recursive: true });
    const sid = 'sid-to-delete';
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), JSON.stringify({
      type: 'user', message: { role: 'user', content: 'goodbye' },
    }) + '\n');

    await api(baseUrl, 'PUT', `/api/sessions/${sid}/title`, { title: 'will be deleted' });
    assert.equal(await getTitle(sid), 'will be deleted');

    const del = await api(baseUrl, 'DELETE', `/api/projects/titled-del/sessions/${sid}`);
    assert.equal(del.status, 200);
    assert.equal(await getTitle(sid), null);
  }
});

test('rename pushes updated title onto a live instance summary', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'live-rename' });
    const r = await api(baseUrl, 'POST', '/api/instances', { project: 'live-rename' });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle' && !!inst.sessionId);

    assert.equal(inst.summary().title, null);
    const put = await api(baseUrl, 'PUT', `/api/sessions/${inst.sessionId}/title`, { title: 'live label' });
    assert.equal(put.status, 200);

    // setTitle on the instance is synchronous from the route handler, so the
    // summary should already carry the new value by the time the PUT returns.
    assert.equal(inst.summary().title, 'live label');

    // And the /api/instances list reflects it too.
    const list = await api(baseUrl, 'GET', '/api/instances');
    assert.equal(list.body.find(i => i.id === id).title, 'live label');
  }
});

test('temp session exit preserves its custom title in the sidecar', async () => {
  {
    await api(baseUrl, 'POST', '/api/projects', { name: 'temp-titled' });
    const r = await api(baseUrl, 'POST', '/api/instances', {
      project: 'temp-titled', temp: true, mode: 'bypassPermissions',
    });
    const id = r.body.id;
    const inst = instances.get(id);
    await waitFor(() => inst.status === 'idle' && !!inst.sessionId);
    const sid = inst.sessionId;

    await api(baseUrl, 'PUT', `/api/sessions/${sid}/title`, { title: 'ephemeral' });
    assert.equal(await getTitle(sid), 'ephemeral');

    await api(baseUrl, 'DELETE', `/api/instances/${id}`);
    // _archiveTempSession runs on subprocess exit; wait for archive to complete.
    await waitFor(() => isArchived(sid));
    // Title is retained — still meaningful on an archived session.
    assert.equal(await getTitle(sid), 'ephemeral');
  }
});

test('resuming a crashed session recovers firstPrompt from disk instead of losing it to the next message', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'crash-resumed' });

  const r1 = await api(baseUrl, 'POST', '/api/instances', { project: 'crash-resumed' });
  const sid = r1.body.sessionId;
  const inst = instances.get(r1.body.id);
  await waitFor(() => inst.status === 'idle' && inst.sessionId === sid);

  // Plant the original first-turn content on disk — the fake CLI (like a
  // real crash) never gets to write this itself; this mirrors what a real
  // session's jsonl holds after its actual first prompt.
  const cwd = path.join(projectsRoot, 'crash-resumed');
  const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sid}.jsonl`),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Foo bar' } })}\n`,
  );

  // Simulate a crash: kill the subprocess without going through the normal
  // exit/cleanup path, leaving the Instance in byId with proc === null.
  inst.proc.kill('SIGKILL');
  await waitFor(() => !inst.proc);

  // Resume via the generic path (a UI "resume dead session" click, crash/
  // anchor auto-resume, respawn_instance all go through create({resume})
  // with a BRAND NEW Instance object — unlike the restart-manifest path,
  // nothing else seeds firstPrompt for it).
  const inst2 = await instances.create({ project: 'crash-resumed', resume: sid });
  assert.equal(inst2.firstPrompt, 'Foo bar', 'firstPrompt recovered from disk immediately on resume');

  await waitFor(() => inst2.status === 'idle');
  await inst2.prompt('please continue');
  await waitFor(() => inst2.status === 'idle');
  assert.equal(inst2.firstPrompt, 'Foo bar', 'the next real message must not clobber the recovered label');
});
