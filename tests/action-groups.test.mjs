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

// ---------------------------------------------------------------------------
// A2 — pins: every wrap that can hold an open group is reached by the closers.
// `_ensureMessageWrap` serves a CACHED wrap (the shared '__floating__' key an
// orphan tool_result lands on) without re-arming the active-wrap pointer, so a
// closer keyed on that pointer alone folds a different wrap and leaves this
// group open for the rest of the session.
// ---------------------------------------------------------------------------
test('A2 pins: a group on a reused floating wrap is folded by the run-enders', async (t) => {
  const CLOSERS = [
    ['turn_end', { kind: 'turn_end', subtype: 'success' }],
    ['user_echo', { kind: 'user_echo', text: 'later prompt', userIndex: 2 }],
  ];
  for (const [name, closer] of CLOSERS) {
    await t.test(`${name} folds a group on the re-served floating wrap`, async () => {
      const { root, Conversation } = await setupDOM();
      const conv = new Conversation(root, {});
      feed(conv, [
        { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Bash' },
        { kind: 'turn_end', subtype: 'success' },
        // First orphan: `turn_end` never nulls the active pointer, so the m1
        // wrap is still active and '__floating__' is ALIASED onto it. Being
        // the active wrap is what lets the user_echo below fold this group.
        { kind: 'tool_result', toolUseId: 'ghost1', content: 'first orphan' },
        { kind: 'user_echo', text: 'next prompt', userIndex: 1 },
        { kind: 'turn_end', subtype: 'success' },
        // Second orphan: '__floating__' is in the cache now, so the wrap is
        // served without re-arming the active pointer — which the user_echo
        // has since nulled. The group opens on a wrap the pointer never names.
        { kind: 'tool_result', toolUseId: 'ghost2', content: 'second orphan' },
      ]);
      const stranded = groupsIn(root).find(g => g.textContent.includes('second orphan'));
      assert.ok(stranded, 'the second orphan opened a group of its own');
      assert.equal(stranded.hasAttribute('open'), true, 'it is open while it is the live run');

      conv.apply(closer);
      assert.equal(stranded.hasAttribute('open'), false,
        `${name} must fold it — a group no closer reaches stays open for the session`);
    });
  }
});

// ---------------------------------------------------------------------------
// A3 — pins: an interrupted turn's machinery does not stay expanded.
// ---------------------------------------------------------------------------
test('A3 pins: a soft interrupt ends the run and folds its group', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, [...tool('m1', 0, 'tu1', 'Bash'), ...thinking('m1', 1)]);
  const group = groupsIn(root)[0];
  assert.equal(group.hasAttribute('open'), true);

  conv.apply({ kind: 'system', subtype: 'soft_interrupted', data: { text: 'user interrupt' } });
  assert.equal(group.hasAttribute('open'), false,
    'the machinery will never continue — the run is over');
  // The interrupt annotation itself still renders, and the segment stays open
  // (a soft interrupt is not a bubble boundary).
  assert.ok(root.textContent.includes('Turn interrupted'), 'the annotation still renders');
});

// ---------------------------------------------------------------------------
// A4 — pins: the header does not understate failures. docs/features.md states
// the clause appears when a tool result came back as an error; an orphan
// result (no parent tool_use) is one.
// ---------------------------------------------------------------------------
test('A4 pins: an errored orphan tool_result counts toward the error clause', async () => {
  const { root, Conversation } = await setupDOM();
  feed(new Conversation(root, {}), [
    ...tool('m1', 0, 'tu1', 'Bash'),
    { kind: 'tool_result', toolUseId: 'ghost', content: 'boom', isError: true },
  ]);
  assert.equal(summaryTextOf(groupsIn(root)[0]), '2 actions · Bash, tool_result · 1 error');
});

// ---------------------------------------------------------------------------
// B1 — pins: first-appearance order, proven by a label that is later
// OUT-COUNTED by one seen after it. A count-descending tally reads
// `Read ×3, Bash` here.
// ---------------------------------------------------------------------------
test('B1 pins: labels keep first-appearance order even when a later one out-counts them', async () => {
  const { root, Conversation } = await setupDOM();
  feed(new Conversation(root, {}), [
    ...tool('m1', 0, 'x1', 'Bash'),
    ...tool('m1', 1, 'x2', 'Read'), ...tool('m1', 2, 'x3', 'Read'), ...tool('m1', 3, 'x4', 'Read'),
  ]);
  assert.equal(summaryTextOf(groupsIn(root)[0]), '4 actions · Bash, Read ×3',
    'Bash was seen first, so it leads — the tally is not sorted by count');
});

