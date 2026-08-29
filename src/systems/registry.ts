// System resolution: the one place a project name becomes a System handle, and
// the one reader of the record field that names it.
//
// `local` is the only implementation there is. A user can REGISTER another
// system (Settings -> Systems) and a project record can name it, but there is
// no transport to reach one yet — so such a project is REFUSED here rather than
// quietly resolved local (see resolveSystem).

import { readProjectMeta } from '../projects.ts';
import { httpError } from '../httpError.ts';
import { LocalSystem, LOCAL_SYSTEM_ID } from './localSystem.ts';
import type { System } from './system.ts';

export { LOCAL_SYSTEM_ID };

// The hidden `.conduct` project — home of the conductor sessions that
// orchestrate everything else (src/conduct.ts). Its name is defined HERE rather
// than in conduct.ts because the pin below must hold without importing the
// conductor bootstrap, which imports src/projects.ts and would close a cycle
// with the resolver projects.ts itself calls. conduct.ts re-exports it, so
// every existing importer is unaffected.
export const CONDUCT_PROJECT_NAME = '.conduct';

// A row in the system registry (Settings → Systems). `managed` marks a
// CODE-authoritative row: it always exists, is never persisted to the store,
// and cannot be edited or removed. Registration only — a row says a system
// exists and what to call it; nothing here reaches it.
export interface SystemRecord {
  id: string;
  label: string;
  managed: boolean;
}

// `local` is the machine cc runs on. It is managed for the same reason the
// `claude` backend row is: it is not a thing the user configured, it is the
// system every project is on until told otherwise, and a store that could
// delete it could strand every project.
export const MANAGED_SYSTEMS: readonly SystemRecord[] = [
  { id: LOCAL_SYSTEM_ID, label: 'This machine', managed: true },
];

export const MANAGED_SYSTEM_IDS: readonly string[] = MANAGED_SYSTEMS.map(s => s.id);

// One instance for the process: a System handle is a connection, not a value,
// and two `local` handles would be two identities for one machine.
const LOCAL = new LocalSystem();

export function localSystem(): System {
  return LOCAL;
}

// Where a project's tree lives: the System, and — only for a non-local one —
// the path on it. A local project's path comes from the projects root or its
// `.external/<name>` symlink instead, so `systemPath` stays null for it.
export interface ProjectPlacement {
  system: string;
  systemPath: string | null;
}

// THE PIN, and the one reader of the record's `system` field.
//
// ABSENCE OF `system` IS THE LOCAL ANSWER. That is the whole migration story:
// most projects have no `project.json` at all, so stamping `system: "local"`
// would CREATE ~25 files to record the default, and writeProjectMeta drops
// empty fields anyway. Reading absence as local is what makes no-backfill
// correct rather than merely cheap.
//
// Pure, and takes an already-read record, so a caller holding one (listProjects
// reads it for `workspace`) does not read it twice.
export function placementOf(
  projectName: string,
  meta: { system?: string | null; systemPath?: string | null },
): ProjectPlacement {
  // `.conduct` IS the orchestrator, and cc runs it on its own host: its dir is
  // cc-owned under projectsRoot(), its sessions drive every other project over
  // MCP on 127.0.0.1, and the store it reads is local by invariant. So it is
  // pinned UNCONDITIONALLY — this returns before the record is consulted, and a
  // record naming a system for it is IGNORED rather than honoured. Every reader
  // of a project's system comes through here, so the pin holds for all of them:
  // resolution, the listing, and the registry's still-referenced check.
  if (projectName === CONDUCT_PROJECT_NAME) return { system: LOCAL_SYSTEM_ID, systemPath: null };
  const id = typeof meta.system === 'string' ? meta.system.trim() : '';
  if (!id || id === LOCAL_SYSTEM_ID) return { system: LOCAL_SYSTEM_ID, systemPath: null };
  const p = typeof meta.systemPath === 'string' ? meta.systemPath.trim() : '';
  return { system: id, systemPath: p || null };
}

export async function projectPlacement(projectName: string): Promise<ProjectPlacement> {
  return placementOf(projectName, await readProjectMeta(projectName));
}

// The System a project's tree, git repo and shell commands live on.
export async function resolveSystem(projectName: string): Promise<System> {
  const { system } = await projectPlacement(projectName);
  if (system === LOCAL_SYSTEM_ID) return LOCAL;
  // SYSTEMS-P4 maps a registered id onto a live handle here. Until the wire
  // protocol exists there is no handle to map it to, and REFUSING is the only
  // honest answer: falling back to `local` would run every operation for this
  // project against a path on the wrong machine — the silent no-op that reports
  // success, which is the worst failure this design has.
  throw httpError(
    501,
    `project '${projectName}' is registered on system '${system}', which cc cannot reach yet`,
  );
}
