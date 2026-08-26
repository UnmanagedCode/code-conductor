// Boot-ordering guard: regenerateAllProjectConventions() must run AFTER
// createServer() has wired the plugin convention providers.
//
// Why a subprocess boot of the real server.ts and not an in-process test: the
// thing under test IS the statement order inside start(). Nothing an
// in-process harness can call reproduces it — bootServer() builds the server
// itself, so it can never have the providers unwired.
//
// Why it matters: unwired, setPluginConventionsProvider is a no-op stub
// returning [], so every plugin-namespaced slug is absent from the project
// catalog. ensureProjectConventionsMd computes `missing` from that catalog and
// filters those slugs out BEFORE compose — so nothing throws. The regeneration
// succeeds and WRITES each project's in-tree CONVENTIONS.md with the plugin's
// real text replaced by the "> Convention unavailable: `<slug>`." note. Silent
// file corruption, in the committed tree, with a clean boot log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { waitForBanner } from './serverBanner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.resolve(__dirname, '..', 'server.ts');

const PLUGIN_ID = 'bootorder-plugin';
const PLUGIN_SLUG = `${PLUGIN_ID}/demo`;
// A BUILT-IN project-convention seed rides in the marker alongside the plugin
// slug. An unwired provider writes the demotion note either way, so the seed is
// no longer what forces a write — it is what makes the "plugin text survived"
// assertion meaningful: with only the plugin slug in the marker, a regenerated
// file holding nothing but the note is indistinguishable from a correct one for
// a project that genuinely selected nothing resolvable.
const SEED_SLUG = 'design-guidelines';
const MARKER = `<!-- cc:conventions ${SEED_SLUG},${PLUGIN_SLUG} -->`;
const PLUGIN_BODY_MARKER = 'PLUGIN-DEMO-BODY';

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

// A temp PROJECTS_ROOT holding exactly two projects: a conventions-only plugin
// (enabled in the registry) and one project whose committed CONVENTIONS.md
// selects that plugin's convention plus a built-in seed. Discovery therefore
// finds only this fixture — the real local plugin library is out of scope and
// nothing touches the network.
async function makeFixture() {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-bootorder-'));
  const root = path.join(tmpHome, 'project');
  await fs.mkdir(path.join(tmpHome, '.claude', 'projects'), { recursive: true });

  const pluginDir = path.join(root, 'bootorder-plugin-src');
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'conductor.plugin.json'), JSON.stringify({
    id: PLUGIN_ID, name: 'Boot Order Plugin', version: '1.0.0', pluginApi: 1,
    conventions: [{
      slug: 'demo', name: 'Demo', description: 'boot-order fixture convention',
      file: 'demo.md', scope: 'project',
    }],
  }, null, 2));
  await fs.writeFile(path.join(pluginDir, 'demo.md'), `## Demo\n- ${PLUGIN_BODY_MARKER}\n`);

  const registryFile = path.join(root, '.code-conductor', 'plugins', 'registry.json');
  await fs.mkdir(path.dirname(registryFile), { recursive: true });
  await fs.writeFile(registryFile, JSON.stringify({
    plugins: { [PLUGIN_ID]: { project: 'bootorder-plugin-src', enabled: true, activeVersion: { type: 'main' } } },
  }, null, 2));

  const projectDir = path.join(root, 'consumer');
  await fs.mkdir(projectDir, { recursive: true });
  const conventionsMd = path.join(projectDir, 'CONVENTIONS.md');
  await fs.writeFile(conventionsMd, `${MARKER}\n\nSTALE BODY — must be regenerated on boot.\n`);

  return { tmpHome, root, conventionsMd };
}

test('boot regenerates project CONVENTIONS.md with plugin bodies — the providers are wired before the regen', async (t) => {
  const port = await getFreePort();
  const { tmpHome, root, conventionsMd } = await makeFixture();

  const captured = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, [SERVER_TS], {
    cwd: path.dirname(SERVER_TS),
    env: {
      ...process.env,
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

  t.after(async () => {
    if (!child.killed) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    await new Promise(r => setTimeout(r, 100));
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  // The banner is the readiness signal AND the proof this is our child. All
  // three boot regenerations run before listenWithRetry, so by the time the
  // banner appears the file below has already been written (or deliberately
  // left alone).
  try {
    await waitForBanner(captured, port);
  } catch (e) {
    throw new Error(`server never booted: ${e.message}\nstdout=${captured.stdout}\nstderr=${captured.stderr}`);
  }

  const doc = await fs.readFile(conventionsMd, 'utf8');
  // Fixture guard: if the regen declined entirely, everything below is vacuous.
  assert.doesNotMatch(doc, /STALE BODY/, 'the file was actually regenerated');
  assert.match(doc, /## Design guidelines/, 'the built-in seed body resolves alongside the plugin one');
  // THE assertion. Unwired, this is `> Convention unavailable: ...` instead.
  assert.match(doc, new RegExp(PLUGIN_BODY_MARKER),
    'the plugin convention body must survive the boot regeneration');
  assert.doesNotMatch(doc, /Convention unavailable/,
    'no slug may be demoted — the providers were wired before the regen');
  // The marker is preserved verbatim, plugin slug included.
  assert.equal(doc.split('\n', 1)[0], MARKER);
});
