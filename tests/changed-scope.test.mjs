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
// A reviewed file's live `sites` in the tree at `root`.
const liveSites = (root, file) => buildReach(root, { reviewed: { [file]: { sites: '', node: [], why: 'probe' } } }).sites[file];

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
  const SKIPPED = 'SKIPPED_TREE_MARKER';
  const walkSource = "export const w = fs.readdirSync(path.join(ROOT, 'web', 'lint'));";
  const root = fixtureTree({
    'tests/a.test.mjs': [
      "import { h } from './helper.mjs';",
      "import '../src/side.ts';",
      "export { r } from '../src/reexp.ts';",
      "import q from '../src/q.ts?raw';",
      "import fs from 'node:fs';",
      "import pkg from 'pkg';",
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
    'tests/d1/w.mjs': 'fs.readdirSync(__dirname);',
    'tests/d2/w.mjs': "fs.readdirSync(new URL('.', import.meta.url));",
    'tests/anc.mjs': "fs.readdirSync(ROOT);\nconst f = 'notes/deep/file.md';",
    'tests/web-reader.mjs': "const at = (n) => fs.readFileSync(path.join(ROOT, 'web', 'assets', n));",
    'tests/same-reader.mjs': "const at = (n) => fs.readFileSync(path.join(ROOT, 'conf', n));",
    'web/src/fixture-reader.test.ts': "const FIX = path.join(ROOT, 'tests', 'fixtures');\nconst read = (n) => readFileSync(path.join(FIX, n));\nconst own = (n) => readFileSync(path.join(ROOT, 'web', 'own', n));",
    'tests/node_modules/evil.test.mjs': SKIPPED,
    'tests/.git/g.test.mjs': SKIPPED, 'tests/.mutation/m.test.mjs': SKIPPED,
    'tests/.conduct/c.test.mjs': SKIPPED, 'tests/.compile-cache/k.test.mjs': SKIPPED,
    'node_modules/pkg/index.js': SKIPPED,
    'web/dist/d.js': SKIPPED, 'web/dist.next/n.js': SKIPPED,
    'src/side.ts': "import 'pkg';", 'src/pkg.ts': '', 'src/reexp.ts': '', 'src/q.ts': '', 'src/dyn.ts': '', 'src/unreached.ts': '',
    'bin/x.mjs': "import './y.mjs';\nconst sib = path.join(import.meta.dirname, 'z.mjs');",
    'bin/y.mjs': '', 'bin/z.mjs': '', 'bin/lit.mjs': '', 'bin/commented.mjs': '', 'bin/blocked.mjs': '',
    'shared/walk.ts': walkSource,
    'shared/s.ts': '',
    'web/src/app.test.tsx': "import { C } from '@/comp';\nimport { s } from '@shared/s';\nimport { d } from './dir';\nimport { w } from '@shared/walk';\nimport '../dist/d.js';\nimport '../dist.next/n.js';",
    'web/src/comp.tsx': '', 'web/src/dir/index.ts': '',
    'web/vitest.config.ts': '', 'web/vite.config.ts': '',
    'web/lint/rule.ts': '', 'web/other/o.ts': '', 'web/assets/a.css': '', 'web/own/o.json': '',
    'docs/d.md': '', 'notes/deep/file.md': '', 'conf/c.json': '', 'tests/fixtures/f.jsonl': '',
  });
  const reach = buildReach(root, { reviewed: {} });

  await t.test('the node closure follows every import form and entry paths, and skips comments and bare packages', () => {
    const { node } = reach;
    for (const f of ['tests/a.test.mjs', 'tests/helper.mjs', 'src/side.ts', 'src/reexp.ts', 'src/q.ts', 'src/dyn.ts', 'shared/walk.ts', 'bin/x.mjs', 'bin/y.mjs', 'bin/lit.mjs']) {
      assert.ok(node.files.has(f), `${f} must be node-reached`);
    }
    // bin/x.mjs names 'z.mjs' only relative to its own dir: names are read repo-relative.
    // src/pkg.ts sits where a bare 'pkg' from src/side.ts would land if read as relative.
    for (const f of ['src/unreached.ts', 'src/pkg.ts', 'bin/z.mjs', 'bin/commented.mjs', 'bin/blocked.mjs', 'web/src/comp.tsx']) {
      assert.ok(!node.files.has(f), `${f} must not be node-reached`);
    }
    assert.ok(node.text.includes("path.join(ROOT, 'bin', 'x.mjs')"), 'text carries the closure\'s source');
  });

  await t.test('the web closure resolves @/, @shared/, .tsx and index imports', () => {
    const { web } = reach;
    for (const f of ['web/src/app.test.tsx', 'web/src/comp.tsx', 'shared/s.ts', 'web/src/dir/index.ts', 'shared/walk.ts', 'web/vitest.config.ts', 'web/vite.config.ts']) {
      assert.ok(web.files.has(f), `${f} must be web-reached`);
    }
    assert.ok(!web.files.has('tests/a.test.mjs'));
  });

  await t.test('skipped dirs never enter the files or the text', () => {
    for (const side of [reach.node, reach.web]) {
      assert.deepEqual([...side.files].filter((f) => /(^|\/)(\.git|\.mutation|\.conduct|\.compile-cache|node_modules|dist|dist\.next)\//.test(f)), []);
      assert.ok(!side.text.includes(SKIPPED));
    }
  });

  await t.test('a walk call adds the dirs its file names, and their ancestors', () => {
    assert.ok(reach.node.walked.has('web/lint'));
    assert.ok(reach.web.walked.has('web/lint'));
    assert.ok(reach.node.walked.has('notes/deep'));
    assert.ok(reach.node.walked.has('notes'), 'a named path\'s leading dirs are named too');
    assert.ok(!reach.node.walked.has('web/other'), 'naming a dir without a walk call adds nothing');
  });

  await t.test('a walk call with a dirname adds its own dir, for each dirname form', () => {
    for (const dir of ['tests/sub', 'tests/d1', 'tests/d2']) assert.ok(reach.node.walked.has(dir), dir);
  });

  await t.test('a read call adds the dirs its file names on the other suite\'s side only', () => {
    assert.ok(reach.node.walked.has('web/assets'), 'a node file reading under web/');
    assert.ok(reach.web.walked.has('tests/fixtures'), 'a web file reading outside web/');
    assert.ok(!reach.node.walked.has('conf'), 'a node file reading outside web/ is a same-side read');
    assert.ok(!reach.web.walked.has('web/own'), 'a web file reading under web/ is a same-side read');
  });

  const sites = liveSites(root, 'shared/walk.ts');

  await t.test('a fresh reviewed entry replaces the inferred roots for the suite it names only', () => {
    const r = buildReach(root, { reviewed: { 'shared/walk.ts': { sites, node: ['docs'], why: 'fixture' } } });
    assert.deepEqual(r.stale, []);
    assert.ok(r.node.walked.has('docs'));
    assert.ok(!r.node.walked.has('web/lint'));
    assert.ok(r.web.walked.has('web/lint'));
  });

  await t.test('an empty reviewed list suppresses the inferred roots for its suite', () => {
    const r = buildReach(root, { reviewed: { 'shared/walk.ts': { sites, node: [], why: 'fixture' } } });
    assert.ok(!r.node.walked.has('web/lint'));
    assert.ok(r.web.walked.has('web/lint'));
  });

  await t.test('a reviewed entry whose call sites differ is stale and the inferred roots are used', () => {
    const r = buildReach(root, { reviewed: { 'shared/walk.ts': { sites: `${sites} 00000000`, node: ['docs'], why: 'fixture' } } });
    assert.deepEqual(r.stale, ['shared/walk.ts']);
    assert.ok(r.node.walked.has('web/lint'));
    assert.ok(!r.node.walked.has('docs'));
  });

  await t.test('a same-arity change to a walk call line makes its entry stale', () => {
    const tree = (call) => fixtureTree({
      'tests/a.test.mjs': "import '../shared/walk.ts';",
      'shared/walk.ts': `export const w = fs.${call}(path.join(ROOT, 'web', 'lint'));`,
      'web/lint/rule.ts': '', 'docs/d.md': '',
    });
    const before = tree('readdirSync');
    const after = tree('opendirSync');
    const reviewed = { 'shared/walk.ts': { sites: liveSites(before, 'shared/walk.ts'), node: ['docs'], why: 'fixture' } };
    const [was, now] = [liveSites(before, 'shared/walk.ts'), liveSites(after, 'shared/walk.ts')].map((s) => s.split(' '));
    assert.equal(now.length, was.length, 'premise: same arity');
    assert.equal(now.at(-1), was.at(-1), 'premise: same named paths');
    assert.deepEqual(buildReach(before, { reviewed }).stale, []);
    const r = buildReach(after, { reviewed });
    assert.deepEqual(r.stale, ['shared/walk.ts']);
    assert.ok(r.node.walked.has('web/lint'));
  });

  await t.test('moving the constant a narrowing comes from, on a non-call line, makes its entry stale', () => {
    const tree = (dir) => fixtureTree({
      'tests/r.mjs': `const FIX = path.join(ROOT, 'web', 'src', '${dir}');\nconst read = (n) => fs.readFileSync(path.join(FIX, n));`,
      'web/src/d1/a.ts': '', 'web/src/d2/b.ts': '',
    });
    const before = tree('d1');
    const after = tree('d2');
    const reviewed = { 'tests/r.mjs': { sites: liveSites(before, 'tests/r.mjs'), node: ['web/src/d1'], why: 'fixture' } };
    const [was, now] = [liveSites(before, 'tests/r.mjs'), liveSites(after, 'tests/r.mjs')].map((s) => s.split(' '));
    assert.deepEqual(now.slice(0, -1), was.slice(0, -1), 'premise: the call sites are unchanged');
    assert.deepEqual(buildReach(before, { reviewed }).stale, []);
    const r = buildReach(after, { reviewed });
    assert.deepEqual(r.stale, ['tests/r.mjs']);
    assert.deepEqual(suitesOf('web/src/d2/b.ts', r), ['node', 'web']);
  });

  await t.test('a reviewed entry for a missing file is stale', () => {
    assert.deepEqual(buildReach(root, { reviewed: { 'src/gone.ts': { sites: '', node: [], why: 'fixture' } } }).stale, ['src/gone.ts']);
  });
});

test('buildReach: a read naming exactly web/ is other-side for node only', () => {
  const read = "const at = (n) => readFileSync(path.join(ROOT, 'web', n));";
  const reach = buildReach(fixtureTree({ 'tests/r.test.mjs': read, 'web/src/r.test.ts': read, 'web/x.json': '' }), { reviewed: {} });
  assert.ok(reach.node.walked.has('web'));
  assert.ok(!reach.web.walked.has('web'));
});

test('buildReach: each walk and read call form', async (t) => {
  // One file per form, each naming its own dir; tests/ files reading under web/
  // so the read rule (other side only) applies.
  const WALKS = {
    readdirSync: "fs.readdirSync(path.join(ROOT, 'd', 'readdirSync'));",
    readdir: "await fs.readdir(path.join(ROOT, 'd', 'readdir'));",
    opendirSync: "fs.opendirSync(path.join(ROOT, 'd', 'opendirSync'));",
    opendir: "await fs.opendir(path.join(ROOT, 'd', 'opendir'));",
    globSync: "fs.globSync(path.join(ROOT, 'd', 'globSync', '*'));",
    glob: "await glob(path.join(ROOT, 'd', 'glob', '*'));",
    fsGlob: "for await (const f of fs.glob(path.join(ROOT, 'd', 'fsGlob', '*')));",
    // The generic form: a bare `import.meta.glob(` already matches through `glob(`.
    metaGlob: "const mods = import.meta.glob<{ default: string }>('../../d/metaGlob/*.ts');",
    cpSync: "fs.cpSync(path.join(ROOT, 'd', 'cpSync'), tmp, { recursive: true });",
    fsCp: "await fs.cp(path.join(ROOT, 'd', 'fsCp'), tmp, { recursive: true });",
    lsFiles: "execFileSync('git', ['ls-files', 'd/lsFiles']);",
    rg: "run(['rg', 'TODO', path.join(ROOT, 'd', 'rg')]);",
    grep: "run(['grep', '-r', 'TODO', path.join(ROOT, 'd', 'grep')]);",
    gitGrep: "execFileSync('git', ['grep', '-n', 'TODO', '--', 'd/gitGrep']);",
    find: "run(['find', path.join(ROOT, 'd', 'find')]);",
  };
  const READS = {
    readFileSync: "fs.readFileSync(path.join(ROOT, 'web', 'r', 'readFileSync', n));",
    readFile: "await fs.readFile(path.join(ROOT, 'web', 'r', 'readFile', n));",
    createReadStream: "fs.createReadStream(path.join(ROOT, 'web', 'r', 'createReadStream', n));",
    copyFileSync: "fs.copyFileSync(path.join(ROOT, 'web', 'r', 'copyFileSync', n), tmp);",
    copyFile: "await fs.copyFile(path.join(ROOT, 'web', 'r', 'copyFile', n), tmp);",
  };
  const files = {};
  for (const [name, src] of Object.entries(WALKS)) {
    files[`tests/walks/${name}.mjs`] = src;
    files[`d/${name}/x.ts`] = '';
  }
  for (const [name, src] of Object.entries(READS)) {
    files[`tests/reads/${name}.mjs`] = src;
    files[`web/r/${name}/x.json`] = '';
  }
  const { node } = buildReach(fixtureTree(files), { reviewed: {} });
  for (const name of Object.keys(WALKS)) {
    await t.test(`walk: ${name}`, () => assert.ok(node.walked.has(`d/${name}`), `d/${name} must be walked`));
  }
  for (const name of Object.keys(READS)) {
    await t.test(`read: ${name}`, () => assert.ok(node.walked.has(`web/r/${name}`), `web/r/${name} must be reached`));
  }
});

test('buildReach: a closureOf reviewed entry reaches an import closure', async (t) => {
  const depsSource = "const WEB = path.join(ROOT, 'web');\nconst html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');";
  const root = fixtureTree({
    'tests/deps.test.mjs': depsSource,
    'web/index.html': '<script type="module" src="/src/main.tsx"></script>',
    'web/src/main.tsx': "import './lib';\nimport './main.css';",
    'web/src/main.css': "@import 'tailwindcss';\n@import './tokens.css';\n@import url(\"./more.css\");",
    'web/src/tokens.css': '', 'web/src/more.css': '',
    'web/src/lib.ts': '',
    'web/src/lib.test.ts': "import './lib';",
    'web/vite.config.ts': "import './plugin.ts';",
    'web/plugin.ts': '',
  });
  const entry = (closureOf) => ({ 'tests/deps.test.mjs': { sites: liveSites(root, 'tests/deps.test.mjs'), node: { closureOf }, why: 'fixture' } });
  const reach = buildReach(root, { reviewed: entry(['web/index.html', 'web/vite.config.ts']) });

  await t.test('files in the closure select node, through an .html module entry and through imports', () => {
    assert.deepEqual(reach.stale, []);
    for (const p of ['web/src/main.tsx', 'web/src/lib.ts', 'web/plugin.ts']) assert.deepEqual(suitesOf(p, reach), ['node', 'web'], p);
  });

  await t.test('a CSS file reached only through @import from a closure file selects node', () => {
    for (const p of ['web/src/tokens.css', 'web/src/more.css']) assert.deepEqual(suitesOf(p, reach), ['node', 'web'], p);
  });

  await t.test('a test-side file outside the closure does not select node', () => {
    assert.deepEqual(suitesOf('web/src/lib.test.ts', reach), ['web']);
  });

  await t.test('without the entry, the read rule reaches all of web/', () => {
    assert.deepEqual(suitesOf('web/src/lib.test.ts', buildReach(root, { reviewed: {} })), ['node', 'web']);
  });

  await t.test('a closureOf root that is gone makes the entry stale', () => {
    assert.deepEqual(buildReach(root, { reviewed: entry(['web/gone.html']) }).stale, ['tests/deps.test.mjs']);
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

// A real code path this file pins is spelled as a concatenation: a whole-path
// literal here would be an entry edge into the node closure and satisfy the pin.
test('the real tree', async (t) => {
  const reach = buildReach(REPO);
  const namedIn = (text, p) => new RegExp(`(?<![\\w.-])${path.posix.basename(p).replace(/[.]/g, '\\.')}(?![\\w-])`).test(text);
  const underAny = (p, roots) => [...roots].some((d) => p === d || p.startsWith(`${d}/`));

  await t.test('a Vitest proof file selects node by its basename alone (row 4: tests/web-console-guard.test.mjs runs it)', () => {
    const p = 'web/src/test/' + 'consoleGuard.proof.test.ts';
    assert.ok(!reach.node.files.has(p) && !underAny(p, reach.node.walked), 'premise: no node closure or walk reaches it');
    assert.ok(suitesOf(p, reach).includes('node'));
  });

  await t.test('web/src/themeTokens.css joins the web closure through index.css\'s @import', () => {
    assert.ok(reach.web.files.has('web/src/themeTokens.css'));
  });

  await t.test('a web file a node test names by full path joins the node closure (pluginBridge.js)', () => {
    assert.ok(reach.node.files.has('web/src/features/views/' + 'pluginBridge.js'));
  });

  await t.test('src/webBuild.ts selects web (web/src/build.test.ts imports it)', () => {
    assert.ok(suitesOf('src/webBuild.ts', reach).includes('web'));
  });

  await t.test('web/e2e/harness/redact.ts reaches web through a walked root alone (row 5)', () => {
    const p = 'web/e2e/harness/redact.ts';
    assert.ok(!reach.web.files.has(p) && !namedIn(reach.web.text, p), 'premise: no web import or name reaches it');
    assert.deepEqual(suitesOf(p, reach), ['node', 'web']);
  });

  await t.test('web/src/e2eProjects.test.ts\'s recursive walk makes web/e2e a web walked root', () => {
    assert.ok(reach.web.walked.has('web/e2e'));
  });

  await t.test('fixtures Vitest reads through testkit\'s computed paths select web', () => {
    const subagents = fs.readdirSync(path.join(REPO, 'tests', 'fixtures', 'bg-agents-reinvoke.subagents'));
    for (const p of ['tests/fixtures/narration/deepseek-plain.transcript.jsonl', `tests/fixtures/bg-agents-reinvoke.subagents/${subagents[0]}`]) {
      assert.ok(suitesOf(p, reach).includes('web'), p);
    }
  });

  await t.test('web-build-deps reaches the web runtime import closure, not test-side files', () => {
    for (const p of ['web/src/main.tsx', 'web/src/App.tsx']) assert.ok(reach.node.walked.has(p), p);
    assert.ok(!reach.node.walked.has('web/src/conversation/testkit.ts'));
  });

  await t.test('every WALKS_REVIEWED entry is fresh (re-review a named file when this reds)', () => {
    const live = reach.stale.map((f) => `${f}: sites '${reach.sites[f] ?? '(missing)'}'`);
    assert.deepEqual(reach.stale, [], live.join('\n'));
    for (const [file, entry] of Object.entries(WALKS_REVIEWED)) assert.ok(entry.why, `${file} needs a why`);
  });
});
