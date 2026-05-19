// Live self-respawn test for POST /api/admin/restart.
//
// The in-process bootServer helper can't observe its own exit, so this
// test spawns the actual server.js in a child node process, hits the
// restart endpoint, and asserts that:
//   (a) the original process exits cleanly,
//   (b) a new process (different PID) ends up listening on the same port,
//   (c) GET /api/projects succeeds against that new process.
//
// Cleanup kills the grandchild via the PID parsed from its restart-log
// line so we don't leak detached server processes between test runs.
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
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: path.dirname(SERVER_JS),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      // Sandbox FS lookups away from the user's real ~/project.
      PROJECTS_ROOT: path.join(tmpHome, 'project'),
      CLAUDE_PROJECTS_ROOT: path.join(tmpHome, '.claude', 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitForListening(port, { timeout = 8_000 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/projects`);
      if (r.ok) { await r.text(); return; }
    } catch { /* not up yet */ }
    if (Date.now() - start > timeout) throw new Error(`port ${port} never opened`);
    await new Promise(r => setTimeout(r, 50));
  }
}

test('POST /api/admin/restart respawns the server on the same port with a new pid', async (t) => {
  const port = await getFreePort();
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-restart-'));
  await fs.mkdir(path.join(tmpHome, 'project'), { recursive: true });
  await fs.mkdir(path.join(tmpHome, '.claude', 'projects'), { recursive: true });

  const captured = { stdout: '', stderr: '' };
  const child = spawnServer(port, tmpHome);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { captured.stdout += chunk; });
  child.stderr.on('data', (chunk) => { captured.stderr += chunk; });

  const originalPid = child.pid;
  let grandchildPid = null;

  t.after(async () => {
    // Kill whichever process is still alive.
    if (grandchildPid) {
      try { process.kill(grandchildPid, 'SIGTERM'); } catch { /* gone already */ }
    }
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch { /* gone already */ }
    }
    // Give them a moment, then SIGKILL anything lingering.
    await new Promise(r => setTimeout(r, 100));
    if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch {} }
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  try {
    await waitForListening(port);
  } catch (e) {
    throw new Error(`initial start failed: ${e.message}\nstdout=${captured.stdout}\nstderr=${captured.stderr}`);
  }

  // Trigger the restart. The server may exit before the fetch resolves
  // (response is sent immediately, then process.exit kicks in ~50ms
  // later) — that's fine; either response or aborted connection is OK.
  await fetch(`http://127.0.0.1:${port}/api/admin/restart`, { method: 'POST' })
    .catch(() => { /* server may close socket before flush */ });

  // Wait for the original process to exit.
  const exitCode = await new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => resolve(code));
    setTimeout(() => resolve('timeout'), 5_000);
  });
  assert.notEqual(exitCode, 'timeout', `original server did not exit after restart\nstdout=${captured.stdout}\nstderr=${captured.stderr}`);
  assert.equal(exitCode, 0, `original server exit code: ${exitCode}`);

  // The grandchild logs `restart: spawned replacement pid=<N>` before exiting.
  const m = captured.stdout.match(/restart: spawned replacement pid=(\d+)/);
  assert.ok(m, `did not see spawned-pid log line\nstdout=${captured.stdout}`);
  grandchildPid = Number(m[1]);
  assert.notEqual(grandchildPid, originalPid, 'grandchild pid must differ from original');

  // The grandchild rebinds the same port — with the listen-with-retry
  // loop it may take a moment after the parent releases the socket.
  await waitForListening(port, { timeout: 8_000 });

  // Verify the new process is actually serving (and is the one we
  // think it is — sanity check via PID).
  const probe = await fetch(`http://127.0.0.1:${port}/api/projects`);
  assert.equal(probe.status, 200);
  const body = await probe.json();
  assert.ok(Array.isArray(body));
  // Grandchild process must be alive.
  assert.doesNotThrow(() => process.kill(grandchildPid, 0));
});
