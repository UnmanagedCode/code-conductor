// THE CLI CONTRACT a stage's `workerTools` stands on (src/mcp/playbookGate.ts
// → checkWorkerTool, answered on the `?policy=worker-tools` hook entry). Skipped
// by default — opt in with `RUN_CLI_CONTRACT=1`:
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/worker-tools-cli-deny.real.test.mjs
//
// cc launches every session under `--permission-mode bypassPermissions`, and
// the worker-tools entry sits BESIDE the base entry, which answers `allow` for
// the mutating tools. The whole feature rests on two CLI behaviours no document
// states for that combination:
//   * a PreToolUse hook `deny` still blocks the call under bypassPermissions;
//   * it wins over a SIBLING entry's `allow` for the same call.
// If either changed, a denied tool would simply run.
//
// The settings are cc's own (`buildSettingsJSON`), so the entry under test is
// the one cc ships. Harness and rules: tests/cliContractCase.mjs.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildSettingsJSON, WORKER_TOOLS_POLICY } from '../src/settings.ts';
import { workerToolsHookBody } from '../src/hookBroker.ts';
import { allow, fixture, hookServer, runClaude, t } from './cliContractCase.mjs';

const PROMPT = 'Run exactly this shell command with the Bash tool and nothing else: touch denied.txt';
const isWorkerTools = (url) => new URL(url, 'http://h').searchParams.get('policy') === WORKER_TOOLS_POLICY;

// One run: the base entry answers `allow`, the worker-tools entry answers
// `workerTools(envelope)`. Returns whether the file exists, the result frame,
// and which entries saw the Bash call.
async function runOnce(workerTools) {
  const { dir, clean } = await fixture();
  const urls = [];
  const hooks = await hookServer((e, url) => {
    if (e.hook_event_name !== 'PreToolUse') return {};
    urls.push({ tool: e.tool_name, workerTools: isWorkerTools(url) });
    return isWorkerTools(url) ? workerTools(e) : allow();
  });
  try {
    const frame = await runClaude(dir, buildSettingsJSON({ hookCallbackUrl: hooks.url }), PROMPT);
    const created = await fs.stat(path.join(dir, 'denied.txt')).then(() => true, () => false);
    return {
      created, frame,
      baseSawBash: urls.some(u => u.tool === 'Bash' && !u.workerTools),
      workerToolsSawBash: urls.some(u => u.tool === 'Bash' && u.workerTools),
    };
  } finally { await hooks.close(); await clean(); }
}

// PINS: under bypassPermissions, a `deny` from the worker-tools entry blocks
// the call even though the sibling base entry answered `allow` for it, and the
// CLI reports it as a permission denial.
t('a worker-tools deny blocks the call under bypassPermissions, beside a sibling allow', async () => {
  const r = await runOnce((e) => workerToolsHookBody(e.tool_name === 'Bash' ? 'cc contract probe: Bash is denied in this stage.' : null));
  assert.equal(r.workerToolsSawBash, true, 'the worker-tools entry received the Bash call');
  assert.equal(r.baseSawBash, true, 'and so did the base entry, which answered allow');
  assert.equal(r.created, false, 'the denied command did not run');
  assert.equal(Array.isArray(r.frame.permission_denials) && r.frame.permission_denials.length >= 1, true,
    `the CLI reported a permission denial: ${JSON.stringify(r.frame.permission_denials)}`);
});

// CONTROL: the same run with the worker-tools entry answering `{}` runs the
// command — so the deny above, not the tool profile or the prompt, blocked it,
// and `{}` passes under bypassPermissions.
t('control: a worker-tools {} lets the call run', async () => {
  const r = await runOnce(() => workerToolsHookBody(null));
  assert.equal(r.workerToolsSawBash, true, 'the worker-tools entry received the Bash call');
  assert.equal(r.created, true, 'the command ran');
});
