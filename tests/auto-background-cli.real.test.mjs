// Real Claude Code behind a real cc, MCP auto-background ON. Skipped by
// default; opt in with RUN_REAL_CLAUDE=1 (uses your real auth, a few cheap
// haiku turns, about 40 s):
//
//   RUN_REAL_CLAUDE=1 node tests/run.mjs tests/auto-background-cli.real.test.mjs
//
// The worker's run_code call outlives the threshold, so the CLI moves it to the
// background as an mcp_task; the first turn ends while it runs, the CLI opens
// its own turn when it completes, and the owner is woken once, after that turn.
// The control with the toggle off is tests/auto-background-cli-control.real.test.mjs.
// Rig: tests/autoBackgroundCli.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRealWorker, events, wakes, turnEnds, THRESHOLD_MS } from './autoBackgroundCli.mjs';

const t = process.env.RUN_REAL_CLAUDE ? test : test.skip.bind(test);

t('real claude through cc: a slow run_code call is backgrounded at the threshold and the owner gets one wake after the follow-up turn', async () => {
  const { log, spawnEnv } = await runRealWorker({
    enabled: true,
    done: ({ log }) => wakes(log).length >= 1 && turnEnds(log).length >= 2,
  });
  assert.equal(spawnEnv.CLAUDE_AUTO_BACKGROUND_TASKS, '1');
  assert.equal(spawnEnv.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, String(THRESHOLD_MS));
  assert.equal(spawnEnv.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, '10000');

  const evs = events(log);
  const started = log.findIndex((e) => e.src === 'event' && e.ev.kind === 'system' && e.ev.subtype === 'task_started'
    && e.ev.data?.task_type === 'mcp_task');
  assert.ok(started >= 0, `no task_started mcp_task — kinds: ${evs.map((e) => e.ev.kind + (e.ev.subtype ? `/${e.ev.subtype}` : '')).join(',')}`);
  const firstTurnEnd = turnEnds(log)[0];
  assert.equal(firstTurnEnd.activeAgentTasks, 1, 'the first turn ends while the mcp_task runs');

  const ws = wakes(log);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].opts.exited, false);
  assert.equal(ws[0].opts.timedOut, false);
  assert.ok(ws[0].taskNotificationsSeen >= 1, 'woken only after the task notification');
  const wakeAt = log.indexOf(ws[0]);
  assert.ok(wakeAt > log.indexOf(firstTurnEnd), 'not woken at the first turn_end');
});
