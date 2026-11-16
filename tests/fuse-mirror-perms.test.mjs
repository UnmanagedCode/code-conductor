// `mirrorPerms.ts`: cc's transient owner grants on read-only mirror entries.
// Root bypasses DAC, so every arm skips there rather than passing vacuously.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { mkdtemp } from './tmpRegistry.mjs';
import { DirGrants, withOwnerWrite, removeOwnedTree } from '../src/systems/fuse/mirrorPerms.ts';

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

describe('mirrorPerms', {
  skip: process.getuid?.() === 0 && 'root bypasses DAC, so 0555 constrains nothing and the arms would pass vacuously',
}, () => {
  // PINS: a write into a 0555 dir succeeds under a grant and the mode is back.
  test('inDir grants owner write on EACCES and restores the mode', async () => {
    const b = await box();
    try {
      const d = path.join(b.dir, 'd'); await fs.mkdir(d); await fs.chmod(d, 0o555);
      await new DirGrants().inDir(d, () => fs.writeFile(path.join(d, 'f'), 'x'));
      assert.equal(await fs.readFile(path.join(d, 'f'), 'utf8'), 'x');
      assert.equal(await modeOf(d), 0o555);
    } finally { await b.done(); }
  });

  // PINS: a writable dir is never touched — the op runs once and sees its own mode.
  test('inDir does not grant when the dir is writable', async () => {
    const b = await box();
    try {
      const d = path.join(b.dir, 'd'); await fs.mkdir(d); await fs.chmod(d, 0o755);
      let calls = 0, seen;
      await new DirGrants().inDir(d, async () => { calls++; seen = await modeOf(d); });
      assert.equal(calls, 1);
      assert.equal(seen, 0o755);
    } finally { await b.done(); }
  });

  // PINS: a mode the worker changes mid-grant is not reverted to the old one.
  test('inDir restores only when the mode is still the granted one', async () => {
    const b = await box();
    try {
      const d = path.join(b.dir, 'd'); await fs.mkdir(d); await fs.chmod(d, 0o555);
      await new DirGrants().inDir(d, async () => {
        await fs.writeFile(path.join(d, 'f'), 'x');
        await fs.chmod(d, 0o750);
      });
      assert.equal(await modeOf(d), 0o750);
    } finally { await b.done(); }
  });

  // PINS: setDirMode is serialised behind a grant, so it cannot revoke the
  // write a child op relies on, and lands once the grant is over.
  test('setDirMode waits for a grant in flight', async () => {
    const b = await box();
    try {
      const d = path.join(b.dir, 'd'); await fs.mkdir(d); await fs.chmod(d, 0o555);
      const g = new DirGrants();
      let release; const gate = new Promise((r) => { release = r; });
      let entered; const inside = new Promise((r) => { entered = r; });
      let first = true;
      const grant = g.inDir(d, async () => {
        if (first) { first = false; await fs.writeFile(path.join(d, 'f'), 'x'); }
        entered(); await gate;
      });
      // The first attempt above succeeds only after the retry, so wait for it.
      await inside;
      const set = g.setDirMode(d, 0o500);
      await new Promise((r) => setImmediate(r));
      assert.equal(await modeOf(d), 0o755, 'the pending setDirMode landed during the grant');
      release();
      await Promise.all([grant, set]);
      assert.equal(await modeOf(d), 0o500);
    } finally { await b.done(); }
  });

  // PINS: only EACCES takes the grant path; any other error surfaces once, mode untouched.
  test('inDir rethrows a non-EACCES error without retrying', async () => {
    const b = await box();
    try {
      const d = path.join(b.dir, 'd'); await fs.mkdir(d); await fs.chmod(d, 0o555);
      let calls = 0;
      await assert.rejects(
        () => new DirGrants().inDir(d, async () => { calls++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }),
        { code: 'ENOENT' });
      assert.equal(calls, 1);
      assert.equal(await modeOf(d), 0o555);
    } finally { await b.done(); }
  });

  // PINS: mkdirp builds a chain under a read-only ancestor and leaves it read-only.
  test('mkdirp creates a chain under a 0555 ancestor and restores it', async () => {
    const b = await box();
    try {
      const a = path.join(b.dir, 'a'); await fs.mkdir(a); await fs.chmod(a, 0o555);
      await new DirGrants().mkdirp(path.join(a, 'b', 'c'));
      assert.ok((await fs.stat(path.join(a, 'b', 'c'))).isDirectory());
      assert.equal(await modeOf(a), 0o555);
    } finally { await b.done(); }
  });

  // PINS: a 0444 file is rewritable and ends at the final mode, even if the write throws.
  test('withOwnerWrite rewrites a 0444 file and restores the mode, also on a throw', async () => {
    const b = await box();
    try {
      const f = path.join(b.dir, 'f'); await fs.writeFile(f, 'old'); await fs.chmod(f, 0o444);
      await withOwnerWrite(f, 0o444, () => fs.writeFile(f, 'new'));
      assert.equal(await fs.readFile(f, 'utf8'), 'new');
      assert.equal(await modeOf(f), 0o444);
      await assert.rejects(() => withOwnerWrite(f, 0o444, async () => { await fs.writeFile(f, 'x'); throw new Error('boom'); }), /boom/);
      assert.equal(await modeOf(f), 0o444);
    } finally { await b.done(); }
  });

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
});
