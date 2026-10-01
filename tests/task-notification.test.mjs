// Background-task notifications on both surfaces (src/taskNotification.ts): the
// live stdout `system/task_notification` frame and the persisted
// `queue-operation` `enqueue` line become the SAME `system`/`task_notification`
// UI event, and only a backgrounded task that completed or failed is marked
// `data.notified` (the one field the client filter and the event archive read).
//
// Fixtures: three committed trims of real CLI 2.1.286 sessions, each a stdout
// capture paired with that session's jsonl.
//   task-notification.*         — C1 bg Bash ok, C2 bg Bash exit 3, C3 bg Bash
//                                 stopped by the model's TaskStop, C4 a foreground
//                                 Bash past its 3s timeout (the CLI killed it, exit
//                                 143, and emitted no task frames), C5 a foreground
//                                 Bash (no task frames at all), C6 bg Agent, C7
//                                 foreground Agent, C8 bg Bash with no description.
//   task-notification-monitor.* — M1 a Monitor whose stream ends, M2 a Monitor
//                                 whose script exits 4.
//   task-notification-killed.*  — C9 a bg `sleep 600` whose CLI got SIGTERM.
// Kept: the init frame (its long arrays, paths and account fields dropped), every
// task_* frame, the assistant/user/result frames, and every queue-operation,
// user and assistant line. Dropped: stream_event partials, hook/status frames,
// and the jsonl's environment/credential/bookkeeping attachments. Tool-result
// bodies over 300 chars are shortened, thinking signatures replaced by
// "[trimmed]". The cwd is scrubbed to `/workspace/project` and the CLI's task
// output dir to `/tmp/claude-UID/-workspace-project/` identically in both files
// of a pair, so live-equals-replay still holds.
//
// Measured on these captures, and what each case pins:
//   * C3 (TaskStop): live status `stopped`, summary is the bare description,
//     and the jsonl holds NO enqueue. C9 (SIGTERM): live status `stopped` with an
//     empty output_file, while the jsonl's enqueue says `killed`. A stop is
//     therefore hidden on both paths — never a line.
//   * C7: a foreground Agent's frame carries a non-empty output_file and has no
//     enqueue, so `output_file` is not evidence of backgrounding;
//     `task_started.is_backgrounded` is.
//   * C9 settles the never-delivered enqueue question: the live frame DID reach
//     stdout, so replay needs no delivered-set pre-pass — and the enqueue it left
//     replays nothing because its status is `killed`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from '../src/parser.ts';
import { replayPersistedLine, loadPersistedTranscript } from '../src/transcript.ts';
import { parseTaskSentence, sentenceExitCode } from '../src/taskNotification.ts';
import { localPlace } from '../src/projects.ts';
import { freshProjectsRoot, seedSessionJsonl, rmrf } from './helpers.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJsonl = async (name) =>
  (await fs.readFile(path.join(FX, name), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

const MAIN = 'task-notification';
const MON = 'task-notification-monitor';
const KILLED = 'task-notification-killed';

// The cases, by the CLI's tool_use_id. `expect` is an independent oracle read off
// the captured frames by hand, not derived from the code under test.
const BG = {
  C1: { fx: MAIN, tu: 'toolu_018MKm8vtqnn6GpMTLzD3Ncu', expect: { task_id: 'byncs4grx', name: 'bg ok', status: 'completed', exitCode: 0, summary: 'Background command "bg ok" completed (exit code 0)' } },
  C2: { fx: MAIN, tu: 'toolu_014Qe3SFHbVz97n6YPVbuEzp', expect: { task_id: 'bnx1vv474', name: 'bg fail', status: 'failed', exitCode: 3, summary: 'Background command "bg fail" failed with exit code 3' } },
  C6: { fx: MAIN, tu: 'toolu_01D5PcgfmdTg99S49iVFZDfV', expect: { task_id: 'a2875fedbbe7c9b58', name: 'bg agent', status: 'completed', exitCode: null, summary: 'PONG' } },
  C8: { fx: MAIN, tu: 'toolu_01FyAAib3kfSLxs38Q5G8bz3', expect: { task_id: 'b756cnsny', name: 'ls / 2>&1 | head -3', status: 'completed', exitCode: 0, summary: 'Background command "ls / 2>&1 | head -3" completed (exit code 0)' } },
  M1: { fx: MON, tu: 'toolu_01S4K6rJAVqJtTydw6s4FGPz', expect: { task_id: 'b1xgba7gh', name: 'mon ok', status: 'completed', exitCode: null, summary: 'Monitor "mon ok" stream ended' } },
  M2: { fx: MON, tu: 'toolu_019DN4ZtKfGVSVbfnXtVK1Ff', expect: { task_id: 'b6mgtwblr', name: 'mon fail', status: 'failed', exitCode: 4, summary: 'Monitor "mon fail" script failed (exit 4)' } },
};
const C3 = 'toolu_0117VXbmgxC8rmKSvRi63e8e';
const C7 = 'toolu_012VgSmvzUktTsW7SkbfpLHq';
const C9 = 'toolu_015HCGTu537kiqG8N4tSdeN9';
const MAIN_BG = ['C1', 'C2', 'C6', 'C8'].map((k) => BG[k].tu);

const isTn = (e) => e.kind === 'system' && e.subtype === 'task_notification';

async function live(fx) {
  const parser = new Parser();
  return (await readJsonl(`${fx}.stdout.jsonl`)).flatMap((f) => parser.handleObject(f)).filter(isTn);
}
async function replayed(fx) {
  return (await readJsonl(`${fx}.transcript.jsonl`)).flatMap((l) => replayPersistedLine(l)).filter(isTn);
}
async function enqueueFor(fx, toolUseId) {
  const line = (await readJsonl(`${fx}.transcript.jsonl`)).find((l) => l.type === 'queue-operation'
    && typeof l.content === 'string' && l.content.includes(`<tool-use-id>${toolUseId}</tool-use-id>`));
  assert.ok(line, `fixture check: the ${toolUseId} enqueue is in ${fx}`);
  return line;
}

test('1: a backgrounded task\'s completed/failed frame becomes a notified task_notification event', async (t) => {
  for (const [label, c] of Object.entries(BG)) {
    await t.test(label, async () => {
      const evs = (await live(c.fx)).filter((e) => e.toolUseId === c.tu);
      assert.equal(evs.length, 1, 'one event for the one frame');
      const ev = evs[0];
      assert.equal(ev.data.notified, true);
      assert.equal(ev.data.task_id, c.expect.task_id, 'the wire task_id the lifecycle consumers read survives');
      assert.equal(ev.data.name, c.expect.name);
      assert.equal(ev.data.status, c.expect.status);
      assert.equal(ev.data.exitCode, c.expect.exitCode);
      assert.equal(ev.data.summary, c.expect.summary);
      assert.match(ev.data.output_file, new RegExp(`/tasks/${c.expect.task_id}\\.output$`));
    });
  }
});

test('2: a foreground Agent\'s frame is still emitted with its task_id, but not notified — despite its output_file', async () => {
  const evs = (await live(MAIN)).filter((e) => e.toolUseId === C7);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data.task_id, 'ad987b36813caf0b2');
  assert.notEqual(evs[0].data.output_file, '', 'fixture check: the foreground Agent frame carries an output_file');
  assert.equal(evs[0].data.notified, false);
});

test('3: a stopped task is never notified live (TaskStop and SIGTERM)', async (t) => {
  for (const [label, fx, tu] of [['C3 TaskStop', MAIN, C3], ['C9 SIGTERM', KILLED, C9]]) {
    await t.test(label, async () => {
      const evs = (await live(fx)).filter((e) => e.toolUseId === tu);
      assert.equal(evs.length, 1, 'the frame still reaches the lifecycle consumers');
      assert.equal(evs[0].data.status, 'stopped', 'fixture check: the CLI reports the stop as `stopped`');
      assert.ok(evs[0].data.task_id, 'task_id kept');
      assert.equal(evs[0].data.notified, false);
    });
  }
});

test('4: a live Agent event is named by its task_started description, not by its result text', async () => {
  const ev = (await live(MAIN)).find((e) => e.toolUseId === BG.C6.tu);
  assert.equal(ev.data.summary, 'PONG', 'fixture check: the live Agent summary is its result text');
  assert.equal(ev.data.name, 'bg agent');
  assert.equal(ev.data.exitCode, null);
});

test('5: status comes from the structured field, not from the sentence', async () => {
  const frames = await readJsonl(`${MAIN}.stdout.jsonl`);
  const parser = new Parser();
  let ev;
  for (const f of frames) {
    // The real C1 frame with only its structured status changed: the sentence
    // still says "completed".
    const g = f.type === 'system' && f.subtype === 'task_notification' && f.tool_use_id === BG.C1.tu ? { ...f, status: 'failed' } : f;
    const out = parser.handleObject(g).filter(isTn);
    if (g !== f) ev = out[0];
  }
  assert.equal(ev.data.status, 'failed');
  assert.equal(ev.data.notified, true);
});

// The CLI's sentence shapes, copied from real persisted <summary> lines (the
// quoted name and the numbers vary). name/exitCode only; status never comes from here.
const SENTENCES = [
  ['Background command "bg ok" completed (exit code 0)', { kind: 'command', name: 'bg ok' }, 0],
  ['Background command "grep x" completed (exit code 1: No matches found)', { kind: 'command', name: 'grep x' }, 1],
  ['Background command "bg fail" failed with exit code 3', { kind: 'command', name: 'bg fail' }, 3],
  ['Background command "bg doomed" was stopped', { kind: 'command', name: 'bg doomed' }, null],
  ['Background command "echo "quoted" twice" completed (exit code 0)', { kind: 'command', name: 'echo "quoted" twice' }, 0],
  ['Agent "bg agent" finished', { kind: 'agent', name: 'bg agent' }, null],
  ['Agent "build (exit code 2)" failed: the API returned an error', { kind: 'agent', name: 'build (exit code 2)' }, null],
  ['Monitor "mon ok" stream ended', { kind: 'monitor', name: 'mon ok' }, null],
  ['Monitor "mon fail" script failed (exit 4)', { kind: 'monitor', name: 'mon fail' }, 4],
  ['Monitor "tail" ended without producing output (exit 2)', { kind: 'monitor', name: 'tail' }, 2],
];

test('6: each real sentence shape yields its name and exit code', async (t) => {
  for (const [s, parsed, code] of SENTENCES) {
    await t.test(s, () => {
      assert.deepEqual(parseTaskSentence(s), parsed);
      assert.equal(sentenceExitCode(s), code);
    });
  }
  await t.test('a non-sentence', () => {
    assert.equal(parseTaskSentence('PONG'), null);
    assert.equal(sentenceExitCode('done (exit code 5)'), null, 'no exit code outside a recognised sentence');
  });
});

test('7: replaying a background case\'s enqueue yields exactly the live event', async (t) => {
  for (const [label, c] of Object.entries(BG)) {
    await t.test(label, async () => {
      const liveEv = (await live(c.fx)).find((e) => e.toolUseId === c.tu);
      const rep = replayPersistedLine(await enqueueFor(c.fx, c.tu));
      assert.equal(rep.length, 1);
      assert.deepEqual(rep[0], liveEv);
    });
  }
});

test('8: a notification\'s delivery lines replay nothing', async (t) => {
  const lines = await readJsonl(`${MAIN}.transcript.jsonl`);
  const enq = await enqueueFor(MAIN, BG.C1.tu);
  const delivered = lines.find((l) => l.type === 'user' && l.message?.content === enq.content);
  const dequeue = lines.find((l) => l.type === 'queue-operation' && l.operation === 'dequeue');
  assert.ok(delivered && dequeue, 'fixture check: the delivery user line and a dequeue are in the fixture');
  const cases = {
    'the <task-notification> user line': delivered,
    'a dequeue': dequeue,
    // Shapes from older sessions, built from this enqueue's real content.
    'a remove': { ...enq, operation: 'remove', reason: 'absorbed_mid_turn' },
    'a queued_command attachment': { type: 'attachment', uuid: 'att-tn', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: enq.content } },
  };
  for (const [label, line] of Object.entries(cases)) {
    await t.test(label, () => assert.deepEqual(replayPersistedLine(line), []));
  }
});

