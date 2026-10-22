// src/serverImports.ts: the files the running server's code reaches through
// its imports, from server.ts and every src/ file, transitively, resolved the
// way Node resolves them (exact paths). A site it cannot resolve makes the
// whole walk unknown, which src/webPostMerge.ts reads as "may be loaded".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp } from './tmpRegistry.mjs';
import { serverImportsAt, walkServerImports } from '../src/serverImports.ts';
import { localSystem } from '../src/systems/registry.ts';

const REPO = path.resolve(import.meta.dirname, '..');

// A tree from { path: text }; extra paths exist with no text.
const walk = (tree, extra = []) =>
  walkServerImports(new Set([...Object.keys(tree), ...extra]), new Map(Object.entries(tree)));
const chainsOf = (r) => {
  assert.ok('chains' in r, `walk is unknown: ${r.unknown}`);
  return r.chains;
};

test('walk: a shared/ module src/ imports is reached; one only web/ imports is not', () => {
  const c = chainsOf(walk({
    'src/a.ts': "import { p } from '../shared/p.ts';\n",
    'web/src/v.tsx': "import { q } from '@shared/q.ts';\n",
    'shared/p.ts': 'export const p = 1;\n',
    'shared/q.ts': 'export const q = 1;\n',
  }));
  assert.deepEqual(c.get('shared/p.ts'), ['src/a.ts', 'shared/p.ts']);
  assert.equal(c.has('shared/q.ts'), false);
});

test('walk: shared/ → shared/ edges are followed, and the chain names each hop', () => {
  const c = chainsOf(walk({
    'src/a.ts': "import { p } from '../shared/p.ts';\n",
    'shared/p.ts': "import { r } from './r.ts';\nexport const p = r;\n",
    'shared/r.ts': 'export const r = 1;\n',
  }));
  assert.deepEqual(c.get('shared/r.ts'), ['src/a.ts', 'shared/p.ts', 'shared/r.ts']);
});

test('walk: server.ts is a root, and edges are followed through any directory (migrations/)', () => {
  const c = chainsOf(walk({
    'server.ts': "import { run } from './migrations/index.mjs';\n",
    'migrations/index.mjs': "import * as m from './0001-x.mjs';\n",
    'migrations/0001-x.mjs': "import { s } from '../shared/s.ts';\n",
    'shared/s.ts': 'export const s = 1;\n',
  }));
  assert.deepEqual(c.get('shared/s.ts'), ['server.ts', 'migrations/index.mjs', 'migrations/0001-x.mjs', 'shared/s.ts']);
});

test('walk: every import form is an edge', async (t) => {
  for (const [form, text, target] of [
    ['import type', "import type { T } from '../shared/t.ts';\n", 'shared/t.ts'],
    ['multi-line import', "import {\n  a,\n} from '../shared/m.ts';\n", 'shared/m.ts'],
    ['export * from', "export * from '../shared/e.ts';\n", 'shared/e.ts'],
    ['bare import', "import '../shared/side.ts';\n", 'shared/side.ts'],
    ['dynamic import of a literal', "const m = await import('../shared/dyn.ts');\n", 'shared/dyn.ts'],
  ]) {
    await t.test(form, () => {
      const c = chainsOf(walk({ 'src/a.ts': text }, [target]));
      assert.deepEqual(c.get(target), ['src/a.ts', target]);
    });
  }
});

test('walk: comment lines are not imports', () => {
  const c = chainsOf(walk({
    'src/a.ts': [
      "// import { x } from '../shared/c.ts';",
      '// CLAUDE.md import (materialized by the conduct writer)',
      "/* import '../shared/c.ts' */",
      " * import('../shared/c.ts') and import(name)",
      'export const a = 1;',
    ].join('\n'),
  }, ['shared/c.ts']));
  assert.equal(c.has('shared/c.ts'), false);
});

