// Where the per-call usage line lands in a real Conversation (happy-dom). A
// live `call_usage` follows its call's last block. The line joins the wrap's
// open action group when there is one, else the wrap body. It is never a
// `.block`, so it never changes a group's tally, never opens or splits a
// group, and never creates a wrap of its own.
//
// The line is also opt-in per session: styles.css hides `.call-usage` unless the
// conversation root carries `show-call-usage`, and header.js update() sets that
// class (Conversation.setCallUsageVisible) from the active session's "Show
// mid-turn statistics" box in the Statistics dialog (sessionStats.js). Debug mode
// does not enter into it. The visibility tests load the real stylesheet and
// assert the computed display, not the class.

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
    'overflow-menu', 'overflow-toggle', 'overflow-panel', 'stats-dialog',
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
  const { installSessionStats } = await import(pathToFileURL(path.join(PUB, 'sessionStats.js')).href + `?t=${Math.random()}`);
  const stats = installSessionStats({
    dom,
    getActiveSid: () => state.instances.find(i => i.id === state.activeId)?.sessionId ?? null,
    isCallUsageShown: header.isCallUsageShown,
    setCallUsageShown: header.setCallUsageShown,
  });
  const box = doc.getElementById('stats-call-usage');
  assert.ok(box, '#stats-call-usage resolves from index.html');
  // The dialog's cost fetch is stubbed; the box is synced before it, so a test
  // reads the box straight after open() resolves.
  const openStats = () => stats.open();
  // A bubbling change, as the browser fires on a user's tick.
  const tick = (on) => {
    box.checked = on;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  return { window, dom, conv, header, state, root: conversationRoot, box, openStats, tick };
}

// Runs `fn` with the Statistics dialog's cost fetch stubbed, restoring fetch after.
const withStatsFetch = async (fn) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ own: {}, rolled: {}, workerSessions: 0 }) });
  try { await fn(); } finally { globalThis.fetch = realFetch; }
};

const inst = (id, debug) => ({
  id, sessionId: `s-${id}`, status: 'idle', mode: 'plan', model: 'claude-sonnet-4-6',
  project: 'demo', title: null, worktree: null, autoApprovePlan: false,
  interrupting: false, debug,
});

const renderLine = (conv, root) => {
  feed(conv, [...text('m1', 0, 'hi'), callUsage('m1')]);
  return root.querySelector('.call-usage');
};

test('default off: a fresh session hides the line and its Statistics box opens unticked', () => withStatsFetch(async () => {
  const { window, header, conv, root, box, openStats } = await setupHeader({ instances: [inst('i1', false)], activeId: 'i1' });
  header.update();
  const line = renderLine(conv, root);
  assert.equal(displayOf(window, line), 'none');
  box.checked = true; // a stale tick must not survive the open
  await openStats();
  assert.equal(box.checked, false);
}));

test('ticking the Statistics box reveals the line already on screen; unticking hides it again', () => withStatsFetch(async () => {
  const { window, header, conv, root, openStats, tick } = await setupHeader({ instances: [inst('i1', false)], activeId: 'i1' });
  header.update();
  const line = renderLine(conv, root);
  assert.equal(displayOf(window, line), 'none', 'premise: hidden before the tick');
  await openStats();

  tick(true);
  assert.ok(root.querySelector('.call-usage') === line, 'the same node, not a re-render');
  assert.notEqual(displayOf(window, line), 'none');

  tick(false);
  assert.equal(displayOf(window, line), 'none');
}));

test('debug alone does not reveal the line: a session that starts with debug on still computes display:none', () => withStatsFetch(async () => {
  const { window, header, conv, root } = await setupHeader({ instances: [inst('D', true)], activeId: 'D' });
  header.update();
  assert.equal(displayOf(window, renderLine(conv, root)), 'none');
}));

