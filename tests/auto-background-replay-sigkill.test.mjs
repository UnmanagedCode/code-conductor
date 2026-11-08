// DERIVED from the mcp-bg-sigterm-flag1 capture (CLI 2.1.316, auto-background
// on): the CLI is SIGKILLed instead, so it sends none of the terminal task
// frames a SIGTERM produces. The dead worker must still report no running
// agent (Instance._handleExit clears the count), and the owner's single EXITED
// wake is unchanged. Rig: tests/autoBackgroundReplay.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayCell, firstPrompt, turnEnded, pause, SETTLE_WAIT_MS } from './autoBackgroundReplay.mjs';

test('SIGKILL with a pending MCP task: the dead worker reports no running agents; one EXITED wake', async () => {
  const cell = 'mcp-bg-sigterm-flag1';
  let premise;
  const out = await replayCell(cell, async (c) => {
    await c.dispatch(firstPrompt(cell));
    await turnEnded(c); await c.idle(); await pause(3000);
    premise = c.worker.activeAgentTaskCount;
    c.worker.proc.kill('SIGKILL');
    await c.gone(); await pause(SETTLE_WAIT_MS);
  });
  assert.equal(premise, 1, 'premise: the MCP task was still counted when the CLI was killed');
  assert.equal(out.final.status, 'crashed');
  assert.equal(out.final.activeAgentTasks, 0);
  assert.equal(out.final.display, 'crashed');
  const edges = out.log.filter((e) => e.src === 'status-edge');
  assert.equal(edges.at(-1).summary.activeAgentTasks, 0);
  assert.equal(out.wakes.length, 1);
  assert.equal(out.wakes[0].opts.exited, true);
});
