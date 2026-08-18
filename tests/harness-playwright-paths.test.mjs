// Regression guard for the one thing harness/playwright/ has no other cover for:
// the depth of its own path resolve. 4c1a3da moved debug/ -> harness/playwright/,
// adding a directory level, and left ORCH_ROOT one short; every bootOrch() caller
// then died with an opaque "child server exited before binding" (card 2026-0172).
//
// Imports harness/playwright/paths.mjs, NOT boot-orch.mjs: boot-orch statically
// imports the sibling code-playwright repo and throws on any machine without it
// cloned — which is why the four Playwright-adjacent tests in this directory defer
// their sibling import into the test body. paths.mjs is a node-builtins-only leaf
// precisely so this guard can run ungated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORCH_ROOT, ORCH_ENTRY, FAKE_CLAUDE } from '../harness/playwright/paths.mjs';

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
