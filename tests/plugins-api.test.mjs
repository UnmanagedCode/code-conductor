import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bootServer, api, waitFor, registerLocalProject} from './helpers.mjs';
import { FAKE_PLUGIN_DIR } from './plugin-helpers.mjs';
import { pidAlive } from '../src/plugins/ports.ts';
import { orchStoreRoot } from '../src/projects.ts';

const run = promisify(execFile);
async function git(cwd, ...args) { await run('git', ['-C', cwd, ...args]); }

async function setup() {
  const boot = await bootServer();
  const dir = path.join(boot.projectsRoot, 'fakeplug');
  await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true });
  await registerLocalProject('fakeplug', dir);
  return boot;
}

test('GET /api/plugins lists the discovered catalog', async () => {
  const boot = await setup();
  try {
    const r = await api(boot.baseUrl, 'GET', '/api/plugins');
    assert.equal(r.status, 200);
    const row = r.body.rows.find(p => p.id === 'fake-plugin');
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

    const staleRow = (await api(boot.baseUrl, 'GET', '/api/plugins')).body.rows.find(p => p.id === 'fake-plugin');
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
    await registerLocalProject('second', dir);
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
    await registerLocalProject('badplug', bad);
    await fs.writeFile(path.join(bad, 'conductor.plugin.json'), JSON.stringify({ id: 'badplug', pluginApi: 1 }));

    assert.equal((await api(boot.baseUrl, 'POST', '/api/plugins/ghost/enable')).status, 404);
    assert.equal((await api(boot.baseUrl, 'GET', '/api/plugins/ghost/status')).status, 404);
    const inv = await api(boot.baseUrl, 'POST', '/api/plugins/badplug/enable');
    assert.equal(inv.status, 409);
    assert.match(inv.body.error, /invalid/);
    const notEnabled = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/start');
    assert.equal(notEnabled.status, 409);
    const listed = await api(boot.baseUrl, 'GET', '/api/plugins');
    assert.equal(listed.body.rows.find(p => p.project === 'badplug')?.state, 'invalid');
  } finally { await boot.close(); }
});

// The wire half of the corrupt-registry surfacing: a notices() accessor nobody
// wires into the route would leave the user just as uninformed as the old
// console.warn did.
test('GET /api/plugins reports a corrupt registry as a notice', async () => {
  const boot = await setup();
  try {
    // Seeded before the first request, which is what triggers ensureInit.
    const registryFile = path.join(orchStoreRoot(), 'plugins', 'registry.json');
    await fs.mkdir(path.dirname(registryFile), { recursive: true });
    await fs.writeFile(registryFile, '{ not json');

    const r = await api(boot.baseUrl, 'GET', '/api/plugins');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.rows), 'the catalog still serves — never fatal');
    assert.equal(r.body.notices.length, 1);
    assert.equal(r.body.notices[0].file, 'registry.json');
    assert.match(r.body.notices[0].backup, /registry\.json\.corrupt$/);
  } finally { await boot.close(); }
});

// The wire half of the library-skip surfacing.
test('GET /api/plugins/library reports a malformed drop-in in skipped', async () => {
  const boot = await bootServer();
  try {
    const libDir = path.join(orchStoreRoot(), 'plugins', 'library');
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(path.join(libDir, 'broken.json'), '{ not json');

    const r = await api(boot.baseUrl, 'GET', '/api/plugins/library');
    assert.equal(r.status, 200);
    assert.ok(r.body.entries.length > 0, 'the built-in entries still serve');
    assert.equal(r.body.skipped.length, 1);
    assert.equal(r.body.skipped[0].file, 'broken.json');
    assert.equal(r.body.skipped[0].dir, libDir);
    assert.ok(r.body.skipped[0].reason.length > 0);
  } finally { await boot.close(); }
});

test('GET /api/plugins/library lists the default code-share entry, unmarked installed', async () => {
  const boot = await bootServer();
  try {
    const r = await api(boot.baseUrl, 'GET', '/api/plugins/library');
    assert.equal(r.status, 200);
    const row = r.body.entries.find(e => e.id === 'code-share');
    assert.ok(row, 'default entry present');
    assert.equal(row.repo, 'https://github.com/UnmanagedCode/code-share');
    assert.equal(row.installed, false);
  } finally { await boot.close(); }
});

