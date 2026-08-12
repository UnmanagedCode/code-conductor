// Soft-interrupt steer is hidden everywhere it could surface: the live
// parser, the transcript replay, and the rewind/fork prompt-counter. The
// CLI persists the injected prompt either as a `type:"user"` line or (when
// received mid-turn) a `type:"attachment"` queued_command line — both shapes
// must be recognised by the SOFT_INTERRUPT_MARKER and dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser, SOFT_INTERRUPT_MARKER, isSoftInterruptContent, isInterruptMarkerContent } from '../src/parser.ts';
import { replayPersistedLine, isPureUserPromptLine } from '../src/transcript.ts';

const STEER = `${SOFT_INTERRUPT_MARKER}\nStop all work and end your turn now.`;

function userLine(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}
function queuedCmdLine(text) {
  return { type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text }] } };
}

test('isSoftInterruptContent detects the marker in string + array shapes', () => {
  assert.equal(isSoftInterruptContent(STEER), true);
  assert.equal(isSoftInterruptContent([{ type: 'text', text: STEER }]), true);
  assert.equal(isSoftInterruptContent('hello world'), false);
  assert.equal(isSoftInterruptContent([{ type: 'text', text: 'hello' }]), false);
  assert.equal(isSoftInterruptContent(undefined), false);
});

test('live parser emits soft_interrupted system event for a soft-interrupt steer (no user bubble)', () => {
  const p = new Parser();
  const evs = p.handleObject(userLine(STEER));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'system');
  assert.equal(evs[0].subtype, 'soft_interrupted');
  // Must not bubble as a user_echo.
  assert.equal(evs.filter(e => e.kind === 'user_echo').length, 0);
  // A normal user message still produces a user_echo.
  const normal = new Parser().handleObject(userLine('real prompt'));
  assert.equal(normal.filter(e => e.kind === 'user_echo').length, 1);
});

test('replay drops the steer from both persisted shapes, keeps real prompts', () => {
  assert.deepEqual(replayPersistedLine(userLine(STEER)).filter(e => e.kind === 'user_echo'), []);
  assert.deepEqual(replayPersistedLine(queuedCmdLine(STEER)).filter(e => e.kind === 'user_echo'), []);
  assert.equal(replayPersistedLine(userLine('real')).filter(e => e.kind === 'user_echo').length, 1);
  assert.equal(replayPersistedLine(queuedCmdLine('real')).filter(e => e.kind === 'user_echo').length, 1);
});

test('prompt-counter excludes the steer so rewind/fork indices stay aligned', () => {
  assert.equal(isPureUserPromptLine(userLine(STEER)), false);
  assert.equal(isPureUserPromptLine(queuedCmdLine(STEER)), false);
  assert.equal(isPureUserPromptLine(userLine('real')), true);
  assert.equal(isPureUserPromptLine(queuedCmdLine('real')), true);
});

// The CLI's own post-abort marker line — now produced by every ⏸ as well as
// every ⏹ — is filtered at the same three sites, by shape rather than a marker.
const MARKERS = ['[Request interrupted by user]', '[Request interrupted by user for tool use]'];

test('isInterruptMarkerContent matches both variants, only as a lone text block', () => {
  for (const m of MARKERS) {
    assert.equal(isInterruptMarkerContent(m), true, m);
    assert.equal(isInterruptMarkerContent([{ type: 'text', text: m }]), true, m);
    assert.equal(isInterruptMarkerContent([{ type: 'text', text: `\n${m}\n` }]), true, 'surrounding whitespace');
  }
  // Not a marker: quoted mid-answer, extra blocks, or a different phrase.
  assert.equal(isInterruptMarkerContent('see [Request interrupted by user] above'), false);
  assert.equal(isInterruptMarkerContent([
    { type: 'text', text: MARKERS[0] }, { type: 'text', text: 'and more' },
  ]), false);
  assert.equal(isInterruptMarkerContent('[Request interrupted]'), false);
  assert.equal(isInterruptMarkerContent(undefined), false);
});

test('the interrupt marker renders as a soft_interrupted annotation everywhere, never a prompt', () => {
  for (const m of MARKERS) {
    const evs = new Parser().handleObject(userLine(m));
    assert.deepEqual(evs.map(e => `${e.kind}/${e.subtype}`), ['system/soft_interrupted'], m);

    const replayed = replayPersistedLine(userLine(m));
    assert.deepEqual(replayed.map(e => `${e.kind}/${e.subtype}`), ['system/soft_interrupted'], m);
    assert.equal(replayed.filter(e => e.kind === 'user_echo').length, 0);

    assert.equal(isPureUserPromptLine(userLine(m)), false, m);
  }
});
