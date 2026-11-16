// Hook context (src/hookContext.ts): the text a hook adds to the model's
// context (`hookSpecificOutput.additionalContext`) becomes one `hook_context`
// UI event — live from a UserPromptSubmit `hook_response` frame (the parser),
// and on replay from the CLI's `hook_additional_context` attachment line. Pure
// units over the two recognizers, the parser's replacement of the frame and
// replay parity with the live constructor. The broker's live Pre/PostToolUse
// emission is in tests/hook-callback.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hookContextEvent, hookContextFromResponse, hookContextEventsFromAttachment,
} from '../src/hookContext.ts';
import { Parser } from '../src/parser.ts';
import { replayPersistedLine } from '../src/transcript.ts';
import { readNudgeText } from '../src/conductorReadNudge.ts';

const RECALL = '<recall>synthetic note one</recall>';

// A live `system`/`hook_response` frame, shaped as the CLI emits it. Synthetic.
const responseFrame = ({ hookEvent = 'UserPromptSubmit', output, outcome = 'success', ...extra } = {}) => ({
  type: 'system', subtype: 'hook_response',
  hook_id: 'hid-1', hook_name: hookEvent, hook_event: hookEvent,
  output, stdout: output, stderr: '', exit_code: 0, outcome,
  uuid: 'uuid-1', session_id: 'sess-1', ...extra,
});
const contextOutput = (additionalContext, hookEventName = 'UserPromptSubmit') =>
  JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } });

// INVARIANT: the live recognizer is total — it never throws, returns null for
// every frame that carries no non-empty UserPromptSubmit context, and returns
// null for Pre/PostToolUse frames (the broker is their only live source, so a
// tool context is never emitted twice).
test('hookContextFromResponse is total', async (t) => {
  await t.test('a context-bearing UserPromptSubmit frame yields exactly the event', () => {
    assert.deepEqual(hookContextFromResponse(responseFrame({ output: contextOutput(RECALL) })), {
      kind: 'hook_context', hookEvent: 'UserPromptSubmit', toolUseId: null, toolName: null, text: RECALL,
    });
  });
  const nulls = [
    ['empty output', { output: '' }],
    ['{}', { output: '{}' }],
    ['a cancelled hook\'s text', { output: 'Hook cancelled' }],
    ['plain text', { output: 'not json' }],
    ['a JSON array', { output: '[]' }],
    ['JSON null', { output: 'null' }],
    ['a non-string output', { output: 42 }],
    ['a missing output', { output: undefined }],
    ['a non-object hookSpecificOutput', { output: JSON.stringify({ hookSpecificOutput: 'x' }) }],
    ['a non-string additionalContext', { output: JSON.stringify({ hookSpecificOutput: { additionalContext: 7 } }) }],
    ['an empty additionalContext', { output: contextOutput('') }],
    ['outcome cancelled', { output: contextOutput(RECALL), outcome: 'cancelled' }],
    ['a PreToolUse frame', { hookEvent: 'PreToolUse', output: contextOutput(RECALL, 'PreToolUse') }],
    ['a PostToolUse frame', { hookEvent: 'PostToolUse', output: contextOutput(RECALL, 'PostToolUse') }],
    ['a SessionStart frame', { hookEvent: 'SessionStart', output: contextOutput(RECALL, 'SessionStart') }],
  ];
  for (const [label, fields] of nulls) {
    await t.test(`null for ${label}`, () => {
      assert.equal(hookContextFromResponse(responseFrame(fields)), null);
    });
  }
  await t.test('null for a hook_started frame carrying the same output', () => {
    assert.equal(hookContextFromResponse({ ...responseFrame({ output: contextOutput(RECALL) }), subtype: 'hook_started' }), null);
  });
});

// INVARIANT: the parser REPLACES a context-bearing UserPromptSubmit
// `hook_response` with the one `hook_context` event (the ring never holds the
// recall twice), and passes every other hook_response through unchanged.
test('Parser: a context-bearing hook_response becomes one hook_context and no system event', () => {
  const evs = new Parser().handleLine(JSON.stringify(responseFrame({ output: contextOutput(RECALL) })));
  assert.deepEqual(evs, [{
    kind: 'hook_context', hookEvent: 'UserPromptSubmit', toolUseId: null, toolName: null, text: RECALL, parentToolUseId: null,
  }]);
});

test('Parser: a {} hook_response still passes through as the hidden system frame', () => {
  const evs = new Parser().handleLine(JSON.stringify(responseFrame({ output: '{}' })));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'system');
  assert.equal(evs[0].subtype, 'hook_response');
});

// A `hook_additional_context` attachment line, shaped as the CLI writes it. Synthetic.
const attachment = (fields) => ({ type: 'hook_additional_context', ...fields });
const attachmentLine = (fields, extra = {}) => ({
  type: 'attachment', uuid: 'att-1', parentUuid: 'p', isSidechain: false, attachment: attachment(fields), ...extra,
});

