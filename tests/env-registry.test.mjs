// Every environment variable production code reads is registered in ENV_VARS
// (src/env.ts), the docs table matches the registry, and the default port is
// defined once. The scanner is scripts/env-reads.mjs; the G rows pin its
// grammar on fixtures, the R rows hold the real tree to the registry, the P
// rows hold the port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from './importCycles.mjs';
import {
  scanSource, scanFiles, scanRepo, collectConsts, deriveIndirect, docsTableNames, trackedFiles, CODE, INDIRECT,
} from '../scripts/env-reads.mjs';
import { ENV_VARS, DEFAULT_PORT } from '../src/env.ts';
import { entryStartOptions } from '../server.ts';
import { portOf } from '../bin/windows-launch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scan = (src, opts) => scanSource('fx/a.ts', src, opts);
const names = (src, opts) => scan(src, opts).reads.map((r) => r.name).sort();
const real = scanRepo(root);
const keys = Object.keys(ENV_VARS);
const READ_KINDS = new Set(['knob', 'internal', 'platform']);

// G1: a member read of process.env, however spelled, is a read of that name.
test('G1: process.env member reads are reads of that name', () => {
  const r = scan(`process.env.A; process.env?.B; process.env['C']; process.env["D"]; process.env.Q ??= 'x';`);
  assert.deepEqual(r.reads.map((x) => x.name), ['A', 'B', 'C', 'D', 'Q']);
  assert.ok(r.reads.every((x) => x.form === 'direct'));
  assert.deepEqual(r.unresolved, []);
});

// G2: an element read resolves through a string constant, and refuses an ambiguous one.
test('G2: process.env[CONST] resolves through the constant; a constant with two values is unresolved', () => {
  const ok = scan('process.env[K];', { consts: collectConsts(['const K = "B";']) });
  assert.deepEqual(ok.reads.map((x) => [x.name, x.form]), [['B', 'const']]);
  const clash = scan('process.env[K];', { consts: collectConsts(['const K = "B";', 'const K = "X";']) });
  assert.deepEqual(clash.reads, []);
  assert.equal(clash.unresolved.length, 1);
});

// G3: an injected env (any receiver named ...env) is read the same way.
test('G3: env.X, spec.env.X, baseEnv.X and env["X"] are injected reads', () => {
  const r = scan(`env.C; spec.env.D; baseEnv.E; env['F']; this.#launch.env.G;`);
  assert.deepEqual(r.reads.map((x) => x.name), ['C', 'D', 'E', 'F', 'G']);
  assert.ok(r.reads.every((x) => x.form === 'injected'));
});

// G4: writes, deletes, stripping destructures and whole-env passthrough are not reads and not unresolved.
test('G4: writes, deletes, stripping destructures and env-to-env flows are neither reads nor unresolved', () => {
  const src = [
    `env.X = 1; process.env.Y = 'a'; spawnEnv.Z = 'b';`,
    `delete env[k]; delete spawnEnv.W; delete process.env.V;`,
    `const { A: _a, ...restEnv } = process.env;`,
    `const env = { ...process.env };`,
    `function f(env = process.env) {}`,
    `g({ cwd, env: process.env, programEnv: {} });`,
    `const o = { env: next ? { ...process.env, K: next } : process.env };`,
    `const baseEnv = (x.env as T) ?? process.env;`,
    `const NO_PROMPT_GIT_ENV = { ...process.env, A: '1' };`,
    `const env: Win32Env = process.env;`,
    `const n = b.env.length; b.env.map((e) => e);`,
  ].join('\n');
  const r = scan(src);
  assert.deepEqual(r.reads, []);
  assert.deepEqual(r.unresolved, []);
});

// G5: a destructure with a real binding is a read of that key.
test('G5: const { D } = process.env reads D', () => {
  const r = scan(`const { D, E: e2, F: _f } = process.env;`);
  assert.deepEqual(r.reads.map((x) => x.name), ['D', 'E']);
  assert.deepEqual(r.unresolved, []);
});

