// get_recent_messages' reconstruction of narration (src/mcp/messageReconstruction.ts),
// arm by arm: the reconciled arm classifies the envelopes by BLOCK INDEX, the
// delta arm reads the parser's flag, and the delta accumulation backs the
// reconciled arm when it finds nothing. The real capture under
// tests/fixtures/narration/ drives the arm tests; the ring shapes it cannot
// produce (a dropped middle envelope, a narration-only slice) are built here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from '../src/parser.ts';
import { EventLog } from '../src/instances.ts';
import { reconstructMessages, bondTrailingTurn, ringTurnIndex } from '../src/mcp/messageReconstruction.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NARRATION_MSG = 'msg_011Cg4aZkEcqTrXhBFw7EJnj';
const NARRATION_TEXT = "This is fixable: I'll have the server save the instruction text (not the cut-off frame) as the session's first-prompt preview when the first prompt is a forward, update `readablePrompt`/`promptPreview` to show its first line (falling back to \"Forwarded worker output\" when missing), and adjust the related tests and docs—also noting that generic instruction openers should be replaced with role lines so titles stay meaningful.";

async function liveEvents() {
  const lines = (await fs.readFile(path.join(__dirname, 'fixtures', 'narration', 'claude-narration.stdout.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  const parser = new Parser();
  return lines.flatMap(l => parser.handleObject(l));
}

// The instance ring over `events` (one fresh object per push, as emitted).
function ring(events) {
  const log = new EventLog({ cap: 100000 });
  for (const ev of events) log.push({ ...ev });
  return log.buf;
}

const messageOf = (r, msgId = NARRATION_MSG) => reconstructMessages(r, false).find(m => m.msgId === msgId);
const isFlagged = (e) => e.kind === 'thinking_delta' && e.narration === true;

test('reconciled arm alone: with the flagged deltas gone, the envelopes still yield the narration in arrival position', async () => {
  const events = (await liveEvents()).filter(e => !isFlagged(e));
  assert.ok(events.some(e => e.kind === 'assistant_message' && e.msgId === NARRATION_MSG), 'fixture check: the envelopes stay');
  const m = messageOf(ring(events));
  assert.equal(m.narration, NARRATION_TEXT);
  assert.equal(m.narrationSeq, 0, 'positioned by the reconciled pass, not the -1 fallback pin');
});

test('never-regress: when the envelopes yield no narration, the flagged deltas supply it, pinned first', async () => {
  // The redacted predecessor's envelope is gone, so the reconciled pass sees no
  // block before the narration block's envelope.
  const events = (await liveEvents()).filter(e => !(e.kind === 'assistant_message' && e.msgId === NARRATION_MSG && e.blockIdx === 0));
  assert.ok(events.some(isFlagged), 'fixture check: the flagged deltas stay');
  const m = messageOf(ring(events));
  assert.equal(m.narration, NARRATION_TEXT);
  assert.equal(m.narrationSeq, -1);
});

// Envelopes as the parser stamps them: msgId 'm', `blockIdx` = message index.
const envelope = (blockIdx, block, seq) => ({ kind: 'assistant_message', msgId: 'm', blockIdx, message: { id: 'm', content: [block] }, parentToolUseId: null, _seq: seq });
const REDACTED = { type: 'thinking', thinking: '', signature: 'sig' };
const THOUGHT = { type: 'thinking', thinking: 'a later thought', signature: 'sig' };

test('reconciled adjacency is by block index: a thought across a dropped envelope is not narration', async (t) => {
  await t.test('control: redacted@0 then thought@1 is narration', () => {
    assert.equal(messageOf(ring([envelope(0, REDACTED, 0), envelope(1, THOUGHT, 1)]), 'm').narration, 'a later thought');
  });
  await t.test('redacted@0, block 1 dropped, thought@2', () => {
    const m = messageOf(ring([envelope(0, REDACTED, 0), envelope(2, THOUGHT, 1), envelope(3, { type: 'tool_use', id: 't', name: 'Bash', input: {} }, 2)]), 'm');
    assert.equal(m.narration, undefined);
  });
  await t.test('the live parser agrees: a thought after a text block at idx 1 carries no flag', () => {
    const se = (event) => ({ type: 'stream_event', event });
    const p = new Parser();
    const frames = [
      se({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      se({ type: 'content_block_stop', index: 0 }),
      se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } }),
      se({ type: 'content_block_stop', index: 1 }),
      se({ type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } }),
      se({ type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'a later thought' } }),
    ];
    assert.equal(frames.flatMap(f => p.handleObject(f)).filter(isFlagged).length, 0);
  });
});

