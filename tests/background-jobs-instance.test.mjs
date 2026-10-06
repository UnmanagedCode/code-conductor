// Instance's background Bash job tracking (`_backgroundJobs`, summary()'s
// `backgroundJobs`), driven by a bare Instance's _handleStdoutLine with no
// subprocess. Display-only: jobs never touch `displayStatus` or the Agent count.
//
// Fixture: tests/fixtures/bg-bash-jobs.stdout.jsonl, a committed trim of real
// Claude Code CLI 2.1.286 `-p --input-format=stream-json
// --output-format=stream-json --verbose` stdout, one session per case (keyed by
// its scrubbed session_id below). Kept: the init frame (cwd, session_id, model,
// permissionMode, claude_code_version only), every task_* /
// background_tasks_changed / assistant / user / result frame. Dropped:
// stream_event partials (the capture ran without --include-partial-messages),
// thinking_tokens and rate_limit_event frames, and every frame's uuid,
// request_id and timestamp. Thinking text is emptied and signatures replaced by
// "[trimmed]"; tool-result bodies over 300 chars are shortened. The cwd is
// scrubbed to `/workspace/project` and the CLI's task output dir to
// `/tmp/claude-UID/-workspace-project/`.
//   E1 bg Bash "sleep probe" that exits while the worker is idle
//   E2 bg Bash "long sleeper" stopped by the model's TaskStop
//   E3 bg Bash with no description and a 200-char command (shares E5's session)
//   E4 bg Bash with no description + a bg Agent, one snapshot listing both
//   E5 a bg Agent whose subagent starts its own bg Bash "sub sleeper"
//   E6 bg Bash "eof sleeper" stopped by the CLI's own stdin-EOF shutdown
//
// Without partial messages the stream has no message_start, so `feed` injects
// one before each top-level assistant frame that arrives while idle — the frame
// cc's real launch sees at that point, and what flips an unprompted
// re-invocation turn to `turn`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Instance } from '../src/instances.ts';
import { JOB_TITLE_MAX } from '../src/backgroundJobs.ts';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bg-bash-jobs.stdout.jsonl');
const FRAMES = readFileSync(FX, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SESSION = {
  E1: 'e1000000-0000-4000-8000-000000000001',
  E2: 'e2000000-0000-4000-8000-000000000002',
  E4: 'e4000000-0000-4000-8000-000000000004',
  E35: 'e3000000-0000-4000-8000-000000000035',
  E6: 'e6000000-0000-4000-8000-000000000006',
};
const framesOf = (k) => FRAMES.filter((f) => f.session_id === SESSION[k]);

function makeInstance() {
  const inst = new Instance({
    id: 'i-bgjobs', project: 'demo', cwd: '/nonexistent-cwd',
    mode: 'bypassPermissions', effort: 'high', thinking: 'adaptive', model: null,
  });
  const statuses = [];
  inst.on('status', (s) => statuses.push(s));
  return { inst, statuses };
}

const MSG_START = JSON.stringify({
  type: 'stream_event',
  event: { type: 'message_start', message: { id: 'm', role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 1, output_tokens: 0 } } },
});
function feedOne(inst, f) {
  if (f.type === 'assistant' && !f.parent_tool_use_id && inst.status === 'idle') inst._handleStdoutLine(MSG_START);
  inst._handleStdoutLine(JSON.stringify(f));
}
// Feed frames up to and including the first one matching `until` (all when absent).
// Returns the frames left over.
function feed(inst, frames, until) {
  let i = 0;
  for (; i < frames.length; i++) {
    feedOne(inst, frames[i]);
    if (until && until(frames[i])) return frames.slice(i + 1);
  }
  return [];
}
const isSnapshot = (f) => f.type === 'system' && f.subtype === 'background_tasks_changed';
const isResult = (f) => f.type === 'result';
const titles = (inst) => inst.summary().backgroundJobs.map((j) => j.title);

test('start: a bg Bash job is tracked from its snapshot; the worker still reads plain idle', () => {
  const { inst, statuses } = makeInstance();
  const before = Date.now();
  const rest = feed(inst, framesOf('E1'), isSnapshot);
  const emitted = statuses.at(-1);
  assert.deepEqual(emitted.backgroundJobs.map((j) => j.title), ['sleep probe'],
    'the snapshot itself emits a status carrying the job');
  feed(inst, rest, isResult);
  const s = inst.summary();
  assert.deepEqual(titles(inst), ['sleep probe']);
  assert.ok(s.backgroundJobs[0].startedAt >= before && s.backgroundJobs[0].startedAt <= Date.now(),
    'startedAt is cc\'s clock at the snapshot');
  assert.equal(s.status, 'idle');
  assert.equal(s.displayStatus, 'idle', 'a job never overlays displayStatus');
  assert.equal(s.activeAgentTasks, 0, 'a job is not an Agent task');
});

