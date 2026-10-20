// The command-spec transforms behind a Buffer `stdin` and an `envOverlay` on a
// provider System (src/systems/execWrap.ts).
//
// Every spec shape is RUN, under the real /bin/sh and `bash -lc` of this
// machine through the in-process runner, rather than compared as strings: the
// claims are about what a shell does with the wrapper, not what it looks like.
// The pre-check rows compare against an UNWRAPPED local spawn of the same argv,
// which is the behaviour the wrapper exists to reproduce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LocalSystem } from '../src/systems/localSystem.ts';
import {
  ENV_NAME_RE, argvWrapper, assertEnvOverlay, shQuote, shellWithPrelude, unwrapResult,
} from '../src/systems/execWrap.ts';
import { rmrf } from './rmrf.mjs';
import { mkdtemp } from './tmpRegistry.mjs';

const NONCE = '0123456789abcdef0123456789abcdef';
const sys = new LocalSystem();

async function withDir(fn) {
  const dir = await fs.realpath(await mkdtemp('cc-exec-wrap-'));
  try { return await fn(dir); } finally { await rmrf(dir); }
}

const run = (spec, cwd = '/') => sys.exec(spec, { cwd, stdin: 'ignore', timeoutMs: 10_000 });

// PINS: an argv overlay ADDS to the environment and OVERRIDES an inherited
// name, while the rest of the environment (PATH) survives — and a value with
// spaces, quotes and `$` arrives verbatim.
test('argvWrapper: the overlay adds, overrides, keeps PATH, and is verbatim', async () => {
  const value = `a b 'c' "d" $HOME`;
  const r = await run({ argv: argvWrapper(['sh', '-c', 'printf "%s|%s|%s" "$NEWV" "$HOME" "${PATH:+set}"'], {
    envOverlay: { NEWV: value, HOME: '/overridden' }, nonce: NONCE,
  }) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${value}|/overridden|set`);
});

// PINS: the shell prelude exports the overlay verbatim (shQuote holds), AFTER
// the login profile, so the caller's value is what the command sees.
test('shellWithPrelude: exported values arrive verbatim in bash -lc', async () => {
  const value = `it's "q" $X \\ end`;
  const r = await run({ shell: shellWithPrelude('printf "%s|%s" "$NEWV" "$HOME"', { envOverlay: { NEWV: value, HOME: '/h2' } }) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${value}|/h2`);
});

// PINS: with a staged stdin path, the command reads the file's bytes on fd 0,
// and the file is ALREADY GONE by the time the command runs — both wrappers.
test('both wrappers: stdin arrives and the staged file is unlinked before the command runs', async () => {
  await withDir(async (dir) => {
    const probe = 'cat; if [ -e "$F" ]; then echo PRESENT; else echo GONE; fi';
    for (const shape of ['argv', 'shell']) {
      const f = path.join(dir, `stdin-${shape}`);
      await fs.writeFile(f, 'line1\nline2\n');
      const spec = shape === 'argv'
        ? { argv: argvWrapper(['sh', '-c', probe], { envOverlay: { F: f }, stdinPath: f, nonce: NONCE }) }
        : { shell: shellWithPrelude(probe, { envOverlay: { F: f }, stdinPath: f, nonce: NONCE }) };
      const r = await run(spec);
      assert.equal(r.code, 0, `${shape}: ${r.stderr}`);
      assert.equal(r.stdout, 'line1\nline2\nGONE\n', shape);
      await assert.rejects(fs.stat(f), { code: 'ENOENT' }, `${shape}: the file is gone afterwards`);
    }
  });
});

// PINS: a staged stdin file that cannot be opened is reported as the wrapper's
// own one-line ESTDIN marker, which unwrapResult turns into a never-started
// result — the command does not run.
test('both wrappers: an unopenable stdin path is ESTDIN and the command never runs', async () => {
  for (const shape of ['argv', 'shell']) {
    const missing = `/nonexistent-cc-stdin-${shape}`;
    const spec = shape === 'argv'
      ? { argv: argvWrapper(['echo', 'RAN'], { stdinPath: missing, nonce: NONCE }) }
      : { shell: shellWithPrelude('echo RAN', { stdinPath: missing, nonce: NONCE }) };
    const r = unwrapResult(await run(spec), NONCE, shape === 'argv' ? 'echo' : 'sh');
    assert.equal(r.spawnError, `spawn ${shape === 'argv' ? 'echo' : 'sh'} ESTDIN`, shape);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '', `${shape}: the command did not run`);
  }
});

// PINS: the argv pre-check reports what an unwrapped local spawn reports for
// the same argv[0]: a missing bare name and a builtin-only name (`cd`) are
// ENOENT, a missing path is ENOENT, a directory and a non-executable file are
// EACCES — and a name that is BOTH a builtin and a binary (`echo`) runs.
test('argvWrapper pre-check agrees with local spawn on argv[0]', async () => {
  await withDir(async (dir) => {
    const plain = path.join(dir, 'plain.txt');
    await fs.writeFile(plain, 'x', { mode: 0o644 });
    const cases = [
      ['cc-definitely-not-a-binary', 'ENOENT'],
      ['cd', 'ENOENT'],
      [path.join(dir, 'missing'), 'ENOENT'],
      [dir, 'EACCES'],
      [plain, 'EACCES'],
    ];
    for (const [argv0, errno] of cases) {
      const raw = await run({ argv: [argv0] }, dir);
      assert.match(raw.spawnError ?? '', new RegExp(`\\b${errno}\\b`), `local spawn of ${argv0}`);
      const r = unwrapResult(await run({ argv: argvWrapper([argv0], { nonce: NONCE }) }, dir), NONCE, argv0);
      assert.equal(r.spawnError, `spawn ${argv0} ${errno}`, argv0);
      assert.equal(r.spawnErrorCode, errno, argv0);
      assert.equal(r.code, 1);
    }
    const ok = unwrapResult(await run({ argv: argvWrapper(['echo', 'hi'], { nonce: NONCE }) }), NONCE, 'echo');
    assert.equal(ok.spawnError, null);
    assert.equal(ok.stdout, 'hi\n');
  });
});

// PINS: a bare name resolves through PATH the way local spawn's execvp does,
// measured against an unwrapped local spawn on the same PATH: only
// non-executable candidates (a 0644 file, a directory) are EACCES — never a
// run, never ENOENT — while an executable candidate anywhere on PATH runs,
// whichever side of a non-executable one it sits.
test('argvWrapper pre-check: non-executable PATH candidates agree with local spawn', async () => {
  await withDir(async (dir) => {
    const name = 'cc-pathprobe';
    const nonexec = path.join(dir, 'nonexec');
    const exec = path.join(dir, 'exec');
    const dirhit = path.join(dir, 'dirhit');
    await fs.mkdir(nonexec); await fs.mkdir(exec); await fs.mkdir(path.join(dirhit, name), { recursive: true });
    await fs.writeFile(path.join(nonexec, name), '#!/bin/sh\necho nonexec-ran\n', { mode: 0o644 });
    await fs.writeFile(path.join(exec, name), '#!/bin/sh\necho exec-ran\n', { mode: 0o755 });
    const local = (PATH) => sys.exec({ argv: [name] }, { cwd: dir, stdin: 'ignore', env: { ...process.env, PATH } });
    const wrapped = async (PATH) => unwrapResult(
      await run({ argv: argvWrapper([name], { envOverlay: { PATH }, nonce: NONCE }) }, dir), NONCE, name);
    for (const PATH of [nonexec, dirhit, `${nonexec}:${dirhit}`]) {
      assert.match((await local(PATH)).spawnError ?? '', /\bEACCES\b/, `local spawn, PATH=${PATH}`);
      const r = await wrapped(PATH);
      assert.equal(r.spawnError, `spawn ${name} EACCES`, `PATH=${PATH}`);
      assert.equal(r.spawnErrorCode, 'EACCES');
      assert.equal(r.stdout, '', 'the non-executable candidate never ran');
    }
    for (const PATH of [`${nonexec}:${exec}`, `${exec}:${nonexec}`]) {
      assert.equal((await local(PATH)).stdout, 'exec-ran\n', `local spawn, PATH=${PATH}`);
      const r = await wrapped(PATH);
      assert.equal(r.spawnError, null, `PATH=${PATH}`);
      assert.equal(r.stdout, 'exec-ran\n', `PATH=${PATH}`);
    }
  });
});

// PINS: the wrapper replaces itself with the command, so a command's own exit
// code — including 127 from a command that prints its own stderr — passes
// through as the command's.
test('argvWrapper: the command exit code and streams pass through', async () => {
  const r = unwrapResult(await run({ argv: argvWrapper(['sh', '-c', 'echo out; echo err >&2; exit 127'], { nonce: NONCE }) }), NONCE, 'sh');
  assert.equal(r.code, 127);
  assert.equal(r.spawnError, null);
  assert.equal(r.stdout, 'out\n');
  assert.equal(r.stderr, 'err\n');
});

function result(over) {
  return {
    code: 127, stdout: '', stderr: `${NONCE} ENOENT\n`, output: `${NONCE} ENOENT\n`,
    timedOut: false, truncated: false, durationMs: 3, spawnError: null, ...over,
  };
}

// PINS: unwrapResult maps ONLY an exact, nonce-bearing, sole stderr line from
// one of the wrapper's exit codes with an empty stdout; a forged nonce, extra
// stderr, any stdout, another exit code or a timeout all pass through untouched.
test('unwrapResult: only the exact nonce line is a wrapper failure', () => {
  const hit = unwrapResult(result({}), NONCE, 'git');
  assert.equal(hit.spawnError, 'spawn git ENOENT');
  assert.equal(hit.spawnErrorCode, 'ENOENT');
  assert.equal(hit.stderr, 'spawn git ENOENT');
  assert.equal(hit.code, 1);
  const forged = 'ffffffffffffffffffffffffffffffff';
  const untouched = [
    result({ stderr: `${forged} ENOENT\n` }),
    result({ stderr: `${NONCE} ENOENT\nmore\n` }),
    result({ stderr: `noise\n${NONCE} ENOENT\n` }),
    result({ stdout: 'x' }),
    result({ code: 1 }),
    result({ timedOut: true }),
  ];
  for (const r of untouched) assert.equal(unwrapResult(r, NONCE, 'git'), r);
});

// PINS: in byte mode the marker is read from stderrBytes and the unwrapped
// result carries empty Buffers.
test('unwrapResult: byte mode reads the marker from stderrBytes', () => {
  const r = unwrapResult(result({
    stderr: '', output: '', stdoutBytes: Buffer.alloc(0), stderrBytes: Buffer.from(`${NONCE} EACCES\n`),
  }), NONCE, '/x');
  assert.equal(r.spawnErrorCode, 'EACCES');
  assert.deepEqual(r.stdoutBytes, Buffer.alloc(0));
  assert.deepEqual(r.stderrBytes, Buffer.alloc(0));
});

// PINS: an overlay with an invalid name or a NUL value is cc's bug and throws.
test('assertEnvOverlay refuses a bad name and a NUL value', () => {
  for (const name of ['1A', 'A-B', 'A B', '', 'A=B']) {
    assert.equal(ENV_NAME_RE.test(name), false, name);
    assert.throws(() => assertEnvOverlay({ [name]: 'v' }), /envOverlay name/, name);
  }
  assert.throws(() => assertEnvOverlay({ OK: 'a\0b' }), /without NUL/);
  assert.doesNotThrow(() => assertEnvOverlay({ _A1: 'x', GIT_INDEX_FILE: '/tmp/i' }));
});

// PINS: shQuote round-trips arbitrary text through a shell word.
test('shQuote survives single quotes and shell metacharacters', async () => {
  const s = `a'b"c $d \`e\` \\f`;
  const r = await run({ argv: ['sh', '-c', `printf %s ${shQuote(s)}`] });
  assert.equal(r.stdout, s);
});
