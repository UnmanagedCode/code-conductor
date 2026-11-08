// Control for tests/auto-background-cli.real.test.mjs: the same real worker and
// run_code call with MCP auto-background OFF. Skipped by default; opt in with
// RUN_REAL_CLAUDE=1 (uses your real auth, cheap haiku turns, about 30 s):
//
//   RUN_REAL_CLAUDE=1 node tests/run.mjs tests/auto-background-cli-control.real.test.mjs
//
// Shows the toggle is what causes the backgrounding: the call returns inline,
// no mcp_task starts, and the turn ends once. Rig: tests/autoBackgroundCli.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRealWorker, wakes, turnEnds, runCodeResult, resultText } from './autoBackgroundCli.mjs';

const t = process.env.RUN_REAL_CLAUDE ? test : test.skip.bind(test);

t('real claude through cc: with the toggle off the same run_code call returns inline and no mcp_task starts', async () => {
  const { log, spawnEnv } = await runRealWorker({ enabled: false, done: ({ log }) => wakes(log).length >= 1 && turnEnds(log).length >= 1 });
  assert.equal('CLAUDE_AUTO_BACKGROUND_TASKS' in spawnEnv, false);
  assert.equal('CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS' in spawnEnv, false);
  assert.equal(log.some((e) => e.src === 'event' && e.ev.kind === 'system' && e.ev.subtype === 'task_started'
    && e.ev.data?.task_type === 'mcp_task'), false, 'no mcp_task starts');
  assert.equal(turnEnds(log).length, 1);
  const result = runCodeResult(log);
  assert.ok(result, 'the run_code call returned a tool_result');
  assert.doesNotMatch(resultText(result), /moved to the background/);
  assert.match(resultText(result), /SLEPT/);
});