test('a message whose only retained event is a flagged narration delta is still reconstructed', () => {
  const r = [{ kind: 'thinking_delta', msgId: 'm', blockIdx: 1, text: 'Checking the parser next.', narration: true, parentToolUseId: null, _seq: 7 }];
  assert.deepEqual(reconstructMessages(r, false).map(m => [m.msgId, m.text, m.narration]), [['m', '', 'Checking the parser next.']]);
});

test('bonding: a narration-only last message counts as prose and bonds back to its turn\'s plan', () => {
  const r = [
    { kind: 'tool_use', msgId: 'mPlan', blockIdx: 0, toolUseId: 'tp', name: 'ExitPlanMode', input: { plan: 'PLAN-BODY' }, parentToolUseId: null, _seq: 0 },
    { kind: 'thinking_delta', msgId: 'mNote', blockIdx: 1, text: 'Waiting for approval.', narration: true, parentToolUseId: null, _seq: 1 },
  ];
  const messages = reconstructMessages(r, false);
  assert.deepEqual(messages.map(m => m.msgId), ['mPlan', 'mNote'], 'fixture check: two messages, the last narration-only');
  assert.deepEqual(bondTrailingTurn(messages, ringTurnIndex(r)).map(m => m.msgId), ['mPlan', 'mNote']);
});

// One envelope carrying several blocks (the legacy CLI shape): each block's
// message index is the envelope's blockIdx plus its position in the envelope.
const multiEnvelope = (content, extra = {}) => ({ kind: 'assistant_message', msgId: 'm', blockIdx: 0, message: { id: 'm', content }, parentToolUseId: null, _seq: 0, ...extra });

test('a multi-block envelope: blocks are adjacent by their position inside it', async (t) => {
  await t.test('[redacted, thought] in one envelope is narration', () => {
    assert.equal(messageOf(ring([multiEnvelope([REDACTED, THOUGHT])]), 'm').narration, 'a later thought');
  });
  await t.test('control: [thought, thought] in one envelope is not', () => {
    const m = messageOf(ring([multiEnvelope([{ ...THOUGHT, thinking: 'pondering' }, THOUGHT, { type: 'text', text: 'done' }])]), 'm');
    assert.equal(m.text, 'done', 'fixture check: the message reconstructs');
    assert.equal(m.narration, undefined);
  });
});

test('an envelope with no numeric blockIdx gets no reconciled verdict; only the flagged deltas can supply narration', async (t) => {
  const NOTE = { type: 'thinking', thinking: 'a note', signature: 'sig' };
  const content = [NOTE, { type: 'tool_use', id: 't', name: 'Bash', input: {} }, REDACTED];
  for (const [label, extra] of [['blockIdx missing', { blockIdx: undefined }], ['blockIdx NaN', { blockIdx: NaN }]]) {
    await t.test(`${label}: no narration from the envelope`, () => {
      const m = messageOf(ring([multiEnvelope(content, extra)]), 'm');
      assert.equal(m.hasToolUse, true, 'fixture check: the envelope is read');
      assert.equal(m.narration, undefined);
    });
  }
  await t.test('blockIdx missing: the flagged deltas still supply it, pinned first', () => {
    const m = messageOf(ring([
      { kind: 'thinking_delta', msgId: 'm', blockIdx: 1, text: 'the flagged note', narration: true, parentToolUseId: null },
      multiEnvelope([REDACTED, { ...THOUGHT, thinking: 'the flagged note' }], { blockIdx: undefined }),
    ]), 'm');
    assert.equal(m.narration, 'the flagged note');
    assert.equal(m.narrationSeq, -1);
  });
});
