// The bounds code mode owns (src/codeMode/limits.ts) and how they relate to
// the ones around them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampRunCodeTimeoutMs, RUN_CODE_DEFAULT_TIMEOUT_MS, RUN_CODE_MAX_TIMEOUT_MS, CC_MCP_SERVER_TIMEOUT_MS,
  RUN_RESULT_CAP, RUN_LOGS_CAP, RUN_ERROR_MESSAGE_CAP, RUN_META_HEADROOM, PROGRESS_HEARTBEAT_MS, describeDuration,
} from '../src/codeMode/limits.ts';
import { clampBashTimeoutMs } from '../src/mcp/handlers.ts';
import { MCP_RESULT_CHAR_BUDGET } from '../src/mcp/content.ts';
import { capableTools } from '../src/mcp/tools.ts';
import { hostPlatform } from '../src/platform/index.ts';
import { assembleResult } from '../src/codeMode/runCode.ts';
import { buildMcpConfigJSON } from '../src/settings.ts';

test('the timeout clamp: a missing, non-numeric or non-positive value is the default; a large one is the max', () => {
  for (const bad of [undefined, null, 'x', 0, -5, NaN, Infinity]) {
    assert.equal(clampRunCodeTimeoutMs(bad), RUN_CODE_DEFAULT_TIMEOUT_MS, String(bad));
  }
  assert.equal(clampRunCodeTimeoutMs(1234), 1234);
  assert.equal(clampRunCodeTimeoutMs(RUN_CODE_MAX_TIMEOUT_MS * 10), RUN_CODE_MAX_TIMEOUT_MS);
});

test('the MCP server timeout outlasts every call cc can hold open', () => {
  assert.ok(CC_MCP_SERVER_TIMEOUT_MS > RUN_CODE_MAX_TIMEOUT_MS);
  assert.ok(CC_MCP_SERVER_TIMEOUT_MS > clampBashTimeoutMs(1e12));
  const cfg = JSON.parse(buildMcpConfigJSON({ url: 'http://x/mcp' }));
  assert.equal(cfg.mcpServers['code-conductor'].timeout, CC_MCP_SERVER_TIMEOUT_MS);
});

test('the progress heartbeat is inside Claude Code\'s five-minute idle window', () => {
  assert.ok(PROGRESS_HEARTBEAT_MS * 4 <= 300_000);
});

test('the largest run_code result, in text format, fits the MCP result budget', () => {
  assert.ok(RUN_RESULT_CAP + RUN_LOGS_CAP + RUN_ERROR_MESSAGE_CAP + RUN_META_HEADROOM <= MCP_RESULT_CHAR_BUDGET);
  const worst = assembleResult(
    {
      code: 1, stdout: '', stderr: '', output: 'l'.repeat(RUN_LOGS_CAP * 2), timedOut: false, truncated: true,
      durationMs: 123456789.123, spawnError: null,
    },
    {
      result: 'r'.repeat(RUN_RESULT_CAP + 80), resultChars: 99999999, truncated: true,
      error: { name: 'ConductorError', message: 'm'.repeat(RUN_ERROR_MESSAGE_CAP), code: 'SOME_LONG_ERROR_CODE_HERE', status: 200 },
    },
    false,
  );
  const text = worst.text();
  const chars = JSON.stringify(text.meta).length + text.bodies.reduce((n, b) => n + String(b).length, 0);
  assert.ok(chars <= MCP_RESULT_CHAR_BUDGET, `${chars} chars`);
});

test('the run_code description states the real limits and fits 4096 chars in both formats', () => {
  for (const format of ['text', 'json']) {
    const tool = capableTools(format, hostPlatform.capabilities, 'anonymous').find(t => t.name === 'run_code');
    assert.ok(tool.description.length <= 4096, `${format}: ${tool.description.length}`);
    assert.ok(tool.description.includes(String(RUN_RESULT_CAP)), 'the result cap');
    assert.ok(tool.description.includes(`defaults to ${describeDuration(RUN_CODE_DEFAULT_TIMEOUT_MS)}`), 'the default timeout');
    assert.ok(tool.description.includes(`at most ${describeDuration(RUN_CODE_MAX_TIMEOUT_MS)}`), 'the max timeout');
    assert.ok(!/RUN_RESULT_CAP|clampRunCodeTimeoutMs/.test(tool.description), 'no code constant names');
    assert.match(tool.description, /^Code mode/);
  }
});

test('the run_code description lists every core tool the host serves, except itself', () => {
  const tools = capableTools('text', hostPlatform.capabilities, 'anonymous');
  const description = tools.find(t => t.name === 'run_code').description;
  const listed = description.slice(description.indexOf('Core methods (cc.<name>): ') + 'Core methods (cc.<name>): '.length).replace(/\.$/, '').split(', ');
  assert.deepEqual(listed, tools.map(t => t.name).filter(n => n !== 'run_code'));
});

test('describeDuration spells whole minutes as minutes and the rest as seconds', () => {
  assert.equal(describeDuration(300_000), '5 min');
  assert.equal(describeDuration(90_000), '90 s');
});
