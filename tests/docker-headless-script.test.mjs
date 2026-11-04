// docker/headless.sh — the one-shot `docker compose run` behind `make headless`
// — with a stub DOCKER_COMPOSE that records its argv and environment and exits
// with a chosen code, so no docker is needed. The script exits with that exact
// code, refuses a projects dir that is, sits inside or contains the main one
// and a prompt given twice or not at all (exit 2, compose never run), and
// builds the run: --rm -T, the home bind, the prompt mount, the optional port,
// tailscale and the deps sync off, the projects dir rebound.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from './tmpRegistry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_DIR = path.resolve(__dirname, '..', 'docker');
const SCRIPT = path.join(DOCKER_DIR, 'headless.sh');

function fixture(t) {
  const dir = fs.realpathSync(mkdtempSync('cc-headless-sh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  const run = path.join(dir, 'run');
  fs.mkdirSync(path.join(main, '.cc-home'), { recursive: true });
  fs.mkdirSync(run);
  const argvOut = path.join(dir, 'argv');
  const envOut = path.join(dir, 'env');
  const stub = path.join(dir, 'compose-stub');
  fs.writeFileSync(stub, [
    '#!/bin/sh',
    `printf '%s\\0' "$@" > ${JSON.stringify(argvOut)}`,
    `printf 'CC_PROJECTS_DIR=%s\\nCC_HOME_DIR=%s\\n' "$CC_PROJECTS_DIR" "$CC_HOME_DIR" > ${JSON.stringify(envOut)}`,
    'echo STUB-OUT',
    'exit "${STUB_EXIT:-0}"',
    '',
  ].join('\n'), { mode: 0o755 });
  const exec = (env, { cwd = dir } = {}) => {
    fs.rmSync(argvOut, { force: true });
    const r = spawnSync('bash', [SCRIPT], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        DOCKER_COMPOSE: stub,
        COMPOSE_FILES: '-f compose.yaml',
        CC_PROJECTS_DIR: main,
        CC_HEADLESS_PROJECTS_DIR: run,
        CC_HEADLESS_PROMPT: 'say hi',
        ...env,
      },
    });
    const called = fs.existsSync(argvOut);
    const argv = called ? fs.readFileSync(argvOut, 'utf8').split('\0').slice(0, -1) : null;
    const childEnv = called ? Object.fromEntries(fs.readFileSync(envOut, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2))) : null;
    return { status: r.status, stderr: r.stderr, argv, childEnv };
  };
  // A copy of docker/'s Makefile and script with its own .env, so make reads
  // this test's .env and never a developer's docker/.env.
  const makeDir = path.join(dir, 'docker');
  fs.mkdirSync(makeDir);
  for (const f of ['Makefile', 'headless.sh']) fs.copyFileSync(path.join(DOCKER_DIR, f), path.join(makeDir, f));
  fs.chmodSync(path.join(makeDir, 'headless.sh'), 0o755);
  const make = ({ dotenv = '', vars = [], cwd = dir, viaC = true, env = {} } = {}) => {
    fs.rmSync(argvOut, { force: true });
    fs.writeFileSync(path.join(makeDir, '.env'), dotenv);
    const r = spawnSync('make', [...(viaC ? ['-C', makeDir] : []), 'headless', `DOCKER_COMPOSE=${stub}`, ...vars], {
      cwd: viaC ? cwd : makeDir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
    });
    const called = fs.existsSync(argvOut);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, argv: called ? fs.readFileSync(argvOut, 'utf8').split('\0').slice(0, -1) : null };
  };
  return { dir, main, run, exec, make };
}
const HAS_MAKE = spawnSync('make', ['--version']).status === 0;

// The value following `flag` in argv, for each occurrence.
const valuesOf = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

test('the script exits with compose\'s exact code', async (t) => {
  const f = fixture(t);
  for (const code of [0, 3, 7, 130]) {
    assert.equal(f.exec({ STUB_EXIT: String(code) }).status, code);
  }
});

