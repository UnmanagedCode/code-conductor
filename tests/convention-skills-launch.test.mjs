// End-to-end: a convention's skill part reaches a session as a generated
// Claude Code plugin root on its argv, through exactly the gates its inline
// part obeys — the toggle, the plugin being enabled and `ok`, and the scope —
// and is regenerated on every launch. The scenario's `plugin_skills` makes the
// fake CLI's init list `<plugin.json name>:<skill dir>` for each `--plugin-dir`,
// as the real CLI does. Fragments get their skill parts in a temp copy of
// `conventions/` (CC_CONVENTIONS_DIR), stripped of any shipped ones.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer, api, waitFor, freshProjectsRoot, rmrf, registerLocalProject } from './helpers.mjs';
import { CORE_CLAUDE_PLUGIN_ROOT } from '../src/coreClaudePlugin.ts';
import { conventionSkillsDir, sweepConventionSkillDirs, renderSkill } from '../src/conventionSkills.ts';
import { conductConventionsPath } from '../src/conduct.ts';
import { regenerateAllProjectConventions } from '../src/projectClaudeMd.ts';
import { copyConventions, addSkill, useConventionsDir } from './conventionsTree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.join(__dirname, 'fixtures', 'scenario-plugin-skills.json');

let ctx, baseUrl, instances, pluginHost, home, conventionsRoot, restoreConventions;

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
});
afterEach(async () => {
  await instances.shutdown();
  restoreConventions();
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

async function spawnConductor() {
  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  return spawnIn('.conduct', { model: 'claude-haiku-4-5' });
}

async function createProject(name, conventions) {
  const r = await api(baseUrl, 'POST', '/api/projects', { name, ...(conventions ? { conventions } : {}) });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
}

// The skills the CLI lists at init for this launch. The init is emitted on the
// first stdin line, and a relaunch emits a fresh one, so this reads the last.
async function initSkills(inst) {
  const isInit = ev => ev.kind === 'system' && ev.subtype === 'init';
  const before = inst.ringSnapshot().filter(isInit).length;
  await inst.prompt('hello');
  await waitFor(() => inst.ringSnapshot().filter(isInit).length > before);
  return inst.ringSnapshot().filter(isInit).at(-1).data.skills;
}

const conventionSkills = skills => skills.filter(s => s.startsWith('cc-')).sort();

// The first line of a fixture fragment: its heading, which the composed doc
// carries iff the inline part is in force.
async function headingOf(scope, slug) {
  return (await fs.readFile(path.join(conventionsRoot, scope, `${slug}.md`), 'utf8')).split('\n')[0];
}

const CORE_SKILL = { name: 'fixture-core', description: 'Core fixture skill.', body: 'CORE-SKILL-BODY' };
const WS_SKILL = { description: 'Workspace fixture skill.', body: 'WS-SKILL-BODY' };
const COND_SKILL = { description: 'Conductor fixture skill.', body: 'COND-SKILL-BODY' };
const PROJ_SKILL = { description: 'Project fixture skill.', body: 'PROJ-SKILL-BODY' };

test('no skill part in force: argv carries only the built-in root and no skill dir is written', async () => {
  await createProject('p', ['testing-guidelines']);
  const worker = await spawnIn('p');
  const conductor = await spawnConductor();
  for (const inst of [worker, conductor]) {
    assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT]);
    assert.equal(existsSync(conventionSkillsDir(inst.id)), false, 'no convention-skills dir');
  }
});

test('conductor: core, workspace and conductor skills are delivered and the role doc keeps only inline parts', async () => {
  await addSkill(conventionsRoot, 'conductor', 'core.md', CORE_SKILL);
  await addSkill(conventionsRoot, 'workspace', 'git-hygiene.md', WS_SKILL);
  await addSkill(conventionsRoot, 'conductor', 'worker-prompts.md', COND_SKILL);
  const inst = await spawnConductor();

  const dir = conventionSkillsDir(inst.id);
  assert.deepEqual(pluginDirArgs(inst._spawnArgv),
    [CORE_CLAUDE_PLUGIN_ROOT, path.join(dir, 'cc-workspace'), path.join(dir, 'cc-conductor')],
    'built-in root, then workspace built-ins, then conductor built-ins');
  assert.deepEqual(conventionSkills(await initSkills(inst)),
    ['cc-conductor:fixture-core', 'cc-conductor:worker-prompts', 'cc-workspace:git-hygiene']);

  assert.equal(await fs.readFile(path.join(dir, 'cc-conductor', 'skills', 'fixture-core', 'SKILL.md'), 'utf8'),
    renderSkill(CORE_SKILL));
  assert.equal(await fs.readFile(path.join(dir, 'cc-workspace', 'skills', 'git-hygiene', 'SKILL.md'), 'utf8'),
    renderSkill({ name: 'git-hygiene', ...WS_SKILL }));

  const doc = await fs.readFile(conductConventionsPath(), 'utf8');
  for (const [scope, slug] of [['conductor', 'worker-prompts'], ['workspace', 'git-hygiene']]) {
    assert.ok(doc.includes(await headingOf(scope, slug)), `${scope}/${slug} inline part is in the role doc`);
  }
  for (const body of ['CORE-SKILL-BODY', 'WS-SKILL-BODY', 'COND-SKILL-BODY', 'cc:skill']) {
    assert.ok(!doc.includes(body), `role doc carries no '${body}'`);
  }
});

