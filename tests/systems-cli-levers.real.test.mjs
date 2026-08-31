// THE CLI-CONTRACT REGRESSION TEST, part 2: the settings and env levers cc
// pulls to make a redirected session behave. Skipped by default — opt in with
// `RUN_CLI_CONTRACT=1`.
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/systems-cli-*.real.test.mjs
//
// Each is a key or variable cc now DEPENDS on, so a CLI upgrade that renames or
// drops one breaks the redirect quietly:
//   * `disableAllHooks`        → the premise of REDIRECT_HOOKS_DISABLED. If it
//                                stopped disabling hooks, cc would be refusing
//                                spawns to protect against nothing.
//   * `includeGitInstructions` → every worker on a remote project would get git
//                                guidance describing cc's session root.
//
// Harness, and the two rules every case follows: tests/cliContractCase.mjs.
// The hook mechanics are part 1, tests/systems-cli-contract.real.test.mjs;
// CLAUDE_CODE_TMPDIR is part 3, tests/systems-cli-tmpdir.real.test.mjs — its own
// file because its two runs cost ~33s, and the hang guard charges a file the SUM
// of its cases.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { allow, fixture, hookServer, run, runClaude, settingsJSON, t } from './cliContractCase.mjs';

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
