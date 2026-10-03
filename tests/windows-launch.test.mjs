import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { launch, stop, probe, status, LaunchError, detectClaude, findOnPath, launcherEnv } from '../bin/windows-launch.mjs';

// Git Bash and claude detection are injected into launch(); detectClaude,
// findOnPath and launcherEnv have their own cases at the end.
// The projects root is a Windows-style path; on Linux a real mkdir would create
// a directory literally named after it relative to the cwd. `mkdir` is
// injected (recorded in `made`), and the hook below proves the cwd stays clean.
const made = [];
const cwdBefore = new Set(fs.readdirSync(process.cwd()));
after(() => {
  const added = fs.readdirSync(process.cwd()).filter((n) => !cwdBefore.has(n));
  assert.deepEqual(added, [], 'the tests must not create anything in the cwd');
});
const existsIn = (...files) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
};
const USER = 'C:\\Users\\Jo Bloggs';
const detect = {
  mkdir: (dir) => made.push(dir), gitBash: () => 'C:\\Git\\bin\\bash.exe', exists: existsIn('C:\\Git\\cmd\\git.exe'), detectClaude: () => null,
};
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
    assert.ok(opts.env.Path.startsWith(`${path.win32.join(fx.installDir, 'node')};C:\\Git\\cmd;`));
    assert.deepEqual(made.at(-1), opts.env.PROJECTS_ROOT);
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

test('launch: a server that never becomes healthy is killed and reported', async () => {
  const fx = fixture();
  const s = await healthServer(CC());
  const port = s.port;
  await s.close();
  try {
    let now = 0;
    const killed = [];
    await assert.rejects(launch({
      installDir: fx.installDir, env: { ...fx.env, PORT: String(port) }, ...detect, readCommit: () => 'x',
      sleep: async () => { now += 20_000; }, now: () => now,
      spawn: () => Object.assign(fakeChild(), { pid: 321 }),
      kill: (pid) => killed.push(pid),
      openUrl: () => assert.fail('must not open'),
    }), /did not become healthy/);
    assert.deepEqual(killed, [321]);
  } finally { fx.cleanup(); }
});

const OLD_SHAPE = { ok: true, bootId: 'b', capabilities: {} };

