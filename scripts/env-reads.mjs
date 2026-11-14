// Lists every environment variable the production code reads, and compares the
// set with the registry (`ENV_VARS` in the `src/env.ts` module) and with the
// `| Var | Effect |` table of a docs file.
//
// CLI: `node scripts/env-reads.mjs --docs <path> [--dump]`
//   default  one fact per line: files scanned, names read, undocumented,
//            unregistered, unresolved accesses, stale allow-list entries
//   --dump   sorted `file<TAB>name<TAB>form<TAB>context` rows, one per read
//            (context = the trimmed source line, the access replaced by `$`)
// It always exits 0: tests/env-registry.test.mjs is the enforcer.
//
// Scope: PRODUCTION below. A read is `process.env.X`, `process.env['X']`,
// `process.env[CONST]` (a `const CONST = 'X'` in production code), a
// destructure `{ X } = process.env`, or any of those on a receiver whose name
// ends in `env` (an injected env: `env.X`, `spec.env.X`). Writes, deletes and a
// destructure that only strips names are not reads. An access this grammar
// cannot resolve is reported as unresolved, never skipped.
//
// Limitation: an injected env is followed only when bound directly to a name
// (`x = env`). These alias shapes are NOT followed, so reads through them are
// missed: the env as a call argument, as a return value, in a parenthesized
// binding `(env)`, and a spread `{ ...env }` bound to a name without the env
// suffix.
//
// The walking-test rule applies here too (this file is reached by a walking
// test): no string literal below names a tracked path except the registry's
// own segments. The scope is a regex, the docs path is an argument and the
// root comes from git.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { blankNonCode } from '../tests/importCycles.mjs';

export const CODE = /\.(?:ts|tsx|mts|cts|mjs|js|cjs)$/;
const PRODUCTION_SCOPE = /^(?:server\.ts$|src\/|shared\/|web\/src\/)/;
const PRODUCTION_EXCLUDED = /\.test\.|\.d\.ts$|^web\/src\/test\//;
export const PRODUCTION = (file) => PRODUCTION_SCOPE.test(file) && CODE.test(file) && !PRODUCTION_EXCLUDED.test(file);

// Names held in a property rather than a literal at the read site. `names` are
// derived: every `<key>: '<NAME>'` literal in each `from` file.
export const INDIRECT = [
  { file: 'src/worktrees.ts', expr: 'hook.disableVar', from: [{ file: 'src/worktrees.ts', key: 'disableVar' }], why: 'the post-worktree hooks name their kill-switch var in WORKTREE_HOOKS' },
  { file: 'src/worktrees.ts', expr: 'hook.timeoutVar', from: [{ file: 'src/worktrees.ts', key: 'timeoutVar' }], why: 'the post-worktree hooks name their timeout var in WORKTREE_HOOKS' },
  { file: 'src/installRunner.ts', expr: 'scriptEnvVar', from: [{ file: 'src/whisperInstall.ts', key: 'scriptEnvVar' }, { file: 'src/ttsInstall.ts', key: 'scriptEnvVar' }], why: 'each installer config names its script-override var' },
];

// A whole env value flowing where the scanner cannot follow it. `dest` is the
// destination the scanner classifies: `rest:<name>` for a destructure rest,
// `return`, or `call:<callee>`.
export const FLOWS = [
  { file: 'src/plugins/supervisor.ts', dest: 'rest:inherited', why: 'the rest object is only spread into the backend\'s spawn env' },
  { file: 'src/transcribe.ts', dest: 'return', why: 'whisperEnv returns a child env that is passed to the spawn' },
  { file: 'server.ts', dest: 'call:entryStartOptions', why: 'the callee\'s parameter is named env, so its member reads are scanned' },
  { file: 'src/webPostMergeMain.ts', dest: 'call:bootCommitFromEnv', why: 'the callee\'s parameter is named env, so its member reads are scanned' },
];

