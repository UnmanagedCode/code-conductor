// Byte-identical characterization pins for the two convention SELECTION layers
// (workspace + conductor) — the exact-string compose output a given store state
// derives, plus the exact patch `setSelection` persists.
//
// Why exact strings: every other compose assertion in the suite is a regex or a
// startsWith, so a selection-derivation change that reorders slugs, drops one,
// or re-sorts the store array would pass all of them. These are the pins that
// don't.
//
// Not circular: the right-hand side of every equality feeds composeWorkspace /
// composeConduct a HARD-CODED literal selection. Those two composers are the
// oracle — only the selection derivation is under test, and the generated
// playbook listing / default-playbook section / footer appear identically on
// both sides and cancel out.
//
// The two seed literals are written out by hand in seed order. That is
// deliberate: adding a built-in convention SHOULD force an edit here.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { freshProjectsRoot, rmrf, registerLocalProject} from './helpers.mjs';
import { createFragmentCatalog } from '../src/fragmentCatalog.ts';
import { createSelectionStore } from '../src/conventionSelection.ts';
import {
  SEED_CONVENTIONS as WORKSPACE_SEEDS,
  getSelection as wsGetSelection, setSelection as wsSetSelection,
  addCustomConvention as wsAddCustom, deleteCustomConvention as wsDeleteCustom,
  composeWorkspace, composeCurrentWorkspace,
} from '../src/workspaceConventions.ts';
import {
  SEED_CONVENTIONS as CONDUCTOR_SEEDS,
  getSelection as cdGetSelection, setSelection as cdSetSelection,
  addCustomConvention as cdAddCustom, deleteCustomConvention as cdDeleteCustom,
  composeConduct, composeCurrentConduct, setPluginConductorConventionsProvider,
} from '../src/conductorConventions.ts';

const SEED_WORKSPACE_SLUGS = [
  'git-hygiene', 'readme-maintenance', 'durable-content', 'system-prompt-docs', 'opening-urls', 'answering-questions',
];
const SEED_CONDUCTOR_SLUGS = [
  'intent-disambiguation', 'canonical-workflow', 'worker-lifecycle', 'operational-tasks',
  'worker-prompts', 'capturing-learnings', 'context-renewal', 'system-prompt-gate', 'playbooks',
];

// Two plugin-namespaced conductor conventions, injected through the same
// provider seam server.ts wires to the plugin host. `plugin` is what marks an
// entry plugin-contributed for the selection derivation — the '/' in the slug
// marks nothing any more (card 2026-0123 retired `isPluginSlug` along with the
// allow-list it kept plugin slugs out of).
//
// THE TWO IDS ARE DISTINCT ON PURPOSE, and the two sides of the invariant are
// split across them: `z/one` is the slug C3 drives through `derive`'s off-switch
// subtraction, `q/two` the one S2 drives through the persist diff. Two ids also
// keep the fixture honest about namespacing itself: nothing in the selection
// layer may key on a particular plugin id.
const PLUGIN_ENTRIES = [
  { slug: 'z/one', name: 'Plugin One', description: 'first', body: '## Plugin One\n- alpha', plugin: 'z' },
  { slug: 'q/two', name: 'Plugin Two', description: 'second', body: '## Plugin Two\n- beta', plugin: 'q' },
];

let home, projectsRoot;

beforeEach(async () => {
  const r = await freshProjectsRoot();
  home = r.home; projectsRoot = r.projectsRoot;
});
afterEach(async () => {
  setPluginConductorConventionsProvider(null);
  await rmrf(home);
});

const storeFile = (scope) => path.join(projectsRoot, '.code-conductor', 'conventions', `${scope}.json`);

