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
import { freshProjectsRoot, rmrf } from './helpers.mjs';
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
  'git-hygiene', 'readme-maintenance', 'system-prompt-docs', 'opening-urls',
];
const SEED_CONDUCTOR_SLUGS = [
  'intent-disambiguation', 'canonical-workflow', 'worker-lifecycle', 'operational-tasks',
  'worker-prompts', 'capturing-learnings', 'context-renewal', 'system-prompt-gate', 'playbooks',
];

// Two plugin-namespaced conductor conventions, injected through the same
// provider seam server.ts wires to the plugin host. `plugin` is what marks an
// entry plugin-contributed for the selection derivation; the '/' in the slug is
// what marks it non-persistable in `enabled`.
//
// THE TWO IDS ARE DISTINCT ON PURPOSE, and the two sides of the invariant are
// split across them: `z/one` is the slug C5 drives through `derive`'s filter,
// `q/two` is the slug S2 drives through `persist`'s strip. `isPluginSlug`
// classifies by the generic namespace separator '/', so a predicate narrowed to
// any ONE id can no longer satisfy this file — `includes('z/')` fails S2,
// `includes('q/')` fails C5, `includes('p/')` fails both. A single shared id
// (whatever letter) leaves that whole class of narrowing invisible here while it
// silently stops filtering and stripping every real plugin namespace
// (code-hub/…, code-kanban/…, cond-plugin/…). Keep them different.
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

test('W2 workspace: a stored selection composes in STORE order, not re-sorted', async () => {
  const reversed = ['readme-maintenance', 'git-hygiene'];
  await wsSetSelection(reversed);
  assert.deepEqual(await wsGetSelection(), reversed);
  assert.strictEqual(await composeCurrentWorkspace(), await composeWorkspace(reversed));
  // Non-vacuity: the two orders really do produce different bytes, so W2 is
  // pinning order and not just "both sides call the same function".
  assert.notStrictEqual(await composeWorkspace(reversed), await composeWorkspace([...reversed].reverse()));
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

test('C3 conductor: a pluginOff entry drops exactly that plugin convention', async () => {
  withPlugins();
  await writeStore('conductor', { pluginOff: ['z/one'] });
  assert.deepEqual(await cdGetSelection(), [...SEED_CONDUCTOR_SLUGS, 'q/two']);
  assert.strictEqual(
    await composeCurrentConduct(),
    await composeConduct([...SEED_CONDUCTOR_SLUGS, 'q/two']),
  );
});

test('C4 conductor: a stale plugin slug in `enabled` is filtered out of the base and re-derived from the catalog', async () => {
  withPlugins();
  await writeStore('conductor', { enabled: ['canonical-workflow', 'z/one'] });
  assert.deepEqual(await cdGetSelection(), ['canonical-workflow', 'z/one', 'q/two']);
  assert.strictEqual(
    await composeCurrentConduct(),
    await composeConduct(['canonical-workflow', 'z/one', 'q/two']),
  );
});

// C4's sibling, and the only test that constructs the state the base filter
// exists for. C4 itself passes with or without the filter: its provider always
// returns z/one, so an unfiltered base slug is simply re-derived from the live
// catalog and deduped away by the Set. The filter only changes behaviour when
// the persisted plugin slug is ABSENT from the catalog — a plugin that was
// disabled or removed, or a plugin update that dropped the convention.
//
// Two writers currently prevent that state reaching the store (`persist` strips
// plugin slugs on write; migration 0021 strips legacy ones on read), which is
// exactly the sort of double-guard that stops holding the day a third writer
// appears. Unfiltered, the stale slug reaches compose with no catalog entry —
// a 400 'unknown convention slug' on the conductor spawn path.
//
// No compose assertion here, deliberately: composeCurrentConduct() IS
// composeConduct(await getSelection()), so once the deepEqual below pins the
// argument, a compose equality would be composeConduct(X) === composeConduct(X)
// — unfailable. The selection assertions are the whole pin.
test('C5 conductor: a persisted plugin slug ABSENT from the catalog is filtered out of the derived selection', async () => {
  // z/one is gone from the catalog; only q/two still contributes.
  setPluginConductorConventionsProvider(async () => [PLUGIN_ENTRIES[1]]);
  await writeStore('conductor', { enabled: ['canonical-workflow', 'z/one'] });

  const sel = await cdGetSelection();
  assert.ok(!sel.includes('z/one'), 'the stale plugin slug must not survive into the selection');
  assert.deepEqual(sel, ['canonical-workflow', 'q/two']);
});

// ── Persisted state: the exact patch setSelection writes ─────────────────────

test('S1 workspace setSelection persists `enabled` verbatim and writes no pluginOff key', async () => {
  await wsSetSelection(['git-hygiene']);
  const store = await readStore('workspace');
  assert.deepEqual(store.enabled, ['git-hygiene']);
  assert.ok(!('pluginOff' in store), 'the workspace scope has no plugin split');
});

test('S2 conductor setSelection splits the submitted set into enabled (seeds) + pluginOff (unchecked plugin slugs)', async () => {
  withPlugins();
  await cdSetSelection([...SEED_CONDUCTOR_SLUGS, 'q/two']);
  const store = await readStore('conductor');
  assert.deepEqual(store.enabled, SEED_CONDUCTOR_SLUGS, 'plugin slugs never enter `enabled`');
  assert.deepEqual(store.pluginOff, ['z/one'], 'the unchecked plugin convention is the only off-switch');
});

test('S3 both scopes: deleting a custom convention drops it from the persisted `enabled`', async () => {
  await wsAddCustom({ slug: 'mine', name: 'Mine', description: 'd', body: '## Mine' });
  await wsSetSelection([...SEED_WORKSPACE_SLUGS, 'mine']);
  assert.deepEqual((await readStore('workspace')).enabled, [...SEED_WORKSPACE_SLUGS, 'mine']);
  await wsDeleteCustom('mine');
  assert.deepEqual((await readStore('workspace')).enabled, SEED_WORKSPACE_SLUGS);

  await cdAddCustom({ slug: 'mine', name: 'Mine', description: 'd', body: '## Mine' });
  await cdSetSelection([...SEED_CONDUCTOR_SLUGS, 'mine']);
  assert.deepEqual((await readStore('conductor')).enabled, [...SEED_CONDUCTOR_SLUGS, 'mine']);
  await cdDeleteCustom('mine');
  assert.deepEqual((await readStore('conductor')).enabled, SEED_CONDUCTOR_SLUGS);
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