const ENV_SUFFIX = /env$/i;
const IDENT = '[A-Za-z_$][\\w$]*';
const RECEIVER = /(?<![\w$#])([\w$#]*env)(?![\w$#])(?!\s*\()/gi;
const CONST_DECL = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*(['"])([A-Z][A-Z0-9_]*)\2/g;
// Members of an `env` that is a list of entries (a backend record's `env`), not an environment.
const LIST_MEMBERS = new Set(['length', 'map', 'filter', 'forEach', 'some', 'every', 'find', 'join', 'includes', 'slice', 'push']);
const KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'return', 'typeof', 'await', 'function']);

export function collectConsts(texts) {
  const seen = new Map();
  for (const text of texts) {
    for (const m of text.matchAll(CONST_DECL)) {
      const prior = seen.get(m[1]);
      if (prior === undefined) seen.set(m[1], m[3]);
      else if (prior !== m[3]) seen.set(m[1], null);
    }
  }
  return seen;
}

export function deriveIndirect(entries, read) {
  return entries.map((e) => {
    const names = new Set();
    for (const f of e.from) {
      const re = new RegExp(`\\b${f.key}\\s*:\\s*(['"])([A-Za-z_]\\w*)\\1`, 'g');
      for (const m of blankNonCode(read(f.file) ?? '').matchAll(re)) names.add(m[2]);
    }
    return { file: e.file, expr: e.expr, names: [...names] };
  });
}

// True when `pos` sits inside a quoted string or a regex literal (template
// text and comments are already blanked). Scans the line up to `pos`.
const REGEX_PRECEDERS = new Set([...'(,=:[!&|?{};+-*%<>~^']);
// A regex literal can start after these words; after any other identifier `/` divides.
const REGEX_KEYWORDS = new Set(['return', 'case', 'typeof', 'throw', 'yield', 'await', 'delete', 'void', 'in', 'of', 'instanceof', 'else', 'do']);
function inNonCode(t, pos) {
  let quote = ''; let regex = false; let cls = false; let last = ''; let word = '';
  const begin = t.lastIndexOf('\n', pos - 1) + 1;
  for (let i = begin; i < pos; i++) {
    const c = t[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (regex) {
      if (c === '\\') i++; else if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) { regex = false; last = 'r'; word = ''; }
      continue;
    }
    if (c === '\'' || c === '"') { quote = c; continue; }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < pos && /[\w$]/.test(t[j])) j++;
      const member = /\.\s*$/.test(t.slice(begin, i));
      word = member ? '' : t.slice(i, j);
      last = 'w'; i = j - 1;
      continue;
    }
    if (c === '/' && (last === '' || REGEX_PRECEDERS.has(last) || (last === 'w' && REGEX_KEYWORDS.has(word)))) { regex = true; cls = false; continue; }
    if (!/\s/.test(c)) { last = c; word = ''; }
  }
  return quote !== '' || regex;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

// Index of the bracket that opens the group `pos` sits in, or -1.
function enclosingOpen(t, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = t[i];
    if (')]}'.includes(c)) depth++;
    else if ('([{'.includes(c)) { if (depth === 0) return i; depth--; }
  }
  return -1;
}