test('toggle gate (conductor): a switched-off convention loses text and skill, on a new spawn and across a respawn', async () => {
  await addSkill(conventionsRoot, 'conductor', 'worker-prompts.md', COND_SKILL);
  const heading = await headingOf('conductor', 'worker-prompts');
  const inst = await spawnConductor();
  assert.ok(conventionSkills(await initSkills(inst)).includes('cc-conductor:worker-prompts'), 'fixture check: on');

  const { body } = await api(baseUrl, 'GET', '/api/settings/conventions/conductor');
  const off = await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/selection',
    { enabled: body.enabled.filter(s => s !== 'worker-prompts') });
  assert.equal(off.status, 200, JSON.stringify(off.body));

  await inst.kill();
  await instances.respawn(inst.id);
  await waitFor(() => inst.status === 'idle');
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT], 'the relaunch carries no skill root');
  assert.equal(existsSync(path.join(conventionSkillsDir(inst.id), 'cc-conductor')), false, 'the stale root is gone');
  assert.ok(!(await fs.readFile(conductConventionsPath(), 'utf8')).includes(heading), 'nor is the inline part');

  const fresh = await spawnConductor();
  assert.deepEqual(conventionSkills(await initSkills(fresh)), []);
});

test('toggle gate (workspace): a worker loses the skill when its regenerated CONVENTIONS.md loses the text', async () => {
  await addSkill(conventionsRoot, 'workspace', 'git-hygiene.md', WS_SKILL);
  const heading = await headingOf('workspace', 'git-hygiene');
  await createProject('p');
  const conventionsMd = path.join(ctx.projectsRoot, 'p', 'CONVENTIONS.md');
  assert.ok((await fs.readFile(conventionsMd, 'utf8')).includes(heading), 'fixture check: text in force');
  const inst = await spawnIn('p');
  assert.deepEqual(conventionSkills(await initSkills(inst)), ['cc-workspace:git-hygiene']);

  const { body } = await api(baseUrl, 'GET', '/api/settings/conventions/workspace');
  const off = await api(baseUrl, 'PUT', '/api/settings/conventions/workspace/selection',
    { enabled: body.enabled.filter(s => s !== 'git-hygiene') });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.ok(!(await fs.readFile(conventionsMd, 'utf8')).includes(heading), 'the text is gone from the file');

  await inst.kill();
  await instances.respawn(inst.id);
  await waitFor(() => inst.status === 'idle');
  assert.deepEqual(conventionSkills(await initSkills(inst)), [], 'and the skill from the relaunch');
});

// A conventions-only cc plugin (no backend) whose fragment files carry markers.
async function addConventionPlugin({ id = 'skill-conv', condFile = null, projFile = null } = {}) {
  const dir = path.join(ctx.projectsRoot, id);
  await fs.mkdir(path.join(dir, 'conventions'), { recursive: true });
  await registerLocalProject(id, dir);
  await fs.writeFile(path.join(dir, 'conventions', 'cond.md'),
    condFile ?? '## Plugin conductor rule\nInline.\n\n<!-- cc:skill Plugin conductor skill. -->\nPLUGIN-COND-BODY\n');
  await fs.writeFile(path.join(dir, 'conventions', 'proj.md'),
    projFile ?? '## Plugin project rule\nInline.\n\n<!-- cc:skill Plugin project skill. -->\nPLUGIN-PROJ-BODY\n');
  await fs.writeFile(path.join(dir, 'conductor.plugin.json'), JSON.stringify({
    id, name: 'Skill Conventions', version: '1.0.0', pluginApi: 1,
    conventions: [
      { slug: 'cond-rule', name: 'Cond rule', description: 'd', file: 'conventions/cond.md', scope: 'conductor' },
      { slug: 'proj-rule', name: 'Proj rule', description: 'd', file: 'conventions/proj.md', scope: 'project' },
    ],
  }));
  await pluginHost.rescan();
  return dir;
}

