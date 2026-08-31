// THE CLI-CONTRACT REGRESSION TEST, part 3: CLAUDE_CODE_TMPDIR. Skipped by
// default — opt in with `RUN_CLI_CONTRACT=1`.
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/systems-cli-*.real.test.mjs
//
// cc pins this variable per redirected session so a worker can `Read` its own
// backgrounded command's interim output — the file the CLI's own tool result
// tells it to read, which lives on the ORCHESTRATOR and which the redirect would
// otherwise refuse as a path outside the session root. If the variable stops
// being honoured the file goes back under the per-uid tmp root and background
// Bash silently becomes unreadable to the worker.
//
// ITS OWN FILE because its two runs cost ~33s together and the hang guard charges
// a file the SUM of its cases (tests/hangGuardConfig.mjs).
//
// Harness, and the two rules every case follows: tests/cliContractCase.mjs.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fixture, hookServer, runClaudeEnv, settingsJSON, t, allow } from './cliContractCase.mjs';

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
