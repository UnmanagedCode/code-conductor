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

// PINS THE UNDOCUMENTED SURFACE A SHELL-PER-AGENT RESTS ON: a SUBAGENT's
// `PreToolUse` payload carries a non-empty string `agent_id`, and the main
// agent's does not carry the field at all. That difference is the only thing
// that tells cc which shell a redirected command belongs in.
//
// SILENT IF IT REGRESSES, which is why it is here. A CLI upgrade that stopped
// sending `agent_id` would collapse every subagent back onto the main agent's
// shell — a subagent's `cd` would re-base the main agent's next command — and
// every command would still succeed. One that started sending it for the main
// agent too would give main its own consistent shell, still isolated; harmless,
// and this test would say so rather than leaving it to be discovered.
//
// Asserted over the hook envelopes, never the model's prose: what is pinned is
// what the CLI put on the wire.
//
// NOT CLAIMING: the id's format (opaque to cc — it is only ever a map key), nor
// anything about NESTED subagents, for which no clean two-level sample exists,
// nor that the CLI would refuse to reorder the two steps — if it ever ran the
// dispatch first this fails, and re-reading the prompt is the right response.
t('a subagent PreToolUse payload carries agent_id and the main agent does not', async () => {
  const { dir, clean } = await fixture();
  const hooks = await hookServer(() => allow());
  try {
    await runClaude(dir, settingsJSON(hooks.url, { pre: ['Bash', 'Task'], post: ['Bash'] }),
      'Do exactly two things, in order. (1) Use the Bash tool yourself to run `echo MAIN_AGENT_HERE`. '
      + '(2) Use the Task tool to dispatch one general-purpose subagent, instructing it to run the '
      + 'Bash command `echo SUB_AGENT_HERE` and report the output. Do not run the subagent\'s command yourself.');

    const bash = hooks.of('PreToolUse', 'Bash');
    assert.ok(bash.length >= 2, `both Bash calls were hooked (got ${bash.length})`);

    // The field is EITHER a non-empty string OR entirely absent. An empty
    // string, a null or a number would each need cc to decide what it meant.
    for (const e of bash) {
      const named = typeof e.agent_id === 'string' && e.agent_id.length > 0;
      assert.ok(named || !('agent_id' in e),
        `agent_id is a non-empty string or absent, got ${JSON.stringify(e.agent_id)}`);
    }

    const sub = bash.filter(e => typeof e.agent_id === 'string' && e.agent_id.length > 0);
    const main = bash.filter(e => !('agent_id' in e));
    assert.ok(sub.length >= 1, `at least one Bash call carried an agent_id: ${JSON.stringify(bash.map(e => e.agent_id))}`);
    assert.ok(main.length >= 1, `at least one Bash call carried none: ${JSON.stringify(bash.map(e => e.agent_id))}`);
    assert.equal(sub.length + main.length, bash.length, 'and the two sets partition the calls');

    // WHICH WAY ROUND, and this is the half that matters. The prompt fixes the
    // order — the main agent's own Bash call is step (1), the dispatch is step
    // (2) — so the FIRST envelope to arrive is provably the main agent's. Both
    // sets being non-empty is equally true of a CLI that swapped the semantics
    // (subagents omit the field, the main agent carries one), and cc reading it
    // that way is the silent collapse this case exists to catch: every subagent
    // would land on the main agent's shell while every command still succeeded.
    assert.ok(!('agent_id' in bash[0]),
      `the main agent's own call came first and carries no agent_id, got ${JSON.stringify(bash[0].agent_id)}`);
    assert.ok(bash.slice(1).some(e => typeof e.agent_id === 'string' && e.agent_id.length > 0),
      'and a later call — the dispatched subagent\'s — carries one');
  } finally { await hooks.close(); await clean(); }
});
