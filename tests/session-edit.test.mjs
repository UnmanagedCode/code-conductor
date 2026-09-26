// Pure-function coverage of the truncate/fork helpers in src/sessionEdit.ts.
// Operates against synthetic jsonl files written into a temp dir styled as
// `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encodeCwd, localPlace} from '../src/projects.ts';
import { isPureUserPromptLine } from '../src/transcript.ts';
import {
  truncateSessionAtUserMessage, forkSessionAtUserMessage,
} from '../src/sessionEdit.ts';
import { mkdtemp } from './tmpRegistry.mjs';

async function makeFixture(lines) {
  const tmpHome = await mkdtemp('orch-edit-');
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
  // CLI-internal task-notification re-injection — a background subagent's
  // completion ping persisted as a type:"user" line — never produced a
  // user_echo live and must not count.
  assert.equal(isPureUserPromptLine({
    type: 'user',
    message: { content: '<task-notification>\n<task-id>t1</task-id>\n</task-notification>' },
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
    place: localPlace(cwd), sessionId: sid, userMessageIndex: 1, expectedText: 'second',
    mode: 'bypassPermissions',
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
    place: localPlace(cwd), sessionId: sid, userMessageIndex: 0, expectedText: 'first',
    mode: 'bypassPermissions',
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
    truncateSessionAtUserMessage({ place: localPlace(cwd), sessionId: sid, userMessageIndex: 5, expectedText: 'first' }),
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
    place: localPlace(cwd), sessionId: sid, userMessageIndex: 1, expectedText: 'second',
    mode: 'bypassPermissions',
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
    place: localPlace(cwd), sessionId: sid, userMessageIndex: 1, expectedText: 'second',
    mode: 'bypassPermissions',
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

test('isPureUserPromptLine: queued_command attachments count when prompt is an array of text blocks', () => {
  // The CLI persists a stdin user prompt that arrived mid-turn as
  // type:"attachment", attachment.type:"queued_command". The orchestrator
  // already emitted a user_echo from inst.prompt() — so the predicate must
  // count this line too, or the rewind/fork index drifts.
  assert.equal(isPureUserPromptLine({
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: [{ type: 'text', text: 'I approve the plan. Please proceed with the implementation.' }],
      commandMode: 'prompt',
    },
  }), true);
  // CLI-internal task-notification queued commands carry a string `prompt`
  // and never produced a user_echo — must NOT count.
  assert.equal(isPureUserPromptLine({
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: '<task-notification>...</task-notification>',
      commandMode: 'prompt',
    },
  }), false);
  // Empty text block — no user_echo would be rendered, no count.
  assert.equal(isPureUserPromptLine({
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: [{ type: 'text', text: '' }],
    },
  }), false);
  // Non-queued_command attachment (other CLI attachment subtypes) — no count.
  assert.equal(isPureUserPromptLine({
    type: 'attachment',
    attachment: { type: 'something_else', prompt: [{ type: 'text', text: 'x' }] },
  }), false);
});

test('fork targeting a queued_command auto-approve mid-session succeeds and prefills its text', async () => {
  // Reproduces the exact bug pattern from toy_battle: 3 real user prompts
  // interleaved with one auto-approve queued_command attachment. The
  // attachment line was invisible to isPureUserPromptLine pre-fix, so the
  // 3rd real prompt (rendered as the 4th user_echo bubble client-side) hit
  // "index 3 out of range, 3 user prompts".
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: 'orig', message: { role: 'user', content: 'build the thing' } },
    { type: 'assistant', uuid: 'a1', sessionId: 'orig', message: { id: 'm1', role: 'assistant', content: [
      { type: 'tool_use', id: 'epm1', name: 'ExitPlanMode', input: { plan: 'do stuff' } },
    ] } },
    // PreToolUse hook deny tool_result follows ExitPlanMode in real sessions.
    { type: 'user', uuid: 'u_tr1', sessionId: 'orig', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'epm1', content: 'denied', is_error: true },
    ] } },
    // Auto-approve from _fireAutoApprovePlan — orchestrator's inst.prompt()
    // wrote to stdin while the CLI was finishing the turn, so the CLI
    // persisted it as a queued_command attachment instead of a user line.
    { type: 'attachment', uuid: 'att1', sessionId: 'orig', attachment: {
      type: 'queued_command',
      prompt: [{ type: 'text', text: 'I approve the plan. Please proceed with the implementation.' }],
      commandMode: 'prompt',
    } },
    { type: 'assistant', uuid: 'a2', sessionId: 'orig', message: { id: 'm2', role: 'assistant', content: [
      { type: 'text', text: 'starting' },
    ] } },
    { type: 'user', uuid: 'u2', sessionId: 'orig', message: { role: 'user', content: 'answer to a question' } },
    { type: 'assistant', uuid: 'a3', sessionId: 'orig', message: { id: 'm3', role: 'assistant', content: [
      { type: 'text', text: 'ok' },
    ] } },
    { type: 'user', uuid: 'u3', sessionId: 'orig', message: { role: 'user', content: 'Please start' } },
    { type: 'assistant', uuid: 'a4', sessionId: 'orig', message: { id: 'm4', role: 'assistant', content: [
      { type: 'text', text: 'starting up' },
    ] } },
  ];
  const { cwd, sid, file, dir } = await makeFixture(lines);

  // The 4th forkable bubble (index 3) is "Please start" — must succeed.
  const result = await forkSessionAtUserMessage({
    place: localPlace(cwd), sessionId: sid, userMessageIndex: 3, expectedText: 'Please start',
    mode: 'bypassPermissions',
  });
  assert.equal(result.droppedText, 'Please start',
    'index 3 maps to the 4th forkable bubble — the post-auto-approve user prompt');

  // Original is untouched.
  const newFile = path.join(dir, `${result.newSessionId}.jsonl`);
  const after = readJsonl(await fs.readFile(newFile, 'utf8'));
  // Prefix should include u1, a1, u_tr1, att1, a2, u2, a3 — i.e. everything
  // before u3 ("Please start").
  assert.ok(after.some(l => l.uuid === 'att1'), 'auto-approve attachment survives in the fork');
  assert.ok(after.some(l => l.uuid === 'u2'), 'mid-session user prompt survives');
  assert.ok(after.some(l => l.uuid === 'a3'), 'assistant turn before Please start survives');
  assert.ok(!after.some(l => l.uuid === 'u3'), 'Please start prompt is dropped');
  assert.ok(!after.some(l => l.uuid === 'a4'), 'reply to Please start is dropped');
});

