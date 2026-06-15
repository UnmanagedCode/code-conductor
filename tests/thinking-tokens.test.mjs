import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stub Web Audio + fetch before importing blocks.js (which pulls in tts.js).
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

const blocksUrl = pathToFileURL(path.resolve(__dirname, '..', 'public', 'blocks.js')).href;
const convUrl   = pathToFileURL(path.resolve(__dirname, '..', 'public', 'conversation.js')).href;

const { ThinkingBlock } = await import(blocksUrl);
const { Conversation }  = await import(convUrl);

function setupDOM() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.window.AudioContext = globalThis.AudioContext;
}

// ── ThinkingBlock unit tests ─────────────────────────────────────────────────

test('ThinkingBlock: initial summary is "thinking"', () => {
  setupDOM();
  const block = new ThinkingBlock();
  const summary = block.node.querySelector('summary');
  assert.equal(summary.textContent, 'thinking');
});

test('ThinkingBlock: updateThinkingTokens updates summary live', () => {
  setupDOM();
  const block = new ThinkingBlock();
  block.updateThinkingTokens(1234);
  const summary = block.node.querySelector('summary');
  assert.equal(summary.textContent, 'thinking… 1,234 tokens');
});

test('ThinkingBlock: finalize after tokens shows char count (not token count)', () => {
  setupDOM();
  const block = new ThinkingBlock();
  block.updateThinkingTokens(500);
  block.appendDelta('hello world');
  block.finalize();
  const summary = block.node.querySelector('summary');
  assert.equal(summary.textContent, 'thinking (11 chars)');
});

test('ThinkingBlock: markRedacted with no tokens shows plain label', () => {
  setupDOM();
  const block = new ThinkingBlock();
  block.markRedacted();
  assert.equal(block.node.textContent, 'thinking (redacted)');
});

test('ThinkingBlock: markRedacted after tokens shows token count', () => {
  setupDOM();
  const block = new ThinkingBlock();
  block.updateThinkingTokens(1200);
  block.markRedacted();
  assert.equal(block.node.textContent, 'thinking (redacted, ~1,200 tokens)');
});

test('ThinkingBlock: updateThinkingTokens no-ops after markRedacted', () => {
  setupDOM();
  const block = new ThinkingBlock();
  block.markRedacted();
  block.updateThinkingTokens(999); // should be ignored for summary
  // The flat node text was set at markRedacted time; verify it wasn't changed
  assert.equal(block.node.textContent, 'thinking (redacted)');
});

test('ThinkingBlock: finalize after markRedacted is a no-op', () => {
  setupDOM();
  const block = new ThinkingBlock();
  block.updateThinkingTokens(500);
  block.markRedacted();
  block.finalize(); // should be no-op per redacted guard
  assert.equal(block.node.textContent, 'thinking (redacted, ~500 tokens)');
});

// ── Conversation integration tests ───────────────────────────────────────────

function makeConv() {
  const root = document.createElement('div');
  return new Conversation(root);
}

function thinkingTokensEv(n) {
  return {
    kind: 'system',
    subtype: 'thinking_tokens',
    _seq: Math.floor(Math.random() * 1e9),
    data: { estimated_tokens: n, estimated_tokens_delta: n },
  };
}

test('Conversation: thinking_tokens updates active ThinkingBlock summary', () => {
  setupDOM();
  const conv = makeConv();
  const msgId = 'msg_test1';

  conv.apply({ kind: 'thinking_start', msgId, blockIdx: 0, _seq: 1 });
  conv.apply({ ...thinkingTokensEv(750), _seq: 2 });

  const block = conv.blocksByKey.get(`${msgId}:0:thinking`);
  assert.ok(block, 'ThinkingBlock should exist');
  const summary = block.node.querySelector('summary');
  assert.equal(summary.textContent, 'thinking… 750 tokens');
});

test('Conversation: thinking_tokens updates are cumulative (last value wins)', () => {
  setupDOM();
  const conv = makeConv();
  const msgId = 'msg_test2';

  conv.apply({ kind: 'thinking_start', msgId, blockIdx: 0, _seq: 1 });
  conv.apply({ ...thinkingTokensEv(100), _seq: 2 });
  conv.apply({ ...thinkingTokensEv(350), _seq: 3 });
  conv.apply({ ...thinkingTokensEv(750), _seq: 4 });

  const block = conv.blocksByKey.get(`${msgId}:0:thinking`);
  const summary = block.node.querySelector('summary');
  assert.equal(summary.textContent, 'thinking… 750 tokens');
});

test('Conversation: active key cleared after thinking_end', () => {
  setupDOM();
  const conv = makeConv();
  const msgId = 'msg_test3';

  conv.apply({ kind: 'thinking_start', msgId, blockIdx: 0, _seq: 1 });
  assert.ok(conv._activeThinkingKey, 'key should be set after thinking_start');
  conv.apply({ kind: 'thinking_delta', msgId, blockIdx: 0, text: 'hi', _seq: 2 });
  conv.apply({ kind: 'thinking_end', msgId, blockIdx: 0, _seq: 3 });
  assert.equal(conv._activeThinkingKey, null, 'key should be cleared after thinking_end');

  // A stray thinking_tokens event after end should be silently ignored
  assert.doesNotThrow(() => conv.apply({ ...thinkingTokensEv(99), _seq: 4 }));
});

test('Conversation: non-redacted block finalizes with char count after tokens streamed', () => {
  setupDOM();
  const conv = makeConv();
  const msgId = 'msg_test4';

  conv.apply({ kind: 'thinking_start', msgId, blockIdx: 0, _seq: 1 });
  conv.apply({ ...thinkingTokensEv(300), _seq: 2 });
  conv.apply({ kind: 'thinking_delta', msgId, blockIdx: 0, text: 'because reasons', _seq: 3 });
  conv.apply({ kind: 'thinking_end', msgId, blockIdx: 0, _seq: 4 });

  const block = conv.blocksByKey.get(`${msgId}:0:thinking`);
  const summary = block.node.querySelector('summary');
  assert.equal(summary.textContent, 'thinking (15 chars)');
});

test('Conversation: redacted path — token count appears in final label', () => {
  setupDOM();
  const conv = makeConv();
  const msgId = 'msg_test5';

  conv.apply({ kind: 'thinking_start', msgId, blockIdx: 0, _seq: 1 });
  conv.apply({ ...thinkingTokensEv(800), _seq: 2 });
  conv.apply({ kind: 'thinking_redacted', msgId, blockIdx: 0, _seq: 3 });
  conv.apply({ kind: 'thinking_end', msgId, blockIdx: 0, _seq: 4 });

  const block = conv.blocksByKey.get(`${msgId}:0:thinking`);
  assert.equal(block.node.textContent, 'thinking (redacted, ~800 tokens)');
});

test('Conversation: redacted path — no tokens gives plain label', () => {
  setupDOM();
  const conv = makeConv();
  const msgId = 'msg_test6';

  conv.apply({ kind: 'thinking_start', msgId, blockIdx: 0, _seq: 1 });
  // no thinking_tokens events
  conv.apply({ kind: 'thinking_redacted', msgId, blockIdx: 0, _seq: 2 });
  conv.apply({ kind: 'thinking_end', msgId, blockIdx: 0, _seq: 3 });

  const block = conv.blocksByKey.get(`${msgId}:0:thinking`);
  assert.equal(block.node.textContent, 'thinking (redacted)');
});
