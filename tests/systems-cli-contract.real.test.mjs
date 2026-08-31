// THE CLI-CONTRACT REGRESSION TEST, part 1: the hook mechanics the whole
// redirection is built on. Skipped by default — opt in with
// `RUN_CLI_CONTRACT=1`.
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/systems-cli-*.real.test.mjs
//
// Each failure mode here is silent and destructive:
//   * `updatedInput` stops rewriting  → the worker's own command runs on the
//     ORCHESTRATOR's machine, in the session root, reported as success.
//   * `PostToolUse` stops firing      → every edit stays local and the system
//     never sees it, again reported as success.
//   * `additionalContext` stops       → the write-back note vanishes; a
//     degradation, not a corruption.
//   * `Glob`/`Grep` become reachable  → a search answers about a directory
//                                       holding the project's config surface
//                                       and nothing else.
//   * `Bash(...)` rules stop being    → the premise of
//     enforced under bypass             BASH_RULES_NOT_ENFORCEABLE is gone and
//                                       cc refuses spawns for no reason.
//
// Harness, and the two rules every case follows: tests/cliContractCase.mjs.
// The settings and env levers are part 2, tests/systems-cli-levers.real.test.mjs.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { allow, fixture, hookServer, runClaude, settingsJSON, t, toolRegistry } from './cliContractCase.mjs';

// PINS: `PreToolUse` `updatedInput` still replaces the tool input, and the
// REWRITTEN command is what runs. The entire Bash forwarder is this one fact.
t('PreToolUse updatedInput still rewrites the Bash command that runs', async () => {
  const { dir, clean } = await fixture();
  const hooks = await hookServer((e) => (
    e.hook_event_name === 'PreToolUse' && e.tool_name === 'Bash'
      ? allow({ ...e.tool_input, command: 'echo PROBE_REWRITTEN' })
      : {}
  ));
  try {
    await runClaude(dir, settingsJSON(hooks.url, { pre: ['Bash'], post: ['Bash'] }),
      'Run the Bash command `echo PROBE_ORIGINAL`.');
    const pre = hooks.of('PreToolUse', 'Bash');
    assert.equal(pre.length >= 1, true, 'the hook fired');
    assert.equal(pre[0].tool_input.command, 'echo PROBE_ORIGINAL', 'the hook sees the PRE-rewrite command');
    // The CLI's own report of what the command produced — not the model's
    // account of it.
    const post = hooks.of('PostToolUse', 'Bash');
    assert.equal(post.length >= 1, true, 'PostToolUse fired for the Bash call');
    assert.equal(post[0].tool_response.stdout.trim(), 'PROBE_REWRITTEN',
      'the REWRITTEN command is the one that ran');
  } finally { await hooks.close(); await clean(); }
});

// PINS: `PostToolUse` still fires over the http transport and still carries
// `tool_response`, and `additionalContext` still reaches the model. The
// write-back and the note both rest on this.
t('PostToolUse still carries tool_response, and additionalContext still reaches the model', async () => {
  const { dir, clean } = await fixture();
  await fs.writeFile(path.join(dir, 'target.txt'), 'ALPHA marker\n');
  const hooks = await hookServer((e) => {
    if (e.hook_event_name === 'PreToolUse') return allow();
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'cc probe codeword PLATYPUS-7731.' } };
  });
  try {
    const r = await runClaude(dir, settingsJSON(hooks.url, { pre: ['Read', 'Edit'], post: ['Edit'] }),
      'Read ./target.txt, then use the Edit tool to replace ALPHA with OMEGA in it. '
      + 'Finally, quote verbatim any additional context a hook gave you.');

    const read = hooks.of('PreToolUse', 'Read');
    assert.equal(read.length >= 1, true, 'PreToolUse fires for Read — the pull depends on it');
    assert.equal(path.isAbsolute(read[0].tool_input.file_path), true, 'with an already-resolved absolute path');

    const post = hooks.of('PostToolUse', 'Edit');
    assert.equal(post.length >= 1, true, 'PostToolUse fires for Edit');
    assert.equal(typeof post[0].tool_response.filePath, 'string');
    // The model picks the exact strings; what is pinned is that the response
    // carries them, since the write-back reads the file this edit produced.
    assert.match(post[0].tool_response.oldString, /ALPHA/);
    assert.match(post[0].tool_response.newString, /OMEGA/);
    assert.equal(typeof post[0].tool_response.originalFile, 'string');

    assert.match(r.result, /PLATYPUS-7731/, 'additionalContext reached the model');
    assert.equal(await fs.readFile(path.join(dir, 'target.txt'), 'utf8'), 'OMEGA marker\n');
  } finally { await hooks.close(); await clean(); }
});

// PINS THE PROPERTY, not the mechanism: a session launched exactly as cc
// launches one has NEITHER `Glob` NOR `Grep`. Both would answer about cc's
// session root — a directory holding the project's config surface and nothing
// else — and a tool result cannot be substituted, so there is no way to make
// either honest on a remote project.
//
// MEASURED (2.1.250): today they are absent from the headless profile whether
// or not `permissions.deny` names them, and `ToolSearch` cannot surface them
// either. So cc's denial currently removes nothing, and this test is asserting
// the property rather than the denial's effect — which is the point. If a CLI
// upgrade puts them back and the denial does not hold, this fails, and the
// second guard in src/systems/toolRedirect.ts is what keeps the boundary
// consistent until it is fixed.
//
// The registry list is read from the session's own `system`/`init` frame, so
// nothing here depends on what a model chose to reach for.
t('a cc-shaped session can reach neither Glob nor Grep', async () => {
  const { dir, clean } = await fixture();
  const hooks = await hookServer(() => allow());
  try {
    const tools = await toolRegistry(dir, settingsJSON(hooks.url, { pre: ['Bash'], deny: ['Glob', 'Grep'] }));
    // Not vacuous: the list is real and populated with the tools cc does rely on.
    for (const present of ['Bash', 'Read', 'Edit', 'Write']) {
      assert.ok(tools.includes(present), `${present} is in the registry (got ${tools.join(',')})`);
    }
    assert.ok(!tools.includes('Glob'), `Glob is absent (got ${tools.join(',')})`);
    assert.ok(!tools.includes('Grep'), `Grep is absent (got ${tools.join(',')})`);
  } finally { await hooks.close(); await clean(); }
});

// PINS THE PREMISE OF `BASH_RULES_NOT_ENFORCEABLE`: a `Bash(...)` pattern rule
// IS enforced under bypassPermissions. If a CLI upgrade stopped enforcing it
// there, cc's refusal would be blocking spawns to protect a rule that was doing
// nothing, and the refusal should go.
t('a Bash pattern deny is still enforced under bypassPermissions', async () => {
  const { dir, clean } = await fixture();
  const hooks = await hookServer(() => allow());
  try {
    const r = await runClaude(dir, settingsJSON(hooks.url, { pre: ['Bash'], deny: ['Bash(touch:*)'] }),
      'Run exactly this shell command with the Bash tool and nothing else: touch denied.txt');
    await assert.rejects(fs.stat(path.join(dir, 'denied.txt')), 'the denied command did not run');
    assert.equal(Array.isArray(r.permission_denials) && r.permission_denials.length >= 1, true,
      'and the CLI reported it as a permission denial');
  } finally { await hooks.close(); await clean(); }
});
