// `npm test -- --changed` scoping (tests/changedScope.mjs): which suites and
// typecheck halves a changed path selects (classifyChanged over a hand-built
// reach), what buildReach counts as reached over a fixture tree, what
// changedPaths reports from a temp git repo, and pins on the real tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildReach, changedPaths, classifyChanged, WALKS_REVIEWED } from './changedScope.mjs';
import { mkdtempSync } from './tmpRegistry.mjs';

const REPO = path.resolve(import.meta.dirname, '..');

const side = ({ files = [], text = '', walked = [] } = {}) => ({ files: new Set(files), text, walked: new Set(walked) });
const reachOf = (node, web) => ({ node: side(node), web: side(web), stale: [] });
const classify = (p, reach) => classifyChanged([p], reach).why[0];
const suitesOf = (p, reach) => classify(p, reach).suites;

test('classifyChanged: the rows', async (t) => {
  const empty = reachOf();

  await t.test('toolchain files select both suites', () => {
    for (const p of ['package.json', 'package-lock.json', 'tsconfig.json', 'web/tsconfig.bridge.json', 'web/e2e/tsconfig.json']) {
      assert.deepEqual(suitesOf(p, empty), ['node', 'web'], p);
      assert.deepEqual(classify(p, empty).rows, [1], p);
    }
  });

  await t.test('shared/ selects both suites', () => {
    assert.deepEqual(suitesOf('shared/x.ts', empty), ['node', 'web']);
    assert.deepEqual(classify('shared/x.ts', empty).rows, [2]);
  });

  await t.test('a file in the node closure only selects node', () => {
    const r = reachOf({ files: ['src/a.ts'] });
    assert.deepEqual(suitesOf('src/a.ts', r), ['node']);
    assert.deepEqual(classify('src/a.ts', r).rows, [3]);
  });

  await t.test('a file in the web closure only selects web', () => {
    assert.deepEqual(suitesOf('web/src/b.ts', reachOf({}, { files: ['web/src/b.ts'] })), ['web']);
  });

  await t.test('a file in both closures selects both', () => {
    assert.deepEqual(suitesOf('src/c.ts', reachOf({ files: ['src/c.ts'] }, { files: ['src/c.ts'] })), ['node', 'web']);
  });

  await t.test('a basename named in a closure\'s text selects that suite', () => {
    const r = reachOf({ text: "readFileSync(path.join(ROOT, 'web', 'src', 'index.css'))" }, { files: ['web/src/index.css'] });
    assert.deepEqual(suitesOf('web/src/index.css', r), ['node', 'web']);
    assert.deepEqual(classify('web/src/index.css', r).rows, [3, 4]);
    assert.deepEqual(suitesOf('docs/x.md', reachOf({ text: "fs.readFileSync('docs/x.md')" })), ['node']);
  });

  await t.test('the basename match is boundary-matched on both sides', () => {
    const r = reachOf({ text: "import './openapi.ts'; import './api.tsx';" }, { files: ['src/api.ts'] });
    assert.deepEqual(suitesOf('src/api.ts', r), ['web']);
  });

  await t.test('a file under a walked root selects that suite, even in the other suite\'s closure', () => {
    const r = reachOf({ walked: ['web/lint'] }, { files: ['web/lint/rule.ts', 'web/linter/x.ts'] });
    assert.deepEqual(suitesOf('web/lint/rule.ts', r), ['node', 'web']);
    assert.deepEqual(classify('web/lint/rule.ts', r).rows, [3, 5]);
    assert.deepEqual(suitesOf('web/lint', r), ['node'], 'the walked root itself is under it');
    assert.deepEqual(suitesOf('web/linter/x.ts', r), ['web'], 'a walked root covers its own subtree, not a sibling sharing its prefix');
  });

  await t.test('an unnamed or deleted path selects both, as unclassified', () => {
    const r = reachOf({ files: ['src/a.ts'] }, { files: ['web/src/b.ts'] });
    assert.deepEqual(classify('src/gone.ts', r), { path: 'src/gone.ts', suites: ['node', 'web'], rows: [6] });
  });

  await t.test('a mixed list selects the union', () => {
    const r = reachOf({ files: ['src/a.ts'] }, { files: ['web/src/b.ts'] });
    const c = classifyChanged(['src/a.ts', 'web/src/b.ts'], r);
    assert.deepEqual([...c.suites].sort(), ['node', 'web']);
    assert.deepEqual(c.why.map((w) => w.suites), [['node'], ['web']]);
    assert.deepEqual([...classifyChanged(['src/a.ts'], r).suites], ['node']);
  });
});

