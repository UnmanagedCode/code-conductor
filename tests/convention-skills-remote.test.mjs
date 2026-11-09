// Remote placement never turns a skill part back into inline text and never
// drops it: the generated roots are always LOCAL (under the store, inside the
// host-pinned projects root), whether the session or the contributing plugin is
// on a remote system.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { CORE_CLAUDE_PLUGIN_ROOT } from '../src/coreClaudePlugin.ts';
import { adoptProject, orchStoreRoot } from '../src/projects.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { resolveTierEntry } from '../src/systems/fuse/tierTable.ts';
import { conventionSkillsDir } from '../src/conventionSkills.ts';
import { conductConventionsPath } from '../src/conduct.ts';
import { ensureProjectConventionsMd } from '../src/projectClaudeMd.ts';
import { copyConventions, addSkill, useConventionsDir } from './conventionsTree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-plugin-skills.json');

let ctx, baseUrl, instances, pluginHost, home, conventionsRoot, restoreConventions, remote;

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
  conventionsRoot = await copyConventions({ stripSkills: true });
  restoreConventions = useConventionsDir(conventionsRoot);
  remote = await bindRemoteSystem();
});
afterEach(async () => {
  await instances.shutdown();
  disposeSystemHandles();
  restoreConventions();
  await rmrf(remote.root);
  await rmrf(home);
});

function pluginDirArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--plugin-dir') out.push(argv[i + 1]);
  return out;
}

async function spawnIn(project, body = {}) {
  const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  await waitFor(() => instances.get(id)?.status === 'idle');
  return instances.get(id);
}

async function initSkills(inst) {
  const isInit = ev => ev.kind === 'system' && ev.subtype === 'init';
  await inst.prompt('hello');
  await waitFor(() => inst.ringSnapshot().some(isInit));
  return inst.ringSnapshot().filter(isInit).at(-1).data.skills.filter(s => s.startsWith('cc-')).sort();
}

test('a remote-backed worker gets its marker-selected project skill from a local, host-pinned root', async () => {
  await addSkill(conventionsRoot, 'project', 'testing-guidelines.md', { description: 'Remote fixture.', body: 'REMOTE-PROJ-BODY' });
  const tree = await seedRepo(path.join(remote.root, 'app'));
  const adopted = await adoptProject('app', tree, { system: remote.id });
  assert.equal(adopted.ok, true, JSON.stringify(adopted));
  // The selection lives in the REMOTE tree's CONVENTIONS.md marker.
  await fs.writeFile(path.join(tree, 'CONVENTIONS.md'), '<!-- cc:conventions testing-guidelines -->\n');
  const regen = await ensureProjectConventionsMd('app');
  assert.equal(regen.regenerated, true, JSON.stringify(regen));
  const md = await fs.readFile(path.join(tree, 'CONVENTIONS.md'), 'utf8');
  assert.ok(!md.includes('REMOTE-PROJ-BODY'), 'the remote file carries the inline part only');

  const inst = await spawnIn('app');
  assert.ok(inst._redirect, 'fixture check: the session is redirect-backed');
  const root = path.join(conventionSkillsDir(inst.id), 'cc-project');
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT, root]);
  assert.ok(root.startsWith(orchStoreRoot() + path.sep), 'the root is under the local store');
  assert.deepEqual(await initSkills(inst), ['cc-project:testing-guidelines']);
  assert.equal(resolveTierEntry(inst._redirect.tiers, path.join(root, 'skills', 'testing-guidelines', 'SKILL.md'))?.tier, 'host',
    'inside the chroot the root resolves to the host, at the same spelling');
});

test('a plugin on a remote system delivers its conductor skill, though its claudePlugin root stays local-only', async () => {
  const tree = await seedRepo(path.join(remote.root, 'rplug'));
  await fs.mkdir(path.join(tree, 'conventions'), { recursive: true });
  await fs.writeFile(path.join(tree, 'conventions', 'cond.md'),
    '## Remote plugin rule\nInline.\n\n<!-- cc:skill Remote plugin skill. -->\nREMOTE-PLUGIN-BODY\n');
  await fs.mkdir(path.join(tree, 'claude', '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(tree, 'claude', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'rplug-cc' }));
  await fs.writeFile(path.join(tree, 'conductor.plugin.json'), JSON.stringify({
    id: 'rplug', name: 'Remote Plugin', version: '1.0.0', pluginApi: 1, claudePlugin: 'claude',
    conventions: [{ slug: 'cond-rule', name: 'Cond rule', description: 'd', file: 'conventions/cond.md', scope: 'conductor' }],
  }));
  const adopted = await adoptProject('rplug', tree, { system: remote.id });
  assert.equal(adopted.ok, true, JSON.stringify(adopted));
  await pluginHost.rescan();
  const row = await pluginHost.enable('rplug');
  assert.equal(row.system, remote.id, 'fixture check: discovered on the remote system');
  assert.deepEqual(await pluginHost.claudePluginDirs(), [], 'the claudePlugin root is not passed (local-only)');

  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const inst = await spawnIn('.conduct', { model: 'claude-haiku-4-5' });
  assert.deepEqual(await initSkills(inst), ['cc-conductor-rplug:cond-rule']);
  assert.deepEqual(pluginDirArgs(inst._spawnArgv),
    [CORE_CLAUDE_PLUGIN_ROOT, path.join(conventionSkillsDir(inst.id), 'cc-conductor-rplug')]);
  const doc = await fs.readFile(conductConventionsPath(), 'utf8');
  assert.ok(doc.includes('## Remote plugin rule') && !doc.includes('REMOTE-PLUGIN-BODY'));
});
