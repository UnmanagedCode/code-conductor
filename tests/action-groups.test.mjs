// DOM-level tests for collapsible action groups (public/blocks.js's
// createActionGroup family + public/conversation.js's _appendBlockToWrap seam).
// A contiguous run of non-prose blocks (tool_use, tool_result, thinking)
// between two assistant text blocks is wrapped in ONE collapsible <details>,
// collapsed once the run ends. Mirrors the happy-dom setup in
// rendering.test.mjs.
//
// Every test below names the invariant it pins in its title.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import path from 'node:path';
import { promises as fs } from 'node:fs';
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

  const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);

  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');
  return { window, document, root, Conversation };
}

function feed(conv, events) { for (const ev of events) conv.apply(ev); }

// --- Event fixtures --------------------------------------------------------

function thinking(msgId, blockIdx, text = 'pondering') {
  return [
    { kind: 'thinking_start', msgId, blockIdx },
    { kind: 'thinking_delta', msgId, blockIdx, text },
    { kind: 'thinking_end', msgId, blockIdx },
  ];
}

function text(msgId, blockIdx, body) {
  return [
    { kind: 'text_delta', msgId, blockIdx, text: body },
    { kind: 'text_end', msgId, blockIdx },
  ];
}

// A whole tool call: head, finalized input, result. `result: null` leaves it
// unresolved (a run still in flight).
function tool(msgId, blockIdx, id, name, { result = 'ok', isError = false } = {}) {
  const evs = [
    { kind: 'tool_use_start', msgId, blockIdx, toolUseId: id, name },
    { kind: 'tool_use', msgId, blockIdx, toolUseId: id, name, input: { command: 'x' } },
  ];
  if (result !== null) evs.push({ kind: 'tool_result', toolUseId: id, content: result, isError });
  return evs;
}

// --- DOM helpers (direct-children only — a `querySelector('.ag-body')` would
// reach into a nested sub-agent conversation's own group) -------------------

function agBodyOf(group) {
  return [...group.children].find(c => c.classList.contains('ag-body'));
}

function groupsIn(node) { return [...node.querySelectorAll('.action-group')]; }

function summaryTextOf(group) { return group.querySelector('.ag-summary').textContent; }

// The two-run feed shared by tests 1 and 2: thinking + 2 tools, prose,
// 2 tools, prose.
function twoRunFeed() {
  return [
    ...thinking('m1', 0),
    ...tool('m1', 1, 'tu1', 'Bash'),
    ...tool('m1', 2, 'tu2', 'Read'),
    ...text('m1', 3, 'prose one'),
    ...tool('m1', 4, 'tu3', 'Edit'),
    ...tool('m1', 5, 'tu4', 'Grep'),
    ...text('m1', 6, 'prose two'),
  ];
}

// ---------------------------------------------------------------------------
// 1 — pins: a run is bounded by assistant text; one run = one group.
// ---------------------------------------------------------------------------
test('1 pins: each contiguous machinery run becomes exactly one group, prose stays outside', async () => {
  const { root, Conversation } = await setupDOM();
  feed(new Conversation(root, {}), twoRunFeed());

  const bubble = root.querySelector('.msg.assistant');
  assert.ok(bubble, 'one assistant bubble');
  const blocks = bubble.querySelector('.blocks');
  const groups = groupsIn(bubble);
  assert.equal(groups.length, 2, 'two runs, two groups');
  assert.equal(agBodyOf(groups[0]).children.length, 3, 'thinking + 2 tools in the first run');
  assert.equal(agBodyOf(groups[1]).children.length, 2, '2 tools in the second run');

  const directTexts = [...blocks.children].filter(n => n.classList.contains('text'));
  assert.equal(directTexts.length, 2, 'both text blocks are direct children of .blocks');
  assert.deepEqual(directTexts.map(n => n.textContent.trim()), ['prose one', 'prose two']);
  // Order: group, text, group, text — the run boundaries are where prose is.
  assert.deepEqual(
    [...blocks.children].map(n => (n.classList.contains('action-group') ? 'group' : 'text')),
    ['group', 'text', 'group', 'text'],
  );
});

