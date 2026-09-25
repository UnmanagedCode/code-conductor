// The one resolver cc's harnesses (mutation/, playwright/) use to find an
// installed plugin: `<projectsRoot>/.plugins/<name>`.
//
// The projects root comes from CC_PROJECTS_ROOT, which cc exports to every
// worker it spawns. Without it (a shell outside cc) — and an empty value counts
// as unset — the root is derived from git: the main checkout's `.git` is a
// directory directly under the projects root, and `--git-common-dir` names it
// from the main checkout and from any worktree alike.
//
// LEAF MODULE — node builtins ONLY. harness/playwright/paths.mjs imports this,
// and that module must load under `npm test` on a machine with no plugins.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolution follows THIS checkout, not the caller's cwd.
const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function resolvePluginDir(name, { env = process.env, cwd = HARNESS_DIR } = {}) {
  let root, source;
  if (env.CC_PROJECTS_ROOT) {
    root = path.resolve(env.CC_PROJECTS_ROOT);
    source = 'from CC_PROJECTS_ROOT';
  } else {
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      throw new Error(`harness: cannot derive the projects root from git in ${cwd} because CC_PROJECTS_ROOT is unset: `
        + `${r.error?.message ?? r.stderr.trim()}`);
    }
    root = path.dirname(path.dirname(r.stdout.trim()));
    source = `derived from git in ${cwd} because CC_PROJECTS_ROOT is unset`;
  }
  const dir = path.join(root, '.plugins', name);
  if (!existsSync(dir)) {
    throw new Error(`harness: plugin "${name}" not found at ${dir} (projects root ${root}, ${source}). `
      + 'Install it from Settings → Plugin Library, or export CC_PROJECTS_ROOT=<the orchestrator\'s projects root>.');
  }
  return dir;
}