// G6: a form the grammar cannot resolve is reported, never passed silently.
test('G6: unknown element, property element, aliased env, call argument, return, rest and lowercase member are unresolved', () => {
  const cases = {
    'unknown element': 'process.env[k];',
    'property element': 'process.env[a.b];',
    'aliased env': 'const vars = process.env;',
    'call argument': 'f(process.env);',
    'returned spread': 'function g() { return { ...process.env }; }',
    'destructure rest': 'const { ...rest } = process.env;',
    'lowercase member': 'env.foo;',
  };
  for (const [label, src] of Object.entries(cases)) {
    const r = scan(src);
    assert.equal(r.unresolved.length, 1, `${label}: ${src}`);
    assert.deepEqual(r.reads, [], label);
  }
});

// G7: only code is read.
test('G7: comments, template text and path-like strings hold no reads', () => {
  const r = scan([
    '// process.env.A',
    '/* env.B */',
    'const s = `process.env.C`;',
    `import x from './cliEnv.ts'; w.join('usr', 'bin', 'env.exe');`,
  ].join('\n'));
  assert.deepEqual(r.reads, []);
  assert.deepEqual(r.unresolved, []);
});

// G8: the allow-lists derive names, silence only their own site, and go stale loudly.
test('G8: INDIRECT derives names from key literals; FLOWS silences one (file, dest); unmatched entries are stale', () => {
  const sources = new Map([
    ['fx/a.ts', 'process.env[hook.v];'],
    ['fx/b.ts', `const H = { x: { v: 'N1' }, y: { v: "N2" } };`],
    ['fx/c.ts', 'const x = f(process.env);'],
    ['fx/d.ts', 'const x = f(process.env);'],
  ]);
  const scope = (f) => f.startsWith('fx/');
  const indirect = [{ file: 'fx/a.ts', expr: 'hook.v', from: [{ file: 'fx/b.ts', key: 'v' }], why: 't' }];
  const flows = [{ file: 'fx/c.ts', dest: 'call:f', why: 't' }];
  const r = scanFiles(sources, { indirect, flows, scope });
  assert.deepEqual([...r.names].sort(), ['N1', 'N2']);
  assert.deepEqual(r.unresolved.map((u) => u.file), ['fx/d.ts']);
  assert.deepEqual([r.staleIndirect, r.staleFlows], [[], []]);

  const stale = scanFiles(sources, {
    indirect: [
      { file: 'fx/none.ts', expr: 'q', from: [{ file: 'fx/b.ts', key: 'v' }], why: 't' },
      { file: 'fx/a.ts', expr: 'hook.v', from: [{ file: 'fx/b.ts', key: 'absent' }], why: 't' },
    ],
    flows: [{ file: 'fx/none.ts', dest: 'return', why: 't' }],
    scope,
  });
  assert.deepEqual(stale.staleIndirect, ['fx/none.ts q', 'fx/a.ts hook.v']);
  assert.deepEqual(stale.staleFlows, ['fx/none.ts return']);
  assert.deepEqual(deriveIndirect(indirect, (f) => sources.get(f))[0].names, ['N1', 'N2']);
});

// G9: pins that an injected env aliased to a non-env name cannot hide reads
// (the same destination rule as a bare process.env), and that env-to-env flows stay quiet.
test('G9: a bare injected env bound to a non-env name is unresolved; bound to an env name it is not', () => {
  const alias = scan('const aliased = env; aliased.SOME_UNREGISTERED_VAR;');
  assert.equal(alias.unresolved.length, 1);
  assert.deepEqual(alias.reads, []);
  const ok = scan('const baseEnv = env; const o = { env: spec.env }; function f(env = other.env) {}');
  assert.deepEqual(ok.unresolved, []);
  assert.deepEqual(ok.reads, []);
  const named = scan("function g(v = LOCAL_ENV) {}", { consts: collectConsts(["const LOCAL_ENV = 'NAME';"]) });
  assert.deepEqual(named.unresolved, [], 'a string constant naming a variable is not an env object');
});

