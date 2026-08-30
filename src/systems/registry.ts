// System resolution: the one place a project name becomes a System handle, and
// the one reader of the record field that names it.
//
// `local` is in-process; every other system is reached by launching the
// provider command its registry row carries and speaking the wire protocol to
// it (docs/systems-protocol.md). cc ships no TRANSPORT — the provider command
// is the user's, and what it connects to is its own business.
//
// A row with no provider command is registration only: it names a system
// nothing can reach, and a project on it is REFUSED here BY NAME rather than
// quietly resolved local (see resolveSystem).

import { readProjectMeta } from '../projects.ts';
import { httpError } from '../httpError.ts';
import { LocalSystem, LOCAL_SYSTEM_ID } from './localSystem.ts';
import { ProviderSystem } from './providerSystem.ts';
import type { Handshake } from './providerConnection.ts';
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
  // The provider command, as argv — argv[0] is the executable, and it is never
  // run through a shell (quoting would become part of the contract). Absent on
  // the managed `local` row, which is in-process, and on a user row that has
  // not been given one: such a row is a name with nothing behind it.
  launch?: string[];
}

// `local` is the machine cc runs on. It is managed for the same reason the
// `claude` backend row is: it is not a thing the user configured, it is the
// system every project is on until told otherwise, and a store that could
// delete it could strand every project.
export const MANAGED_SYSTEMS: readonly SystemRecord[] = [
  { id: LOCAL_SYSTEM_ID, label: 'This machine', managed: true },
];

export const MANAGED_SYSTEM_IDS: readonly string[] = MANAGED_SYSTEMS.map(s => s.id);

// THE PROVIDER SEAM, and the reason the protocol can be proved sufficient.
//
// `CC_LOCAL_SYSTEM_PROVIDER` replaces the in-process `local` system with a
// ProviderSystem speaking the wire protocol (docs/systems-protocol.md) to the
// named command — normally the reference provider, which is this same machine
// reached the long way round. Every project-scoped operation in the app then
// runs over the protocol, which is what lets the WHOLE test suite serve as the
// protocol's conformance gate in each capability configuration
// (`npm run gate:systems`). Following CLAUDE_BIN's precedent: an env seam whose
// only job is to make a real dependency swappable under test.
//
// The value is a JSON array of argv (`["node","…/referenceProvider.ts"]`); a
// value that is not a JSON array is taken as a bare executable path.
export const LOCAL_PROVIDER_ENV = 'CC_LOCAL_SYSTEM_PROVIDER';

// `varName` is the setting the value came FROM, so a typo is reported against
// the variable the reader actually set — the conformance harness parses
// CC_CONFORMANCE_PROVIDER through here too, and naming the wrong one sends them
// looking in the wrong place.
export function parseProviderLaunch(spec: string, varName: string = LOCAL_PROVIDER_ENV): string[] {
  const trimmed = spec.trim();
  if (trimmed.startsWith('[')) {
    const v: unknown = JSON.parse(trimmed);
    if (!Array.isArray(v) || v.length === 0 || v.some(x => typeof x !== 'string')) {
      throw new Error(`${varName} must be a non-empty JSON array of strings`);
    }
    return v as string[];
  }
  return [trimmed];
}

function buildLocalSystem(): System {
  const spec = process.env[LOCAL_PROVIDER_ENV];
  if (!spec?.trim()) return new LocalSystem();
  return new ProviderSystem({ id: LOCAL_SYSTEM_ID, launch: { argv: parseProviderLaunch(spec) } });
}

// One instance for the process: a System handle is a connection, not a value,
// and two `local` handles would be two identities for one machine.
const LOCAL: System = buildLocalSystem();

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

// resolveSystem for the LISTINGS, where a refusal is a VALUE rather than a throw.
//
// listProjects already promises that one bad entry does not take the page down
// — a broken `.external` link "is skipped, not fatal: the rest of the project
// list must still render". Its ENRICHMENT layer has to keep the same promise,
// and it did not: every listing fans its per-project work out through one
// `Promise.all`, so a single project whose record names an unreachable system
// rejected the whole batch and broke the list for every OTHER project too.
//
// So a listing resolves through here and degrades the one row it concerns; an
// addressed-by-name caller keeps resolveSystem and its throw, because there the
// refusal IS the answer. `unreachable` carries the refusal's own message, so the
// row can say WHY rather than just showing absent facts.
//
// It catches everything, not just the refusal: a listing that must render the
// rest of the list has the same duty for an unexpected fault as for an expected
// one.
export async function tryResolveSystem(
  projectName: string,
): Promise<{ system: System | null; unreachable: string | null }> {
  try {
    return { system: await resolveSystem(projectName), unreachable: null };
  } catch (e) {
    return { system: null, unreachable: e instanceof Error ? e.message : String(e) };
  }
}

