// public/app.js's sticky-prompt wiring: installStickyPrompt gets the live
// session getters and the lazy-history controller, and installPromptReveal's
// gestures drive that controller's reveal/conceal. app.js cannot be imported
// (it wires the whole page at load), so the two real install calls are lifted
// out of app.js as source and run against stub installers — their behaviour,
// not their spelling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..', 'public', 'app.js');

async function loadWiring() {
  const src = await fs.readFile(APP, 'utf8');
  const sticky = src.match(/^const stickyPrompt = installStickyPrompt\(\{\n[\s\S]*?\n\}\);\n/m);
  assert.ok(sticky, 'the installStickyPrompt call was renamed or reshaped; update this test\'s slice');
  const reveal = src.match(/^installPromptReveal\(\{\n[\s\S]*?\n\}\);\n/m);
  assert.ok(reveal, 'the installPromptReveal call was renamed or reshaped; update this test\'s slice');
  return new Function('installStickyPrompt', 'installPromptReveal', 'dom', 'document', 'state', 'lazyController',
    `${sticky[0]}${reveal[0]}`);
}

function run(wiring) {
  const actions = [];
  const handle = { reveal: () => actions.push('reveal'), conceal: () => actions.push('conceal') };
  const got = {};
  const dom = { conversation: { id: 'conversation' }, pinnedPrompt: { id: 'pinned-prompt' }, composerInput: { id: 'composer-input' } };
  const elements = new Map();
  const document = { getElementById: (id) => { if (!elements.has(id)) elements.set(id, { id }); return elements.get(id); } };
  const state = { activeId: 'A', instances: [{ id: 'A', conducted: true }, { id: 'B', conducted: false }] };
  const lazyController = { loadUntil() {}, state() {} };
  wiring(
    (opts) => { got.sticky = opts; return handle; },
    (opts) => { got.reveal = opts; },
    dom, document, state, lazyController,
  );
  return { got, actions, dom, document, state, lazyController };
}

test('the reveal gestures call reveal() and the hide gestures call conceal() on the sticky prompt', async () => {
  const w = run(await loadWiring());
  w.got.reveal.onReveal();
  assert.deepEqual(w.actions, ['reveal']);
  w.got.reveal.onConceal();
  assert.deepEqual(w.actions, ['reveal', 'conceal']);
});

test('the gestures read the composer and swipe on the top bar and the pin', async () => {
  const w = run(await loadWiring());
  assert.ok(w.got.reveal.textarea === w.dom.composerInput, 'the composer textarea');
  assert.deepEqual(w.got.reveal.swipeZones.map(z => z.id), ['instance-header', 'pinned-prompt']);
  assert.ok(w.got.reveal.swipeZones[1] === w.dom.pinnedPrompt, 'the pin is the same element the sticky prompt drives');
});

test('installStickyPrompt gets the lazy-history controller and live session getters', async () => {
  const w = run(await loadWiring());
  const o = w.got.sticky;
  assert.ok(o.history === w.lazyController, 'history is the lazy-history controller');
  assert.ok(o.pinEl === w.dom.pinnedPrompt && o.scrollEl === w.dom.conversation);
  assert.equal(o.viewHostEl.id, 'main');
  assert.equal(o.getActiveId(), 'A');
  assert.equal(o.isConducted(), true);
  w.state.activeId = 'B'; // read live, not captured at install
  assert.equal(o.getActiveId(), 'B');
  assert.equal(o.isConducted(), false);
});
