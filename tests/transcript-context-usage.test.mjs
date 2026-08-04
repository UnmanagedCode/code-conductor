// Seeding the ctx readout from jsonl replay (card 2026-0026).
//
// The ctx chip is fed ONLY by `message_start.usage`, and the replay path emits
// no `message_start` — so a resumed/respawned/rewound session read `ctx —`
// until its first live turn. loadPersistedTranscript now latches the newest
// assistant line's usage as `lastAssistantUsage`, which loadHistory replays as
// one synthetic, non-retained `message_start`.
//
// Two things this file pins:
//   1. the scan's hazards — `<synthetic>` all-zero placeholders (frequently the
//      LAST assistant line of an interrupted session) and sub-agent sidechain
//      lines (a different context window) must never win.
//   2. the renderer invariant — the synthetic event must leave a subscribed
//      client's conversation completely unchanged. `conversation.apply` has no
//      `message_start` case, but it does run `_ensureNotEmpty()` first, so
//      "probably ignored" is not good enough to rely on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { encodeCwd } from '../src/projects.ts';
import { loadPersistedTranscript } from '../src/transcript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CWD = '/tmp/ctx-usage-project';
const SID = 'sess-ctx-usage';

// Real observed Claude shape: `input_tokens` is ~2, the bulk sits in
// cache_read, and the per-call prompt total is the sum of all three.
const usage = (n, extra = {}) => ({
  input_tokens: 2, cache_read_input_tokens: n - 2, cache_creation_input_tokens: 0,
  output_tokens: 500, ...extra,
});
// The CLI's API-error / interrupt placeholder: every token field zero.
const SYNTHETIC_USAGE = {
  input_tokens: 0, output_tokens: 0,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
};

const assistantLine = (uuid, id, model, u, content = [{ type: 'text', text: 'hi' }]) =>
  ({ type: 'assistant', uuid, message: { id, role: 'assistant', model, content, usage: u } });

