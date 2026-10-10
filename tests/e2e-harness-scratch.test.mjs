// The e2e harness's isolation primitives (web/e2e/harness/): the allowlisted env
// a booted cc gets (env.ts), scratch roots that go on every exit path and the
// sweep for the ones a SIGKILL left (scratch.ts), and log redaction (redact.ts).
// Every root here lives under this file's own mkdtemp, via TMPDIR for children.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedEnv, scratchLayout } from '../web/e2e/harness/env.ts';
import { sweepStaleRoots, SCRATCH_PREFIX } from '../web/e2e/harness/scratch.ts';
import { redact, registerSecret } from '../web/e2e/harness/redact.ts';

const SCRATCH_URL = pathToFileURL(path.resolve(import.meta.dirname, '../web/e2e/harness/scratch.ts')).href;

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-scratch-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const under = (root, p) => p === root || p.startsWith(root + path.sep);

test('isolatedEnv keeps only the allowlist and points every path under the root', (t) => {
  const root = tmp(t);
  const dirs = scratchLayout(root);
  const env = isolatedEnv({
    base: {
      PATH: '/usr/bin', LANG: 'C.UTF-8', LC_ALL: 'C', TERM: 'xterm', TZ: 'UTC', TMPDIR: '/tmp',
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CC_PROJECTS_ROOT: '/live/projects',
      CLAUDE_CONFIG_DIR: '/live/.claude', HOME: '/home/someone', ANTHROPIC_API_KEY: 'k', NODE_OPTIONS: '--x',
      CLAUDE_CODE_MESSAGING_SOCKET: '/s',
    },
    dirs,
    port: 4321,
    env: { EXTRA_FLAG: 'yes' },
  });

  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CC_PROJECTS_ROOT', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'CLAUDE_CODE_MESSAGING_SOCKET']) {
    assert.equal(env[k], undefined, `${k} leaked into the booted cc's env`);
  }
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'TMPDIR']) assert.ok(k in env, `${k} was dropped`);
  assert.equal(env.EXTRA_FLAG, 'yes');
  assert.equal(env.PORT, '4321');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.CC_SKIP_WEB_BUILD, '1');
  assert.equal(env.CLAUDE_CONFIG_DIR, dirs.claudeConfig);
  for (const k of ['HOME', 'PROJECTS_ROOT', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_ROOT', 'GIT_CONFIG_GLOBAL', 'FAKE_CLAUDE_ENV_DUMP']) {
    assert.ok(env[k] && under(root, env[k]), `${k}=${env[k]} is not under the scratch root`);
  }
  for (const [k, v] of Object.entries(dirs)) assert.ok(under(root, v), `dirs.${k} is not under the scratch root`);
});

// A child that imports scratch.ts, creates a root holding a file, prints it, and
// then ends the way `mode` says.
function runChild(t, mode) {
  const tmpDir = tmp(t);
  const script = `
    import fs from 'node:fs';
    const { createScratchRoot } = await import(${JSON.stringify(SCRATCH_URL)});
    const root = createScratchRoot();
    fs.writeFileSync(root + '/file', 'x');
    console.log(JSON.stringify({ root, created: fs.existsSync(root + '/file') }));
    if (${JSON.stringify(mode)} === 'exit') process.exit(0);
    if (${JSON.stringify(mode)} === 'throw') throw new Error('boom');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TMPDIR: tmpDir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    let root = null;
    let created = false;
    child.stdout.on('data', (d) => {
      out += d;
      if (root === null && out.includes('\n')) {
        const line = JSON.parse(out.split('\n')[0]);
        root = line.root;
        created = line.created;
        if (mode === 'term') child.kill('SIGTERM');
      }
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ root, created, code, signal, tmpDir }));
  });
}

test('a scratch root goes on every exit path', async (t) => {
  await t.test('SIGTERM: removed, and the signal is re-raised', async (t) => {
    const r = await runChild(t, 'term');
    assert.ok(r.root && under(r.tmpDir, r.root), `root ${r.root} not under TMPDIR`);
    assert.ok(r.created, 'the child did not create its root');
    assert.ok(path.basename(r.root).startsWith(`${SCRATCH_PREFIX}`));
    assert.equal(r.signal, 'SIGTERM');
    assert.ok(!fs.existsSync(r.root), 'the root survived SIGTERM');
  });
  await t.test('normal exit: removed', async (t) => {
    const r = await runChild(t, 'exit');
    assert.equal(r.code, 0);
    assert.ok(r.created, 'the child did not create its root');
    assert.ok(r.root && !fs.existsSync(r.root), 'the root survived a normal exit');
  });
  await t.test('uncaught throw: removed', async (t) => {
    const r = await runChild(t, 'throw');
    assert.notEqual(r.code, 0);
    assert.ok(r.created, 'the child did not create its root');
    assert.ok(r.root && !fs.existsSync(r.root), 'the root survived an uncaught throw');
  });
});

test('sweepStaleRoots removes a dead pid\'s root and keeps a live one\'s', (t) => {
  const dir = tmp(t);
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const deadRoot = path.join(dir, `${SCRATCH_PREFIX}${dead}-aaaaaa`);
  const liveRoot = path.join(dir, `${SCRATCH_PREFIX}${process.pid}-bbbbbb`);
  const other = path.join(dir, 'cc-e2e-unrelated');
  for (const d of [deadRoot, liveRoot, other]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'f'), 'x'); }

  const removed = sweepStaleRoots({ tmpDir: dir });

  assert.deepEqual(removed, [deadRoot]);
  assert.ok(!fs.existsSync(deadRoot));
  assert.ok(fs.existsSync(liveRoot));
  assert.ok(fs.existsSync(other));
});

test('redact replaces every registered secret, and an empty one is ignored', () => {
  registerSecret('');
  registerSecret('s3cr3t-value');
  registerSecret('other-secret');
  assert.equal(redact('a s3cr3t-value b s3cr3t-value other-secret'), 'a <redacted> b <redacted> <redacted>');
  assert.equal(redact('nothing here'), 'nothing here');
});
