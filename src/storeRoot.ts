// Where cc's projects root and store live. A leaf: `src/sessionStore.ts` reads it,
// so it must not import anything that reaches back.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPlatform, type Platform } from './platform/index.ts';

// Default projects root = parent directory of the code-conductor repo,
// resolved once at module load. Layout: <parent>/code-conductor/src/
// projects.ts → <parent>/. Matches the convention that the orchestrator
// + its sibling projects all live under a single workspace dir (the
// user's ~/cc-projects/ by default). Override with PROJECTS_ROOT.
const DEFAULT_PROJECTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

// All orchestrator-owned state lives under a single dotfolder at the
// workspace root (`<projectsRoot>/.code-conductor/`). Layout:
//   <store>/projects/<name>/project.json
//   <store>/projects/<name>/attachments/<file>
//   <store>/projects/<name>/debug/<instance-id>/
//   <store>/projects/<name>/worktrees/<worktreeDir>/worktree.json
//   <store>/projects/<name>/worktrees/<worktreeDir>/attachments/<file>
//   <store>/projects/<name>/worktrees/<worktreeDir>/debug/<instance-id>/
// Project + worktree directories themselves stay clean.
export const ORCH_STORE_DIRNAME = '.code-conductor';

// Memoised per raw value: called per request, and tests swap PROJECTS_ROOT. A root
// the platform cannot resolve yet is returned raw and NOT memoised, so its spelling
// is fixed only once the directory exists.
export function canonicalRootMemo(platform: Platform): (raw: string) => string {
  const canonicalRoots = new Map<string, string>();
  return (raw) => {
    let canon = canonicalRoots.get(raw);
    if (canon === undefined) {
      const resolved = platform.canonicalPath(raw);
      if (resolved === null) return raw;
      canon = resolved;
      canonicalRoots.set(raw, canon);
    }
    return canon;
  };
}
const canonicalRoot = canonicalRootMemo(hostPlatform);

// The root spelled as the claude CLI's `getcwd()` reports it, so every cwd
// derived from it names the transcript dir the CLI will use.
export function projectsRoot(): string {
  return canonicalRoot(process.env.PROJECTS_ROOT ?? DEFAULT_PROJECTS_ROOT);
}

export function orchStoreRoot(): string {
  return path.join(projectsRoot(), ORCH_STORE_DIRNAME);
}

export function projectStoreDir(name: string): string {
  return path.join(orchStoreRoot(), 'projects', name);
}