test('classifyChanged: the typecheck halves', async (t) => {
  const halves = (paths, reach) => [...classifyChanged(paths, reach).halves].sort();

  await t.test('web-only paths that select web take the web half', () => {
    assert.deepEqual(halves(['web/src/b.ts'], reachOf({}, { files: ['web/src/b.ts'] })), ['web']);
  });

  await t.test('a web path that also selects node adds the node half', () => {
    const r = reachOf({ text: "path.join('web', 'src', 'index.css')" }, { files: ['web/src/index.css'] });
    assert.deepEqual(halves(['web/src/index.css'], r), ['node', 'web']);
  });

  await t.test('tests/-only paths take the node half', () => {
    assert.deepEqual(halves(['tests/x.test.mjs'], reachOf({ files: ['tests/x.test.mjs'] })), ['node']);
  });

  await t.test('a path outside web/ and tests/ takes both halves', () => {
    const r = reachOf({ files: ['src/a.ts', 'tests/x.test.mjs'] });
    assert.deepEqual([...classifyChanged(['src/a.ts'], r).suites], ['node']);
    assert.deepEqual(halves(['src/a.ts'], r), ['node', 'web']);
    assert.deepEqual(halves(['tests/x.test.mjs', 'src/a.ts'], r), ['node', 'web']);
  });
});

