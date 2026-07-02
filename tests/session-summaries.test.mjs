import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  setSummary, getSummaries, deleteSummaries, loadAll,
} from '../src/sessionSummaries.js';
import { orchStoreRoot, findSessionLocation } from '../src/projects.js';
import { summarySpawnDir } from '../src/summarize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');
const FAKE_SUMMARIZE = path.join(__dirname, 'fake-claude-summarize.mjs');

let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;
before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot, claudeProjectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// ---------------------------------------------------------------------------
// Store layer
// ---------------------------------------------------------------------------

test('setSummary / getSummaries round-trip persists to disk', async () => {
  assert.deepEqual(await getSummaries('sid-A'), {});

  const rec = { summary: 'Short gist.', generatedAt: 1000, messageCount: 5 };
  const stored = await setSummary('sid-A', 'short', rec);
  assert.equal(stored.summary, 'Short gist.');
  assert.equal(stored.messageCount, 5);

  const tiers = await getSummaries('sid-A');
  assert.ok(tiers.short);
  assert.equal(tiers.short.summary, 'Short gist.');
  assert.equal(tiers.medium, undefined);
  assert.equal(tiers.long, undefined);

  // Disk shape
  const file = path.join(orchStoreRoot(), 'session-summaries.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw.summaries['sid-A'].short.summary, 'Short gist.');
  assert.equal(raw.summaries['sid-A'].medium, undefined);
});

test('multiple tiers coexist for one session; setSummary does not clobber others', async () => {
  await setSummary('sid-A', 'short', { summary: 'Short.', generatedAt: 1, messageCount: 2 });
  await setSummary('sid-A', 'long', { summary: 'Long detailed.', generatedAt: 2, messageCount: 2 });

  const tiers = await getSummaries('sid-A');
  assert.equal(tiers.short.summary, 'Short.');
  assert.equal(tiers.long.summary, 'Long detailed.');
  assert.equal(tiers.medium, undefined);
});

test('overwrite one tier does not affect other tiers', async () => {
  await setSummary('sid-A', 'short', { summary: 'First short.', generatedAt: 1, messageCount: 1 });
  await setSummary('sid-A', 'medium', { summary: 'Medium.', generatedAt: 2, messageCount: 1 });
  await setSummary('sid-A', 'short', { summary: 'Updated short.', generatedAt: 3, messageCount: 2 });

  const tiers = await getSummaries('sid-A');
  assert.equal(tiers.short.summary, 'Updated short.');
  assert.equal(tiers.medium.summary, 'Medium.');
});

test('concurrent writes do not lose entries', async () => {
  await Promise.all([
    setSummary('sid-1', 'short', { summary: 'one', generatedAt: 1, messageCount: 1 }),
    setSummary('sid-2', 'medium', { summary: 'two', generatedAt: 2, messageCount: 2 }),
    setSummary('sid-3', 'long', { summary: 'three', generatedAt: 3, messageCount: 3 }),
    setSummary('sid-1', 'medium', { summary: 'one-med', generatedAt: 4, messageCount: 1 }),
    setSummary('sid-2', 'long', { summary: 'two-long', generatedAt: 5, messageCount: 2 }),
  ]);
  const all = await loadAll();
  assert.equal(all.get('sid-1').short.summary, 'one');
  assert.equal(all.get('sid-1').medium.summary, 'one-med');
  assert.equal(all.get('sid-2').medium.summary, 'two');
  assert.equal(all.get('sid-2').long.summary, 'two-long');
  assert.equal(all.get('sid-3').long.summary, 'three');
});

test('deleteSummaries removes all tiers and unlinks file when empty', async () => {
  await setSummary('sid-A', 'short', { summary: 'x', generatedAt: 1, messageCount: 1 });
  await setSummary('sid-A', 'long', { summary: 'y', generatedAt: 2, messageCount: 1 });

  await deleteSummaries('sid-A');
  assert.deepEqual(await getSummaries('sid-A'), {});

  const file = path.join(orchStoreRoot(), 'session-summaries.json');
  let exists = true;
  try { await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
  assert.equal(exists, false, 'sidecar should be unlinked when empty');
});

test('backward-compat: old single-summary shape is migrated on read', async () => {
  // Write an old-style entry directly to the sidecar file.
  const file = path.join(orchStoreRoot(), 'session-summaries.json');
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    summaries: {
      'old-sid': { summary: 'Old summary.', length: 'medium', generatedAt: 999, messageCount: 7 },
    },
  }) + '\n');

  const tiers = await getSummaries('old-sid');
  assert.equal(tiers.medium?.summary, 'Old summary.');
  assert.equal(tiers.medium?.messageCount, 7);
  assert.equal(tiers.short, undefined);
  assert.equal(tiers.long, undefined);
});

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

