import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './tmpRegistry.mjs';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, registerLocalProject, seedSessionJsonl } from './helpers.mjs';
import { bindRemoteSystem, seedRepo } from './remoteSystem.mjs';
import { CORE_CLAUDE_PLUGIN_ROOT } from '../src/coreClaudePlugin.ts';
import { adoptProject, selfProjectDir } from '../src/projects.ts';
import { disposeSystemHandles } from '../src/systems/registry.ts';
import { copyConventions, useConventionsDir } from './conventionsTree.mjs';

// End-to-end wire: every session's claude argv carries cc's built-in Claude
// Code plugin root as the first `--plugin-dir`, and an enabled cc plugin
// declaring `claudePlugin` adds `--plugin-dir <root>` after it — proving
// provider injection (server.ts) → resolver (registry) → composition with the
// built-in root (_doCreateResolved) → the frozen-on-Instance list → sync append
// in Instance.spawn(). The scenario's `plugin_skills` makes the fake CLI's init
// list the skills it finds under each root, as the real CLI does.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-plugin-skills.json');

let ctx, baseUrl, instances, pluginHost, home, restoreConventions;

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
  // These rows pin the PLUGIN roots exactly, so they run over a conventions
  // tree with every skill part stripped: a shipped convention skill adds its
  // own generated root (tests/convention-skills-launch.test.mjs owns those).
  restoreConventions = useConventionsDir(await copyConventions({ stripSkills: true }));
});
afterEach(async () => {
  restoreConventions();
  instances._coreClaudePluginRoot = CORE_CLAUDE_PLUGIN_ROOT;
  instances.setClaudePluginDirsResolver(() => pluginHost.claudePluginDirs());
  await instances.shutdown();
  disposeSystemHandles();
  await rmrf(home);
});

// The value after each `--plugin-dir`, in argv order.
function pluginDirArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--plugin-dir') out.push(argv[i + 1]);
  return out;
}

// The core-skill namespace the docs promise (`code-conductor:<skill>`). Pinned
// here as the contract; production reads it from the shipped plugin.json.
const CORE_NAMESPACE = 'code-conductor';

// Write a cc plugin project (manifest + a Claude Code plugin root at <rel>) under
// the active projects root.
async function addSkillPlugin(projectsRoot, { rel = 'claude', withCcRoot = true, ccName = 'skill-plugin-cc' } = {}) {
  const dir = path.join(projectsRoot, 'skillp');
  await fs.mkdir(dir, { recursive: true });
  await registerLocalProject('skillp', dir);
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
    id: 'skill-plugin', name: 'Skill Plugin', version: '1.0.0', pluginApi: 1, claudePlugin: rel,
  }));
  if (withCcRoot) {
    const root = path.join(dir, rel);
    await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: ccName }));
  }
  return dir;
}

async function spawnIn(project, body = {}) {
  const r = await api(baseUrl, 'POST', '/api/instances', { project, mode: 'bypassPermissions', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  await waitFor(() => instances.get(id)?.status === 'idle');
  return instances.get(id);
}

async function spawnInProject() {
  await api(baseUrl, 'POST', '/api/projects', { name: 'p' });
  return spawnIn('p');
}

test('built-in root comes first, then an enabled plugin\'s claudePlugin root', async () => {
  await addSkillPlugin(ctx.projectsRoot);
  await pluginHost.rescan();
  await pluginHost.enable('skill-plugin');
  const [root] = await pluginHost.claudePluginDirs();
  assert.ok(root, 'claudePluginDirs should resolve one root');

  const inst = await spawnInProject();
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT, root]);
});

test('with no enabled plugin, the built-in root is the only --plugin-dir', async () => {
  const inst = await spawnInProject();
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT]);
});