test('GET /api/plugins/library also lists the code-playwright default entry with its postClone/postPull command', async () => {
  const boot = await bootServer();
  try {
    const r = await api(boot.baseUrl, 'GET', '/api/plugins/library');
    const row = r.body.entries.find(e => e.id === 'code-playwright');
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

test('GET /api/plugins/library marks an entry installed once its project is registered', async () => {
  const boot = await bootServer();
  try {
    await registerLocalProject('code-share', path.join(boot.projectsRoot, '.plugins', 'code-share'));
    const r = await api(boot.baseUrl, 'GET', '/api/plugins/library');
    const row = r.body.entries.find(e => e.id === 'code-share');
    assert.equal(row.installed, true);
    assert.equal(row.installedAs, 'code-share');
  } finally { await boot.close(); }
});

test('POST /api/plugins/library/:id/install — unknown id 404, already-installed 409', async () => {
  const boot = await bootServer();
  try {
    const ghost = await api(boot.baseUrl, 'POST', '/api/plugins/library/ghost/install');
    assert.equal(ghost.status, 404);

    await registerLocalProject('code-share', path.join(boot.projectsRoot, '.plugins', 'code-share'));
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
    await registerLocalProject('code-x', path.join(boot.projectsRoot, 'code-x'));

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
// must surface through server.ts's provider hookup on the project-conventions
// REST endpoint (the path the new-project dialog fetches), carrying the scaffold
// facet, and create_project must return the composed scaffold directive.
test('contributions-only plugin (convention w/ scaffold facet) flows through to /api/settings/conventions/project', async () => {
  const boot = await bootServer();
  try {
    const dir = path.join(boot.projectsRoot, 'convplug');
    await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true });
    await registerLocalProject('convplug', dir); // brings conventions/sample.md + scaffolds/sample.md
    // One convention carrying BOTH facets (fragment file + scaffold file) —
    // mirrors code-playwright's post-migration shape.
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
      id: 'conv-plugin', name: 'Conv Plugin', version: '1.0.0', pluginApi: 1,
      conventions: [{ slug: 'vis-check', name: 'Visual check', description: 'verify UX', file: 'conventions/sample.md', scope: 'project', scaffold: { file: 'scaffolds/sample.md' } }],
    }));

    // Before enable: not offered.
    let conv = await api(boot.baseUrl, 'GET', '/api/settings/conventions/project');
    assert.ok(!conv.body.conventions.some(r => r.slug === 'conv-plugin/vis-check'));

    await boot.pluginHost.enable('conv-plugin');
    // Row: backendless, contribution metadata present with hasScaffold; no
    // separate scaffolds array.
    const row = (await api(boot.baseUrl, 'GET', '/api/plugins')).body.rows.find(p => p.id === 'conv-plugin');
    assert.equal(row.hasBackend, false);
    assert.equal(row.state, 'enabled');
    assert.deepEqual(row.conventions, [{ slug: 'conv-plugin/vis-check', name: 'Visual check', description: 'verify UX', hasScaffold: true }]);
    assert.equal(row.scaffolds, undefined);

    // After enable: convention merged (namespaced, plugin-tagged, carries scaffold text).
    conv = await api(boot.baseUrl, 'GET', '/api/settings/conventions/project');
    const g = conv.body.conventions.find(r => r.slug === 'conv-plugin/vis-check');
    assert.ok(g, 'plugin convention in the catalog');
    assert.equal(g.plugin, 'conv-plugin');
    assert.equal(g.builtin, false);
    assert.match(g.scaffold, /harness wrapper/);

    // Create a project selecting it: convention body lands in CONVENTIONS.md;
    // scaffold directive is RETURNED (never persisted).
    const created = await api(boot.baseUrl, 'POST', '/api/projects', { name: 'usesconv', conventions: ['conv-plugin/vis-check'] });
    assert.equal(created.status, 201);
    assert.match(created.body.scaffold, /Project "usesconv" was created with these scaffolding steps/);
    assert.match(created.body.scaffold, /harness wrapper/);
    const conventionsMd = await fs.readFile(path.join(boot.projectsRoot, 'usesconv', 'CONVENTIONS.md'), 'utf8');
    assert.match(conventionsMd, /Visual UX verification/);
    // Scaffold is NOT persisted to the project record — which now always
    // exists, because the record IS the registration.
    const rec = JSON.parse(await fs.readFile(
      path.join(boot.projectsRoot, '.code-conductor', 'projects', 'usesconv', 'project.json'), 'utf8'));
    assert.deepEqual(Object.keys(rec), ['location']);

    // Disable → convention drops from the catalog; the committed CONVENTIONS.md
    // survives because this is the direct host call, which runs no fan-out (the
    // HTTP disable route does — pinned by the next test).
    await boot.pluginHost.disable('conv-plugin');
    conv = await api(boot.baseUrl, 'GET', '/api/settings/conventions/project');
    assert.ok(!conv.body.conventions.some(r => r.slug === 'conv-plugin/vis-check'));
    const still = await fs.readFile(path.join(boot.projectsRoot, 'usesconv', 'CONVENTIONS.md'), 'utf8');
    assert.match(still, /Visual UX verification/, 'committed convention body survives disable');
  } finally { await boot.close(); }
});

test('enable/disable a project-convention plugin fans out to referencing projects', async () => {
  const boot = await bootServer();
  try {
    const dir = path.join(boot.projectsRoot, 'projconvplug');
    await fs.cp(FAKE_PLUGIN_DIR, dir, { recursive: true }); // brings conventions/sample.md
    await registerLocalProject('projconvplug', dir);
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
      id: 'projconv', name: 'Proj Conv', version: '1.0.0', pluginApi: 1,
      conventions: [{ slug: 'vis', name: 'Visual check', description: 'verify UX', file: 'conventions/sample.md', scope: 'project' }],
    }));

    // Enable via the HTTP route, then a project selects the plugin convention.
    assert.equal((await api(boot.baseUrl, 'POST', '/api/plugins/projconv/enable')).status, 200);
    const created = await api(boot.baseUrl, 'POST', '/api/projects', { name: 'refproj', conventions: ['projconv/vis'] });
    assert.equal(created.status, 201);
    const target = path.join(boot.projectsRoot, 'refproj', 'CONVENTIONS.md');
    assert.match(await fs.readFile(target, 'utf8'), /Visual UX verification/);

    // Mangle the body (marker intact) to prove the fan-out actually rewrites.
    await fs.writeFile(target, '<!-- cc:conventions projconv/vis -->\n\nSTALE BODY\n');

    // Disable → fan-out runs; the marker's only slug is now unresolvable (a
    // clean disable, not a degraded catalog), so it is demoted to the note and
    // KEPT in the marker, while the workspace block still refreshes.
    assert.equal((await api(boot.baseUrl, 'POST', '/api/plugins/projconv/disable')).status, 200);
    const disabled = await fs.readFile(target, 'utf8');
    assert.equal(disabled.split('\n', 1)[0], '<!-- cc:conventions projconv/vis -->', 'the slug survives in the marker');
    assert.match(disabled, /> Convention unavailable: `projconv\/vis`\./);
    assert.match(disabled, /# Workspace conventions/);
    assert.doesNotMatch(disabled, /STALE BODY/);

    // Re-enable → fan-out re-resolves the slug ⇒ CONVENTIONS.md refreshed.
    assert.equal((await api(boot.baseUrl, 'POST', '/api/plugins/projconv/enable')).status, 200);
    const refreshed = await fs.readFile(target, 'utf8');
    assert.match(refreshed, /Visual UX verification/, 'enable refreshed the referencing project');
    assert.doesNotMatch(refreshed, /STALE BODY/);
  } finally { await boot.close(); }
});

