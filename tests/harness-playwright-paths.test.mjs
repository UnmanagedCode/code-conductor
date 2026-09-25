// Regression guard for the one thing harness/playwright/ has no other cover for:
// the depth of its own path resolve. A resolve one level short makes every
// bootOrch() caller die with an opaque "child server exited before binding".
//
// Imports harness/playwright/paths.mjs, NOT boot-orch.mjs: boot-orch loads the
// code-playwright plugin at module load and throws on any machine without it
// installed — which is why the Playwright-adjacent tests in this directory defer
// that load into the test body. paths.mjs is node-builtins-only, transitively (its one
// non-builtin import, harness/pluginDir.mjs, is itself a builtins-only leaf, and
// the plugin is resolved only when asked) precisely so this guard can run ungated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORCH_ROOT, ORCH_ENTRY, FAKE_CLAUDE, codePlaywrightBrowser } from '../harness/playwright/paths.mjs';

// Derived from THIS file's depth (tests/ is one level down), so it is an
// independent cross-check of harness/playwright/'s resolve, not a copy of it.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('harness/playwright resolves the repo root, not an intermediate directory', () => {
  assert.equal(ORCH_ROOT, REPO_ROOT);
});

test('every harness/playwright path constant points at a file that exists', () => {
  assert.ok(existsSync(ORCH_ENTRY), `bootOrch entrypoint missing: ${ORCH_ENTRY}`);
  assert.ok(existsSync(FAKE_CLAUDE), `fake-claude missing: ${FAKE_CLAUDE}`);
});

test('codePlaywrightBrowser() resolves browser.mjs inside the code-playwright plugin dir', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-pw-paths-'));
  try {
    await fsp.mkdir(path.join(root, '.plugins', 'code-playwright'), { recursive: true });
    assert.equal(codePlaywrightBrowser({ env: { CC_PROJECTS_ROOT: root } }),
      path.join(root, '.plugins', 'code-playwright', 'browser.mjs'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
