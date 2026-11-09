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
import { conventionSkillsDir, sweepConventionSkillDirs } from '../src/conventionSkills.ts';
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

// The core's description carries a double quote, a colon and `---` — each of
// which breaks YAML frontmatter unless the description is quoted and escaped.
const CORE_SKILL = { name: 'fixture-core', description: 'Core "fixture": a skill --- with traps.', body: 'CORE-SKILL-BODY\n\nSecond paragraph.' };
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

  // Literal SKILL.md bytes, spelled out here rather than produced by the
  // renderer under test: frontmatter `name`, a double-quoted description with
  // its quotes escaped (so the `:` and `---` stay inside the scalar), then the
  // fixture fragment's skill body verbatim.
  const coreMd = await fs.readFile(path.join(dir, 'cc-conductor', 'skills', 'fixture-core', 'SKILL.md'), 'utf8');
  assert.equal(coreMd,
    '---\nname: fixture-core\ndescription: "Core \\"fixture\\": a skill --- with traps."\n---\n\nCORE-SKILL-BODY\n\nSecond paragraph.\n');
  assert.equal(JSON.parse(/^description: (.*)$/m.exec(coreMd)[1]), CORE_SKILL.description, 'the description round-trips');
  assert.equal(coreMd.split('\n').filter(l => l === '---').length, 2, 'exactly two frontmatter fences');
  assert.equal(await fs.readFile(path.join(dir, 'cc-workspace', 'skills', 'git-hygiene', 'SKILL.md'), 'utf8'),
    '---\nname: git-hygiene\ndescription: "Workspace fixture skill."\n---\n\nWS-SKILL-BODY\n');

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
    '---\nname: proj-rule\ndescription: "Plugin project skill."\n---\n\nPLUGIN-PROJ-BODY\n');

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

// A session cwd with no CONVENTIONS.md has no inline convention text in force,
// so it gets no convention skill either — even with a workspace skill on.
test('a worker whose cwd has no CONVENTIONS.md gets no convention skills', async () => {
  await addSkill(conventionsRoot, 'workspace', 'git-hygiene.md', WS_SKILL);
  const dir = path.join(ctx.projectsRoot, 'bare');
  await fs.mkdir(dir, { recursive: true });
  await registerLocalProject('bare', dir);
  assert.equal(existsSync(path.join(dir, 'CONVENTIONS.md')), false, 'fixture check: no CONVENTIONS.md');
  const inst = await spawnIn('bare');
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT]);
  assert.deepEqual(conventionSkills(await initSkills(inst)), []);
  assert.equal(existsSync(conventionSkillsDir(inst.id)), false, 'no skill dir written');
});

test('teardown: removeAllForProject() and shutdown() delete each session\'s skill dir', async () => {
  await addSkill(conventionsRoot, 'workspace', 'git-hygiene.md', WS_SKILL);
  await createProject('p');
  await createProject('q');
  const [p1, p2, q1] = [await spawnIn('p'), await spawnIn('p'), await spawnIn('q')];
  for (const inst of [p1, p2, q1]) assert.ok(existsSync(conventionSkillsDir(inst.id)), 'fixture check: written');

  await instances.removeAllForProject('p');
  assert.equal(existsSync(conventionSkillsDir(p1.id)), false, 'removeAllForProject reclaimed p1');
  assert.equal(existsSync(conventionSkillsDir(p2.id)), false, 'and p2');
  assert.ok(existsSync(conventionSkillsDir(q1.id)), 'another project\'s session keeps its dir');

  await instances.shutdown();
  assert.equal(existsSync(conventionSkillsDir(q1.id)), false, 'shutdown reclaimed q1');
});

async function captureWarnings(fn) {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  try { return { result: await fn(), warnings }; }
  finally { console.warn = origWarn; }
}

