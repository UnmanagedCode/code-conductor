// The two path constants harness/playwright/ derives from its own depth, in one
// place so the guard in boot-orch.mjs and tests/harness-playwright-paths.test.mjs
// both check the SAME resolve rather than each protecting a private copy.
//
// LEAF MODULE — node builtins ONLY. Do not import code-playwright, boot-orch.mjs,
// or anything else from here. tests/harness-playwright-paths.test.mjs runs ungated
// under `npm test`, on machines with no sibling code-playwright clone; a single
// non-builtin import here would make that test unloadable and silently drop the
// only automated cover this directory has.
//
// History: 4c1a3da moved debug/ -> harness/playwright/, adding a directory level,
// and left the resolve below one short. See card 2026-0172.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This file lives at <repo>/harness/playwright/ — two levels below the repo root.
export const ORCH_ROOT = path.resolve(__dirname, '..', '..');
export const ORCH_ENTRY = path.join(ORCH_ROOT, 'server.ts');
export const FAKE_CLAUDE = path.join(ORCH_ROOT, 'tests', 'fake-claude.mjs');
