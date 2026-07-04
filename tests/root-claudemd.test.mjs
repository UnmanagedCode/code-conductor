// Tests for code-conductor's ownership of the projects-root CLAUDE.md.
// Covers the four-case reconcile (create / up-to-date / silent-update / keep /
// conflict), the keep + overwrite resolutions, the vendor baseline seed, and
// the HTTP endpoints. Mirrors TCC scripts/lib.sh::sync_workspace_claudemd.
// The legacy shell-installer baseline seed is now a boot-time migration —
// see tests/migration-seed-legacy-baseline.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootServer, api } from './helpers.mjs';
import {
  vendorText, targetPath, baselinePath,
  classify, seedBaselineIfNeeded, reconcile, getStatus, getDiff, resolve,
  unifiedDiff,
} from '../src/rootClaudeMd.js';

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

// ── classify (pure) ─────────────────────────────────────────────────────────

test('classify covers all five cases', () => {
  assert.equal(classify({ targetExists: false }), 'create');
  assert.equal(classify({ targetExists: true, targetSha: 'V', vendorSha: 'V' }), 'up-to-date');
  assert.equal(classify({ targetExists: true, targetSha: 'B', baselineSha: 'B', vendorSha: 'V' }), 'silent-update');
  assert.equal(classify({ targetExists: true, targetSha: 'U', baselineSha: 'V', vendorSha: 'V' }), 'keep');
  assert.equal(classify({ targetExists: true, targetSha: 'U', baselineSha: 'B', vendorSha: 'V' }), 'conflict');
});

// ── reconcile: create ───────────────────────────────────────────────────────