test('restart drops the cached fragment body so /api/settings/conventions/project sees the on-disk edit', async () => {
  const boot = await setup(); // fakeplug carries FAKE_PLUGIN_DIR's server.mjs + conventions/sample.md
  try {
    const dir = path.join(boot.projectsRoot, 'fakeplug');
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
      id: 'fake-plugin', name: 'Fake Plugin', version: '1.0.0', pluginApi: 1,
      backend: { start: 'node server.mjs', healthPath: '/health' },
      conventions: [{ slug: 'vis', name: 'Visual check', description: 'verify UX', file: 'conventions/sample.md', scope: 'project' }],
    }));

    await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/enable');
    const st = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/start');
    assert.equal(st.body.state, 'ready');

    let conv = await api(boot.baseUrl, 'GET', '/api/settings/conventions/project');
    let g = conv.body.conventions.find(r => r.slug === 'fake-plugin/vis');
    assert.match(g.body, /Visual UX verification/);

    await fs.writeFile(path.join(dir, 'conventions', 'sample.md'), '## V2 body\n- new text');
    const restarted = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/restart');
    assert.equal(restarted.status, 200);

    conv = await api(boot.baseUrl, 'GET', '/api/settings/conventions/project');
    g = conv.body.conventions.find(r => r.slug === 'fake-plugin/vis');
    assert.match(g.body, /V2 body/);
    assert.doesNotMatch(g.body, /Visual UX verification/);
  } finally { await boot.close(); }
});

