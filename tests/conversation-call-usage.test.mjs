// Where the per-call usage line lands in a real Conversation (happy-dom). A
// live `call_usage` follows its call's last block. The line joins the wrap's
// open action group when there is one, else the wrap body. It is never a
// `.block`, so it never changes a group's tally, never opens or splits a
// group, and never creates a wrap of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
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
  const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
  const { renderEventBatch } = await import(pathToFileURL(path.join(PUB, 'lazyHistory.js')).href);
  const style = document.createElement('style');
  style.textContent = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
  document.head.appendChild(style);
  document.body.innerHTML = '<div id="root"></div>';
  return { window, root: document.getElementById('root'), Conversation, renderEventBatch };
}

const feed = (conv, events) => { for (const ev of events) conv.apply(ev); };

const thinking = (msgId, blockIdx) => [
  { kind: 'thinking_start', msgId, blockIdx },
  { kind: 'thinking_delta', msgId, blockIdx, text: 'pondering' },
  { kind: 'thinking_end', msgId, blockIdx },
];
const text = (msgId, blockIdx, body) => [
  { kind: 'text_delta', msgId, blockIdx, text: body },
  { kind: 'text_end', msgId, blockIdx },
];
const tool = (msgId, blockIdx, id, name) => [
  { kind: 'tool_use_start', msgId, blockIdx, toolUseId: id, name },
  { kind: 'tool_use', msgId, blockIdx, toolUseId: id, name, input: { command: 'x' } },
  { kind: 'tool_result', toolUseId: id, content: 'ok', isError: false },
];
const callUsage = (msgId, over = {}) => ({
  kind: 'call_usage', msgId, parentToolUseId: null,
  outputTokens: 460, thinkingTokens: 73, promptTokens: 84_000, growthTokens: 3_200, ...over,
});

const groupsIn = (node) => [...node.querySelectorAll('.action-group')];
const agBodyOf = (group) => [...group.children].find(c => c.classList.contains('ag-body'));
const summaryOf = (group) => group.querySelector('.ag-summary').textContent;

test('a thinking + parallel-tool call: the line joins the open group after its last tool, and the tally ignores it', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  feed(conv, [...thinking('m1', 0), ...tool('m1', 1, 'tu1', 'Read'), ...tool('m1', 2, 'tu2', 'Read')]);
  const [group] = groupsIn(root);
  const before = summaryOf(group);

  conv.apply(callUsage('m1'));
  assert.equal(groupsIn(root).length, 1, 'no group opened or split');
  const kids = [...agBodyOf(group).children];
  assert.ok(kids.at(-1).classList.contains('call-usage'), 'the line follows the call\'s last tool block');
  assert.ok(kids.at(-2).classList.contains('tool'));
  assert.equal(summaryOf(group), before, 'the group header count is unchanged');
  assert.match(before, /^3 actions/);
  assert.ok(group.open, 'the badge does not close the still-running group');
});

test('a call ending in text: the line goes in the wrap body after the text, with no group created', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  feed(conv, [...thinking('m1', 0), ...text('m1', 1, 'the answer')]);
  const groupsBefore = groupsIn(root).length;

  conv.apply(callUsage('m1', { thinkingTokens: 0 }));
  assert.equal(groupsIn(root).length, groupsBefore, 'no extra action group');
  const body = root.querySelector('.msg.assistant > .blocks');
  assert.ok(body.lastElementChild.classList.contains('call-usage'));
  assert.ok(body.lastElementChild.previousElementSibling.classList.contains('text'));
  assert.equal(body.lastElementChild.textContent, '+3.2k → ctx 84k · out 460');
});

test('the next call\'s tools continue the same group, past the line', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  feed(conv, [...tool('m1', 0, 'tu1', 'Read'), callUsage('m1'), ...tool('m2', 0, 'tu2', 'Bash')]);
  const groups = groupsIn(root);
  assert.equal(groups.length, 1, 'one run across both calls');
  const kinds = [...agBodyOf(groups[0]).children].map(c => (c.classList.contains('call-usage') ? 'usage' : 'tool'));
  assert.deepEqual(kinds, ['tool', 'usage', 'tool']);
  assert.match(summaryOf(groups[0]), /^2 actions/);
});

