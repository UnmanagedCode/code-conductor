// `npm test -- --changed`: the diff against main, and which suites and typecheck
// halves it selects. tests/gate.mjs turns the selection into steps.
//
// A suite "reaches" a path when its import closure contains it (roots plus every
// import and every code file it spawns by path), when its closure's source names
// the path's basename (a file read by name), or when a closure file walks a
// directory holding it. The rules fail safe: anything nothing reaches runs both
// suites. Pinned by tests/changed-scope.test.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// A call that enumerates a directory: its file's named dirs are walked.
export const WALK_CALL = /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|fs\.glob|glob)\s*\(|import\.meta\.glob|\bcpSync\s*\(|\bfs\.cp\s*\(|\bcp\s*\(|ls-files|\[\s*['"](?:rg|grep|find)['"]|['"]git['"]\s*,\s*\[\s*['"]grep['"]/g;

// Walks whose real reach is narrower than the dirs their file names. For each
// suite an entry names, its dirs replace the inferred ones. `calls` is the file's
// WALK_CALL count; when the live count differs the entry is stale, ignored, and
// reported, so a new walk over-selects until it is re-reviewed.
export const WALKS_REVIEWED = {
  'src/webBuild.ts': {
    calls: 2, node: [], web: ['web', 'shared'],
    why: 'listFiles walks the real web/ and shared/, but on node it only hashes them and tests compare hashes from one run; Vitest\'s build.test.ts runs real builds. The leftover sweep reads a temp distDir\'s parent',
  },
  'web/src/build.test.ts': {
    calls: 4, node: [], web: ['web', 'shared'],
    why: 'its own walks read a temp distDir; src/bin/docs appear only as isWebInput fixture paths. The node closure holds it only because this file names it, and node never runs it',
  },
  'tests/web-post-merge.test.mjs': { calls: 2, node: [], why: 'walks a temp fixture tree; its web/ paths are fixture literals' },
  'tests/boot-commit.test.mjs': { calls: 3, node: [], why: 'walks a temp repo\'s dirs' },
  'tests/plugin-theme.test.mjs': { calls: 1, node: [], why: 'walks a temp decoy npm prefix' },
  'tests/e2e-harness-credentials.test.mjs': { calls: 2, node: [], why: 'walks a temp credentials dir' },
  'tests/changedScope.mjs': {
    calls: 3, node: [],
    why: 'classifies the tree rather than tests it: an unrelated change that breaks a real-tree pin is caught by the full npm test gate, not by --changed',
  },
  'tests/changed-scope.test.mjs': {
    calls: 2, node: [],
    why: 'classifies the tree rather than tests it: an unrelated change that breaks a real-tree pin is caught by the full npm test gate, not by --changed',
  },
};

const SKIP_NAMES = new Set(['node_modules', '.git', '.mutation', '.conduct', '.compile-cache']);
const CODE = /\.(?:ts|tsx|mts|mjs|js|cjs)$/;
const DIRNAME = /__dirname|import\.meta\.dirname|import\.meta\.url/;
const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
// A string literal opening at a quote; every quote is tried as an opener, so a
// stray quote earlier on a line cannot hide a path.
const LITERAL_AT = /(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/y;
const SEGMENT_NEXT = /\s*,\s*(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/y;
const AFTER_SEGMENT = /['"]\s*,\s*$/;

const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const under = (p, dirs) => [...dirs].some((d) => p === d || p.startsWith(`${d}/`));

// Every repo path a comment-stripped text spells: a literal or a run of quoted
// segments not preceded by another (`path.join(ROOT, 'bin', 'x.mjs')`), read
// repo-relative after dropping leading `./`/`../`. A sibling named by its bare
// basename is the basename row's to catch. `ancestors` adds each name's leading
// dirs (`'web/src/a.ts'` names `web`).
function namedPaths(text, { ancestors }) {
  const names = new Set();
  const add = (p) => {
    if (!p) return;
    const repoRel = path.posix.normalize(p.replace(/^(?:\.\.?\/)+/, ''));
    names.add(repoRel);
    if (ancestors) for (let d = path.posix.dirname(repoRel); d !== '.' && d !== '/'; d = path.posix.dirname(d)) names.add(d);
  };
  for (const q of text.matchAll(/['"`]/g)) {
    const i = q.index;
    LITERAL_AT.lastIndex = i;
    const m = LITERAL_AT.exec(text);
    if (!m) continue;
    add(m[2]);
    if (m[1] === '`' || AFTER_SEGMENT.test(text.slice(Math.max(0, i - 64), i))) continue;
    const run = [m[2]];
    SEGMENT_NEXT.lastIndex = i + m[0].length;
    for (let n; (n = SEGMENT_NEXT.exec(text));) {
      run.push(n[2]);
      add(run.join('/'));
    }
  }
  return names;
}

function listTree(root) {
  const files = [];
  const dirs = new Set();
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP_NAMES.has(e.name) || /^web\/dist/.test(r)) continue;
      if (e.isDirectory()) {
        dirs.add(r);
        walk(r);
      } else {
        files.push(r);
      }
    }
  };
  walk('');
  return { files, dirs };
}

// The closures, the walked roots and the stale reviewed entries, read from the
// tree at `root` once.
export function buildReach(root, { reviewed = WALKS_REVIEWED } = {}) {
  const { files, dirs } = listTree(root);
  const fileSet = new Set(files);
  const source = new Map();
  const read = (f) => {
    if (!source.has(f)) source.set(f, CODE.test(f) && fileSet.has(f) ? fs.readFileSync(path.join(root, f), 'utf8') : null);
    return source.get(f);
  };
  const strippedOf = new Map();
  const stripped = (f) => {
    if (!strippedOf.has(f)) strippedOf.set(f, read(f) === null ? null : stripComments(read(f)));
    return strippedOf.get(f);
  };

  const resolveSpecifier = (from, spec) => {
    const s = spec.split('?')[0];
    let p;
    if (s.startsWith('.')) p = path.posix.normalize(path.posix.join(path.posix.dirname(from), s));
    else if (s.startsWith('@shared/') && from.startsWith('web/')) p = `shared/${s.slice('@shared/'.length)}`;
    else if (s.startsWith('@/') && from.startsWith('web/')) p = `web/src/${s.slice('@/'.length)}`;
    else return null;
    return [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`].find((c) => fileSet.has(c)) ?? null;
  };

  const closure = (roots) => {
    const seen = new Set();
    const stack = [...roots];
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      const text = read(f);
      if (text === null) continue;
      for (const m of text.matchAll(SPECIFIER)) {
        const r = resolveSpecifier(f, m[1] ?? m[2] ?? m[3]);
        if (r) stack.push(r);
      }
      for (const named of namedPaths(stripped(f), { ancestors: false })) {
        if (CODE.test(named) && fileSet.has(named) && !seen.has(named)) stack.push(named);
      }
    }
    return seen;
  };

  const codeUnder = (dir) => files.filter((f) => f.startsWith(`${dir}/`) && CODE.test(f));
  const closures = {
    node: closure(codeUnder('tests')),
    web: closure([...codeUnder('web/src'), 'web/vitest.config.ts', 'web/vite.config.ts'].filter((f) => fileSet.has(f))),
  };

  const callCount = (f) => (stripped(f) ?? '').match(WALK_CALL)?.length ?? 0;
  const stale = Object.entries(reviewed).filter(([f, entry]) => callCount(f) !== entry.calls).map(([f]) => f);

  const reach = { stale };
  for (const [suite, members] of Object.entries(closures)) {
    const walked = new Set();
    for (const f of members) {
      const entry = reviewed[f];
      if (entry?.[suite] && !stale.includes(f)) {
        for (const d of entry[suite]) walked.add(d);
        continue;
      }
      if (!callCount(f)) continue;
      for (const named of namedPaths(stripped(f), { ancestors: true })) if (dirs.has(named)) walked.add(named);
      if (DIRNAME.test(stripped(f))) walked.add(path.posix.dirname(f));
    }
    const text = [...members].map((f) => read(f) ?? '').join('\n');
    reach[suite] = { files: members, text, walked };
  }
  return reach;
}

const TOOLCHAIN = (p) => p === 'package.json' || p === 'package-lock.json' || /^tsconfig.*\.json$/.test(path.posix.basename(p));
const SUITES = ['node', 'web'];

// The suites and typecheck halves `paths` select, and per path the suites and
// the rows (1 toolchain, 2 shared/, 3 closure, 4 basename, 5 walked,
// 6 unclassified) that selected them.
export function classifyChanged(paths, reach) {
  const why = paths.map((p) => {
    if (TOOLCHAIN(p)) return { path: p, suites: [...SUITES], rows: [1] };
    if (p.startsWith('shared/')) return { path: p, suites: [...SUITES], rows: [2] };
    const base = path.posix.basename(p);
    const named = new RegExp(`(?<![\\w.-])${escape(base)}(?![\\w-])`);
    const rows = new Set();
    const suites = SUITES.filter((s) => {
      const { files, text, walked } = reach[s];
      const hits = [files.has(p) && 3, text.includes(base) && named.test(text) && 4, under(p, walked) && 5].filter(Boolean);
      for (const r of hits) rows.add(r);
      return hits.length > 0;
    });
    if (!suites.length) return { path: p, suites: [...SUITES], rows: [6] };
    return { path: p, suites, rows: [...rows].sort() };
  });
  const suites = new Set(why.flatMap((w) => w.suites));
  const halves = new Set(suites);
  if (paths.some((p) => !p.startsWith('web/') && !p.startsWith('tests/'))) for (const s of SUITES) halves.add(s);
  return { suites, halves, why };
}

// Paths changed since `base`'s merge-base with HEAD: committed on the branch,
// staged, unstaged (both sides of a rename) and untracked-not-ignored.
export function changedPaths(root, base = 'main') {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const mergeBase = git('merge-base', base, 'HEAD').trim();
    const list = (out) => out.split('\0').filter(Boolean);
    const paths = new Set([
      ...list(git('diff', '--name-only', '--no-renames', '-z', mergeBase)),
      ...list(git('ls-files', '--others', '--exclude-standard', '-z')),
    ]);
    return { ok: true, base, mergeBase, paths: [...paths].sort() };
  } catch (err) {
    const detail = String(err.stderr ?? err.message).trim().split('\n')[0];
    return { ok: false, reason: `cannot diff against ${base}: ${detail}` };
  }
}