test('fork targeting a real prompt after a background-subagent task-notification stays aligned', async () => {
  // A background Agent tool_use finishes mid-session and the CLI re-injects
  // its completion ping as a type:"user" line with a bare <task-notification>
  // string. Pre-fix, isPureUserPromptLine counted it as a real prompt, so
  // the 2nd real prompt (the only bubble the UI ever showed at index 1)
  // would be targeted by index 2 instead, and droppedText could even
  // surface the raw tag text if the notification line itself were selected.
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: 'orig', message: { role: 'user', content: 'first prompt' } },
    { type: 'assistant', uuid: 'a1', sessionId: 'orig', message: { id: 'm1', role: 'assistant', content: [
      { type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'background work' } },
    ] } },
    { type: 'user', uuid: 'u_tr1', sessionId: 'orig', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'agent1', content: 'Async agent launched successfully.' },
    ] } },
    { type: 'assistant', uuid: 'a2', sessionId: 'orig', message: { id: 'm2', role: 'assistant', content: [
      { type: 'text', text: 'working on it' },
    ] } },
    { type: 'user', uuid: 'u2', sessionId: 'orig', message: { role: 'user', content: 'second prompt' } },
    { type: 'assistant', uuid: 'a3', sessionId: 'orig', message: { id: 'm3', role: 'assistant', content: [
      { type: 'text', text: 'still working' },
    ] } },
    // The background subagent completes and its ping lands here, between
    // the 2nd and 3rd real prompts.
    { type: 'user', uuid: 'u_notif', sessionId: 'orig', message: { role: 'user',
      content: '<task-notification>\n<task-id>agent1</task-id>\n<status>completed</status>\n</task-notification>' } },
    { type: 'user', uuid: 'u3', sessionId: 'orig', message: { role: 'user', content: 'third prompt' } },
    { type: 'assistant', uuid: 'a4', sessionId: 'orig', message: { id: 'm4', role: 'assistant', content: [
      { type: 'text', text: 'done' },
    ] } },
  ];
  const { cwd, sid, file, dir } = await makeFixture(lines);

  // Bubble index 2 (0-based) is "third prompt" — the 3rd real user_echo the
  // UI ever rendered. Must not drift because of the task-notification line.
  const result = await forkSessionAtUserMessage({
    place: localPlace(cwd), sessionId: sid, userMessageIndex: 2, expectedText: 'third prompt',
    mode: 'bypassPermissions',
  });
  assert.equal(result.droppedText, 'third prompt',
    'index 2 maps to the 3rd real user prompt, unaffected by the task-notification line');

  const newFile = path.join(dir, `${result.newSessionId}.jsonl`);
  const after = readJsonl(await fs.readFile(newFile, 'utf8'));
  assert.ok(after.some(l => l.uuid === 'u_notif'), 'task-notification line survives in the fork prefix');
  assert.ok(after.some(l => l.uuid === 'u2'), 'second real prompt survives');
  assert.ok(!after.some(l => l.uuid === 'u3'), 'third prompt is dropped');
  assert.ok(!after.some(l => l.uuid === 'a4'), 'reply to third prompt is dropped');
});

