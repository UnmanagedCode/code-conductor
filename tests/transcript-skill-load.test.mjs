// Replay parity for the Skill-content-injection correlation: a persisted
// jsonl session where a Skill tool_use is followed by its content-injection
// user line must replay with the same `skillLoad` tag the live parser stamps
// (see attachSkillLoad in src/parser.ts) — otherwise the dedicated
// skill-loading bubble would only appear live and regress to a giant
// plain-text bubble on session reload.
//
// FIELD NAMES MATTER HERE. The CLI marks the injection differently per
// surface: the stream-json stdout envelope says `isSynthetic`, the persisted
// jsonl says `isMeta` and additionally carries `sourceToolUseID` naming the
// Skill tool_use it belongs to. These fixtures use the *persisted* shape,
// because that is what the CLI actually writes to a jsonl — a fixture stamped
// with the stdout field name is a false-green that passes whether replay reads
// the right field or not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCwd } from '../src/projects.ts';
import { loadPersistedTranscript, loadSubAgentTranscript } from '../src/transcript.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const CWD = '/tmp/skill-load-project';
const SID = 'sess-skill-load';

function skillSessionLines() {
  return [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'what are the default keybindings?' } },
    {
      type: 'assistant', uuid: 'a0',
      message: {
        id: 'm_skill', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'keybindings-help', args: 'what are the default keybindings?' } }],
      },
    },
    {
      type: 'user', uuid: 'u1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_skill', content: 'Launching skill: keybindings-help' }] },
    },
    {
      type: 'user', uuid: 'u2', isMeta: true, sourceToolUseID: 'tu_skill',
      message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nfull reference text here' }] },
    },
    { type: 'assistant', uuid: 'a1', message: { id: 'm_reply', role: 'assistant', content: [{ type: 'text', text: 'Here they are.' }] } },
  ];
}