// ---------------------------------------------------------------------------
// B2 — pins the OTHER arm of the manual-toggle guard: a group the user opened
// by hand is not folded when the run ends. (Test 5b covers the collapsed arm,
// which holds trivially because nothing reopens a group.)
// ---------------------------------------------------------------------------
test('B2 pins: a group the user re-opened by hand survives the run ending', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, tool('m1', 0, 'tu1', 'Bash'));
  const group = groupsIn(root)[0];
  const summary = group.querySelector('.ag-summary');

  summary.click();            // the user collapses it
  summary.click();            // …and opens it again
  assert.equal(group.hasAttribute('open'), true, 'sanity: the user\'s toggle left it open');

  feed(conv, text('m1', 1, 'prose that ends the run'));
  assert.equal(group.hasAttribute('open'), true,
    'the auto-collapse must leave a group the user chose to keep open');
});

// ---------------------------------------------------------------------------
// B3 — pins: the error tally is scoped to the group's own tools.
// ---------------------------------------------------------------------------
test('B3 pins: an errored tool inside a sub-agent does not count against the outer group', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, [
    { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent' },
    { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent', input: {} },
    { kind: 'tool_use_start', msgId: 'ms', blockIdx: 0, toolUseId: 'ctu', name: 'Read', parentToolUseId: 'tuA' },
    { kind: 'tool_use', msgId: 'ms', blockIdx: 0, toolUseId: 'ctu', name: 'Read', input: {}, parentToolUseId: 'tuA' },
    { kind: 'tool_result', toolUseId: 'ctu', content: 'no such file', isError: true, parentToolUseId: 'tuA' },
    // The realistic close: the sub-agent fails, then the Agent call itself
    // completes. Attaching this result re-tallies the OUTER header, so it is
    // read after the nested failure exists — without it the assertion below
    // is stale and passes whatever the error scan looks at.
    { kind: 'tool_result', toolUseId: 'tuA', content: 'sub-agent done', isError: false },
  ]);

  const outerBlocks = root.querySelector('.msg.assistant > .blocks');
  const outer = [...outerBlocks.children].find(n => n.classList.contains('action-group'));
  const nested = [...root.querySelectorAll('.sub-conversation-body .msg.assistant > .blocks')][0]
    .querySelector('.action-group');
  assert.ok(nested, 'sanity: the sub-agent has a group of its own');
  assert.equal(summaryTextOf(nested), '1 action · Read · 1 error',
    'sanity: the failure really is inside the nested group');
  assert.ok(agBodyOf(outer).children[0].querySelector('.block.tool-result'),
    'sanity: the Agent\'s own result attached, so the outer header was re-tallied');
  assert.equal(summaryTextOf(outer), '1 action · Agent',
    'the outer header reports the Agent call, not the sub-agent\'s failure');
});

// ---------------------------------------------------------------------------
// B4 — pins: the append seam re-opens a group whose node has left the wrap,
// instead of appending into a node no longer in the document. Defensive: no
// production path detaches a group from a wrap that will be appended to again
// (`mergeActionGroupInto`'s `donor.remove()` is the only removal, and a donor
// always belongs to the discarded batch), so the guard is driven directly
// here.
// ---------------------------------------------------------------------------
test('B4 pins: a detached group is replaced, not appended into', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, tool('m1', 0, 'tu1', 'Bash'));
  const wrap = conv.messageWraps.get('m1');
  const detached = wrap.actionGroup;
  detached.remove(); // the group leaves the wrap without being closed

  feed(conv, tool('m1', 1, 'tu2', 'Read'));

  const fresh = wrap.actionGroup;
  assert.ok(fresh !== detached, 'a group that left the wrap is not reused');
  assert.ok(fresh.parentNode === wrap.body, 'the fresh group is in the wrap body');
  assert.equal(agBodyOf(fresh).children.length, 1, 'the new block went into the live group');
  assert.equal(agBodyOf(detached).children.length, 1,
    'the detached node received nothing — it would never have reached the document');
});