test('start: exactly one status emission per membership change, none for an unchanged snapshot', () => {
  const { inst, statuses } = makeInstance();
  const frames = framesOf('E1');
  const snap = frames.find(isSnapshot);
  inst._handleStdoutLine(JSON.stringify(snap));
  assert.equal(statuses.length, 1);
  inst._handleStdoutLine(JSON.stringify(snap));
  assert.equal(statuses.length, 1, 'a repeated snapshot changes nothing and emits nothing');
});

test('exit: the empty snapshot when the job exits clears it and emits', () => {
  const { inst, statuses } = makeInstance();
  const rest = feed(inst, framesOf('E1'), isResult);
  assert.deepEqual(titles(inst), ['sleep probe']);
  const n = statuses.length;
  const after = feed(inst, rest, isSnapshot);
  assert.deepEqual(titles(inst), []);
  assert.equal(statuses.length, n + 1);
  assert.deepEqual(statuses.at(-1).backgroundJobs, [], 'the emission carries the cleared list');
  feed(inst, after);
  assert.deepEqual(titles(inst), [], 'the re-invocation turn leaves it clear');
});

test('stop: a TaskStop clears the job', () => {
  const { inst } = makeInstance();
  const frames = framesOf('E2');
  const rest = feed(inst, frames, isSnapshot);
  assert.deepEqual(titles(inst), ['long sleeper']);
  feed(inst, rest);
  assert.deepEqual(titles(inst), []);
});

test('EOF: the CLI\'s stdin-EOF shutdown clears the job', () => {
  const { inst } = makeInstance();
  const rest = feed(inst, framesOf('E6'), isResult);
  assert.deepEqual(titles(inst), ['eof sleeper']);
  feed(inst, rest);
  assert.deepEqual(titles(inst), []);
});

test('mixed: Agent + Bash — the agent overlays running, the job alone leaves idle', () => {
  const { inst } = makeInstance();
  const rest = feed(inst, framesOf('E4'), isResult);
  let s = inst.summary();
  assert.equal(s.activeAgentTasks, 1);
  assert.equal(s.backgroundJobs.length, 1);
  assert.equal(s.displayStatus, 'running');
  // Through the agent's completion (its task_notification), before the job exits.
  feed(inst, rest, (f) => f.type === 'system' && f.subtype === 'task_notification' && f.task_id.startsWith('a'));
  s = inst.summary();
  assert.equal(s.activeAgentTasks, 0);
  assert.deepEqual(titles(inst), ['sleep 20; echo x'], 'no description → the command is the title');
  assert.equal(s.status, 'idle');
  assert.equal(s.displayStatus, 'idle');
});

test('no description: a 200-char command is titled truncated to JOB_TITLE_MAX', () => {
  const { inst } = makeInstance();
  feed(inst, framesOf('E35'), isSnapshot);
  const [title] = titles(inst);
  assert.equal(title.length, JOB_TITLE_MAX);
  assert.ok(title.startsWith('sleep 12; echo aaaa') && title.endsWith('…'), title);
});

test('subagent-owned: a subagent\'s own bg Bash counts after its Agent task is gone', () => {
  const { inst } = makeInstance();
  const frames = framesOf('E35');
  // Up to the snapshot that follows the top-level job's exit: only the
  // subagent's job is left, and the Agent task completed earlier.
  const at = frames.findIndex((f) => isSnapshot(f) && f.tasks.length === 1 && f.tasks[0].description === 'sub sleeper');
  assert.ok(at > 0, 'fixture carries the subagent-only snapshot');
  feed(inst, frames.slice(0, at + 1));
  const s = inst.summary();
  assert.equal(s.activeAgentTasks, 0, 'the Agent task already completed');
  assert.deepEqual(titles(inst), ['sub sleeper']);
  feed(inst, frames.slice(at + 1));
  assert.deepEqual(titles(inst), []);
});

for (const [label, code, signal, expected] of [
  ['exit', 0, null, 'exited'],
  ['crash', null, 'SIGKILL', 'crashed'],
]) {
  test(`${label}: _handleExit clears the jobs in the very status emission that carries '${expected}'`, () => {
    const { inst, statuses } = makeInstance();
    feed(inst, framesOf('E1'), isResult);
    assert.equal(titles(inst).length, 1);
    inst._handleExit(code, signal, Promise.resolve(''));
    const exitEmission = statuses.find((s) => s.status === expected);
    assert.ok(exitEmission, `a status emission carries ${expected}`);
    assert.deepEqual(exitEmission.backgroundJobs, []);
    assert.deepEqual(titles(inst), []);
  });
}

test('respawn: spawn() starts with no jobs', () => {
  const { inst } = makeInstance();
  feed(inst, framesOf('E1'), isResult);
  assert.equal(titles(inst).length, 1);
  // A backend missing from the registry makes spawn() refuse right after its
  // per-launch resets, before any process exists.
  inst.backend = 'no-such-backend';
  assert.throws(() => inst.spawn(), /no longer exists/);
  assert.deepEqual(titles(inst), []);
});
