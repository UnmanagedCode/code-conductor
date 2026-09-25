// The path constants harness/playwright/ derives from its own depth, in one
// place so the guard in boot-orch.mjs and tests/harness-playwright-paths.test.mjs
// both check the SAME resolve rather than each protecting a private copy — plus
// the lazy loader for the code-playwright plugin.
//
// LEAF MODULE — node builtins ONLY (and ../pluginDir.mjs, itself a builtins-only
// leaf). Do not import code-playwright, boot-orch.mjs, or anything else from
// here. tests/harness-playwright-paths.test.mjs runs ungated under `npm test`,
// on machines without the code-playwright plugin; a single non-builtin import
// here would make that test unloadable and silently drop the only automated
// cover this directory has. The plugin is resolved only when a caller asks for
// it, so this module still loads without it.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePluginDir } from '../pluginDir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This file lives at <repo>/harness/playwright/ — two levels below the repo root.
export const ORCH_ROOT = path.resolve(__dirname, '..', '..');
export const ORCH_ENTRY = path.join(ORCH_ROOT, 'server.ts');
export const FAKE_CLAUDE = path.join(ORCH_ROOT, 'tests', 'fake-claude.mjs');

// `opts` is resolvePluginDir's `{ env, cwd }`.
export function codePlaywrightBrowser(opts) {
  return path.join(resolvePluginDir('code-playwright', opts), 'browser.mjs');
}

export function importCodePlaywright() {
  return import(pathToFileURL(codePlaywrightBrowser()).href);
}
