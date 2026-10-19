// `npm test -- --changed`: the diff against main, and which suites and typecheck
// halves it selects. tests/gate.mjs turns the selection into steps.
//
// A suite "reaches" a path when its import closure contains it (roots plus every
// import and every code file it spawns by path), when its closure's source names
// the path's basename (a file read by name), or when a closure file walks a
// directory holding it or reads under one on the other suite's side. The rules
// fail safe: anything nothing reaches runs both suites. Pinned by
// tests/changed-scope.test.mjs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// A call that enumerates a directory: every dir its file names is reached.
// `fs.cp(`, `fs.glob(` and `'git', ['grep'` match through `cp(`, `glob(` and `['grep'`.
export const WALK_CALL = /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob)\s*\(|import\.meta\.glob|\bcpSync\s*\(|\bcp\s*\(|ls-files|\[\s*['"](?:rg|grep|find)['"]/g;

// A call that reads a file. A file making one reaches every dir it names on the
// other suite's side (a fixture dir read through a computed path); a helper
// wrapping it counts too, because the match is per file.
export const READ_CALL = /\b(?:readFileSync|readFile|createReadStream|copyFileSync|copyFile)\s*\(/g;
const OTHER_SIDE = {
  node: (d) => d === 'web' || d.startsWith('web/'),
  web: (d) => d !== 'web' && !d.startsWith('web/'),
};

// What a file's reach is computed from: a short hash of each walk and read
// call site's trimmed line (comments stripped), in source order, then one hash
// of the sorted repo paths (`isRepoPath`) its literals name, so moving a
// constant a narrowing came from changes it too.
export function sitesOf(source, isRepoPath) {
  const text = stripComments(source);
  const lines = text.split('\n');
  const lineOf = (index) => lines[text.slice(0, index).split('\n').length - 1].trim();
  const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8);
  const calls = [...text.matchAll(WALK_CALL), ...text.matchAll(READ_CALL)].sort((a, b) => a.index - b.index);
  const named = [...namedPaths(text, { ancestors: false })].filter(isRepoPath).sort();
  return [...calls.map((m) => hash(lineOf(m.index))), hash(named.join('\n'))].join(' ');
}

const FULL_GATE = 'classifies the tree rather than tests it, and its dir literals would otherwise make whole trees node-reached roots. The real-tree pins live in the node suite, so a `web/`-only diff does not run them: the full npm test gate catches what --changed skips';
const TEMP_ONLY = (what) => `${what}; its repo-dir literals are fixture paths or names`;

// Walks and reads whose real reach is narrower than the dirs their file names.
// For each suite an entry names, its value replaces the inferred dirs: a list of
// dirs, or `{ closureOf: [roots] }` for a file that follows imports itself (an
// .html root contributes its module <script> srcs). `sites` is sitesOf(the
// file, its repo paths); `buildReach` returns each reviewed file's live value as
// `sites`. When it differs, or a closureOf root is gone, the entry is stale:
// ignored and reported, so a changed call over-selects until it is re-reviewed.
export const WALKS_REVIEWED = {
  'src/webBuild.ts': {
    sites: '6e3cf71c ad17a209 a75cbeb1 a2e63040 c6098721', node: [], web: ['web', 'shared'],
    why: 'listFiles walks the real web/ and shared/, but on node it only hashes them and tests compare hashes from one run; Vitest\'s build.test.ts runs real builds. The leftover sweep reads a temp distDir\'s parent',
  },
  'web/src/build.test.ts': {
    sites: 'f1486e07 8d9b0700 4a355031 6fb40c69 f1ae0f8d c4818124 5bdf6397 c2a40c80 3d3eb0f7 451ff969 bfc0415d 670355af 2bc56ac9 30d3d1ae bbd0c016 18a58c5e', node: [], web: ['web', 'shared'],
    why: 'its own walks read a temp distDir; src/bin/docs appear only as isWebInput fixture paths. The node closure holds it only because tests/changedScope.mjs names it, and node never runs it',
  },
  'tests/web-post-merge.test.mjs': { sites: 'd69e23d6 b9c60af3 84c422d9 f3b78fed 2394566a b2b3efec 0d75ce36 cffbf990 cffbf990 f7fc612e b8f329e6 caf50f03 2eac1251', node: [], why: TEMP_ONLY('walks and reads a temp fixture tree') },
  'tests/boot-commit.test.mjs': { sites: '022d904e aaef09c1 2b5291a8 7142d7c4', node: [], why: TEMP_ONLY('walks a temp repo') },
  'tests/plugin-theme.test.mjs': { sites: '968c0fa0 c0c8f1fa 58aa9cb6 c0c8f1fa 694e31cf d69fbcaa 45782442 a10d7e70', node: [], why: TEMP_ONLY('walks a temp decoy npm prefix') },
  'tests/e2e-harness-credentials.test.mjs': { sites: 'd9f3ee8f ef07bcd0 c47911ee 5141e561 fc4789d4 5141e561 b2474d28', node: [], why: TEMP_ONLY('walks a temp credentials dir') },
  'tests/web-routes.test.mjs': { sites: '7762d58e aafe3cc9', node: [], why: 'reads pluginBridge.js by its full path, which the closure already follows' },
  'tests/web-console-guard.test.mjs': { sites: 'c3cac5bc 57bf6791 57bf6791 d8479345', node: [], why: 'reads Vitest\'s report from a temp file; web files it names are named in full' },
  'tests/project-location-records.test.mjs': { sites: '664db8b3 90ccc955', node: [], why: 'copies the real tests/fixtures/session-sample.jsonl, which the basename row and node\'s own tests/ walks already reach; \'web\' is a project name' },
  'tests/harness-mutation-parse.test.mjs': { sites: '3163bb1f 99687694 60a807b0 ad5f09e4', node: [], why: TEMP_ONLY('reads fixtures under tests/ and package.json; web/ names are route globs and temp dirs') },
  'tests/harness-mutation-canary.test.mjs': { sites: 'd3f6f2f7 30e83ada 62639c9d', node: [], why: TEMP_ONLY('reads a temp tree it writes') },
  'tests/gate.test.mjs': { sites: '60a807b0 c518304c', node: [], why: TEMP_ONLY('reads package.json; web/ paths are argument fixtures') },
  'tests/web-build-deps.test.mjs': {
    sites: '57096d31 baeef358 2f5ef4cd 1b947073', node: { closureOf: ['web/index.html', 'web/vite.config.ts'] },
    why: 'follows the web build\'s runtime import graph from index.html\'s entry and the Vite config',
  },
  'web/e2e/harness/boot.ts': { sites: 'aa0206d3 61a09ac6', node: ['web/e2e/fixtures'], why: 'FIXTURES names web/e2e/fixtures; its own read is a temp log' },
  'web/src/conversation/testkit.ts': { sites: '33814713 4e89ed51', web: ['tests/fixtures'], why: 'FIXTURES is tests/fixtures, read through computed names' },
  'tests/changedScope.mjs': { sites: 'b04d40e7 e1618153 1384b122 35c10387 6be9e464 d1573673 164f8337', node: [], why: FULL_GATE },
  'tests/changed-scope.test.mjs': { sites: 'f95d83a4 0e146f58 9d784053 e7c5322d 12467dd7 55034659 821cbd72 87b80e20 1f8fea67 d6788adc 081e659c 081e659c 0017fecc b23cfe1b 7c2dcb60 71fdd1b7 12f6b5d8 291d57a9 af882457 d6495aa7 9a7a8887 0dc907a7 45e55e8c ff7912b4 48609e11 98c6d0d8 1a35a52c 2cd0aece c162c661 c9a22610 74710671 a4ab583c 002a278d b8eeebc4 99033093 da492361 d4ec334f a2b29e83', node: [], why: FULL_GATE },
};

const SUITES = ['node', 'web'];
const SKIP_NAMES = new Set(['node_modules', '.git', '.mutation', '.conduct', '.compile-cache']);
const CODE = /\.(?:ts|tsx|mts|mjs|js|cjs)$/;
const DIRNAME = /__dirname|import\.meta\.dirname|import\.meta\.url/;
// A module entry in an .html file: `<script type="module" src="/src/main.tsx">`.
const MODULE_SCRIPT = /<script\b[^>]*\btype="module"[^>]*\bsrc="\/?([^"]+)"/g;
// A CSS `@import './x.css'` or `@import url('./x.css')`; package imports are skipped.
const CSS_IMPORT = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;
const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
// A string literal opening at a quote; every quote is tried as an opener, so a
// stray quote earlier on a line cannot hide a path.
const LITERAL_AT = /(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/y;
const SEGMENT_NEXT = /\s*,\s*(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/y;
const AFTER_SEGMENT = /['"]\s*,\s*$/;

// Drop `//` and `/* */` comments outside strings, in one left-to-right pass.
// A block comment keeps its newlines, so line boundaries survive. Strings are
// kept whole: `'…'`/`"…"` end at their quote or the line's end, and a template
// literal's `${…}` is scanned as code to its matching brace, so a nested
// template inside it nests. A `/` is a regex literal when the last significant
// code char is one of REGEX_AFTER (or none); the regex runs to its unescaped
// closing `/` outside a `[…]` class, on one line. That is the usual heuristic:
// a regex after a keyword such as `return` reads as division.
const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);
export function stripComments(src) {
  let out = '';
  let i = 0;
  let last = '';
  const quoted = (q) => {
    const start = i++;
    while (i < src.length && src[i] !== q && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
    if (src[i] === q) i++;
    out += src.slice(start, i);
  };
  const regex = () => {
    const start = i++;
    let inClass = false;
    while (i < src.length && src[i] !== '\n') {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i++; break; }
      i++;
    }
    while (i < src.length && /\w/.test(src[i])) i++;
    out += src.slice(start, i);
  };
  const template = () => {
    out += src[i++];
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        code(true);
        if (i < src.length) out += src[i++];
      } else {
        out += src[i++];
      }
    }
    if (i < src.length) out += src[i++];
  };
  // Code until the end, or (`inTemplate`) until the `}` closing a `${`.
  function code(inTemplate) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '/' && n === '/') {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        out += src.slice(i, stop).replace(/[^\n]/g, '');
        i = stop;
      } else if (c === '\'' || c === '"') {
        quoted(c);
        last = c;
      } else if (c === '`') {
        template();
        last = c;
      } else if (c === '/' && (last === '' || REGEX_AFTER.has(last))) {
        regex();
        last = '/';
      } else {
        if (inTemplate && c === '{') depth++;
        if (inTemplate && c === '}' && depth-- === 0) return;
        out += c;
        i++;
        if (!/\s/.test(c)) last = c;
      }
    }
  }
  code(false);
  return out;
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const under = (p, dirs) => [...dirs].some((d) => p === d || p.startsWith(`${d}/`));

// Every repo path a comment-stripped text spells: a literal or a run of quoted
// segments not preceded by another (`path.join(ROOT, 'bin', 'x.mjs')`), read
// repo-relative after dropping leading `./`/`../`. A sibling named by its bare
// basename is the basename row's to catch. `ancestors` adds each name's leading
// dirs (`'web/src/a.ts'` names `web`).
export function namedPaths(text, { ancestors }) {
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
      if (f.endsWith('.html') && fileSet.has(f)) {
        for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(MODULE_SCRIPT)) {
          stack.push(path.posix.join(path.posix.dirname(f), m[1]));
        }
      }
      if (f.endsWith('.css') && fileSet.has(f)) {
        for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(CSS_IMPORT)) {
          if (m[1].startsWith('.')) stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])));
        }
      }
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

  const matches = (f, re) => [...(stripped(f) ?? '').matchAll(re)];
  const isRepoPath = (p) => fileSet.has(p) || dirs.has(p);
  const sites = Object.fromEntries(Object.keys(reviewed).map((f) => [f, fileSet.has(f) ? sitesOf(read(f), isRepoPath) : null]));
  const stale = Object.entries(reviewed)
    .filter(([f, entry]) => sites[f] !== entry.sites || SUITES.some((s) => entry[s]?.closureOf?.some((r) => !fileSet.has(r))))
    .map(([f]) => f);

  const reach = { stale, sites };
  for (const [suite, members] of Object.entries(closures)) {
    const walked = new Set();
    for (const f of members) {
      const narrowed = reviewed[f]?.[suite];
      if (narrowed && !stale.includes(f)) {
        for (const d of narrowed.closureOf ? closure(narrowed.closureOf) : narrowed) walked.add(d);
        continue;
      }
      const walks = matches(f, WALK_CALL).length > 0;
      if (!walks && matches(f, READ_CALL).length === 0) continue;
      for (const named of namedPaths(stripped(f), { ancestors: true })) {
        if (dirs.has(named) && (walks || OTHER_SIDE[suite](named))) walked.add(named);
      }
      if (walks && DIRNAME.test(stripped(f))) walked.add(path.posix.dirname(f));
    }
    const text = [...members].map((f) => read(f) ?? '').join('\n');
    reach[suite] = { files: members, text, walked };
  }
  return reach;
}

const TOOLCHAIN = (p) => p === 'package.json' || p === 'package-lock.json' || /^tsconfig.*\.json$/.test(path.posix.basename(p));

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
