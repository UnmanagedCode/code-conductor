// Tests for code-conductor's ownership of the projects-root CLAUDE.md.
// The file is fully app-owned: regenerated (overwritten) from the composed
// workspace convention modules on boot and on every Settings → Workspace
// conventions change — no three-way reconcile, no conflict UI. The only
// safety net is a ONE-TIME backup of a hand-edited copy on the first
// app-owned regeneration (detected by an absent sentinel).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api } from './helpers.mjs';
import { ensureRootClaudeMd, targetPath } from '../src/rootClaudeMd.js';
import { composeCurrentWorkspace } from '../src/workspaceModules.js';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-rootclaudemd-'));
}

async function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return await fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function writeFileMk(p, text) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
}

async function read(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

function storeDir(root) { return path.join(root, '.code-conductor', 'workspace-claudemd'); }
function legacyBaseline(root) { return path.join(storeDir(root), 'baseline.md'); }
function ownedMarker(root) { return path.join(storeDir(root), 'owned.json'); }

async function baks(root) {
  const entries = await fs.readdir(root);
  return entries.filter(n => /^CLAUDE\.md\.bak-\d{8}-\d{6}$/.test(n));
}

// ── create ────────────────────────────────────────────────────────────────

test('ensureRootClaudeMd: target missing → creates it = composed workspace; sentinel written; no backup', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      const res = await ensureRootClaudeMd();
      assert.equal(res.created, true);
      assert.equal(res.backedUp, false);
      assert.equal(await read(targetPath()), await composeCurrentWorkspace());
      assert.ok(await read(ownedMarker(root)), 'sentinel written');
      assert.equal((await baks(root)).length, 0);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── unedited upgrade (no backup) ─────────────────────────────────────────────

test('ensureRootClaudeMd: unedited target (== legacy baseline) is overwritten with NO backup', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      // target == baseline == an OLD canonical that differs from composed.
      await writeFileMk(legacyBaseline(root), 'OLD CANONICAL\n');
      await writeFileMk(targetPath(), 'OLD CANONICAL\n');
      const res = await ensureRootClaudeMd();
      assert.equal(res.backedUp, false, 'unedited copy is not backed up');
      assert.equal(await read(targetPath()), await composeCurrentWorkspace());
      assert.equal((await baks(root)).length, 0);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── first-transition backup of a hand-edited copy ────────────────────────────

test('ensureRootClaudeMd: hand-edited target (!= legacy baseline) → one .bak, then overwritten', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await writeFileMk(legacyBaseline(root), 'OLD CANONICAL\n');
      await writeFileMk(targetPath(), 'MY LOCAL EDITS\n');
      const res = await ensureRootClaudeMd();
      assert.equal(res.backedUp, true);
      const bs = await baks(root);
      assert.equal(bs.length, 1, `expected one .bak, got ${JSON.stringify(bs)}`);
      assert.equal(await read(path.join(root, bs[0])), 'MY LOCAL EDITS\n');
      assert.equal(await read(targetPath()), await composeCurrentWorkspace());
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('ensureRootClaudeMd: no legacy baseline + target differs from composed → backup (fallback oracle)', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await writeFileMk(targetPath(), 'SOME EXISTING FILE\n'); // no baseline.md present
      const res = await ensureRootClaudeMd();
      assert.equal(res.backedUp, true);
      assert.equal((await baks(root)).length, 1);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('ensureRootClaudeMd: no legacy baseline + target already == composed → NO backup', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await writeFileMk(targetPath(), await composeCurrentWorkspace());
      const res = await ensureRootClaudeMd();
      assert.equal(res.backedUp, false);
      assert.equal((await baks(root)).length, 0);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── one-time only: second run never backs up ─────────────────────────────────

test('ensureRootClaudeMd: after the sentinel exists, a since-edited target is overwritten with NO new backup', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await ensureRootClaudeMd();               // first transition: writes sentinel
      await fs.writeFile(targetPath(), 'HAND EDIT AFTER OWNERSHIP\n');
      const res = await ensureRootClaudeMd();   // second run
      assert.equal(res.backedUp, false, 'one-time backup fires only on first transition');
      assert.equal(await read(targetPath()), await composeCurrentWorkspace());
      assert.equal((await baks(root)).length, 0);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── HTTP surface ─────────────────────────────────────────────────────────────

test('GET /api/settings/workspace-conventions returns core + 4 modules + enabled (all on)', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/settings/workspace-conventions');
    assert.equal(r.status, 200);
    assert.ok(r.body.core && r.body.core.name);
    assert.equal(r.body.modules.length, 4);
    assert.equal(r.body.enabled.length, 4);
    for (const m of r.body.modules) assert.equal(m.builtin, true);
  } finally { await close(); }
});

test('PUT selection regenerates the projects-root CLAUDE.md; built-in edit/delete → 400', async () => {
  const { baseUrl, projectsRoot, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'PUT', '/api/settings/workspace-conventions/selection', {
      enabled: ['git-hygiene'],
    });
    assert.equal(r.status, 200);
    const content = await read(path.join(projectsRoot, 'CLAUDE.md'));
    assert.match(content, /## Git hygiene/);
    assert.doesNotMatch(content, /## Opening URLs/);
    assert.ok(content.startsWith('# Project workspace conventions'), 'core first');

    const put = await api(baseUrl, 'PUT', '/api/settings/workspace-conventions/git-hygiene', { name: 'X' });
    assert.equal(put.status, 400);
    const del = await api(baseUrl, 'DELETE', '/api/settings/workspace-conventions/git-hygiene');
    assert.equal(del.status, 400);
    const bad = await api(baseUrl, 'PUT', '/api/settings/workspace-conventions/selection', { enabled: ['nope'] });
    assert.equal(bad.status, 400);
  } finally { await close(); }
});
