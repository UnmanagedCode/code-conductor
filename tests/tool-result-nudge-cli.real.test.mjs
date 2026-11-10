// THE CLI CONTRACT the tool-result nudges stand on (src/toolResultNudges.ts).
// Skipped by default — opt in with `RUN_CLI_CONTRACT=1`.
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/tool-result-nudge-cli.real.test.mjs
//
// A handler queues its nudge under the id the CLI's MCP `tools/call` carries in
// `params._meta["claudecode/toolUseId"]`, and the session's PostToolUse hook
// takes it by the envelope's `tool_use_id`. Both halves are undocumented CLI
// behaviour, and each failure is silent — the nudge just never arrives:
//   * the `_meta` key is renamed or dropped → nothing is ever queued;
//   * the two ids stop being the same value → every take misses;
//   * PostToolUse `additionalContext` stops reaching an `mcp__*` tool's result.
//
// The session is launched with cc's own settings (`buildSettingsJSON`) and MCP
// config (`buildMcpConfigJSON`) against a stub MCP server named like cc's, so
// the matcher under test is the one cc ships. Harness and rules:
// tests/cliContractCase.mjs.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../src/projects.ts';
import { buildMcpConfigJSON, buildSettingsJSON } from '../src/settings.ts';
import { toolUseIdOf } from '../src/toolResultNudges.ts';
import { fixture, hookServer, runClaude, t } from './cliContractCase.mjs';

const TOOL = 'mcp__code-conductor__spawn_instance';
const CODEWORD = 'cc tool-result nudge codeword WOMBAT-4417.';

// A minimal streamable-HTTP MCP server exposing one `spawn_instance` tool. It
// records every tools/call's params.
async function stubMcp() {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* answered below */ }
      const reply = (result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.id === undefined || msg.id === null) { res.writeHead(202).end(); return; }
      if (msg.method === 'initialize') {
        reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } });
      } else if (msg.method === 'tools/list') {
        reply({ tools: [{
          name: 'spawn_instance', description: 'Starts a worker session. Takes no arguments.',
          inputSchema: { type: 'object', properties: {} },
        }] });
      } else if (msg.method === 'tools/call') {
        calls.push(msg.params);
        reply({ content: [{ type: 'text', text: '{"sessionId":"worker-1"}' }] });
      } else {
        reply({});
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

// The session's jsonl lines, from wherever this host's CLI keeps its projects.
async function transcriptLines(cwd, sessionId) {
  const roots = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean);
  for (const root of roots) {
    const file = path.join(root, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text !== null) {
      return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    }
  }
  throw new Error(`no transcript for session ${sessionId} under ${roots.join(', ')}`);
}

const PROMPT = `Call the ${TOOL} tool exactly once, with no arguments (load it with ToolSearch first if it is deferred). `
  + 'Then reply with the single word DONE.';

// One run: the hook answers a PostToolUse on the tool with `answer`. Returns the
// MCP call's toolUseId, the PostToolUse envelopes for the tool, and the
// transcript's PostToolUse hook_additional_context attachments.
async function runOnce(answer) {
  const { dir, clean } = await fixture();
  const mcp = await stubMcp();
  const hooks = await hookServer((e) => (e.hook_event_name === 'PostToolUse' && e.tool_name === TOOL ? answer : {}));
  try {
    const frame = await runClaude(dir, buildSettingsJSON({ hookCallbackUrl: hooks.url }), PROMPT,
      ['--strict-mcp-config', '--mcp-config', buildMcpConfigJSON({ url: mcp.url })]);
    assert.equal(mcp.calls.length >= 1, true, 'the model called the stub tool');
    const toolUseId = toolUseIdOf(mcp.calls[0]);
    const lines = await transcriptLines(dir, frame.session_id);
    const attachments = lines
      .map((l) => l.attachment)
      .filter((a) => a?.type === 'hook_additional_context' && a.hookEvent === 'PostToolUse');
    return { toolUseId, post: hooks.of('PostToolUse', TOOL), attachments };
  } finally { await hooks.close(); await mcp.close(); await clean(); }
}

// PINS: the MCP tools/call carries params._meta["claudecode/toolUseId"] (read
// by cc's own toolUseIdOf), it equals the PostToolUse envelope's tool_use_id,
// and an additionalContext answer persists as a PostToolUse
// hook_additional_context attachment keyed by that id, carrying the text verbatim.
t('the MCP call id is the PostToolUse id, and additionalContext lands on that call', async () => {
  const r = await runOnce({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: CODEWORD } });
  assert.equal(typeof r.toolUseId, 'string', 'tools/call carried a toolUseId under the meta key');
  assert.equal(r.post.length >= 1, true, 'PostToolUse fired for the MCP tool through cc\'s matcher');
  assert.equal(r.post[0].tool_use_id, r.toolUseId, 'the hook envelope names the same call');
  const mine = r.attachments.filter((a) => a.toolUseID === r.toolUseId);
  assert.equal(mine.length, 1, `one attachment for the call: ${JSON.stringify(r.attachments)}`);
  assert.equal(mine[0].hookName, `PostToolUse:${TOOL}`);
  assert.equal(Array.isArray(mine[0].content), true);
  assert.equal(mine[0].content.some((c) => typeof c === 'string' && c.includes(CODEWORD)), true,
    `the text is carried verbatim: ${JSON.stringify(mine[0].content)}`);
});

// CONTROL: the same run answered `{}` persists no PostToolUse context — so the
// attachment above is the answer's doing, not something the CLI adds anyway.
t('control: a {} answer persists no PostToolUse context', async () => {
  const r = await runOnce({});
  assert.equal(typeof r.toolUseId, 'string');
  assert.equal(r.post.length >= 1, true, 'the hook still fired');
  assert.deepEqual(r.attachments, []);
});