// A minimal git "dumb HTTP" remote: serves a bare repo's files verbatim under
// `<prefix>/...` (no CGI, no git-daemon) — git's client falls back to the
// dumb protocol against any plain static server, which is all `install()`'s
// real `git clone` needs to exercise the REAL install route end-to-end
// (validateRepoUrl only allows http:/https:/git: schemes, so a bare
// filesystem path can't stand in for `entry.repo` there). Caller must run
// `git update-server-info` in `remoteDir` after every push.
function serveGitDumbHttp(remoteDir, prefix) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (!u.pathname.startsWith(`${prefix}/`)) { res.writeHead(404); res.end(); return; }
      const filePath = path.join(remoteDir, u.pathname.slice(prefix.length + 1));
      fs.readFile(filePath)
        .then((data) => { res.writeHead(200); res.end(data); })
        .catch(() => { res.writeHead(404); res.end(); });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Shared git scaffolding for the library-update tests below: a bare "remote",
// a "seed" working copy that pushes to it, and a project directory cloned
// from the remote into boot.projectsRoot (mirrors the existing update() NDJSON
// test above). `manifestExtra` is merged into the fixture's conductor.plugin.json.
async function seedLibraryGitProject({ projectsRoot, projectName, manifestExtra = {}, withFixtureBackend = false, libraryExtra = {} }) {
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-remote-'));
  const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-seed-'));
  await git(remoteDir, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare');
  if (withFixtureBackend) await fs.cp(FAKE_PLUGIN_DIR, seedDir, { recursive: true });
  await git(seedDir, '-c', 'init.defaultBranch=main', 'init', '-q');
  await git(seedDir, 'config', 'user.email', 'test@test');
  await git(seedDir, 'config', 'user.name', 'test');
  await fs.writeFile(path.join(seedDir, 'conductor.plugin.json'), JSON.stringify({
    id: projectName, name: projectName, version: '1.0.0', pluginApi: 1, ...manifestExtra,
  }));
  await git(seedDir, 'add', '-A');
  await git(seedDir, 'commit', '-q', '-m', 'v1');
  await git(seedDir, 'remote', 'add', 'origin', remoteDir);
  await git(seedDir, 'push', '-q', 'origin', 'main');
  await git(projectsRoot, 'clone', '-q', remoteDir, projectName);
  await registerLocalProject(projectName, path.join(projectsRoot, projectName));

  const libDir = path.join(projectsRoot, '.code-conductor', 'plugins', 'library');
  await fs.mkdir(libDir, { recursive: true });
  await fs.writeFile(path.join(libDir, `${projectName}.json`), JSON.stringify({
    id: projectName, name: projectName, repo: `https://example.com/org/${projectName}`, ...libraryExtra,
  }));
  return { remoteDir, seedDir };
}

test('library update regenerates a referencing project\'s CONVENTIONS.md even when the fragment text is unchanged', async () => {
  const boot = await bootServer();
  let scaffold;
  try {
    scaffold = await seedLibraryGitProject({
      projectsRoot: boot.projectsRoot, projectName: 'code-x',
      manifestExtra: { conventions: [{ slug: 'vis', name: 'Visual check', description: 'verify UX', file: 'conventions/vis.md', scope: 'project' }] },
    });
    await fs.mkdir(path.join(scaffold.seedDir, 'conventions'), { recursive: true });
    await fs.writeFile(path.join(scaffold.seedDir, 'conventions', 'vis.md'), '## V1 body\n- old text');
    await git(scaffold.seedDir, 'add', '-A');
    await git(scaffold.seedDir, 'commit', '-q', '-m', 'add fragment');
    await git(scaffold.seedDir, 'push', '-q', 'origin', 'main');
    await git(path.join(boot.projectsRoot, 'code-x'), 'pull', '-q'); // clone made before the fragment existed

    assert.equal((await api(boot.baseUrl, 'POST', '/api/plugins/code-x/enable')).status, 200);
    const created = await api(boot.baseUrl, 'POST', '/api/projects', { name: 'refproj', conventions: ['code-x/vis'] });
    assert.equal(created.status, 201);
    const target = path.join(boot.projectsRoot, 'refproj', 'CONVENTIONS.md');
    assert.match(await fs.readFile(target, 'utf8'), /V1 body/);

    // Mangle (marker intact) — proves the fan-out actually rewrites, not that
    // it happened to already hold the right text.
    await fs.writeFile(target, '<!-- cc:conventions code-x/vis -->\n\nSTALE BODY\n');

    // Upstream commit that does NOT touch the fragment.
    await fs.writeFile(path.join(scaffold.seedDir, 'unrelated.txt'), 'noise');
    await git(scaffold.seedDir, 'add', '-A');
    await git(scaffold.seedDir, 'commit', '-q', '-m', 'unrelated');
    await git(scaffold.seedDir, 'push', '-q', 'origin', 'main');

    const r = await api(boot.baseUrl, 'POST', '/api/plugins/library/code-x/update');
    assert.equal(r.status, 200);

    const refreshed = await fs.readFile(target, 'utf8');
    assert.match(refreshed, /V1 body/);
    assert.doesNotMatch(refreshed, /STALE BODY/);
  } finally {
    await boot.close();
    if (scaffold) { await fs.rm(scaffold.remoteDir, { recursive: true, force: true }); await fs.rm(scaffold.seedDir, { recursive: true, force: true }); }
  }
});

test('library update propagates a changed fragment body to a referencing project\'s CONVENTIONS.md', async () => {
  const boot = await bootServer();
  let scaffold;
  try {
    scaffold = await seedLibraryGitProject({
      projectsRoot: boot.projectsRoot, projectName: 'code-y',
      manifestExtra: { conventions: [{ slug: 'vis', name: 'Visual check', description: 'verify UX', file: 'conventions/vis.md', scope: 'project' }] },
    });
    await fs.mkdir(path.join(scaffold.seedDir, 'conventions'), { recursive: true });
    await fs.writeFile(path.join(scaffold.seedDir, 'conventions', 'vis.md'), '## V1 body\n- old text');
    await git(scaffold.seedDir, 'add', '-A');
    await git(scaffold.seedDir, 'commit', '-q', '-m', 'add fragment');
    await git(scaffold.seedDir, 'push', '-q', 'origin', 'main');
    await git(path.join(boot.projectsRoot, 'code-y'), 'pull', '-q');

    assert.equal((await api(boot.baseUrl, 'POST', '/api/plugins/code-y/enable')).status, 200);
    const created = await api(boot.baseUrl, 'POST', '/api/projects', { name: 'refproj2', conventions: ['code-y/vis'] });
    assert.equal(created.status, 201);
    const target = path.join(boot.projectsRoot, 'refproj2', 'CONVENTIONS.md');
    assert.match(await fs.readFile(target, 'utf8'), /V1 body/);

    // Upstream commit that CHANGES the fragment.
    await fs.writeFile(path.join(scaffold.seedDir, 'conventions', 'vis.md'), '## V2 body\n- new text');
    await git(scaffold.seedDir, 'add', '-A');
    await git(scaffold.seedDir, 'commit', '-q', '-m', 'v2');
    await git(scaffold.seedDir, 'push', '-q', 'origin', 'main');

    const r = await api(boot.baseUrl, 'POST', '/api/plugins/library/code-y/update');
    assert.equal(r.status, 200);

    const refreshed = await fs.readFile(target, 'utf8');
    assert.match(refreshed, /V2 body/);
    assert.doesNotMatch(refreshed, /V1 body/);
  } finally {
    await boot.close();
    if (scaffold) { await fs.rm(scaffold.remoteDir, { recursive: true, force: true }); await fs.rm(scaffold.seedDir, { recursive: true, force: true }); }
  }
});

test('library update auto-restarts a running plugin backend and clears its staleness', async () => {
  const boot = await bootServer();
  let scaffold;
  try {
    scaffold = await seedLibraryGitProject({
      projectsRoot: boot.projectsRoot, projectName: 'fake-lib', withFixtureBackend: true,
      manifestExtra: { backend: { start: 'node server.mjs', healthPath: '/health' } },
    });

    await api(boot.baseUrl, 'POST', '/api/plugins/fake-lib/enable');
    const st = await api(boot.baseUrl, 'POST', '/api/plugins/fake-lib/start');
    assert.equal(st.body.state, 'ready');
    const pid1 = st.body.pid;

    await fs.writeFile(path.join(scaffold.seedDir, 'extra.txt'), 'v2');
    await git(scaffold.seedDir, 'add', '-A');
    await git(scaffold.seedDir, 'commit', '-q', '-m', 'v2');
    await git(scaffold.seedDir, 'push', '-q', 'origin', 'main');

    const r = await api(boot.baseUrl, 'POST', '/api/plugins/library/fake-lib/update');
    assert.equal(r.status, 200);
    const result = parseNdjson(r.body).find(l => l.type === 'result');
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.equal(result.result.restarted.ok, true);
    assert.deepEqual(result.result.restarted.ids, ['fake-lib']);

    await waitFor(() => !pidAlive(pid1));
    const status = await api(boot.baseUrl, 'GET', '/api/plugins/fake-lib/status');
    assert.equal(status.body.state, 'ready');
    assert.notEqual(status.body.pid, pid1);
    assert.equal(status.body.stale, false);
  } finally {
    await boot.close();
    if (scaffold) { await fs.rm(scaffold.remoteDir, { recursive: true, force: true }); await fs.rm(scaffold.seedDir, { recursive: true, force: true }); }
  }
});

test('library update never auto-starts a plugin backend that was never running', async () => {
  const boot = await bootServer();
  let scaffold;
  try {
    scaffold = await seedLibraryGitProject({
      projectsRoot: boot.projectsRoot, projectName: 'fake-lib2', withFixtureBackend: true,
      manifestExtra: { backend: { start: 'node server.mjs', healthPath: '/health' } },
    });

    await api(boot.baseUrl, 'POST', '/api/plugins/fake-lib2/enable'); // never started

    await fs.writeFile(path.join(scaffold.seedDir, 'extra.txt'), 'v2');
    await git(scaffold.seedDir, 'add', '-A');
    await git(scaffold.seedDir, 'commit', '-q', '-m', 'v2');
    await git(scaffold.seedDir, 'push', '-q', 'origin', 'main');

    const r = await api(boot.baseUrl, 'POST', '/api/plugins/library/fake-lib2/update');
    assert.equal(r.status, 200);
    const result = parseNdjson(r.body).find(l => l.type === 'result');
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.equal(result.result.restarted, null);

    const status = await api(boot.baseUrl, 'GET', '/api/plugins/fake-lib2/status');
    assert.equal(status.body.state, 'stopped');
    assert.equal(status.body.pid, null);
  } finally {
    await boot.close();
    if (scaffold) { await fs.rm(scaffold.remoteDir, { recursive: true, force: true }); await fs.rm(scaffold.seedDir, { recursive: true, force: true }); }
  }
});

test('library update skips auto-restart (not attempted, not failed) when postPull fails, leaving a running backend untouched', async () => {
  const boot = await bootServer();
  let scaffold;
  try {
    scaffold = await seedLibraryGitProject({
      projectsRoot: boot.projectsRoot, projectName: 'fake-lib3', withFixtureBackend: true,
      manifestExtra: { backend: { start: 'node server.mjs', healthPath: '/health' } },
      libraryExtra: { postPull: 'exit 1' }, // a broken postPull — half-built tree
    });

    await api(boot.baseUrl, 'POST', '/api/plugins/fake-lib3/enable');
    const st = await api(boot.baseUrl, 'POST', '/api/plugins/fake-lib3/start');
    assert.equal(st.body.state, 'ready');
    const pid1 = st.body.pid;

    await fs.writeFile(path.join(scaffold.seedDir, 'extra.txt'), 'v2');
    await git(scaffold.seedDir, 'add', '-A');
    await git(scaffold.seedDir, 'commit', '-q', '-m', 'v2');
    await git(scaffold.seedDir, 'push', '-q', 'origin', 'main');

    const r = await api(boot.baseUrl, 'POST', '/api/plugins/library/fake-lib3/update');
    assert.equal(r.status, 200);
    const result = parseNdjson(r.body).find(l => l.type === 'result');
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.equal(result.result.postPull.ok, false, 'sanity: the postPull hook actually failed');
    assert.deepEqual(result.result.restarted, { skipped: 'postPull-failed' }, 'a skip, not a restart attempt');

    // The pre-update child is left running, untouched — never stopped, never replaced.
    const status = await api(boot.baseUrl, 'GET', '/api/plugins/fake-lib3/status');
    assert.equal(status.body.state, 'ready');
    assert.equal(status.body.pid, pid1);
    assert.equal(pidAlive(pid1), true);
  } finally {
    await boot.close();
    if (scaffold) { await fs.rm(scaffold.remoteDir, { recursive: true, force: true }); await fs.rm(scaffold.seedDir, { recursive: true, force: true }); }
  }
});

test('library update reports null (not a skip) when postPull fails and the plugin was never running', async () => {
  const boot = await bootServer();
  let scaffold;
  try {
    scaffold = await seedLibraryGitProject({
      projectsRoot: boot.projectsRoot, projectName: 'fake-lib4', withFixtureBackend: true,
      manifestExtra: { backend: { start: 'node server.mjs', healthPath: '/health' } },
      libraryExtra: { postPull: 'exit 1' }, // a broken postPull — half-built tree
    });

    await api(boot.baseUrl, 'POST', '/api/plugins/fake-lib4/enable'); // never started

    await fs.writeFile(path.join(scaffold.seedDir, 'extra.txt'), 'v2');
    await git(scaffold.seedDir, 'add', '-A');
    await git(scaffold.seedDir, 'commit', '-q', '-m', 'v2');
    await git(scaffold.seedDir, 'push', '-q', 'origin', 'main');

    const r = await api(boot.baseUrl, 'POST', '/api/plugins/library/fake-lib4/update');
    assert.equal(r.status, 200);
    const result = parseNdjson(r.body).find(l => l.type === 'result');
    assert.ok(result);
    assert.equal(result.ok, true);
    assert.equal(result.result.postPull.ok, false, 'sanity: the postPull hook actually failed');
    // Nothing was running, so this must read exactly like the plain
    // nothing-was-running case — never the skip shape (that claim would be a lie
    // here: there is no backend "left running the old code").
    assert.equal(result.result.restarted, null);

    const status = await api(boot.baseUrl, 'GET', '/api/plugins/fake-lib4/status');
    assert.equal(status.body.state, 'stopped');
    assert.equal(status.body.pid, null);
  } finally {
    await boot.close();
    if (scaffold) { await fs.rm(scaffold.remoteDir, { recursive: true, force: true }); await fs.rm(scaffold.seedDir, { recursive: true, force: true }); }
  }
});

// The four tests below each drive a plugin REST route directly and assert on
// the on-disk CONVENTIONS.md of a project that SELECTED the plugin's
// convention — the actual user-visible artefact — rather than the live
// `/api/settings/conventions/project` catalog or the host method. Each pins
// exactly one of refreshProjectConventions()'s call sites in src/plugins/api.ts.

test('POST /api/plugins/rescan regenerates a referencing project\'s CONVENTIONS.md', async () => {
  const boot = await setup();
  try {
    const dir = path.join(boot.projectsRoot, 'fakeplug');
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
      id: 'fake-plugin', name: 'Fake Plugin', version: '1.0.0', pluginApi: 1,
      conventions: [{ slug: 'vis', name: 'Visual check', description: 'verify UX', file: 'conventions/sample.md', scope: 'project' }],
    }));
    assert.equal((await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/enable')).status, 200);
    const created = await api(boot.baseUrl, 'POST', '/api/projects', { name: 'refproj-rescan', conventions: ['fake-plugin/vis'] });
    assert.equal(created.status, 201);
    const target = path.join(boot.projectsRoot, 'refproj-rescan', 'CONVENTIONS.md');
    assert.match(await fs.readFile(target, 'utf8'), /Visual UX verification/);

    // Mangle (marker intact) — proves the route actually rewrites the file,
    // not that it happened to already hold the right text.
    await fs.writeFile(target, '<!-- cc:conventions fake-plugin/vis -->\n\nSTALE BODY\n');

    const r = await api(boot.baseUrl, 'POST', '/api/plugins/rescan');
    assert.equal(r.status, 200);

    const refreshed = await fs.readFile(target, 'utf8');
    assert.match(refreshed, /Visual UX verification/);
    assert.doesNotMatch(refreshed, /STALE BODY/);
  } finally { await boot.close(); }
});

