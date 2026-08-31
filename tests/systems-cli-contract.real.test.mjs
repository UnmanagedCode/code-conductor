// THE CLI-CONTRACT REGRESSION TEST. Skipped by default — opt in with
// `RUN_CLI_CONTRACT=1`.
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/systems-cli-contract.real.test.mjs
//
// Redirecting a worker to another system rests entirely on undocumented Claude
// Code hook behaviour. Nothing in the ordinary suite can notice if a CLI
// upgrade changes any of it, and each failure mode is silent and destructive:
//
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
// So each is asserted against the live binary, over the SAME `http` hook
// transport cc uses — not a `command` hook, because the transport is part of
// what could change. Pinned to claude-haiku-4-5 to keep the runs cheap; nothing
// asserted here is model-specific.
//
// Nothing here is asserted through the model's prose where a mechanical channel
// exists. The rewrite is checked against `PostToolUse`'s `tool_response.stdout`,
// and the tool removal against the `system/init` frame's own tool list — both
// facts the CLI states, rather than behaviour a model might or might not
// exhibit on a given run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp } from './tmpRegistry.mjs';
import { rmrf } from './rmrf.mjs';

const ENABLED = process.env.RUN_CLI_CONTRACT === '1';
const t = ENABLED ? test : test.skip.bind(test);
const MODEL = 'claude-haiku-4-5';
const RUN_TIMEOUT_MS = 180_000;

// A hook endpoint shaped exactly like cc's: one URL, both events, discriminated
// by `hook_event_name`. `reply(envelope)` returns the response body.
async function hookServer(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let envelope = {};
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* record it anyway */ }
      seen.push(envelope);
      const body = (await reply(envelope)) ?? {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((r) => server.close(r)),
    of: (event, tool) => seen.filter(e => e.hook_event_name === event && e.tool_name === tool),
  };
}

function settingsJSON(url, { pre, post = [], deny, extra }) {
  const hooks = [{ type: 'http', url, timeout: 60 }];
  const out = { hooks: { PreToolUse: [{ matcher: pre.join('|'), hooks }] } };
  if (post.length) out.hooks.PostToolUse = [{ matcher: post.join('|'), hooks }];
  if (deny) out.permissions = { deny };
  return JSON.stringify({ ...out, ...extra });
}

function runClaudeEnv(cwd, settings, prompt, env) {
  return new Promise((resolve, reject) => {
    execFile('claude', claudeArgs(settings, prompt, ['--output-format', 'json']),
      { cwd, env: { ...process.env, ...env }, timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`unparseable CLI output: ${stdout.slice(0, 500)}`)); }
      });
  });
}

// cc's OWN launch flags, including `--permission-prompt-tool stdio`. The
// headless tool profile depends on them — that flag is what un-strips the
// interactive tools — so a probe run without them is measuring a different
// session than the one cc ships.
function claudeArgs(settings, prompt, format) {
  return [
    '-p', '--model', MODEL, ...format,
    '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions',
    '--permission-prompt-tool', 'stdio',
    '--settings', settings, prompt,
  ];
}

function runClaude(cwd, settings, prompt) {
  return new Promise((resolve, reject) => {
    execFile('claude', claudeArgs(settings, prompt, ['--output-format', 'json']),
      { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`unparseable CLI output: ${stdout.slice(0, 500)}`)); }
      });
  });
}

// The `system`/`init` frame's own `tools` list — what the session actually has,
// stated by the CLI rather than inferred from what a model chose to reach for.
function toolRegistry(cwd, settings) {
  return new Promise((resolve, reject) => {
    execFile('claude', claudeArgs(settings, 'Reply with the single word OK.', ['--output-format', 'stream-json', '--verbose']),
      { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          let f; try { f = JSON.parse(line); } catch { continue; }
          if (f.type === 'system' && f.subtype === 'init' && Array.isArray(f.tools)) { resolve(f.tools); return; }
        }
        reject(new Error(`no system/init frame with a tool list: ${stdout.slice(0, 500)}`));
      });
  });
}

// A plain command in a directory — the git fixture below is the only user.
function run(argv, cwd) {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { cwd }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function fixture() {
  const dir = await fs.realpath(await mkdtemp('cc-cli-contract-'));
  return { dir, clean: () => rmrf(dir) };
}

const allow = (updatedInput) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'allow',
    ...(updatedInput ? { updatedInput } : {}),
  },
});

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

// ── The two behaviours the refine round added a dependency on ────────