// ---------------------------------------------------------------------------
// 2 — pins: grouping is a wrapper, not a re-render (requirement 5).
// ---------------------------------------------------------------------------
test('2 pins: grouping wraps blocks without changing what renders inside them', async () => {
  const { root, Conversation } = await setupDOM();
  feed(new Conversation(root, {}), twoRunFeed());

  assert.equal(root.querySelectorAll('.block.tool').length, 4, 'every tool block still renders');
  assert.equal(root.querySelectorAll('.block.thinking').length, 1);
  assert.equal(root.querySelectorAll('.block.tool-result').length, 4);
  assert.deepEqual(
    [...root.querySelectorAll('.block.tool .tool-name')].map(n => n.textContent),
    ['Bash', 'Read', 'Edit', 'Grep'],
    'tool names and order unchanged',
  );
  // Each result is attached inside its OWN tool block, not hoisted into the group.
  for (const result of root.querySelectorAll('.block.tool-result')) {
    assert.ok(result.parentElement.classList.contains('tool'),
      'a resolved tool_result is a child of its tool block');
  }
  assert.ok(root.textContent.includes('prose one') && root.textContent.includes('prose two'));
  assert.match(root.querySelector('.block.thinking summary').textContent, /^thinking \(\d+ chars\)$/);
});

// ---------------------------------------------------------------------------
// 3 — pins: the in-flight run stays expanded (requirement 3a).
// ---------------------------------------------------------------------------
test('3 pins: a run still accumulating is open so the user can watch it', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, [
    ...thinking('m1', 0),
    { kind: 'tool_use_start', msgId: 'm1', blockIdx: 1, toolUseId: 'tu1', name: 'Bash' },
  ]);

  const groups = groupsIn(root);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hasAttribute('open'), true, 'an in-flight run is expanded');
});

// ---------------------------------------------------------------------------
// 4 — pins: the run folds when prose arrives (requirement 3b).
// ---------------------------------------------------------------------------
test('4 pins: the group folds when an assistant text block ends the run', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, [...thinking('m1', 0), ...tool('m1', 1, 'tu1', 'Bash')]);
  const group = groupsIn(root)[0];
  assert.equal(group.hasAttribute('open'), true, 'open before the prose');

  feed(conv, text('m1', 2, 'the prose'));

  assert.equal(group.hasAttribute('open'), false, 'the same group node folded');
  const textNode = [...root.querySelectorAll('.block.text')].find(n => n.textContent.includes('the prose'));
  assertNull(textNode.closest('.action-group'), 'the text landed outside the group');
});

// ---------------------------------------------------------------------------
// 5 — pins: a manual toggle beats the auto behaviour (requirement 3c).
// ---------------------------------------------------------------------------
test('5 pins: a summary click stamps the group and the auto-collapse leaves it alone', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, tool('m1', 0, 'tu1', 'Bash'));
  const group = groupsIn(root)[0];

  group.querySelector('.ag-summary').click();
  assert.equal(group.dataset.userToggled, '1', 'the click is recorded as the user\'s choice');
  const afterClick = group.hasAttribute('open');

  feed(conv, text('m1', 1, 'prose that would normally fold it'));
  assert.equal(group.hasAttribute('open'), afterClick,
    'the auto-collapse must not override a group the user toggled');
  assert.equal(group.dataset.userToggled, '1', 'the stamp survives the close');
});

test('5b pins: a user-collapsed in-flight group is never reopened by further tool appends', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, tool('m1', 0, 'tu1', 'Bash'));
  const group = groupsIn(root)[0];

  group.querySelector('.ag-summary').click();
  group.open = false; // the user's collapse lands

  feed(conv, [...tool('m1', 1, 'tu2', 'Read'), ...thinking('m1', 2)]);
  assert.equal(group.hasAttribute('open'), false, 'appending to a collapsed group must not reopen it');
  assert.equal(agBodyOf(group).children.length, 3, 'the blocks still accumulated inside it');
});

// ---------------------------------------------------------------------------
// 6 — pins: a turn ending in machinery still folds; every closer closes
// (requirement 2). Subtests rather than a table loop — a loop would only prove
// the first row when the run is red.
// ---------------------------------------------------------------------------
test('6 pins: every run-ender folds a trailing machinery run', async (t) => {
  const CLOSERS = [
    ['user_echo', { kind: 'user_echo', text: 'next prompt', userIndex: 1 }],
    ['turn_end', { kind: 'turn_end', subtype: 'success' }],
    ['history_gap', { kind: 'history_gap' }],
  ];
  for (const [name, closer] of CLOSERS) {
    await t.test(`${name} folds the trailing group`, async () => {
      const { root, Conversation } = await setupDOM();
      const conv = new Conversation(root, {});
      feed(conv, [...tool('m1', 0, 'tu1', 'Bash'), ...tool('m1', 1, 'tu2', 'Read')]);
      const group = groupsIn(root)[0];
      assert.equal(group.hasAttribute('open'), true, 'open while the run is the live one');

      conv.apply(closer);
      assert.equal(group.hasAttribute('open'), false, `${name} must end the run`);
    });
  }
});