test('POST /api/plugins/:id/restart regenerates a referencing project\'s CONVENTIONS.md', async () => {
  const boot = await setup();
  try {
    const dir = path.join(boot.projectsRoot, 'fakeplug');
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
      id: 'fake-plugin', name: 'Fake Plugin', version: '1.0.0', pluginApi: 1,
      backend: { start: 'node server.mjs', healthPath: '/health' },
      conventions: [{ slug: 'vis', name: 'Visual check', description: 'verify UX', file: 'conventions/sample.md', scope: 'project' }],
    }));
    await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/enable');
    const st = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/start');
    assert.equal(st.body.state, 'ready');

    const created = await api(boot.baseUrl, 'POST', '/api/projects', { name: 'refproj-restart', conventions: ['fake-plugin/vis'] });
    assert.equal(created.status, 201);
    const target = path.join(boot.projectsRoot, 'refproj-restart', 'CONVENTIONS.md');
    assert.match(await fs.readFile(target, 'utf8'), /Visual UX verification/);

    await fs.writeFile(target, '<!-- cc:conventions fake-plugin/vis -->\n\nSTALE BODY\n');

    const restarted = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/restart');
    assert.equal(restarted.status, 200);

    const refreshed = await fs.readFile(target, 'utf8');
    assert.match(refreshed, /Visual UX verification/);
    assert.doesNotMatch(refreshed, /STALE BODY/);
  } finally { await boot.close(); }
});

