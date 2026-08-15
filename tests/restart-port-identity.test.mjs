// Regression guard for the cross-file restart-port hijack.
//
// tests/server-restart.test.mjs and tests/eaddrinuse-retry.test.mjs drive a real
// server.ts child on a fixed port and then POST the DESTRUCTIVE
// /api/admin/restart at it. They used to decide "the child is up" by probing
// GET /api/projects on that port — but the port had been picked by binding and
// immediately freeing a socket, so between the free and the child's bind any
// other test file's bootServer() `listen(0)` could be handed the same port.
// The probe was then answered by that stranger, and the restart POST killed
// ANOTHER test file's process mid-run (observed: 52 tests lost).
//
// This test reproduces the exact geometry — a decoy that answers the old
// readiness probe while our child cannot bind — and asserts that the new
// banner-based readiness refuses to call it ready.
//
// It exercises the SAME `waitForBanner` the restart tests import, not a private
// copy: this guard only protects the destructive call sites if reverting the
// readiness rule there is the same edit as reverting it here.
// The decoy is a plain node:http recorder, not a code-conductor server, so a
// stray restart POST would be recorded, not obeyed: nothing here is destructive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { waitForBanner } from './serverBanner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.resolve(__dirname, '..', 'server.ts');

// Answers exactly what the OLD readiness probe looked for, and counts the
// destructive POST it would have led to. The socket is held for the whole
// test — never bound-then-freed — so there is no TOCTOU window here either.
async function startDecoy() {
  const state = { restartPosts: 0, projectsGets: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/admin/restart') {
      state.restartPosts++;
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ restarting: true }));
      return;
    }
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bootId: 'decoy' }));
      return;
    }
    if (req.url === '/api/projects') {
      state.projectsGets++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((res, rej) => {
    server.on('error', rej);
    server.listen(0, '127.0.0.1', res);
  });
  state.port = server.address().port;
  state.close = () => new Promise(r => server.close(r));
  return state;
}

test('banner readiness never mistakes a foreign server on our port for our child', async (t) => {
  const decoy = await startDecoy();
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-port-identity-'));
  await fs.mkdir(path.join(tmpHome, 'project'), { recursive: true });
  await fs.mkdir(path.join(tmpHome, '.claude', 'projects'), { recursive: true });

  // Our child gets the decoy's port, so it can never bind: it sits in
  // listenWithRetry and by construction never prints its banner.
  const child = spawn(process.execPath, [SERVER_TS], {
    cwd: path.dirname(SERVER_TS),
    env: {
      ...process.env,
      PORT: String(decoy.port),
      HOST: '127.0.0.1',
      PROJECTS_ROOT: path.join(tmpHome, 'project'),
      CLAUDE_PROJECTS_ROOT: path.join(tmpHome, '.claude', 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const captured = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { captured.stdout += c; });
  child.stderr.on('data', (c) => { captured.stderr += c; });

  t.after(async () => {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 100));
    try { child.kill('SIGKILL'); } catch {}
    await decoy.close();
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  // The decoy answers the OLD probe happily — establish that, so the test
  // proves the probe was genuinely fooled and not merely unreachable.
  const probe = await fetch(`http://127.0.0.1:${decoy.port}/api/projects`);
  assert.equal(probe.status, 200, 'the decoy answers the old readiness probe');
  assert.ok(Array.isArray(await probe.json()));

  // THE live assertion. Banner readiness must REFUSE: the port answers, but
  // not with our banner — so the caller never proceeds to its restart POST.
  await assert.rejects(
    () => waitForBanner(captured, decoy.port, { timeout: 2_000 }),
    /never printed listening banner/,
    'a foreign server on our port must not read as ready',
  );

  // Documents the consequence; this test issues no restart POST, so it is 0 by
  // construction and pins nothing on its own. The rejection above is the proof.
  assert.equal(decoy.restartPosts, 0, 'no restart POST may reach a server we do not own');
});