async function plantJsonl(projPath, sid, lines) {
  const encoded = projPath.replace(/[^A-Za-z0-9-]/g, '-');
  const dir = path.join(claudeProjectsRoot, encoded);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

test('GET /api/sessions/:sid/summary returns all-null when no summaries exist', async () => {
  const r = await api(baseUrl, 'GET', '/api/sessions/no-sum-sid/summary');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.short, null);
  assert.equal(r.body.data.medium, null);
  assert.equal(r.body.data.long, null);
});

test('GET returns per-tier data with isStale:false when counts match', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'get-fresh' });
  const sid = 'sid-get-fresh';
  await plantJsonl(path.join(projectsRoot, 'get-fresh'), sid, [
    { type: 'user', message: { role: 'user', content: 'q' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
  ]);

  await setSummary(sid, 'short', { summary: 'S.', generatedAt: 1, messageCount: 2 });
  await setSummary(sid, 'long', { summary: 'L.', generatedAt: 2, messageCount: 2 });

  const r = await api(baseUrl, 'GET', `/api/sessions/${sid}/summary`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.short.summary, 'S.');
  assert.equal(r.body.data.short.isStale, false);
  assert.equal(r.body.data.medium, null);
  assert.equal(r.body.data.long.summary, 'L.');
  assert.equal(r.body.data.long.isStale, false);
});

test('GET returns isStale:true per tier when session has grown', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'get-stale' });
  const sid = 'sid-get-stale';
  // 4 lines in jsonl now, but summaries were generated at messageCount=1.
  await plantJsonl(path.join(projectsRoot, 'get-stale'), sid, [
    { type: 'user', message: { role: 'user', content: 'a' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } },
    { type: 'user', message: { role: 'user', content: 'c' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'd' }] } },
  ]);

  await setSummary(sid, 'short', { summary: 'S.', generatedAt: 1, messageCount: 1 });
  await setSummary(sid, 'medium', { summary: 'M.', generatedAt: 2, messageCount: 4 }); // fresh

  const r = await api(baseUrl, 'GET', `/api/sessions/${sid}/summary`);
  assert.equal(r.body.data.short.isStale, true);
  assert.equal(r.body.data.medium.isStale, false);
  assert.equal(r.body.data.long, null);
});

test('POST returns 400 on invalid length', async () => {
  const r = await api(baseUrl, 'POST', '/api/sessions/abc-123/summary', { length: 'huge' });
  assert.equal(r.status, 400);
});

