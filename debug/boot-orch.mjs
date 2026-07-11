// Orch-specific wrapper around code-playwright's generic
// bootServer. Hardcodes the orchestrator's cwd (..) and entrypoint
// (server.js), plus the sandbox shape that tests/fake-claude.mjs expects
// (PROJECTS_ROOT + CLAUDE_PROJECTS_ROOT subdirs and CLAUDE_BIN pointing
// at the fake).
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

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer } from '../../code-playwright/browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, '..');
const FAKE_CLAUDE = path.join(ORCH_ROOT, 'tests', 'fake-claude.mjs');

// Pass `sandbox: true` for the common orch test-shape: ephemeral
// PROJECTS_ROOT + CLAUDE_PROJECTS_ROOT, plus CLAUDE_BIN pointing at
// tests/fake-claude.mjs. Pass `scenario: '<abs path>'` to point fake-claude
// at a scenario file (same shape as tests/fixtures/scenario-*.json).
export async function bootOrch({ sandbox = false, scenario, ...rest } = {}) {
  return bootServer({
    cwd: ORCH_ROOT,
    entry: 'server.js',
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