async function writeStore(scope, obj) {
  const file = storeFile(scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n');
}

async function readStore(scope) {
  return JSON.parse(await fs.readFile(storeFile(scope), 'utf8'));
}

const withPlugins = () => setPluginConductorConventionsProvider(async () => PLUGIN_ENTRIES);

// ── Fixture guard ────────────────────────────────────────────────────────────
// The literals above are the oracle's input; if a seed is added/renamed/moved
// this is the assertion that says so in one line instead of via a 40kB string
// diff below.

test('the hand-written seed literals match the code-owned seed lists', () => {
  assert.deepEqual(WORKSPACE_SEEDS.map(m => m.slug), SEED_WORKSPACE_SLUGS);
  assert.deepEqual(CONDUCTOR_SEEDS.map(m => m.slug), SEED_CONDUCTOR_SLUGS);
});

// ── Compose: exact bytes, derived selection vs literal selection ─────────────

test('W1 workspace, no store: derived compose === compose(all seeds, seed order)', async () => {
  assert.strictEqual(await composeCurrentWorkspace(), await composeWorkspace(SEED_WORKSPACE_SLUGS));
});

// The persisted state is a deny-list, so the effective selection is built from
// the SEED list and can no longer echo the order a save happened to submit.
// That makes the composed document's section order a property of
// SEED_CONVENTIONS alone — deterministic across saves, and independent of how
// the Settings panel serialises its checkboxes.
test('W2 workspace: a submitted selection composes in SEED order, not submission order', async () => {
  const submittedBackwards = ['readme-maintenance', 'git-hygiene'];
  const seedOrder = ['git-hygiene', 'readme-maintenance'];
  await wsSetSelection(submittedBackwards);
  assert.deepEqual(await wsGetSelection(), seedOrder);
  assert.strictEqual(await composeCurrentWorkspace(), await composeWorkspace(seedOrder));
  // Non-vacuity: the two orders really do produce different bytes, so W2 is
  // pinning order and not just "both sides call the same function".
  assert.notStrictEqual(await composeWorkspace(seedOrder), await composeWorkspace(submittedBackwards));
});

test('C1 conductor, no store, no plugin provider: derived compose === compose(all seeds)', async () => {
  assert.strictEqual(await composeCurrentConduct(), await composeConduct(SEED_CONDUCTOR_SLUGS));
});

test('C2 conductor, plugin provider on, no store: seeds in seed order, plugin slugs appended in catalog order', async () => {
  withPlugins();
  assert.deepEqual(await cdGetSelection(), [...SEED_CONDUCTOR_SLUGS, 'z/one', 'q/two']);
  assert.strictEqual(
    await composeCurrentConduct(),
    await composeConduct([...SEED_CONDUCTOR_SLUGS, 'z/one', 'q/two']),
  );
});

test('C3 conductor: a `disabled` entry drops exactly that plugin convention', async () => {
  withPlugins();
  await writeStore('conductor', { disabled: ['z/one'] });
  assert.deepEqual(await cdGetSelection(), [...SEED_CONDUCTOR_SLUGS, 'q/two']);
  assert.strictEqual(
    await composeCurrentConduct(),
    await composeConduct([...SEED_CONDUCTOR_SLUGS, 'q/two']),
  );
});

// A store still carrying the retired `enabled` allow-list — the shape every
// install had before migration 0033 — must read as if the key were not there:
// the deny-list is the ONLY selection state. This is the read-side half of the
// retired bug class at the real-seed level. Under the allow-list this same
// fixture yielded exactly `['canonical-workflow', …plugins]` and froze the
// other eight seeds off forever.
//
// It also replaces the retired C5 (a persisted plugin slug filtered out of the
// base): the base is now built from the seed literals and from SLUG_RE-validated
// custom slugs, both `/`-free, so it cannot carry a namespaced plugin slug for a
// filter to remove. A plugin slug reaches the selection only from the live
// catalog, and so cannot outlive its plugin.
test('C4 conductor: a leftover `enabled` allow-list is INERT — every seed stays on', async () => {
  withPlugins();
  await writeStore('conductor', { enabled: ['canonical-workflow'], rules: [] });
  assert.deepEqual(await cdGetSelection(), [...SEED_CONDUCTOR_SLUGS, 'z/one', 'q/two']);
  assert.strictEqual(
    await composeCurrentConduct(),
    await composeConduct([...SEED_CONDUCTOR_SLUGS, 'z/one', 'q/two']),
  );

  // Same key, workspace scope — one collaborator, so one rule for both.
  await writeStore('workspace', { enabled: ['git-hygiene'], rules: [] });
  assert.deepEqual(await wsGetSelection(), SEED_WORKSPACE_SLUGS);
});

// ── Persisted state: the exact patch setSelection writes ─────────────────────

test('S1 workspace setSelection persists the UNCHECKED complement as `disabled`, and no allow-list key', async () => {
  await wsSetSelection(['git-hygiene']);
  const store = await readStore('workspace');
  assert.deepEqual(store.disabled, SEED_WORKSPACE_SLUGS.filter(s => s !== 'git-hygiene'));
  assert.ok(!('enabled' in store), 'no allow-list is written back');
  assert.ok(!('pluginOff' in store), 'and no second off-list either');
});

test('S2 conductor setSelection records seed AND plugin off-switches in the one `disabled` list', async () => {
  withPlugins();
  await cdSetSelection([...SEED_CONDUCTOR_SLUGS.filter(s => s !== 'worker-prompts'), 'q/two']);
  const store = await readStore('conductor');
  assert.deepEqual(store.disabled, ['worker-prompts', 'z/one'],
    'one list, catalog order: the unchecked seed and the unchecked plugin convention');
  assert.ok(!('enabled' in store) && !('pluginOff' in store), 'and nothing else persists a selection');
});

test('S3 both scopes: deleting a custom convention prunes it from `disabled`, so a re-created one is ON', async () => {
  for (const [scope, addCustom, setSelection, deleteCustom, getSelection, seeds] of [
    ['workspace', wsAddCustom, wsSetSelection, wsDeleteCustom, wsGetSelection, SEED_WORKSPACE_SLUGS],
    ['conductor', cdAddCustom, cdSetSelection, cdDeleteCustom, cdGetSelection, SEED_CONDUCTOR_SLUGS],
  ]) {
    await addCustom({ slug: 'mine', name: 'Mine', description: 'd', body: '## Mine' });
    // The user switches it off, so the deny-list records it.
    await setSelection(seeds);
    assert.deepEqual((await readStore(scope)).disabled, ['mine'], `${scope}: off-switch persisted`);

    await deleteCustom('mine');
    assert.deepEqual((await readStore(scope)).disabled, [], `${scope}: the off-switch is pruned with the entry`);

    // Re-created under the same slug ⇒ ON, like any other new entry.
    await addCustom({ slug: 'mine', name: 'Mine', description: 'd', body: '## Mine' });
    assert.ok((await getSelection()).includes('mine'), `${scope}: a re-created custom is not silently OFF`);
  }
});

test('S4 both scopes: setSelection rejects a non-array and an unknown slug with the same 400s', async () => {
  for (const [scope, setSelection] of [['workspace', wsSetSelection], ['conductor', cdSetSelection]]) {
    await assert.rejects(() => setSelection('nope'), e => {
      assert.equal(e.statusCode, 400, scope);
      assert.equal(e.message, 'enabled must be an array of slug strings', scope);
      return true;
    });
    await assert.rejects(() => setSelection(['nope']), e => {
      assert.equal(e.statusCode, 400, scope);
      assert.equal(e.message, "unknown convention slug 'nope'", scope);
      return true;
    });
  }
});

// ── The retired bug class (card 2026-0123) ───────────────────────────────────
//
// Built on the shared collaborators DIRECTLY, over a temp seed dir of synthetic
// slugs, so the proof is about the mechanism rather than about either real
// SEED_CONVENTIONS array — adding a real seed must not have to touch these.
//
// Both stores below point at the SAME file, so `later` is literally "the code
// gained a seed after this install had already saved its selection" — the exact
// situation migrations 0015 and 0029 existed to repair.

async function synthScope(slugs, dirName) {
  const seedDir = path.join(projectsRoot, dirName);
  await fs.mkdir(seedDir, { recursive: true });
  await registerLocalProject(dirName, seedDir);
  for (const slug of slugs) {
    await fs.writeFile(path.join(seedDir, `${slug}.md`), `## ${slug}\n- body of ${slug}`);
  }
  const seeds = slugs.map(slug => ({ slug, name: slug, description: `the ${slug}` }));
  const catalog = createFragmentCatalog({
    seeds, seedDir, storeFile: () => storeFile('synth'), noun: 'convention',
  });
  return { catalog, selection: createSelectionStore({ catalog, seeds, noun: 'convention' }) };
}

test('N1 a seed added AFTER a store was written reaches it with no migration; the off-switch survives', async () => {
  // A post-migration store: one explicit off-switch, nothing else.
  await writeStore('synth', { rules: [], disabled: ['b'] });

  // Control — the store IS being read: `b` really is off under the seeds that
  // existed when it was written. Without this, N1 could pass on a getSelection
  // that ignores the store altogether.
  const before = await synthScope(['a', 'b', 'c'], 'synth-3');
  assert.deepEqual(await before.selection.getSelection(), ['a', 'c']);

  // The code now ships a fourth seed. The store is untouched — no write, no
  // migration, and no key naming `d` anywhere on disk.
  const later = await synthScope(['a', 'b', 'c', 'd'], 'synth-4');
  assert.deepEqual(await later.selection.getSelection(), ['a', 'c', 'd'],
    'the new seed is on, and the user\'s off-switch for b is still honoured');
  assert.deepEqual(await readStore('synth'), { rules: [], disabled: ['b'] }, 'store byte-equal — nothing was written');
});

test('N2 the newly seeded slug\'s BODY reaches the composed text for that pre-existing store', async () => {
  await writeStore('synth', { rules: [], disabled: ['b'] });
  const later = await synthScope(['a', 'b', 'c', 'd'], 'synth-4');
  const text = await later.catalog.compose(await later.selection.getSelection());
  assert.match(text, /## d\n- body of d/, 'the fragment the new seed contributes is composed');
  assert.doesNotMatch(text, /## b/, 'and the switched-off one still is not');
});

test('N3 a custom convention is enabled the moment it is created, with no save', async () => {
  await wsAddCustom({ slug: 'fresh', name: 'Fresh', description: 'd', body: '## Fresh rule' });
  assert.ok((await wsGetSelection()).includes('fresh'), 'in the selection with no setSelection call');
  assert.match(await composeCurrentWorkspace(), /## Fresh rule/, 'and composed');
});

test('N4 a save PRESERVES an off-switch for a slug the catalog cannot currently see', async () => {
  // `far/gone` is an off-switch for a plugin convention that is not in the
  // catalog right now (plugin disabled, project unreachable, convention
  // dropped by an update). A save must not silently clear it, or the switch
  // would not survive a disable→re-enable round trip.
  withPlugins();
  await writeStore('conductor', { disabled: ['far/gone'], rules: [] });
  await cdSetSelection([...SEED_CONDUCTOR_SLUGS, 'z/one', 'q/two']);
  assert.deepEqual((await readStore('conductor')).disabled, ['far/gone'],
    'invisible off-switch kept, and nothing visible gained one');
});
