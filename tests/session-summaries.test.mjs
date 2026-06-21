import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, freshProjectsRoot, rmrf } from './helpers.mjs';
import {
  setSummary, getSummary, deleteSummary, loadAll,
} from '../src/sessionSummaries.js';
import { orchStoreRoot } from '../src/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-basic.json');
const FAKE_SUMMARIZE = path.join(__dirname, 'fake-claude-summarize.mjs');

// One server shared across the file; fresh home dir per test (same pattern as
// session-titles.test.mjs).
let ctx, baseUrl, instances, home, projectsRoot, claudeProjectsRoot;
before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => { ({ home, projectsRoot, claudeProjectsRoot } = await freshProjectsRoot()); });
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// ---------------------------------------------------------------------------
// Store layer (no HTTP)
// ---------------------------------------------------------------------------

test('sessionSummaries: set / get round-trip persists to disk', async () => {
  assert.equal(await getSummary('sid-A'), null);

  const rec = { summary: 'A test summary.', length: 'short', generatedAt: 1000, messageCount: 5 };
  const stored = await setSummary('sid-A', rec);
  assert.equal(stored.summary, 'A test summary.');
  assert.equal(stored.length, 'short');

  const got = await getSummary('sid-A');
  assert.deepEqual(got, stored);

  // Verify disk shape
  const file = path.join(orchStoreRoot(), 'session-summaries.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw.summaries['sid-A'].summary, 'A test summary.');
});

test('sessionSummaries: getSummary returns null on miss', async () => {
  assert.equal(await getSummary('nonexistent-sid'), null);
});

test('sessionSummaries: overwrite updates the entry', async () => {
  await setSummary('sid-A', { summary: 'First.', length: 'short', generatedAt: 1000, messageCount: 3 });
  await setSummary('sid-A', { summary: 'Second.', length: 'long', generatedAt: 2000, messageCount: 10 });
  const got = await getSummary('sid-A');
  assert.equal(got.summary, 'Second.');
  assert.equal(got.length, 'long');
  assert.equal(got.messageCount, 10);
});

test('sessionSummaries: concurrent writes do not lose entries', async () => {
  await Promise.all([
    setSummary('sid-1', { summary: 'one', length: 'short', generatedAt: 1, messageCount: 1 }),
    setSummary('sid-2', { summary: 'two', length: 'medium', generatedAt: 2, messageCount: 2 }),
    setSummary('sid-3', { summary: 'three', length: 'long', generatedAt: 3, messageCount: 3 }),
    setSummary('sid-4', { summary: 'four', length: 'short', generatedAt: 4, messageCount: 4 }),
    setSummary('sid-5', { summary: 'five', length: 'medium', generatedAt: 5, messageCount: 5 }),
  ]);
  const all = await loadAll();
  assert.equal(all.get('sid-1').summary, 'one');
  assert.equal(all.get('sid-2').summary, 'two');
  assert.equal(all.get('sid-3').summary, 'three');
  assert.equal(all.get('sid-4').summary, 'four');
  assert.equal(all.get('sid-5').summary, 'five');
});

test('sessionSummaries: deleting last entry removes the sidecar file', async () => {
  await setSummary('sid-A', { summary: 'only one', length: 'medium', generatedAt: 1, messageCount: 1 });
  await deleteSummary('sid-A');
  assert.equal(await getSummary('sid-A'), null);
  const file = path.join(orchStoreRoot(), 'session-summaries.json');
  let exists = true;
  try { await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
  assert.equal(exists, false, 'sidecar should be unlinked when empty');
});

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

// Plant a minimal jsonl and return the sid + encoded dir.
async function plantJsonl(projPath, sid, lines) {
  const encoded = projPath.replace(/[^A-Za-z0-9-]/g, '-');
  const dir = path.join(claudeProjectsRoot, encoded);
  await fs.mkdir(dir, { recursive: true });
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), content);
  return { encoded, dir };
}

test('GET /api/sessions/:sid/summary returns {data:null} when no summary', async () => {
  const r = await api(baseUrl, 'GET', '/api/sessions/no-summary-sid/summary');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data, null);
});

test('GET /api/sessions/:sid/summary returns data with isStale:false when counts match', async () => {
  // Create a project + jsonl with 2 user+assistant lines.
  await api(baseUrl, 'POST', '/api/projects', { name: 'sum-fresh' });
  const sid = 'sid-fresh-1';
  await plantJsonl(path.join(projectsRoot, 'sum-fresh'), sid, [
    { type: 'user', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  ]);

  // Persist a summary with messageCount=2 (matches).
  await setSummary(sid, { summary: 'A fresh summary.', length: 'medium', generatedAt: Date.now(), messageCount: 2 });

  const r = await api(baseUrl, 'GET', `/api/sessions/${sid}/summary`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.summary, 'A fresh summary.');
  assert.equal(r.body.data.isStale, false);
});

test('GET /api/sessions/:sid/summary returns isStale:true when session has grown', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'sum-stale' });
  const sid = 'sid-stale-1';
  await plantJsonl(path.join(projectsRoot, 'sum-stale'), sid, [
    { type: 'user', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'user', message: { role: 'user', content: 'more' } },
  ]);

  // Stored messageCount=1 but current is 3 → stale.
  await setSummary(sid, { summary: 'Old summary.', length: 'short', generatedAt: Date.now(), messageCount: 1 });

  const r = await api(baseUrl, 'GET', `/api/sessions/${sid}/summary`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.isStale, true);
});

test('POST /api/sessions/:sid/summary returns 400 on invalid length', async () => {
  const r = await api(baseUrl, 'POST', '/api/sessions/abc-123/summary', { length: 'huge' });
  assert.equal(r.status, 400);
});

test('POST /api/sessions/:sid/summary generates and saves using fake CLI', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'sum-gen' });
  const sid = 'sid-gen-1';
  await plantJsonl(path.join(projectsRoot, 'sum-gen'), sid, [
    { type: 'user', message: { role: 'user', content: 'build a thing' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ]);

  const origBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = `${process.execPath} ${FAKE_SUMMARIZE}`;
  try {
    const r = await api(baseUrl, 'POST', `/api/sessions/${sid}/summary`, { length: 'short' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.summary, 'This is a canned test summary of the session.');
    assert.equal(r.body.data.length, 'short');
    assert.ok(typeof r.body.data.messageCount === 'number');
    assert.ok(typeof r.body.data.generatedAt === 'number');

    // Persisted to sidecar.
    const persisted = await getSummary(sid);
    assert.equal(persisted.summary, 'This is a canned test summary of the session.');
  } finally {
    if (origBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = origBin;
  }
});

test('DELETE /api/projects/:name/sessions/:sid also removes summary', async () => {
  await api(baseUrl, 'POST', '/api/projects', { name: 'sum-del' });
  const sid = 'sid-del-1';
  await plantJsonl(path.join(projectsRoot, 'sum-del'), sid, [
    { type: 'user', message: { role: 'user', content: 'hello' } },
  ]);

  await setSummary(sid, { summary: 'will be deleted', length: 'short', generatedAt: Date.now(), messageCount: 1 });
  assert.equal((await getSummary(sid)).summary, 'will be deleted');

  const del = await api(baseUrl, 'DELETE', `/api/projects/sum-del/sessions/${sid}`);
  assert.equal(del.status, 200);

  // Allow the best-effort async deleteSummary to complete.
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await getSummary(sid), null);
});
