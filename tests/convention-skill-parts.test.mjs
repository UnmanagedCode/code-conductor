// The skill-part grammar (src/skillPart.ts) and its one consumer inside the
// fragment catalog (src/fragmentCatalog.ts): which text is inline, which is a
// skill, and that one selection yields both parts. No server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp } from './tmpRegistry.mjs';
import { freshProjectsRoot, rmrf } from './helpers.mjs';
import { splitSkillPart } from '../src/skillPart.ts';
import { createFragmentCatalog, readCoreFragment, skillsOf } from '../src/fragmentCatalog.ts';
import {
  composeConductParts, composeCurrentConductParts, SEED_CONVENTIONS as CONDUCTOR_SEEDS, setPluginConductorConventionsProvider,
} from '../src/conductorConventions.ts';
import { materializeCurrentConduct, conductConventionsPath } from '../src/conduct.ts';
import { createContributions } from '../src/plugins/contributions.ts';
import { localSystem } from '../src/systems/registry.ts';
import { composeWorkspaceParts, SEED_CONVENTIONS as WORKSPACE_SEEDS } from '../src/workspaceConventions.ts';
import { copyConventions, addSkill, useConventionsDir } from './conventionsTree.mjs';

const seedTransform = raw => raw.replace(/\s+$/, '');

test('no marker: the inline part is exactly the seed transform and there is no skill', () => {
  for (const raw of [
    '## A\n- body\n',
    '## A\r\n- body\r\n\r\n',
    '  ## indented first line\n\n\n',
    '',
    // Lookalikes that are NOT a marker: another cc marker, a longer word, a
    // marker not at column 0, and one inside prose.
    '<!-- cc:conventions a,b -->\n## A\n',
    '<!-- cc:skills not a marker -->\n## A\n',
    '## A\n  <!-- cc:skill indented, so inline -->\nbody\n',
    '## A\nsee `<!-- cc:skill d -->` in the docs\n',
  ]) {
    assert.deepEqual(splitSkillPart(raw), { inline: seedTransform(raw) }, JSON.stringify(raw));
    assert.deepEqual(splitSkillPart(raw, { explicitName: 'required' }), { inline: seedTransform(raw) }, `core: ${JSON.stringify(raw)}`);
  }
});

test('a marker splits inline (above) from skill (below) and captures the description', () => {
  const raw = '## Plan mode\nShort rule.\n  \n<!-- cc:skill Use when you plan: the full procedure. -->\n\n\nStep 1.\n\nStep 2.  \n\n';
  assert.deepEqual(splitSkillPart(raw), {
    inline: '## Plan mode\nShort rule.',
    skill: { description: 'Use when you plan: the full procedure.', body: 'Step 1.\n\nStep 2.' },
  });
  // A skill-only fragment: nothing above the marker.
  assert.deepEqual(splitSkillPart('<!-- cc:skill d -->\nbody'), { inline: '', skill: { description: 'd', body: 'body' } });
  // CRLF files split the same way.
  assert.deepEqual(splitSkillPart('## A\r\n<!-- cc:skill d -->\r\nbody\r\n'),
    { inline: '## A', skill: { description: 'd', body: 'body' } });
  // `-->` with no space before it closes the marker too.
  assert.deepEqual(splitSkillPart('<!-- cc:skill d-->\nbody').skill, { description: 'd', body: 'body' });
});

test('a core marker names its skill; the name is required there and forbidden elsewhere', () => {
  const core = '# Core\n<!-- cc:skill:plan-mode Use when planning. -->\nbody\n';
  assert.deepEqual(splitSkillPart(core, { explicitName: 'required' }),
    { inline: '# Core', skill: { name: 'plan-mode', description: 'Use when planning.', body: 'body' } });
  assert.throws(() => splitSkillPart(core), /only a core may/);
  assert.throws(() => splitSkillPart('# Core\n<!-- cc:skill d -->\nbody', { explicitName: 'required' }), /must name its skill/);
  for (const bad of ['Plan', '-plan', 'plan_mode', '']) {
    assert.throws(() => splitSkillPart(`<!-- cc:skill:${bad} d -->\nbody`, { explicitName: 'required' }), /must match|malformed/, bad);
  }
  assert.equal(splitSkillPart('<!-- cc:skill:0-x d -->\nb', { explicitName: 'required' }).skill.name, '0-x');
});