test('reconcile: target missing → create (copy vendor→target, baseline written)', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      const res = await reconcile();
      assert.equal(res.status, 'created');
      assert.equal(res.conflict, false);
      assert.equal(await read(targetPath()), vendorText());
      assert.equal(await read(baselinePath()), vendorText());
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── reconcile: up-to-date ───────────────────────────────────────────────────

test('reconcile: target == vendor → up-to-date (baseline bumped, file unchanged)', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await writeFileMk(targetPath(), vendorText());
      const res = await reconcile();
      assert.equal(res.status, 'up-to-date');
      assert.equal(await read(targetPath()), vendorText());
      assert.equal(await read(baselinePath()), vendorText());
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── reconcile: silent-update ────────────────────────────────────────────────

test('reconcile: untouched target + moved vendor → silent update', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      // baseline == target == an OLD canonical that differs from the real vendor.
      await writeFileMk(baselinePath(), 'OLD CANONICAL\n');
      await writeFileMk(targetPath(), 'OLD CANONICAL\n');
      const res = await reconcile();
      assert.equal(res.status, 'updated');
      assert.equal(await read(targetPath()), vendorText());
      assert.equal(await read(baselinePath()), vendorText());
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── reconcile: keep ─────────────────────────────────────────────────────────

test('reconcile: user-edited target + unchanged vendor → keep (no-op)', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await writeFileMk(baselinePath(), vendorText()); // baseline == vendor
      await writeFileMk(targetPath(), 'MY LOCAL EDITS\n');
      const res = await reconcile();
      assert.equal(res.status, 'kept');
      assert.equal(await read(targetPath()), 'MY LOCAL EDITS\n'); // untouched
      assert.equal(await read(baselinePath()), vendorText());
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── reconcile: conflict ─────────────────────────────────────────────────────

test('reconcile: both changed → conflict (file untouched, status reports conflict)', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await writeFileMk(baselinePath(), 'OLD CANONICAL\n');
      await writeFileMk(targetPath(), 'MY LOCAL EDITS\n');
      const res = await reconcile();
      assert.equal(res.status, 'conflict');
      assert.equal(res.conflict, true);
      assert.equal(await read(targetPath()), 'MY LOCAL EDITS\n'); // untouched
      const st = await getStatus();
      assert.equal(st.status, 'conflict');
      assert.equal(st.conflict, true);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── resolve: overwrite ──────────────────────────────────────────────────────

test('resolve overwrite: backs up to .bak-<ts>, copies vendor→target, bumps baseline', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await writeFileMk(baselinePath(), 'OLD CANONICAL\n');
      await writeFileMk(targetPath(), 'MY LOCAL EDITS\n');
      await reconcile(); // → conflict
      const st = await resolve('overwrite');
      assert.notEqual(st.status, 'conflict');
      assert.equal(st.conflict, false);
      assert.equal(await read(targetPath()), vendorText());
      assert.equal(await read(baselinePath()), vendorText());
      // A timestamped backup of the user's copy must exist alongside CLAUDE.md.
      const entries = await fs.readdir(root);
      const baks = entries.filter(n => /^CLAUDE\.md\.bak-\d{8}-\d{6}$/.test(n));
      assert.equal(baks.length, 1, `expected one .bak file, got ${JSON.stringify(entries)}`);
      assert.equal(await read(path.join(root, baks[0])), 'MY LOCAL EDITS\n');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── resolve: keep ───────────────────────────────────────────────────────────

test('resolve keep: bumps baseline to vendor without changing the file', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      await writeFileMk(baselinePath(), 'OLD CANONICAL\n');
      await writeFileMk(targetPath(), 'MY LOCAL EDITS\n');
      await reconcile(); // → conflict
      const st = await resolve('keep');
      assert.equal(st.status, 'kept');
      assert.equal(st.conflict, false);
      assert.equal(await read(targetPath()), 'MY LOCAL EDITS\n'); // byte-identical
      assert.equal(await read(baselinePath()), vendorText());     // baseline bumped
      // No backup file created on keep.
      const entries = await fs.readdir(root);
      assert.equal(entries.some(n => /^CLAUDE\.md\.bak-/.test(n)), false);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── baseline seed ────────────────────────────────────────────────────────────

test('seedBaselineIfNeeded seeds from vendor when absent, and is idempotent', async () => {
  const root = await mkTmp();
  try {
    await withEnv({ PROJECTS_ROOT: root }, async () => {
      const r = await seedBaselineIfNeeded();
      assert.deepEqual(r, { seeded: true, from: 'vendor' });
      assert.equal(await read(baselinePath()), vendorText());
      // Idempotent: a second call is a no-op.
      assert.deepEqual(await seedBaselineIfNeeded(), { seeded: false });
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ── unified diff helper ─────────────────────────────────────────────────────

test('unifiedDiff: identical inputs → empty; differing inputs → +/- lines', () => {
  assert.equal(unifiedDiff('same\n', 'same\n'), '');
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'a/x', 'b/x');
  assert.match(d, /^--- a\/x\n\+\+\+ b\/x\n/);
  assert.match(d, /-b/);
  assert.match(d, /\+B/);
});

// ── HTTP endpoints ──────────────────────────────────────────────────────────

test('GET /api/settings/workspace-claudemd reports status shape', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const r = await api(baseUrl, 'GET', '/api/settings/workspace-claudemd');
    assert.equal(r.status, 200);
    // Fresh temp PROJECTS_ROOT has no CLAUDE.md yet → would be created.
    assert.equal(r.body.status, 'created');
    assert.equal(r.body.targetExists, false);
    assert.equal(typeof r.body.targetPath, 'string');
    assert.equal(typeof r.body.vendorPath, 'string');
    assert.equal(typeof r.body.baselinePath, 'string');
  } finally { await close(); }
});

test('HTTP conflict flow: status conflict → diff non-empty → overwrite resolves', async () => {
  const { baseUrl, projectsRoot, close } = await bootServer();
  try {
    // Stage a both-changed conflict directly on disk.
    const storeBaseline = path.join(projectsRoot, '.code-conductor', 'workspace-claudemd', 'baseline.md');
    await writeFileMk(storeBaseline, 'OLD CANONICAL\n');
    await writeFileMk(path.join(projectsRoot, 'CLAUDE.md'), 'MY LOCAL EDITS\n');

    const st = await api(baseUrl, 'GET', '/api/settings/workspace-claudemd');
    assert.equal(st.body.status, 'conflict');
    assert.equal(st.body.conflict, true);

    const diff = await api(baseUrl, 'GET', '/api/settings/workspace-claudemd/diff');
    assert.equal(diff.status, 200);
    assert.match(diff.body.diff, /MY LOCAL EDITS/);

    const bad = await api(baseUrl, 'POST', '/api/settings/workspace-claudemd/resolve', { action: 'merge' });
    assert.equal(bad.status, 400);

    const ok = await api(baseUrl, 'POST', '/api/settings/workspace-claudemd/resolve', { action: 'overwrite' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.conflict, false);

    const after = await read(path.join(projectsRoot, 'CLAUDE.md'));
    assert.equal(after, vendorText());
  } finally { await close(); }
});
