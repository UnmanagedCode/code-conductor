// DOM-level tests for the Sub-agents strip's playbook/stage label
// (public/subagents.js → SubagentPanel). A bound worker's row grows a small
// muted `<playbook> · <stage>` span; an unbound worker's row must render
// BYTE-IDENTICAL to before the label existed — no hidden/empty placeholder.
//
// happy-dom harness copied from tests/subagent-nesting.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

async function setupDOM() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;

  const { SubagentPanel } = await import(pathToFileURL(path.join(PUB, 'subagents.js')).href);
  document.body.innerHTML = '<div id="subagent-panel" hidden></div>';
  const host = document.getElementById('subagent-panel');
  return { host, SubagentPanel };
}

const CONDUCTOR_ID = 'conductor-1';

function worker(overrides) {
  return {
    id: 'w1', callerInstanceId: CONDUCTOR_ID, displayStatus: 'idle',
    project: 'demo', title: '', firstPrompt: '',
    playbook: null, stage: null,
    ...overrides,
  };
}

test('a bound worker\'s row holds exactly one .subagent-playbook, right after .task-text', async () => {
  const { host, SubagentPanel } = await setupDOM();
  const panel = new SubagentPanel(host);
  panel.setInstances([worker({ id: 'w1', playbook: 'gatelab', stage: 'draft' })], CONDUCTOR_ID);

  const li = host.querySelector('li.task-row');
  assert.ok(li, 'the worker row renders');
  const labels = li.querySelectorAll('.subagent-playbook');
  assert.equal(labels.length, 1, 'exactly one playbook label');
  assert.equal(labels[0].textContent, 'gatelab · draft');

  const text = li.querySelector('.task-text');
  assert.equal([...li.children].indexOf(labels[0]), [...li.children].indexOf(text) + 1,
    'the label sits immediately after .task-text');
});

test('an unbound worker gets no .subagent-playbook element at all — the row is unchanged', async () => {
  const { host, SubagentPanel } = await setupDOM();
  const panel = new SubagentPanel(host);
  panel.setInstances([worker({ id: 'w2' })], CONDUCTOR_ID);

  const li = host.querySelector('li.task-row');
  assert.equal(li.querySelectorAll('.subagent-playbook').length, 0, 'no label node, hidden or otherwise');
  assert.equal(li.children.length, 2, 'exactly marker + text — nothing else appended');
  const marker = li.querySelector('.task-marker');
  const text = li.querySelector('.task-text');
  assert.equal(li.textContent, marker.textContent + text.textContent,
    'rendered text is identical to a row with no playbook label at all');
});

test('a stage change re-renders the label in place, with no stale duplicate', async () => {
  const { host, SubagentPanel } = await setupDOM();
  const panel = new SubagentPanel(host);
  const w = worker({ id: 'w3', playbook: 'gatelab', stage: 'draft' });
  panel.setInstances([w], CONDUCTOR_ID);

  panel.setInstances([{ ...w, stage: 'build' }], CONDUCTOR_ID);

  const li = host.querySelector('li.task-row');
  const labels = li.querySelectorAll('.subagent-playbook');
  assert.equal(labels.length, 1, 'still exactly one label, not two stacked from the re-render');
  assert.equal(labels[0].textContent, 'gatelab · build');
});

test('clicking the playbook label still navigates to the worker — it does not break tap-to-navigate', async () => {
  const { host, SubagentPanel } = await setupDOM();
  const panel = new SubagentPanel(host);
  let navigated = null;
  panel.onNavigate = id => { navigated = id; };
  panel.setInstances([worker({ id: 'w4', playbook: 'gatelab', stage: 'draft' })], CONDUCTOR_ID);

  host.querySelector('.subagent-playbook').click();
  assert.equal(navigated, 'w4');
});
