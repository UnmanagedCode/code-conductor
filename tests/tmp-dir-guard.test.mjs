// Guard: every temp dir a test mints goes through tests/tmpRegistry.mjs, which
// removes it by exact path at file end. A raw node:fs mint leaks into the OS
// temp dir for good.
//
// The scan reads RAW SOURCE TEXT — no lexer, no parser. A comment/string/regex
// blanker fails in the false-negative direction (a misread token hides a
// call), so instead every whole-word `mkdtemp` / `mkdtempSync` is a hit,
// comments and strings included. Exactly three things exempt an occurrence:
//   E1  it sits inside `import { … } from '<…>/tmpRegistry.mjs'` as an
//       UNRENAMED specifier (a renamed one is a hit and binds nothing). Only
//       the file's LEADING import block counts — blank lines, comments and
//       (possibly multi-line) import statements up to the first other line —
//       so an import spelled inside a string or template binds nothing;
//   E2  it is a bare use of a name E1 bound in the same file — not preceded by
//       `.` / `?.`, not followed by `:`, not wrapped in quotes;
//   E3  its line contains the `match` of an ALLOWED entry for that file.
// In prose write "temp dir" instead of the word.
//
// Residual (stated, not hidden):
//   - bare shorthand destructuring that shadows a registry-bound name in a
//     nested scope, e.g. `{ const { mkdtemp } = fsp; }` in a file that imports
//     the registry's `mkdtemp` — it takes a deliberate shadow;
//   - mints not spelled with the word: shell `mktemp -d`, or `fs.mkdir` of a
//     hand-built name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCAN_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.mts']);

// Whole files exempt by name.
const FILE_EXEMPT = {
  'tests/tmpRegistry.mjs': 'the one sanctioned implementation of the mint',
  'tests/tmp-dir-guard.test.mjs': 'its snippets are fixtures and necessarily spell every forbidden shape',
};

// Per-site exceptions: `match` is a substring of the hit's source line, so a
// new direct call added to one of these files still fails.
const ALLOWED = [
  { file: 'tests/store-lock-lost-update.test.mjs', match: "path.join(tmp, 'race-')", reason: 'nested inside an already-registered root, not under the OS temp dir' },
  { file: 'tests/store-lock-lost-update.test.mjs', match: "path.join(tmp, 'inproc-')", reason: 'nested inside an already-registered root, not under the OS temp dir' },
  { file: 'tests/archived-lock-lost-update.test.mjs', match: "path.join(tmp, 'race-')", reason: 'nested inside an already-registered root, not under the OS temp dir' },
  { file: 'tests/systems-absolute-paths.test.mjs', match: "'relative-write-fence-'", reason: 'nested inside a registry-owned home' },
  { file: 'tests/systems-absolute-paths.test.mjs', match: "'relative-cwd-fence-'", reason: 'nested inside a registry-owned home' },
  { file: 'tests/systems-absolute-paths.test.mjs', match: "'provider-cwd-'", reason: 'nested inside a registry-owned home' },
  { file: 'tests/fuse-transport-bench.mjs', match: "'cc-bench-'", reason: 'a plain script, not node:test: importing the registry would call after() outside a run; its try/finally removes the dir' },
  { file: 'tests/tmpRegistry.test.mjs', match: "'cc-f3-nest-outer-'", reason: 'must stay unregistered or the registry would remove the nested entry under test' },
  { file: 'tests/tmpRegistry.test.mjs', match: "'cc-f3b-nest-outer-'", reason: 'must stay unregistered or the registry would remove the nested entry under test' },
  { file: 'tests/safeStoreRoot.mjs', match: "import { mkdtempSync,", reason: 'tmpRegistry imports this module, so it cannot depend on the registry' },
  { file: 'tests/safeStoreRoot.mjs', match: "'cc-testrun-'", reason: 'the per-run root is owned by mintedRoots and outlives every file' },
];

