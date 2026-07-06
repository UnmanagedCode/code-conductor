import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  setSummary, getSummaries, deleteSummaries, loadAll, migrateSummaries,
} from '../src/sessionSummaries.js';
import { orchStoreRoot, findSessionLocation, encodeCwd } from '../src/projects.js';
import { summarySpawnDir } from '../src/summarize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');
const FAKE_SUMMARIZE = path.join(__dirname, 'fake-claude-summarize.mjs');
// Init event carries a hardcoded session_id different from the spawned id,
// forcing the resume rekey branch (the default mock keeps the id stable).
const REKEY = path.join(__dirname, 'fixtures', 'scenario-rekey.json');
const REKEY_NEW_SID = '11111111-1111-1111-1111-111111111111';

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

test('migrateSummaries moves all tiers old→new and is a no-op for missing/same id', async () => {
  await setSummary('sid-old', 'short', { summary: 'carry short', generatedAt: 1, messageCount: 2 });
  await setSummary('sid-old', 'long', { summary: 'carry long', generatedAt: 2, messageCount: 2 });

  // Missing source → no-op.
  assert.equal(await migrateSummaries('sid-absent', 'sid-new'), null);
  assert.deepEqual(await getSummaries('sid-new'), {});

  // Same id → no-op (entry untouched).
  assert.equal(await migrateSummaries('sid-old', 'sid-old'), null);
  assert.equal((await getSummaries('sid-old')).short.summary, 'carry short');

  // Real move — whole entry (all tiers) carried.
  const moved = await migrateSummaries('sid-old', 'sid-new');
  assert.equal(moved.short.summary, 'carry short');
  assert.equal(moved.long.summary, 'carry long');
  const at = await getSummaries('sid-new');
  assert.equal(at.short.summary, 'carry short');
  assert.equal(at.long.summary, 'carry long');
  assert.deepEqual(await getSummaries('sid-old'), {}, 'old key removed (move, not copy)');
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

// ---------------------------------------------------------------------------
// Resume rekey — `claude --resume` mints a new session_id at init; the entry
// (keyed by sessionId) must MOVE to the new id, not orphan under the old.
// ---------------------------------------------------------------------------

test('resume rekey migrates session summaries from the old sessionId to the new', async () => {
  const OLD_SID = '99999999-9999-9999-9999-999999999999';
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = REKEY;
  try {
    await api(baseUrl, 'POST', '/api/projects', { name: 'rekey-summed' });

    // Summaries generated under the session's current (old) id.
    await setSummary(OLD_SID, 'short', { summary: 'Old-id short.', generatedAt: 1, messageCount: 2 });
    await setSummary(OLD_SID, 'long', { summary: 'Old-id long.', generatedAt: 2, messageCount: 2 });

    // Plant a jsonl for the old id so a real --resume would find it (the mock
    // ignores it, but this mirrors the live layout).
    const cwd = path.join(projectsRoot, 'rekey-summed');
    const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${OLD_SID}.jsonl`), '{"type":"user","uuid":"u1"}\n');

    // Resume: spawn sets sessionId=OLD_SID; the fixture's init then reports a
    // NEW session_id, driving the rekey branch (the real --resume behaviour).
    const inst = await instances.create({ project: 'rekey-summed', resume: OLD_SID });
    await waitFor(() => inst.status === 'idle' && inst.sessionId === OLD_SID);
    // The fake CLI (like the real one) is silent until the first stdin line —
    // the init event carrying the new session_id arrives with the first turn.
    await inst.prompt('go');
    await waitFor(() => inst.sessionId === REKEY_NEW_SID);

    // Entry MOVED to the live (new) id, all tiers intact; old id cleared.
    await waitFor(async () => (await getSummaries(REKEY_NEW_SID)).short?.summary === 'Old-id short.');
    const at = await getSummaries(REKEY_NEW_SID);
    assert.equal(at.short.summary, 'Old-id short.', 'short tier migrated to new id');
    assert.equal(at.long.summary, 'Old-id long.', 'long tier migrated to new id');
    assert.deepEqual(await getSummaries(OLD_SID), {}, 'old id cleared (move, not copy)');
  } finally {
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});