async function seed(lines) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ctx-usage-'));
  process.env.CLAUDE_PROJECTS_ROOT = rootDir;
  const file = path.join(rootDir, encodeCwd(CWD), `${SID}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return loadPersistedTranscript({ cwd: CWD, sessionId: SID });
}

// ── the scan ────────────────────────────────────────────────────────────────

test('lastAssistantUsage: the newest assistant line wins, with its msgId', async () => {
  const result = await seed([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } },
    assistantLine('a0', 'm_old', 'claude-opus-5', usage(38202)),
    assistantLine('a1', 'm_new', 'claude-opus-5', usage(46398)),
  ]);
  assert.deepEqual(result.lastAssistantUsage, { msgId: 'm_new', usage: usage(46398) });
});

test('lastAssistantUsage: a trailing <synthetic> all-zero line does not clobber a good reading', async () => {
  // The hazard that would have shipped as `ctx 0 · 0%`: an interrupted session
  // ends with the CLI's synthetic placeholder, so naive last-wins seeds zero.
  const result = await seed([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } },
    assistantLine('a0', 'm_real', 'claude-opus-5', usage(79167)),
    assistantLine('a1', 'm_syn', '<synthetic>', SYNTHETIC_USAGE,
      [{ type: 'text', text: 'API Error: Connection error.' }]),
  ]);
  assert.deepEqual(result.lastAssistantUsage, { msgId: 'm_real', usage: usage(79167) },
    'the real reading survives the synthetic tail');
});

test('lastAssistantUsage: <synthetic> is rejected on the marker, not merely on its zero values', async () => {
  // Every synthetic line in the observed corpus is all-zero, so the zero floor
  // below would shadow the marker check and leave it untested. The marker is
  // kept as read-time tolerance for a format we don't own (the CLI's jsonl —
  // the documented exception to the no-back-compat rule): a synthetic line is
  // not real model output, so its usage must not count whatever it holds. Same
  // predicate readLastSessionModel applies to the same file.
  const result = await seed([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } },
    assistantLine('a0', 'm_real', 'claude-opus-5', usage(50000)),
    assistantLine('a1', 'm_syn', '<synthetic>', usage(999999)),
  ]);
  assert.deepEqual(result.lastAssistantUsage, { msgId: 'm_real', usage: usage(50000) });
});

test('lastAssistantUsage: a zero-prompt usage block is skipped even without the <synthetic> marker', async () => {
  const result = await seed([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } },
    assistantLine('a0', 'm_real', 'claude-opus-5', usage(1234)),
    assistantLine('a1', 'm_zero', 'claude-opus-5', SYNTHETIC_USAGE),
  ]);
  assert.equal(result.lastAssistantUsage.msgId, 'm_real');
});

test('lastAssistantUsage: sidechain lines never contribute — a sub-agent is a different window', async () => {
  const result = await seed([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } },
    assistantLine('a0', 'm_outer', 'claude-opus-5', usage(60000)),
    { ...assistantLine('a1', 'm_sub', 'claude-opus-5', usage(900000)), isSidechain: true },
  ]);
  assert.deepEqual(result.lastAssistantUsage, { msgId: 'm_outer', usage: usage(60000) },
    'the sub-agent prompt size must not become the session reading');
});

test('lastAssistantUsage: null when the jsonl carries no usable assistant usage', async () => {
  const withoutAssistant = await seed([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } },
  ]);
  assert.equal(withoutAssistant.lastAssistantUsage, null);

  const onlySynthetic = await seed([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } },
    assistantLine('a0', 'm_syn', '<synthetic>', SYNTHETIC_USAGE),
  ]);
  assert.equal(onlySynthetic.lastAssistantUsage, null);
});

test('lastAssistantUsage: non-Claude backends carry the whole prompt in input_tokens', async () => {
  // Substitution backends report no cache fields at all, so the prompt total is
  // input_tokens alone — and they report the model BARE (`glm-5.2`, never
  // `glm-5.2:cloud`), which is why loadHistory omits `model` from the replayed
  // event and lets the instance's tagged model own the window denominator.
  const result = await seed([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } },
    assistantLine('a0', 'm_glm', 'glm-5.2', { input_tokens: 34892, output_tokens: 0 }),
  ]);
  assert.deepEqual(result.lastAssistantUsage,
    { msgId: 'm_glm', usage: { input_tokens: 34892, output_tokens: 0 } });
});

// ── the renderer invariant ──────────────────────────────────────────────────

globalThis.AudioContext = class MockAudioContext {
  constructor() { this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createBufferSource() { return { connect() {}, start() {}, onended: null, buffer: null }; }
  decodeAudioData() { return Promise.resolve({ duration: 0.5 }); }
};
globalThis.fetch = async () => ({
  ok: true,
  body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
});

const convUrl = pathToFileURL(path.resolve(__dirname, '..', 'public', 'conversation.js')).href;
const { Conversation } = await import(convUrl);

function freshConversation() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.window.AudioContext = globalThis.AudioContext;
  const root = window.document.createElement('div');
  window.document.body.appendChild(root);
  return new Conversation(root);
}

test('the replayed message_start leaves a subscribed client conversation completely unchanged', async () => {
  const conv = freshConversation();
  // Replay real history first — this is the production order: loadHistory only
  // emits the synthetic event inside `replayedCount > 0`, i.e. after at least
  // one real replayed event has already reached the client.
  conv.apply({ kind: 'user_echo', text: 'go', userIndex: 0, parentToolUseId: null });
  conv.apply({ kind: 'text_delta', msgId: 'm_new', blockIdx: 0, text: 'an answer', parentToolUseId: null });
  conv.apply({ kind: 'text_end', msgId: 'm_new', blockIdx: 0, parentToolUseId: null });

  const before = {
    html: conv.root.innerHTML,
    blocks: conv.blocksByKey.size,
    wraps: conv.messageWraps.size,
    reconcile: conv.reconcileCounts.size,
    seenSeq: conv.seenSeq.size,
    empty: conv.emptyNode,
  };

  // The synthetic event, exactly as loadHistory emits it — note it reuses the
  // REAL msgId whose text block was just replayed, so this also pins that the
  // msgId cannot reopen, duplicate or attach to that block.
  conv.apply({
    kind: 'message_start', msgId: 'm_new',
    usage: usage(46398), replayed: true, parentToolUseId: null,
  });

  assert.equal(conv.root.innerHTML, before.html, 'DOM is byte-identical');
  assert.equal(conv.blocksByKey.size, before.blocks, 'no new block registered');
  assert.equal(conv.messageWraps.size, before.wraps, 'no new assistant wrap opened');
  assert.equal(conv.reconcileCounts.size, before.reconcile, 'reconcile cursor untouched');
  assert.equal(conv.seenSeq.size, before.seenSeq, 'seq-less, so it consumes no dedup slot');
  assert.equal(conv.emptyNode, before.empty, 'empty-state placeholder state unchanged');
  assert.equal(conv.root.querySelectorAll('.msg.assistant').length, 1,
    'still exactly one assistant bubble — no empty/spurious block');
});

test('the empty-state placeholder survives: the event is never the first thing a client sees', async () => {
  // The one renderer surface `message_start` does touch is `_ensureNotEmpty()`.
  // loadHistory's `replayedCount > 0` guard is what keeps that harmless, so pin
  // the consequence: on a conversation that HAS content the placeholder is
  // already gone, and the server never emits the event in the other case (see
  // the ws.test.mjs coverage for the guard itself).
  const conv = freshConversation();
  assert.ok(conv.emptyNode, 'fresh conversation shows the placeholder');
  conv.apply({ kind: 'user_echo', text: 'go', userIndex: 0, parentToolUseId: null });
  assert.equal(conv.emptyNode, null, 'real replayed content clears it first');
});
