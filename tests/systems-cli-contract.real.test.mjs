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
import os from 'node:os';
import { encodeCwd } from '../src/projects.ts';
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

// PINS AN UNDOCUMENTED CLI SURFACE: a SUBAGENT's `PreToolUse` payload carries a
// non-empty string `agent_id`, and the main agent's does not carry the field at
// all.
//
// CC NO LONGER CONSUMES IT (card 2026-0312 deleted the per-agent shell it keyed,
// because no command's state reaches any later command for a subagent's to
// re-base). This stays as a CLI-CONTRACT FACT, established by a real-binary run:
// the shape is a real thing about the CLI, it is the natural channel for any
// future per-agent behaviour, and re-establishing it later would cost another
// real-binary session. Nothing in `src/` reads it, so a regression here changes
// nothing cc does today — the test says what the CLI does, and no longer what cc
// depends on.
//
// Asserted over the hook envelopes, never the model's prose: what is pinned is
// what the CLI put on the wire.
//
// NOT CLAIMING: the id's format, nor anything about NESTED subagents, for which
// no clean two-level sample exists, nor that the CLI would refuse to reorder the
// two steps — if it ever ran the dispatch first this fails, and re-reading the
// prompt is the right response.
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
    // (subagents omit the field, the main agent carries one), and a consumer
    // reading it that way would be reading it exactly backwards — which is what
    // this case exists to catch, whatever cc does with it.
    assert.ok(!('agent_id' in bash[0]),
      `the main agent's own call came first and carries no agent_id, got ${JSON.stringify(bash[0].agent_id)}`);
    assert.ok(bash.slice(1).some(e => typeof e.agent_id === 'string' && e.agent_id.length > 0),
      'and a later call — the dispatched subagent\'s — carries one');
  } finally { await hooks.close(); await clean(); }
});

