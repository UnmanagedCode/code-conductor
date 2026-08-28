// System resolution: the one place a project name becomes a System handle.
//
// Phase 1 registers exactly one system — the in-process `local` built-in — so
// every project resolves to it and nothing observable moves. The record field
// that can name another system (`system`/`systemPath` on `project.json`) lands
// in Phase 2, and remote resolution in Phase 4; both change the body of
// resolveSystem() and nothing else, which is the point of routing every
// project-scoped operation through it now.

import { LocalSystem } from './localSystem.ts';
import type { System } from './system.ts';

export { LOCAL_SYSTEM_ID } from './localSystem.ts';

// The hidden `.conduct` project — home of the conductor sessions that
// orchestrate everything else (src/conduct.ts). Its name is defined HERE rather
// than in conduct.ts because the pin below must hold without importing the
// conductor bootstrap, which imports src/projects.ts and would close a cycle
// with the resolver projects.ts itself calls. conduct.ts re-exports it, so
// every existing importer is unaffected.
export const CONDUCT_PROJECT_NAME = '.conduct';

// One instance for the process: a System handle is a connection, not a value,
// and two `local` handles would be two identities for one machine.
const LOCAL = new LocalSystem();

export function localSystem(): System {
  return LOCAL;
}

// The System a project's tree, git repo and shell commands live on.
export async function resolveSystem(projectName: string): Promise<System> {
  // `.conduct` IS the orchestrator, and cc runs it on its own host: its dir is
  // cc-owned under projectsRoot(), its sessions drive every other project over
  // MCP on 127.0.0.1, and the store it reads is local by invariant. So it is
  // pinned UNCONDITIONALLY — this returns before any record is consulted, and a
  // record naming a system for it is ignored rather than honoured.
  if (projectName === CONDUCT_PROJECT_NAME) return LOCAL;
  // Phase 2 reads the project record here; Phase 4 maps a non-local id onto a
  // registered system. Until then every project is local.
  return LOCAL;
}
