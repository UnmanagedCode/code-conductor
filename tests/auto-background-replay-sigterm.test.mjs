// Replayed capture (CLI 2.1.316, auto-background on): the CLI is SIGTERMed
// while its backgrounded MCP task is pending. It emits the terminal task frames
// before exiting, so the count is clear before the exit; the owner gets one
// EXITED wake. Rig: tests/autoBackgroundReplay.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayCell, firstPrompt, turnEnded, pause, SETTLE_WAIT_MS } from './autoBackgroundReplay.mjs';

test('SIGTERM with a pending MCP task: terminal frames clear the count before exit; one EXITED wake', async () => {
  const cell = 'mcp-bg-sigterm-flag1';
  let premise;
  let countBeforeExit;
  const out = await replayCell(cell, async (c) => {
    await c.dispatch(firstPrompt(cell));
    await turnEnded(c); await c.idle(); await pause(3000);
    premise = c.worker.activeAgentTaskCount;
    // The count as of the CLI's exit event, read ahead of cc's own exit
    // listener (and so before _handleExit's clear).
    c.worker.proc.prependOnceListener('exit', () => { countBeforeExit = c.worker.activeAgentTaskCount; });
    c.worker.proc.kill('SIGTERM');
    await c.gone(); await pause(SETTLE_WAIT_MS);
  });
  assert.equal(premise, 1, 'premise: the MCP task was counted when the CLI was signalled');
  assert.equal(countBeforeExit, 0, 'the terminal task frames cleared the count before the CLI exited');
  assert.equal(out.wakes.length, 1);
  assert.equal(out.wakes[0].opts.exited, true);
  assert.equal(out.final.status, 'crashed');
  assert.equal(out.final.activeAgentTasks, 0);
  assert.equal(out.final.armedAfter, false);
});
