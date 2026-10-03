import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { launch, stop, probe } from '../installer/windows/launch.mjs';

// Tool detection is injected (its own tests are in win-installer-toolchain).
const detect = { detectGit: () => ({ gitExe: 'C:\\Git\\cmd\\git.exe', cmdDir: 'C:\\Git\\cmd' }), detectClaude: () => null };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launch-'));
  const installDir = path.join(root, 'inst');
  fs.mkdirSync(path.join(installDir, 'app'), { recursive: true });
  return { root, installDir, env: { Path: 'C:\\Windows', USERPROFILE: root }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// A health server on port 0 answering with `body` (or raw text).
async function healthServer(body) {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

const CC = (pid = 4242) => ({ ok: true, bootId: 'b', capabilities: {}, app: 'code-conductor', pid });
const fakeChild = () => Object.assign(new EventEmitter(), { unref() {} });
const quick = { ...detect, pollMs: 5, sleep: () => new Promise((r) => setTimeout(r, 5)) };

test('probe classifies cc / other / none', async () => {
  const cc = await healthServer(CC());
  const other = await healthServer('<html>hi</html>');
  try {
    assert.deepEqual(await probe(cc.port), { kind: 'cc', pid: 4242 });
    assert.equal((await probe(other.port)).kind, 'other');
  } finally { await cc.close(); await other.close(); }
  assert.equal((await probe(cc.port)).kind, 'none');
});

test('launch: a running cc is reused, nothing spawned, URL opened', async () => {
  const fx = fixture();
  const s = await healthServer(CC());
  try {
    const opened = [];
    const r = await launch({
      installDir: fx.installDir, env: { ...fx.env, PORT: String(s.port) }, ...quick,
      spawn: () => assert.fail('must not spawn'), openUrl: (u) => opened.push(u),
    });
    assert.deepEqual(r, { reused: true, pid: 4242 });
    assert.deepEqual(opened, [`http://127.0.0.1:${s.port}/`]);
    assert.match(fs.readFileSync(path.join(fx.installDir, 'logs', 'server.log'), 'utf8'), /reuse/);
  } finally { await s.close(); fx.cleanup(); }
});

test('launch: a foreign program on the port is refused', async () => {
  const fx = fixture();
  const s = await healthServer('nope');
  try {
    await assert.rejects(
      launch({ installDir: fx.installDir, env: { ...fx.env, PORT: String(s.port) }, ...quick, spawn: () => assert.fail('no') }),
      /in use by another program/);
  } finally { await s.close(); fx.cleanup(); }
});

test('launch: spawns server.ts with the composed env, then waits for health and opens the UI', async () => {
  const fx = fixture();
  const s = await healthServer(CC(7));
  const port = s.port;
  await s.close(); // nothing listening at first
  let server;
  try {
    const spawned = [];
    const opened = [];
    const r = await launch({
      installDir: fx.installDir, env: { ...fx.env, PORT: String(port) }, ...quick, readCommit: () => 'abc12345',
      openUrl: (u) => opened.push(u),
      spawn: (cmd, args, opts) => {
        spawned.push({ cmd, args, opts });
        // the server "boots" shortly after being spawned
        setTimeout(async () => {
          server = http.createServer((q, res) => res.end(JSON.stringify(CC(7))));
          server.listen(port, '127.0.0.1');
        }, 30);
        return fakeChild();
      },
    });
    assert.equal(r.pid, 7);
    assert.equal(spawned.length, 1);
    const { args, opts } = spawned[0];
    assert.deepEqual(args, ['server.ts']);
    assert.equal(opts.cwd, path.join(fx.installDir, 'app'));
    assert.equal(opts.detached, true);
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.env.PROJECTS_ROOT, path.win32.join(fx.root, 'code-conductor'));
    assert.ok(opts.env.Path.startsWith(path.win32.join(fx.installDir, 'node')));
    assert.ok(fs.existsSync(opts.env.PROJECTS_ROOT));
    assert.equal(opened.length, 1);
    const log = fs.readFileSync(path.join(fx.installDir, 'logs', 'server.log'), 'utf8');
    assert.match(log, /commit abc12345/);
    assert.match(log, /PROJECTS_ROOT=/);
  } finally { server?.close(); fx.cleanup(); }
});

test('launch: a child that exits before becoming healthy fails with the log tail', async () => {
  const fx = fixture();
  const s = await healthServer(CC());
  const port = s.port;
  await s.close();
  try {
    await assert.rejects(
      launch({
        installDir: fx.installDir, env: { ...fx.env, PORT: String(port) }, ...quick, readCommit: () => 'x',
        spawn: (cmd, args, opts) => {
          fs.writeSync(opts.stdio[1], 'Error: boom from server\n');
          const c = fakeChild();
          setTimeout(() => c.emit('exit', 1, null), 10);
          return c;
        },
        openUrl: () => assert.fail('must not open'),
      }),
      (e) => /exited with 1/.test(e.message) && /boom from server/.test(e.tail) && e.message.includes('server.log'));
  } finally { fx.cleanup(); }
});

test('launch: rotates server.log to server.prev.log', async () => {
  const fx = fixture();
  const s = await healthServer(CC());
  const port = s.port;
  await s.close();
  try {
    const logs = path.join(fx.installDir, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'server.log'), 'OLD RUN\n');
    fs.writeFileSync(path.join(logs, 'server.prev.log'), 'OLDER\n');
    await assert.rejects(launch({
      installDir: fx.installDir, env: { ...fx.env, PORT: String(port) }, ...quick, readCommit: () => 'x',
      spawn: () => { const c = fakeChild(); setTimeout(() => c.emit('exit', 1), 5); return c; },
    }));
    assert.equal(fs.readFileSync(path.join(logs, 'server.prev.log'), 'utf8'), 'OLD RUN\n');
    assert.doesNotMatch(fs.readFileSync(path.join(logs, 'server.log'), 'utf8'), /OLD RUN/);
  } finally { fx.cleanup(); }
});

test('stop: kills the health pid and waits for health to stop answering', async () => {
  const s = await healthServer(CC(555));
  try {
    const killed = [];
    const r = await stop({
      env: { PORT: String(s.port) }, ...quick,
      kill: (pid) => { killed.push(pid); s.srv.close(); s.srv.closeAllConnections(); },
    });
    assert.deepEqual(killed, [555]);
    assert.deepEqual(r, { stopped: true, pid: 555 });
  } finally { s.srv.closeAllConnections(); }
});

test('stop: nothing running is not an error; a survivor is', async () => {
  const none = await healthServer(CC());
  const port = none.port;
  await none.close();
  assert.deepEqual(await stop({ env: { PORT: String(port) }, ...quick }), { stopped: false });

  const s = await healthServer(CC(9));
  let now = 0;
  try {
    await assert.rejects(stop({ env: { PORT: String(s.port) }, kill: () => {}, sleep: async () => { now += 6000; }, now: () => now }),
      /still running/);
  } finally { await s.close(); }
});