// ---------------------------------------------------------------------------
// B5 — pins: an orphan tool_result is machinery and folds with the rest.
// ---------------------------------------------------------------------------
test('B5 pins: a tool_result with no parent tool_use is grouped like other machinery', async () => {
  const { root, Conversation } = await setupDOM();
  feed(new Conversation(root, {}), [
    { kind: 'tool_result', toolUseId: 'nobody', content: 'stray output' },
  ]);
  const blocks = root.querySelector('.msg.assistant > .blocks');
  assert.equal([...blocks.children].filter(n => n.classList.contains('tool-result')).length, 0,
    'an orphan result must not sit bare beside the prose');
  const group = groupsIn(root)[0];
  assert.ok(group, 'it opened a group');
  assert.ok([...agBodyOf(group).children].some(n => n.classList.contains('tool-result')),
    'the orphan result is inside the group');
});

// ---------------------------------------------------------------------------
// B6 — pins: the non-text arm of _appendStreamingBlock's creation branch. It
// is REACHABLE, not dead: Ring._trim's plain-cut last resort (src/instances.ts
// — a single giant non-quiescent span) can leave the ring head mid-block, so a
// thinking_delta arrives with its thinking_start already evicted.
// ---------------------------------------------------------------------------
test('B6 pins: a thinking block born from a bare thinking_delta still joins the group', async () => {
  const { root, Conversation } = await setupDOM();
  feed(new Conversation(root, {}), [
    { kind: 'thinking_delta', msgId: 'm1', blockIdx: 0, text: 'cut off mid-block' },
  ]);
  const blocks = root.querySelector('.msg.assistant > .blocks');
  assert.equal([...blocks.children].filter(n => n.classList.contains('thinking')).length, 0,
    'a start-less thinking block must not sit bare beside the prose');
  const group = groupsIn(root)[0];
  assert.ok(group, 'it opened a group');
  assert.ok([...agBodyOf(group).children].some(n => n.classList.contains('thinking')),
    'the thinking block is inside the group');
  assert.ok(group.textContent.includes('cut off mid-block'));
});

// ---------------------------------------------------------------------------
// B7 — pins: only the group's OWN summary marks it user-toggled. A listener on
// the group node instead would be reached by every nested <summary>'s click,
// stamping the group the user never touched and suppressing its auto-collapse.
// ---------------------------------------------------------------------------
test('B7 pins: clicking a nested summary never marks the outer group user-toggled', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, [
    { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent' },
    { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent', input: {} },
    { kind: 'text_delta', msgId: 'ms', blockIdx: 0, text: 'sub reply', parentToolUseId: 'tuA' },
    { kind: 'text_end', msgId: 'ms', blockIdx: 0, parentToolUseId: 'tuA' },
    { kind: 'tool_result', toolUseId: 'tuA', content: 'done', isError: false },
  ]);
  const group = groupsIn(root).find(g => [...g.children].some(c => c.classList.contains('ag-body')
    && [...c.children].some(k => k.classList.contains('tool'))));
  const toolBlock = [...agBodyOf(group).children].find(n => n.classList.contains('tool'));

  const nestedSummaries = [
    toolBlock.firstElementChild,                                  // the tool's own summary
    toolBlock.querySelector('.block.tool-result > summary'),      // the result's summary
    toolBlock.querySelector('.sub-conversation > summary'),       // the sub-agent panel's summary
  ];
  for (const s of nestedSummaries) {
    assert.ok(s, 'sanity: every nested summary the user can reach exists');
    s.click();
  }
  assert.equal(group.hasAttribute('data-user-toggled'), false,
    'a click inside the group is not a click on the group');

  feed(conv, text('m1', 1, 'prose ends the run'));
  assert.equal(group.hasAttribute('open'), false,
    'the auto-collapse still fires — a nested click did not suppress it');
});