// G10: pins that a regex literal holding a quote does not make the rest of its
// line read as a string, and that its own contents are not code.
test('G10: a read after a quote-bearing regex literal on the same line is found; env text inside a regex is not', () => {
  const r = scan(`const q = /['"]/; const y = process.env.SILENT_MISS;`);
  assert.deepEqual(r.reads.map((x) => x.name), ['SILENT_MISS']);
  const inside = scan('const q = /process.env.NOT_A_READ/;');
  assert.deepEqual(inside.reads, []);
  assert.deepEqual(inside.unresolved, []);
  const division = scan('const z = a / b; const y = process.env.AFTER_DIVISION;');
  assert.deepEqual(division.reads.map((x) => x.name), ['AFTER_DIVISION']);
  // a regex after a value-position keyword is a regex, not a division
  for (const [label, src, name] of [
    ['return', `function f(){ return /['"]/.test(s) && process.env.DEBUG_FLAG; }`, 'DEBUG_FLAG'],
    ['case', `switch (x) { case /['"]/: y = process.env.CASE_AFTER; }`, 'CASE_AFTER'],
    ['typeof', `typeof /['"]/; const y = process.env.TYPEOF_AFTER;`, 'TYPEOF_AFTER'],
    ['throw', `throw /['"]/; process.env.THROW_AFTER;`, 'THROW_AFTER'],
    ['else', `if (a) b(); else /['"]/.test(s) && process.env.ELSE_AFTER;`, 'ELSE_AFTER'],
  ]) {
    assert.deepEqual(scan(src).reads.map((x) => x.name), [name], label);
  }
  const keywordRegexBody = scan('function f(){ return /process.env.NOT_A_READ/; }');
  assert.deepEqual(keywordRegexBody.reads, [], 'env text inside a regex after return');
  assert.deepEqual(keywordRegexBody.unresolved, []);
  // an identifier that merely ends in a keyword, or a member named like one, is still a division
  for (const src of ['const a = redo / 2; const y = process.env.DIV_REDO;', "const a = xin / y; const b = '/'; const y = process.env.DIV_XIN;", 'const a = o.return / 2; const y = process.env.DIV_MEMBER;']) {
    assert.deepEqual(scan(src).reads.map((x) => x.name).length, 1, src);
  }
});

// G11: pins that a computed destructure key is reported, not read as a name.
test('G11: const { [K]: v } = process.env is unresolved and emits no read', () => {
  const r = scan('const { [K2]: v } = process.env;');
  assert.deepEqual(r.reads, []);
  assert.deepEqual(r.unresolved.map((u) => u.what), ['destructure computed key']);
});

const sitesOf = (name) => real.reads.filter((r) => r.name === name).map((r) => `${r.file}:${r.line}`).join(', ');

// R1: the registry holds every name production code reads.
test('R1: every env name production code reads is an ENV_VARS key', () => {
  const missing = [...real.names].filter((n) => !(n in ENV_VARS)).sort();
  assert.deepEqual(missing, [], `unregistered env reads (add to ENV_VARS in src/env.ts):\n${missing.map((n) => `  ${n} <- ${sitesOf(n)}`).join('\n')}`);
});

// R2: a key's kind says whether production reads it.
test('R2: knob/internal/platform keys are read by production; exported/tooling keys are not', () => {
  const unread = keys.filter((k) => READ_KINDS.has(ENV_VARS[k].kind) && !real.names.has(k));
  const read = keys.filter((k) => !READ_KINDS.has(ENV_VARS[k].kind) && real.names.has(k));
  assert.deepEqual(unread, [], 'registered as read but production never reads it');
  assert.deepEqual(read, [], 'registered as not read but production reads it');
});