test('POST generates, saves under the right tier, and does NOT clobber other tiers', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'post-gen' });
  const sid = 'sid-post-gen';
  await plantJsonl(path.join(projectsRoot, 'post-gen'), sid, [
    { type: 'user', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  ]);

  // Pre-seed a long summary.
  await setSummary(sid, 'long', { summary: 'Pre-existing long.', generatedAt: 1, messageCount: 2 });

  const origBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = `${process.execPath} ${FAKE_SUMMARIZE}`;
  try {
    const r = await api(baseUrl, 'POST', `/api/sessions/${sid}/summary`, { length: 'short' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    // The generated short tier is in the response.
    assert.equal(r.body.data.short.summary, 'This is a canned test summary of the session.');
    // The pre-existing long tier is still there (not clobbered).
    assert.equal(r.body.data.long.summary, 'Pre-existing long.');
    assert.equal(r.body.data.medium, null);

    // Persisted correctly.
    const tiers = await getSummaries(sid);
    assert.equal(tiers.short.summary, 'This is a canned test summary of the session.');
    assert.equal(tiers.long.summary, 'Pre-existing long.');
  } finally {
    if (origBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = origBin;
  }
});

test('DELETE /api/projects/:name/sessions/:sid removes all tiers', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'del-sum' });
  const sid = 'sid-del-sum';
  await plantJsonl(path.join(projectsRoot, 'del-sum'), sid, [
    { type: 'user', message: { role: 'user', content: 'x' } },
  ]);

  await setSummary(sid, 'short', { summary: 'S.', generatedAt: 1, messageCount: 1 });
  await setSummary(sid, 'medium', { summary: 'M.', generatedAt: 2, messageCount: 1 });

  const del = await api(baseUrl, 'DELETE', `/api/projects/del-sum/sessions/${sid}`);
  assert.equal(del.status, 200);

  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(await getSummaries(sid), {});
});

// ---------------------------------------------------------------------------
// Scratch-dir isolation: POST must use SCRATCH_DIR as cwd, not a real project.
// ---------------------------------------------------------------------------

test('POST spawns subprocess in .code-conductor/summaries dir (not a real project cwd)', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'spawn-cwd' });
  const sid = 'sid-spawn-cwd';
  await plantJsonl(path.join(projectsRoot, 'spawn-cwd'), sid, [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] } },
  ]);

  // Use a temp file to capture the subprocess's cwd reported by the fake.
  const cwdOut = path.join(os.tmpdir(), `cc-test-cwd-${Date.now()}.txt`);
  const origBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = `${process.execPath} ${FAKE_SUMMARIZE}`;
  process.env.FAKE_SUMMARIZE_CWD_OUT = cwdOut;
  try {
    const r = await api(baseUrl, 'POST', `/api/sessions/${sid}/summary`, { length: 'short' });
    assert.equal(r.status, 200);

    const spawnedCwd = (await fs.readFile(cwdOut, 'utf8').catch(() => '')).trim();
    const expectedSpawnDir = summarySpawnDir();
    assert.equal(spawnedCwd, expectedSpawnDir,
      `subprocess cwd should be summarySpawnDir(), got: ${spawnedCwd}`);
  } finally {
    if (origBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = origBin;
    delete process.env.FAKE_SUMMARIZE_CWD_OUT;
    await fs.unlink(cwdOut).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// .conduct (hidden conductor project) regression — listProjects() skips
// dot-prefixed dirs, so findSessionLocation must special-case .conduct or
// conductor-session summaries 404 as "session not found".
// ---------------------------------------------------------------------------

test('findSessionLocation resolves a session under the hidden .conduct project', async () => {
  const conductPath = path.join(projectsRoot, '.conduct');
  await fs.mkdir(conductPath, { recursive: true });
  const sid = 'sid-conduct-locate';
  await plantJsonl(conductPath, sid, [
    { type: 'user', message: { role: 'user', content: 'hi' } },
  ]);

  const hit = await findSessionLocation(sid);
  assert.deepEqual(hit, { project: '.conduct', worktreeName: null });
});

test('POST /api/sessions/:sid/summary succeeds for a .conduct session', async () => {
  const conductPath = path.join(projectsRoot, '.conduct');
  await fs.mkdir(conductPath, { recursive: true });
  const sid = 'sid-conduct-summary';
  await plantJsonl(conductPath, sid, [
    { type: 'user', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  ]);

  const origBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = `${process.execPath} ${FAKE_SUMMARIZE}`;
  try {
    const r = await api(baseUrl, 'POST', `/api/sessions/${sid}/summary`, { length: 'short' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.short.summary, 'This is a canned test summary of the session.');
  } finally {
    if (origBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = origBin;
  }
});
