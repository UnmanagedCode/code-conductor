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

// End-to-end wiring: a real contributions-only plugin, enabled via the host,
// must surface through server.js's provider hookup on the conventions +
// project-scaffolds REST endpoints (the paths the new-project dialog fetches).
test('contributions-only plugin flows through to /api/settings/project-conventions + /api/project-scaffolds', async () => {
  const boot = await bootServer();
  try {
    const dir = path.join(boot.projectsRoot, 'convplug');
    await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true }); // brings conventions/sample.md + scaffolds/sample.md
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
      id: 'conv-plugin', name: 'Conv Plugin', version: '1.0.0', pluginApi: 1,
      conventions: [{ slug: 'vis-check', name: 'Visual check', description: 'verify UX', file: 'conventions/sample.md', scope: 'project' }],
      scaffolds: [{ slug: 'harness-wrapper', name: 'Scaffold harness', description: 'build wrapper', file: 'scaffolds/sample.md' }],
    }));

    // Before enable: not offered.
    let conv = await api(boot.baseUrl, 'GET', '/api/settings/project-conventions');
    assert.ok(!conv.body.rules.some(r => r.slug === 'conv-plugin/vis-check'));
    let sc = await api(boot.baseUrl, 'GET', '/api/project-scaffolds');
    assert.deepEqual(sc.body.scaffolds, []);

    await boot.pluginHost.enable('conv-plugin');
    // Row: backendless, contribution metadata present.
    const row = (await api(boot.baseUrl, 'GET', '/api/plugins')).body.find(p => p.id === 'conv-plugin');
    assert.equal(row.hasBackend, false);
    assert.equal(row.state, 'enabled');
    assert.equal(row.conventions[0].slug, 'conv-plugin/vis-check');
    assert.deepEqual(row.scaffolds, [{ slug: 'conv-plugin/harness-wrapper', name: 'Scaffold harness', description: 'build wrapper' }]);

    // After enable: convention merged (namespaced, plugin-tagged) + scaffold offered.
    conv = await api(boot.baseUrl, 'GET', '/api/settings/project-conventions');
    const g = conv.body.rules.find(r => r.slug === 'conv-plugin/vis-check');
    assert.ok(g, 'plugin convention in the catalog');
    assert.equal(g.plugin, 'conv-plugin');
    assert.equal(g.builtin, false);
    sc = await api(boot.baseUrl, 'GET', '/api/project-scaffolds');
    assert.deepEqual(sc.body.scaffolds, [{ slug: 'conv-plugin/harness-wrapper', name: 'Scaffold harness', description: 'build wrapper', plugin: 'conv-plugin' }]);

    // Create a project selecting both: convention snapshots inline; scaffold
    // directive is RETURNED (never persisted).
    const created = await api(boot.baseUrl, 'POST', '/api/projects', { name: 'usesconv', conventions: ['conv-plugin/vis-check'], scaffolds: ['conv-plugin/harness-wrapper'] });
    assert.equal(created.status, 201);
    assert.match(created.body.scaffold, /Project "usesconv" was created with these setup steps/);
    assert.match(created.body.scaffold, /harness wrapper/);
    const claudeMd = await fs.readFile(path.join(boot.projectsRoot, 'usesconv', 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /Visual UX verification/);
    // Scaffold is NOT persisted to project meta.
    await assert.rejects(fs.stat(path.join(boot.projectsRoot, '.code-conductor', 'projects', 'usesconv', 'project.json')), { code: 'ENOENT' });

    // Disable → both drop from the offering endpoints; convention snapshot survives.
    await boot.pluginHost.disable('conv-plugin');
    conv = await api(boot.baseUrl, 'GET', '/api/settings/project-conventions');
    assert.ok(!conv.body.rules.some(r => r.slug === 'conv-plugin/vis-check'));
    sc = await api(boot.baseUrl, 'GET', '/api/project-scaffolds');
    assert.deepEqual(sc.body.scaffolds, []);
    const still = await fs.readFile(path.join(boot.projectsRoot, 'usesconv', 'CLAUDE.md'), 'utf8');
    assert.match(still, /Visual UX verification/, 'applied convention snapshot survives disable');
  } finally { await boot.close(); }
});