test('malformed, repeated, description-less and body-less markers throw', () => {
  const cases = [
    ['## A\n<!-- cc:skill d -->\nbody\n<!-- cc:skill e -->\nmore', /second skill marker/],
    ['## A\n<!-- cc:skill -->\nbody', /empty description/],
    ['## A\n<!-- cc:skill    -->\nbody', /empty description/],
    ['## A\n<!-- cc:skill d -->\n\n  \n', /empty skill body/],
    ['## A\n<!-- cc:skill d', /malformed/],
    ['## A\n<!-- cc:skill d --> trailing', /malformed/],
  ];
  for (const [raw, re] of cases) assert.throws(() => splitSkillPart(raw), re, JSON.stringify(raw));
});

async function seedTree(files) {
  const dir = await mkdtemp('cc-skill-seeds-');
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  return dir;
}

const SEEDS = [
  { slug: 'plain', name: 'Plain', description: 'no skill' },
  { slug: 'split', name: 'Split', description: 'has a skill' },
  { slug: 'other', name: 'Other', description: 'has a skill too' },
];

function catalogOver(seedDir, { skillParts = true, extraProvider = null, storeFile } = {}) {
  return createFragmentCatalog({
    seeds: SEEDS, seedDir, skillParts, noun: 'convention', extraProvider,
    storeFile: storeFile ?? (() => path.join(seedDir, 'store.json')),
  });
}

test('one compose yields the inline text and exactly the selected slugs\' skills', async () => {
  const dir = await seedTree({
    'plain.md': '## Plain\n- p\n',
    'split.md': '## Split\n- inline\n\n<!-- cc:skill Split skill. -->\n\nSPLIT-SKILL-BODY\n',
    'other.md': '<!-- cc:skill Other skill. -->\nOTHER-SKILL-BODY\n',
  });
  const catalog = catalogOver(dir);

  const all = await catalog.composeWithMeta(['plain', 'split', 'other']);
  assert.equal(all.text, '\n## Plain\n- p\n\n## Split\n- inline\n');
  assert.doesNotMatch(all.text, /SKILL-BODY|cc:skill/);
  assert.deepEqual(all.skills, [
    { name: 'split', description: 'Split skill.', body: 'SPLIT-SKILL-BODY' },
    { name: 'other', description: 'Other skill.', body: 'OTHER-SKILL-BODY' },
  ]);
  assert.equal(all.text, await catalog.compose(['plain', 'split', 'other']), 'compose() is the text half');

  // Deselected → neither part; a skill-only fragment contributes no text.
  assert.deepEqual(await catalog.composeWithMeta(['plain']), { text: '\n## Plain\n- p\n', degraded: false, skills: [] });
  assert.deepEqual(await catalog.composeWithMeta(['other']),
    { text: '', degraded: false, skills: [{ name: 'other', description: 'Other skill.', body: 'OTHER-SKILL-BODY' }] });
  // A repeated slug delivers its skill once.
  assert.equal((await catalog.composeWithMeta(['split', 'split'])).skills.length, 1);
});

test('a plugin entry\'s skill is named by its plugin-local slug and carries the plugin', async () => {
  const dir = await seedTree({ 'plain.md': '## P\n', 'split.md': '## S\n', 'other.md': '## O\n' });
  const catalog = catalogOver(dir, {
    extraProvider: async () => [{ slug: 'my-plug/rule', name: 'R', description: 'd', body: '## R', plugin: 'my-plug',
      skill: { description: 'Plugin skill.', body: 'PLUGIN-BODY' } }],
  });
  const { text, skills } = await catalog.composeWithMeta(['my-plug/rule']);
  assert.equal(text, '\n## R\n');
  assert.deepEqual(skills, [{ name: 'rule', plugin: 'my-plug', description: 'Plugin skill.', body: 'PLUGIN-BODY' }]);
  // skillsOf over a read catalog skips a slug it lacks rather than throwing.
  assert.deepEqual(skillsOf(await catalog.getCatalog(), ['gone/x', 'my-plug/rule']).map(s => s.name), ['rule']);
});

test('a Settings-authored custom body is never split', async () => {
  const dir = await seedTree({ 'plain.md': '## P\n', 'split.md': '## S\n', 'other.md': '## O\n' });
  const catalog = catalogOver(dir);
  const body = '## Custom\n<!-- cc:skill looks like a marker -->\nstays inline';
  await catalog.addCustom({ slug: 'custom', name: 'C', description: 'd', body });
  assert.deepEqual(await catalog.composeWithMeta(['custom']), { text: `\n${body}\n`, degraded: false, skills: [] });
});

