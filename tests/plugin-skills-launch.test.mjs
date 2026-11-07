import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, registerLocalProject, seedSessionJsonl } from './helpers.mjs';
import { CORE_CLAUDE_PLUGIN_ROOT } from '../src/coreClaudePlugin.ts';

// End-to-end wire: every session's claude argv carries cc's built-in Claude
// Code plugin root as the first `--plugin-dir`, and an enabled cc plugin
// declaring `claudePlugin` adds `--plugin-dir <root>` after it — proving
// provider injection (server.ts) → resolver (registry) → composition with the
// built-in root (_doCreateResolved) → the frozen-on-Instance list → sync append
// in Instance.spawn(). The scenario's `plugin_skills` makes the fake CLI's init
// list the skills it finds under each root, as the real CLI does.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-plugin-skills.json');

let ctx, baseUrl, instances, pluginHost, home;
const tmpDirs = [];

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
afterEach(async () => {
  instances._coreClaudePluginRoot = CORE_CLAUDE_PLUGIN_ROOT;
  await instances.shutdown();
  await rmrf(home);
  for (const d of tmpDirs.splice(0)) await rmrf(d);
});

async function tmpDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-core-skills-'));
  tmpDirs.push(d);
  return d;
}

// The value after each `--plugin-dir`, in argv order.
function pluginDirArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--plugin-dir') out.push(argv[i + 1]);
  return out;
}

// The namespace the shipped built-in root declares.
async function realCoreName() {
  const manifest = JSON.parse(await fs.readFile(path.join(CORE_CLAUDE_PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(typeof manifest.name, 'string', 'the shipped claude-plugin/.claude-plugin/plugin.json names the plugin');
  return manifest.name;
}

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

test('a skill under the built-in root is listed by the CLI under the shipped namespace', async () => {
  const name = await realCoreName();
  const root = path.join(await tmpDir(), 'claude-plugin');
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
  assert.ok(init.data.skills.includes(`${name}:fixture-skill`),
    `init skills ${JSON.stringify(init.data.skills)} should list ${name}:fixture-skill`);
});

test('broken built-in root → warned by path, left out, session still launches', async () => {
  const broken = await tmpDir();
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