// PINS: `disableAllHooks: true` really does suppress the injected hooks — the
// premise of `REDIRECT_HOOKS_DISABLED`. If a CLI upgrade stopped honouring it,
// cc would be refusing spawns to protect against a setting that no longer does
// anything, and the refusal should go. And if the key is RENAMED, this test
// keeps passing while cc's scan silently stops finding the live lever — which is
// why the sibling assertion below checks that the hook fires WITHOUT it, so the
// zero-hit result is attributable to the key and not to a broken fixture.
t('disableAllHooks still suppresses the injected hooks', async () => {
  const { dir, clean } = await fixture();
  const on = await hookServer((e) => (
    e.tool_name === 'Bash' ? allow({ ...e.tool_input, command: 'echo REWRITTEN_BY_CC_HOOK' }) : {}
  ));
  try {
    // CONTROL: the same settings without the key. Without this the assertion
    // below is satisfied by any fixture that never fires a hook at all.
    await runClaude(dir, settingsJSON(on.url, { pre: ['Bash'], post: ['Bash'] }),
      'Run the Bash command `echo ORIGINAL_WORKER_COMMAND`.');
    assert.ok(on.of('PreToolUse', 'Bash').length >= 1, 'the control fired the hook');
    const post = on.of('PostToolUse', 'Bash');
    assert.equal(post[0].tool_response.stdout.trim(), 'REWRITTEN_BY_CC_HOOK',
      'and the control really redirected the command');
  } finally { await on.close(); await clean(); }

  const { dir: dir2, clean: clean2 } = await fixture();
  const off = await hookServer((e) => (
    e.tool_name === 'Bash' ? allow({ ...e.tool_input, command: 'echo REWRITTEN_BY_CC_HOOK' }) : {}
  ));
  try {
    const r = await runClaude(dir2,
      settingsJSON(off.url, { pre: ['Bash'], post: ['Bash'], extra: { disableAllHooks: true } }),
      'Run the Bash command `echo ORIGINAL_WORKER_COMMAND`.');
    assert.equal(off.seen.length, 0, `the hook fired ${off.seen.length} times with hooks disabled`);
    // The worker's OWN command ran, locally. This is exactly the divergence
    // REDIRECT_HOOKS_DISABLED exists to refuse.
    assert.match(r.result, /ORIGINAL_WORKER_COMMAND/);
  } finally { await off.close(); await clean2(); }
});

// PINS: `includeGitInstructions: false` still turns off the CLI's dynamic git
// guidance. A redirected session's cwd is cc's session root, so that guidance
// describes the wrong repository; if the key stops working, every worker on a
// remote project gets git instructions about a directory holding the project's
// config surface and nothing else.
//
// Asserted from the CLI's own system prompt, and with a CONTROL that shows the
// fixture does produce the instructions when the key is absent — otherwise a
// renamed key would leave this passing for the wrong reason.
t('includeGitInstructions:false still suppresses the CLI git instructions', async () => {
  const { dir, clean } = await fixture();
  const hooks = await hookServer(() => allow());
  try {
    // A real repo, so the CLI's probe has something to find.
    await run(['git', 'init', '-q'], dir);
    await run(['git', 'config', 'user.email', 't@e'], dir);
    await run(['git', 'config', 'user.name', 'T'], dir);
    await fs.writeFile(path.join(dir, 'f.txt'), 'x\n');
    await run(['git', 'add', '-A'], dir);
    await run(['git', 'commit', '-q', '-m', 'initial'], dir);

    const ask = 'Reply with ONLY the words in your system prompt that state the current git branch, or NONE.';
    const control = await runClaude(dir, settingsJSON(hooks.url, { pre: ['Bash'] }), ask);
    const off = await runClaude(dir,
      settingsJSON(hooks.url, { pre: ['Bash'], extra: { includeGitInstructions: false } }), ask);

    // The mechanical half: the CLI reports how many tokens of system prompt it
    // built, and dropping a whole gitStatus block is visible in it.
    assert.ok(/main|master/i.test(control.result),
      `the control saw the branch in its prompt (got ${JSON.stringify(control.result).slice(0, 300)})`);
    assert.ok(!/main|master/i.test(off.result),
      `with the key off the branch is not in the prompt (got ${JSON.stringify(off.result).slice(0, 300)})`);
  } finally { await hooks.close(); await clean(); }
});

// PINS: CLAUDE_CODE_TMPDIR still relocates the root the task-output file lands
// under. cc points it at a directory it owns so a worker can Read its own
// backgrounded command's interim output; if the var stops being honoured the
// file goes back under the per-uid tmp root and the redirect refuses it again.
t('CLAUDE_CODE_TMPDIR still relocates the task-output root', async () => {
  const backgrounded = 'Use the Bash tool to start `sleep 3; echo done` in the BACKGROUND '
    + '(run_in_background: true). Then reply with the single word STARTED. Do not wait for it.';
  // Asserted from the FILESYSTEM, not from the model's prose: the model was
  // measured reporting "the background task completed" instead of relaying the
  // path, and what cc depends on is where the CLI PUTS the file.
  const taskFiles = async (dir) => {
    const out = [];
    const walk = async (d) => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (path.basename(path.dirname(p)) === 'tasks') out.push(p);
      }
    };
    await walk(dir);
    return out;
  };

  const { dir, clean } = await fixture();
  const tmpRoot = path.join(dir, 'cc-owned-tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  await fs.chmod(tmpRoot, 0o700);
  const hooks = await hookServer(() => allow());
  try {
    await runClaudeEnv(dir, settingsJSON(hooks.url, { pre: ['Bash'] }), backgrounded,
      { CLAUDE_CODE_TMPDIR: tmpRoot });
    const found = await taskFiles(tmpRoot);
    assert.ok(found.length >= 1,
      `a tasks/ output file landed under the override (found nothing under ${tmpRoot})`);
  } finally { await hooks.close(); await clean(); }

  // CONTROL: without the override nothing lands under that directory, so the
  // assertion above is about the variable and not about the CLI happening to
  // write into its own cwd.
  const { dir: dir2, clean: clean2 } = await fixture();
  const tmpRoot2 = path.join(dir2, 'cc-owned-tmp');
  await fs.mkdir(tmpRoot2, { recursive: true });
  const hooks2 = await hookServer(() => allow());
  try {
    await runClaudeEnv(dir2, settingsJSON(hooks2.url, { pre: ['Bash'] }), backgrounded, {});
    assert.deepEqual(await taskFiles(tmpRoot2), [],
      'with no override the task file goes somewhere else entirely');
  } finally { await hooks2.close(); await clean2(); }
});
