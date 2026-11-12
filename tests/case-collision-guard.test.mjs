// Case collisions: no two repo paths, and no two module stems, may differ only
// by case. On a case-insensitive filesystem (NTFS, default APFS) the first pair
// cannot both be checked out, and the second lets an extensionless import
// resolve to the wrong file — Vite tries `.ts` before `.tsx`, so `./Foo` can
// load `foo.ts` and the build fails with MISSING_EXPORT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The extensions a module resolver tries on an extensionless specifier.
const MODULE_EXT = /\.(?:[cm]?[jt]sx?|json)$/;

// Groups of distinct keys that are equal once lowercased, each group the sorted
// original names it came from.
function caseGroups(entries) {
  const byFold = new Map();
  for (const [key, name] of entries) {
    const fold = key.toLowerCase();
    if (!byFold.has(fold)) byFold.set(fold, new Map());
    const keys = byFold.get(fold);
    if (!keys.has(key)) keys.set(key, new Set());
    keys.get(key).add(name);
  }
  return [...byFold.values()]
    .filter((keys) => keys.size > 1)
    .map((keys) => [...keys.values()].flatMap((names) => [...names]).sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// Rule A: paths of any extension, and the directories they imply, that cannot
// coexist on a case-insensitive checkout.
function pathCollisions(paths) {
  const entries = new Set(paths);
  for (const p of paths) {
    for (let d = path.posix.dirname(p); d !== '.'; d = path.posix.dirname(d)) entries.add(d);
  }
  return caseGroups([...entries].map((p) => [p, p]));
}

// Rule B: module files whose path minus its last extension differs only by case.
function moduleStemCollisions(paths) {
  return caseGroups(paths.filter((p) => MODULE_EXT.test(p)).map((p) => [p.replace(MODULE_EXT, ''), p]));
}

// Tracked plus untracked-but-not-ignored files, so a new colliding file reds
// before its commit.
function repoPaths(dir) {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir, encoding: 'utf8' })
    .split('\0').filter(Boolean);
}

test('rule B flags a component and a helper whose stems differ only by case', () => {
  assert.deepEqual(moduleStemCollisions(['fx/conv/JsonTree.tsx', 'fx/conv/jsonTree.ts']),
    [['fx/conv/JsonTree.tsx', 'fx/conv/jsonTree.ts']]);
});

test('rule B flags test files too', () => {
  assert.deepEqual(moduleStemCollisions(['fx/a/Foo.test.ts', 'fx/a/foo.test.tsx']),
    [['fx/a/Foo.test.ts', 'fx/a/foo.test.tsx']]);
});

test('rule B leaves distinct stems and non-module extensions alone', async (t) => {
  const rows = {
    'a renamed component beside its helper and its test': ['fx/conv/JsonTreeView.tsx', 'fx/conv/jsonTree.ts', 'fx/conv/jsonTree.test.ts'],
    'a non-module extension': ['fx/a/Foo.css', 'fx/a/foo.ts'],
    'different directories': ['fx/x/Foo.ts', 'fx/y/foo.ts'],
    'one stem, two extensions, same case': ['fx/a/foo.ts', 'fx/a/foo.tsx'],
  };
  for (const [name, paths] of Object.entries(rows)) {
    await t.test(name, () => assert.deepEqual(moduleStemCollisions(paths), []));
  }
});

test('rule A flags full paths and implied directories that differ only by case', async (t) => {
  await t.test('two files', () => {
    assert.deepEqual(pathCollisions(['fx/README.md', 'fx/readme.md']), [['fx/README.md', 'fx/readme.md']]);
  });
  await t.test('two directories', () => {
    assert.deepEqual(pathCollisions(['fx/Docs/a.md', 'fx/docs/b.md']), [['fx/Docs', 'fx/docs']]);
  });
});

test('repoPaths lists tracked and untracked files, not ignored ones', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-case-collision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(path.join(dir, 'JsonTree.tsx'), '');
  writeFileSync(path.join(dir, 'jsonTree.ts'), '');
  writeFileSync(path.join(dir, '.gitignore'), 'ignored.ts\n');
  writeFileSync(path.join(dir, 'ignored.ts'), '');
  git('add', 'JsonTree.tsx');

  const paths = repoPaths(dir);
  assert.ok(!paths.includes('ignored.ts'), 'an ignored file is not listed');
  assert.deepEqual(moduleStemCollisions(paths), [['JsonTree.tsx', 'jsonTree.ts']]);
});

test('the repo has no case collisions', () => {
  const paths = repoPaths(root);
  assert.deepEqual(pathCollisions(paths), []);
  assert.deepEqual(moduleStemCollisions(paths), []);
  assert.ok(paths.includes('package.json'), 'the listing is the real tree, not empty');
});
