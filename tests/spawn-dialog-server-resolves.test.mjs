// Card 2026-0486 — the New Session dialog and the Conduct button no longer
// resolve {model, backend} client-side. They send only the tier/role NAME and
// the server resolves it against the CURRENT stored binding, so a stale
// client cache (another tab, another device, a Settings change made outside
// this page) can't pin an old model. Same real public/spawnDialog.js harness
// as tests/spawn-dialog-effort.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick, closeWithSpawn } from './spawnDialogHarness.mjs';

test('the dialog POST names only the tier — no model, no backend', async () => {
  const { window, dom, handles, spawns } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  await handles.openSpawnDialog('p');
  await tick();
  dom.spawnDialog.querySelector('.qs-model[data-tier="frontier"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));

  await closeWithSpawn(window, dom);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].tier, 'frontier');
  assert.equal('model' in spawns[0], false, 'no model key — the server resolves the tier');
  assert.equal('backend' in spawns[0], false, 'no backend key — both travel together or not at all');
});

test('the Conduct POST is exactly {project, role, temp, mode} — no model, no backend', async () => {
  const { window, dom, spawns } = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  dom.conductBtn.dispatchEvent(new window.Event('click'));
  await tick(20);

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0], { project: '.conduct', role: 'conductor', temp: true, mode: 'bypassPermissions' });
});

test('Conduct never short-circuits client-side, even when the payload has no roleBackend for it', async () => {
  // The client no longer reads roleBackend at all (the role cache was
  // deleted), so a payload that omits/mismatches it must not stop the spawn —
  // and must not trigger the alert the old "no model configured" branch used
  // to show. That branch is gone; this pins its absence.
  const alerts = [];
  const t = await setup({ fast: 'low', balanced: 'medium', powerful: 'high', frontier: 'max' });
  globalThis.alert = (msg) => alerts.push(msg);

  t.dom.conductBtn.dispatchEvent(new t.window.Event('click'));
  await tick(20);

  assert.equal(t.spawns.length, 1, 'Conduct must spawn regardless of any role-binding cache state');
  assert.deepEqual(alerts, [], 'no alert — the silent server-side fallback is the accepted policy');
});