// THE PREMISE THE TRANSCRIPT-COLLISION GUARD RESTS ON, asserted against the
// installed binary rather than against cc's own function.
//
// cc refuses to register two places whose working directories `encodeCwd` alike
// — `_` and `.` both collapsing to `-` — because the CLI would then name ONE
// `~/.claude/projects/<...>` directory for both and their sessions would
// interleave in it. `src/projects.ts`'s `encodeCwd` is tested only against
// itself, which proves nothing about the CLI: if the binary preserved `.`, the
// guard would be over-refusing genuine non-collisions, and that is a lockout.
//
// BOTH DIRECTIONS, because either alone is satisfiable by accident: two cwds
// differing only in `_` vs `.` land in ONE directory, and a genuinely distinct
// pair lands in TWO.
//
// Asserted as a DELTA against `~/.claude/projects` — the CLI writes to the real
// HOME, and this host has transcripts from every other run — so what the probe
// created is distinguished from what it inherited, and only what it created is
// cleaned up.
t('two cwds differing only in `_` vs `.` share ONE transcript directory', async () => {
  const { dir, clean } = await fixture();
  const settings = path.join(dir, 'settings.json');
  await fs.writeFile(settings, '{}');
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const exists = (d) => fs.stat(path.join(projects, d)).then(() => true, () => false);

  // Three real cwds. The first two differ ONLY in the character under test.
  const cwds = {};
  for (const name of ['a_b', 'a.b', 'zz']) {
    cwds[name] = path.join(dir, name);
    await fs.mkdir(cwds[name], { recursive: true });
  }

  // SELECTION FOR DELETION CARRIES POSITIVE IDENTITY, NEVER "whatever is new".
  // This writes into the REAL ~/.claude/projects, which holds this host's
  // transcripts from every other session — and the probe window is three
  // model-backed CLI runs, minutes long, during which a concurrent `claude`
  // anywhere on the box creates its own directory. A delta-based cleanup would
  // recursively delete that live directory, possibly mid-write. So only the two
  // names this probe COMPUTES are ever removable, and only if they were absent
  // beforehand — a pre-existing directory of the same name is somebody else's.
  const mine = [...new Set(['a_b', 'zz'].map(n => encodeCwd(cwds[n])))];
  const preExisting = new Set();
  for (const d of mine) if (await exists(d)) preExisting.add(d);

  let measured = false;
  try {
    // PER-CWD, AROUND EACH INVOCATION, so a concurrent creation elsewhere on the
    // box cannot perturb the count into a flake: what each run produced is
    // observed at its own two names rather than inferred from a whole-directory
    // delta.
    // `a.b` RUNS FIRST, and the order is the attribution: it is the cwd whose
    // `.` is under test, so it must be the run that CREATES the shared name.
    // Run second it would only ever find `a_b`'s directory already there, and
    // "the name existed afterwards" would say nothing about which run made it.
    const produced = {};
    for (const name of ['a.b', 'a_b', 'zz']) {
      const want = encodeCwd(cwds[name]);
      const had = await exists(want);
      await runClaude(cwds[name], settings, 'Reply with the single word OK.');
      produced[name] = { want, had, now: await exists(want) };
    }

    // THE MEASUREMENT, printed rather than merely asserted: the convention is
    // the finding, and a green tick does not show it.
    for (const name of ['a.b', 'a_b', 'zz']) {
      const p = produced[name];
      console.log(`cli-contract: cwd ${cwds[name]}`);
      console.log(`cli-contract:   cc encodeCwd → ${p.want}`);
      console.log(`cli-contract:   CLI produced → ${p.now ? p.want : '(nothing at that name)'}`
        + `${p.had ? ' [name pre-existed; not attributable]' : ''}`);
    }
    console.log(`cli-contract: distinct directory names for 3 cwds: ${mine.length} (${mine.join(', ')})`);

    measured = true;
    // cc's own function first, so a premise that moved on THIS side is named as
    // that rather than blamed on the binary.
    assert.equal(encodeCwd(cwds['a_b']), encodeCwd(cwds['a.b']),
      "cc's own encodeCwd no longer collapses `_` and `.` alike — the premise moved on cc's side");

    // DIRECTION 1, ATTRIBUTED TO THE `a.b` RUN: the cwd containing `.` CREATED
    // the collapsed name. If the binary preserved `.`, this directory would not
    // have appeared and cc's guard would be over-refusing genuine
    // non-collisions — a lockout, and the guard would be wrong, not this.
    assert.equal(mine.length, 2, `three cwds, two of which encode alike, name ${mine.length} directories`);
    assert.equal(produced['a.b'].had, false, 'the shared name pre-existed — this run cannot be attributed');
    assert.ok(produced['a.b'].now, `the \`.\` cwd wrote nothing at the collapsed name ${produced['a.b'].want}`);

    // THE FALSIFIER, spelled the way a `.`-preserving CLI would spell it: the
    // same collapse with `.` exempted. Its absence is what rules out "the CLI
    // kept the dot and cc merely looked in the wrong place".
    const dotPreserved = cwds['a.b'].replace(/[^A-Za-z0-9.-]/g, '-');
    assert.notEqual(dotPreserved, produced['a.b'].want, 'the falsifier is not distinguishable');
    assert.equal(await exists(dotPreserved), false,
      `a directory preserving the literal \`.\` exists (${dotPreserved}) — the CLI does not collapse it`);

    // …AND THE PAIR REALLY SHARES IT: `a_b` ran second and found the name
    // already there, which is the collision cc refuses.
    assert.equal(produced['a_b'].had, true, 'the second cwd of the pair got its own directory');
    assert.ok(produced['a_b'].now);

    // DIRECTION 2: the distinct cwd got its OWN, previously absent, directory —
    // so "2" is one shared plus one separate rather than two arbitrary names,
    // and the collapse is not simply mapping everything together.
    assert.equal(produced['zz'].had, false);
    assert.ok(produced['zz'].now, `no separate directory for zz at ${produced['zz'].want}`);
    assert.notEqual(encodeCwd(cwds['zz']), encodeCwd(cwds['a_b']));
  } finally {
    // Exactly the names this probe computed, minus any that already existed.
    const left = [];
    for (const d of mine) {
      if (preExisting.has(d)) continue;          // somebody else's, from before
      if (!await exists(d)) continue;
      if (measured) await fs.rm(path.join(projects, d), { recursive: true, force: true });
      else left.push(path.join(projects, d));
    }
    if (left.length) {
      // A MID-RUN FAILURE REPORTS RATHER THAN FORCE-CLEANS: the run broke before
      // the measurement was complete, so what these directories hold is exactly
      // what is no longer known.
      console.log(`cli-contract: LEFT BEHIND, not removed (the run failed before it measured): ${left.join(', ')}`);
    }
    await clean();
  }
});
