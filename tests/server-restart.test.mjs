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

// Generous default deadline: this test boots the REAL server.js (port bind +
// migrations + sync reconcile + restart respawn). Under the concurrent suite
// these boots are CPU-starved on Termux, so the poll must allow ample headroom.
// It returns the instant /api/projects responds, so a wide deadline is free on
// the happy path and only widens the failure-detection window.
async function waitForListening(port, { timeout = 20_000 } = {}) {
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
    setTimeout(() => resolve('timeout'), 15_000);
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
  await waitForListening(port, { timeout: 20_000 });

  // Verify the new process is actually serving (and is the one we
  // think it is — sanity check via PID).
  const probe = await fetch(`http://127.0.0.1:${port}/api/projects`);
  assert.equal(probe.status, 200);
  const body = await probe.json();
  assert.ok(Array.isArray(body));
  // Grandchild process must be alive.
  assert.doesNotThrow(() => process.kill(grandchildPid, 0));
});

test('restart sweeps a pending-temp-cleanup manifest on the next boot (archives the session)', async (t) => {
  // A pending-temp-cleanup manifest left for the next boot is swept on
  // restart: the manifest + ephemeral subagent dir are removed, and the
  // session is **archived** (transcript jsonl kept — always-archive policy,
  // so a temp that exited during restart is recoverable from Settings →
  // Archived). We plant a (legacy, no-action) manifest + a fake jsonl
  // before triggering restart, then assert the sweep outcome after the
  // grandchild comes up.
  const port = await getFreePort();
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-restart-sweep-'));
  const projectsRoot = path.join(tmpHome, 'project');
  const claudeProjectsRoot = path.join(tmpHome, '.claude', 'projects');
  await fs.mkdir(projectsRoot, { recursive: true });
  await fs.mkdir(claudeProjectsRoot, { recursive: true });

  // Pre-plant: fake jsonl + manifest pointing at it.
  const fakeCwd = path.join(projectsRoot, 'sweep-target');
  await fs.mkdir(fakeCwd, { recursive: true });
  const sid = 'cafef00d-0000-0000-0000-000000000001';
  const { encodeCwd } = await import('../src/projects.js');
  const sessionDir = path.join(claudeProjectsRoot, encodeCwd(fakeCwd));
  await fs.mkdir(sessionDir, { recursive: true });
  const jsonl = path.join(sessionDir, `${sid}.jsonl`);
  const subagents = path.join(sessionDir, sid);
  await fs.writeFile(jsonl, '{"type":"user","uuid":"x"}\n');
  await fs.mkdir(subagents, { recursive: true });

  const storeDir = path.join(projectsRoot, '.code-conductor');
  await fs.mkdir(storeDir, { recursive: true });
  const manifest = path.join(storeDir, 'pending-temp-cleanup.json');
  await fs.writeFile(manifest, JSON.stringify({
    writtenAt: new Date().toISOString(),
    entries: [{ cwd: fakeCwd, sessionId: sid }],
  }));

  const captured = { stdout: '', stderr: '' };
  const child = spawnServer(port, tmpHome);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { captured.stdout += c; });
  child.stderr.on('data', (c) => { captured.stderr += c; });

  let grandchildPid = null;
  t.after(async () => {
    if (grandchildPid) { try { process.kill(grandchildPid, 'SIGTERM'); } catch {} }
    if (!child.killed) { try { child.kill('SIGTERM'); } catch {} }
    await new Promise(r => setTimeout(r, 100));
    if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch {} }
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  await waitForListening(port);

  // The initial boot already swept the planted manifest. Re-plant before
  // restart so the restarted process is the one we're asserting against.
  // (Order doesn't actually matter for correctness — either boot path is
  // valid — but doing it this way exercises the restart-then-sweep flow.)
  await fs.writeFile(jsonl, '{"type":"user","uuid":"x"}\n');
  await fs.mkdir(subagents, { recursive: true });
  await fs.writeFile(manifest, JSON.stringify({
    writtenAt: new Date().toISOString(),
    entries: [{ cwd: fakeCwd, sessionId: sid }],
  }));

  await fetch(`http://127.0.0.1:${port}/api/admin/restart`, { method: 'POST' }).catch(() => {});

  await new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 15_000);
  });

  const m = captured.stdout.match(/restart: spawned replacement pid=(\d+)/);
  assert.ok(m, `no restart pid log\nstdout=${captured.stdout}`);
  grandchildPid = Number(m[1]);

  await waitForListening(port, { timeout: 20_000 });

  // Grandchild boot should have swept the manifest + subagent dir, but
  // KEPT the transcript jsonl (always-archive: never delete from disk).
  await fs.access(jsonl); // jsonl preserved (archived, not deleted)
  await assert.rejects(() => fs.access(subagents), 'temp subagents dir must be swept');
  await assert.rejects(() => fs.access(manifest), 'manifest must be unlinked');

  // The session must be recorded in the grandchild's archived set.
  const archived = JSON.parse(
    await fs.readFile(path.join(storeDir, 'archived-sessions.json'), 'utf8'),
  );
  assert.ok(archived.sessions.includes(sid), 'session must be archived after sweep');
});
