// The transcript lines a restart model switch leaves (src/transcript.ts →
// modelSwitchEvent): the success divider reads as a model change that restarted
// the session; the failure divider names the target, the model the session is
// still on, and carries the cause as its tooltip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

function setupDOM() {
  const win = new Window({ url: 'http://localhost/' });
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  globalThis.MutationObserver = win.MutationObserver;
}

let uid = 0;
async function render(ev) {
  setupDOM();
  uid++;
  const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + `?uid=${uid}`);
  const root = document.createElement('div');
  new Conversation(root, {}).apply(ev);
  return root.querySelector('.block.system');
}

const detail = (node) => node.textContent.slice(node.querySelector('.subtype').textContent.length).trim();

test('both divider subtypes are in the rendered-system allow-list', async () => {
  setupDOM();
  const { shouldRenderSystem } = await import(pathToFileURL(path.join(PUB, 'blocks.js')).href + '?allow');
  assert.equal(shouldRenderSystem({ subtype: 'model_switch_failed', data: {} }), true);
  assert.equal(shouldRenderSystem({ subtype: 'model_changed', data: { restart: true } }), true);
});

test('the restart divider says the session restarted', async () => {
  const node = await render({ kind: 'system', subtype: 'model_changed', data: { from: 'alpha:cloud', to: 'beta:cloud', restart: true, switchId: 's1' } });
  assert.ok(node);
  assert.equal(detail(node), 'Model changed: alpha:cloud → beta:cloud (session restarted)');
  assert.ok(!node.classList.contains('warn'));
});

test('an identity switch notice is unchanged — no restart suffix', async () => {
  const node = await render({ kind: 'system', subtype: 'model_changed', data: { from: 'claude-haiku-4-5', to: 'claude-opus-4-8' } });
  assert.equal(detail(node), 'Model changed: claude-haiku-4-5 → claude-opus-4-8');
});

test('the failure divider names the target and the model still in use, with the cause as its tooltip', async () => {
  const node = await render({ kind: 'system', subtype: 'model_switch_failed',
    data: { from: 'alpha:cloud', to: 'beta:cloud', error: "Error: model 'beta:cloud' not found", switchId: 's2' } });
  assert.ok(node, 'rendered, not dropped');
  assert.equal(detail(node), 'Switch to beta:cloud failed — still on alpha:cloud');
  assert.equal(node.getAttribute('title'), "Error: model 'beta:cloud' not found");
  assert.ok(node.classList.contains('warn'), 'styled as a warning');
});

test('a cancelled switch (a Terminate mid-switch) reads as a stop, neutral, with no cause', async () => {
  const node = await render({ kind: 'system', subtype: 'model_switch_failed',
    data: { from: 'alpha:cloud', to: 'beta:cloud', cancelled: true, switchId: 's3' } });
  assert.ok(node, 'rendered, not dropped');
  assert.equal(detail(node), 'Switch to beta:cloud cancelled — session stopped');
  assert.ok(!node.classList.contains('warn'), 'not warn-styled');
  assert.equal(node.getAttribute('title'), null);
});