test('turning debug on mid-session through the Debug button leaves the line on screen hidden', async () => {
  const live = inst('i1', false);
  const { window, dom, conv, header, root } = await setupHeader({ instances: [live], activeId: 'i1' });
  const realFetch = globalThis.fetch;
  const realAlert = globalThis.alert;
  try {
    header.update();
    const line = renderLine(conv, root);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, debugDir: '/tmp/dbg' }) });
    globalThis.alert = () => {};
    dom.debugBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 20 && !live.debug; i++) await new Promise(r => setImmediate(r));
    assert.equal(live.debug, true, 'premise: the click handler flipped the flag');
    header.update();
    assert.ok(root.querySelector('.call-usage') === line, 'the same node, not a re-render');
    assert.equal(displayOf(window, line), 'none');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.alert = realAlert;
  }
});

test('the setting is per session: A ticked shows on A only, B opens unticked, back on A it is still ticked, no session hides', () => withStatsFetch(async () => {
  const { window, conv, header, state, root, box, openStats, tick } = await setupHeader({
    instances: [inst('A', false), inst('B', false)], activeId: 'A',
  });
  // selectInstance: clear the shared conversation, then header.update().
  const switchTo = (id) => { state.activeId = id; conv.clear(); header.update(); };

  header.update();
  await openStats();
  tick(true);
  assert.notEqual(displayOf(window, renderLine(conv, root)), 'none', 'A ticked');

  switchTo('B');
  assert.equal(displayOf(window, renderLine(conv, root)), 'none', 'B never ticked');
  await openStats();
  assert.equal(box.checked, false, 'B opens unticked');

  switchTo('A');
  assert.notEqual(displayOf(window, renderLine(conv, root)), 'none', 'back on A');
  await openStats();
  assert.equal(box.checked, true, 'A opens ticked');

  conv.setCallUsageVisible(true);
  state.activeId = null;
  header.update();
  assert.equal(displayOf(window, root.querySelector('.call-usage')), 'none', 'no active instance');
}));

test('a tick made in a dialog opened on A lands on A even if the active session moves before the change', () => withStatsFetch(async () => {
  const { window, conv, header, state, root, openStats, tick } = await setupHeader({
    instances: [inst('A', false), inst('B', false)], activeId: 'A',
  });
  header.update();
  await openStats();
  state.activeId = 'B';
  conv.clear();
  header.update();
  tick(true);
  assert.equal(displayOf(window, renderLine(conv, root)), 'none', 'B stays off');
  state.activeId = 'A';
  header.update();
  assert.equal(header.isCallUsageShown('s-A'), true);
  assert.equal(header.isCallUsageShown('s-B'), false);
}));

test('the setting follows the session across a respawn: a new instance id with the same sessionId stays ticked', () => withStatsFetch(async () => {
  const { window, conv, header, state, root, openStats, tick } = await setupHeader({
    instances: [inst('old', false)], activeId: 'old',
  });
  header.update();
  await openStats();
  tick(true);

  state.instances = [{ ...inst('new', false), sessionId: 's-old' }];
  state.activeId = 'new';
  conv.clear();
  header.update();
  assert.notEqual(displayOf(window, renderLine(conv, root)), 'none');
}));

test('a session with no sessionId yet is never shown, and the query for it is false', () => withStatsFetch(async () => {
  const { window, conv, header, root } = await setupHeader({
    instances: [{ ...inst('i1', false), sessionId: null }], activeId: 'i1',
  });
  header.setCallUsageShown(null, true);
  header.update();
  assert.equal(header.isCallUsageShown(null), false);
  assert.equal(displayOf(window, renderLine(conv, root)), 'none');
}));

test('the turn-end segment and the Agent-row total stay displayed with show-call-usage off and on', async () => {
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
  const badge = root.querySelector('.subagent-usage');
  assert.equal(badge?.textContent, ' · subagent 124k ctx · 11 tool uses');
  const assertBothShown = (when) => {
    assert.notEqual(displayOf(window, turnEnd), 'none', `turn-end segment, ${when}`);
    assert.notEqual(displayOf(window, badge), 'none', `Agent-row total, ${when}`);
  };
  assertBothShown('toggle off');

  conv.setCallUsageVisible(true);
  assert.notEqual(displayOf(window, root.querySelector('.call-usage')), 'none', 'premise: the call line shows once the class is on');
  assertBothShown('toggle on');
});
