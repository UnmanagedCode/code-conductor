// Pins posixPlatform's members and the platform selection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { posixPlatform } from '../src/platform/posix.ts';
import { selectPlatform, hostPlatform, samePath } from '../src/platform/index.ts';
import { resolveClaudeBin, resolveBackendLaunch } from '../src/claudeLauncher.ts';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function dies(pid) { for (let i = 0; i < 100 && alive(pid); i++) await sleep(20); return !alive(pid); }

test('commandFor: shell runs through bash -lc, argv splits executable from args', () => {
  assert.deepEqual(posixPlatform.commandFor({ shell: 'a && b' }), { command: 'bash', args: ['-lc', 'a && b'] });
  assert.deepEqual(posixPlatform.commandFor({ argv: ['git', 'status', '-s'] }), { command: 'git', args: ['status', '-s'] });
});

test('spawnOptions: child is bare, group and daemon are detached', () => {
  assert.deepEqual(posixPlatform.spawnOptions('child'), {});
  assert.deepEqual(posixPlatform.spawnOptions('group'), { detached: true });
  assert.deepEqual(posixPlatform.spawnOptions('daemon'), { detached: true });
});

test('splitCommand: whitespace split dropping empties', () => {
  assert.deepEqual(posixPlatform.splitCommand('node /x/fake.mjs'), ['node', '/x/fake.mjs']);
  assert.deepEqual(posixPlatform.splitCommand('  a \t b   c '), ['a', 'b', 'c']);
  assert.deepEqual(posixPlatform.splitCommand(''), []);
});

test('splitCommand parity with resolveClaudeBin / resolveBackendLaunch', () => {
  const prev = process.env.CLAUDE_BIN;
  try {
    process.env.CLAUDE_BIN = '  node   /x/fake.mjs ';
    assert.deepEqual(resolveClaudeBin(), { command: 'node', prefixArgs: ['/x/fake.mjs'] });
    process.env.CLAUDE_BIN = '';
    assert.deepEqual(resolveClaudeBin(), { command: 'claude', prefixArgs: [] });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
  }
  const r = resolveBackendLaunch({ id: 'x', template: 'ollama launch  claude --model={model} --', env: [] }, 'm1', { command: 'claude', prefixArgs: [] });
  assert.equal(r.command, 'ollama');
  assert.deepEqual(r.prefixArgs, ['launch', 'claude', '--model=m1', '--']);
});

test('pathKey is the identity', () => {
  assert.equal(posixPlatform.pathKey('/A/b/'), '/A/b/');
  assert.equal(samePath('/a', '/a'), true);
  assert.equal(samePath('/a', '/A'), false);
});

test('killGroup kills a real detached group and throws ESRCH once it is gone', async () => {
  const child = spawn('sleep', ['600'], { ...posixPlatform.spawnOptions('group'), stdio: 'ignore' });
  const exited = new Promise(r => child.once('exit', r));
  posixPlatform.killGroup(child.pid, 'SIGKILL');
  await exited;
  assert.ok(await dies(child.pid));
  assert.throws(() => posixPlatform.killGroup(child.pid, 'SIGTERM'), { code: 'ESRCH' });
});

test('killProcess: a handle gets .kill(sig); a pid is signalled directly', async () => {
  const calls = [];
  posixPlatform.killProcess({ pid: null, kill: (s) => { calls.push(s); return true; } }, 'SIGTERM');
  assert.deepEqual(calls, ['SIGTERM']);
  const child = spawn('sleep', ['600'], { stdio: 'ignore' });
  const exited = new Promise(r => child.once('exit', r));
  posixPlatform.killProcess(child.pid, 'SIGKILL');
  await exited;
  assert.ok(await dies(child.pid));
});

test('selectPlatform: posix for non-Windows hosts, loud failure for win32', () => {
  for (const os of ['linux', 'android', 'darwin']) assert.equal(selectPlatform(os), posixPlatform);
  assert.throws(() => selectPlatform('win32'), /no Platform implementation for win32/);
  assert.equal(hostPlatform, posixPlatform);
});
