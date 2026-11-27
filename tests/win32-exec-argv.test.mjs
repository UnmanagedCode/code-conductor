// Lossless argv on Windows. `{argv}` specs reach Git for Windows' MSYS tools
// (bash/sh/env) and native programs through one raw command line, and each
// side re-parses it by its own rules, so the encoder depends on the target.
//
// The pure half runs on every host against test-local decoders of the two
// parsers; the win32 block runs the real thing through runHostExec.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as win32 from '../src/platform/win32.ts';
import { mkdtemp } from './tmpRegistry.mjs';
import { runHostExec } from '../src/hostExec.ts';
import { hostPlatform } from '../src/platform/index.ts';

// The reporter's list, then the cases that separate the two encoders and the
// other MSYS triggers (glob, brace, tilde, @file, non-ASCII, whitespace).
const ARGS = [
  'HEAD^{commit}', '{a,b}.txt', "it's", 'a"b', 'C:\\x\\{y}', 'Win*', 'p\\q\\', 'a b{c}', '',
  'a\\\\b', '\\\\srv\\share\\x', 'x\\\\"y', 'q\\\\', '~', '~/x', '@argfile', '*', 'ü€',
  'tab\there', 'line1\nline2', '%PATH%', '$HOME',
];

// CommandLineToArgvW / post-2008 MSVCRT rules, for the text after argv[0].
function decodeMsvcrt(tail) {
  const out = [];
  let i = 0;
  const n = tail.length;
  for (;;) {
    while (i < n && (tail[i] === ' ' || tail[i] === '\t')) i++;
    if (i >= n) break;
    let cur = '';
    let inQuote = false;
    while (i < n && (inQuote || (tail[i] !== ' ' && tail[i] !== '\t'))) {
      const c = tail[i];
      if (c === '\\') {
        let k = 0;
        while (tail[i + k] === '\\') k++;
        if (tail[i + k] === '"') {
          cur += '\\'.repeat(Math.floor(k / 2));
          if (k % 2) { cur += '"'; i += k + 1; } else { inQuote = !inQuote; i += k + 1; }
        } else { cur += '\\'.repeat(k); i += k; }
      } else if (c === '"') {
        if (inQuote && tail[i + 1] === '"') { cur += '"'; i += 2; } else { inQuote = !inQuote; i++; }
      } else { cur += c; i++; }
    }
    out.push(cur);
  }
  return out;
}

// A port of the MSYS runtime's command-line re-parse (git-for-windows/
// msys2-runtime, winsup/cygwin/dcrt0.cc: `build_argv` → `quoted` → `globify`)
// for a program whose parent is not an MSYS process and whose globbing is on:
// inside a quoted word a backslash before `\` or `"` is consumed and the next
// character is literal; every other character is literal. Scoped to words
// wholly inside one pair of quotes — unquoted content is where globbing and
// @file expansion happen, so it throws.
function decodeMsys(tail) {
  const out = [];
  let i = 0;
  const n = tail.length;
  for (;;) {
    while (i < n && /\s/.test(tail[i])) i++;
    if (i >= n) break;
    if (tail[i] !== '"') throw new Error(`unquoted word at ${i}: ${JSON.stringify(tail.slice(i, i + 12))}`);
    i++;
    let cur = '';
    for (;;) {
      if (i >= n) throw new Error('unterminated quote');
      const c = tail[i];
      if (c === '\\' && (tail[i + 1] === '\\' || tail[i + 1] === '"')) { cur += tail[i + 1]; i += 2; }
      else if (c === '"') { i++; break; }
      else { cur += c; i++; }
    }
    if (i < n && !/\s/.test(tail[i])) throw new Error('text glued to a closing quote');
    out.push(cur);
  }
  return out;
}

test('msvcrtQuote: every argument is wrapped in quotes, the empty string included', () => {
  assert.equal(win32.msvcrtQuote(''), '""');
  for (const a of ARGS) {
    const q = win32.msvcrtQuote(a);
    assert.ok(q.startsWith('"') && q.endsWith('"') && q.length >= 2, JSON.stringify(a));
  }
});

test('msvcrtQuote: backslashes double only before a quote or at the end', () => {
  assert.equal(win32.msvcrtQuote('a"b'), '"a\\"b"');
  assert.equal(win32.msvcrtQuote('p\\q\\'), '"p\\q\\\\"');
  assert.equal(win32.msvcrtQuote('x\\\\"y'), '"x\\\\\\\\\\"y"');
  assert.equal(win32.msvcrtQuote('a\\\\b'), '"a\\\\b"');
});

test('msvcrtQuote round-trips every argument through a CommandLineToArgvW decoder', () => {
  assert.deepEqual(decodeMsvcrt(ARGS.map(win32.msvcrtQuote).join(' ')), ARGS);
});

test('msysQuote round-trips every argument through the MSYS build_argv/globify decoder', () => {
  assert.deepEqual(decodeMsys(ARGS.map(win32.msysQuote).join(' ')), ARGS);
});

test('msvcrtQuote is not lossless under MSYS: each pair of backslashes collapses to one', () => {
  assert.deepEqual(decodeMsys(win32.msvcrtQuote('a\\\\b')), ['a\\b']);
  assert.deepEqual(decodeMsys(win32.msvcrtQuote('\\\\srv\\share\\x')), ['\\srv\\share\\x']);
});

describe('host exec argv round trip on win32 (Git for Windows)', { skip: process.platform !== 'win32' && 'win32 only' }, () => {
  let cwd;
  const caps = { capabilities: hostPlatform.capabilities };
  const run = async (spec) => {
    const r = await runHostExec({ system: 'local', cwd, ...spec }, caps);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.exitCode, 0, JSON.stringify(r.body));
    return r.body;
  };
  const bracket = (xs) => xs.map(a => `<${a}>`).join('');

  const seed = async () => {
    cwd = await mkdtemp('cc-win32-argv-');
    for (const f of ['a.txt', 'b.txt', 'Windows.txt']) await fs.writeFile(path.join(cwd, f), '');
  };

  test('sh -c printf round-trips every argument byte-exact', async () => {
    await seed();
    const b = await run({ argv: ['sh', '-c', 'printf "<%s>" "$@"', 'sh', ...ARGS] });
    assert.equal(b.stdout, bracket(ARGS));
  });

  test('env NAME=value sh -c printf round-trips every argument byte-exact', async () => {
    await seed();
    const b = await run({ argv: ['env', 'A=1', 'sh', '-c', 'printf "<%s>" "$A" "$@"', 'sh', ...ARGS] });
    assert.equal(b.stdout, '<1>' + bracket(ARGS));
  });

  test('shell form: bash -lc keeps backslash runs, braces and quotes', async () => {
    await seed();
    const b = await run({ shell: `printf '<%s>' 'a\\\\b' '\\\\srv\\share' "{a,b}" 'it'"'"'s'` });
    assert.equal(b.stdout, '<a\\\\b><\\\\srv\\share><{a,b}><it\'s>');
  });

  test('native: node -e prints its argv as JSON, byte-exact', async () => {
    await seed();
    const b = await run({ argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...ARGS] });
    assert.deepEqual(JSON.parse(b.stdout), ARGS);
  });

  test('git rev-parse HEAD^{commit} through sh -c exec "$@" finds the commit', async () => {
    await seed();
    const git = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x').status, 0);
    const b = await run({ argv: ['sh', '-c', 'exec "$@"', 'sh', 'git', 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'] });
    assert.equal(b.stdout.trim(), git('rev-parse', 'HEAD').stdout.trim());
  });
});
