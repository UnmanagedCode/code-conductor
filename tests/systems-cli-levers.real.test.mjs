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
import os from 'node:os';
import { encodeCwd } from '../src/projects.ts';
import { allow, fixture, hookServer, run, runClaude, runClaudeEnv, settingsJSON, t } from './cliContractCase.mjs';

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

    // THE MECHANICAL CHANNEL: the CLI SHELLS OUT to git to build that block, so
    // a shim earlier on PATH records whether it did. Asked the model instead,
    // the answer is prose about its own prompt — which the harness's own rules
    // say not to rely on where a mechanical channel exists, and which cannot
    // distinguish "not in my prompt" from "I declined to quote it".
    //
    // MEASURED (2.1.250): `status --short`, `log --oneline` and `config
    // user.name` run only when the block is built. Five other git calls (the
    // skills scan, remote/email lookups, a settings `ls-files`) happen either
    // way, which is why the assertion names the three and not the count.
    const bin = path.join(dir, 'shim');
    await fs.mkdir(bin, { recursive: true });
    const realGit = (await run(['sh', '-c', 'command -v git'], dir)).trim();
    await fs.writeFile(path.join(bin, 'git'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GIT_SHIM_LOG"\nexec ${realGit} "$@"\n`);
    await fs.chmod(path.join(bin, 'git'), 0o755);

    const gitCalls = async (extra, tag) => {
      const log = path.join(dir, `git-${tag}.log`);
      await fs.writeFile(log, '');
      await runClaudeEnv(dir, settingsJSON(hooks.url, { pre: ['Bash'], ...(extra ? { extra } : {}) }),
        'Reply with the single word OK.',
        { PATH: `${bin}:${process.env.PATH}`, GIT_SHIM_LOG: log });
      return fs.readFile(log, 'utf8');
    };

    // CONTROL first: without the key the block IS built, so the assertion below
    // is about the key and not about a CLI that stopped calling git at all.
    const control = await gitCalls(null, 'control');
    for (const probe of ['status --short', 'log --oneline']) {
      assert.ok(control.includes(probe),
        `the control built the git block (no '${probe}' in ${JSON.stringify(control).slice(0, 400)})`);
    }

    const off = await gitCalls({ includeGitInstructions: false }, 'off');
    for (const probe of ['status --short', 'log --oneline']) {
      assert.ok(!off.includes(probe),
        `with the key off the CLI must not probe git for '${probe}' (got ${JSON.stringify(off).slice(0, 400)})`);
    }
    // Not vacuous in the other direction either: the shim WAS on PATH and the
    // CLI did still use git for its other startup work.
    assert.ok(off.trim().length > 0, 'the shim was reached at all');
  } finally { await hooks.close(); await clean(); }
});

// PINS THE TWO LEVERS card 2026-0447's per-remote config directory rests on,
// and the one property that makes the symlink farm safe rather than lucky.
//
// Each failure mode here is silent:
//   * `CLAUDE_CONFIG_DIR` stops relocating `projects/` → every remote's
//     transcripts collapse back into `~/.claude/projects/<encodeCwd(cwd)>`, and
//     two boxes at one absolute path share one directory again. The defect
//     returns with nothing in cc failing.
//   * The CLI stops resolving symlinks before writing → it replaces a farm link
//     with a real file, and that remote silently stops sharing the host's
//     settings, plugins and skills from then on.
//   * `CLAUDE_SECURESTORAGE_CONFIG_DIR=''` stops meaning "the default" → the
//     worker cannot authenticate at all, because credentials are deliberately
//     NOT linked into the farm.
t('CLAUDE_CONFIG_DIR relocates the transcript dir, and the farm survives the run', async () => {
  const { dir, clean } = await fixture();
  try {
    // A farm shaped exactly like ensureRemoteConfigDir builds: a real private
    // `projects/`, links for everything shared, and NO `.credentials.json`.
    const source = path.join(dir, 'real-claude');
    const cfg = path.join(dir, 'farm', 'boxa-0123456789ab', '.claude');
    await fs.mkdir(path.join(source, 'plans'), { recursive: true });
    await fs.writeFile(path.join(source, 'settings.json'), '{}\n');
    await fs.mkdir(path.join(cfg, 'projects'), { recursive: true });
    for (const entry of ['plans', 'settings.json']) {
      await fs.symlink(path.join(source, entry), path.join(cfg, entry));
    }

    const work = path.join(dir, 'work');
    await fs.mkdir(work, { recursive: true });
    const hooks = await hookServer(() => ({}));
    let r;
    try {
      r = await runClaudeEnv(work, settingsJSON(hooks.url, {}), 'Reply with exactly: PROBE_OK', {
        CLAUDE_CONFIG_DIR: cfg,
        // The EMPTY-STRING form: credentials come from the real `~/.claude`
        // without being linked into the farm. If this stopped resolving to the
        // default the run would fail to authenticate and reject above.
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      });
    } finally { await hooks.close(); }
    assert.match(r.result, /PROBE_OK/);

    // 1. The transcript landed under the RELOCATED root, keyed by the cwd as
    //    always — the root moved, `encodeCwd` did not.
    const landed = path.join(cfg, 'projects', encodeCwd(work));
    const jsonls = (await fs.readdir(landed)).filter(n => n.endsWith('.jsonl'));
    assert.ok(jsonls.length >= 1, `no transcript under ${landed}`);

    // 2. And NOT under the host's own root, which is what the relocation means.
    const hostRoot = path.join(os.homedir(), '.claude', 'projects', encodeCwd(work));
    await assert.rejects(() => fs.access(hostRoot),
      `the CLI also wrote ${hostRoot} — CLAUDE_CONFIG_DIR did not relocate the transcript dir`);

    // 3. EVERY LINK SURVIVED. The CLI resolves a symlink before writing (or
    //    refuses by name); if it ever starts replacing one with a real file,
    //    this remote forks its config from the host's silently.
    for (const entry of ['plans', 'settings.json']) {
      assert.ok((await fs.lstat(path.join(cfg, entry))).isSymbolicLink(),
        `${entry} is no longer a symlink — the farm forked`);
    }
    // 4. And `projects/` stayed a real directory, never replaced by a link.
    assert.equal((await fs.lstat(path.join(cfg, 'projects'))).isSymbolicLink(), false);
  } finally { await clean(); }
});