test('fork targeting the queued_command itself prefills the queued text and drops it forward', async () => {
  // When the user clicks fork/rewind on the auto-approve bubble itself,
  // droppedText should pull from attachment.prompt, not message.content.
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: 'orig', message: { role: 'user', content: 'plan it' } },
    { type: 'assistant', uuid: 'a1', sessionId: 'orig', message: { id: 'm1', role: 'assistant', content: [
      { type: 'tool_use', id: 'epm1', name: 'ExitPlanMode', input: { plan: 'do stuff' } },
    ] } },
    { type: 'attachment', uuid: 'att1', sessionId: 'orig', attachment: {
      type: 'queued_command',
      prompt: [{ type: 'text', text: 'I approve the plan. Please proceed with the implementation.' }],
      commandMode: 'prompt',
    } },
    { type: 'assistant', uuid: 'a2', sessionId: 'orig', message: { id: 'm2', role: 'assistant', content: [
      { type: 'text', text: 'starting' },
    ] } },
  ];
  const { cwd, sid, dir } = await makeFixture(lines);
  const result = await forkSessionAtUserMessage({
    place: localPlace(cwd), sessionId: sid, userMessageIndex: 1, expectedText: 'I approve the plan. Please proceed with the implementation.',
    mode: 'bypassPermissions',
  });
  assert.equal(result.droppedText,
    'I approve the plan. Please proceed with the implementation.',
    'droppedText pulled from attachment.prompt for queued_command targets');
  const newFile = path.join(dir, `${result.newSessionId}.jsonl`);
  const after = readJsonl(await fs.readFile(newFile, 'utf8'));
  assert.ok(!after.some(l => l.uuid === 'att1'), 'queued_command itself is dropped');
  assert.ok(!after.some(l => l.uuid === 'a2'), 'turn after it is dropped');
  assert.ok(after.some(l => l.uuid === 'u1'), 'pre-attachment user prompt survives');
});

test('fork with attachment-bearing user message strips the marker from droppedText', async () => {
  // The user composer writes prompt text + an "Attached file:" marker line in
  // the same `text` block array. When we prefill the composer after a fork,
  // we don't want the marker line bouncing back as visible prose.
  const lines = [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'earlier' } },
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
    place: localPlace(cwd), sessionId: sid, userMessageIndex: 1, expectedText: 'look at this',
    mode: 'bypassPermissions',
  });
  assert.equal(result.droppedText, 'look at this',
    'Attached file: marker line is stripped from the composer prefill text');
});

// ── local-command caveat + the prompt-text guard ────────────────────────────

const CAVEAT_TEXT = '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>';
const caveatLine = (uuid) => ({ type: 'user', isMeta: true, uuid, message: { role: 'user', content: CAVEAT_TEXT } });
const commandLine = (uuid, name, args) => ({ type: 'user', uuid, message: { role: 'user', content:
  `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>` } });
const localCommandStdout = (uuid) => ({ type: 'system', subtype: 'local_command', uuid, content: '<local-command-stdout></local-command-stdout>' });
const turn = (tag, text) => [
  { type: 'user', uuid: `u-${tag}`, message: { role: 'user', content: text } },
  { type: 'assistant', uuid: `a-${tag}`, message: { id: `m-${tag}`, role: 'assistant', content: [{ type: 'text', text: `${tag} reply` }] } },
];
const ATT_MARKER = 'Attached file: `/store/.code-conductor/projects/demo/attachments/1-shot.png`';
const MID_TURN = '<system-reminder>\nThe user sent this message while you were mid-turn.\n</system-reminder>';

// `run` refuses with a PROMPT_MISMATCH 409.
async function assertMismatch(run) {
  let caught = null;
  await assert.rejects(run, (e) => { caught = e; return true; });
  assert.equal(caught.statusCode, 409, caught.message);
  const { PROMPT_MISMATCH } = await import('../src/sessionEdit.ts');
  assert.equal(typeof PROMPT_MISMATCH, 'string', 'sessionEdit exports PROMPT_MISMATCH');
  assert.ok(caught.message.startsWith(PROMPT_MISMATCH), caught.message);
}

