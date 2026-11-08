// Replayed capture (CLI 2.1.316, auto-background on): cc's own kill (stdin
// close first) while the backgrounded MCP task is pending. A commanded kill
// wakes nobody about the stopped task (a documented known gap) and leaves no
// agent count. Rig: tests/autoBackgroundReplay.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayCell, firstPrompt, turnEnded, pause, SETTLE_WAIT_MS } from './autoBackgroundReplay.mjs';

test('commanded kill with a pending MCP task wakes nobody and leaves no agent count (known gap b)', async () => {
  const cell = 'mcp-bg-stdin-close-flag1';
  let premise;
  const out = await replayCell(cell, async (c) => {
    await c.dispatch(firstPrompt(cell));
    await turnEnded(c); await c.idle(); await pause(3000);
    premise = c.worker.activeAgentTaskCount;
    await c.worker.kill({ graceMs: 4000 });
    await c.gone(); await pause(SETTLE_WAIT_MS);
  });
  assert.equal(premise, 1, 'premise: the MCP task was still counted when cc killed the worker');
  assert.equal(out.wakes.length, 0, 'a commanded kill wakes nobody');
  assert.equal(out.final.status, 'exited');
  assert.equal(out.final.activeAgentTasks, 0);
  assert.equal(out.final.lastExit, null);
});
