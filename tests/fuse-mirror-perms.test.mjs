// `mirrorPerms.ts`: cc's helpers for its own mirror tree under read-only
// source modes. Root bypasses DAC, so the mode arms skip there rather than
// passing vacuously.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { mkdtemp } from './tmpRegistry.mjs';
import { removeOwnedTree, replaceViaScratch, widenDirMode } from '../src/systems/fuse/mirrorPerms.ts';

const modeOf = async (p) => (await fs.stat(p)).mode & 0o777;

// Owner rwx back so tmpRegistry's cleanup is not blocked.
async function openUp(dir) {
  const st = await fs.lstat(dir).catch(() => null);
  if (!st) return;
  if (!st.isDirectory()) { await fs.chmod(dir, 0o644).catch(() => {}); return; }
  await fs.chmod(dir, 0o755).catch(() => {});
  for (const n of await fs.readdir(dir).catch(() => [])) await openUp(path.join(dir, n));
}

async function box() {
  const dir = await mkdtemp('cc-perms-');
  return { dir, done: () => openUp(dir) };
}

describe('widenDirMode', () => {
  // PINS: owner rwx is OR-ed in and every other bit — group, other, setgid,
  // sticky — is preserved.
  test('ORs in owner rwx and keeps the other bits', () => {
    assert.equal(widenDirMode(0o555), 0o755);
    assert.equal(widenDirMode(0o550), 0o750);
    assert.equal(widenDirMode(0o333), 0o733);
    assert.equal(widenDirMode(0o2555), 0o2755);
    assert.equal(widenDirMode(0o1000), 0o1700);
  });
});

describe('mirrorPerms', {
  skip: process.getuid?.() === 0 && 'root bypasses DAC, so 0555 constrains nothing and the arms would pass vacuously',
}, () => {
  // PINS: a tree of nested read-only dirs holding read-only files is removable.
  test('removeOwnedTree removes nested 0555 dirs holding 0444 files', async () => {
    const b = await box();
    try {
      const t = path.join(b.dir, 't');
      await fs.mkdir(path.join(t, 'x', 'y'), { recursive: true });
      await fs.writeFile(path.join(t, 'x', 'y', 'f'), 'x');
      await fs.chmod(path.join(t, 'x', 'y', 'f'), 0o444);
      for (const d of [path.join(t, 'x', 'y'), path.join(t, 'x'), t]) await fs.chmod(d, 0o555);
      await removeOwnedTree(t);
      await assert.rejects(() => fs.lstat(t), { code: 'ENOENT' });
    } finally { await b.done(); }
  });

  // PINS: a removal that still fails after the subtree is opened REJECTS — the
  // caller can log it — and a read-only PARENT is not chmod'd to make it work.
  test('removeOwnedTree rejects when the parent is read-only, and leaves the parent alone', async () => {
    const b = await box();
    try {
      const parent = path.join(b.dir, 'p');
      await fs.mkdir(path.join(parent, 't'), { recursive: true });
      await fs.writeFile(path.join(parent, 't', 'f'), 'x');
      await fs.chmod(parent, 0o555);
      await assert.rejects(() => removeOwnedTree(path.join(parent, 't')), { code: 'EACCES' });
      assert.equal(await modeOf(parent), 0o555);
    } finally { await b.done(); }
  });

  // PINS: the written temp becomes `dest` as a NEW inode carrying the given mode
  // and mtime, and the scratch dir is left empty.
  test('replaceViaScratch installs a new inode with the mode and mtime, leaving the scratch empty', async () => {
    const b = await box();
    try {
      const scratch = path.join(b.dir, 'scratch');
      const dest = path.join(b.dir, 'dest');
      await fs.writeFile(dest, 'old'); await fs.chmod(dest, 0o444);
      const ino = (await fs.stat(dest)).ino;
      await replaceViaScratch(scratch, dest, 0o444, 1_700_000_000_000, async (tmp) => { await fs.writeFile(tmp, 'new'); return true; });
      assert.equal(await fs.readFile(dest, 'utf8'), 'new');
      assert.equal(await modeOf(dest), 0o444);
      assert.equal(Math.floor((await fs.stat(dest)).mtimeMs), 1_700_000_000_000);
      assert.notEqual((await fs.stat(dest)).ino, ino);
      assert.deepEqual(await fs.readdir(scratch), []);
    } finally { await b.done(); }
  });

  // PINS: `write` declining or throwing leaves `dest` untouched and no temp behind.
  test('replaceViaScratch leaves dest untouched and the scratch empty when write declines or throws', async () => {
    const b = await box();
    try {
      const scratch = path.join(b.dir, 'scratch');
      const dest = path.join(b.dir, 'dest');
      await fs.writeFile(dest, 'old'); await fs.chmod(dest, 0o444);
      await replaceViaScratch(scratch, dest, 0o444, 0, async (tmp) => { await fs.writeFile(tmp, 'x'); return false; });
      await assert.rejects(() => replaceViaScratch(scratch, dest, 0o444, 0, async (tmp) => { await fs.writeFile(tmp, 'x'); throw new Error('boom'); }), /boom/);
      assert.equal(await fs.readFile(dest, 'utf8'), 'old');
      assert.deepEqual(await fs.readdir(scratch), []);
    } finally { await b.done(); }
  });
});
