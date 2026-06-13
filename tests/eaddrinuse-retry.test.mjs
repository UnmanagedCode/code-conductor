// Regression test: EADDRINUSE must not crash the replacement server via an
// unhandled WebSocketServer 'error' event before listenWithRetry can retry.
//
// ws 8.20.1 registers server.on('error', wss.emit.bind(wss,'error')) at
// WebSocketServer construction time. Without the fix, EADDRINUSE fired on the
// wss (which had no handler) and killed the process before the retry loop ran.
//
// Strategy: hold the target port with a plain TCP blocker, spawn server.js on
// that port, wait for the EADDRINUSE retry log line in stderr (deterministic
// signal that the child actually hit the collision), then release the blocker
// and assert the child recovers and serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.resolve(__dirname, '..', 'server.js');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function spawnServer(port, tmpHome) {
  return spawn(process.execPath, [SERVER_JS], {
    cwd: path.dirname(SERVER_JS),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PROJECTS_ROOT: path.join(tmpHome, 'project'),
      CLAUDE_PROJECTS_ROOT: path.join(tmpHome, '.claude', 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForListening(port, { timeout = 15_000 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/projects`);
      if (r.ok) { await r.text(); return; }
    } catch { /* not yet */ }
    if (Date.now() - start > timeout) throw new Error(`port ${port} never opened`);
    await new Promise(r => setTimeout(r, 50));
  }
}

test('EADDRINUSE: server retries and recovers when the blocking port is released', async (t) => {
  const port = await getFreePort();
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-eaddrinuse-'));
  await fs.mkdir(path.join(tmpHome, 'project'), { recursive: true });
  await fs.mkdir(path.join(tmpHome, '.claude', 'projects'), { recursive: true });

  // Hold the port so the child gets EADDRINUSE on its first bind attempt.
  const blocker = net.createServer();
  await new Promise((res, rej) => {
    blocker.on('error', rej);
    blocker.listen(port, '127.0.0.1', res);
  });

  const captured = { stdout: '', stderr: '' };
  const child = spawnServer(port, tmpHome);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { captured.stdout += c; });

  // Accumulate stderr and notify a waiting promise when the retry log appears.
  let _retryResolve = null;
  child.stderr.on('data', (chunk) => {
    captured.stderr += chunk;
    if (_retryResolve && captured.stderr.includes('EADDRINUSE on port')) {
      const fn = _retryResolve;
      _retryResolve = null;
      fn();
    }
  });

  let blockerClosed = false;
  t.after(async () => {
    if (!blockerClosed) { try { await new Promise(r => blocker.close(r)); } catch {} }
    try { child.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 100));
    try { child.kill('SIGKILL'); } catch {}
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  // Wait for the child to confirm it hit EADDRINUSE and entered the retry loop.
  // This is the deterministic gate: we only release the blocker once the collision
  // is confirmed. Timeout is generous to allow for slow boot on Termux.
  await new Promise((resolve, reject) => {
    if (captured.stderr.includes('EADDRINUSE on port')) { resolve(); return; }
    const timer = setTimeout(() => {
      _retryResolve = null;
      reject(new Error(
        `child never emitted EADDRINUSE retry log within 20s\n` +
        `stdout=${captured.stdout}\nstderr=${captured.stderr}`
      ));
    }, 20_000);
    _retryResolve = () => { clearTimeout(timer); resolve(); };
  });

  // Confirmed: child is alive and in the retry loop. Release the port.
  await new Promise((res, rej) => blocker.close((e) => e ? rej(e) : res()));
  blockerClosed = true;

  // Primary assertion: server recovers, retries, and serves on the same port.
  try {
    await waitForListening(port, { timeout: 10_000 });
  } catch (e) {
    throw new Error(
      `server did not recover after blocker release: ${e.message}\n` +
      `stdout=${captured.stdout}\nstderr=${captured.stderr}`
    );
  }

  const probe = await fetch(`http://127.0.0.1:${port}/api/projects`);
  assert.equal(probe.status, 200, 'recovered server must respond 200');
  assert.ok(Array.isArray(await probe.json()), 'response must be a JSON array');

  // Child must still be alive.
  assert.equal(child.exitCode, null, 'child process must not have exited');
});
