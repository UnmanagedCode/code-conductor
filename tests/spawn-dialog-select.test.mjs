// Which selectInstance options the New Session dialog passes for the instance
// it just created: both entry points (Spawn submit, 🎼 Conduct) are user
// gestures, so public/promptFocus.js focuses the prompt bar for them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick, closeWithSpawn } from './spawnDialogHarness.mjs';

const TIER_EFFORT = { fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' };

test('a spawn selects the new instance with a user gesture', async () => {
  const selected = [];
  const { window, dom, handles } = await setup(TIER_EFFORT, {
    selectInstance: (id, opts) => selected.push({ id, opts }),
  });
  await handles.openSpawnDialog('p');
  await tick();
  await closeWithSpawn(window, dom);

  assert.deepEqual(selected, [{ id: 'i1', opts: { userGesture: true } }]);
});

test('Conduct selects the new conductor with a user gesture', async () => {
  const selected = [];
  const { window, dom } = await setup(TIER_EFFORT, {
    selectInstance: (id, opts) => selected.push({ id, opts }),
  });
  dom.conductBtn.dispatchEvent(new window.Event('click'));
  await tick(20);

  assert.deepEqual(selected, [{ id: 'i1', opts: { userGesture: true } }]);
});