test('a call_usage for an unknown msgId creates no wrap and keeps the empty-state placeholder', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  assert.ok(root.querySelector('.empty'), 'premise: a fresh conversation shows the placeholder');
  conv.apply(callUsage('m-unknown'));
  assert.equal(root.querySelectorAll('.msg').length, 0);
  assert.equal(root.querySelectorAll('.call-usage').length, 0);
  assert.ok(root.querySelector('.empty'), 'the placeholder survives');
});

test('a static lazy-history batch without call_usage renders no line', async () => {
  const { renderEventBatch } = await setupDOM();
  const { holder } = renderEventBatch([
    { kind: 'user_echo', text: 'go', userIndex: 0 },
    ...thinking('m1', 0), ...tool('m1', 1, 'tu1', 'Read'), ...text('m1', 2, 'done'),
  ]);
  assert.ok(holder.querySelector('.tool'), 'premise: the batch rendered its blocks');
  assert.equal(holder.querySelectorAll('.call-usage').length, 0);
});

// happy-dom keeps an element's computed style across a class change on its
// ancestor, so a node read before the toggle would report its old display. A
// clone dropped in beside it computes fresh against the same ancestors, and the
// stylesheet's selectors match it exactly as they match the original.
const displayOf = (window, node) => {
  const probe = node.cloneNode(true);
  node.after(probe);
  const display = window.getComputedStyle(probe).display;
  probe.remove();
  return display;
};

test('hidden by default: the line is rendered with its text but computes display:none', async () => {
  const { window, root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  feed(conv, [...text('m1', 0, 'the answer'), callUsage('m1', { thinkingTokens: 0 })]);
  const line = root.querySelector('.call-usage');
  assert.ok(line, 'the line is always rendered');
  assert.equal(line.textContent, '+3.2k → ctx 84k · out 460');
  assert.equal(displayOf(window, line), 'none');
});

test('setCallUsageVisible(true) shows the already-rendered line and (false) hides it again', async () => {
  const { window, root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  feed(conv, [...tool('m1', 0, 'tu1', 'Read'), callUsage('m1')]);
  const line = root.querySelector('.call-usage');
  const text0 = line.textContent;

  conv.setCallUsageVisible(true);
  assert.notEqual(displayOf(window, line), 'none', 'a line inside an action group shows too');
  assert.equal(line.textContent, text0);

  conv.setCallUsageVisible(false);
  assert.equal(displayOf(window, line), 'none');
});

// ── through the real header ─────────────────────────────────────────────────

async function setupHeader({ instances, activeId }) {
  const { window, root, Conversation } = await setupDOM();
  const html = await fs.readFile(path.join(PUB, 'index.html'), 'utf8');
  const style = document.head.querySelector('style');
  window.document.documentElement.innerHTML = html;
  window.document.head.appendChild(style);
  const doc = window.document;
  const dom = {};
  for (const id of [
    'composer-input', 'mode-toggle', 'kill-btn', 'mute-btn', 'resume-btn', 'instance-title',
    'turn-indicator', 'ti-left', 'ti-dot', 'ti-label', 'ti-ellipsis', 'ti-interrupt-now',
    'ti-usage-slot', 'sync-btn', 'merge-btn', 'debug-btn', 'summarize-session-btn',
    'rename-session-btn', 'change-model-btn', 'change-effort-btn', 'session-stats-btn',
    'prune-session-btn', 'auto-approve-plan-btn', 'playbook-enforcement-btn',
    'overflow-menu', 'overflow-toggle', 'overflow-panel',
  ]) {
    const key = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    dom[key] = doc.getElementById(id);
    assert.ok(dom[key], `dom.${key} must resolve to a real element from index.html`);
  }
  const conversationRoot = doc.getElementById('conversation');
  assert.ok(conversationRoot, '#conversation resolves from index.html');
  const conv = new Conversation(conversationRoot);

  const { installHeader } = await import(pathToFileURL(path.join(PUB, 'header.js')).href + `?t=${Math.random()}`);
  const { UsageTracker, RateLimitTracker } = await import(pathToFileURL(path.join(PUB, 'usage.js')).href);
  const state = { instances, activeId };
  const usage = new Map();
  const header = installHeader({
    dom,
    getActiveId: () => state.activeId,
    getInstances: () => state.instances,
    setActiveStatus: () => {},
    setActiveMode: () => {},
    getUsage: (id) => {
      if (!usage.has(id)) usage.set(id, new UsageTracker());
      return usage.get(id);
    },
    globalRLTracker: new RateLimitTracker(),
    getAccountUsage: () => null,
    getAccountUsageStale: () => false,
    composer: { disable() {}, set() {} },
    conversation: conv,
    sessionActions: {
      applySessionTitle: async () => {}, syncWorktree: async () => {},
      mergeWorktree: async () => {}, respawnActive: async () => {},
    },
    openSummary: () => {}, openStats: () => {}, openPrune: () => {},
  });
  return { window, dom, conv, header, state, root: conversationRoot };
}

const inst = (id, debug) => ({
  id, sessionId: `s-${id}`, status: 'idle', mode: 'plan', model: 'claude-sonnet-4-6',
  project: 'demo', title: null, worktree: null, autoApprovePlan: false,
  interrupting: false, debug,
});

test('turning debug on mid-session through the Debug button reveals the line already on screen', async () => {
  const live = inst('i1', false);
  const { window, dom, conv, header, root } = await setupHeader({ instances: [live], activeId: 'i1' });
  const realFetch = globalThis.fetch;
  const realAlert = globalThis.alert;
  try {
    header.update();
    feed(conv, [...text('m1', 0, 'the answer'), callUsage('m1')]);
    const line = root.querySelector('.call-usage');
    assert.ok(line, 'premise: the line was rendered');
    assert.equal(displayOf(window, line), 'none', 'premise: hidden while debug is off');

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, debugDir: '/tmp/dbg' }) });
    globalThis.alert = () => {};
    dom.debugBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 20 && !root.classList.contains('show-call-usage'); i++) {
      await new Promise(r => setImmediate(r));
    }

    assert.equal(live.debug, true, 'premise: the click handler flipped the flag');
    assert.ok(root.querySelector('.call-usage') === line, 'the same node, not a re-render');
    assert.notEqual(displayOf(window, line), 'none');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.alert = realAlert;
  }
});

