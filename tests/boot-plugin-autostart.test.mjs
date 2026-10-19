// Boot wiring guard: server.ts start() runs the plugin host's auto-start pass
// after init, so an enabled plugin whose registry record has `autoStart: true`
// is running after a boot that nothing else asked to start it.
//
// A subprocess boot of the real server.ts, because the thing under test is a
// statement inside start(): bootServer() builds the server itself and never
// runs it. The plugin backend is a detached process group that outlives the
// server, so `finally` kills it by the pgid runtime.json recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { waitForBanner } from './serverBanner.mjs';
import { mkdtemp } from './tmpRegistry.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.resolve(__dirname, '..', 'server.ts');

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

// A temp PROJECTS_ROOT holding one plugin project (the fake-plugin fixture),
// enabled with auto-start on and never started.
async function makeFixture() {
  const tmpHome = await mkdtemp('orch-bootautostart-');
  const root = path.join(tmpHome, 'project');
  await fs.mkdir(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  await fs.cp(FAKE_PLUGIN_DIR, path.join(root, 'autoplug'), { recursive: true });

  const pluginsDir = path.join(root, '.code-conductor', 'plugins');
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.writeFile(path.join(pluginsDir, 'registry.json'), JSON.stringify({
    plugins: { 'fake-plugin': { project: 'autoplug', enabled: true, activeVersion: { type: 'main' }, autoStart: true } },
  }, null, 2));
  return { tmpHome, root, runtimeFile: path.join(pluginsDir, 'runtime.json') };
}

test('a cc boot starts an enabled plugin whose auto-start flag is on', async () => {
  const port = await getFreePort();
  const { tmpHome, root, runtimeFile } = await makeFixture();

  const captured = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, [SERVER_TS], {
    cwd: path.dirname(SERVER_TS),
    env: {
      ...process.env,
      // Migration 0004 moves $HOME/.code-conductor/{whisper.cpp,piper} on boot; keep it off the real HOME.
      HOME: tmpHome,
      PORT: String(port),
      HOST: '127.0.0.1',
      PROJECTS_ROOT: root,
      CLAUDE_PROJECTS_ROOT: path.join(tmpHome, '.claude', 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { captured.stdout += c; });
  child.stderr.on('data', (c) => { captured.stderr += c; });

  try {
    try {
      await waitForBanner(captured, port);
    } catch (e) {
      throw new Error(`server never booted: ${e.message}\nstdout=${captured.stdout}\nstderr=${captured.stderr}`);
    }

    // Bounded poll: the auto-start pass is fire-and-forget after listen.
    let row;
    const deadline = Date.now() + 20_000;
    for (;;) {
      const res = await fetch(`http://127.0.0.1:${port}/api/plugins`);
      row = (await res.json()).rows.find(r => r.id === 'fake-plugin');
      if (row?.state === 'ready' || row?.state === 'crashed' || row?.state === 'failed') break;
      if (Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(row, `the fixture plugin is discovered\nstdout=${captured.stdout}\nstderr=${captured.stderr}`);
    assert.equal(row.autoStart, true);
    assert.equal(row.state, 'ready', `auto-start brought the backend up\nstderr=${captured.stderr}`);
    assert.ok(row.pid);
  } finally {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    await new Promise(r => setTimeout(r, 100));
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    // The backend is detached: kill its group by the recorded pgid.
    const runtime = await fs.readFile(runtimeFile, 'utf8').then(JSON.parse, () => ({}));
    for (const rec of Object.values(runtime)) {
      try { process.kill(-rec.pgid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
