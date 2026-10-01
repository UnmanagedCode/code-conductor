// The client half of the conductor read nudge: a `system`/`read_nudge` event
// (src/conductorReadNudge.ts → readNudgeEvent) renders as an amber system block
// whose detail is the exact text the model was given.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { readNudgeEvent, readNudgeText } from '../src/conductorReadNudge.ts';

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
  return win;
}

let uid = 0;
async function importPublic() {
  uid++;
  const q = `?uid=${uid}`;
  const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href + q);
  const { shouldRenderSystem } = await import(pathToFileURL(path.join(PUB, 'blocks.js')).href + q);
  return { Conversation, shouldRenderSystem };
}

const NUDGE_EV = readNudgeEvent({
  count: 8, toolName: 'mcp__code-conductor__project_read', toolUseId: 'tu8', text: readNudgeText(8),
});

test('read_nudge is in the rendered-system allow-list', async () => {
  setupDOM();
  const { shouldRenderSystem } = await importPublic();
  assert.equal(shouldRenderSystem(NUDGE_EV), true);
});

test('read_nudge renders as a warn-styled system block carrying the verbatim text', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const root = document.createElement('div');
  new Conversation(root, {}).apply(NUDGE_EV);

  const node = root.querySelector('.block.system.warn');
  assert.ok(node, 'renders a system block carrying the warn class');
  assert.equal(node.querySelector('.subtype').textContent, 'read_nudge', 'labelled with the subtype');
  assert.ok(node.textContent.includes(readNudgeText(8)), 'the detail is exactly what the model saw');
  assert.ok(!node.textContent.includes('{'), 'rendered as the text, not the raw JSON fallback');
});

test('the warn class stays off an ordinary system block', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const root = document.createElement('div');
  new Conversation(root, {}).apply({ kind: 'system', subtype: 'stderr', data: { line: 'noise' } });
  assert.ok(root.querySelector('.block.system'), 'the control block renders');
  assertNull(root.querySelector('.block.system.warn'), 'an ordinary system block is not styled as a warning');
});

// The nudge lands between a tool_use and its tool_result. It is not a run-ender,
// so the open machinery group stays open and the result still reaches its tool.
test('a read_nudge between a tool_use and its tool_result does not close the action group', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  const name = 'mcp__code-conductor__project_read';
  conv.apply({ kind: 'message_start', msgId: 'm1' });
  conv.apply({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu8', name });
  conv.apply({ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu8', name, input: {} });
  conv.apply(NUDGE_EV);
  const group = root.querySelector('details.action-group');
  assert.ok(group, 'the tool opened an action group');
  assert.equal(group.open, true, 'the nudge did not close the group');
  conv.apply({ kind: 'tool_result', toolUseId: 'tu8', content: 'file bytes RESULT-MARK', isError: false });
  assert.equal(group.open, true, 'still open after the result');
  assert.ok(group.textContent.includes('RESULT-MARK'), 'the result attached to its tool inside the group');
  assert.ok(root.querySelector('.block.system.warn'), 'and the nudge rendered');
});
