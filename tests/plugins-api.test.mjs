import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bootServer, api, waitFor } from './helpers.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';
import { pidAlive } from '../src/plugins/ports.js';

const run = promisify(execFile);
async function git(cwd, ...args) { await run('git', ['-C', cwd, ...args]); }

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

test('restart: 409 while not running; picks up a new commit and clears stale', async () => {
  const boot = await setup();
  try {
    const dir = path.join(boot.projectsRoot, 'fakeplug');
    await git(dir, 'init', '-q');
    await git(dir, 'config', 'user.email', 'test@test');
    await git(dir, 'config', 'user.name', 'test');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'initial');

    await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/enable');
    const notRunning = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/restart');
    assert.equal(notRunning.status, 409);

    const st = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/start');
    assert.equal(st.body.stale, false);
    const pid = st.body.pid;

    await fs.writeFile(path.join(dir, 'extra.txt'), 'change');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'second');

    const staleRow = (await api(boot.baseUrl, 'GET', '/api/plugins')).body.find(p => p.id === 'fake-plugin');
    assert.equal(staleRow.stale, true);

    const restarted = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/restart');
    assert.equal(restarted.status, 200);
    assert.equal(restarted.body.state, 'ready');
    assert.notEqual(restarted.body.pid, pid);
    assert.equal(restarted.body.stale, false);
    await waitFor(() => !pidAlive(pid));
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

test('GET /api/plugins/library lists the default code-share entry, unmarked installed', async () => {
  const boot = await bootServer();
  try {
    const r = await api(boot.baseUrl, 'GET', '/api/plugins/library');
    assert.equal(r.status, 200);
    const row = r.body.find(e => e.id === 'code-share');
    assert.ok(row, 'default entry present');
    assert.equal(row.repo, 'https://github.com/UnmanagedCode/code-share');
    assert.equal(row.installed, false);
  } finally { await boot.close(); }
});

test('GET /api/plugins/library also lists the code-playwright default entry with its postClone/postPull command', async () => {
  const boot = await bootServer();
  try {
    const r = await api(boot.baseUrl, 'GET', '/api/plugins/library');
    const row = r.body.find(e => e.id === 'code-playwright');
    assert.ok(row, 'default entry present');
    assert.equal(row.repo, 'https://github.com/UnmanagedCode/code-playwright');
    assert.equal(row.postClone, 'bash install.sh');
    assert.equal(row.postPull, 'bash install.sh');
  } finally { await boot.close(); }
});

test('POST /api/plugins/library/:id/update — unknown id 404, not-installed 404', async () => {
  const boot = await bootServer();
  try {
    const ghost = await api(boot.baseUrl, 'POST', '/api/plugins/library/ghost/update');
    assert.equal(ghost.status, 404);

    const notInstalled = await api(boot.baseUrl, 'POST', '/api/plugins/library/code-share/update');
    assert.equal(notInstalled.status, 404);
    assert.match(notInstalled.body.error, /not installed/);
  } finally { await boot.close(); }
});

test('GET /api/plugins/library marks an entry installed once its target dir exists', async () => {
  const boot = await bootServer();
  try {
    await fs.mkdir(path.join(boot.projectsRoot, 'code-share'), { recursive: true });
    const r = await api(boot.baseUrl, 'GET', '/api/plugins/library');
    const row = r.body.find(e => e.id === 'code-share');
    assert.equal(row.installed, true);
    assert.equal(row.installedAs, 'code-share');
  } finally { await boot.close(); }
});

test('POST /api/plugins/library/:id/install — unknown id 404, already-installed 409', async () => {
  const boot = await bootServer();
  try {
    const ghost = await api(boot.baseUrl, 'POST', '/api/plugins/library/ghost/install');
    assert.equal(ghost.status, 404);

    await fs.mkdir(path.join(boot.projectsRoot, 'code-share'), { recursive: true });
    const taken = await api(boot.baseUrl, 'POST', '/api/plugins/library/code-share/install');
    assert.equal(taken.status, 409);
    assert.match(taken.body.error, /already installed/);
  } finally { await boot.close(); }
});

test('POST /api/plugins/library/:id/install — disallowed repo URL scheme rejects with 400 before any clone', async () => {
  const boot = await bootServer();
  try {
    const libDir = path.join(boot.projectsRoot, '.code-conductor', 'plugins', 'library');
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(path.join(libDir, 'sketchy.json'), JSON.stringify({
      id: 'sketchy', name: 'Sketchy', repo: 'ftp://example.com/org/sketchy',
    }));
    const r = await api(boot.baseUrl, 'POST', '/api/plugins/library/sketchy/install');
    assert.equal(r.status, 400);
    await assert.rejects(fs.stat(path.join(boot.projectsRoot, 'sketchy')), { code: 'ENOENT' });
  } finally { await boot.close(); }
});

// api()'s JSON.parse(text) can't parse multi-line NDJSON, so it falls back
// to the raw string — split + parse each line ourselves to inspect the
// chunk/result event stream the install/update routes now emit.
function parseNdjson(body) {
  return body.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('POST /api/plugins/library/:id/install — streams NDJSON chunks, terminal ok:false on clone failure', async () => {
  const boot = await bootServer();
  try {
    const libDir = path.join(boot.projectsRoot, '.code-conductor', 'plugins', 'library');
    await fs.mkdir(libDir, { recursive: true });
    // A scheme-valid but unreachable URL (nothing listens on 127.0.0.1:1) —
    // git fails fast with connection-refused rather than a DNS timeout.
    await fs.writeFile(path.join(libDir, 'unreachable.json'), JSON.stringify({
      id: 'unreachable', name: 'Unreachable', repo: 'http://127.0.0.1:1/nowhere/repo.git',
    }));

    const r = await api(boot.baseUrl, 'POST', '/api/plugins/library/unreachable/install');
    assert.equal(r.status, 200, 'validation passed — response is already streaming, not a 502');
    const lines = parseNdjson(r.body);
    assert.ok(lines.some(l => l.type === 'chunk'), 'clone output streamed as chunk events');
    const result = lines.find(l => l.type === 'result');
    assert.ok(result, 'terminal result event present');
    assert.equal(result.ok, false);
    assert.ok(result.tail, 'failure carries a stderr/stdout tail');
    await assert.rejects(fs.stat(path.join(boot.projectsRoot, 'repo')), { code: 'ENOENT' }, 'partial clone cleaned up');
  } finally { await boot.close(); }
});

test('POST /api/plugins/library/:id/update — streams NDJSON chunks, terminal ok:true, and actually fast-forwards', async () => {
  const boot = await bootServer();
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-remote-'));
  const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-seed-'));
  try {
    await git(remoteDir, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare');
    await git(seedDir, '-c', 'init.defaultBranch=main', 'init', '-q');
    await git(seedDir, 'config', 'user.email', 'test@test');
    await git(seedDir, 'config', 'user.name', 'test');
    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v1');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v1');
    await git(seedDir, 'remote', 'add', 'origin', remoteDir);
    await git(seedDir, 'push', '-q', 'origin', 'main');

    await git(boot.projectsRoot, 'clone', '-q', remoteDir, 'code-x');

    // A new commit lands upstream after the install-time clone.
    await fs.writeFile(path.join(seedDir, 'file.txt'), 'v2');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v2');
    await git(seedDir, 'push', '-q', 'origin', 'main');

    const libDir = path.join(boot.projectsRoot, '.code-conductor', 'plugins', 'library');
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(path.join(libDir, 'code-x.json'), JSON.stringify({
      id: 'code-x', name: 'Code X', repo: 'https://example.com/org/code-x',
    }));

    const r = await api(boot.baseUrl, 'POST', '/api/plugins/library/code-x/update');
    assert.equal(r.status, 200);
    const lines = parseNdjson(r.body);
    assert.ok(lines.some(l => l.type === 'chunk'), 'pull output streamed as chunk events');
    const result = lines.find(l => l.type === 'result');
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.equal(result.result.name, 'code-x');

    const content = await fs.readFile(path.join(boot.projectsRoot, 'code-x', 'file.txt'), 'utf8');
    assert.equal(content, 'v2', 'pull actually fast-forwarded');
  } finally {
    await boot.close();
    await fs.rm(remoteDir, { recursive: true, force: true });
    await fs.rm(seedDir, { recursive: true, force: true });
  }
});

// End-to-end wiring: a real contributions-only plugin, enabled via the host,
// must surface through server.js's provider hookup on the project-conventions
// REST endpoint (the path the new-project dialog fetches), carrying the scaffold
// facet, and create_project must return the composed scaffold directive.
test('contributions-only plugin (convention w/ scaffold facet) flows through to /api/settings/project-conventions', async () => {
  const boot = await bootServer();
  try {
    const dir = path.join(boot.projectsRoot, 'convplug');
    await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true }); // brings conventions/sample.md + scaffolds/sample.md
    // One convention carrying BOTH facets (fragment file + scaffold file) —
    // mirrors code-playwright's post-migration shape.
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
      id: 'conv-plugin', name: 'Conv Plugin', version: '1.0.0', pluginApi: 1,
      conventions: [{ slug: 'vis-check', name: 'Visual check', description: 'verify UX', file: 'conventions/sample.md', scope: 'project', scaffold: { file: 'scaffolds/sample.md' } }],
    }));

    // Before enable: not offered.
    let conv = await api(boot.baseUrl, 'GET', '/api/settings/project-conventions');
    assert.ok(!conv.body.rules.some(r => r.slug === 'conv-plugin/vis-check'));

    await boot.pluginHost.enable('conv-plugin');
    // Row: backendless, contribution metadata present with hasScaffold; no
    // separate scaffolds array.
    const row = (await api(boot.baseUrl, 'GET', '/api/plugins')).body.find(p => p.id === 'conv-plugin');
    assert.equal(row.hasBackend, false);
    assert.equal(row.state, 'enabled');
    assert.deepEqual(row.conventions, [{ slug: 'conv-plugin/vis-check', name: 'Visual check', description: 'verify UX', hasScaffold: true }]);
    assert.equal(row.scaffolds, undefined);

    // After enable: convention merged (namespaced, plugin-tagged, carries scaffold text).
    conv = await api(boot.baseUrl, 'GET', '/api/settings/project-conventions');
    const g = conv.body.rules.find(r => r.slug === 'conv-plugin/vis-check');
    assert.ok(g, 'plugin convention in the catalog');
    assert.equal(g.plugin, 'conv-plugin');
    assert.equal(g.builtin, false);
    assert.match(g.scaffold, /harness wrapper/);

    // Create a project selecting it: convention snapshots inline; scaffold
    // directive is RETURNED (never persisted).
    const created = await api(boot.baseUrl, 'POST', '/api/projects', { name: 'usesconv', conventions: ['conv-plugin/vis-check'] });
    assert.equal(created.status, 201);
    assert.match(created.body.scaffold, /Project "usesconv" was created with these scaffolding steps/);
    assert.match(created.body.scaffold, /harness wrapper/);
    const claudeMd = await fs.readFile(path.join(boot.projectsRoot, 'usesconv', 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /Visual UX verification/);
    // Scaffold is NOT persisted to project meta.
    await assert.rejects(fs.stat(path.join(boot.projectsRoot, '.code-conductor', 'projects', 'usesconv', 'project.json')), { code: 'ENOENT' });

    // Disable → convention drops from the catalog; the snapshot survives.
    await boot.pluginHost.disable('conv-plugin');
    conv = await api(boot.baseUrl, 'GET', '/api/settings/project-conventions');
    assert.ok(!conv.body.rules.some(r => r.slug === 'conv-plugin/vis-check'));
    const still = await fs.readFile(path.join(boot.projectsRoot, 'usesconv', 'CLAUDE.md'), 'utf8');
    assert.match(still, /Visual UX verification/, 'applied convention snapshot survives disable');
  } finally { await boot.close(); }
});
