// Replayed capture (CLI 2.1.316, auto-background on): an MCP call backgrounded
// at the threshold. The first turn_end lands while its mcp_task runs, so the
// owner's wake is deferred; the CLI opens its own turn when the task completes,
// and the owner is woken once, after that turn. Rig: tests/autoBackgroundReplay.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayCell, firstPrompt, pause, SETTLE_WAIT_MS } from './autoBackgroundReplay.mjs';

test('backgrounded MCP call: the first turn_end defers, one wake follows the self-started turn', async () => {
  const cell = 'mcp-s150-flag1';
  const out = await replayCell(cell, async (c) => {
    await c.dispatch(firstPrompt(cell)); await c.replayDone(); await c.idle(); await pause(SETTLE_WAIT_MS);
  });
  assert.ok(out.log.some((e) => e.what === 'system/task_started' && e.taskType === 'mcp_task' && e.activeAgentTasks === 1),
    'the mcp_task is counted');
  const turnEnds = out.log.filter((e) => e.what.startsWith('turn_end'));
  assert.equal(turnEnds[0].display, 'running');
  assert.equal(turnEnds[0].activeAgentTasks, 1);
  assert.equal(turnEnds[0].wakeArmed, true);
  assert.equal(out.wakes.length, 1);
  assert.ok(out.wakes[0].taskNotificationsSeen >= 1, 'never woken while the MCP task was still running');
  assert.equal(out.wakes[0].opts.exited, false);
  assert.equal(out.wakes[0].opts.timedOut, false);
  assert.equal(out.final.activeAgentTasks, 0);
});
