// Orch-specific wrapper around code-playwright's generic bootServer. Hardcodes
// the orchestrator's cwd and entrypoint (ORCH_ROOT / ORCH_ENTRY from ./paths.mjs
// — the repo root, two levels up from this directory), plus the sandbox shape
// that tests/fake-claude.mjs expects (PROJECTS_ROOT + CLAUDE_PROJECTS_ROOT
// subdirs and CLAUDE_BIN pointing at the fake).
//
// The generic harness lives in a sibling repo cloned to the parent directory
// of code-conductor. See ./README.md for setup.
//
//   import { bootOrch } from './boot-orch.mjs';
//   const orch = await bootOrch({ sandbox: true });
//   try {
//     // orch.url
//     // orch.sandbox.dirs.PROJECTS_ROOT, orch.sandbox.dirs.CLAUDE_PROJECTS_ROOT
//   } finally { await orch.close(); }

import { existsSync } from 'node:fs';
import { bootServer } from '../../../code-playwright/browser.mjs';
import { ORCH_ROOT, ORCH_ENTRY, FAKE_CLAUDE } from './paths.mjs';

// A silent depth change spends 15s inside bootServer's readiness poll and then
// reports only "child server exited before binding" — the child's real
// MODULE_NOT_FOUND is swallowed by `silent: true` (snap.mjs:53). Say what broke.
for (const p of [ORCH_ENTRY, FAKE_CLAUDE]) {
  if (!existsSync(p)) {
    throw new Error(
      `boot-orch: ORCH_ROOT=${ORCH_ROOT} but ${p} does not exist — ` +
      `./paths.mjs is resolving the wrong depth (see tests/harness-playwright-paths.test.mjs)`,
    );
  }
}

// Pass `sandbox: true` for the common orch test-shape: ephemeral
// PROJECTS_ROOT + CLAUDE_PROJECTS_ROOT, plus CLAUDE_BIN pointing at
// tests/fake-claude.mjs. Pass `scenario: '<abs path>'` to point fake-claude
// at a scenario file (same shape as tests/fixtures/scenario-*.json).
export async function bootOrch({ sandbox = false, scenario, ...rest } = {}) {
  return bootServer({
    cwd: ORCH_ROOT,
    entry: ORCH_ENTRY,
    ...rest,
    sandbox: sandbox ? {
      dirs: {
        PROJECTS_ROOT: 'project',
        CLAUDE_PROJECTS_ROOT: '.claude/projects',
      },
      env: {
        CLAUDE_BIN: `${process.execPath} ${FAKE_CLAUDE}`,
        ...(scenario ? { FAKE_CLAUDE_SCENARIO: scenario } : {}),
      },
    } : undefined,
  });
}