// Computing a worker's convention skills can fail; that costs the worker its
// convention skills, loudly, and never its launch. A conductor's skills come
// out of its role-doc compose, which fails its launch loudly as it always has.
test('a worker whose CONVENTIONS.md cannot be read launches without convention skills, warned', async () => {
  await addSkill(conventionsRoot, 'workspace', 'git-hygiene.md', WS_SKILL);
  await createProject('p');
  const target = path.join(ctx.projectsRoot, 'p', 'CONVENTIONS.md');
  await fs.rm(target);
  await fs.mkdir(target); // a read now fails EISDIR — not ENOENT
  const { result: inst, warnings } = await captureWarnings(() => spawnIn('p'));
  assert.equal(inst.status, 'idle', 'the launch went through');
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT]);
  assert.ok(warnings.some(w => w.includes('convention skills') && w.includes(inst.id) && /EISDIR/.test(w)), JSON.stringify(warnings));
});

test('a workspace compose failure costs a worker its convention skills, not its launch; a conductor still fails loudly', async () => {
  await addSkill(conventionsRoot, 'workspace', 'git-hygiene.md', WS_SKILL);
  await createProject('p');
  // Broken after the project's CONVENTIONS.md was written: every later
  // workspace compose throws.
  await fs.appendFile(path.join(conventionsRoot, 'workspace', 'opening-urls.md'), '\n<!-- cc:skill -->\nbody\n');
  const { result: inst, warnings } = await captureWarnings(() => spawnIn('p'));
  assert.equal(inst.status, 'idle', 'the worker launched');
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT]);
  assert.ok(warnings.some(w => w.includes('convention skills') && /empty description/.test(w)), JSON.stringify(warnings));

  await api(baseUrl, 'POST', '/api/projects/.conduct/ensure');
  const r = await api(baseUrl, 'POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', model: 'claude-haiku-4-5' });
  assert.ok(r.status >= 400, `the conductor launch is refused: ${r.status} ${JSON.stringify(r.body)}`);
  assert.match(JSON.stringify(r.body), /empty description/);
});

// ── Custom conventions (Settings-authored) ──────────────────────────────────

const customBody = (heading, skill, desc = 'Custom skill.') => `${heading}\nInline text.\n\n<!-- cc:skill ${desc} -->\n\n${skill}\n`;

async function addCustom(scope, slug, body) {
  const r = await api(baseUrl, 'POST', `/api/settings/conventions/${scope}`, { slug, name: slug, description: 'd', body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}

test('custom conductor convention: its skill ships under cc-custom-conductor and the role doc keeps the inline part', async () => {
  await addCustom('conductor', 'my-rule', customBody('## My conductor rule', 'MY-COND-SKILL'));
  const inst = await spawnConductor();
  const dir = conventionSkillsDir(inst.id);
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT, path.join(dir, 'cc-custom-conductor')]);
  assert.deepEqual(conventionSkills(await initSkills(inst)), ['cc-custom-conductor:my-rule']);
  assert.equal(await fs.readFile(path.join(dir, 'cc-custom-conductor', 'skills', 'my-rule', 'SKILL.md'), 'utf8'),
    '---\nname: my-rule\ndescription: "Custom skill."\n---\n\nMY-COND-SKILL\n');
  const doc = await fs.readFile(conductConventionsPath(), 'utf8');
  assert.ok(doc.includes('## My conductor rule') && !doc.includes('MY-COND-SKILL') && !doc.includes('cc:skill'));
});

test('custom workspace convention: the root reaches a worker and the conductor', async () => {
  await addCustom('workspace', 'ws-rule', customBody('## My workspace rule', 'MY-WS-SKILL'));
  await createProject('p');
  const worker = await spawnIn('p');
  assert.deepEqual(conventionSkills(await initSkills(worker)), ['cc-custom-workspace:ws-rule']);
  const md = await fs.readFile(path.join(ctx.projectsRoot, 'p', 'CONVENTIONS.md'), 'utf8');
  assert.ok(md.includes('## My workspace rule') && !md.includes('MY-WS-SKILL'));
  const conductor = await spawnConductor();
  assert.deepEqual(conventionSkills(await initSkills(conductor)), ['cc-custom-workspace:ws-rule']);
});