// ---------------------------------------------------------------------------
// D1 — pins: a tool renamed by its finalizing `tool_use` re-tallies the header.
// Read BETWEEN the rename and any later refresh, so a re-tally triggered by
// something else cannot mask a missing one here.
// ---------------------------------------------------------------------------
test('D1 pins: the header follows a tool renamed by its finalizing tool_use', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, [{ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Bash' }]);
  const group = groupsIn(root)[0];
  assert.equal(summaryTextOf(group), '1 action · Bash', 'sanity: the head\'s name');

  feed(conv, [{ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'BashOutput', input: {} }]);
  assert.equal(summaryTextOf(group), '1 action · BashOutput',
    'the tally must follow setName — no result has attached to re-tally it since');
});

// ---------------------------------------------------------------------------
// D3 — pins: an outer run-ender reaches INTO the sub-agent panels. A sub-agent
// gets no run-ender of its own (`turn_end` is emitted for top-level result
// envelopes only, and the Agent's `tool_result` merely attaches to the parent
// block), so without the recursion its group stays expanded forever.
// ---------------------------------------------------------------------------
test('D3 pins: a run-ender folds a sub-agent\'s group too', async (t) => {
  const CLOSERS = [
    ['turn_end', { kind: 'turn_end', subtype: 'success' }],
    ['user_echo', { kind: 'user_echo', text: 'next prompt', userIndex: 1 }],
  ];
  for (const [name, closer] of CLOSERS) {
    await t.test(`${name} reaches the sub-agent panel`, async () => {
      const { root, Conversation } = await setupDOM();
      const conv = new Conversation(root, {});
      feed(conv, [
        { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent' },
        { kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuA', name: 'Agent', input: {} },
        { kind: 'tool_use_start', msgId: 'ms', blockIdx: 0, toolUseId: 'ctu', name: 'Read', parentToolUseId: 'tuA' },
        { kind: 'tool_use', msgId: 'ms', blockIdx: 0, toolUseId: 'ctu', name: 'Read', input: {}, parentToolUseId: 'tuA' },
        { kind: 'tool_result', toolUseId: 'tuA', content: 'sub-agent done', isError: false },
      ]);
      const nested = root.querySelector('.sub-conversation-body .msg.assistant > .blocks > .action-group');
      assert.ok(nested, 'sanity: the sub-agent has a group of its own');
      assert.equal(summaryTextOf(nested), '1 action · Read');
      assert.equal(nested.hasAttribute('open'), true, 'open while the sub-agent is running');

      conv.apply(closer);
      assert.equal(nested.hasAttribute('open'), false,
        `${name} ends the run one level down too — the panel must not stay expanded`);
    });
  }
});

// ---------------------------------------------------------------------------
// D4 — pins: a killed process ends the run. `_handleExit` emits `system/exit`
// on every process death and `crashed` carries the stderr; the machinery that
// was accumulating can never continue.
// ---------------------------------------------------------------------------
test('D4 pins: a process exit or crash folds the accumulating group', async (t) => {
  const ENDERS = [
    ['exit', { kind: 'system', subtype: 'exit', data: { code: 1, signal: null } }],
    ['crashed', { kind: 'system', subtype: 'crashed', data: { message: 'backend died' } }],
  ];
  for (const [name, ev] of ENDERS) {
    await t.test(`${name} ends the run`, async () => {
      const { root, Conversation } = await setupDOM();
      const conv = new Conversation(root, {});
      feed(conv, [...tool('m1', 0, 'tu1', 'Bash'), ...thinking('m1', 1)]);
      const group = groupsIn(root)[0];
      assert.equal(group.hasAttribute('open'), true);

      conv.apply(ev);
      assert.equal(group.hasAttribute('open'), false, `${name} must end the run`);
    });
  }
});

// ---------------------------------------------------------------------------
// D5 — the other arm of D4/A3: a system event that is NOT terminal must leave
// the watchable run alone. `auto_resume` is mid-session housekeeping — the
// turn continues, so its machinery keeps accumulating in an open group.
// ---------------------------------------------------------------------------
test('D5 pins: a non-terminal system note does not collapse an accumulating group', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root, {});
  feed(conv, tool('m1', 0, 'tu1', 'Bash'));
  const group = groupsIn(root)[0];

  conv.apply({ kind: 'system', subtype: 'auto_resume', data: { count: 2 } });
  assert.equal(group.hasAttribute('open'), true,
    'the run has not ended — the user must still be able to watch it');

  feed(conv, tool('m1', 1, 'tu2', 'Read'));
  assert.equal(agBodyOf(group).children.length, 2, 'and it is still the accumulating run');
});
