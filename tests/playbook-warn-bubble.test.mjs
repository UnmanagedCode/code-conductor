// The client half of warn-mode playbook visibility: a `system`/`playbook_warn`
// event pushed to the conductor's stream (src/mcp/playbookGate.ts) renders as an
// amber warning bubble in its transcript. Covers the allow-list membership, the
// warn class scoping, and the detail text.

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

const WARN_EV = {
  kind: 'system',
  subtype: 'playbook_warn',
  data: {
    tool: 'send_prompt',
    code: 'TRANSITION_ILLEGAL',
    reason: 'plan cannot reach implement directly',
    sessionId: 'abc12345-dead-beef',
  },
};

// Without this the dispatcher drops the event and every other assertion here
// would fail for the wrong reason — this is the one that names the cause.
test('playbook_warn is in the rendered-system allow-list', async () => {
  setupDOM();
  const { shouldRenderSystem } = await importPublic();
  assert.equal(shouldRenderSystem({ subtype: 'playbook_warn', data: WARN_EV.data }), true);
});

test('playbook_warn renders as a warning-styled system block', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const root = document.createElement('div');
  new Conversation(root, {}).apply(WARN_EV);

  const node = root.querySelector('.block.system.warn');
  assert.ok(node, 'renders a system block carrying the warn class');

  const text = node.textContent;
  assert.ok(text.includes('⚠'), 'carries the warning glyph');
  assert.ok(text.includes('would have been refused'),
    'reads as a warning about a move that was let through');
  assert.ok(text.includes('TRANSITION_ILLEGAL'), 'names the refusal code');
  assert.ok(text.includes('plan cannot reach implement directly'), 'gives the reason');
  assert.ok(text.includes('send_prompt'), 'names the tool');
  assert.ok(text.includes('abc12345'), 'names the target worker');
  assert.ok(!text.includes('abc12345-dead-beef'), 'target sessionId is truncated to 8 chars');
  // The SystemBlock fallback is JSON.stringify(data), which would also contain
  // every field above — so pin that the dedicated branch is what ran.
  assert.ok(!text.includes('{'), 'rendered as prose, not the raw JSON fallback');
});

// SystemBlock always prints the subtype label before the detail, so a detail
// that also says "Playbook (warn)" renders it twice. The label owns the naming.
test('the playbook naming is not duplicated between label and detail', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const root = document.createElement('div');
  new Conversation(root, {}).apply(WARN_EV);
  const node = root.querySelector('.block.system.warn');

  assert.equal(node.querySelector('.subtype').textContent, 'playbook_warn',
    'the label is the subtype, unchanged');
  // This fixture's tool/code/reason contain no "playbook", so every occurrence
  // in the bubble comes from the naming itself — and there must be exactly one.
  assert.equal((node.textContent.match(/playbook/gi) ?? []).length, 1,
    'the bubble names the playbook exactly once');
  assert.ok(!/Playbook \(warn\)/.test(node.textContent),
    'the detail does not restate the label');
});

test('the warn class is scoped to playbook_warn, not every system block', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const root = document.createElement('div');
  new Conversation(root, {}).apply({ kind: 'system', subtype: 'stderr', data: { line: 'noise' } });

  assert.ok(root.querySelector('.block.system'), 'the control block renders');
  // Compared as a boolean, not against null: assert.equal on a live DOM node
  // makes the reporter serialize the whole element tree on failure.
  assert.equal(root.querySelector('.block.system.warn') === null, true,
    'an ordinary system block is not styled as a warning');
});

test('a playbook_warn with no target worker renders without a target fragment', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const root = document.createElement('div');
  new Conversation(root, {}).apply({
    kind: 'system',
    subtype: 'playbook_warn',
    data: { tool: 'spawn_instance', code: 'PLAYBOOK_UNKNOWN', reason: 'no playbook named' },
  });

  const text = root.querySelector('.block.system.warn').textContent;
  assert.ok(text.includes('spawn_instance') && text.includes('PLAYBOOK_UNKNOWN'));
  assert.ok(!text.includes('undefined'), 'no undefined leaks into the bubble');
  assert.ok(!/ on /.test(text), 'no dangling target fragment');
});
