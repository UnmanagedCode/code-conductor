// Replayed capture (CLI 2.1.316, auto-background on): an Agent call made with
// run_in_background:false, force-backgrounded. The subagent's own Bash task
// (local_bash, subagent-owned) is never counted; the owner is woken once, after
// both task notifications. Rig: tests/autoBackgroundReplay.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayCell, firstPrompt, pause, SETTLE_WAIT_MS } from './autoBackgroundReplay.mjs';

test('force-backgrounded Agent: subagent-owned Bash never counts; one wake after both notifications', async () => {
  const cell = 'agent-fg-flag1';
  const out = await replayCell(cell, async (c) => {
    await c.dispatch(firstPrompt(cell)); await c.replayDone(); await c.idle(); await pause(SETTLE_WAIT_MS);
  });
  assert.equal(Math.max(...out.log.map((e) => e.activeAgentTasks)), 1, 'the subagent-owned local_bash task is never counted');
  assert.equal(out.log.filter((e) => e.what.startsWith('turn_end'))[0].display, 'running');
  assert.equal(out.wakes.length, 1);
  assert.equal(out.wakes[0].taskNotificationsSeen, 2, 'the wake follows both the subagent-owned and the agent task notifications');
  assert.equal(out.final.activeAgentTasks, 0);
});