// A tree under a fresh temp dir; `files` maps repo-relative paths to contents.
function fixtureTree(files) {
  const root = mkdtempSync('cc-changed-scope-');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

test('buildReach over a fixture tree', async (t) => {
  const root = fixtureTree({
    'tests/a.test.mjs': [
      "import { h } from './helper.mjs';",
      "import '../src/side.ts';",
      "export { r } from '../src/reexp.ts';",
      "import q from '../src/q.ts?raw';",
      "import fs from 'node:fs';",
      "import pkg from 'somepkg';",
      "import { w } from '../shared/walk.ts';",
      "const m = await import('../src/dyn.ts');",
      "spawn(process.execPath, [path.join(ROOT, 'bin', 'x.mjs')]);",
      "execFileSync(process.execPath, ['../bin/lit.mjs']);",
      "// spawn(process.execPath, [path.join(ROOT, 'bin', 'commented.mjs')]);",
      '/* node bin/blocked.mjs: "bin/blocked.mjs" */',
    ].join('\n'),
    'tests/helper.mjs': 'export const h = 1;',
    'tests/namer.test.mjs': "const d = path.join(ROOT, 'web', 'other'); // readdirSync(d)",
    'tests/sub/w.mjs': 'fs.readdirSync(import.meta.dirname);',
    'tests/node_modules/evil.test.mjs': 'export {};',
    'src/side.ts': '', 'src/reexp.ts': '', 'src/q.ts': '', 'src/dyn.ts': '', 'src/unreached.ts': '',
    'bin/x.mjs': "import './y.mjs';\nconst sib = path.join(import.meta.dirname, 'z.mjs');",
    'bin/y.mjs': '', 'bin/z.mjs': '', 'bin/lit.mjs': '', 'bin/commented.mjs': '', 'bin/blocked.mjs': '',
    'shared/walk.ts': "export const w = fs.readdirSync(path.join(ROOT, 'web', 'lint'));",
    'shared/s.ts': '',
    'web/src/app.test.tsx': "import { C } from '@/comp';\nimport { s } from '@shared/s';\nimport { d } from './dir';\nimport { w } from '@shared/walk';",
    'web/src/comp.tsx': '', 'web/src/dir/index.ts': '',
    'web/vitest.config.ts': '', 'web/vite.config.ts': '',
    'web/lint/rule.ts': '', 'web/other/o.ts': '', 'docs/d.md': '',
  });

  await t.test('the node closure follows every import form and entry paths, and skips bare packages and node_modules', () => {
    const { node } = buildReach(root, { reviewed: {} });
    for (const f of ['tests/a.test.mjs', 'tests/helper.mjs', 'src/side.ts', 'src/reexp.ts', 'src/q.ts', 'src/dyn.ts', 'shared/walk.ts', 'bin/x.mjs', 'bin/y.mjs', 'bin/lit.mjs']) {
      assert.ok(node.files.has(f), `${f} must be node-reached`);
    }
    // bin/x.mjs names 'z.mjs' only relative to its own dir: names are read repo-relative.
    for (const f of ['src/unreached.ts', 'bin/z.mjs', 'bin/commented.mjs', 'bin/blocked.mjs', 'tests/node_modules/evil.test.mjs', 'web/src/comp.tsx']) {
      assert.ok(!node.files.has(f), `${f} must not be node-reached`);
    }
    assert.ok(![...node.files].some((f) => f.includes('somepkg')));
    assert.ok(node.text.includes("path.join(ROOT, 'bin', 'x.mjs')"), 'text carries the closure\'s source');
  });

  await t.test('the web closure resolves @/, @shared/, .tsx and index imports', () => {
    const { web } = buildReach(root, { reviewed: {} });
    for (const f of ['web/src/app.test.tsx', 'web/src/comp.tsx', 'shared/s.ts', 'web/src/dir/index.ts', 'shared/walk.ts', 'web/vitest.config.ts', 'web/vite.config.ts']) {
      assert.ok(web.files.has(f), `${f} must be web-reached`);
    }
    assert.ok(!web.files.has('tests/a.test.mjs'));
  });

  await t.test('a walk call adds the dirs its file names and, with a dirname, its own dir', () => {
    const { node, web, stale } = buildReach(root, { reviewed: {} });
    assert.ok(node.walked.has('web/lint'));
    assert.ok(web.walked.has('web/lint'));
    assert.ok(node.walked.has('tests/sub'));
    assert.ok(!node.walked.has('web/other'), 'naming a dir without a walk call adds nothing');
    assert.deepEqual(stale, []);
  });

  await t.test('a fresh reviewed entry replaces the inferred roots for the suite it names only', () => {
    const { node, web, stale } = buildReach(root, { reviewed: { 'shared/walk.ts': { calls: 1, node: ['docs'], why: 'fixture' } } });
    assert.deepEqual(stale, []);
    assert.ok(node.walked.has('docs'));
    assert.ok(!node.walked.has('web/lint'));
    assert.ok(web.walked.has('web/lint'));
  });

  await t.test('a reviewed entry whose call count is off is stale and the inferred roots are used', () => {
    const { node, stale } = buildReach(root, { reviewed: { 'shared/walk.ts': { calls: 2, node: ['docs'], why: 'fixture' } } });
    assert.deepEqual(stale, ['shared/walk.ts']);
    assert.ok(node.walked.has('web/lint'));
    assert.ok(!node.walked.has('docs'));
  });
});

test('changedPaths against a temp git repo', async (t) => {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const repo = (files) => {
    const root = fixtureTree(files);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    return root;
  };

  await t.test('reports branch commits, staged, unstaged and untracked files, and not ignored ones', () => {
    const root = repo({ '.gitignore': 'ignored.log\n', 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'old.txt': 'o' });
    git(root, 'checkout', '-q', '-b', 'work');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a2');
    git(root, 'mv', 'old.txt', 'new.txt');
    git(root, 'commit', '-q', '-am', 'branch');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b2');
    git(root, 'add', 'b.txt');
    fs.writeFileSync(path.join(root, 'c.txt'), 'c2');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'u');
    fs.writeFileSync(path.join(root, 'ignored.log'), 'i');
    const r = changedPaths(root);
    assert.equal(r.ok, true);
    assert.equal(r.base, 'main');
    assert.equal(r.mergeBase, git(root, 'rev-parse', 'main').trim());
    assert.deepEqual([...r.paths].sort(), ['a.txt', 'b.txt', 'c.txt', 'new.txt', 'old.txt', 'untracked.txt']);
  });

  await t.test('a tree identical to main reports no paths', () => {
    const root = repo({ 'a.txt': 'a' });
    assert.deepEqual(changedPaths(root).paths, []);
  });

  await t.test('no main is not ok, with a reason', () => {
    const root = fixtureTree({ 'a.txt': 'a' });
    git(root, 'init', '-q', '-b', 'trunk');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const r = changedPaths(root);
    assert.equal(r.ok, false);
    assert.match(r.reason, /main/);
  });
});

test('the real tree', async (t) => {
  const reach = buildReach(REPO);

  await t.test('files the node suite reads by name select node', () => {
    for (const p of ['web/src/features/views/pluginBridge.js', 'web/src/index.css']) {
      assert.ok(suitesOf(p, reach).includes('node'), p);
    }
  });

  await t.test('src/webBuild.ts selects web (web/src/build.test.ts imports it)', () => {
    assert.ok(suitesOf('src/webBuild.ts', reach).includes('web'));
  });

  await t.test('web/e2e/harness/redact.ts selects web through the e2e walk alone', () => {
    assert.ok(!reach.web.files.has('web/e2e/harness/redact.ts'), 'premise: no web import reaches it');
    assert.deepEqual(suitesOf('web/e2e/harness/redact.ts', reach), ['node', 'web']);
  });

  await t.test('every WALKS_REVIEWED entry is fresh (re-review a named file when this reds)', () => {
    assert.deepEqual(reach.stale, []);
    for (const [file, entry] of Object.entries(WALKS_REVIEWED)) assert.ok(entry.why, `${file} needs a why`);
  });
});
