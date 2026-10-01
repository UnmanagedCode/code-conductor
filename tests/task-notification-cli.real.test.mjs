// THE CLI-CONTRACT REGRESSION TEST for background-task notifications
// (src/taskNotification.ts). Skipped by default — opt in with
// `RUN_CLI_CONTRACT=1`:
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/task-notification-cli.real.test.mjs
//
// The feature rests on undocumented Claude Code behaviour that a CLI upgrade
// could change silently:
//   * a backgrounded task's stdout `system/task_notification` frame carries a
//     structured `status`, its `tool_use_id`, and a `summary` sentence holding
//     the exit code, and its `task_started` says `is_backgrounded:true`;
//   * the session jsonl gains a `queue-operation` `enqueue` holding the same
//     notification as `<task-notification>` XML, written at completion time, in
//     the frame's slot — the replay source and the archive correlation identity.
//
// Harness and the two rules every case follows: tests/cliContractCase.mjs.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encodeCwd } from '../src/projects.ts';
import { Parser } from '../src/parser.ts';
import { replayPersistedLine } from '../src/transcript.ts';
import { claudeSession, fixture, t } from './cliContractCase.mjs';

async function jsonl(cwd, sessionId) {
  const root = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const file = path.join(root, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
  const out = [];
  for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is not evidence either way */ }
  }
  return out;
}

// PINS: a failed background Bash yields a live notified `failed` event with exit
// code 3, the jsonl holds its enqueue in the frame's slot (before the turn's
// closing text that the frame precedes on stdout), and replaying that enqueue
// yields the live event exactly.
t('a failed background Bash notifies live and replays the identical event from its enqueue', async () => {
  const { dir, clean } = await fixture();
  const s = claudeSession({ cwd: dir, settings: '{}' });
  try {
    s.prompt('Use the Bash tool with run_in_background: true and description "bg fail" to run exactly: sleep 1; exit 3\n'
      + 'Then reply with the single word STARTED. Do not check on it.');
    const frame = await s.waitFor((f) => f.type === 'system' && f.subtype === 'task_notification', 120_000);
    // The CLI writes the jsonl as it goes; let the turn the notification opens finish.
    await s.waitFor((f) => f.type === 'result' && s.events.indexOf(f) > s.events.indexOf(frame), 120_000);

    const parser = new Parser();
    const liveEv = s.events.flatMap((f) => parser.handleObject(f))
      .find((e) => e.kind === 'system' && e.subtype === 'task_notification' && e.toolUseId === frame.tool_use_id);
    assert.equal(liveEv.data.notified, true);
    assert.equal(liveEv.data.status, 'failed');
    assert.equal(liveEv.data.exitCode, 3);
    assert.equal(liveEv.data.name, 'bg fail');

    const lines = await jsonl(dir, frame.session_id);
    const at = lines.findIndex((l) => l.type === 'queue-operation' && l.operation === 'enqueue'
      && typeof l.content === 'string' && l.content.includes(`<tool-use-id>${frame.tool_use_id}</tool-use-id>`));
    assert.ok(at >= 0, 'the jsonl holds the notification as a queue-operation enqueue');
    // The slot: the outer assistant messages bracketing the frame on stdout
    // bracket the enqueue in the jsonl.
    const fi = s.events.indexOf(frame);
    const outer = s.events.map((f, i) => ({ f, i })).filter(({ f }) => f.type === 'assistant' && !f.parent_tool_use_id);
    const before = outer.filter(({ i }) => i < fi).at(-1)?.f.message.id;
    const after = outer.find(({ i }) => i > fi)?.f.message.id;
    assert.ok(before, 'fixture check: an assistant message precedes the frame');
    const lastBefore = lines.findLastIndex((l) => l.type === 'assistant' && l.message?.id === before);
    assert.ok(lastBefore >= 0 && lastBefore < at, 'the enqueue follows the message the frame follows');
    if (after) {
      const firstAfter = lines.findIndex((l) => l.type === 'assistant' && l.message?.id === after);
      assert.ok(firstAfter > at, 'the enqueue precedes the message the frame precedes');
    }

    const [rep] = replayPersistedLine(lines[at]);
    assert.deepEqual(rep, liveEv, 'replay rebuilds the live event exactly');
  } finally {
    s.kill();
    await clean();
  }
});