// INVARIANT: the replay recognizer is total and emits one event per non-empty
// string: Pre/Post carry the call's id and the tool named by `hookName`;
// UserPromptSubmit drops its synthetic `hook-…` id; anything out of scope or
// malformed yields nothing.
test('hookContextEventsFromAttachment is total and per-string', async (t) => {
  await t.test('PreToolUse takes toolUseId from toolUseID and toolName from hookName', () => {
    assert.deepEqual(hookContextEventsFromAttachment(attachment({
      hookEvent: 'PreToolUse', hookName: 'PreToolUse:mcp__x__read', toolUseID: 'toolu_a', content: ['note'],
    })), [{ kind: 'hook_context', hookEvent: 'PreToolUse', toolUseId: 'toolu_a', toolName: 'mcp__x__read', text: 'note' }]);
  });
  await t.test('PostToolUse likewise', () => {
    assert.deepEqual(hookContextEventsFromAttachment(attachment({
      hookEvent: 'PostToolUse', hookName: 'PostToolUse:Edit', toolUseID: 'call_b', content: ['after'],
    })), [{ kind: 'hook_context', hookEvent: 'PostToolUse', toolUseId: 'call_b', toolName: 'Edit', text: 'after' }]);
  });
  await t.test('UserPromptSubmit ignores its synthetic hook- id', () => {
    assert.deepEqual(hookContextEventsFromAttachment(attachment({
      hookEvent: 'UserPromptSubmit', hookName: 'UserPromptSubmit', toolUseID: 'hook-0000', content: [RECALL],
    })), [{ kind: 'hook_context', hookEvent: 'UserPromptSubmit', toolUseId: null, toolName: null, text: RECALL }]);
  });
  await t.test('two strings yield two events, in order', () => {
    const evs = hookContextEventsFromAttachment(attachment({
      hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_c', content: ['first', 'second'],
    }));
    assert.deepEqual(evs.map(e => e.text), ['first', 'second']);
  });
  await t.test('non-string and empty elements are skipped', () => {
    const evs = hookContextEventsFromAttachment(attachment({
      hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_d', content: [7, '', null, 'kept'],
    }));
    assert.deepEqual(evs.map(e => e.text), ['kept']);
  });
  await t.test('a hookName without the event prefix gives a null toolName; a missing id a null toolUseId', () => {
    assert.deepEqual(hookContextEventsFromAttachment(attachment({
      hookEvent: 'PreToolUse', hookName: 'something-else', content: ['x'],
    })), [{ kind: 'hook_context', hookEvent: 'PreToolUse', toolUseId: null, toolName: null, text: 'x' }]);
  });
  const empties = [
    ['a non-array content', { hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 't', content: 'text' }],
    ['a SessionStart context', { hookEvent: 'SessionStart', hookName: 'SessionStart', toolUseID: 't', content: ['x'] }],
    ['a missing hookEvent', { hookName: 'PreToolUse:Bash', toolUseID: 't', content: ['x'] }],
  ];
  for (const [label, fields] of empties) {
    await t.test(`[] for ${label}`, () => assert.deepEqual(hookContextEventsFromAttachment(attachment(fields)), []));
  }
  await t.test('[] for a wrong attachment type', () => {
    assert.deepEqual(hookContextEventsFromAttachment({
      type: 'hook_success', hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 't', content: ['x'],
    }), []);
  });
  await t.test('[] for null and undefined', () => {
    assert.deepEqual(hookContextEventsFromAttachment(null), []);
    assert.deepEqual(hookContextEventsFromAttachment(undefined), []);
  });
});

const stripParent = ({ parentToolUseId, ...rest }) => rest;

// INVARIANT: replay rebuilds exactly the event the live constructor builds for
// the same fields — a reload shows what the live view showed — for any hook on
// any tool, cc's read nudge included; a non-context hook line replays nothing.
test('replay parity: an attachment line replays as the live constructor\'s event', async (t) => {
  const cases = [
    { hookEvent: 'PreToolUse', toolName: 'mcp__code-conductor__project_read', toolUseId: 'toolu_r8', text: readNudgeText(8) },
    { hookEvent: 'PreToolUse', toolName: 'Bash', toolUseId: 'toolu_b', text: readNudgeText(8) },
    { hookEvent: 'PostToolUse', toolName: 'mcp__code-conductor__delete_worktree', toolUseId: 'toolu_dw', text: 'landed note' },
    { hookEvent: 'UserPromptSubmit', toolName: null, toolUseId: null, text: RECALL },
  ];
  for (const c of cases) {
    await t.test(`${c.hookEvent} ${c.toolName ?? ''}`, () => {
      const line = attachmentLine({
        hookEvent: c.hookEvent,
        hookName: c.toolName ? `${c.hookEvent}:${c.toolName}` : c.hookEvent,
        toolUseID: c.toolUseId ?? 'hook-1111',
        content: [c.text],
      });
      const evs = replayPersistedLine(line);
      assert.equal(evs.length, 1);
      assert.equal(evs[0].parentToolUseId, null, 'a main-thread line is tagged with no parent');
      assert.deepEqual(stripParent(evs[0]), hookContextEvent(c));
    });
  }
  await t.test('a hook_success line replays nothing', () => {
    assert.deepEqual(replayPersistedLine({
      type: 'attachment', uuid: 'att-2', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 't', content: '' },
    }), []);
  });
});