test('the run: compose run --rm -T on the conductor service, the home bound, tailscale and the deps sync off, the projects dir rebound', async (t) => {
  const f = fixture(t);
  const r = f.exec({}, { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.argv.slice(0, 2), ['-f', 'compose.yaml']);
  const runAt = r.argv.indexOf('run');
  assert.ok(runAt >= 0);
  const opts = r.argv.slice(runAt + 1, r.argv.indexOf('conductor'));
  assert.ok(opts.includes('--rm'));
  assert.ok(opts.includes('-T'));
  assert.deepEqual(valuesOf(opts, '-v'), [`${path.join(f.main, '.cc-home')}:/workspaces/cc-home`], 'the main login\'s home, no prompt mount');
  assert.deepEqual(valuesOf(opts, '-e').sort(), ['CC_SKIP_DEPS_SYNC=1', 'CC_WITH_TAILSCALE=0']);
  assert.deepEqual(valuesOf(opts, '-p'), [], 'nothing published without CC_HEADLESS_PORT');
  assert.deepEqual(r.argv.slice(r.argv.indexOf('conductor') + 1), ['--prompt', 'say hi']);
  assert.deepEqual(r.childEnv, { CC_PROJECTS_DIR: f.run, CC_HOME_DIR: '/workspaces/cc-home' });
});

test('a prompt with shell and make metacharacters reaches cc verbatim', async (t) => {
  const f = fixture(t);
  const prompt = 'cost $5 `id` "$(rm -rf /)" * ; done';
  const r = f.exec({ CC_HEADLESS_PROMPT: prompt });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.argv.slice(r.argv.indexOf('conductor') + 1), ['--prompt', prompt]);
});

test('a prompt file is mounted read-only at one fixed path; "-" mounts nothing and reads stdin', async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, 'prompt.md');
  fs.writeFileSync(file, 'from a file');
  const r = f.exec({ CC_HEADLESS_PROMPT: '', PROMPT_FILE: 'prompt.md', MODE: 'plan' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(valuesOf(r.argv, '-v').includes(`${file}:/run/cc-prompt:ro`), r.argv.join(' '));
  assert.deepEqual(r.argv.slice(r.argv.indexOf('conductor') + 1), ['--prompt-file', '/run/cc-prompt', '--mode', 'plan']);

  const s = f.exec({ CC_HEADLESS_PROMPT: '', PROMPT_FILE: '-' });
  assert.equal(s.status, 0, s.stderr);
  assert.ok(!valuesOf(s.argv, '-v').some((v) => v.endsWith(':/run/cc-prompt:ro')));
  assert.deepEqual(s.argv.slice(s.argv.indexOf('conductor') + 1), ['--prompt-file', '-']);
});

test('CC_HEADLESS_PORT publishes on CC_BIND and names the URL; CC_HEADLESS_HOME replaces the home', async (t) => {
  const f = fixture(t);
  const home = path.join(f.dir, 'home');
  fs.mkdirSync(home);
  const r = f.exec({ CC_HEADLESS_PORT: '8799', CC_BIND: '0.0.0.0', CC_HEADLESS_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(valuesOf(r.argv, '-p'), ['0.0.0.0:8799:8787']);
  assert.match(r.stderr, /also published at http:\/\/127\.0\.0\.1:8799/);
  assert.deepEqual(valuesOf(r.argv, '-v'), [`${home}:/workspaces/cc-home`]);
  const loop = f.exec({ CC_HEADLESS_PORT: '8799' });
  assert.deepEqual(valuesOf(loop.argv, '-p'), ['127.0.0.1:8799:8787']);
});

test('refusals exit 2 and never run compose', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.main, 'nested'));
  fs.symlinkSync(f.main, path.join(f.dir, 'main-link'));
  const cases = [
    ['no CC_HEADLESS_PROJECTS_DIR', { CC_HEADLESS_PROJECTS_DIR: '' }, /CC_HEADLESS_PROJECTS_DIR/],
    ['a dir that does not exist', { CC_HEADLESS_PROJECTS_DIR: path.join(f.dir, 'nope') }, /not an existing directory/],
    ['the main projects dir itself', { CC_HEADLESS_PROJECTS_DIR: f.main }, /is the main projects dir/],
    ['the main projects dir through a symlink', { CC_HEADLESS_PROJECTS_DIR: path.join(f.dir, 'main-link') }, /is the main projects dir/],
    ['a dir inside the main one', { CC_HEADLESS_PROJECTS_DIR: path.join(f.main, 'nested') }, /inside the main projects dir/],
    ['a dir containing the main one', { CC_HEADLESS_PROJECTS_DIR: f.dir }, /contains the main projects dir/],
    ['both PROMPT and PROMPT_FILE', { PROMPT_FILE: '-' }, /not both/],
    ['neither PROMPT nor PROMPT_FILE', { CC_HEADLESS_PROMPT: '' }, /PROMPT or PROMPT_FILE/],
    ['a PROMPT_FILE that is not a file', { CC_HEADLESS_PROMPT: '', PROMPT_FILE: 'missing.md' }, /not a file/],
    ['a CC_HEADLESS_HOME that is not a directory', { CC_HEADLESS_HOME: path.join(f.dir, 'no-home') }, /CC_HEADLESS_HOME .*no-home.* is not an existing directory/],
    ['a missing default home', { CC_PROJECTS_DIR: path.join(f.main, 'nested') }, /\$CC_PROJECTS_DIR\/\.cc-home .*nested\/\.cc-home.* is not an existing directory/],
    ['a CC_PROJECTS_DIR that does not resolve', { CC_PROJECTS_DIR: path.join(f.dir, 'gone') }, /CC_PROJECTS_DIR .*gone.* is not an existing directory/],
    ['the main projects dir, CC_PROJECTS_DIR quoted', { CC_PROJECTS_DIR: `"${f.main}"`, CC_HEADLESS_PROJECTS_DIR: f.main }, /is the main projects dir/],
  ];
  for (const [name, env, message] of cases) {
    await t.test(name, () => {
      const r = f.exec(env);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, message);
      assert.equal(r.argv, null, 'compose was not run');
    });
  }
});