// Where a bare `process.env` value goes: the name it is bound to, the object
// key it is stored under, `return`, or `call:<callee>`; null when unknown.
function destination(t, pos) {
  let i = pos;
  if (/\.\.\.\s*$/.test(t.slice(Math.max(0, pos - 8), pos))) {
    const open = enclosingOpen(t, pos);
    if (open < 0) return null;
    i = open + 1;
  }
  let depth = 0;
  for (let steps = 0; i > 0 && steps < 4000; steps++, i--) {
    const c = t[i - 1];
    if (')]}'.includes(c)) { depth++; continue; }
    if (depth > 0) { if ('([{'.includes(c)) depth--; continue; }
    if (c === '(') {
      const id = /([\w$#]+)\s*$/.exec(t.slice(0, i - 1));
      if (id && !KEYWORDS.has(id[1])) return `call:${id[1]}`;
      continue;
    }
    if (c === ';') return null;
    if (c === '=') {
      if (t[i] === '>' || t[i] === '=' || '=!<>'.includes(t[i - 2] ?? ' ')) continue;
      const left = t.slice(0, i - 1).replace(/[|?&+\-*/%^]+\s*$/, '');
      const annotated = /([\w$#]+)\s*:\s*[^:=;,{}()]*$/.exec(left);
      const plain = /([\w$#]+)\s*$/.exec(left);
      return (annotated ?? plain)?.[1] ?? null;
    }
    if (c === ':') {
      const before = t.slice(0, i - 1);
      const id = /([\w$#]+)\s*$/.exec(before);
      if (id && /(?:[{,]|\n|^)[ \t]*$/.test(before.slice(0, id.index))) return id[1];
      continue;
    }
    if (c === 'n' && t.slice(i - 6, i) === 'return' && !/[\w$]/.test(t[i - 7] ?? ' ')) return 'return';
  }
  return null;
}

// `{ A, B: _b, ...rest } =` ending at `pos`: its parts, or null.
function destructureBefore(t, pos) {
  const m = /\}\s*=\s*$/.exec(t.slice(Math.max(0, pos - 400), pos));
  if (!m) return null;
  const close = pos - 400 > 0 ? pos - 400 + m.index : m.index;
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (t[i] === '}') depth++;
    else if (t[i] === '{') {
      if (--depth === 0) {
        return t.slice(i + 1, close).split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
          if (part.startsWith('...')) return { rest: part.slice(3).trim() };
          if (part.startsWith('[')) return { computed: true };
          const [key, ...aliasParts] = part.split(':');
          const alias = (aliasParts.length ? aliasParts.join(':') : key).split('=')[0].trim();
          return { key: key.split('=')[0].trim(), alias };
        });
      }
    }
  }
  return null;
}

export function scanSource(file, text, { consts = new Map(), indirect = [], flows = [] } = {}) {
  const t = blankNonCode(text);
  const lines = text.split('\n');
  const reads = [];
  const unresolved = [];
  const used = { indirect: new Set(), flows: new Set() };

  const note = (start, end, name, form) => {
    const line = lineOf(t, start);
    const src = lines[line - 1] ?? '';
    const lineStart = t.lastIndexOf('\n', start - 1) + 1;
    const context = (src.slice(0, start - lineStart) + '$' + src.slice(end - lineStart)).trim();
    reads.push({ file, line, name, form, context });
  };
  const fail = (index, what) => unresolved.push({ file, line: lineOf(t, index), what });
  const flow = (index, dest, what) => {
    const hit = flows.find((f) => f.file === file && f.dest === dest);
    if (hit) used.flows.add(`${file}|${dest}`);
    else fail(index, what);
  };

  for (const m of t.matchAll(RECEIVER)) {
    const recvStart = m.index;
    const recvEnd = m.index + m[0].length;
    if (inNonCode(t, recvStart)) continue;
    if (/import\s*\.\s*meta\s*\.\s*$/.test(t.slice(Math.max(0, recvStart - 20), recvStart))) continue;
    const viaProcess = /\bprocess\s*\??\.\s*$/.exec(t.slice(Math.max(0, recvStart - 20), recvStart));
    const start = viaProcess ? recvStart - viaProcess[0].length : recvStart;
    const rest = t.slice(recvEnd);

    // the chain this access hangs off, to see a `delete` in front of it
    const chain = /(?:[\w$#]+\s*\??\.\s*)*$/.exec(t.slice(0, start))[0];
    const deleted = /\bdelete\s+$/.test(t.slice(0, start - chain.length));
    const assigned = (end) => /^\s*=(?![=>])/.test(t.slice(end));
    const form = viaProcess ? 'direct' : 'injected';

    const member = new RegExp(`^\\s*\\??\\.\\s*(${IDENT})`).exec(rest);
    if (member) {
      const end = recvEnd + member[0].length;
      if (deleted || assigned(end)) continue;
      if (/^[A-Z]/.test(member[1])) note(start, end, member[1], form);
      else if (LIST_MEMBERS.has(member[1])) continue;
      else fail(start, `${t.slice(start, end).replace(/\s+/g, ' ')} (lowercase member)`);
      continue;
    }
    const element = /^\s*\??\.?\s*\[\s*([^\]]*?)\s*\]/.exec(rest);
    if (element) {
      const end = recvEnd + element[0].length;
      if (deleted || assigned(end)) continue;
      const expr = element[1];
      const literal = /^(['"])([A-Za-z_]\w*)\1$/.exec(expr);
      if (literal) { note(start, end, literal[2], form); continue; }
      if (new RegExp(`^${IDENT}$`).test(expr) && consts.get(expr)) { note(start, end, consts.get(expr), 'const'); continue; }
      const ind = indirect.find((e) => e.file === file && e.expr === expr);
      if (ind) {
        used.indirect.add(`${file}|${expr}`);
        for (const name of ind.names) note(start, end, name, 'indirect');
        continue;
      }
      fail(start, `${t.slice(start, end).replace(/\s+/g, ' ')} (unresolved element)`);
      continue;
    }

    const parts = destructureBefore(t, start);
    if (parts) {
      for (const p of parts) {
        if (p.computed) fail(start, 'destructure computed key');
        else if (p.rest !== undefined) {
          if (!ENV_SUFFIX.test(p.rest)) flow(start, `rest:${p.rest}`, `destructure rest "${p.rest}" of an env`);
        } else if (!p.alias.startsWith('_')) note(start, recvEnd, p.key, viaProcess ? 'direct' : 'injected');
      }
      continue;
    }
    // A bare injected env is only followed when it is bound (`x = env`): any other
    // use of an `...env` identifier is a type, a parameter or a field, not a value flow.
    // A string constant (`const X_ENV = 'NAME'`) names a variable; it is not an env object.
    if (!viaProcess && consts.get(m[1])) continue;
    if (!viaProcess && !/(?<![=!<>])=\s*$/.test(t.slice(Math.max(0, start - 8), start))) continue;
    const dest = destination(t, start);
    if (dest !== null && !dest.startsWith('call:') && ENV_SUFFIX.test(dest)) continue;
    flow(start, dest ?? '?', `${viaProcess ? 'process.env' : t.slice(start, recvEnd)} as a value (${dest ?? 'unknown destination'})`);
  }
  return { reads, unresolved, used };
}

export function scanFiles(sources, { indirect = INDIRECT, flows = FLOWS, scope = PRODUCTION } = {}) {
  const files = [...sources.keys()].filter(scope).sort();
  const blanked = files.map((f) => blankNonCode(sources.get(f)));
  const consts = collectConsts(blanked);
  const derived = deriveIndirect(indirect, (f) => sources.get(f));
  const reads = [];
  const unresolved = [];
  const usedIndirect = new Set();
  const usedFlows = new Set();
  for (const f of files) {
    const r = scanSource(f, sources.get(f), { consts, indirect: derived, flows });
    reads.push(...r.reads);
    unresolved.push(...r.unresolved);
    r.used.indirect.forEach((k) => usedIndirect.add(k));
    r.used.flows.forEach((k) => usedFlows.add(k));
  }
  const staleIndirect = indirect.filter((e, i) => !usedIndirect.has(`${e.file}|${e.expr}`) || derived[i].names.length === 0)
    .map((e) => `${e.file} ${e.expr}`);
  const staleFlows = flows.filter((f) => !usedFlows.has(`${f.file}|${f.dest}`)).map((f) => `${f.file} ${f.dest}`);
  return { files, reads, names: new Set(reads.map((r) => r.name)), unresolved, staleIndirect, staleFlows };
}

export function trackedFiles(root, re) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0').filter((f) => f && re.test(f) && fs.statSync(path.join(root, f), { throwIfNoEntry: false })?.isFile());
}

export function scanRepo(root, opts) {
  const sources = new Map(trackedFiles(root, CODE).map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
  return scanFiles(sources, opts);
}

export function docsTableNames(markdown) {
  const out = [];
  const lines = markdown.split('\n');
  const head = lines.findIndex((l) => /^\|\s*Var\s*\|\s*Effect\s*\|\s*$/.test(l));
  if (head < 0) return out;
  for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const first = lines[i].slice(1).split(/(?<!\\)\|/)[0];
    for (const m of first.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) out.push(m[1]);
  }
  return out;
}

async function main(argv) {
  const docsAt = argv.indexOf('--docs');
  if (docsAt < 0 || !argv[docsAt + 1]) throw new Error('usage: env-reads.mjs --docs <path> [--dump]');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const scan = scanRepo(root);
  if (argv.includes('--dump')) {
    const rows = scan.reads.map((r) => `${r.file}\t${r.name}\t${r.form}\t${r.context}`).sort();
    console.log(rows.join('\n'));
    return;
  }
  const registryFile = path.join(root, 'src', 'env.ts');
  const registry = fs.existsSync(registryFile) ? (await import(pathToFileURL(registryFile).href)).ENV_VARS : {};
  const documented = new Set(docsTableNames(fs.readFileSync(path.join(root, argv[docsAt + 1]), 'utf8')));
  const names = [...scan.names].sort();
  const undocumented = names.filter((n) => !documented.has(n));
  const unregistered = names.filter((n) => !(n in registry));
  console.log(`files scanned: ${scan.files.length}`);
  console.log(`env names read: ${names.length}`);
  console.log(`undocumented: ${undocumented.length} ${undocumented.join(' ')}`.trimEnd());
  console.log(`unregistered: ${unregistered.length} ${unregistered.join(' ')}`.trimEnd());
  console.log(`unresolved: ${scan.unresolved.length}`);
  for (const u of scan.unresolved) console.log(`  ${u.file}:${u.line} ${u.what}`);
  console.log(`stale allow-list entries: ${scan.staleIndirect.length + scan.staleFlows.length}`);
  for (const s of [...scan.staleIndirect, ...scan.staleFlows]) console.log(`  ${s}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
