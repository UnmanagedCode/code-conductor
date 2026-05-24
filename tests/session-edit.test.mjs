// Pure-function coverage of the truncate/fork helpers in src/sessionEdit.js.
// Operates against synthetic jsonl files written into a temp dir styled as
// `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encodeCwd } from '../src/projects.js';
import { isPureUserPromptLine } from '../src/transcript.js';
import {
  truncateSessionAtUserMessage, forkSessionAtUserMessage,
} from '../src/sessionEdit.js';

async function makeFixture(lines) {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-edit-'));
  const projectsRoot = path.join(tmpHome, 'project');
  const claudeProjectsRoot = path.join(tmpHome, '.claude', 'projects');
  await fs.mkdir(claudeProjectsRoot, { recursive: true });
  const cwd = path.join(projectsRoot, 'demo');
  await fs.mkdir(cwd, { recursive: true });
  process.env.PROJECTS_ROOT = projectsRoot;
  process.env.CLAUDE_PROJECTS_ROOT = claudeProjectsRoot;
  const sid = '11111111-2222-3333-4444-555555555555';
  const dir = path.join(claudeProjectsRoot, encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { tmpHome, cwd, sid, file, dir };
}

function readJsonl(text) {
  return text.split('\n').filter(l => l.trim().length).map(l => JSON.parse(l));
}

test('isPureUserPromptLine: counts only true user prompts', () => {
  assert.equal(isPureUserPromptLine({ type: 'user', message: { content: 'hi' } }), true);
  assert.equal(isPureUserPromptLine({
    type: 'user',
    message: { content: [{ type: 'text', text: 'hi' }] },
  }), true);
  // tool_result-only user line: not a prompt.
  assert.equal(isPureUserPromptLine({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  }), false);
  // assistant line is never a prompt.
  assert.equal(isPureUserPromptLine({ type: 'assistant', message: { content: [] } }), false);
  // sidechain user lines are filtered out at replay; treat them the same here.
  assert.equal(isPureUserPromptLine({
    type: 'user', isSidechain: true, message: { content: 'hi' },
  }), false);
  // empty-string content shouldn't count (replay emits nothing).
  assert.equal(isPureUserPromptLine({
    type: 'user', message: { content: '' },
  }), false);
});

test('truncate at N=1 drops everything from the 2nd user prompt onward', async () => {
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
      { type: 'text', text: 'first reply' },
    ] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [
      { type: 'text', text: 'second reply' },
    ] } },
    { type: 'last-prompt', leafUuid: 'a2', sessionId: 'sid' },
  ];
  const { cwd, sid, file } = await makeFixture(lines);
  const result = await truncateSessionAtUserMessage({
    cwd, sessionId: sid, userMessageIndex: 1,
    permissionMode: 'bypassPermissions',
  });
  assert.equal(result.droppedText, 'second');
  assert.equal(result.lastSurvivingUuid, 'a1');

  const after = readJsonl(await fs.readFile(file, 'utf8'));
  // First user + first assistant survive; the new last-prompt + permission-mode
  // metadata pair is appended pointing at a1.
  const userUuids = after.filter(l => l.type === 'user').map(l => l.uuid);
  const assistantUuids = after.filter(l => l.type === 'assistant').map(l => l.uuid);
  assert.deepEqual(userUuids, ['u1']);
  assert.deepEqual(assistantUuids, ['a1']);
  const lastPrompt = after.find(l => l.type === 'last-prompt');
  assert.ok(lastPrompt && lastPrompt.leafUuid === 'a1', 'fresh last-prompt points at surviving leaf');
});

test('truncate at N=0 empties the file, no metadata appended', async () => {
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
      { type: 'text', text: 'reply' },
    ] } },
  ];
  const { cwd, sid, file } = await makeFixture(lines);
  const result = await truncateSessionAtUserMessage({
    cwd, sessionId: sid, userMessageIndex: 0,
    permissionMode: 'bypassPermissions',
  });
  assert.equal(result.droppedText, 'first');
  assert.equal(result.lastSurvivingUuid, null);

  const txt = await fs.readFile(file, 'utf8');
  assert.equal(txt, '', 'file is empty — no last-prompt metadata when there is no surviving leaf');
});

test('truncate out-of-range throws 400', async () => {
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'only' } },
  ];
  const { cwd, sid } = await makeFixture(lines);
  await assert.rejects(
    truncateSessionAtUserMessage({ cwd, sessionId: sid, userMessageIndex: 5 }),
    (e) => e.statusCode === 400 && /out of range/.test(e.message),
  );
});