const WORD = /\b(mkdtemp|mkdtempSync)\b/g;
const REGISTRY_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])[^'"]*\/tmpRegistry\.mjs\2/g;

// Offset where the leading block (blank lines, comments, a shebang, import
// statements) ends; the first other token stops it.
const LEADING_TOKENS = [
  /\s+/y,
  /\/\/[^\n]*/y,
  /\/\*[\s\S]*?\*\//y,
  /#![^\n]*/y,
  /import\b(?:[^'";]*?\bfrom\s*)?(['"])[^'"\n]*\1[ \t]*;?/y,
];
function leadingBlockEnd(source) {
  let pos = 0;
  for (;;) {
    let advanced = false;
    for (const re of LEADING_TOKENS) {
      re.lastIndex = pos;
      const m = re.exec(source);
      if (m && m[0].length > 0) { pos += m[0].length; advanced = true; break; }
    }
    if (!advanced) return pos;
  }
}

// Allowed entries no hit used.
export const staleEntries = (allowed, used) => allowed.filter((a) => !used.has(a));
// Expected files the scan never visited.
export const unscanned = (expected, scanned) => expected.filter((e) => !scanned.has(e));

// -> [{ line, text, name }] for every hit the exemptions don't cover.
// `allowed` is the ALLOWED entries for this file; `used` collects the ones that matched.
export function scan(source, allowed = [], used = new Set()) {
  const bound = new Set();
  const importSpans = [];
  const leadingEnd = leadingBlockEnd(source);
  for (const m of source.matchAll(REGISTRY_IMPORT)) {
    if (m.index >= leadingEnd) continue;
    importSpans.push([m.index, m.index + m[0].length]);
    for (const spec of m[1].split(',')) {
      const t = spec.trim();
      if (t === 'mkdtemp' || t === 'mkdtempSync') bound.add(t);
    }
  }
  const lines = source.split('\n');
  const lineStarts = [];
  let off = 0;
  for (const l of lines) { lineStarts.push(off); off += l.length + 1; }
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const hits = [];
  for (const m of source.matchAll(WORD)) {
    const idx = m.index;
    const name = m[1];
    const prev = source.slice(0, idx);
    const next = source.slice(idx + name.length);
    const inImport = importSpans.some(([a, b]) => idx >= a && idx < b);
    // E1: an unrenamed specifier is delimited by `{`/`,` before and `,`/`}` after.
    if (inImport && /[{,]\s*$/.test(prev) && /^\s*[,}]/.test(next)) continue;
    const lineNo = lineOf(idx);
    const text = lines[lineNo];
    const entry = allowed.find((a) => text.includes(a.match));
    if (entry) { used.add(entry); continue; } // E3
    if (!inImport && bound.has(name)) {
      // E2: a bare use of a bound name.
      const dotted = /\??\.\s*$/.test(prev);
      const keyed = /^\s*:/.test(next);
      const quoted = /['"`]$/.test(prev) && /^['"`]/.test(next);
      if (!dotted && !keyed && !quoted) continue;
    }
    hits.push({ line: lineNo + 1, text: text.trim(), name });
  }
  return hits;
}

async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (SCAN_EXT.has(path.extname(e.name))) yield p;
  }
}

const rel = (p) => path.relative(path.dirname(TESTS_DIR), p).split(path.sep).join('/');

test('scanner reports every forbidden occurrence at its line', async (t) => {
  const registryMkdtemp = "import { mkdtemp } from './tmpRegistry.mjs';\n";
  const registrySync = "import { mkdtempSync } from './tmpRegistry.mjs';\n";
  const cases = [
    ['fs.mkdtemp with os.tmpdir', "fs.mkdtemp(path.join(os.tmpdir(),'x-'))", 1],
    ['fsp.mkdtemp with a named tmpdir', "import { tmpdir } from 'node:os';\nfsp.mkdtemp(path.join(tmpdir(),'x-'))", 2],
    ['fs.mkdtempSync with a template', 'a;\nfs.mkdtempSync(`${os.tmpdir()}/x-`)', 2],
    ['renamed node:fs/promises import', "import { mkdtemp as mk } from 'node:fs/promises';", 1],
    ['renamed registry import', "import { mkdtemp as mk } from './tmpRegistry.mjs';", 1],
    ['require destructuring', "const { mkdtempSync } = require('node:fs');", 1],
    ['destructure-rename beside a registry import', registryMkdtemp + 'const { mkdtemp: raw } = fs.promises;', 2],
    ['fs.promises.mkdtemp', 'await fs.promises.mkdtemp(p);', 1],
    ['optional chain', 'await fs?.mkdtemp(p);', 1],
    ['quoted property', registrySync + "fs['mkdtempSync'](p);", 2],
    ['promisify', 'const m = promisify(fs.mkdtemp);', 1],
    ['namespace import of the registry', "import * as reg from './tmpRegistry.mjs';\nreg.mkdtemp('x-');", 2],
    ['local function', 'x;\nfunction mkdtemp() {}', 2],
    ['line comment', 'a;\n// uses fs.mkdtemp( here', 2],
    ['string', "const s = 'fs.mkdtemp(';", 1],
    ['dotted call beside a registry import', registryMkdtemp + 'await fs.mkdtemp(p);', 2],
    ['optional-chained call beside a registry import', registryMkdtemp + 'await fs?.mkdtemp(p);', 2],
    ['registry import spelled in a template, real fs import and call',
      "const src = `import { mkdtemp } from './tmpRegistry.mjs';`;\nimport { mkdtemp } from 'node:fs/promises';\nawait mkdtemp(p);", 3],
    ['registry import spelled in a template, destructured from fsp',
      "const src = `import { mkdtemp } from './tmpRegistry.mjs';`;\nconst { mkdtemp } = fsp;\nawait mkdtemp(p);", 3],
    ['registry import after other code',
      "const x = 1;\nimport { mkdtemp } from './tmpRegistry.mjs';\nawait mkdtemp(p);", 2],
    ['comment in a file that binds only the sync name', registrySync + '// the bare mkdtemp word', 2],
  ];
  for (const [title, src, line] of cases) {
    await t.test(title, () => {
      const hits = scan(src);
      assert.ok(hits.length >= 1, `expected a hit in: ${src}`);
      assert.ok(hits.some((h) => h.line === line), `expected a hit at line ${line}, got ${JSON.stringify(hits.map((h) => h.line))}`);
    });
  }
});

test('scanner accepts registry imports and their bare uses, and only whole words', async (t) => {
  const cases = [
    ['single import and call', "import { mkdtemp } from './tmpRegistry.mjs';\nconst d = await mkdtemp('x-');"],
    ['multi-line import with both names', "import {\n  mkdtemp,\n  mkdtempSync,\n} from '../tmpRegistry.mjs';\nawait mkdtemp('a-');\nmkdtempSync('b-');"],
    ['import after a leading comment block', "// header\n/* block\n   comment */\nimport fs from 'node:fs';\nimport { mkdtemp } from './tmpRegistry.mjs';\nawait mkdtemp('x-');"],
    ['identifiers that merely contain the word', 'mymkdtempHelper();\nfs.mymkdtempHelper();\nmkdtempHelper2();'],
  ];
  for (const [title, src] of cases) {
    await t.test(title, () => {
      assert.deepEqual(scan(src), []);
    });
  }
});

test('no test-tree file mentions mkdtemp outside tmpRegistry', async () => {
  const perFile = new Map();
  for (const a of ALLOWED) {
    if (!perFile.has(a.file)) perFile.set(a.file, []);
    perFile.get(a.file).push(a);
  }
  const offenders = [];
  for await (const file of walk(TESTS_DIR)) {
    const r = rel(file);
    if (r in FILE_EXEMPT) continue;
    const src = await fs.readFile(file, 'utf8');
    for (const h of scan(src, perFile.get(r) ?? [])) offenders.push(`${r}:${h.line}: ${h.text}`);
  }
  assert.deepEqual(offenders, [], `mint via \`mkdtemp\`/\`mkdtempSync\` imported from tests/tmpRegistry.mjs (removed at file end); in prose write 'temp dir'; a deliberate exception needs an ALLOWED entry with a reason:\n${offenders.join('\n')}`);
});

test('every exemption still matches, and every *.test.mjs was scanned', async () => {
  const perFile = new Map();
  for (const a of ALLOWED) {
    if (!perFile.has(a.file)) perFile.set(a.file, []);
    perFile.get(a.file).push(a);
  }
  const used = new Set();
  const scanned = new Set();
  for await (const file of walk(TESTS_DIR)) {
    const r = rel(file);
    scanned.add(r);
    const src = await fs.readFile(file, 'utf8');
    if (r in FILE_EXEMPT) {
      assert.ok(scan(src).length >= 1, `file-wide exemption ${r} no longer contains a hit — drop it`);
      continue;
    }
    scan(src, perFile.get(r) ?? [], used);
  }
  const stale = staleEntries(ALLOWED, used);
  assert.deepEqual(stale.map((a) => `${a.file}: ${a.match}`), [], 'stale ALLOWED entries');
  const expected = (await fs.readdir(TESTS_DIR)).filter((e) => e.endsWith('.test.mjs')).map((e) => `tests/${e}`);
  assert.deepEqual(unscanned(expected, scanned), [], 'test files the scan never visited');
});

test('staleEntries names exactly the ALLOWED entries no hit used', () => {
  const a = { file: 'x', match: 'a', reason: 'r' };
  const b = { file: 'x', match: 'b', reason: 'r' };
  assert.deepEqual(staleEntries([a, b], new Set([a])), [b]);
  assert.deepEqual(staleEntries([a, b], new Set([a, b])), []);
});

test('unscanned names exactly the expected files the scan never visited', () => {
  assert.deepEqual(unscanned(['tests/a.test.mjs', 'tests/b.test.mjs'], new Set(['tests/a.test.mjs'])), ['tests/b.test.mjs']);
  assert.deepEqual(unscanned(['tests/a.test.mjs'], new Set(['tests/a.test.mjs'])), []);
});
