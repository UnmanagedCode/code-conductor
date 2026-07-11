// Background-subagent completion pings are re-injected by the CLI into a
// worker's own conversation as a `type:"user"` line whose content is the raw
// string `<task-notification>...</task-notification>`. This must be hidden
// everywhere a real user prompt would surface: the live parser, the
// transcript replay, and the rewind/fork prompt-counter — mirrors
// tests/soft-interrupt-filter.test.mjs for the analogous soft-interrupt case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser, isTaskNotificationContent } from '../src/parser.js';
import { replayPersistedLine, isPureUserPromptLine } from '../src/transcript.js';

const NOTIF = '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>';

function userLine(content) {
  return { type: 'user', message: { role: 'user', content } };
}

test('isTaskNotificationContent detects the tag in string + array shapes', () => {
  assert.equal(isTaskNotificationContent(NOTIF), true);
  assert.equal(isTaskNotificationContent([{ type: 'text', text: NOTIF }]), true);
  assert.equal(isTaskNotificationContent('hello world'), false);
  assert.equal(isTaskNotificationContent([{ type: 'text', text: 'hello' }]), false);
  assert.equal(isTaskNotificationContent(undefined), false);
});

test('live parser drops a task-notification line entirely (no events, no user bubble)', () => {
  const p = new Parser();
  const evs = p.handleObject(userLine(NOTIF));
  assert.deepEqual(evs, []);
  // A normal user message still produces a user_echo.
  const normal = new Parser().handleObject(userLine('real prompt'));
  assert.equal(normal.filter((e) => e.kind === 'user_echo').length, 1);
});

test('replay drops a task-notification line entirely, keeps real prompts', () => {
  assert.deepEqual(replayPersistedLine(userLine(NOTIF)), []);
  assert.equal(replayPersistedLine(userLine('real')).filter((e) => e.kind === 'user_echo').length, 1);
});

test('prompt-counter excludes the task-notification line so rewind/fork indices stay aligned', () => {
  assert.equal(isPureUserPromptLine(userLine(NOTIF)), false);
  assert.equal(isPureUserPromptLine(userLine('real')), true);
});