// R3: the scanner resolved everything and no allow-list entry is dead.
test('R3: no unresolved env access and no stale INDIRECT/FLOWS entry', () => {
  assert.deepEqual(real.unresolved.map((u) => `${u.file}:${u.line} ${u.what}`), []);
  assert.deepEqual([...real.staleIndirect, ...real.staleFlows], []);
});

// R4: the docs table and the registry name the same variables.
test('R4: the Var column of docs/environment.md equals the ENV_VARS keys', () => {
  const file = path.join(root, 'docs', 'environment.md');
  assert.ok(fs.existsSync(file), 'docs/environment.md exists');
  const documented = new Set(docsTableNames(fs.readFileSync(file, 'utf8')));
  assert.ok(documented.size > 0, 'docs/environment.md has a | Var | Effect | table');
  const registered = new Set(keys);
  assert.deepEqual([...registered].filter((k) => !documented.has(k)).sort(), [], 'in ENV_VARS, no row in docs/environment.md');
  assert.deepEqual([...documented].filter((k) => !registered.has(k)).sort(), [], 'a row in docs/environment.md, not in ENV_VARS');
});

// R5: a registered default is the fallback the reading code spells.
test('R5: a non-null default is spelled in a file that reads the name; exported/tooling defaults are null', () => {
  const code = new Map();
  const blankOf = (f) => {
    if (!code.has(f)) code.set(f, blankNonCode(fs.readFileSync(path.join(root, f), 'utf8')));
    return code.get(f);
  };
  const bad = [];
  for (const k of keys) {
    const { kind, default: dflt } = ENV_VARS[k];
    if (dflt === null) continue;
    if (!READ_KINDS.has(kind)) { bad.push(`${k}: ${kind} must have a null default`); continue; }
    const files = new Set();
    for (const r of real.reads.filter((x) => x.name === k)) {
      files.add(r.file);
      if (r.form === 'indirect') {
        for (const e of INDIRECT.filter((i) => i.file === r.file)) e.from.forEach((f) => files.add(f.file));
      }
    }
    if (![...files].some((f) => blankOf(f).includes(dflt))) bad.push(`${k}: default ${dflt} not spelled in ${[...files].join(', ')}`);
  }
  assert.deepEqual(bad, []);
});

// R6: the scan is not vacuous.
test('R6: the scan covers server.ts and finds reads', () => {
  assert.ok(real.files.includes('server.ts'));
  assert.ok(real.reads.length > 0);
});

// P1: both entry points fall back to DEFAULT_PORT.
test('P1: entryStartOptions and the Windows launcher default to DEFAULT_PORT', () => {
  assert.equal(entryStartOptions({}).port, DEFAULT_PORT);
  assert.equal(portOf({}), DEFAULT_PORT);
});

// P2: the port number is spelled in code only by src/env.ts.
test('P2: the default port literal appears in no production code outside src/env.ts', () => {
  const literal = new RegExp(`\\b${DEFAULT_PORT}\\b`);
  const offenders = trackedFiles(root, /^(?:server\.ts$|src\/|shared\/|bin\/)/)
    .filter((f) => CODE.test(f) && !/\.test\./.test(f) && f !== path.join('src', 'env.ts').split(path.sep).join('/'))
    .filter((f) => literal.test(blankNonCode(fs.readFileSync(path.join(root, f), 'utf8'))));
  assert.deepEqual(offenders, []);
});

// P3: the files that pin the port as text agree with the constant.
test('P3: docker files and the vite config spell DEFAULT_PORT the expected number of times', () => {
  const expected = {
    'docker/compose.yaml': 4,
    'docker/Makefile': 3,
    'docker/headless.sh': 1,
    'docker/.env.example': 2,
    'docker/entrypoint.sh': 1,
    'web/vite.config.ts': 1,
  };
  const literal = new RegExp(`\\b${DEFAULT_PORT}\\b`, 'g');
  const actual = Object.fromEntries(Object.keys(expected).map((f) => [f, (fs.readFileSync(path.join(root, f), 'utf8').match(literal) ?? []).length]));
  assert.deepEqual(actual, expected);
});
