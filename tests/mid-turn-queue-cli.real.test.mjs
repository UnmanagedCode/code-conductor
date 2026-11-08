// THE CLI-CONTRACT REGRESSION TEST for a message written into a RUNNING turn
// (Instance.queuedPromptPending, IdleSubscriptionHub._parked). Skipped by
// default — opt in with `RUN_CLI_CONTRACT=1`:
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/mid-turn-queue-cli.real.test.mjs
//
// The hold rests on undocumented Claude Code behaviour a CLI upgrade could
// change silently:
//   * a message written with no top-level tool round-trip before the turn ends
//     is QUEUED: the turn's `result` is followed by a `system/init` for a new
//     turn, and the session jsonl records `enqueue` then `dequeue` for it;
//   * a message written while a top-level tool call is running is FOLDED into
//     that turn at the tool's result: no second `result`, and the jsonl records
//     `enqueue` then `remove` plus a `queued_command` attachment.
// A fold leaves no stdout frame, so the jsonl is the only mechanical evidence.
//
// Harness and the two rules every case follows: tests/cliContractCase.mjs.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encodeCwd } from '../src/projects.ts';
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
const ops = (lines, operation) => lines.filter((l) => l.type === 'queue-operation' && l.operation === operation);
const isResult = (f) => f.type === 'result';

// PINS: a message written right after the turn's init, before any tool call, is
// queued — a second `result`-delimited turn opens (init after the first result)
// and the jsonl dequeues both messages with nothing removed.
t('a message written before any tool round-trip is queued as its own turn', async () => {
  const { dir, clean } = await fixture();
  const s = claudeSession({ cwd: dir, settings: '{}' });
  try {
    s.prompt('Reply with the single word ALPHA.');
    const init = await s.waitFor((f) => f.type === 'system' && f.subtype === 'init', 120_000);
    s.prompt('Reply with the single word OMEGA.');
    const first = await s.waitFor(isResult, 120_000);
    const second = await s.waitFor((f) => isResult(f) && f !== first, 120_000);
    const between = s.events.slice(s.events.indexOf(first) + 1, s.events.indexOf(second));
    assert.ok(between.some((f) => f.type === 'system' && f.subtype === 'init'),
      'a new turn opened after the first result');

    const lines = await jsonl(dir, init.session_id);
    assert.equal(ops(lines, 'enqueue').length, 2, 'both messages were enqueued');
    assert.equal(ops(lines, 'dequeue').length, 2, 'both became turns');
    assert.equal(ops(lines, 'remove').length, 0, 'none was folded');
  } finally {
    s.kill();
    await clean();
  }
});

// PINS: a message written while a top-level Bash call is running is folded into
// that turn — the jsonl removes it from the queue and carries it as a
// queued_command attachment, and only the first message was ever dequeued.
t('a message written during a top-level tool call is folded into the running turn', async () => {
  const { dir, clean } = await fixture();
  const s = claudeSession({ cwd: dir, settings: '{}' });
  try {
    s.prompt('Use the Bash tool to run exactly: sleep 8\nThen reply with the single word ALPHA.');
    const init = await s.waitFor((f) => f.type === 'system' && f.subtype === 'init', 120_000);
    await s.waitFor((f) => f.type === 'assistant' && !f.parent_tool_use_id
      && f.message.content.some((c) => c.type === 'tool_use'), 120_000);
    s.prompt('Also reply with the single word OMEGA.');
    await s.waitFor(isResult, 180_000);

    const lines = await jsonl(dir, init.session_id);
    assert.equal(ops(lines, 'enqueue').length, 2, 'both messages were enqueued');
    assert.equal(ops(lines, 'remove').length, 1, 'the second was removed from the queue');
    assert.equal(ops(lines, 'dequeue').length, 1, 'only the first became a turn');
    assert.ok(lines.some((l) => l.type === 'attachment' && l.attachment?.type === 'queued_command'),
      'the folded message rides in as a queued_command attachment');
  } finally {
    s.kill();
    await clean();
  }
});