test('custom project convention: a project that picked it gets cc-custom-project, one that did not gets nothing', async () => {
  await addCustom('project', 'pj-rule', customBody('## My project rule', 'MY-PJ-SKILL'));
  await createProject('picked', ['pj-rule']);
  await createProject('plain', ['testing-guidelines']);
  assert.deepEqual(conventionSkills(await initSkills(await spawnIn('picked'))), ['cc-custom-project:pj-rule']);
  assert.deepEqual(conventionSkills(await initSkills(await spawnIn('plain'))), []);
});

test('a disabled or deleted custom convention loses its root on the next launch; an edited one gets the new SKILL.md', async () => {
  await addCustom('conductor', 'my-rule', customBody('## Rule', 'FIRST-BODY'));
  const inst = await spawnConductor();
  const skillMd = () => path.join(conventionSkillsDir(inst.id), 'cc-custom-conductor', 'skills', 'my-rule', 'SKILL.md');
  assert.match(await fs.readFile(skillMd(), 'utf8'), /FIRST-BODY/);

  const put = await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/my-rule', { body: customBody('## Rule', 'SECOND-BODY', 'New desc.') });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.match(await fs.readFile(skillMd(), 'utf8'), /FIRST-BODY/, 'a running session keeps its launch-time copy');
  await inst.kill();
  await instances.respawn(inst.id);
  await waitFor(() => inst.status === 'idle');
  const md = await fs.readFile(skillMd(), 'utf8');
  assert.match(md, /SECOND-BODY/);
  assert.match(md, /description: "New desc\."/);

  const { body } = await api(baseUrl, 'GET', '/api/settings/conventions/conductor');
  await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/selection', { enabled: body.enabled.filter(s => s !== 'my-rule') });
  await inst.kill();
  await instances.respawn(inst.id);
  await waitFor(() => inst.status === 'idle');
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT], 'disabled → root gone');
  assert.equal(existsSync(path.join(conventionSkillsDir(inst.id), 'cc-custom-conductor')), false);

  await api(baseUrl, 'PUT', '/api/settings/conventions/conductor/selection', { enabled: [...body.enabled] });
  await inst.kill();
  await instances.respawn(inst.id);
  await waitFor(() => inst.status === 'idle');
  assert.ok(existsSync(skillMd()), 'fixture check: back on');
  assert.equal((await api(baseUrl, 'DELETE', '/api/settings/conventions/conductor/my-rule')).status, 200);
  await inst.kill();
  await instances.respawn(inst.id);
  await waitFor(() => inst.status === 'idle');
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [CORE_CLAUDE_PLUGIN_ROOT], 'deleted → root gone');
});

test('root order is built-ins, then customs, then plugins', async () => {
  await addConventionPlugin();
  await pluginHost.enable('skill-conv');
  await addSkill(conventionsRoot, 'conductor', 'worker-prompts.md', COND_SKILL);
  await addCustom('conductor', 'my-rule', customBody('## Rule', 'MY-BODY'));
  const inst = await spawnConductor();
  const dir = conventionSkillsDir(inst.id);
  assert.deepEqual(pluginDirArgs(inst._spawnArgv), [
    CORE_CLAUDE_PLUGIN_ROOT, path.join(dir, 'cc-conductor'), path.join(dir, 'cc-custom-conductor'), path.join(dir, 'cc-conductor-skill-conv'),
  ]);
});

test('built-in and custom skills of one scope load side by side under their own namespaces', async () => {
  await addSkill(conventionsRoot, 'conductor', 'worker-prompts.md', COND_SKILL);
  await addCustom('conductor', 'my-rule', customBody('## Rule', 'MINE'));
  const inst = await spawnConductor();
  assert.deepEqual(conventionSkills(await initSkills(inst)), ['cc-conductor:worker-prompts', 'cc-custom-conductor:my-rule']);
});
