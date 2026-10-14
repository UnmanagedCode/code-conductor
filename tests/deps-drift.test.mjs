// dependencyDrift (src/depsDrift.ts): whether node_modules on disk satisfies
// package.json. One subtest per rule row, each on its own fixture tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyDrift, isSupportedRange } from '../src/depsDrift.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deps-drift-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Writes `installed` (repo-relative package dir → its package.json fields; a
// bare string is the version) under `dir`.
function install(dir, installed) {
  for (const [rel, m] of Object.entries(installed)) {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
    const manifest = typeof m === 'string' ? { version: m } : m;
    fs.writeFileSync(path.join(dir, rel, 'package.json'), JSON.stringify({ name: path.basename(rel), ...manifest }));
  }
}

// A checkout whose root package.json is `pkg` and whose node_modules holds `installed`.
function tree(t, pkg, installed) {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', ...pkg }));
  install(dir, installed);
  return dir;
}

test('dependencyDrift', async (t) => {
  await t.test('every root installed inside its range → null', (t) => {
    const dir = tree(t,
      { dependencies: { a: '^1.0.0', '@s/b': '~2.0.0' } },
      { 'node_modules/a': '1.4.0', 'node_modules/@s/b': '2.0.9' });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a root missing on disk → the reason names it', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0', vite: '^8.0.0' } }, { 'node_modules/a': '1.0.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/vite missing' });
  });

  await t.test('a directory with no package.json in it (an interrupted install) is missing', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, {});
    fs.mkdirSync(path.join(dir, 'node_modules', 'a'), { recursive: true });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/a missing' });
  });

  await t.test('a root outside its range → the reason names the version and the range', async (t) => {
    const rows = [
      ['^1.2.3', '1.2.2'], ['^1.2.3', '2.0.0'],
      ['~1.2.3', '1.3.0'], ['~1.2.3', '1.2.2'],
      ['1.2.3', '1.2.4'],
      ['>=1.2.3', '1.2.2'],
      ['^0.7.1', '0.8.0'], ['^0.7.1', '0.7.0'], ['^0.7.1', '1.7.9'],
      ['^0.0.3', '0.0.4'],
      ['^1.2.3', '1.3.0-beta.1'], ['>=1.0.0', '2.0.0-rc.1'],
    ];
    for (const [range, version] of rows) {
      await t.test(`${version} vs ${range}`, (t) => {
        const dir = tree(t, { dependencies: { r: range } }, { 'node_modules/r': version });
        assert.deepEqual(dependencyDrift(dir), { reason: `node_modules/r ${version} does not satisfy ${range}` });
      });
    }
  });

  await t.test('a root inside its range → null', async (t) => {
    const rows = [
      ['^1.2.3', '1.2.3'], ['^1.2.3', '1.9.0'],
      ['~1.2.3', '1.2.9'],
      ['1.2.3', '1.2.3'],
      ['>=1.2.3', '3.0.0'],
      ['^0.7.1', '0.7.9'],
      ['^0.0.3', '0.0.3'],
      ['^1.2.3', '1.2.4+build.5'],
    ];
    for (const [range, version] of rows) {
      await t.test(`${version} vs ${range}`, (t) => {
        const dir = tree(t, { dependencies: { r: range } }, { 'node_modules/r': version });
        assert.equal(dependencyDrift(dir), null);
      });
    }
  });

  await t.test('a range edit the installed version still satisfies → null', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, { 'node_modules/a': '1.5.0' });
    assert.equal(dependencyDrift(dir), null);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '^1.5.0' } }));
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a range outside the supported grammar → drift naming it', (t) => {
    const dir = tree(t, { dependencies: { a: '1.x', b: '^1.0.0' } }, { 'node_modules/a': '1.0.0', 'node_modules/b': '1.0.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'package.json range for a ("1.x") is not supported' });
  });

  await t.test('an optional root absent on disk → null', (t) => {
    const dir = tree(t,
      { dependencies: { a: '^1.0.0' }, optionalDependencies: { fsevents: '^2.0.0' } },
      { 'node_modules/a': '1.0.0' });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a missing root named like an Object.prototype member is missing, not an absent optional', async (t) => {
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      await t.test(name, (t) => {
        const dir = tmp(t);
        // Raw JSON: an object literal's `__proto__` key would set the prototype instead.
        fs.writeFileSync(path.join(dir, 'package.json'), `{"name":"x","dependencies":{"${name}":"^1.0.0"}}`);
        fs.mkdirSync(path.join(dir, 'node_modules'));
        assert.deepEqual(dependencyDrift(dir), { reason: `node_modules/${name} missing` });
      });
    }
  });

  await t.test('an optional root present outside its range is still drift', (t) => {
    const dir = tree(t, { optionalDependencies: { o: '^1.0.0' } }, { 'node_modules/o': '0.9.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/o 0.9.0 does not satisfy ^1.0.0' });
  });

  await t.test('dev roots missing with no dev root on disk (an --omit=dev install) → null', (t) => {
    const dir = tree(t,
      { dependencies: { a: '^1.0.0' }, devDependencies: { vitest: '^5.0.0', typescript: '^7.0.0' } },
      { 'node_modules/a': '1.0.0' });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a dev root the prod graph reaches (an optional peer) does not make an --omit=dev install a full one', (t) => {
    const dir = tree(t,
      { dependencies: { radix: '^1.0.0' }, devDependencies: { '@types/react': '^19.0.0', vitest: '^5.0.0' } },
      {
        'node_modules/radix': { version: '1.0.0', peerDependencies: { '@types/react': '*' } },
        'node_modules/@types/react': '19.0.0',
      });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a dev root missing while another dev root is on disk (a full install) → drift', (t) => {
    const dir = tree(t,
      { dependencies: { a: '^1.0.0' }, devDependencies: { vitest: '^5.0.0', typescript: '^7.0.0' } },
      { 'node_modules/a': '1.0.0', 'node_modules/vitest': '5.0.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/typescript missing' });
  });

  await t.test('a dev root outside its range on a full install → drift', (t) => {
    const dir = tree(t, { devDependencies: { vitest: '^5.0.3' } }, { 'node_modules/vitest': '5.0.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/vitest 5.0.0 does not satisfy ^5.0.3' });
  });

  await t.test("a dev root's transitive dependency missing on a full install → drift", (t) => {
    const dir = tree(t,
      { devDependencies: { vitest: '^5.0.0' } },
      { 'node_modules/vitest': { version: '5.0.0', dependencies: { tinypool: '^1.0.0' } } });
    assert.deepEqual(dependencyDrift(dir), { reason: 'tinypool missing, required by node_modules/vitest' });
  });

  await t.test('a transitive dependency resolves nested or hoisted; missing from both → drift', (t) => {
    const pkg = { dependencies: { a: '^1.0.0' } };
    const a = { version: '1.0.0', dependencies: { b: '^3.0.0' } };
    const nested = tree(t, pkg, { 'node_modules/a': a, 'node_modules/a/node_modules/b': '3.0.0' });
    assert.equal(dependencyDrift(nested), null);
    const hoisted = tree(t, pkg, { 'node_modules/a': a, 'node_modules/b': '3.0.0' });
    assert.equal(dependencyDrift(hoisted), null);
    const missing = tree(t, pkg, { 'node_modules/a': a });
    assert.deepEqual(dependencyDrift(missing), { reason: 'b missing, required by node_modules/a' });
  });

  await t.test("a nested package's dependency resolves from an ancestor node_modules", (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, {
      'node_modules/a': { version: '1.0.0', dependencies: { b: '*' } },
      'node_modules/a/node_modules/b': { version: '1.0.0', dependencies: { c: '*' } },
      'node_modules/c': '1.0.0',
    });
    assert.equal(dependencyDrift(dir), null);
    fs.rmSync(path.join(dir, 'node_modules', 'c'), { recursive: true });
    assert.deepEqual(dependencyDrift(dir), { reason: 'c missing, required by node_modules/a/node_modules/b' });
  });

  await t.test('a transitive dependency is checked for existence only, not its range', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, {
      'node_modules/a': { version: '1.0.0', dependencies: { b: '^3.0.0' } },
      'node_modules/b': '1.0.0',
    });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a missing transitive optional dependency (another platform\'s binding) → null', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, {
      'node_modules/a': { version: '1.0.0', dependencies: { '@x/win32': '1.0.0' }, optionalDependencies: { '@x/win32': '1.0.0', '@x/linux': '1.0.0' } },
    });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a missing peer dependency is not required', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, {
      'node_modules/a': { version: '1.0.0', peerDependencies: { react: '^19.0.0' } },
    });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a top-level package nothing reaches (a removed dependency) is extraneous', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, {
      'node_modules/a': '1.0.0', 'node_modules/sonner': '2.0.0', 'node_modules/@s/gone': '1.0.0',
    });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/@s/gone is extraneous' });
    fs.rmSync(path.join(dir, 'node_modules', '@s'), { recursive: true });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/sonner is extraneous' });
  });

  await t.test('a package reached only as a present peer or optional dependency is not extraneous', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, {
      'node_modules/a': { version: '1.0.0', peerDependencies: { p: '*' }, optionalDependencies: { o: '*' } },
      'node_modules/p': { version: '1.0.0', dependencies: { q: '*' } },
      'node_modules/q': '1.0.0',
      'node_modules/o': '1.0.0',
    });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('dot-entries, symlinked entries and directories without a package.json are not extraneous', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, {
      'node_modules/a': '1.0.0', 'node_modules/.vite': '0.0.0', 'node_modules/@s/.cache': '0.0.0',
    });
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'));
    fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}');
    fs.mkdirSync(path.join(dir, 'node_modules', 'leftover-dir'));
    install(dir, { 'workspace-pkg': '1.0.0' });
    fs.symlinkSync(path.join(dir, 'workspace-pkg'), path.join(dir, 'node_modules', 'workspace-pkg'), 'dir');
    fs.symlinkSync(path.join(dir, 'workspace-pkg'), path.join(dir, 'node_modules', '@s', 'linked'), 'dir');
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a dependency cycle terminates', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, {
      'node_modules/a': { version: '1.0.0', dependencies: { b: '*' } },
      'node_modules/b': { version: '1.0.0', dependencies: { a: '*' } },
    });
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('the first offender wins: roots, then transitive, then extraneous', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0', b: '^1.0.0' } }, {
      'node_modules/a': { version: '1.0.0', dependencies: { gone: '*' } },
      'node_modules/stray': '1.0.0',
    });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/b missing' });
    install(dir, { 'node_modules/b': '1.0.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'gone missing, required by node_modules/a' });
    install(dir, { 'node_modules/gone': '1.0.0' });
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/stray is extraneous' });
  });

  await t.test('no package.json → null (nothing is declared)', (t) => {
    assert.equal(dependencyDrift(tmp(t)), null);
  });

  await t.test('an unparseable package.json → drift naming it', (t) => {
    const dir = tmp(t);
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
    assert.match(dependencyDrift(dir)?.reason ?? '', /^package\.json is unreadable: /);
  });

  await t.test('a package-lock.json that disagrees with the tree is never read', (t) => {
    const dir = tree(t, { dependencies: { a: '^1.0.0' } }, { 'node_modules/a': '1.2.0' });
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '9.9.9' }, 'node_modules/missing': { version: '1.0.0' } },
    }));
    assert.equal(dependencyDrift(dir), null);
  });

  await t.test('a symlinked node_modules is read through the link', (t) => {
    const shared = tree(t, {}, { 'node_modules/a': '1.0.0' });
    const dir = tree(t, { dependencies: { a: '^1.0.0', b: '^1.0.0' } }, {});
    fs.symlinkSync(path.join(shared, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    assert.deepEqual(dependencyDrift(dir), { reason: 'node_modules/b missing' });
    install(shared, { 'node_modules/b': '1.0.0' });
    assert.equal(dependencyDrift(dir), null);
  });
});

test("cc's own package.json uses only the supported range grammar", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const ranges = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.devDependencies };
  assert.ok(Object.keys(ranges).length > 0, 'fixture check: package.json declares dependencies');
  assert.deepEqual(Object.entries(ranges).filter(([, r]) => !isSupportedRange(r)), []);
});