test('the line follows the active session: debug A shows, non-debug B hides, back to A shows, none hides', async () => {
  const { window, conv, header, state, root } = await setupHeader({
    instances: [inst('A', true), inst('B', false)], activeId: 'A',
  });
  // selectInstance: clear the shared conversation, then header.update().
  const switchTo = (id) => { state.activeId = id; conv.clear(); header.update(); };
  const renderLine = () => {
    feed(conv, [...text('m1', 0, 'hi'), callUsage('m1')]);
    return root.querySelector('.call-usage');
  };

  header.update();
  assert.notEqual(displayOf(window, renderLine()), 'none', 'debug session A');

  switchTo('B');
  assert.equal(displayOf(window, renderLine()), 'none', 'non-debug session B');

  switchTo('A');
  assert.notEqual(displayOf(window, renderLine()), 'none', 'back on A');

  conv.setCallUsageVisible(true);
  state.activeId = null;
  header.update();
  assert.equal(displayOf(window, root.querySelector('.call-usage')), 'none', 'no active instance');
});

test('in a non-debug session the turn-end segment and the Agent-row total stay displayed', async () => {
  const { window, conv, header, root } = await setupHeader({ instances: [inst('B', false)], activeId: 'B' });
  header.update();
  feed(conv, [
    { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu_agent', name: 'Agent' },
    { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu_agent', name: 'Agent',
      input: { description: 'Fetch docs', subagent_type: 'web-fetch', prompt: 'x' } },
    { kind: 'tool_result', toolUseId: 'tu_agent', content: 'ok', isError: false, agentTokens: 123_873, agentToolUses: 11 },
    callUsage('m1'),
    { kind: 'turn_end', subtype: 'success', durationMs: 1200, cost: null, costDelta: 0.0123,
      usage: { input_tokens: 10, output_tokens: 252 }, isError: false, stopReason: 'end_turn',
      contextTokens: 35_000, contextWindowTokens: 200_000 },
  ]);
  assert.equal(displayOf(window, root.querySelector('.call-usage')), 'none', 'premise: the call line is hidden');
  const turnEnd = root.querySelector('.block.turn-end');
  assert.match(turnEnd.textContent, /ctx 35k \/ 200k .* in=10 out=252$/);
  assert.notEqual(displayOf(window, turnEnd), 'none');
  const badge = root.querySelector('.subagent-usage');
  assert.equal(badge?.textContent, ' · subagent 124k ctx · 11 tool uses');
  assert.notEqual(displayOf(window, badge), 'none');
});
