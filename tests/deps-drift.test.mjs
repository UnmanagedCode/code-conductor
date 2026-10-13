// dependencyDrift (src/depsDrift.ts): whether node_modules on disk matches
// package-lock.json. One subtest per rule row, each on its own fixture tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dependencyDrift } from '../src/depsDrift.ts';

// A checkout whose lock lists `packages` (key → lock entry) and whose
// node_modules holds `installed` (key → version on disk).
function tree(t, packages, installed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deps-drift-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages },
  }));
  for (const [key, version] of Object.entries(installed)) {
    fs.mkdirSync(path.join(dir, key), { recursive: true });
    fs.writeFileSync(path.join(dir, key, 'package.json'), JSON.stringify({ name: path.basename(key), version }));
  }
  return dir;
}

test('dependencyDrift', async (t) => {
  await t.test('every locked package installed at its locked version → null', (t) => {
    const dir = tree(t,
      { 'node_modules/a': { version: '1.0.0' }, 'node_modules/@s/b': { version: '2.0.0' } },
      { 'node_modules/a': '1.0.0', 'node_modules/@s/b': '2.0.0' });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a non-optional package missing on disk → the reason names it', (t) => {
    const dir = tree(t,
      { 'node_modules/a': { version: '1.0.0' }, 'node_modules/vite': { version: '8.0.0' } },
      { 'node_modules/a': '1.0.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/vite missing' });
  });

  await t.test('a directory with no package.json in it (an interrupted install) is missing', (t) => {
    const dir = tree(t, { 'node_modules/a': { version: '1.0.0' } }, {});
    fs.mkdirSync(path.join(dir, 'node_modules', 'a'), { recursive: true });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/a missing' });
  });

  await t.test('an installed version other than the locked one → the reason names both', (t) => {
    const dir = tree(t, { 'node_modules/react': { version: '19.3.0' } }, { 'node_modules/react': '19.2.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/react 19.2.0 ≠ lock 19.3.0' });
  });

  await t.test('an optional or devOptional package absent on disk → null', (t) => {
    const dir = tree(t, {
      'node_modules/a': { version: '1.0.0' },
      'node_modules/@esbuild/win32-x64': { version: '0.1.0', optional: true },
      'node_modules/fsevents': { version: '2.0.0', devOptional: true },
    }, { 'node_modules/a': '1.0.0' });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('an optional package installed at another version is still drift', (t) => {
    const dir = tree(t, { 'node_modules/o': { version: '1.0.0', optional: true } }, { 'node_modules/o': '0.9.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/o 0.9.0 ≠ lock 1.0.0' });
  });

  await t.test('dev packages missing with no dev package on disk (an --omit=dev install) → null', (t) => {
    const dir = tree(t, {
      'node_modules/a': { version: '1.0.0' },
      'node_modules/vitest': { version: '5.0.0', dev: true },
      'node_modules/typescript': { version: '7.0.0', dev: true },
    }, { 'node_modules/a': '1.0.0' });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a dev package missing while another dev package is on disk (a full install) → drift', (t) => {
    const dir = tree(t, {
      'node_modules/a': { version: '1.0.0' },
      'node_modules/vitest': { version: '5.0.0', dev: true },
      'node_modules/typescript': { version: '7.0.0', dev: true },
    }, { 'node_modules/a': '1.0.0', 'node_modules/vitest': '5.0.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/typescript missing' });
  });

  await t.test('a dev package at another version on a full install → drift', (t) => {
    const dir = tree(t, { 'node_modules/vitest': { version: '5.0.3', dev: true } }, { 'node_modules/vitest': '5.0.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/vitest 5.0.0 ≠ lock 5.0.3' });
  });

  await t.test('a nested node_modules entry is checked at its own path', (t) => {
    const lock = { 'node_modules/a': { version: '1.0.0' }, 'node_modules/a/node_modules/b': { version: '3.0.0' } };
    const ok = tree(t, lock, { 'node_modules/a': '1.0.0', 'node_modules/a/node_modules/b': '3.0.0' });
    assert.equal(dependencyDrift(ok), null);
    const hoistedOnly = tree(t, lock, { 'node_modules/a': '1.0.0', 'node_modules/b': '3.0.0' });
    assert.deepEqual(dependencyDrift(hoistedOnly), { reason: 'node_modules/a/node_modules/b missing' });
  });

  await t.test('link and inBundle entries are skipped', (t) => {
    const dir = tree(t, {
      'node_modules/a': { version: '1.0.0' },
      'node_modules/local-pkg': { resolved: 'packages/local-pkg', link: true },
      'node_modules/a/node_modules/bundled': { version: '1.0.0', inBundle: true },
    }, { 'node_modules/a': '1.0.0' });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('entries outside node_modules (the root, workspace folders) are not checked', (t) => {
    const dir = tree(t, { 'packages/local-pkg': { version: '1.0.0' } }, {});
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('extraneous packages on disk are ignored', (t) => {
    const dir = tree(t, { 'node_modules/a': { version: '1.0.0' } }, { 'node_modules/a': '1.0.0', 'node_modules/stray': '9.9.9' });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('the first offender in lock order is the one named', (t) => {
    const dir = tree(t, { 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '1.0.0' } }, {});
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/a missing' });
  });

  await t.test('no package-lock.json → null (nothing is pinned)', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deps-drift-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('an unparseable package-lock.json → drift naming it', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deps-drift-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{ not json');
    assert.match(dependencyDrift(dir)?.reason ?? '', /^package-lock\.json is unreadable: /);
  });
});
