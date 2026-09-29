// DOM tests for the compaction bubble, driving the real src/parser.ts,
// src/transcript.ts replay and public/conversation.js under happy-dom.
//
// Fixtures: `compaction-manual.stdout.jsonl` / `compaction-manual.transcript.jsonl`
// are committed trims of one real CLI 2.1.284 capture of a manual `/compact`
// (structural fields verbatim; the init frame's long arrays shortened, paths
// scrubbed). The auto case is DERIVED from them by changing only `trigger` and
// dropping the `/compact` echo and stdout: the auto frame order is assumed from
// the CLI's shared boundary builder, not captured.

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

// The ring order: cc's own `_trackModel` emits `model_changed` just before the re-init.
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
  conv._replayMode = true;
  for (const line of await readJsonl('compaction-manual.transcript.jsonl')) {
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

test('auto trigger: one bubble, the header names auto, and no user bubbles', async () => {
  const { root, Parser, Conversation } = await setupDOM();
  const conv = new Conversation(root);
  const frames = (await readJsonl('compaction-manual.stdout.jsonl'))
    // Auto has no `/compact` echo and no command output: drop the stdout line.
    .filter((f) => !(f.type === 'user' && String(f.message?.content).includes('<local-command-stdout>')))
    .map((f) => (f.subtype === 'compact_boundary'
      ? { ...f, compact_metadata: { ...f.compact_metadata, trigger: 'auto' } }
      : f));
  feedFrames(conv, new Parser(), frames);

  assert.deepEqual(labelsOf(root), [`Context compacted · auto · ${N(27152)} → ${N(2952)} tokens`]);
  assert.equal(root.querySelectorAll('.msg.user').length, 0);
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