test('make headless passes PROMPT unexpanded and collapses a failure to 2', { skip: !HAS_MAKE && 'no make' }, async (t) => {
  const f = fixture(t);
  const ok = f.make({ vars: [`CC_PROJECTS_DIR=${f.main}`, `CC_HEADLESS_PROJECTS_DIR=${f.run}`, 'PROMPT=cost $5 and $(shell id)'] });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.argv.slice(ok.argv.indexOf('conductor') + 1), ['--prompt', 'cost $5 and $(shell id)']);
  const failed = f.make({ vars: [`CC_PROJECTS_DIR=${f.main}`, `CC_HEADLESS_PROJECTS_DIR=${f.run}`, 'PROMPT=x'], env: { STUB_EXIT: '3' } });
  assert.equal(failed.status, 2);
});

// `make headless | jq` must see cc's stdout and nothing of make's: no echoed
// recipe, no Entering/Leaving directory lines — without -s, run in place or -C.
test('make headless adds nothing to stdout, run in docker/ or through -C', { skip: !HAS_MAKE && 'no make' }, async (t) => {
  const f = fixture(t);
  for (const viaC of [false, true]) {
    await t.test(viaC ? 'make -C docker headless' : 'make headless in docker/', () => {
      const r = f.make({ viaC, vars: [`CC_PROJECTS_DIR=${f.main}`, `CC_HEADLESS_PROJECTS_DIR=${f.run}`, 'PROMPT=hi'] });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'STUB-OUT\n');
    });
  }
});

// make's .env parsing keeps a value's quotes and the space before an inline
// comment; the guard must see through both, never skip.
for (const [name, line] of [
  ['a quoted CC_PROJECTS_DIR', (main) => `CC_PROJECTS_DIR="${main}"`],
  ["a single-quoted CC_PROJECTS_DIR", (main) => `CC_PROJECTS_DIR='${main}'`],
  ['a CC_PROJECTS_DIR with an inline comment', (main) => `CC_PROJECTS_DIR=${main}   # the main root`],
]) {
  test(`make headless with ${name} in .env: the main root is refused, a separate one binds the right home`, { skip: !HAS_MAKE && 'no make' }, async (t) => {
    const f = fixture(t);
    const dotenv = `${line(f.main)}\n`;
    const refused = f.make({ dotenv, vars: [`CC_HEADLESS_PROJECTS_DIR=${f.main}`, 'PROMPT=hi'] });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /is the main projects dir/);
    assert.equal(refused.argv, null, 'compose was not run');
    const ok = f.make({ dotenv, vars: [`CC_HEADLESS_PROJECTS_DIR=${f.run}`, 'PROMPT=hi'] });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(valuesOf(ok.argv, '-v'), [`${path.join(f.main, '.cc-home')}:/workspaces/cc-home`]);
  });
}

test('make headless normalises the other .env values it exports', { skip: !HAS_MAKE && 'no make' }, async (t) => {
  const f = fixture(t);
  const home = path.join(f.dir, 'home');
  fs.mkdirSync(home);
  const dotenv = [
    `CC_PROJECTS_DIR="${f.main}"`,
    `CC_HEADLESS_PROJECTS_DIR="${f.run}"   # the run's root`,
    `CC_HEADLESS_HOME='${home}'`,
    'CC_HEADLESS_PORT="8799"',
    'CC_BIND="0.0.0.0"  # all interfaces',
    'MODE="plan"',
    '',
  ].join('\n');
  const r = f.make({ dotenv, vars: ['PROMPT=hi'] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(valuesOf(r.argv, '-v'), [`${home}:/workspaces/cc-home`]);
  assert.deepEqual(valuesOf(r.argv, '-p'), ['0.0.0.0:8799:8787']);
  assert.match(r.stderr, /also published at http:\/\/127\.0\.0\.1:8799/);
  assert.deepEqual(r.argv.slice(r.argv.indexOf('conductor') + 1), ['--prompt', 'hi', '--mode', 'plan']);
});