test('POST /api/plugins/:id/version regenerates a referencing project\'s CONVENTIONS.md', async () => {
  const boot = await setup();
  try {
    const dir = path.join(boot.projectsRoot, 'fakeplug');
    await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
      id: 'fake-plugin', name: 'Fake Plugin', version: '1.0.0', pluginApi: 1,
      conventions: [{ slug: 'vis', name: 'Visual check', description: 'verify UX', file: 'conventions/sample.md', scope: 'project' }],
    }));
    await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/enable'); // backendless — never 'ready', so the version route's own restart branch never fires

    const created = await api(boot.baseUrl, 'POST', '/api/projects', { name: 'refproj-version', conventions: ['fake-plugin/vis'] });
    assert.equal(created.status, 201);
    const target = path.join(boot.projectsRoot, 'refproj-version', 'CONVENTIONS.md');
    assert.match(await fs.readFile(target, 'utf8'), /Visual UX verification/);

    await fs.writeFile(target, '<!-- cc:conventions fake-plugin/vis -->\n\nSTALE BODY\n');

    const v = await api(boot.baseUrl, 'POST', '/api/plugins/fake-plugin/version', { type: 'main' });
    assert.equal(v.status, 200);

    const refreshed = await fs.readFile(target, 'utf8');
    assert.match(refreshed, /Visual UX verification/);
    assert.doesNotMatch(refreshed, /STALE BODY/);
  } finally { await boot.close(); }
});

