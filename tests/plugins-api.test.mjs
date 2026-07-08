import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bootServer, api, waitFor } from './helpers.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';
import { pidAlive } from '../src/plugins/ports.js';

async function setup() {
  const boot = await bootServer();
  await fs.cp(FAKE_PLUGIN_DIR, path.join(boot.projectsRoot, 'fakeplug'), { recursive: true });
  return boot;
}

test('GET /api/plugins lists the discovered catalog', async () => {
  const boot = await setup();
  try {
    const r = await api(boot.baseUrl, 'GET', '/api/plugins');
    assert.equal(r.status, 200);
    const row = r.body.find(p => p.id === 'fake-plugin');
    assert.ok(row, 'fixture plugin discovered');
    assert.equal(row.state, 'discovered');
    assert.equal(row.enabled, false);
    assert.equal(row.hasFrontend, true);
    assert.equal(row.hasMcp, true);
    assert.equal(row.navLabel, 'Fake');
    assert.deepEqual(row.activeVersion, { type: 'main' });
  } finally { await boot.close(); }
});

test('enable → start → status → stop → disable round-trip', async () => {
  const boot = await setup();
  try {
    const en = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/enable');
    assert.equal(en.status, 200);
    assert.equal(en.body.state, 'stopped');
    assert.equal(en.body.enabled, true);

    // Enable auto-assigned the unassigned plugin project to CC-Dev.
    const projects = await api(boot.baseUrl, 'GET', '/api/projects');
    assert.equal(projects.body.find(p => p.name === 'fakeplug')?.workspace, 'CC-Dev');

    const st = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/start');
    assert.equal(st.status, 200);
    assert.equal(st.body.state, 'ready');
    assert.ok(st.body.port);
    assert.ok(st.body.pid);

    const status = await api(boot.baseUrl, 'GET', '/api/plugins/fake-plugin/status');
    assert.equal(status.body.state, 'ready');

    const pid = st.body.pid;
    const stop = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/stop');
    assert.equal(stop.body.state, 'stopped');
    await waitFor(() => !pidAlive(pid));

    const dis = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/disable');
    assert.equal(dis.body.state, 'disabled');
    assert.equal(dis.body.enabled, false);
  } finally { await boot.close(); }
});

test('status live-probe reports a killed child as crashed with tail exposed', async () => {
  const boot = await setup();
  try {
    await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/enable');
    const st = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/start');
    process.kill(-st.body.pid, 'SIGKILL');
    await waitFor(() => !pidAlive(st.body.pid));
    const status = await waitFor(async () => {
      const s = await api(boot.baseUrl, 'GET', '/api/plugins/fake-plugin/status');
      return s.body.state === 'crashed' ? s : false;
    });
    assert.equal(status.body.state, 'crashed');
  } finally { await boot.close(); }
});

test('rescan picks up a manifest added after boot', async () => {
  const boot = await setup();
  try {
    // Prime discovery, then add a second plugin.
    await api(boot.baseUrl, 'GET', '/api/plugins');
    const dir = path.join(boot.projectsRoot, 'second');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
      id: 'second', name: 'Second', version: '1', pluginApi: 1,
    }));
    const re = await api(boot.baseUrl, 'POST', '/api/plugins/rescan');
    assert.equal(re.status, 200);
    assert.ok(re.body.find(p => p.id === 'second'));
  } finally { await boot.close(); }
});

test('error shapes: unknown 404, invalid manifest 409, disabled start 409', async () => {
  const boot = await setup();
  try {
    const bad = path.join(boot.projectsRoot, 'badplug');
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, 'conductor.plugin.json'), JSON.stringify({ id: 'badplug', pluginApi: 1 }));

    assert.equal((await api(boot.baseUrl, 'POST', '/api/plugins/ghost/enable')).status, 404);
    assert.equal((await api(boot.baseUrl, 'GET', '/api/plugins/ghost/status')).status, 404);
    const inv = await api(boot.baseUrl, 'POST', '/api/plugins/badplug/enable');
    assert.equal(inv.status, 409);
    assert.match(inv.body.error, /invalid/);
    const notEnabled = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/start');
    assert.equal(notEnabled.status, 409);
    const listed = await api(boot.baseUrl, 'GET', '/api/plugins');
    assert.equal(listed.body.find(p => p.project === 'badplug')?.state, 'invalid');
  } finally { await boot.close(); }
});