test('isPureUserPromptLine: the CLI caveat is not a prompt; user text mentioning the tag is', () => {
  assert.equal(isPureUserPromptLine(caveatLine('c')), false, 'the isMeta string caveat');
  assert.equal(isPureUserPromptLine({ type: 'user', message: { content: CAVEAT_TEXT } }), true,
    'a user-authored string that is only the tag still counts');
  assert.equal(isPureUserPromptLine({ type: 'user', message: { content: [{ type: 'text', text: CAVEAT_TEXT }] } }), true,
    'array content holding the tag still counts');
  assert.equal(isPureUserPromptLine({ type: 'user', isMeta: true, message: { content: `forwarded: ${CAVEAT_TEXT}` } }), true,
    'an isMeta line that merely contains the tag still counts');
});

test('replayPersistedLine and the live parser emit nothing for the caveat', async () => {
  const { replayPersistedLine } = await import('../src/transcript.ts');
  const { Parser } = await import('../src/parser.ts');
  assert.deepEqual(replayPersistedLine(caveatLine('c')), [], 'the jsonl shape (isMeta)');
  assert.deepEqual(new Parser().handleObject({ type: 'user', isSynthetic: true, message: { role: 'user', content: CAVEAT_TEXT } }), [],
    'the stdout shape (isSynthetic)');
});

test('replay and the prompt counter agree 1:1', async () => {
  const { replayPersistedLine, loadPersistedTranscript } = await import('../src/transcript.ts');
  const { stampArchiveEvents } = await import('../src/eventArchive.ts');
  const { isOuterUserEcho } = await import('../src/parser.ts');
  const lines = [
    caveatLine('head-caveat'), commandLine('head-clear', 'clear', ''), localCommandStdout('head-stdout'),
    ...turn('t0', 'first'),
    caveatLine('e-caveat'), commandLine('e-cmd', 'effort', 'high'), localCommandStdout('e-stdout'),
    // The interactive CLI persists a command's output as a user line.
    caveatLine('i-caveat'), commandLine('i-cmd', 'config', ''),
    { type: 'user', uuid: 'i-stdout', message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } },
    ...turn('t1', `worker said: ${CAVEAT_TEXT}`),
    { type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'queued' }] } },
    { type: 'user', uuid: 'tn', message: { role: 'user', content: '<task-notification>\n<task-id>t</task-id>\n</task-notification>' } },
    { type: 'user', uuid: 'im', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ...turn('t2', 'last'),
  ];
  const outerEchoes = (obj) => replayPersistedLine(obj).filter(isOuterUserEcho);
  for (const obj of lines) {
    assert.equal(outerEchoes(obj).length, isPureUserPromptLine(obj) ? 1 : 0, `line ${obj.uuid}: one echo iff a prompt line`);
  }
  const { cwd, sid } = await makeFixture(lines);
  const result = await loadPersistedTranscript({ place: localPlace(cwd), sessionId: sid, seqHint: 0 });
  const stamped = stampArchiveEvents(result.lines).filter(isOuterUserEcho);
  const promptLines = lines.filter(isPureUserPromptLine);
  assert.equal(stamped.length, promptLines.length, 'replayed echoes === counted prompt lines');
  stamped.forEach((e, i) => assert.equal(e.text, outerEchoes(promptLines[i])[0].text, `echo ${i} is its own line's`));
});

test('the prompt-text guard: what matches and what refuses', async (t) => {
  // [title, target line, the text its live bubble carried, accepted]
  const rows = [
    ['CRLF and trailing whitespace', { type: 'user', uuid: 'x', message: { content: 'line one\r\nline two  ' } }, 'line one\nline two', true],
    ['command wrapper ↔ /effort high', commandLine('x', 'effort', 'high'), '/effort high', true],
    ['empty-args /clear', { type: 'user', uuid: 'x', message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } }, '/clear', true],
    ['attachment-marker blocks stripped', { type: 'user', uuid: 'x', message: { content: [{ type: 'text', text: 'look' }, { type: 'text', text: ATT_MARKER }] } }, 'look', true],
    ['mid-turn note skipped', { type: 'user', uuid: 'x', message: { content: [{ type: 'text', text: MID_TURN }, { type: 'text', text: 'steer' }] } }, 'steer', true],
    ['multi-block text joined with \\n', { type: 'user', uuid: 'x', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }, 'a\nb', true],
    ['attachment-only', { type: 'user', uuid: 'x', message: { content: [{ type: 'text', text: ATT_MARKER }] } }, '', true],
    ['queued_command', { type: 'attachment', uuid: 'x', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'queued' }] } }, 'queued', true],
    ['a genuine mismatch', { type: 'user', uuid: 'x', message: { content: 'hello' } }, 'goodbye', false],
    ['prose quoting a command tag is not a command', { type: 'user', uuid: 'x', message: { content: 'please run <command-name>/effort</command-name> for me' } }, '/effort', false],
    ['prose quoting a command tag matches its own text', { type: 'user', uuid: 'x', message: { content: 'please run <command-name>/effort</command-name> for me' } }, 'please run <command-name>/effort</command-name> for me', true],
  ];
  for (const [title, target, expectedText, accepted] of rows) {
    await t.test(title, async () => {
      const { cwd, sid } = await makeFixture([...turn('t0', 'first'), target]);
      const run = forkSessionAtUserMessage({ place: localPlace(cwd), sessionId: sid, userMessageIndex: 1, mode: 'bypassPermissions', expectedText });
      if (accepted) await run;
      else await assertMismatch(run);
    });
  }
});