test('fork copies the prefix to a new sessionId and leaves the original intact', async () => {
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: 'orig-sid', message: { role: 'user', content: 'first' } },
    { type: 'assistant', uuid: 'a1', sessionId: 'orig-sid', message: { id: 'm1', role: 'assistant', content: [
      { type: 'text', text: 'first reply' },
    ] } },
    { type: 'user', uuid: 'u2', sessionId: 'orig-sid', message: { role: 'user', content: 'second' } },
    { type: 'assistant', uuid: 'a2', sessionId: 'orig-sid', message: { id: 'm2', role: 'assistant', content: [
      { type: 'text', text: 'second reply' },
    ] } },
  ];
  const { cwd, sid, file, dir } = await makeFixture(lines);
  const originalBytes = await fs.readFile(file);

  const result = await forkSessionAtUserMessage({
    cwd, sessionId: sid, userMessageIndex: 1,
    permissionMode: 'bypassPermissions',
  });
  assert.ok(result.newSessionId && result.newSessionId !== sid, 'fresh sessionId');
  assert.equal(result.droppedText, 'second');

  // Original file untouched.
  const originalAfter = await fs.readFile(file);
  assert.equal(originalBytes.toString(), originalAfter.toString(),
    'original session jsonl is byte-identical after fork');

  // New file has the prefix + freshly-stamped sessionId fields + new last-prompt.
  const newFile = path.join(dir, `${result.newSessionId}.jsonl`);
  const after = readJsonl(await fs.readFile(newFile, 'utf8'));
  const userPrompts = after.filter(l => l.type === 'user' && typeof l.message?.content === 'string');
  assert.equal(userPrompts.length, 1, 'one surviving user prompt');
  assert.equal(userPrompts[0].message.content, 'first');
  // Each copied line has its sessionId field rewritten to the new id.
  for (const line of after.filter(l => typeof l.sessionId === 'string' && l.type !== 'last-prompt' && l.type !== 'permission-mode')) {
    assert.equal(line.sessionId, result.newSessionId,
      'each copied line carries the new sessionId, not the original');
  }
  const lastPrompt = after.find(l => l.type === 'last-prompt');
  assert.ok(lastPrompt && lastPrompt.leafUuid === 'a1', 'fork picker metadata anchors at a1');
  assert.equal(lastPrompt.sessionId, result.newSessionId);
});

test('predicate: tool_result-only user lines do NOT increment the user-message counter', async () => {
  // Regression: a `type:"user"` line carrying just a tool_result must not count
  // toward the userMessageIndex anchor — otherwise rewinding to "the 2nd user
  // message" would mis-target the tool_result returning the first turn's
  // Bash output.
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
    ] } },
    // This `type:"user"` is the tool_result echo — not a real user prompt.
    { type: 'user', uuid: 'u_tr', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt\n', is_error: false },
    ] } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [
      { type: 'text', text: 'done' },
    ] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
    { type: 'assistant', uuid: 'a3', message: { id: 'm3', role: 'assistant', content: [
      { type: 'text', text: 'second reply' },
    ] } },
  ];
  const { cwd, sid, file } = await makeFixture(lines);
  const result = await truncateSessionAtUserMessage({
    cwd, sessionId: sid, userMessageIndex: 1,
    permissionMode: 'bypassPermissions',
  });
  // We expect droppedText='second' (the 2nd real user prompt), not the tool_result.
  assert.equal(result.droppedText, 'second');
  const after = readJsonl(await fs.readFile(file, 'utf8'));
  // The full prefix (first user + assistant + tool_result + second assistant)
  // survives; only the second user prompt onward is dropped.
  assert.ok(after.some(l => l.uuid === 'u_tr'),
    'tool_result user line stays — it is part of the first turn');
  assert.ok(after.some(l => l.uuid === 'a2'),
    'second assistant turn (built off the tool_result) survives');
  assert.ok(!after.some(l => l.uuid === 'u2'), 'second user prompt is dropped');
});

test('fork with attachment-bearing user message strips the marker from droppedText', async () => {
  // The user composer writes prompt text + an "Attached file:" marker line in
  // the same `text` block array. When we prefill the composer after a fork,
  // we don't want the marker line bouncing back as visible prose.
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [
      { type: 'text', text: 'look at this' },
      { type: 'text', text: 'Attached file: `/tmp/foo/.code-conductor/projects/demo/attachments/123-screenshot.png`' },
    ] } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
      { type: 'text', text: 'reply' },
    ] } },
  ];
  const { cwd, sid } = await makeFixture(lines);
  const result = await forkSessionAtUserMessage({
    cwd, sessionId: sid, userMessageIndex: 0,
    permissionMode: 'bypassPermissions',
  });
  assert.equal(result.droppedText, 'look at this',
    'Attached file: marker line is stripped from the composer prefill text');
});
