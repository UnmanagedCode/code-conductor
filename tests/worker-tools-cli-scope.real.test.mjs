// THE CLI CONTRACT for the REACH of a stage's `workerTools`: the one
// catch-all worker-tools entry (`WORKER_TOOLS_MATCHER`, src/settings.ts) must see
// and be able to stop an MCP tool's call and a SUBAGENT's call, both arriving on
// the worker's own hook URL. Skipped by default — opt in with
// `RUN_CLI_CONTRACT=1`:
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/worker-tools-cli-scope.real.test.mjs
//
// The settings are cc's own (`buildSettingsJSON`), plus ONE observer entry the
// harness appends: a PostToolUse on Bash, so a subagent's command that ran is
// distinguishable from one that was stopped. cc's PreToolUse entries are left
// exactly as shipped. Harness and rules: tests/cliContractCase.mjs.

import assert from 'node:assert/strict';
import { buildMcpConfigJSON, buildSettingsJSON, CC_MCP_SERVER_NAME, WORKER_TOOLS_POLICY } from '../src/settings.ts';
import { workerToolsHookBody } from '../src/hookBroker.ts';
import { hookServer, fixture, runClaude, stubMcp, t } from './cliContractCase.mjs';

const MCP_TOOL = `mcp__${CC_MCP_SERVER_NAME}__probe_status`;
const PROMPT = 'Do exactly two things, in order. '
  + `(1) Call the ${MCP_TOOL} tool once, with no arguments (load it with ToolSearch first if it is deferred). `
  + 'If it is refused, do not retry it. '
  + '(2) Use the Agent tool (also called Task) to dispatch one general-purpose subagent, instructing it to run '
  + 'the Bash command `echo SUB_AGENT_HERE` and report the output. Do not run that command yourself. '
  + 'Then reply with the single word DONE.';
const isWorkerTools = (url) => new URL(url, 'http://h').searchParams.get('policy') === WORKER_TOOLS_POLICY;

// One run: the worker-tools entry answers `decide(envelope)`; every other
// request is answered `{}`. Returns the worker-tools envelopes, the Bash
// PostToolUse envelopes, and the stub's recorded tools/calls.
async function runOnce(decide) {
  const { dir, clean } = await fixture();
  const mcp = await stubMcp([{ name: 'probe_status', description: 'Reports a status line. Takes no arguments.' }], 'STATUS OK');
  const wt = [];
  const hooks = await hookServer((e, url) => {
    if (!isWorkerTools(url)) return {};
    wt.push(e);
    return decide(e);
  });
  try {
    const settings = JSON.parse(buildSettingsJSON({ hookCallbackUrl: hooks.url }));
    settings.hooks.PostToolUse.push({ matcher: 'Bash', hooks: [{ type: 'http', url: hooks.url, timeout: 60 }] });
    await runClaude(dir, JSON.stringify(settings), PROMPT,
      ['--strict-mcp-config', '--mcp-config', buildMcpConfigJSON({ url: mcp.url })]);
    return {
      wt,
      mcpPre: wt.filter(e => e.hook_event_name === 'PreToolUse' && e.tool_name === MCP_TOOL),
      subBashPre: wt.filter(e => e.hook_event_name === 'PreToolUse' && e.tool_name === 'Bash'
        && typeof e.agent_id === 'string' && e.agent_id.length > 0),
      subBashPost: hooks.of('PostToolUse', 'Bash').filter(e => typeof e.agent_id === 'string' && e.agent_id.length > 0),
      mcpCalls: mcp.calls,
    };
  } finally { await hooks.close(); await mcp.close(); await clean(); }
}

const denyMcpAndBash = (e) => workerToolsHookBody(
  e.hook_event_name === 'PreToolUse' && (e.tool_name === 'Bash' || e.tool_name.startsWith(`mcp__${CC_MCP_SERVER_NAME}__`))
    ? `cc contract probe: ${e.tool_name} is denied in this stage.` : null);

// PINS: the catch-all entry receives an MCP tool's call and a subagent's Bash
// call (the latter carrying `agent_id`, on the parent session's URL), and its
// deny stops both — the stub MCP server records no tools/call, and the
// subagent's command produces no PostToolUse.
t('the catch-all worker-tools entry reaches and stops an MCP call and a subagent call', async () => {
  const r = await runOnce(denyMcpAndBash);
  assert.ok(r.mcpPre.length >= 1, `the entry received the MCP call: ${JSON.stringify(r.wt.map(e => e.tool_name))}`);
  assert.ok(r.subBashPre.length >= 1, `the entry received a subagent's Bash call: ${JSON.stringify(r.wt.map(e => [e.tool_name, e.agent_id]))}`);
  assert.deepEqual(r.mcpCalls, [], 'the denied MCP call never reached the server');
  assert.deepEqual(r.subBashPost, [], 'the denied subagent command never ran');
});

// CONTROL: the same run answered `{}` lets both through — so the deny above,
// not the prompt or the tool profile, stopped them, and the PostToolUse
// observer does see a subagent command that ran.
t('control: a worker-tools {} lets the MCP call and the subagent call run', async () => {
  const r = await runOnce(() => workerToolsHookBody(null));
  assert.ok(r.mcpPre.length >= 1, 'the entry received the MCP call');
  assert.ok(r.subBashPre.length >= 1, 'the entry received a subagent\'s Bash call');
  assert.ok(r.mcpCalls.length >= 1, 'the MCP call reached the server');
  assert.ok(r.subBashPost.length >= 1, 'the subagent command ran');
});