// ---------------------------------------------------------------------------
// 7 — pins: the header's exact, scannable content.
// ---------------------------------------------------------------------------
test('7 pins: the header tallies count, first-appearance names and errors', async () => {
  {
    const { root, Conversation } = await setupDOM();
    feed(new Conversation(root, {}), [
      ...tool('m1', 0, 'a1', 'Bash'), ...tool('m1', 1, 'a2', 'Bash'), ...tool('m1', 2, 'a3', 'Bash'),
      ...tool('m1', 3, 'a4', 'Read'), ...tool('m1', 4, 'a5', 'Read'),
      ...thinking('m1', 5),
    ]);
    assert.equal(summaryTextOf(groupsIn(root)[0]), '6 actions · Bash ×3, Read ×2, thinking');
  }
  {
    const { root, Conversation } = await setupDOM();
    feed(new Conversation(root, {}), [
      ...tool('m1', 0, 'b1', 'Bash'), ...tool('m1', 1, 'b2', 'Read'),
      ...thinking('m1', 2),
      ...tool('m1', 3, 'b3', 'Edit'), ...tool('m1', 4, 'b4', 'Grep'),
    ]);
    assert.equal(summaryTextOf(groupsIn(root)[0]),
      '5 actions · Bash, Read, thinking, Edit, +1 more',
      'at most four distinct names, then the +N more tail');
  }
  {
    const { root, Conversation } = await setupDOM();
    feed(new Conversation(root, {}), [
      ...tool('m1', 0, 'c1', 'Bash'),
      ...tool('m1', 1, 'c2', 'Read', { result: 'boom', isError: true }),
    ]);
    assert.equal(summaryTextOf(groupsIn(root)[0]), '2 actions · Bash, Read · 1 error',
      'a failed tool_result adds the error clause');
  }
});

// ---------------------------------------------------------------------------
// 8 — pins: the summary is live and first-appearance-ordered.
// ---------------------------------------------------------------------------
test('8 pins: the header updates per block and never reorders itself', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});

  feed(conv, [{ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 't1', name: 'Bash' }]);
  const group = groupsIn(root)[0];
  assert.equal(summaryTextOf(group), '1 action · Bash');

  feed(conv, [{ kind: 'tool_use_start', msgId: 'm1', blockIdx: 1, toolUseId: 't2', name: 'Bash' }]);
  assert.equal(summaryTextOf(group), '2 actions · Bash ×2');

  feed(conv, [{ kind: 'tool_use_start', msgId: 'm1', blockIdx: 2, toolUseId: 't3', name: 'Read' }]);
  assert.equal(summaryTextOf(group), '3 actions · Bash ×2, Read',
    'the later name appends; Bash does not jump on count');
});

// ---------------------------------------------------------------------------
// 9 — pins: grouping recurses into sub-agents without breaking _routeChildEvent.
// ---------------------------------------------------------------------------
test('9 pins: an Agent block keeps its sub-conversation, which groups its own run', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, [
    { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent' },
    { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent', input: { description: 'sub' } },
    { kind: 'thinking_start', msgId: 'ms', blockIdx: 0, parentToolUseId: 'tuA' },
    { kind: 'thinking_delta', msgId: 'ms', blockIdx: 0, text: 'nested pondering', parentToolUseId: 'tuA' },
    { kind: 'thinking_end', msgId: 'ms', blockIdx: 0, parentToolUseId: 'tuA' },
    { kind: 'tool_use_start', msgId: 'ms', blockIdx: 1, toolUseId: 'ctu', name: 'Read', parentToolUseId: 'tuA' },
    { kind: 'tool_use', msgId: 'ms', blockIdx: 1, toolUseId: 'ctu', name: 'Read', input: {}, parentToolUseId: 'tuA' },
  ]);

  const outerBlocks = root.querySelector('.msg.assistant > .blocks');
  const outer = [...outerBlocks.children].find(n => n.classList.contains('action-group'));
  assert.ok(outer, 'the Agent call sits in an outer group');
  const agentTool = [...agBodyOf(outer).children][0];
  assert.ok(agentTool.classList.contains('tool'), 'the Agent tool block is the group\'s content');

  const subConv = agentTool.querySelector('.sub-conversation');
  assert.ok(subConv && !subConv.hasAttribute('hidden'), 'the nested panel is hosted and revealed');
  const subBlocks = subConv.querySelector('.sub-conversation-body .msg.assistant > .blocks');
  assert.ok(subBlocks, 'the sub-agent renders its own assistant bubble');
  const nested = [...subBlocks.children].find(n => n.classList.contains('action-group'));
  assert.ok(nested, 'the sub-agent\'s own machinery forms its own group');
  assert.equal(agBodyOf(nested).children.length, 2, 'nested thinking + nested tool');
  assert.ok(nested.textContent.includes('nested pondering'));

  // The nested run is tallied by the nested header only — the outer group
  // counts the one Agent call.
  assert.equal(summaryTextOf(outer), '1 action · Agent');
  assert.equal(summaryTextOf(nested), '2 actions · thinking, Read');
});