test('walk: a site it cannot resolve makes the walk unknown, naming the file', async (t) => {
  for (const [site, text] of [
    ['dynamic import of a name', 'const m = await import(name);\n'],
    ['dynamic import of a template literal', 'const m = await import(`../shared/${n}.ts`);\n'],
    ['dynamic import with its argument on a later line', 'const m = await import(\n  \'../shared/x.ts\'\n);\n'],
    ['require', "const x = require('../shared/x.ts');\n"],
    ['the @shared alias', "import { x } from '@shared/x.ts';\n"],
    ['a .js specifier for a .ts file', "import { x } from '../shared/x.js';\n"],
    ['a specifier naming no file', "import { x } from '../shared/missing.ts';\n"],
    ['an absolute path', "import { x } from '/shared/x.ts';\n"],
    ['a file: URL', "import { x } from 'file:///shared/x.ts';\n"],
    ['a # subpath import', "import { x } from '#shared/x';\n"],
  ]) {
    await t.test(site, () => {
      const r = walk({ 'src/a.ts': text }, ['shared/x.ts']);
      assert.ok('unknown' in r, `expected unknown, got chains ${JSON.stringify([...(r.chains ?? new Map()).keys()])}`);
      assert.match(r.unknown, /src\/a\.ts/);
      const line = text.split('\n')[0].trim();
      assert.ok(r.unknown.includes(line), `${JSON.stringify(r.unknown)} names the line ${JSON.stringify(line)}`);
    });
  }
});

test('walk: bare package names and node: builtins are not edges and do not make the walk unknown', () => {
  const c = chainsOf(walk({
    'src/a.ts': "import fs from 'node:fs';\nimport express from 'express';\nimport { z } from '@scope/pkg/sub';\n",
  }));
  assert.deepEqual([...c.keys()], ['src/a.ts']);
});

test('walk: an unresolvable site in a file the server does not reach is ignored', () => {
  const c = chainsOf(walk({
    'src/a.ts': 'export const a = 1;\n',
    'tests/t.mjs': "const x = require(x);\nconst y = await import(y);\nimport { z } from '@shared/z.ts';\n",
  }));
  assert.equal(c.has('tests/t.mjs'), false);
});

test('walk: a tests/ file the server imports is reached', () => {
  const c = chainsOf(walk({ 'src/a.ts': "import { h } from '../tests/helper.mjs';\n" }, ['tests/helper.mjs']));
  assert.deepEqual(c.get('tests/helper.mjs'), ['src/a.ts', 'tests/helper.mjs']);
});

// ── Read from a commit ─────────────────────────────────────────────────────

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout.trim());
    });
  });
}

async function repo() {
  const root = await fs.realpath(await mkdtemp('cc-serverimports-'));
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'test');
  await git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}
async function commit(root, files) {
  for (const [f, text] of Object.entries(files)) {
    await fs.mkdir(path.join(root, path.dirname(f)), { recursive: true });
    await fs.writeFile(path.join(root, f), text);
  }
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'edit');
  return git(root, 'rev-parse', 'HEAD');
}

test('serverImportsAt reads the named commit, not the working tree or HEAD', async () => {
  const root = await repo();
  const a = await commit(root, {
    'src/a.ts': "import { p } from '../shared/p.ts';\n",
    'shared/p.ts': 'export const p = 1;\n',
    'shared/q.ts': 'export const q = 1;\n',
  });
  const b = await commit(root, { 'src/a.ts': "import { p } from '../shared/p.ts';\nimport { q } from '../shared/q.ts';\n" });
  const atA = chainsOf(await serverImportsAt(root, a));
  assert.deepEqual(atA.get('shared/p.ts'), ['src/a.ts', 'shared/p.ts']);
  assert.equal(atA.has('shared/q.ts'), false);
  assert.deepEqual(chainsOf(await serverImportsAt(root, b)).get('shared/q.ts'), ['src/a.ts', 'shared/q.ts']);
});

