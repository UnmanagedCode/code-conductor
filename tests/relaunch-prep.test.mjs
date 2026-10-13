// src/relaunchPrep.ts: ensureDependencies (install only on drift, never into a
// linked node_modules, verify after) and the maintenance lock restart and
// self-update share. Every install command is an injected shell line writing
// into a throwaway fixture tree — nothing here runs npm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDependencies, withMaintenanceLock } from '../src/relaunchPrep.ts';

// A checkout locking a@1.0.0, with `installed` (version of a, or null) in
// `<dir>/node_modules` — or, with `link`, in a sibling dir node_modules links to.
function checkout(t, { installed = null, link = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-relaunch-prep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } }));
  const modules = link ? path.join(dir, 'shared-node_modules') : path.join(repo, 'node_modules');
  fs.mkdirSync(modules);
  if (link) fs.symlinkSync(modules, path.join(repo, 'node_modules'), 'dir');
  if (installed) {
    fs.mkdirSync(path.join(modules, 'a'));
    fs.writeFileSync(path.join(modules, 'a', 'package.json'), JSON.stringify({ name: 'a', version: installed }));
  }
  return { repo, modules, sentinel: path.join(dir, 'ran') };
}

// A shell line that records it ran, then writes a at `version` (or nothing).
const installCmd = (sentinel, version, exit = 0) =>
  `touch ${JSON.stringify(sentinel)}; echo installing a; `
  + (version ? `mkdir -p node_modules/a && printf '{"version":"${version}"}' > node_modules/a/package.json; ` : '')
  + `exit ${exit}`;

test('ensureDependencies', async (t) => {
  await t.test('in sync → { ran: false } and the command is never run', async (t) => {
    const c = checkout(t, { installed: '1.0.0' });
    assert.deepEqual(await ensureDependencies({ repoRoot: c.repo, npmCmd: installCmd(c.sentinel, '1.0.0') }), { ran: false });
    assert.equal(fs.existsSync(c.sentinel), false);
  });

  await t.test('drift in a real node_modules dir → the command runs in the repo, streams, and the re-check passes', async (t) => {
    const c = checkout(t, { installed: '0.9.0' });
    const chunks = [];
    const r = await ensureDependencies({ repoRoot: c.repo, npmCmd: installCmd(c.sentinel, '1.0.0'), onChunk: (s) => chunks.push(s) });
    assert.equal(fs.existsSync(c.sentinel), true);
    assert.deepEqual({ ran: r.ran, ok: r.ok, code: r.code }, { ran: true, ok: true, code: 0 });
    assert.match(r.tail, /installing a/);
    assert.match(chunks.join(''), /installing a/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.modules, 'a', 'package.json'), 'utf8')).version, '1.0.0');
  });

  await t.test('a missing node_modules is installed, not refused', async (t) => {
    const c = checkout(t);
    fs.rmSync(c.modules, { recursive: true });
    const r = await ensureDependencies({ repoRoot: c.repo, npmCmd: installCmd(c.sentinel, '1.0.0') });
    assert.equal(r.ok, true);
  });

  await t.test('the command exits 0 but node_modules still differs → throws naming the drift', async (t) => {
    const c = checkout(t);
    await assert.rejects(
      ensureDependencies({ repoRoot: c.repo, npmCmd: installCmd(c.sentinel, '0.5.0') }),
      (e) => {
        assert.equal(e.message, 'npm install finished but node_modules still differs: node_modules/a 0.5.0 ≠ lock 1.0.0');
        assert.equal(e.ran, true);
        assert.match(e.tail, /installing a/);
        return true;
      });
  });

  await t.test('the command exits non-zero → throws with its exit code and output tail', async (t) => {
    const c = checkout(t);
    await assert.rejects(
      ensureDependencies({ repoRoot: c.repo, npmCmd: installCmd(c.sentinel, '1.0.0', 3) }),
      (e) => {
        assert.equal(e.message, 'npm install failed (exit 3)');
        assert.equal(e.exitCode, 3);
        assert.equal(e.ran, true);
        assert.match(e.tail, /installing a/);
        return true;
      });
  });

  await t.test('drift in a symlinked node_modules → 409 DEPS_LINKED naming the reason and the target; the command never runs', async (t) => {
    const c = checkout(t, { link: true });
    await assert.rejects(
      ensureDependencies({ repoRoot: c.repo, npmCmd: installCmd(c.sentinel, '1.0.0') }),
      (e) => {
        assert.equal(e.statusCode, 409);
        assert.equal(e.code, 'DEPS_LINKED');
        assert.equal(e.ran, false);
        assert.ok(e.message.includes('node_modules/a missing'), e.message);
        assert.ok(e.message.includes(c.modules), e.message);
        return true;
      });
    assert.equal(fs.existsSync(c.sentinel), false);
    assert.deepEqual(fs.readdirSync(c.modules), [], 'the linked tree is untouched');
  });

  await t.test('a symlinked node_modules that is in sync → { ran: false }', async (t) => {
    const c = checkout(t, { link: true, installed: '1.0.0' });
    assert.deepEqual(await ensureDependencies({ repoRoot: c.repo, npmCmd: installCmd(c.sentinel, '1.0.0') }), { ran: false });
    assert.equal(fs.existsSync(c.sentinel), false);
  });
});

test('withMaintenanceLock', async (t) => {
  await t.test('a second caller while one holds it → 409 MAINTENANCE_IN_PROGRESS, its fn never runs', async () => {
    let release;
    const first = withMaintenanceLock('restart', () => new Promise((r) => { release = r; }));
    let ran = false;
    await assert.rejects(withMaintenanceLock('update', async () => { ran = true; }), (e) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.code, 'MAINTENANCE_IN_PROGRESS');
      assert.match(e.message, /^a restart or update is already in progress/);
      return true;
    });
    assert.equal(ran, false);
    release('done');
    assert.equal(await first, 'done');
  });

  await t.test('released after its fn resolves or rejects', async () => {
    assert.equal(await withMaintenanceLock('update', async () => 1), 1);
    await assert.rejects(withMaintenanceLock('restart', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await withMaintenanceLock('restart', async () => 2), 2);
  });
});