// ---------------------------------------------------------------------------
// 10 / 10b — pins: the CSS-origin invariant. happy-dom ships no UA stylesheet,
// so "does an author `display` match?" is both the only answerable question
// here and the faithful one — the same question tests/hidden-attribute-layout
// .test.mjs asks, and the same CSSOM walk.
// ---------------------------------------------------------------------------
async function setupStyledTranscript() {
  const { window, document, root, Conversation } = await setupDOM();
  const css = await fs.readFile(path.join(PUB, 'styles.css'), 'utf8');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const conv = new Conversation(root, {});
  feed(conv, [
    { kind: 'user_echo', text: 'do a thing', userIndex: 0 },
    ...thinking('m1', 0),
    ...tool('m1', 1, 'tu1', 'Bash'),
    ...text('m1', 2, 'some prose'),
    ...tool('m1', 3, 'tu2', 'Read'),
  ]);
  const targets = [
    ...document.querySelectorAll('.action-group'),
    ...document.querySelectorAll('.ag-body'),
  ];
  return { window, document, root, style, targets };
}

// Every author selector that declares `display`, including inside @media.
// Pseudo-element selectors happy-dom cannot match are skipped by the caller's
// try/catch rather than crashing the sweep.
function authorDisplaySelectors(document) {
  const out = [];
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.selectorText && rule.style?.getPropertyValue('display')) out.push(rule.selectorText);
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) walk(sheet.cssRules);
  return out;
}

function sweepGroups(document, targets) {
  const selectors = authorDisplaySelectors(document);
  const hits = [];
  for (const node of targets) {
    for (const sel of selectors) {
      try { if (node.matches(sel)) hits.push(`${node.tagName.toLowerCase()}.${node.className} ← ${sel}`); }
      catch { /* a selector happy-dom cannot match */ }
    }
  }
  return { selectors, hits };
}

test('10 pins: no author `display` in styles.css matches a group or its body', async () => {
  const { document, targets } = await setupStyledTranscript();
  const { selectors, hits } = sweepGroups(document, targets);
  assert.ok(selectors.length > 0, 'sanity: styles.css declares display somewhere');
  assert.ok(targets.length > 0, 'sanity: the transcript really contains groups');
  assert.deepEqual(hits, [],
    'an author `display` on the group or its body would put this sheet in a position to outrank a '
    + 'UA hiding rule (the .quick-spawn-models / .composer-attachments trap). Space the group with '
    + `margins instead:\n  ${hits.join('\n  ')}`);
});

test('10b pins: the sweep would report a `display` collision if one existed', async () => {
  const { document, style, targets } = await setupStyledTranscript();
  assert.deepEqual(sweepGroups(document, targets).hits, [],
    'the control must start from a clean sweep, or it proves nothing');

  style.textContent += '\n.ag-body { display: flex; }';
  const control = sweepGroups(document, targets);
  assert.ok(control.hits.some(h => h.includes('.ag-body')),
    `positive control failed: a deliberate \`.ag-body { display: flex }\` went unreported, so the `
    + `sweep above cannot be trusted.\n  saw: ${JSON.stringify(control.hits)}`);
});

// ---------------------------------------------------------------------------
// 11 — pins: the collapsed state is an attribute the UA acts on, not author
// CSS — which is what makes 10's ban sufficient.
// ---------------------------------------------------------------------------
test('11 pins: the group is a <details>/<summary> whose collapse IS the open attribute', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, tool('m1', 0, 'tu1', 'Bash'));
  const group = groupsIn(root)[0];

  assert.equal(group.tagName, 'DETAILS');
  assert.equal(group.firstElementChild.tagName, 'SUMMARY');
  assert.equal(group.hasAttribute('open'), true);
  assert.equal(group.open, true, 'expanded ⇔ the open attribute is present');

  feed(conv, text('m1', 1, 'prose'));
  assert.equal(group.hasAttribute('open'), false);
  assert.equal(group.open, false, 'collapsed ⇔ the open attribute is absent');
});