test('missing .claude-plugin/plugin.json → plugin root dropped, built-in root kept, session still launches', async () => {
  await addSkillPlugin(ctx.projectsRoot, { withCcRoot: false });
  await pluginHost.rescan();
  await pluginHost.enable('skill-plugin');

  const inst = await spawnInProject(); // still reaches idle
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT]);
});

test('a skill under the built-in root is listed by the CLI as code-conductor:<skill>', async () => {
  const root = path.join(await mkdtemp('cc-core-skills-'), 'claude-plugin');
  await fs.cp(CORE_CLAUDE_PLUGIN_ROOT, root, { recursive: true });
  const skillDir = path.join(root, 'skills', 'fixture-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: A test-only fixture skill.\n---\n\nFixture.\n');
  instances._coreClaudePluginRoot = root;

  const inst = await spawnInProject();
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [root]);
  // The CLI emits its init only once the first stdin line arrives.
  await inst.prompt('hello');
  const isInit = ev => ev.kind === 'system' && ev.subtype === 'init';
  await waitFor(() => inst.ringSnapshot().some(isInit));
  const init = inst.ringSnapshot().find(isInit);
  const expected = `${CORE_NAMESPACE}:fixture-skill`;
  assert.ok(init.data.skills.includes(expected),
    `init skills ${JSON.stringify(init.data.skills)} should list ${expected}`);
});

test('broken built-in root → warned by path, left out, session still launches', async () => {
  const broken = await mkdtemp('cc-core-skills-');
  instances._coreClaudePluginRoot = broken;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  let inst;
  try { inst = await spawnInProject(); }
  finally { console.warn = origWarn; }
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), []);
  assert.ok(warnings.some(w => w.includes(broken)), `a warning names ${broken}: ${JSON.stringify(warnings)}`);
});

test('the conductor session carries the built-in root', async () => {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const inst = await spawnIn('.conduct', { model: 'claude-haiku-4-5' });
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT]);
});

test('respawn and resume relaunch with the built-in root', async () => {
  const inst = await spawnInProject();
  await inst.kill();
  await instances.respawn(inst.id);
  await waitFor(() => inst.status === 'idle');
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT], 'respawn argv');

  const { sessionId } = inst;
  await inst.kill();
  // The fake CLI writes no transcript; resume requires one.
  await seedSessionJsonl(inst.transcriptPlace, inst.backingSessionId);
  const fresh = await spawnIn('p', { resume: sessionId });
  assert.notEqual(fresh, inst, 'fixture check: resume built a new Instance');
  assert.ok(fresh._spawnArgv.includes('--resume'), 'fixture check: the relaunch is a --resume');
  assert.deepEqual(pluginDirArgs(fresh._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT], 'resume argv');
});

test('a plugin-resolver failure does not drop the built-in root', async () => {
  instances.setClaudePluginDirsResolver(async () => { throw new Error('plugin host down'); });
  const inst = await spawnInProject(); // still reaches idle
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT]);
});

test('a remote-backed worker may Read under the built-in root', async () => {
  const remote = await bindRemoteSystem();
  const tree = await seedRepo(path.join(remote.root, 'app'));
  const adopted = await adoptProject('app', tree, { system: remote.id });
  assert.equal(adopted.ok, true, JSON.stringify(adopted));

  const inst = await spawnIn('app');
  assert.ok(inst._redirect, 'fixture check: the session is redirect-backed');
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT]);

  // cc's checkout is a host pin that file tools may not read, so only the
  // built-in root's own allow entry lets a skill's reference file through.
  const sibling = path.join(selfProjectDir(), 'package.json');
  assert.equal((await inst._redirect.preToolUse('Read', { file_path: sibling })).decision, 'deny',
    'fixture check: the rest of cc\'s checkout is denied');
  const skillFile = path.join(CORE_CLAUDE_PLUGIN_ROOT, 'skills', 'some-skill', 'references', 'guide.md');
  assert.deepEqual(await inst._redirect.preToolUse('Read', { file_path: skillFile }), { decision: 'allow' });
});