test('serverImportsAt keeps every import line of a file, not only its last', async () => {
  const root = await repo();
  const sha = await commit(root, {
    'src/a.ts': "import { p } from '../shared/p.ts';\nexport const a = 1;\nimport { q } from '../shared/q.ts';\n",
    'shared/p.ts': 'export const p = 1;\n',
    'shared/q.ts': 'export const q = 1;\n',
  });
  const c = chainsOf(await serverImportsAt(root, sha));
  assert.deepEqual(c.get('shared/p.ts'), ['src/a.ts', 'shared/p.ts'], 'the earlier import');
  assert.deepEqual(c.get('shared/q.ts'), ['src/a.ts', 'shared/q.ts'], 'the later import');
});

test('serverImportsAt: a tree with no line git grep matches is a walk with no edges, not a failure', async () => {
  const root = await repo();
  const sha = await commit(root, { 'src/a.ts': 'export const a = 1;\n', 'shared/p.ts': 'export const p = 1;\n' });
  const c = chainsOf(await serverImportsAt(root, sha));
  assert.equal(c.has('shared/p.ts'), false);
});

test('serverImportsAt: a commit git cannot read makes the walk unknown', async () => {
  const root = await repo();
  await commit(root, { 'src/a.ts': 'export const a = 1;\n' });
  const r = await serverImportsAt(root, 'f'.repeat(40));
  assert.ok('unknown' in r);
});

// The local system, with git grep's exec answered by `grep(cmd, opts, local)`.
const withGrep = (grep) => {
  const local = localSystem();
  return Object.create(local, {
    exec: { value: (cmd, opts) => (cmd.argv.includes('grep') ? grep(cmd, opts, local) : local.exec(cmd, opts)) },
  });
};
const execResult = (o) => ({ code: 0, stdout: '', stderr: '', output: '', timedOut: false, truncated: false, durationMs: 0, spawnError: null, ...o });

test('serverImportsAt: a git grep killed for overflowing its output fence makes the walk unknown, not edgeless', async () => {
  const root = await repo();
  const sha = await commit(root, {
    'src/a.ts': "import { x } from '../shared/x.ts';\n",
    'shared/x.ts': 'export const x = 1;\n',
    'big.ts': "import a from 'pkg';\n".repeat(2000),
  });
  assert.ok(chainsOf(await serverImportsAt(root, sha)).has('shared/x.ts'), 'premise: unfenced, the walk reaches shared/x.ts');
  const r = await serverImportsAt(root, sha, withGrep((cmd, opts, local) => local.exec(cmd, { ...opts, maxBufferBytes: 4096 })));
  assert.ok('unknown' in r, `expected unknown, got chains ${JSON.stringify([...(r.chains ?? new Map()).keys()])}`);
});

test('serverImportsAt: a git grep exit 1 that carries a diagnostic (a spawn error) makes the walk unknown', async () => {
  const root = await repo();
  const sha = await commit(root, { 'src/a.ts': "import { x } from '../shared/x.ts';\n", 'shared/x.ts': 'export const x = 1;\n' });
  const r = await serverImportsAt(root, sha, withGrep(async () => execResult({ code: 1, spawnError: 'spawn git ENOENT' })));
  assert.ok('unknown' in r, `expected unknown, got chains ${JSON.stringify([...(r.chains ?? new Map()).keys()])}`);
});

test('serverImportsAt: a git grep that times out rejects (runGit\'s GIT_TIMED_OUT) rather than reading as a walk', async () => {
  const root = await repo();
  const sha = await commit(root, { 'src/a.ts': 'export const a = 1;\n' });
  await assert.rejects(
    () => serverImportsAt(root, sha, withGrep(async () => execResult({ code: 124, timedOut: true }))),
    { code: 'GIT_TIMED_OUT' },
  );
});

// Depends on this checkout's .git, like plugins-supervisor's HEAD test.
test('serverImportsAt: cc\'s own server code has no site the walk cannot resolve', async () => {
  const c = chainsOf(await serverImportsAt(REPO, 'HEAD'));
  assert.ok(c.has('shared/uiEvent.ts'), 'src/ imports shared/uiEvent.ts');
});
