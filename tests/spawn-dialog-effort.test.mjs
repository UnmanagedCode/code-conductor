// The New Session dialog's Effort control, driven through the real
// public/spawnDialog.js with happy-dom.
//
// The load-bearing claim: the UI does NOT resolve the effort chain. It shows the
// selected tier's server-resolved default as `Default (<level>)`, and on spawn it
// sends the TIER and omits `effort` — so the server's resolveSpawnEffort is the
// only place the precedence lives, and the browser path genuinely exercises it.
// The Conduct button does the same with `role:'conductor'`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { setup, tick, closeWithSpawn, TIERS, modelsPayload } from './spawnDialogHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaultOptionText = (dom) => dom.sdEffort.querySelector('option[value=""]').textContent;
test('opening the dialog labels Default with the default tier\'s effort', async () => {
  // `powerful` (the configured default tier) is deliberately NOT on the global
  // fallback level here: a broken lookup would render 'Default (high)' and pass.
  const { dom, handles } = await setup({ fast: 'low', balanced: 'medium', powerful: 'xhigh', frontier: 'max' });
  await handles.openSpawnDialog('p');
  await tick();
  assert.equal(dom.sdEffort.value, '', 'opens on Default — the tier decides');
  assert.equal(defaultOptionText(dom), 'Default (xhigh)', 'the configured default tier is powerful');
});

test('clicking a tier card re-labels the Default option', async () => {
  const { window, dom, handles } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  await handles.openSpawnDialog('p');
  await tick();

  for (const [tier, level] of [['frontier', 'max'], ['fast', 'low'], ['balanced', 'medium']]) {
    dom.spawnDialog.querySelector(`.qs-model[data-tier="${tier}"]`)
      .dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(defaultOptionText(dom), `Default (${level})`,
      `the label follows the ${tier} tier's own effort`);
  }
});

test('spawning on Default sends the tier and NO effort — the server resolves it', async () => {
  const { window, dom, handles, spawns } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  await handles.openSpawnDialog('p');
  await tick();
  dom.spawnDialog.querySelector('.qs-model[data-tier="frontier"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));

  await closeWithSpawn(window, dom);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].tier, 'frontier', 'the tier travels so the server can resolve its effort');
  assert.ok(!('effort' in spawns[0]) || spawns[0].effort === undefined,
    'no effort is sent — sending one (even the right level) would bypass the server chain');
});

test('picking an explicit level sends it as the override', async () => {
  const { window, dom, handles, spawns } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  await handles.openSpawnDialog('p');
  await tick();
  dom.sdEffort.value = 'xhigh';

  await closeWithSpawn(window, dom);

  assert.equal(spawns[0].effort, 'xhigh');
  assert.equal(spawns[0].tier, 'powerful', 'the tier still rides along (it also picks the model)');
});

test('the Conduct button sends role:conductor and no effort', async () => {
  const { window, dom, spawns } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  dom.conductBtn.dispatchEvent(new window.Event('click'));
  await tick(20);

  assert.equal(spawns.length, 1, 'Conduct spawns directly, no dialog');
  assert.equal(spawns[0].project, '.conduct');
  assert.equal(spawns[0].role, 'conductor',
    "the Conductor role travels so ITS default effort applies (not the spawn dialog's tier)");
  assert.equal(spawns[0].effort, undefined);
});

// The client cache's own fallbacks (public/models.js), which every test above
// bypasses by supplying a complete `tierEffort`. Uses its OWN cache-busted
// models.js instance so the pre-fetch state is genuinely unseeded.
test('models.js: pre-fetch reads the DEFAULT_EFFORT seed, then adopts the payload\'s defaultEffort', async () => {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  const models = await import(
    pathToFileURL(path.resolve(__dirname, '..', 'public', 'models.js')).href + '?prefetch=1');

  // Before any fetch: the seed mirrors src/effortLevels.ts DEFAULT_EFFORT, so a
  // first paint can't advertise a level the server would never resolve.
  for (const t of TIERS) assert.equal(models.getActiveTierEffort(t), 'high');

  // After the fetch: a tier the payload omits falls back to the SHIPPED default,
  // not to the stale seed.
  globalThis.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ ...modelsPayload({ balanced: 'max' }), defaultEffort: 'medium' }),
  });
  await models.loadModelVersions();
  assert.equal(models.getActiveTierEffort('balanced'), 'max', 'a shipped level wins');
  assert.equal(models.getActiveTierEffort('frontier'), 'medium', 'an absent one uses defaultEffort');
});

test('public/index.html anchors the Default option: first, value="", pre-selected', async () => {
  const { dom } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  const opts = [...dom.sdEffort.options];
  assert.equal(opts[0].value, '', 'the empty-value option exists and is FIRST');
  assert.equal(dom.sdEffort.value, '', 'the shipped markup pre-selects it');
  // The remaining entries are the real levels, in order, with no stray duplicate
  // of the removed hardcoded `selected` on `high`.
  assert.deepEqual(opts.slice(1).map(o => o.value), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(opts.filter(o => o.value === '').length, 1);
});
