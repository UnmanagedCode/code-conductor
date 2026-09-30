// DOM tests for the compaction bubble, driving the real src/parser.ts,
// src/transcript.ts replay and public/conversation.js under happy-dom.
//
// Fixtures: `compaction-manual.*` are committed trims of one real CLI 2.1.284
// capture of a manual `/compact` (structural fields verbatim; the init frame's
// long arrays shortened, paths scrubbed). `compaction-auto.*` are committed trims
// of one real CLI 2.1.284 auto-compaction, mid-turn (structural fields verbatim;
// tool-result bodies shortened, environment-dump attachments dropped, paths
// scrubbed; the instance id in the kept hook-callback URLs is a placeholder).
// In the stdout fixture each tool_use block's `input_json_delta` fragments were
// re-chunked from the scrubbed concatenation at the original fragment lengths
// (a path split across fragments cannot be scrubbed piecewise), so those frames
// differ from the capture in where the path text splits. The auto summary
// arrives as array content live and as a string in the jsonl; a manual
// `/compact` has no mid-turn work around it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNull } from './dom-assert.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const SRC = path.resolve(__dirname, '..', 'src');
const FX = path.join(__dirname, 'fixtures');

async function setupDOM() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  const { Parser } = await import(pathToFileURL(path.join(SRC, 'parser.ts')).href);
  const { replayPersistedLine } = await import(pathToFileURL(path.join(SRC, 'transcript.ts')).href);
  const { Conversation } = await import(pathToFileURL(path.join(PUB, 'conversation.js')).href);
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');
  return { root, Parser, replayPersistedLine, Conversation };
}