test('plugin gate: enabled delivers both scopes\' skills; disabled delivers neither part', async () => {
  await addConventionPlugin();
  await pluginHost.enable('skill-conv');
  await createProject('p', ['skill-conv/proj-rule']);
  const conventionsMd = path.join(ctx.projectsRoot, 'p', 'CONVENTIONS.md');
  const md = await fs.readFile(conventionsMd, 'utf8');
  assert.ok(md.includes('## Plugin project rule') && !md.includes('PLUGIN-PROJ-BODY'), 'inline part only in the file');

  const conductor = await spawnConductor();
  assert.deepEqual(conventionSkills(await initSkills(conductor)), ['cc-conductor-skill-conv:cond-rule']);
  const doc = await fs.readFile(conductConventionsPath(), 'utf8');
  assert.ok(doc.includes('## Plugin conductor rule') && !doc.includes('PLUGIN-COND-BODY'));
  const worker = await spawnIn('p');
  assert.deepEqual(conventionSkills(await initSkills(worker)), ['cc-project-skill-conv:proj-rule']);
  assert.equal(await fs.readFile(path.join(conventionSkillsDir(worker.id), 'cc-project-skill-conv', 'skills', 'proj-rule', 'SKILL.md'), 'utf8'),
    renderSkill({ name: 'proj-rule', description: 'Plugin project skill.', body: 'PLUGIN-PROJ-BODY' }));

  await pluginHost.disable('skill-conv');
  await regenerateAllProjectConventions();
  assert.ok(!(await fs.readFile(conventionsMd, 'utf8')).includes('## Plugin project rule'), 'fixture check: text gone');
  const conductor2 = await spawnConductor();
  assert.deepEqual(conventionSkills(await initSkills(conductor2)), []);
  assert.ok(!(await fs.readFile(conductConventionsPath(), 'utf8')).includes('## Plugin conductor rule'));
  const worker2 = await spawnIn('p');
  assert.deepEqual(conventionSkills(await initSkills(worker2)), []);
});

test('plugin gate: a malformed marker makes the plugin invalid, so neither part ships', async () => {
  await addConventionPlugin({ condFile: '## Plugin conductor rule\n<!-- cc:skill -->\nbody\n' });
  await assert.rejects(pluginHost.enable('skill-conv'), err => err.statusCode === 409 && /empty description/.test(err.message));
  const conductor = await spawnConductor();
  assert.deepEqual(conventionSkills(await initSkills(conductor)), []);
  assert.ok(!(await fs.readFile(conductConventionsPath(), 'utf8')).includes('## Plugin conductor rule'));
});

test('scope gate: workers get no conductor skills, conductors no project skills, and a project skill needs the marker', async () => {
  await addSkill(conventionsRoot, 'conductor', 'core.md', CORE_SKILL);
  await addSkill(conventionsRoot, 'conductor', 'worker-prompts.md', COND_SKILL);
  await addSkill(conventionsRoot, 'workspace', 'git-hygiene.md', WS_SKILL);
  await addSkill(conventionsRoot, 'project', 'testing-guidelines.md', PROJ_SKILL);
  await addConventionPlugin();
  await pluginHost.enable('skill-conv');
  await createProject('p', ['testing-guidelines', 'skill-conv/proj-rule']);
  await createProject('q', ['design-guidelines']);

  const conductor = conventionSkills(await initSkills(await spawnConductor()));
  assert.deepEqual(conductor, ['cc-conductor-skill-conv:cond-rule', 'cc-conductor:fixture-core',
    'cc-conductor:worker-prompts', 'cc-workspace:git-hygiene']);
  const p = conventionSkills(await initSkills(await spawnIn('p')));
  assert.deepEqual(p, ['cc-project-skill-conv:proj-rule', 'cc-project:testing-guidelines', 'cc-workspace:git-hygiene']);
  const q = conventionSkills(await initSkills(await spawnIn('q')));
  assert.deepEqual(q, ['cc-workspace:git-hygiene'], 'q selects neither project skill');
});

test('cleanup: remove() deletes a session\'s skill dir and the boot sweep reclaims a leftover', async () => {
  await addSkill(conventionsRoot, 'workspace', 'git-hygiene.md', WS_SKILL);
  await createProject('p');
  const inst = await spawnIn('p');
  const dir = conventionSkillsDir(inst.id);
  assert.ok(existsSync(path.join(dir, 'cc-workspace', 'skills', 'git-hygiene', 'SKILL.md')), 'fixture check: written');
  await instances.remove(inst.id);
  assert.equal(existsSync(dir), false, 'remove() reclaimed it');

  const live = await spawnIn('p');
  const dead = conventionSkillsDir('dead-instance');
  await fs.mkdir(path.join(dead, 'cc-workspace'), { recursive: true });
  await sweepConventionSkillDirs([live.id]);
  assert.equal(existsSync(dead), false, 'the leftover is reclaimed');
  assert.ok(existsSync(conventionSkillsDir(live.id)), 'a live session\'s dir is kept');
});