test('a catalog without skillParts (the playbook shape) composes a marker verbatim', async () => {
  const raw = '## Split\n<!-- cc:skill d -->\nbody\n';
  const dir = await seedTree({ 'plain.md': '## P\n', 'split.md': raw, 'other.md': '## O\n' });
  const catalog = catalogOver(dir, { skillParts: false });
  assert.deepEqual(await catalog.composeWithMeta(['split']), { text: `\n${seedTransform(raw)}\n`, degraded: false, skills: [] });
  assert.equal((await catalog.getCatalog()).find(e => e.slug === 'split').skill, undefined);
});

test('a malformed seed marker fails the catalog read, naming the file', async () => {
  const dir = await seedTree({ 'plain.md': '## P\n', 'split.md': '## S\n<!-- cc:skill -->\nb\n', 'other.md': '## O\n' });
  await assert.rejects(catalogOver(dir).getCatalog(), err => err.message.includes(path.join(dir, 'split.md')) && /empty description/.test(err.message));
});

test('seedDir as a function is read per call', async () => {
  const a = await seedTree({ 'plain.md': '## A\n', 'split.md': '## S\n', 'other.md': '## O\n' });
  const b = await seedTree({ 'plain.md': '## B\n', 'split.md': '## S\n', 'other.md': '## O\n' });
  let cur = a;
  const catalog = createFragmentCatalog({ seeds: SEEDS, seedDir: () => cur, skillParts: true, storeFile: () => path.join(a, 's.json') });
  assert.equal(await catalog.compose(['plain']), '\n## A\n');
  cur = b;
  assert.equal(await catalog.compose(['plain']), '\n## B\n');
});

test('a core skill must be named, and not with a seed slug of its scope', async () => {
  const dir = await mkdtemp('cc-core-');
  const file = path.join(dir, 'core.md');
  await fs.writeFile(file, '# Core\n<!-- cc:skill:core-procedure The procedure. -->\nPROC\n');
  assert.deepEqual(await readCoreFragment(file, ['a', 'b']),
    { inline: '# Core', skill: { name: 'core-procedure', description: 'The procedure.', body: 'PROC' } });
  await assert.rejects(readCoreFragment(file, ['core-procedure']), err => err.message.includes(file) && /also a seed slug/.test(err.message));
  await fs.writeFile(file, '# Core\n<!-- cc:skill The procedure. -->\nPROC\n');
  await assert.rejects(readCoreFragment(file, []), /must name its skill/);
});

// The same rule through each real scope composer, against its own seed list.
for (const [scope, compose, seeds] of [
  ['conductor', composeConductParts, CONDUCTOR_SEEDS],
  ['workspace', composeWorkspaceParts, WORKSPACE_SEEDS],
]) {
  test(`${scope} composer: a core skill named after one of its seeds is refused`, async () => {
    const { home } = await freshProjectsRoot();
    const root = await copyConventions({ stripSkills: true });
    const restore = useConventionsDir(root);
    try {
      const clash = seeds[0].slug;
      await addSkill(root, scope, 'core.md', { name: clash, description: 'd', body: 'b' });
      await assert.rejects(compose([]), new RegExp(`core skill name '${clash}' is also a seed slug`));
      // The same core under a free name composes, its skill first.
      const fresh = await copyConventions({ stripSkills: true });
      process.env.CC_CONVENTIONS_DIR = fresh;
      await addSkill(fresh, scope, 'core.md', { name: 'fixture-core', description: 'd', body: 'b' });
      const { skills } = await compose([]);
      assert.deepEqual(skills, [{ name: 'fixture-core', description: 'd', body: 'b' }]);
    } finally { restore(); await rmrf(home); }
  });
}

// A provider whose answer changes on every read: generation N contributes body
// `TEXT-N` with skill body `SKILL-N` under one fixed slug. Text and skills
// agree on N only if both came off the same catalog read.
function churningProvider() {
  let n = 0;
  const provider = async () => {
    n++;
    return [{ slug: 'churn/rule', name: 'R', description: 'd', plugin: 'churn',
      body: `## TEXT-${n}`, skill: { description: 'd', body: `SKILL-${n}` } }];
  };
  return { provider, reads: () => n };
}

