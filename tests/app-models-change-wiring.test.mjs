// public/app.js's Settings `onModelsChange` handler is what keeps the models.js
// cache current after a Settings → Models edit: it hands the refreshed payload
// to applyModelsPayload, then re-syncs the spawn dialog's tier labels and
// visibility, which read that cache (the order spawnDialog.js's header relies
// on). app.js cannot be imported (it wires the whole page at load), so the real
// handler's source is lifted out of app.js and run against stubs — its
// behaviour, not its spelling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..', 'public', 'app.js');

async function loadOnModelsChange() {
  const src = await fs.readFile(APP, 'utf8');
  const m = src.match(/^ {2}onModelsChange: (data => \{\n[\s\S]*?\n {2}\}),\n/m);
  assert.ok(m, 'onModelsChange was renamed or reshaped; update this test\'s slice');
  return new Function('applyModelsPayload', 'spawnHandles', `return (${m[1]});`);
}

test('onModelsChange applies the Settings payload to the models cache, then re-syncs the spawn dialog', async () => {
  const calls = [];
  const applyModelsPayload = (data) => { calls.push(['applyModelsPayload', data]); };
  const spawnHandles = {
    syncTierModelLabels: () => { calls.push(['syncTierModelLabels']); },
    syncTierVisibility: () => { calls.push(['syncTierVisibility']); },
  };
  const payload = { backendModels: { ollama: [{ model: 'm:cloud', label: 'M' }] }, tierBackend: {} };
  (await loadOnModelsChange())(applyModelsPayload, spawnHandles)(payload);
  assert.equal(calls.length, 3, JSON.stringify(calls));
  assert.equal(calls[0][0], 'applyModelsPayload', 'the cache is updated before anything reads it');
  assert.ok(calls[0][1] === payload, 'the very payload Settings received, not a copy or a subset');
  assert.deepEqual(calls.slice(1).map(c => c[0]).sort(), ['syncTierModelLabels', 'syncTierVisibility']);
});