const readJsonl = async (name) =>
  (await fs.readFile(path.join(FX, name), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

let seq = 0;
const apply = (conv, ev) => conv.apply({ ...ev, _seq: ++seq });

// A notice shape the renderer must tolerate, not one cc emits for this model pair: `_trackModel` canonicalizes a dated id to its catalog id, so it never announces this `from`/`to`.
const MODEL_CHANGED = { kind: 'system', subtype: 'model_changed', data: { from: 'claude-haiku-4-5-20251001', to: 'claude-haiku-4-5' } };

function feedFrames(conv, parser, frames) {
  for (const frame of frames) {
    for (const ev of parser.handleObject(frame)) {
      if (ev.kind === 'system' && ev.subtype === 'init') apply(conv, MODEL_CHANGED);
      apply(conv, ev);
    }
  }
}

const N = (n) => n.toLocaleString();
const MANUAL_LABEL = `Context compacted · manual · ${N(27152)} → ${N(2952)} tokens`;
const labelsOf = (root) => [...root.querySelectorAll('.msg.compaction .compaction-label')].map((n) => n.textContent);
const childIndex = (root, pred) => [...root.children].findIndex(pred);
const isUserBubble = (n) => n.classList.contains('user');
const isCompaction = (n) => n.classList.contains('compaction');
const subtypesOf = (root) => [...root.querySelectorAll('.block.system > .subtype')].map((n) => n.textContent);

async function renderLive() {
  const { root, Parser, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  apply(conv, { kind: 'user_echo', text: '/compact', userIndex: 1 });
  feedFrames(conv, new Parser(), await readJsonl('compaction-manual.stdout.jsonl'));
  return { root, conv };
}

async function renderReload() {
  const { root, Conversation, replayPersistedLine } = await setupDOM();
  const conv = new Conversation(root);
  for (const line of await readJsonl('compaction-manual.transcript.jsonl')) {
    for (const ev of replayPersistedLine(line)) apply(conv, ev);
  }
  return { root, conv };
}

const AUTO_LABEL = `Context compacted · auto · ${N(183658)} → ${N(24338)} tokens`;
const AUTO_PROMPT = 'again, read all wiki pages';
const SUMMARY_PREFIX = 'This session is being continued';
const isAssistant = (n) => n.classList.contains('assistant');
const groupOf = (bubble) => bubble.querySelector('.action-group');
const groupSummary = (group) => group.querySelector('.ag-summary').textContent;

// The slice starts mid-turn, after the prompt: there is no `init` in it, so no
// model_changed is injected.
async function renderAutoLive() {
  const { root, Parser, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  apply(conv, { kind: 'user_echo', text: AUTO_PROMPT, userIndex: 3 });
  feedFrames(conv, new Parser(), await readJsonl('compaction-auto.stdout.jsonl'));
  return { root, conv };
}

async function renderAutoReload() {
  const { root, Conversation, replayPersistedLine } = await setupDOM();
  const conv = new Conversation(root);
  for (const line of await readJsonl('compaction-auto.transcript.jsonl')) {
    for (const ev of replayPersistedLine(line)) apply(conv, ev);
  }
  return { root, conv };
}

test('live: a manual /compact renders one compaction bubble after the untouched /compact bubble', async () => {
  const { root } = await renderLive();

  assert.equal(root.querySelectorAll('.msg.compaction').length, 1);
  const [label] = labelsOf(root);
  for (const part of ['Context compacted', 'manual', N(27152), N(2952)]) {
    assert.ok(label.includes(part), `header ${JSON.stringify(label)} names ${part}`);
  }

  const users = [...root.querySelectorAll('.msg.user')];
  assert.equal(users.length, 1, 'only the /compact echo is a user bubble');
  assert.ok(users[0].textContent.includes('/compact'));
  assert.ok(childIndex(root, isUserBubble) < childIndex(root, isCompaction), '/compact bubble sits above the compaction bubble');
  for (const u of users) {
    assert.ok(!u.textContent.includes('This session is being continued'), 'the summary is not a user bubble');
    assert.ok(!u.textContent.includes('local-command-stdout'), 'the command output is not a user bubble');
  }
  assert.deepEqual(subtypesOf(root), [], 'the CLI re-init and cc\'s model_changed are not shown');
});

test('live: the running bubble is the same node the boundary completes', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  const parser = new Parser();
  const frames = await readJsonl('compaction-manual.stdout.jsonl');

  feedFrames(conv, parser, frames.slice(0, 1)); // status: compacting
  assert.equal(root.querySelectorAll('.msg.compaction').length, 1);
  assert.deepEqual(labelsOf(root), ['Compacting context…']);
  const before = root.querySelector('.msg.compaction');

  feedFrames(conv, parser, frames.slice(1, 4)); // compact_result, init, boundary
  const after = root.querySelector('.msg.compaction');
  assert.equal(root.querySelectorAll('.msg.compaction').length, 1, 'no duplicate bubble');
  assert.ok(before === after, 'the boundary completes the running bubble in place');
  assert.deepEqual(labelsOf(root), [MANUAL_LABEL]);
});

test('reload: the persisted lines render the identical bubble in live order', async () => {
  const live = await renderLive();
  const liveLabels = labelsOf(live.root);
  const { root } = await renderReload();

  assert.equal(root.querySelectorAll('.msg.compaction').length, 1);
  assert.deepEqual(labelsOf(root), liveLabels, 'same header text as live');

  const users = [...root.querySelectorAll('.msg.user')];
  assert.equal(users.length, 2, 'the first prompt and the /compact command — the summary and stdout are not bubbles');
  const commandBubble = users.find((u) => u.textContent.includes('<command-name>/compact</command-name>'));
  assert.ok(commandBubble, 'the /compact bubble still renders its raw command wrapper');
  const commandIdx = childIndex(root, (n) => n === commandBubble);
  assert.ok(commandIdx < childIndex(root, isCompaction), 'compaction bubble is re-seated below the /compact bubble');
  for (const u of users) assert.ok(!u.textContent.includes('local-command-stdout'), 'stdout absorbed');
});

test('the summary is collapsed and expands lazily into the markdown body', async () => {
  const { root } = await renderReload();
  const details = root.querySelector('details.block.compaction');
  assert.ok(details, 'the summary rides in a <details> inside the bubble');
  assert.equal(details.open, false);
  assertNull(details.querySelector('.user-text'), 'nothing built before the first expand');
  assert.ok(details.querySelector(':scope > summary .compaction-label').textContent.includes('Context compacted'));

  details.querySelector(':scope > summary').click();
  assert.equal(details.open, true);
  const body = details.querySelector('.user-text');
  assert.ok(body.textContent.includes('Primary Request and Intent'));
  assert.equal(body.dataset.view, 'rendered');
  assert.ok(details.querySelector('.user-view-toggle'), 'raw/md toggle');
  assert.ok(details.querySelector('.user-view-copy'), 'copy control');
});

test('live auto: one compaction bubble, no summary user bubble', async () => {
  const { root } = await renderAutoLive();

  assert.deepEqual(labelsOf(root), [AUTO_LABEL]);
  const users = [...root.querySelectorAll('.msg.user')];
  assert.equal(users.length, 1, 'only the prompt is a user bubble');
  assert.ok(users[0].textContent.includes(AUTO_PROMPT));
  for (const u of users) assert.ok(!u.textContent.includes(SUMMARY_PREFIX), 'the summary is not a user bubble');
  const details = root.querySelector('details.block.compaction');
  assert.ok(details, 'the summary rides in the bubble');
  assert.equal(details.open, false);
  assert.deepEqual(subtypesOf(root), [], 'no init is shown in the slice');
});

test('live auto: the bubble splits the turn, so later work sits below it', async () => {
  const { root } = await renderAutoLive();

  const kids = [...root.children];
  assert.deepEqual(kids.map((n) => n.className), ['msg user', 'msg assistant', 'msg compaction', 'msg assistant']);
  const [, before, compaction, after] = kids;
  const beforeGroup = groupOf(before);
  assert.equal(beforeGroup.hasAttribute('open'), false, 'the compaction ended the pre-compaction run');
  assert.equal(groupSummary(beforeGroup), '3 actions · thinking, Read, Bash');
  assert.equal(groupSummary(groupOf(after)), '3 actions · thinking, Bash, Read',
    'the post-compaction work is its own bubble');
  assert.ok(compaction.previousElementSibling === before);
  assert.ok(compaction.nextElementSibling === after);
});

test('reload auto: the identical bubble at the identical position', async () => {
  const live = await renderAutoLive();
  const { root } = await renderAutoReload();

  assert.deepEqual(labelsOf(root), labelsOf(live.root), 'same header text as live');
  assert.deepEqual([...root.children].map((n) => n.className), ['msg assistant', 'msg compaction', 'msg assistant'],
    'the slice has no prompt echo; the compaction splits the turn as it does live');
  for (const u of root.querySelectorAll('.msg.user')) assert.ok(!u.textContent.includes(SUMMARY_PREFIX));
  const [before, , after] = root.children;
  assert.equal(groupOf(before).hasAttribute('open'), false);
  assert.equal(groupSummary(groupOf(before)), '3 actions · thinking, Read, Bash');
  assert.equal(groupSummary(groupOf(after)), '2 actions · thinking, Bash',
    'replay has no in-flight Read: only the persisted blocks');
});

test('manual /compact DOM is unchanged', async () => {
  const live = await renderLive();
  assert.deepEqual([...live.root.children].map((n) => n.className), ['msg user', 'msg compaction', '']);
  assert.deepEqual(labelsOf(live.root), [MANUAL_LABEL]);

  const reload = await renderReload();
  assert.deepEqual([...reload.root.children].map((n) => n.className),
    ['msg user', 'msg assistant', 'msg user', 'msg compaction']);
  assert.deepEqual(labelsOf(reload.root), [MANUAL_LABEL]);
});

test('a failed compaction is shown, live-only', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  const parser = new Parser();
  const status = (extra) => ({ type: 'system', subtype: 'status', ...extra });
  feedFrames(conv, parser, [status({ status: 'compacting' })]);
  assert.deepEqual(labelsOf(root), ['Compacting context…']);

  feedFrames(conv, parser, [status({ status: null, compact_result: 'failed', compact_error: 'boom' })]);
  assert.deepEqual(labelsOf(root), ['Compaction failed: boom']);

  feedFrames(conv, parser, [{ type: 'system', subtype: 'init', model: 'claude-haiku-4-5', session_id: 'abcdef123456' }]);
  assert.deepEqual(subtypesOf(root), ['model_changed', 'init'], 'a later re-init is not suppressed after the failure');
});

test('a failed compaction mid-turn splits the turn like a successful one', async () => {
  const { root, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  apply(conv, { kind: 'user_echo', text: 'go', userIndex: 0 });
  apply(conv, { kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tu1', name: 'Bash' });
  apply(conv, { kind: 'system', subtype: 'status', data: { status: 'compacting' } });
  apply(conv, { kind: 'system', subtype: 'status', data: { status: null, compact_result: 'failed', compact_error: 'boom' } });
  apply(conv, { kind: 'tool_use_start', msgId: 'm2', blockIdx: 0, toolUseId: 'tu2', name: 'Read' });

  assert.deepEqual(labelsOf(root), ['Compaction failed: boom']);
  assert.deepEqual([...root.children].map((n) => n.className),
    ['msg user', 'msg assistant', 'msg compaction', 'msg assistant']);
  const [, before, , after] = root.children;
  assert.equal(groupOf(before).hasAttribute('open'), false, 'the run before the compaction is folded');
  assert.ok(!before.textContent.includes('Read'), 'work after the failure is not in the earlier bubble');
  assert.ok(groupSummary(groupOf(after)).includes('Read'), 'it opens a new bubble below the failed one');
});

test('a compaction that never reached its boundary is closed by the turn ending', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  const parser = new Parser();
  feedFrames(conv, parser, [{ type: 'system', subtype: 'status', status: 'compacting' }]);
  feedFrames(conv, parser, [{ type: 'result', subtype: 'success' }]);
  assert.deepEqual(labelsOf(root), ['Compaction did not complete']);
  feedFrames(conv, parser, [{ type: 'system', subtype: 'init', model: 'm', session_id: 'abcdef123456' }]);
  assert.deepEqual(subtypesOf(root), ['model_changed', 'init'], 'a later re-init is shown');
});

test('absorption is scoped to a compaction', async (t) => {
  const stdoutEcho = { kind: 'user_echo', text: '<local-command-stdout>x</local-command-stdout>' };

  await t.test('a lone local-command stdout echo with no compaction still renders as a user bubble', async () => {
    const { root, Conversation } = await setupDOM();
    const conv = new Conversation(root);
    apply(conv, stdoutEcho);
    assert.equal(root.querySelectorAll('.msg.user').length, 1);
    assert.ok(root.querySelector('.msg.user').textContent.includes('local-command-stdout'));
  });

  await t.test('after assistant content closes the window, a stdout echo renders', async () => {
    const { root, Conversation } = await setupDOM();
    const conv = new Conversation(root);
    apply(conv, { kind: 'compaction', trigger: 'auto', preTokens: 5, postTokens: 1, durationMs: 1 });
    apply(conv, { kind: 'text_delta', msgId: 'm1', blockIdx: 0, text: 'continuing' });
    apply(conv, stdoutEcho);
    assert.equal(root.querySelectorAll('.msg.user').length, 1, 'the echo is an ordinary user bubble now');
  });

  await t.test('any other echo ends the window', async () => {
    const { root, Conversation } = await setupDOM();
    const conv = new Conversation(root);
    apply(conv, { kind: 'compaction', trigger: 'auto', preTokens: 5, postTokens: 1, durationMs: 1 });
    apply(conv, { kind: 'user_echo', text: 'next prompt' });
    apply(conv, stdoutEcho);
    assert.equal(root.querySelectorAll('.msg.user').length, 2);
  });
});

test('a summary seen without its boundary reads as a completed compaction', async () => {
  const { root, Conversation, replayPersistedLine } = await setupDOM();
  const conv = new Conversation(root);
  const summaryLine = (await readJsonl('compaction-manual.transcript.jsonl')).find((l) => l.isCompactSummary === true);
  for (const ev of replayPersistedLine(summaryLine)) apply(conv, ev);

  assert.equal(root.querySelectorAll('.msg.compaction').length, 1);
  assert.deepEqual(labelsOf(root), ['Context compacted'], 'completed label, no trigger or token segments, never the running one');
  assert.ok(root.querySelector('details.block.compaction'), 'the summary is still folded into the bubble');
});

test('a repeated `status: compacting` reuses the running bubble', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  const parser = new Parser();
  const frames = await readJsonl('compaction-manual.stdout.jsonl');
  feedFrames(conv, parser, [frames[0], frames[0]]);
  assert.equal(root.querySelectorAll('.msg.compaction').length, 1, 'the second status opens no second bubble');

  feedFrames(conv, parser, frames.slice(1, 4)); // compact_result, init, boundary
  assert.equal(root.querySelectorAll('.msg.compaction').length, 1);
  assert.deepEqual(labelsOf(root), [MANUAL_LABEL], 'the one bubble is completed by the boundary');
});

test('a process end closes a compaction that never reached its boundary', async (t) => {
  const ends = [
    ['exit', { kind: 'system', subtype: 'exit', data: { code: 1, signal: null } }],
    ['crashed', { kind: 'system', subtype: 'crashed', data: { message: 'boom' } }],
  ];
  for (const [name, end] of ends) {
    await t.test(name, async () => {
      const { root, Conversation } = await setupDOM();
      const conv = new Conversation(root);
      apply(conv, { kind: 'system', subtype: 'status', data: { status: 'compacting' } });
      assert.deepEqual(labelsOf(root), ['Compacting context…']);

      apply(conv, end);
      assert.deepEqual(labelsOf(root), ['Compaction did not complete']);
      apply(conv, { kind: 'system', subtype: 'init', data: { model: 'm', session_id: 'abcdef123456' } });
      assert.deepEqual(subtypesOf(root), [name, 'init'], 'a later init is shown, not suppressed');
    });
  }
});