async function seedTranscript(lines) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-skill-load-'));
  process.env.CLAUDE_PROJECTS_ROOT = rootDir;
  const file = path.join(rootDir, encodeCwd(CWD), `${SID}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return rootDir;
}

// Copy a fixture jsonl into the layout the loader expects, so no test reads
// from the developer's real ~/.claude at run time.
async function seedFixture(fixtureName, { subagentId = null } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-skill-load-'));
  process.env.CLAUDE_PROJECTS_ROOT = rootDir;
  const dest = subagentId
    ? path.join(rootDir, encodeCwd(CWD), SID, 'subagents', `agent-${subagentId}.jsonl`)
    : path.join(rootDir, encodeCwd(CWD), `${SID}.jsonl`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(path.join(FIXTURES, fixtureName), dest);
  return rootDir;
}

function flatEvents(result) {
  const out = [];
  for (const line of result.lines) for (const ev of line.events) out.push(ev);
  return out;
}

test('loadPersistedTranscript: isMeta content-injection line correlates with the Skill tool_use named by sourceToolUseID', async () => {
  await seedTranscript(skillSessionLines());
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  assert.ok(result, 'transcript loaded');
  const events = flatEvents(result);

  const toolUse = events.find(ev => ev.kind === 'tool_use' && ev.name === 'Skill');
  assert.ok(toolUse, 'Skill tool_use replayed');

  const echoes = events.filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 2, 'the real prompt and the content-injection line each produce a user_echo');
  assert.equal(echoes[0].skillLoad, undefined, 'the real user prompt is not tagged as a skill load');
  assert.deepEqual(echoes[1].skillLoad, { skill: 'keybindings-help' });

  // The intervening tool_result stays a plain, unrelated event.
  const toolResult = events.find(ev => ev.kind === 'tool_result');
  assert.ok(toolResult);
  assert.equal(toolResult.toolUseId, 'tu_skill');
});

// Ground truth: real lines lifted from session
// 26d0669d-2227-4aa5-badb-abaeeaed7d55, written by CLI 2.1.220. Every
// structural field is byte-identical to what the CLI persisted; only the long
// text/thinking bodies are truncated. This is the session that exposed the bug
// — it resumed with zero live turns, so its whole event ring came from replay.
test('loadPersistedTranscript: a REAL persisted session folds its Skill invocation into a skill bubble', async () => {
  await seedFixture('real-skill-load-parent.jsonl');
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  assert.ok(result, 'transcript loaded');
  const events = flatEvents(result);

  const toolUse = events.find(ev => ev.kind === 'tool_use' && ev.name === 'Skill');
  assert.ok(toolUse, 'Skill tool_use replayed');
  assert.equal(toolUse.toolUseId, 'call_F8awQmxYJ4V21fFu7iUUnM2v');

  const echoes = events.filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 2, 'the real prompt and the injected skill content each produce a user_echo');
  assert.equal(echoes[0].skillLoad, undefined, 'the real user prompt is not tagged');
  assert.deepEqual(echoes[1].skillLoad, { skill: 'claude-api' },
    'the isMeta injection is tagged with the skill named by its sourceToolUseID');
  assert.match(echoes[1].text, /Base directory for this skill/, 'the tagged echo is the injected SKILL.md content');
});

// Same defect, sub-agent surface: loadSubAgentTranscript shares
// replayPersistedLine, so a Skill invoked inside a Task regressed identically.
test('loadSubAgentTranscript: a REAL persisted sub-agent transcript folds its Skill invocation', async () => {
  await seedFixture('real-skill-load-subagent.jsonl', { subagentId: 'ae6b9bdf4daf74ed1' });
  const events = await loadSubAgentTranscript({
    cwd: CWD, sessionId: SID, agentId: 'ae6b9bdf4daf74ed1', parentToolUseId: 'call_outer_agent',
  });
  assert.ok(events.length, 'sub-agent transcript replayed');

  const toolUse = events.find(ev => ev.kind === 'tool_use' && ev.name === 'Skill');
  assert.ok(toolUse, 'Skill tool_use replayed');
  assert.equal(toolUse.toolUseId, 'call_8RvDojH0ymttsqv0XkjJH73o');

  const tagged = events.filter(ev => ev.kind === 'user_echo' && ev.skillLoad);
  assert.equal(tagged.length, 1, 'exactly one echo is tagged as a skill load');
  assert.deepEqual(tagged[0].skillLoad, { skill: 'claude-api' });
  assert.equal(tagged[0].parentToolUseId, 'call_outer_agent',
    'the tagged echo is still routed under the outer Agent block');
});

function twoSkillsOutOfOrderLines() {
  return [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'do two things' } },
    {
      type: 'assistant', uuid: 'a0',
      message: {
        id: 'm_1', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_first', name: 'Skill', input: { skill: 'keybindings-help' } }],
      },
    },
    {
      type: 'assistant', uuid: 'a1',
      message: {
        id: 'm_2', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_second', name: 'Skill', input: { skill: 'claude-api' } }],
      },
    },
    // The SECOND invocation's content lands first. FIFO order would hand this
    // line the first entry; the id says otherwise.
    {
      type: 'user', uuid: 'u1', isMeta: true, sourceToolUseID: 'tu_second',
      message: { role: 'user', content: [{ type: 'text', text: '# Claude API\n\nreference' }] },
    },
    {
      type: 'user', uuid: 'u2', isMeta: true, sourceToolUseID: 'tu_first',
      message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nreference' }] },
    },
  ];
}

test('loadPersistedTranscript: injections are matched by sourceToolUseID identity, not FIFO order', async () => {
  await seedTranscript(twoSkillsOutOfOrderLines());
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  const echoes = flatEvents(result).filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 3);
  assert.deepEqual(echoes[1].skillLoad, { skill: 'claude-api' },
    'the injection naming tu_second gets the second skill, not the FIFO head');
  assert.deepEqual(echoes[2].skillLoad, { skill: 'keybindings-help' },
    'and the first entry is still available for its own injection');
});

function metaLineWithoutIdLines() {
  return [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'load a skill' } },
    {
      type: 'assistant', uuid: 'a0',
      message: {
        id: 'm_1', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'keybindings-help' } }],
      },
    },
    // A compaction-continuation line: isMeta like a skill injection, but with
    // no sourceToolUseID. Every genuine skill injection in a jsonl carries the
    // id, so this one must claim nothing.
    {
      type: 'user', uuid: 'u1', isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation...' }] },
    },
    // The pending entry must have survived that line, and still be claimable
    // by its own injection.
    {
      type: 'user', uuid: 'u2', isMeta: true, sourceToolUseID: 'tu_skill',
      message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nreference' }] },
    },
  ];
}

test('loadPersistedTranscript: an isMeta line with no sourceToolUseID neither claims nor consumes a pending Skill entry', async () => {
  await seedTranscript(metaLineWithoutIdLines());
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  const echoes = flatEvents(result).filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 3);
  assert.match(echoes[1].text, /being continued from a previous conversation/);
  assert.equal(echoes[1].skillLoad, undefined, 'an id-less isMeta line is never a skill load');
  assert.deepEqual(echoes[2].skillLoad, { skill: 'keybindings-help' },
    'and it did not consume the entry its real injection needs');
});

function unknownSourceIdLines() {
  return [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'load a skill' } },
    {
      type: 'assistant', uuid: 'a0',
      message: {
        id: 'm_1', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'keybindings-help' } }],
      },
    },
    // An injected line belonging to some OTHER tool — its id names nothing in
    // the pending queue.
    {
      type: 'user', uuid: 'u1', isMeta: true, sourceToolUseID: 'tu_unrelated_tool',
      message: { role: 'user', content: [{ type: 'text', text: 'output injected by an unrelated tool' }] },
    },
    {
      type: 'user', uuid: 'u2', isMeta: true, sourceToolUseID: 'tu_skill',
      message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nreference' }] },
    },
  ];
}

test('loadPersistedTranscript: an injection whose sourceToolUseID names nothing pending claims nothing', async () => {
  await seedTranscript(unknownSourceIdLines());
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  const echoes = flatEvents(result).filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 3);
  assert.equal(echoes[1].skillLoad, undefined, 'an unmatched id must not fall back to the FIFO head');
  assert.deepEqual(echoes[2].skillLoad, { skill: 'keybindings-help' },
    'and must not have consumed the entry either');
});

function queuedPromptDuringSkillLines() {
  return [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'load a skill' } },
    {
      type: 'assistant', uuid: 'a0',
      message: {
        id: 'm_1', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'keybindings-help' } }],
      },
    },
    // The user types while the turn is still running. The CLI persists that as
    // a queued_command attachment rather than a `type:"user"` line — it is a
    // genuine prompt and carries no injection marker.
    {
      type: 'attachment', uuid: 'u1',
      attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'actually, hold on' }] },
    },
  ];
}

test('loadPersistedTranscript: a queued_command prompt is a real user turn, never tagged as a skill load', async () => {
  await seedTranscript(queuedPromptDuringSkillLines());
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  const echoes = flatEvents(result).filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 2);
  assert.equal(echoes[1].text, 'actually, hold on');
  assert.equal(echoes[1].skillLoad, undefined,
    'the user\'s own typed prompt must never render as "Loading skill: …"');
});

test('loadPersistedTranscript: a queued_command prompt expires the pending queue, so a later injection for the interrupted Skill claims nothing', async () => {
  // The positive half of the call site's purpose. Not tagging the queued
  // prompt is achievable by doing nothing at all; expiring is the behaviour
  // that call site exists for, and it is only observable downstream.
  await seedTranscript([
    ...queuedPromptDuringSkillLines(),
    {
      type: 'user', uuid: 'u2', isMeta: true, sourceToolUseID: 'tu_skill',
      message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nreference' }] },
    },
  ]);
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  const echoes = flatEvents(result).filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 3);
  assert.equal(echoes[2].skillLoad, undefined,
    'the genuine turn boundary expired tu_skill, so its late injection has nothing to correlate with');
});

test('loadPersistedTranscript: isVisibleInTranscriptOnly marks a line as CLI-injected too, so it does not expire a pending Skill', async () => {
  // 21 lines in the persisted corpus carry isVisibleInTranscriptOnly WITHOUT
  // isMeta (compaction continuations). The CLI's own stdout builder maps
  // isSynthetic = isMeta || isVisibleInTranscriptOnly, so dropping the second
  // term here would classify those 21 as real user turns and expire a pending
  // entry that a later injection still needs.
  await seedTranscript([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'load a skill' } },
    {
      type: 'assistant', uuid: 'a0',
      message: {
        id: 'm_1', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'keybindings-help' } }],
      },
    },
    {
      type: 'user', uuid: 'u1', isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation...' }] },
    },
    {
      type: 'user', uuid: 'u2', isMeta: true, sourceToolUseID: 'tu_skill',
      message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nreference' }] },
    },
  ]);
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  const echoes = flatEvents(result).filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 3);
  assert.equal(echoes[1].skillLoad, undefined, 'the continuation line is not itself a skill load');
  assert.deepEqual(echoes[2].skillLoad, { skill: 'keybindings-help' },
    'and it did not expire the entry the real injection needs');
});

test('loadPersistedTranscript: a matched injection consumes its entry, so a repeated sourceToolUseID claims nothing', async () => {
  await seedTranscript([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'load a skill' } },
    {
      type: 'assistant', uuid: 'a0',
      message: {
        id: 'm_1', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'keybindings-help' } }],
      },
    },
    {
      type: 'user', uuid: 'u1', isMeta: true, sourceToolUseID: 'tu_skill',
      message: { role: 'user', content: [{ type: 'text', text: '# Keybindings Skill\n\nreference' }] },
    },
    // A second line naming the same tool_use. The entry is spent.
    {
      type: 'user', uuid: 'u2', isMeta: true, sourceToolUseID: 'tu_skill',
      message: { role: 'user', content: [{ type: 'text', text: 'trailing injected content for the same tool' }] },
    },
  ]);
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  const echoes = flatEvents(result).filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 3);
  assert.deepEqual(echoes[1].skillLoad, { skill: 'keybindings-help' });
  assert.equal(echoes[2].skillLoad, undefined, 'the matched entry was consumed, not just read');
});

function orphanedSkillSessionLines() {
  return [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'what are the default keybindings?' } },
    {
      type: 'assistant', uuid: 'a0',
      message: {
        id: 'm_skill', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'keybindings-help', args: 'what are the default keybindings?' } }],
      },
    },
    // The skill lookup fails — tool_result errors, no content-injection
    // line ever follows for tu_skill.
    {
      type: 'user', uuid: 'u1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_skill', content: 'skill not found', is_error: true }] },
    },
    { type: 'assistant', uuid: 'a1', message: { id: 'm_reply', role: 'assistant', content: [{ type: 'text', text: 'Sorry, that skill was not found.' }] } },
    // Conversation continues normally with a genuine user turn.
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'no worries, what else can you do?' } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm_reply2', role: 'assistant', content: [{ type: 'text', text: 'Here are some options...' }] } },
    // A later, unrelated injected message (Stop-hook feedback style) must not
    // inherit the orphaned tu_skill entry.
    {
      type: 'user', uuid: 'u3', isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'Stop hook feedback:\n[wrap up the conversation]' }] },
    },
  ];
}

// Regression guard rather than a mutation-killing test: on the jsonl surface,
// identity matching already makes the mislabel impossible, so dropping the
// errored entry is no longer separately observable here. That bound is pinned
// where it is still load-bearing — the stdout/FIFO surface, in parser.test.mjs.
test('loadPersistedTranscript: an orphaned Skill tool_use (errored, no content injection) does not mislabel a later unrelated injected message', async () => {
  await seedTranscript(orphanedSkillSessionLines());
  const result = await loadPersistedTranscript({ cwd: CWD, sessionId: SID });
  assert.ok(result, 'transcript loaded');
  const events = flatEvents(result);

  const toolResult = events.find(ev => ev.kind === 'tool_result' && ev.toolUseId === 'tu_skill');
  assert.ok(toolResult);
  assert.equal(toolResult.isError, true);

  const echoes = events.filter(ev => ev.kind === 'user_echo');
  assert.equal(echoes.length, 3, 'the two real prompts and the later unrelated injected line each produce a user_echo');
  const laterInjected = echoes[echoes.length - 1];
  assert.match(laterInjected.text, /Stop hook feedback/);
  assert.equal(laterInjected.skillLoad, undefined, 'the orphaned entry must not attach to this unrelated message');
});
