// Unit tests for migration 0004 (relocate whisper/piper installs from the old
// $HOME/.code-conductor default into the central store). HOME and INSTALL_ROOT
// are redirected to temp dirs so the test never touches the real install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as m0004 from '../migrations/0004-relocate-av-installs.mjs';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cc-relocate-av-'));
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

// Stage a fake install dir tree with a recognisable marker file inside.
async function stageInstall(root, dir, marker) {
  const d = path.join(root, '.code-conductor', dir);
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(d, 'MARKER'), marker);
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

test('0004: moves whisper.cpp + piper from old $HOME default into the central store', async () => {
  const home = await mkTmp();
  const root = await mkTmp();
  try {
    await withEnv({ HOME: home, INSTALL_ROOT: undefined }, async () => {
      await stageInstall(home, 'whisper.cpp', 'W');
      await stageInstall(home, 'piper', 'P');

      const logs = [];
      const res = await m0004.run({ root, log: (...a) => logs.push(a.join(' ')) });

      assert.equal(res.applied, true);
      assert.equal(res.summary['whisper.cpp'], 'moved');
      assert.equal(res.summary['piper'], 'moved');

      // Landed in the central store, marker content intact.
      assert.equal(await fs.readFile(path.join(root, '.code-conductor', 'whisper.cpp', 'MARKER'), 'utf8'), 'W');
      assert.equal(await fs.readFile(path.join(root, '.code-conductor', 'piper', 'MARKER'), 'utf8'), 'P');

      // Old location gone (and tidied up since it's now empty).
      assert.equal(await exists(path.join(home, '.code-conductor', 'whisper.cpp')), false);
      assert.equal(await exists(path.join(home, '.code-conductor')), false);
      assert.equal(res.summary.oldRootRemoved, true);

      // Second run is a fast no-op.
      const res2 = await m0004.run({ root, log: () => {} });
      assert.equal(res2.applied, false);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('0004: no-op when INSTALL_ROOT is pinned', async () => {
  const home = await mkTmp();
  const root = await mkTmp();
  try {
    await withEnv({ HOME: home, INSTALL_ROOT: '/some/pinned/root' }, async () => {
      await stageInstall(home, 'whisper.cpp', 'W'); // present but should be ignored
      const res = await m0004.run({ root, log: () => {} });
      assert.equal(res.applied, false);
      // Old copy left untouched (the pinned install is the user's concern).
      assert.equal(await exists(path.join(home, '.code-conductor', 'whisper.cpp')), true);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('0004: no-op when nothing is at the old default', async () => {
  const home = await mkTmp();
  const root = await mkTmp();
  try {
    await withEnv({ HOME: home, INSTALL_ROOT: undefined }, async () => {
      const res = await m0004.run({ root, log: () => {} });
      assert.equal(res.applied, false);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('0004: backs up the stale old copy instead of clobbering a destination install', async () => {
  const home = await mkTmp();
  const root = await mkTmp();
  try {
    await withEnv({ HOME: home, INSTALL_ROOT: undefined }, async () => {
      await stageInstall(home, 'whisper.cpp', 'OLD'); // stale, at old default
      await stageInstall(root, 'whisper.cpp', 'NEW'); // authoritative, at new store

      const res = await m0004.run({ root, log: () => {} });
      assert.equal(res.applied, true);
      assert.match(res.summary['whisper.cpp'], /backed-up/);

      // The newer install is preserved untouched.
      assert.equal(await fs.readFile(path.join(root, '.code-conductor', 'whisper.cpp', 'MARKER'), 'utf8'), 'NEW');

      // The stale copy is preserved in a backup dir (not deleted).
      const entries = await fs.readdir(path.join(root, '.code-conductor'));
      const backup = entries.find(e => e.startsWith('migrated-backup-'));
      assert.ok(backup, `expected a migrated-backup-* dir; got ${entries.join(', ')}`);
      assert.equal(await fs.readFile(path.join(root, '.code-conductor', backup, 'whisper.cpp', 'MARKER'), 'utf8'), 'OLD');

      // Old default is emptied + removed.
      assert.equal(await exists(path.join(home, '.code-conductor')), false);
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});
