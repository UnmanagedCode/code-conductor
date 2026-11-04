// The headless entry at the process boundary (real `node server.ts`): a usage
// error exits 2 before anything boots, and a held or unreadable projects-root
// lock exits 7 — each with exactly one JSON object on stdout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { ROOT_LOCK_DIRNAME } from '../src/rootLock.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.resolve(__dirname, '..', 'server.ts');
const HOLDER = path.join(__dirname, 'rootLockHolder.mjs');

async function freshHome(t) {
  const home = await mkdtemp('headless-entry-');
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const rootOf = (home) => path.join(home, 'project');
const lockDirOf = (home) => path.join(rootOf(home), '.code-conductor', ROOT_LOCK_DIRNAME);

function run(t, home, args, { stdin = '' } = {}) {
  const child = spawn(process.execPath, [SERVER_TS, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PORT: '0',
      HOST: '127.0.0.1',
      PROJECTS_ROOT: rootOf(home),
      CLAUDE_PROJECTS_ROOT: path.join(home, '.claude', 'projects'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(stdin);
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (c) => { out.stdout += c; });
  child.stderr.setEncoding('utf8').on('data', (c) => { out.stderr += c; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return new Promise((resolve) => child.once('close', (code) => resolve({ code, ...out })));
}

// Exactly one line on stdout, and it parses.
function onlyJson(stdout) {
  const lines = stdout.split('\n');
  assert.equal(lines.length, 2, `one line then the newline: ${JSON.stringify(stdout)}`);
  assert.equal(lines[1], '');
  return JSON.parse(lines[0]);
}

const USAGE = [
  ['--mode alone', ['--mode', 'plan']],
  ['both prompt flags', ['--prompt', 'a', '--prompt-file', 'b']],
  ['a flag with no value', ['--prompt']],
  ['a stray argument', ['--prompt', 'a', 'extra']],
  ['an unknown mode', ['--prompt', 'a', '--mode', 'yolo']],
  ['an unreadable prompt file', ['--prompt-file', 'does-not-exist.md']],
  ['a whitespace-only prompt', ['--prompt', '  ']],
  ['an empty stdin prompt', ['--prompt-file', '-']],
];
for (const [name, args] of USAGE) {
  test(`usage error, ${name}: exit 2, one usage_error object, nothing booted`, async (t) => {
    const home = await freshHome(t);
    const r = await run(t, home, args);
    assert.equal(r.code, 2, r.stderr);
    assert.deepEqual(onlyJson(r.stdout), {
      reason: 'usage_error', exitCode: 2, sessionId: null, text: null, costUsd: null, durationMs: null,
      error: onlyJson(r.stdout).error,
    });
    assert.equal(typeof onlyJson(r.stdout).error, 'string');
    assert.match(r.stderr, /usage: node server\.ts/);
    assert.equal(fs.existsSync(lockDirOf(home)), false, 'no lock was taken');
  });
}

test('a held root: exit 7, a root_held object naming the holder pid', async (t) => {
  const home = await freshHome(t);
  const holder = spawn(process.execPath, [HOLDER, rootOf(home)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    let buf = '';
    holder.stdout.setEncoding('utf8').on('data', (c) => { buf += c; if (/HELD 1\n/.test(buf)) resolve(); });
    holder.once('exit', () => reject(new Error(`holder exited: ${buf}`)));
  });
  const r = await run(t, home, ['--prompt', 'hello']);
  assert.equal(r.code, 7, r.stderr);
  const res = onlyJson(r.stdout);
  assert.equal(res.reason, 'root_held');
  assert.equal(res.exitCode, 7);
  assert.equal(res.sessionId, null);
  assert.match(res.error, new RegExp(`pid ${holder.pid}\\b`));
});

test('an unreadable top lock record: exit 7, a root_held object naming the record', async (t) => {
  const home = await freshHome(t);
  fs.mkdirSync(lockDirOf(home), { recursive: true });
  const file = path.join(lockDirOf(home), '1.json');
  fs.writeFileSync(file, '{not json');
  const r = await run(t, home, ['--prompt', 'hello']);
  assert.equal(r.code, 7, r.stderr);
  const res = onlyJson(r.stdout);
  assert.equal(res.reason, 'root_held');
  assert.equal(res.exitCode, 7);
  assert.ok(res.error.includes(file), res.error);
});
