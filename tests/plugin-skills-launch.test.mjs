import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';

// End-to-end wire: an enabled cc plugin declaring `claudePlugin` (a Claude Code
// plugin root) must add `--plugin-dir <root>` to the claude subprocess argv at
// spawn — proving provider injection (server.ts) → resolver (registry) → the
// frozen-on-Instance list → sync append in Instance.spawn().
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-instance.json');

let ctx, baseUrl, instances, pluginHost, home;

before(async () => {
  ctx = await bootServer({ scenarioPath: SCENARIO });
  ({ baseUrl, instances, pluginHost } = ctx);
});
after(async () => { await ctx.close(); });
beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home;
  ctx.projectsRoot = r.projectsRoot;
  ctx.claudeProjectsRoot = r.claudeProjectsRoot;
});
afterEach(async () => { await instances.shutdown(); await rmrf(home); });

// Write a cc plugin project (manifest + a Claude Code plugin root at <rel>) under
// the active projects root.
async function addSkillPlugin(projectsRoot, { rel = 'claude', withCcRoot = true } = {}) {
  const dir = path.join(projectsRoot, 'skillp');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
    id: 'skill-plugin', name: 'Skill Plugin', version: '1.0.0', pluginApi: 1, claudePlugin: rel,
  }));
  if (withCcRoot) {
    const root = path.join(dir, rel);
    await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'skill-plugin-cc' }));
  }
  return dir;
}

async function spawnInProject() {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  const r = await api(baseUrl, 'POST', '/api/instances', { project: 'p', mode: 'bypassPermissions' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  await waitFor(() => instances.get(id)?.status === 'idle');
  return instances.get(id);
}

test('enabled plugin with claudePlugin adds --plugin-dir at spawn', async () => {
  await addSkillPlugin(ctx.projectsRoot);
  await pluginHost.rescan();
  await pluginHost.enable('skill-plugin');
  const [root] = await pluginHost.claudePluginDirs();
  assert.ok(root, 'claudePluginDirs should resolve one root');

  const inst = await spawnInProject();
  const argv = inst._spawnArgv;
  const idx = argv.indexOf('--plugin-dir');
  assert.ok(idx >= 0, `--plugin-dir missing from argv: ${argv.join(' ')}`);
  assert.equal(argv[idx + 1], root);
});

test('no --plugin-dir when no enabled plugin ships a claudePlugin', async () => {
  const inst = await spawnInProject();
  assert.ok(!inst._spawnArgv.includes('--plugin-dir'));
});

test('missing .claude-plugin/plugin.json → flag dropped, session still launches', async () => {
  await addSkillPlugin(ctx.projectsRoot, { withCcRoot: false });
  await pluginHost.rescan();
  await pluginHost.enable('skill-plugin');

  const inst = await spawnInProject(); // still reaches idle
  assert.ok(!inst._spawnArgv.includes('--plugin-dir'));
});