// The System a project's tree, git repo and shell commands live on.
export async function resolveSystem(projectName: string): Promise<System> {
  const { system } = await projectPlacement(projectName);
  if (system === LOCAL_SYSTEM_ID) return LOCAL;
  return systemById(system, `project '${projectName}'`);
}

// One live handle per registered system, keyed by id. A System handle is a
// CONNECTION, not a value — the same reason `local` is a module singleton — so
// two handles for one id would be two provider processes claiming to be one
// machine, each with its own shell and its own view of what is running.
//
// Keyed on the launch argv as well, so editing a row's provider command
// replaces the handle instead of leaving the old process serving the new
// configuration.
const HANDLES = new Map<string, { key: string; sys: ProviderSystem }>();

function handleFor(row: SystemRecord, argv: string[]): ProviderSystem {
  const key = JSON.stringify(argv);
  const cur = HANDLES.get(row.id);
  if (cur && cur.key === key) return cur.sys;
  cur?.sys.dispose();
  const sys = new ProviderSystem({ id: row.id, launch: { argv } });
  HANDLES.set(row.id, { key, sys });
  return sys;
}

// Drop a system's live handle, shutting its provider process down. Called when
// a row is removed or its provider command changes, and by tests between
// fixtures.
export function disposeSystemHandle(id: string): void {
  const cur = HANDLES.get(id);
  if (!cur) return;
  cur.sys.dispose();
  HANDLES.delete(id);
}

export function disposeSystemHandles(): void {
  for (const id of [...HANDLES.keys()]) disposeSystemHandle(id);
}

// A registered id onto a live handle. `subject` names what is being resolved
// ("project 'x'", "system 'y'") so the refusal reads as an answer about the
// caller's question rather than about an id it never mentioned.
//
// EVERY REFUSAL HERE IS NAMED AND DISTINCT, because the three are three
// different repairs: register the system, give it a provider command, or fix
// the system that is down. Falling back to `local` for any of them would run
// the caller's operation against a path on the wrong machine and report
// success — the worst failure this design has.
export async function systemById(id: string, subject: string): Promise<System> {
  if (id === LOCAL_SYSTEM_ID) return LOCAL;
  // Dynamic: src/appSettings.ts imports this module for MANAGED_SYSTEMS, and a
  // static import back would close the cycle at module-evaluation time. Same
  // device projects.ts uses for worktrees.ts.
  const { getSystem } = await import('../appSettings.ts');
  const row = getSystem(id);
  if (!row) {
    throw systemRefusal(501, 'SYSTEM_NOT_REGISTERED',
      `${subject} is registered on system '${id}', which is not in the system registry`);
  }
  const argv = row.launch ?? [];
  if (argv.length === 0) {
    throw systemRefusal(501, 'SYSTEM_NO_PROVIDER',
      `${subject} is registered on system '${id}', which has no provider command — `
      + `give it one in Settings → Systems`);
  }
  const sys = handleFor(row, argv);
  // Connecting HERE, not at first use, is what keeps the degraded listing
  // honest: tryResolveSystem turns this refusal into the row's
  // `systemUnreachable` reason, whereas a handle that connects lazily would
  // hand the listing a System that fails every fact separately with nothing to
  // say why.
  try { await sys.connect(); }
  catch (e) {
    throw systemRefusal(502, 'SYSTEM_UNREACHABLE',
      `${subject} is on system '${id}', which cannot be reached: ${e instanceof Error ? e.message : String(e)}`);
  }
  return sys;
}

// The three ways cc can fail to reach a system, each with its OWN code because
// each is a different repair: register the system, give it a provider command,
// or fix the system that is down.
//
// They are also MARKED as a family, because a caller with a structured refusal
// vocabulary of its own — mergeWorktreeIntoParent — has to convert them into a
// returned refusal rather than let them throw through a contract that promised
// a value, and it must do that without matching on message text. Everything
// else keeps the throw: there the refusal IS the answer.
function systemRefusal(statusCode: number, code: string, message: string): Error {
  return httpError(statusCode, message, { code, systemRefusal: true });
}

export function isSystemRefusal(e: unknown): e is Error & { code: string } {
  return !!e && typeof e === 'object' && (e as { systemRefusal?: unknown }).systemRefusal === true;
}

// Can cc reach a system launched this way? Used by the registry BEFORE it
// persists a row, so a system that does not answer is refused at the one moment
// the user is looking at the command they typed. The probe owns its own
// throwaway handle — a row that is not saved must leave no live connection
// behind, and the id it would be saved under has no handle yet.
export async function probeSystemLaunch(argv: string[]): Promise<Handshake> {
  const probe = new ProviderSystem({ id: '(probe)', launch: { argv } });
  try { return await probe.connect(); }
  finally { probe.dispose(); }
}