test('POST /api/plugins/library/:id/install regenerates a pre-existing project whose CONVENTIONS.md references the not-yet-installed plugin\'s slug', async () => {
  const boot = await bootServer();
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-remote-'));
  const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-seed-'));
  let gitServer;
  try {
    await git(remoteDir, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare');
    await fs.mkdir(path.join(seedDir, 'conventions'), { recursive: true });
    await fs.writeFile(path.join(seedDir, 'conductor.plugin.json'), JSON.stringify({
      id: 'code-z', name: 'Code Z', version: '1.0.0', pluginApi: 1,
      conventions: [{ slug: 'vis', name: 'Visual check', description: 'verify UX', file: 'conventions/vis.md', scope: 'project' }],
    }));
    await fs.writeFile(path.join(seedDir, 'conventions', 'vis.md'), '## Fresh body\n- from install');
    await git(seedDir, '-c', 'init.defaultBranch=main', 'init', '-q');
    await git(seedDir, 'config', 'user.email', 'test@test');
    await git(seedDir, 'config', 'user.name', 'test');
    await git(seedDir, 'add', '-A');
    await git(seedDir, 'commit', '-q', '-m', 'v1');
    await git(seedDir, 'remote', 'add', 'origin', remoteDir);
    await git(seedDir, 'push', '-q', 'origin', 'main');
    await git(remoteDir, 'update-server-info');

    gitServer = await serveGitDumbHttp(remoteDir, '/code-z');
    const { port } = gitServer.address();

    const libDir = path.join(boot.projectsRoot, '.code-conductor', 'plugins', 'library');
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(path.join(libDir, 'code-z.json'), JSON.stringify({
      id: 'code-z', name: 'Code Z', repo: `http://127.0.0.1:${port}/code-z`,
    }));

    // A pre-existing project whose CONVENTIONS.md already references the
    // not-yet-installed plugin's slug — it's the marker's only slug, so
    // nothing resolves to a body and the file is frozen until install clones
    // + auto-enables it. Mirrors library.ts:299-307's own reasoning for
    // adding this call to the install path.
    const refDir = path.join(boot.projectsRoot, 'preexisting');
    await registerLocalProject('preexisting', refDir);
    const target = path.join(refDir, 'CONVENTIONS.md');
    await fs.writeFile(target, '<!-- cc:conventions code-z/vis -->\n\nSTALE BODY\n');

    const r = await api(boot.baseUrl, 'POST', '/api/plugins/library/code-z/install');
    assert.equal(r.status, 200);

    const refreshed = await fs.readFile(target, 'utf8');
    assert.match(refreshed, /Fresh body/);
    assert.doesNotMatch(refreshed, /STALE BODY/);
  } finally {
    await boot.close();
    if (gitServer) await new Promise((resolve) => gitServer.close(resolve));
    await fs.rm(remoteDir, { recursive: true, force: true });
    await fs.rm(seedDir, { recursive: true, force: true });
  }
});
