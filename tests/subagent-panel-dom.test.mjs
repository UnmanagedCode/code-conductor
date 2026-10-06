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

test('clicking a worker navigates with a user gesture', async () => {
  const { host, SubagentPanel } = await setupDOM();
  const panel = new SubagentPanel(host);
  let navigatedOpts = null;
  panel.onNavigate = (id, opts) => { navigatedOpts = opts; };
  panel.setInstances([worker({ id: 'w5' })], CONDUCTOR_ID);

  host.querySelector('li.task-row').click();
  assert.deepEqual(navigatedOpts, { userGesture: true });
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

// Invariant: an idle worker still waiting on workers of its own reads as running
// in its parent's strip — the running marker, the awaiting class, and the
// sidebar's "on a worker" label.
test('an idle worker awaiting a wake renders as running, marked subagent-awaiting', async () => {
  const { host, SubagentPanel } = await setupDOM();
  new SubagentPanel(host).setInstances([worker({ displayStatus: 'idle', awaitingWake: true })], CONDUCTOR_ID);
  const li = host.querySelector('li.task-row');
  assert.equal(li.querySelector('.task-marker').textContent, '▶');
  assert.ok(li.classList.contains('subagent-awaiting'));
  assert.ok(li.classList.contains('task-in_progress'));
  assert.equal(li.title, 'on a worker');
});

// Invariant: the awaiting treatment needs BOTH idle and awaitingWake — a plain
// idle worker and a mid-turn one keep their own rows.
test('only an idle awaiting worker gets the awaiting treatment', async (t) => {
  const cases = [
    ['idle, not awaiting', { displayStatus: 'idle', awaitingWake: false }, '●'],
    ['mid-turn and awaiting', { displayStatus: 'turn', awaitingWake: true }, '▶'],
  ];
  for (const [name, over, marker] of cases) {
    await t.test(name, async () => {
      const { host, SubagentPanel } = await setupDOM();
      new SubagentPanel(host).setInstances([worker(over)], CONDUCTOR_ID);
      const li = host.querySelector('li.task-row');
      assert.equal(li.querySelector('.task-marker').textContent, marker);
      assert.equal(li.classList.contains('subagent-awaiting'), false);
      assert.equal(li.title, '');
    });
  }
});

// Invariant: an idle worker with a background job still running (on it or below
// it) gets the same awaiting treatment, labelled "on a job".
test('an idle worker waiting on a background job renders as awaiting, titled "on a job"', async () => {
  const { host, SubagentPanel } = await setupDOM();
  new SubagentPanel(host).setInstances([worker({ displayStatus: 'idle', waitingOnJob: true })], CONDUCTOR_ID);
  const li = host.querySelector('li.task-row');
  assert.equal(li.querySelector('.task-marker').textContent, '▶');
  assert.ok(li.classList.contains('subagent-awaiting'));
  assert.equal(li.title, 'on a job');
});

// Invariant: a worker whose subagent is still running reads plain running even
// with a job — the job never turns a running row into an awaiting one.
test('displayStatus running with a job stays plain running, not awaiting', async () => {
  const { host, SubagentPanel } = await setupDOM();
  new SubagentPanel(host).setInstances([worker({ displayStatus: 'running', waitingOnJob: true })], CONDUCTOR_ID);
  const li = host.querySelector('li.task-row');
  assert.equal(li.querySelector('.task-marker').textContent, '▶');
  assert.equal(li.classList.contains('subagent-awaiting'), false);
  assert.equal(li.title, '');
});

// Invariant: the awaiting marker is the accent colour and pulses.
test('the subagent-awaiting marker is styled accent and pulsing', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(path.join(PUB, 'styles.css'), 'utf8');
  const rule = css.match(/\.task-row\.subagent-awaiting \.task-marker\s*\{([^}]*)\}/);
  assert.ok(rule, 'the rule exists');
  assert.match(rule[1], /color:\s*var\(--accent\)/);
  assert.match(rule[1], /animation:\s*pulse\b/);
});