test('launch: a server with the pre-identity health shape is reported clearly and never spawned over', async () => {
  const fx = fixture();
  const s = await healthServer(OLD_SHAPE);
  try {
    await assert.rejects(
      launch({ installDir: fx.installDir, env: { ...fx.env, PORT: String(s.port) }, ...quick, spawn: () => assert.fail('no spawn'), kill: () => assert.fail('no kill') }),
      /doesn't identify as code-conductor \(pre-Windows build\?\)/);
  } finally { await s.close(); fx.cleanup(); }
});

test('launch: a spawned server that never identifies itself (old shape) is killed by pid at the deadline', async () => {
  const fx = fixture();
  const s = await healthServer(CC());
  const port = s.port;
  await s.close();
  let server;
  let now = 0;
  try {
    const killed = [];
    await assert.rejects(launch({
      installDir: fx.installDir, env: { ...fx.env, PORT: String(port) }, ...detect, readCommit: () => 'x',
      sleep: async () => { now += 20_000; }, now: () => now,
      spawn: () => {
        server = http.createServer((q, res) => res.end(JSON.stringify(OLD_SHAPE))).listen(port, '127.0.0.1');
        return Object.assign(fakeChild(), { pid: 99 });
      },
      kill: (pid) => killed.push(pid),
      openUrl: () => assert.fail('must not open'),
    }), /doesn't identify as code-conductor/);
    assert.deepEqual(killed, [99]);
  } finally { server?.close(); fx.cleanup(); }
});

test('launch: a spawned server behind a foreign answer is killed by pid at the deadline', async () => {
  const fx = fixture();
  const s = await healthServer(CC());
  const port = s.port;
  await s.close();
  let server;
  let now = 0;
  try {
    const killed = [];
    await assert.rejects(launch({
      installDir: fx.installDir, env: { ...fx.env, PORT: String(port) }, ...detect, readCommit: () => 'x',
      sleep: async () => { now += 20_000; }, now: () => now,
      spawn: () => {
        server = http.createServer((q, res) => res.end('<html>')).listen(port, '127.0.0.1');
        return Object.assign(fakeChild(), { pid: 5 });
      },
      kill: (pid) => killed.push(pid),
    }), /in use by another program/);
    assert.deepEqual(killed, [5]);
  } finally { server?.close(); fx.cleanup(); }
});

test('launch: a child that died while a stranger holds the port reports the child exit and log tail, no kill', async () => {
  const fx = fixture();
  const s = await healthServer(OLD_SHAPE);
  const port = s.port;
  await s.close();
  let stranger;
  try {
    await assert.rejects(launch({
      installDir: fx.installDir, env: { ...fx.env, PORT: String(port) }, ...quick, readCommit: () => 'x',
      spawn: (cmd, args, opts) => {
        stranger = http.createServer((q, res) => res.end(JSON.stringify(OLD_SHAPE))).listen(port, '127.0.0.1');
        fs.writeSync(opts.stdio[1], 'Error: listen EADDRINUSE\n');
        const c = Object.assign(fakeChild(), { pid: 8 });
        setTimeout(() => c.emit('exit', 1, null), 10);
        return c;
      },
      kill: () => assert.fail('a dead child is not killed'),
    }), (e) => /exited with 1/.test(e.message) && !/pre-Windows/.test(e.message) && /EADDRINUSE/.test(e.tail));
  } finally { stranger?.close(); fx.cleanup(); }
});

test('status: 0 for cc, 1 for none or a stranger, 2 with a message for an unidentified answer', async () => {
  const cc = await healthServer(CC());
  const old = await healthServer(OLD_SHAPE);
  const foreign = await healthServer('<html>');
  try {
    const msgs = [];
    assert.equal(await status(cc.port, fetch, (m) => msgs.push(m)), 0);
    assert.equal(await status(foreign.port, fetch, (m) => msgs.push(m)), 1);
    assert.deepEqual(msgs, []);
    assert.equal(await status(old.port, fetch, (m) => msgs.push(m)), 2);
    assert.match(msgs[0], /doesn't identify as code-conductor/);
  } finally { await cc.close(); await old.close(); await foreign.close(); }
  assert.equal(await status(cc.port), 1);
});

test('stop: an unidentified server cannot be stopped and is reported, not killed', async () => {
  const old = await healthServer(OLD_SHAPE);
  try {
    await assert.rejects(stop({ env: { PORT: String(old.port) }, kill: () => assert.fail('no kill') }), /cannot stop.*doesn't identify/);
  } finally { await old.close(); }
});

test('launch: no Git Bash fails with a run-the-installer-again message, nothing spawned', async () => {
  const fx = fixture();
  const s = await healthServer(CC());
  const port = s.port;
  await s.close();
  try {
    await assert.rejects(
      launch({
        installDir: fx.installDir, env: { ...fx.env, PORT: String(port) }, ...quick,
        gitBash: () => { throw new Error("Git for Windows' bash.exe not found"); },
        spawn: () => assert.fail('must not spawn'),
      }),
      (e) => e instanceof LaunchError && /Git for Windows \(with Git Bash\) was not found; run the installer again/.test(e.message));
  } finally { fx.cleanup(); }
});


// launch() up to the spawn: the server env and the git readCommit was given.
async function spawnedWith(deps) {
  const fx = fixture();
  const s = await healthServer(CC());
  const port = s.port;
  await s.close();
  let seen;
  try {
    await assert.rejects(launch({
      installDir: fx.installDir, env: { ...fx.env, PORT: String(port) }, ...quick, ...deps,
      readCommit: (git) => { seen = { git }; return 'x'; },
      spawn: (cmd, args, opts) => { seen.env = opts.env; const c = fakeChild(); setTimeout(() => c.emit('exit', 1), 5); return c; },
    }), /exited with 1/);
    seen.node = path.win32.join(fx.installDir, 'node');
    seen.log = fs.readFileSync(path.join(fx.installDir, 'logs', 'server.log'), 'utf8');
    return seen;
  } finally { fx.cleanup(); }
}

test('launch: the server PATH gets the Git install\'s existing git.exe dir: cmd, else bin, else PATH; none is omitted', async () => {
  const binOnly = await spawnedWith({ exists: existsIn('C:\\Git\\bin\\git.exe') });
  assert.equal(binOnly.git.gitExe, 'C:\\Git\\bin\\git.exe');
  assert.ok(binOnly.env.Path.startsWith(`${binOnly.node};C:\\Git\\bin;`), binOnly.env.Path);

  const onPath = await spawnedWith({
    gitBash: () => 'X:\\tools\\bash.exe',
    exists: existsIn('C:\\Windows\\git.exe'),
  });
  assert.equal(onPath.git.gitExe, 'C:\\Windows\\git.exe');
  assert.ok(onPath.env.Path.startsWith(`${onPath.node};C:\\Windows`), onPath.env.Path);

  const none = await spawnedWith({ gitBash: () => 'X:\\tools\\bash.exe', exists: existsIn() });
  assert.equal(none.git, null);
  assert.equal(none.env.Path, `${none.node};C:\\Windows`);
  assert.match(none.log, /git bash X:\\tools\\bash\.exe, git NOT FOUND/);
});

test('detectClaude: .cmd shim rejected, .local\\bin fallback used', () => {
  const exe = `${USER}\\.local\\bin\\claude.exe`;
  assert.equal(detectClaude({ PATH: 'C:\\npm', USERPROFILE: USER }, existsIn('C:\\npm\\claude.cmd')), null);
  const r = detectClaude({ PATH: 'C:\\npm', USERPROFILE: USER }, existsIn('C:\\npm\\claude.cmd', exe));
  assert.deepEqual(r, { claudeExe: exe, dir: `${USER}\\.local\\bin` });
});

test('findOnPath: case-insensitive PATH key', () => {
  assert.equal(findOnPath('git', { pAtH: 'C:\\a;C:\\b' }, existsIn('C:\\b\\git.exe')), 'C:\\b\\git.exe');
});

test('launcherEnv: PATH order, case-insensitive dedupe, spaces preserved', () => {
  const inst = `${USER}\\AppData\\Local\\Programs\\code-conductor`;
  const git = { gitExe: 'C:\\Git\\cmd\\git.exe', cmdDir: 'C:\\Git\\cmd' };
  const claude = { claudeExe: `${USER}\\.local\\bin\\claude.exe`, dir: `${USER}\\.local\\bin` };
  const env = launcherEnv({
    env: { Path: `C:\\Windows;c:\\git\\cmd;${USER}\\.local\\bin`, USERPROFILE: USER },
    installDir: inst, git, claude,
  });
  assert.equal(env.Path, [`${inst}\\node`, 'C:\\Git\\cmd', `${USER}\\.local\\bin`, 'C:\\Windows'].join(';'));
  assert.equal(env.PATH, undefined);
  assert.equal(env.PROJECTS_ROOT, `${USER}\\code-conductor`);
});

test('launcherEnv: PROJECTS_ROOT override kept, no CLAUDE_BIN/HOST/PORT/GIT_BASH injected', () => {
  const env = launcherEnv({
    env: { PATH: 'C:\\W', USERPROFILE: USER, PROJECTS_ROOT: 'D:\\work' },
    installDir: 'C:\\i', git: null, claude: null,
  });
  assert.equal(env.PROJECTS_ROOT, 'D:\\work');
  for (const k of ['CLAUDE_BIN', 'HOST', 'PORT', 'CLAUDE_CODE_GIT_BASH_PATH']) assert.equal(env[k], undefined);
});

test('launcherEnv: a mixed-case projects_root is normalised to PROJECTS_ROOT', () => {
  const env = launcherEnv({ env: { PATH: 'C:\\W', USERPROFILE: USER, Projects_Root: 'D:\\work' }, installDir: 'C:\\i', git: null, claude: null });
  assert.equal(env.PROJECTS_ROOT, 'D:\\work');
  assert.deepEqual(Object.keys(env).filter((k) => k.toLowerCase() === 'projects_root'), ['PROJECTS_ROOT']);
});