const generationOf = (re, s) => Number(re.exec(s)?.[1]);

test('one selection read gives both parts: text and skills agree even when the provider changes between reads', async () => {
  const dir = await seedTree({ 'plain.md': '## P\n', 'split.md': '## S\n', 'other.md': '## O\n' });
  const { provider, reads } = churningProvider();
  const catalog = catalogOver(dir, { extraProvider: provider });
  for (let i = 0; i < 3; i++) {
    const { text, skills } = await catalog.composeWithMeta(['churn/rule']);
    assert.equal(generationOf(/SKILL-(\d+)/, skills[0].body), generationOf(/TEXT-(\d+)/, text), `round ${i}: ${text} vs ${skills[0].body}`);
  }
  assert.ok(reads() >= 3, 'fixture check: the provider answered differently across reads');
});

test('one selection read gives both parts through the conductor composer and materializer', async () => {
  const { home } = await freshProjectsRoot();
  const root = await copyConventions({ stripSkills: true });
  const restore = useConventionsDir(root);
  const { provider, reads } = churningProvider();
  setPluginConductorConventionsProvider(provider);
  try {
    const { text, skills } = await composeCurrentConductParts();
    const skill = skills.find(s => s.plugin === 'churn');
    assert.ok(skill, 'fixture check: the churning plugin convention is selected');
    assert.equal(generationOf(/SKILL-(\d+)/, skill.body), generationOf(/TEXT-(\d+)/, text));

    const before = reads();
    const skillsDir = path.join(home, 'skills');
    await materializeCurrentConduct(skillsDir);
    assert.ok(reads() > before + 1, 'fixture check: materializing read the provider more than once');
    const doc = await fs.readFile(conductConventionsPath(), 'utf8');
    const md = await fs.readFile(path.join(skillsDir, 'cc-conductor-churn', 'skills', 'rule', 'SKILL.md'), 'utf8');
    assert.equal(generationOf(/SKILL-(\d+)/, md), generationOf(/TEXT-(\d+)/, doc), 'the written doc and SKILL.md agree');
  } finally { setPluginConductorConventionsProvider(null); restore(); await rmrf(home); }
});

// A plugin fragment that was well-formed at manifest load and turned malformed
// since: the compose-time path drops the entry WHOLE, so neither its inline
// text nor its skill reaches any scope.
test('a plugin fragment malformed after load is dropped whole at compose time', async () => {
  const dir = await mkdtemp('cc-contrib-');
  await fs.mkdir(path.join(dir, 'conventions'), { recursive: true });
  const file = path.join(dir, 'conventions', 'r.md');
  await fs.writeFile(file, '## Rule\nINLINE\n<!-- cc:skill d -->\nSKILL\n');
  const entry = { id: 'plug', project: 'plug-project', manifest: { conventions: [
    { slug: 'r', name: 'R', description: 'd', file: 'conventions/r.md', scope: 'conductor' },
    { slug: 'kept', name: 'K', description: 'd', scaffold: { text: 'do it' }, scope: 'conductor' },
  ] } };
  const contributions = createContributions({
    ensureInit: async () => {},
    contributingEntries: () => [entry],
    resolvePlacement: async () => ({ kind: 'ok', system: localSystem(), dir, cwd: dir }),
    discoveryDegraded: () => false,
  });
  const loaded = (await contributions.conventions()).conductor;
  assert.deepEqual(loaded.find(e => e.slug === 'plug/r')?.skill, { description: 'd', body: 'SKILL' }, 'fixture check: loads with its skill');

  await fs.writeFile(file, '## Rule\nINLINE\n<!-- cc:skill -->\nSKILL\n');
  contributions.invalidate();
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  let after;
  try { after = (await contributions.conventions()).conductor; }
  finally { console.warn = origWarn; }
  assert.equal(after.find(e => e.slug === 'plug/r'), undefined, 'neither text nor skill: the entry is gone');
  assert.ok(after.some(e => e.slug === 'plug/kept'), 'the plugin\'s other conventions still ship');
  assert.equal(after.degraded, undefined, 'a malformed file is not a transient outage');
  assert.ok(warnings.some(w => w.includes("'plug/r'") && /empty description/.test(w)), JSON.stringify(warnings));
});
