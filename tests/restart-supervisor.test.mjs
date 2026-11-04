// The restart supervisor (src/restartSupervisor.ts, docker/supervise.mjs):
// takeRestartSupervisor's pid rule, superviseServer's relaunch/forward/exit
// rules against injected spawn + signals, and the real entry against a fixture
// server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from './tmpRegistry.mjs';
import {
  takeRestartSupervisor, superviseServer, RESTART_SUPERVISOR_ENV, SUPERVISED_RESTART_EXIT,
} from '../src/restartSupervisor.ts';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISE = path.join(REPO, 'docker', 'supervise.mjs');
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'supervisedServer.mjs');

test('takeRestartSupervisor: a value equal to the parent pid is supervised, and the key is always deleted', () => {
  const env = { [RESTART_SUPERVISOR_ENV]: '77' };
  assert.equal(takeRestartSupervisor(env, 77, { warn() { throw new Error('no warning'); } }), true);
  assert.equal(RESTART_SUPERVISOR_ENV in env, false);
});

test('takeRestartSupervisor: a value naming another pid is not supervised, warns with both pids, and the key is deleted', () => {
  const env = { [RESTART_SUPERVISOR_ENV]: '77' };
  const warned = [];
  assert.equal(takeRestartSupervisor(env, 88, { warn: (m) => warned.push(m) }), false);
  assert.equal(RESTART_SUPERVISOR_ENV in env, false);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /77/);
  assert.match(warned[0], /88/);
});

test('takeRestartSupervisor: an absent key is not supervised and does not warn', () => {
  assert.equal(takeRestartSupervisor({}, 88, { warn() { throw new Error('no warning'); } }), false);
});

// superviseServer over fakes: every spawn yields an emitter we end by hand.
function rig({ spawnThrows = false } = {}) {
  const spawns = [];
  const kills = [];
  const exits = [];
  const logs = [];
  const signals = new EventEmitter();
  let pid = 1000;
  superviseServer({
    command: 'srv', args: ['a', 'b'], cwd: '/work', env: { KEEP: '1' },
    spawnOptions: { detached: true },
    signals,
    spawn: (command, args, options) => {
      if (spawnThrows) throw new Error('EAGAIN');
      const child = Object.assign(new EventEmitter(), { pid: ++pid });
      spawns.push({ command, args, options, child });
      return child;
    },
    kill: (p, sig) => kills.push([p, sig]),
    exit: (code) => exits.push(code),
    log: (m) => logs.push(m),
  });
  return { spawns, kills, exits, logs, signals };
}

test('superviseServer: exit 75 relaunches with the same command, args, cwd and env, marking this pid as supervisor', () => {
  const r = rig();
  r.spawns[0].child.emit('exit', SUPERVISED_RESTART_EXIT, null);
  assert.equal(r.spawns.length, 2);
  for (const s of r.spawns) {
    assert.equal(s.command, 'srv');
    assert.deepEqual(s.args, ['a', 'b']);
    assert.equal(s.options.cwd, '/work');
    assert.equal(s.options.env.KEEP, '1');
    assert.equal(s.options.env[RESTART_SUPERVISOR_ENV], String(process.pid));
    assert.equal(s.options.stdio, 'inherit');
  }
  assert.deepEqual(r.exits, []);
  assert.ok(r.logs.some((l) => /relaunching/.test(l)));
});

for (const code of [0, 1, 2, 3, 7]) {
  test(`superviseServer: a server exit ${code} exits the supervisor with ${code} and relaunches nothing`, () => {
    const r = rig();
    r.spawns[0].child.emit('exit', code, null);
    assert.deepEqual(r.exits, [code]);
    assert.equal(r.spawns.length, 1);
  });
}

test('superviseServer: a server killed by SIGKILL exits the supervisor 137 and relaunches nothing', () => {
  const r = rig();
  r.spawns[0].child.emit('exit', null, 'SIGKILL');
  assert.deepEqual(r.exits, [137]);
  assert.equal(r.spawns.length, 1);
});