test('9: loadPersistedTranscript yields exactly one task_notification per background task', async () => {
  const { home } = await freshProjectsRoot();
  try {
    const place = localPlace('/workspace/project');
    const sid = '20594e65-2dd2-4118-83e5-7dd5d36ab56f';
    await seedSessionJsonl(place, sid, await readJsonl(`${MAIN}.transcript.jsonl`));
    const result = await loadPersistedTranscript({ place, sessionId: sid, seqHint: 0 });
    const tns = result.lines.flatMap((l) => l.events).filter(isTn);
    assert.deepEqual(tns.map((e) => e.toolUseId), MAIN_BG);
  } finally {
    await rmrf(home);
  }
});

test('10: a non-notification enqueue replays nothing', async (t) => {
  const contentless = (await readJsonl(`${MAIN}.transcript.jsonl`)).find((l) => l.type === 'queue-operation' && l.operation === 'enqueue' && l.content === undefined);
  assert.ok(contentless, 'fixture check: a content-less enqueue is in the fixture');
  const base = { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-01T00:00:00.000Z', sessionId: 's' };
  const cases = {
    'a content-less enqueue': contentless,
    'a queued user prompt': { ...base, content: 'please also run the tests' },
    'a prompt mentioning a notification past its start': { ...base, content: 'what does <task-notification><tool-use-id>t</tool-use-id><status>completed</status></task-notification> mean?' },
  };
  for (const [label, line] of Object.entries(cases)) {
    await t.test(label, () => assert.deepEqual(replayPersistedLine(line), []));
  }
});

test('11: an enqueue without a <tool-use-id>/<status> replays nothing', async (t) => {
  const monitorEvents = (await readJsonl(`${MON}.transcript.jsonl`)).filter((l) => l.type === 'queue-operation'
    && typeof l.content === 'string' && l.content.includes('Monitor event:'));
  assert.equal(monitorEvents.length, 2, 'fixture check: one Monitor-event enqueue per monitor');
  for (const line of monitorEvents) {
    await t.test(`Monitor event ${line.content.match(/<task-id>(\w+)/)[1]}`, () => assert.deepEqual(replayPersistedLine(line), []));
  }
  // A real line from a resumed session, verbatim.
  const noCompletion = {
    type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-06T16:31:05.195Z', sessionId: '618d9d98-a232-44ce-a97a-a2ebed620ed2',
    content: '<task-notification>\n<task-id>a528caa624d7c92ec</task-id>\n<task-id>a609e11e27ea0921b</task-id>\n<task-id>af2b816e8e0c5edda</task-id>\n<status>stopped</status>\n<summary>No completion record was found for 3 background agents from the previous session: "Map launcher and instance lifecycle" (a528caa624d7c92ec), "Map systems/ file bridge and session root" (a609e11e27ea0921b), "Map systems tests and gate" (af2b816e8e0c5edda). They may have been stopped, or they may have been running when the previous Claude Code process exited — either way their transcripts are saved, so their progress is not lost. Resume any of them by sending a message to its id with SendMessage, or check its worktree/output for partial work before assuming the task landed.</summary>\n</task-notification>',
  };
  await t.test('the multi-task "No completion record" line', () => assert.deepEqual(replayPersistedLine(noCompletion), []));
});

test('12: a killed or stopped enqueue replays nothing', async (t) => {
  const killed = await enqueueFor(KILLED, C9);
  assert.match(killed.content, /<status>killed<\/status>/, 'fixture check: the C9 enqueue is `killed`');
  await t.test('C9 killed', () => assert.deepEqual(replayPersistedLine(killed), []));
  await t.test('stopped', () => assert.deepEqual(replayPersistedLine({ ...killed, content: killed.content.replace('<status>killed</status>', '<status>stopped</status>') }), []));
});

// A recorded CLI fact, not a pin of the replay filter: there is nothing for
// replay to drop for these two, because the CLI never persists an enqueue.
test('13: the CLI persists no enqueue for a foreground Agent or a TaskStop\'d task', async () => {
  const enqueues = (await readJsonl(`${MAIN}.transcript.jsonl`)).filter((l) => l.type === 'queue-operation' && typeof l.content === 'string');
  assert.ok(enqueues.length > 0, 'fixture check: the main transcript holds enqueues');
  for (const [label, tu] of [['C7 foreground Agent', C7], ['C3 TaskStop', C3]]) {
    assert.equal(enqueues.some((l) => l.content.includes(tu)), false, label);
  }
});

test('13b: a SIGTERM\'d task\'s session replays no task_notification', async () => {
  assert.deepEqual(await replayed(KILLED), []);
});

test('14: the live stream yields exactly one notified event per background task', async (t) => {
  await t.test('main', async () => assert.deepEqual((await live(MAIN)).filter((e) => e.data.notified).map((e) => e.toolUseId), MAIN_BG));
  await t.test('monitor', async () => assert.deepEqual((await live(MON)).filter((e) => e.data.notified).map((e) => e.toolUseId), [BG.M1.tu, BG.M2.tu]));
  await t.test('killed', async () => assert.deepEqual((await live(KILLED)).filter((e) => e.data.notified), []));
});

test('15: replayed summaries and output paths are entity-unescaped', async (t) => {
  await t.test('C8 real bytes', async () => {
    const enq = await enqueueFor(MAIN, BG.C8.tu);
    assert.ok(enq.content.includes('2&gt;&amp;1'), 'fixture check: the jsonl escapes the command');
    const [ev] = replayPersistedLine(enq);
    assert.equal(ev.data.summary, BG.C8.expect.summary);
    assert.equal(ev.data.name, 'ls / 2>&1 | head -3');
  });
  await t.test('an escaped entity stays literal', async () => {
    // The C1 enqueue with a command whose text is the literal `&gt;` (so the CLI
    // writes `&amp;gt;`): unescaping `&amp;` first would turn it into `>`.
    const enq = await enqueueFor(MAIN, BG.C1.tu);
    const line = { ...enq, content: enq.content.replace('"bg ok"', '"echo &amp;gt; &lt;out&gt;"') };
    const [ev] = replayPersistedLine(line);
    assert.equal(ev.data.name, 'echo &gt; <out>');
  });
});

test('16: a frame with no task_started seen by this parser is hidden live; its enqueue still renders on replay', async () => {
  const frame = (await readJsonl(`${MAIN}.stdout.jsonl`)).find((f) => f.subtype === 'task_notification' && f.tool_use_id === BG.C1.tu);
  const [ev] = new Parser().handleObject(frame);
  assert.equal(ev.data.notified, false, 'no task_started → not known to be backgrounded');
  const [rep] = replayPersistedLine(await enqueueFor(MAIN, BG.C1.tu));
  assert.equal(rep.data.notified, true);
});

test('17: a background Agent that notifies again still renders', async () => {
  const frames = await readJsonl(`${MAIN}.stdout.jsonl`);
  const parser = new Parser();
  const evs = frames.flatMap((f) => parser.handleObject(f)).filter(isTn).filter((e) => e.toolUseId === BG.C6.tu);
  const again = frames.find((f) => f.subtype === 'task_notification' && f.tool_use_id === BG.C6.tu);
  const [second] = parser.handleObject({ ...again, status: 'failed', summary: 'second stop' });
  assert.equal(evs[0].data.notified, true);
  assert.equal(second.data.notified, true, 'the task_started record outlives an Agent\'s first notification');
  assert.equal(second.data.name, 'bg agent');
});

test('18: a live background Agent never takes an exit code from its result text, even when that text is a command sentence', async () => {
  const parser = new Parser();
  let ev;
  for (const f of await readJsonl(`${MAIN}.stdout.jsonl`)) {
    // The real C6 frame with only its summary (the Agent's result text) changed.
    const g = f.type === 'system' && f.subtype === 'task_notification' && f.tool_use_id === BG.C6.tu
      ? { ...f, summary: 'Background command "x" completed (exit code 0)' } : f;
    const out = parser.handleObject(g).filter(isTn);
    if (g !== f) ev = out[0];
  }
  assert.equal(ev.data.notified, true, 'fixture check: still the notified background Agent');
  assert.equal(ev.data.exitCode, null);
});

test('19: a queued prompt carrying a complete notification block after leading prose replays nothing', async () => {
  const enq = await enqueueFor(MAIN, BG.C1.tu);
  assert.deepEqual(replayPersistedLine({ ...enq, content: `please explain this:\n${enq.content}` }), []);
});

test('20: an enqueue with no <tool-use-id> replays nothing', async () => {
  const enq = await enqueueFor(MAIN, BG.C1.tu);
  const content = enq.content.replace(`<tool-use-id>${BG.C1.tu}</tool-use-id>\n`, '');
  assert.notEqual(content, enq.content, 'fixture check: the tag was removed');
  assert.deepEqual(replayPersistedLine({ ...enq, content }), []);
});

test('21: an enqueue naming two tasks replays nothing', async () => {
  const enq = await enqueueFor(MAIN, BG.C1.tu);
  const content = enq.content.replace('<task-id>byncs4grx</task-id>', '<task-id>byncs4grx</task-id>\n<task-id>bnx1vv474</task-id>');
  assert.notEqual(content, enq.content, 'fixture check: the second task-id was added');
  assert.deepEqual(replayPersistedLine({ ...enq, content }), []);
});

test('22: a task name containing a closing quote and a verb is captured whole', async (t) => {
  for (const [s, name, code] of [
    ['Background command "echo "x" completed" completed (exit code 0)', 'echo "x" completed', 0],
    ['Background command "echo "x" failed" failed with exit code 2', 'echo "x" failed', 2],
  ]) {
    await t.test(s, () => {
      assert.equal(parseTaskSentence(s)?.name, name);
      assert.equal(sentenceExitCode(s), code);
    });
  }
});