test('truncate refuses a text mismatch and leaves the file byte-identical', async () => {
  const { cwd, sid, file } = await makeFixture([...turn('t0', 'first'), ...turn('t1', 'second')]);
  const before = await fs.readFile(file, 'utf8');
  await assertMismatch(
    truncateSessionAtUserMessage({ place: localPlace(cwd), sessionId: sid, userMessageIndex: 1, mode: 'bypassPermissions', expectedText: 'first' }));
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('fork refuses a text mismatch and writes no file', async () => {
  const { cwd, sid, dir } = await makeFixture([...turn('t0', 'first'), ...turn('t1', 'second')]);
  const listing = (await fs.readdir(dir)).sort();
  await assertMismatch(
    forkSessionAtUserMessage({ place: localPlace(cwd), sessionId: sid, userMessageIndex: 1, mode: 'bypassPermissions', expectedText: 'first' }));
  assert.deepEqual((await fs.readdir(dir)).sort(), listing);
});

test('a split before a command line drops its caveat too', async () => {
  const { cwd, sid, file } = await makeFixture([
    ...turn('t0', 'first'),
    caveatLine('e-caveat'), commandLine('e-cmd', 'effort', 'high'), localCommandStdout('e-stdout'),
    ...turn('t1', 'after'),
  ]);
  const result = await truncateSessionAtUserMessage({
    place: localPlace(cwd), sessionId: sid, userMessageIndex: 1, mode: 'bypassPermissions', expectedText: '/effort high',
  });
  assert.equal(result.lastSurvivingUuid, 'a-t0', 'the leaf is the last line before the caveat');
  assert.equal(result.remainingLineCount, 2);
  assert.equal(result.droppedLineCount, 5, 'the caveat is dropped with its command');
  const after = readJsonl(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after.map(l => l.uuid ?? l.type), ['u-t0', 'a-t0', 'last-prompt', 'permission-mode']);
  assert.equal(after[2].leafUuid, 'a-t0');
});

test('composer prefill: a command bubble prefills its command form, any other prompt its text byte-for-byte', async (t) => {
  // [title, target line, its bubble's text, expected droppedText]
  const rows = [
    ['/effort high', commandLine('x', 'effort', 'high'), '/effort high', '/effort high'],
    ['/model opus', commandLine('x', 'model', 'opus'), '/model opus', '/model opus'],
    ['/clear', { type: 'user', uuid: 'x', message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } }, '/clear', '/clear'],
    ['a prompt with surrounding whitespace', { type: 'user', uuid: 'x', message: { content: '  keep\n  my spacing  ' } }, '  keep\n  my spacing  ', '  keep\n  my spacing  '],
    ['prose quoting a command tag', { type: 'user', uuid: 'x', message: { content: 'please run <command-name>/effort</command-name> for me' } },
      'please run <command-name>/effort</command-name> for me', 'please run <command-name>/effort</command-name> for me'],
  ];
  for (const [title, target, expectedText, droppedText] of rows) {
    for (const [op, run] of [['truncate', truncateSessionAtUserMessage], ['fork', forkSessionAtUserMessage]]) {
      await t.test(`${op}: ${title}`, async () => {
        const { cwd, sid } = await makeFixture([...turn('t0', 'first'), target]);
        const result = await run({ place: localPlace(cwd), sessionId: sid, userMessageIndex: 1, mode: 'bypassPermissions', expectedText });
        assert.equal(result.droppedText, droppedText);
      });
    }
  }
});