test('superviseServer: SIGTERM is forwarded to the server pid exactly once, and its exit code is mirrored', () => {
  const r = rig();
  r.signals.emit('SIGTERM');
  assert.deepEqual(r.kills, [[1001, 'SIGTERM']]);
  r.spawns[0].child.emit('exit', 143, null);
  assert.deepEqual(r.exits, [143]);
  assert.deepEqual(r.kills, [[1001, 'SIGTERM']]);
});

test('superviseServer: SIGINT, SIGHUP and SIGQUIT are forwarded too', () => {
  const r = rig();
  for (const s of ['SIGINT', 'SIGHUP', 'SIGQUIT']) r.signals.emit(s);
  assert.deepEqual(r.kills, [[1001, 'SIGINT'], [1001, 'SIGHUP'], [1001, 'SIGQUIT']]);
});

test('superviseServer: after a stop signal an exit 75 does not relaunch', () => {
  const r = rig();
  r.signals.emit('SIGTERM');
  r.spawns[0].child.emit('exit', SUPERVISED_RESTART_EXIT, null);
  assert.equal(r.spawns.length, 1);
  assert.deepEqual(r.exits, [SUPERVISED_RESTART_EXIT]);
});

test('superviseServer: a signal after a relaunch goes to the new server pid', () => {
  const r = rig();
  r.spawns[0].child.emit('exit', SUPERVISED_RESTART_EXIT, null);
  r.signals.emit('SIGTERM');
  assert.deepEqual(r.kills, [[1002, 'SIGTERM']]);
});

test('superviseServer: a spawn that throws logs the error and exits 1', () => {
  const r = rig({ spawnThrows: true });
  assert.deepEqual(r.exits, [1]);
  assert.ok(r.logs.some((l) => /EAGAIN/.test(l)));
});

test('superviseServer: spawnOptions reach spawn, so the server can be given its own process group', () => {
  const r = rig();
  assert.equal(r.spawns[0].options.detached, true);
});

const runSupervisor = (dir, mode, extra = []) => spawn(process.execPath, [SUPERVISE, process.execPath, FIXTURE, dir, mode, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
const WAIT_MS = 15_000;
// Race `promise` against a deadline that fails the test and takes the supervisor
// down (its SIGTERM is forwarded to the server it started), so a supervisor that
// never starts or never ends cannot hang the file until the harness kills it.
function within(child, promise, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      reject(new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`));
    }, WAIT_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
const exited = (child) => within(child, new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))), 'the supervisor to exit');

test('supervise.mjs, real processes: exit 75 relaunches once with identical argv, this supervisor as parent and marker, and stdin intact', async () => {
  const dir = mkdtempSync('cc-supervisor-');
  const child = runSupervisor(dir, 'restart', ['--x', 'y']);
  child.stdin.end('prompt text\n');
  const end = await exited(child);
  assert.equal(end.code, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'runs'), 'utf8'), 'xx', 'exactly two runs');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'run-2.json'), 'utf8'));
  assert.deepEqual(rec.argv, ['--x', 'y']);
  assert.equal(rec.marker, String(child.pid));
  assert.equal(rec.ppid, child.pid);
  assert.equal(rec.stdin, 'prompt text\n');
});

test('supervise.mjs, real processes: a SIGTERM to the supervisor reaches the server exactly once and the supervisor mirrors its exit', async () => {
  const dir = mkdtempSync('cc-supervisor-');
  const child = runSupervisor(dir, 'signal');
  await within(child, new Promise((resolve) => child.stdout.on('data', (d) => { if (/ready/.test(String(d))) resolve(); })), 'the server to print ready');
  child.kill('SIGTERM');
  const end = await exited(child);
  assert.equal(end.code, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'signals'), 'utf8'), 'SIGTERM\n');
});
