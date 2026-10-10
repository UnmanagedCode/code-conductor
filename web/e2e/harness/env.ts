// The environment a booted cc runs in: an ALLOWLIST of the runner's env plus
// every path pointed into the scratch root. A run started from inside a cc
// worker inherits CC_PROJECTS_ROOT, CLAUDECODE, CLAUDE_CODE_SESSION_ID and the
// like; cc passes its own env on to the workers it spawns, so anything not
// listed here would reach them.

import path from 'node:path';

export type ScratchDirs = {
  root: string;
  projects: string;
  claudeConfig: string;
  claudeProjects: string;
  home: string;
  gitconfig: string;
  log: string;
  workerEnv: string;
};

export function scratchLayout(root: string): ScratchDirs {
  const claudeConfig = path.join(root, 'claude-config');
  return {
    root,
    projects: path.join(root, 'projects'),
    claudeConfig,
    claudeProjects: path.join(claudeConfig, 'projects'),
    home: path.join(root, 'home'),
    gitconfig: path.join(root, 'gitconfig'),
    log: path.join(root, 'server.log'),
    workerEnv: path.join(root, 'worker-env.txt'),
  };
}

const KEPT = new Set(['PATH', 'LANG', 'TERM', 'TZ', 'TMPDIR']);
const kept = (name: string): boolean => KEPT.has(name) || name.startsWith('LC_');

export function isolatedEnv(
  { base = process.env, dirs, port, env = {} }:
  { base?: NodeJS.ProcessEnv; dirs: ScratchDirs; port: number; env?: Record<string, string> },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && kept(k)) out[k] = v;
  return {
    ...out,
    HOME: dirs.home,
    PROJECTS_ROOT: dirs.projects,
    CLAUDE_CONFIG_DIR: dirs.claudeConfig,
    CLAUDE_PROJECTS_ROOT: dirs.claudeProjects,
    PORT: String(port),
    HOST: '127.0.0.1',
    GIT_CONFIG_GLOBAL: dirs.gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    CC_SKIP_WEB_BUILD: '1',
    FAKE_CLAUDE_ENV_DUMP: dirs.workerEnv,
    ...env,
  };
}
