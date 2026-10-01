// The client half of background-task notifications: a notified
// `system`/`task_notification` event (src/taskNotification.ts) renders as one
// folded system line — name · status · exit code — amber when the task failed,
// with the summary and output path inside the fold. Every event here comes from
// the real fixtures (see tests/task-notification.test.mjs for their provenance)
// through the real Parser or loadPersistedTranscript.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { Parser } from '../src/parser.ts';
import { loadPersistedTranscript } from '../src/transcript.ts';
import { localPlace } from '../src/projects.ts';
import { freshProjectsRoot, seedSessionJsonl, rmrf } from './helpers.mjs';
import { assertNull } from './dom-assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');
const FX = path.join(__dirname, 'fixtures');
const readJsonl = async (name) =>
  (await fs.readFile(path.join(FX, name), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

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

const C1 = 'toolu_018MKm8vtqnn6GpMTLzD3Ncu';
const C2 = 'toolu_014Qe3SFHbVz97n6YPVbuEzp';
const C6 = 'toolu_01D5PcgfmdTg99S49iVFZDfV';
const C7 = 'toolu_012VgSmvzUktTsW7SkbfpLHq';

async function liveEvents() {
  const parser = new Parser();
  return (await readJsonl('task-notification.stdout.jsonl')).flatMap((f) => parser.handleObject(f));
}
const tnFor = (events, tu) => events.find((e) => e.kind === 'system' && e.subtype === 'task_notification' && e.toolUseId === tu);

function render(Conversation, events) {
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  for (const ev of events) conv.apply(ev);
  return root;
}
const lines = (root) => [...root.querySelectorAll('details.block.system')].filter((n) => n.querySelector('.subtype')?.textContent === 'task_notification');
const headline = (node) => node.querySelector('summary').textContent;

test('U1: shouldRenderSystem shows a notified event and hides a foreground one', async () => {
  setupDOM();
  const { shouldRenderSystem } = await importPublic();
  const evs = await liveEvents();
  assert.equal(shouldRenderSystem(tnFor(evs, C1)), true);
  assert.equal(shouldRenderSystem(tnFor(evs, C7)), false);
});

test('U2: a completed task renders a dim line naming the task, its status and exit code', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const [node] = lines(render(Conversation, [tnFor(await liveEvents(), C1)]));
  assert.ok(node, 'one task line');
  assert.equal(node.classList.contains('warn'), false, 'a completed task is not amber');
  const h = headline(node);
  assert.ok(h.includes('bg ok') && h.includes('completed') && h.includes('exit 0'), `headline: ${h}`);
});

test('U3: a failed task renders amber', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const [node] = lines(render(Conversation, [tnFor(await liveEvents(), C2)]));
  assert.ok(node.classList.contains('warn'));
  assert.ok(headline(node).includes('exit 3'));
});

test('U4: the summary and the output path sit inside the closed fold, not on its line', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const ev = tnFor(await liveEvents(), C1);
  const [node] = lines(render(Conversation, [ev]));
  assert.equal(node.open, false, 'folded by default');
  const body = node.querySelector('.task-notification-body');
  assert.ok(body.textContent.includes(ev.data.summary), 'summary in the body');
  assert.ok(body.textContent.includes(ev.data.output_file), 'output path in the body');
  assert.equal(headline(node).includes(ev.data.output_file), false, 'output path not on the line');
  assert.equal(headline(node).includes(ev.data.summary), false, 'summary not on the line');
});

test('U5: an Agent task\'s line carries no exit code', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const [node] = lines(render(Conversation, [tnFor(await liveEvents(), C6)]));
  const h = headline(node);
  assert.ok(h.includes('bg agent') && h.includes('completed'), `headline: ${h}`);
  assert.equal(h.includes('exit'), false);
});

const EXPECTED_HEADLINES = ['bg ok · completed · exit 0', 'bg fail · failed · exit 3', 'bg agent · completed', 'ls / 2>&1 | head -3 · completed · exit 0'];

test('U6: the live stream renders one line per background task', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const root = render(Conversation, await liveEvents());
  assert.deepEqual(lines(root).map((n) => headline(n).replace(/^task_notification\s*/, '')), EXPECTED_HEADLINES);
});

test('U7: a reload renders the same lines in the same order', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const { home } = await freshProjectsRoot();
  try {
    const place = localPlace('/workspace/project');
    const sid = '20594e65-2dd2-4118-83e5-7dd5d36ab56f';
    await seedSessionJsonl(place, sid, await readJsonl('task-notification.transcript.jsonl'));
    const result = await loadPersistedTranscript({ place, sessionId: sid, seqHint: 0 });
    const root = render(Conversation, result.lines.flatMap((l) => l.events));
    assert.deepEqual(lines(root).map((n) => headline(n).replace(/^task_notification\s*/, '')), EXPECTED_HEADLINES);
  } finally {
    await rmrf(home);
  }
});

// A notification can land between a tool_use and its tool_result. It is not a
// run-ender, so the open machinery group stays open and the result reaches its tool.
test('U8: a notification between a tool_use and its tool_result does not close the action group', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const root = document.createElement('div');
  const conv = new Conversation(root, {});
  conv.apply({ kind: 'message_start', msgId: 'm1' });
  conv.apply({ kind: 'tool_use_start', msgId: 'm1', blockIdx: 0, toolUseId: 'tuR', name: 'Read' });
  conv.apply({ kind: 'tool_use', msgId: 'm1', blockIdx: 0, toolUseId: 'tuR', name: 'Read', input: {} });
  conv.apply(tnFor(await liveEvents(), C1));
  const group = root.querySelector('details.action-group');
  assert.ok(group, 'the tool opened an action group');
  assert.equal(group.open, true, 'the notification did not close the group');
  conv.apply({ kind: 'tool_result', toolUseId: 'tuR', content: 'RESULT-MARK', isError: false });
  assert.ok(group.textContent.includes('RESULT-MARK'), 'the result attached to its tool inside the group');
  assert.equal(lines(root).length, 1, 'and the notification rendered');
});

test('U9: a foreground task renders nothing', async () => {
  setupDOM();
  const { Conversation } = await importPublic();
  const root = render(Conversation, [tnFor(await liveEvents(), C7)]);
  assertNull(root.querySelector('.block.system'), 'no system block for a foreground Agent');
});
