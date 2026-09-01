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
import { SystemError } from './protocol.ts';
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

// WHICH TARGET of that stand-in provider the `local` handle is bound to, and
// GATE-ONLY. It exists so the acceptance gate can run the whole application
// against a provider that serves NAMED targets — a shape `placementOf` will
// never produce for `local` in production, and therefore a shape no whole-suite
// pass could otherwise reach (card 2026-0266).
//
// A sibling of LOCAL_PROVIDER_ENV above, not a new category: it is inert without
// it, and can only ever modify the already-test-only stand-in. The guard is
// STRUCTURAL — buildLocalSystem returns the in-process LocalSystem before it
// reads this variable, so setting it alone cannot bind cc's own machine. Pinned
// by tests/systems-local.test.mjs.
export const LOCAL_REMOTE_ENV = 'CC_LOCAL_SYSTEM_REMOTE_ID';

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
  // THIS RETURN IS THE GUARD, and its position is the whole of it: the real
  // in-process system leaves before LOCAL_REMOTE_ENV is ever looked at.
  if (!spec?.trim()) return new LocalSystem();
  const remoteId = process.env[LOCAL_REMOTE_ENV]?.trim() || null;
  return new ProviderSystem({ id: LOCAL_SYSTEM_ID, remoteId, launch: { argv: parseProviderLaunch(spec) } });
}

// One instance for the process: a System handle is a connection, not a value,
// and two `local` handles would be two identities for one machine.
const LOCAL: System = buildLocalSystem();

export function localSystem(): System {
  return LOCAL;
}

// Where a project's tree lives: the System, WHICH TARGET of it, and — only for
// a non-local one — the path on it. A local project's path comes from the
// projects root or its `.external/<name>` symlink instead, so `systemPath`
// stays null for it.
//
// One registered system can serve many targets (ten containers behind one
// docker provider), so a path identifies a tree only together with BOTH: the
// tuple is (system, remoteId, path).
export interface ProjectPlacement {
  system: string;
  // Which target of that system, or null for the provider's own default.
  remoteId: string | null;
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
  meta: { system?: string | null; remoteId?: string | null; systemPath?: string | null },
): ProjectPlacement {
  // `.conduct` IS the orchestrator, and cc runs it on its own host: its dir is
  // cc-owned under projectsRoot(), its sessions drive every other project over
  // MCP on 127.0.0.1, and the store it reads is local by invariant. So it is
  // pinned UNCONDITIONALLY — this returns before the record is consulted, and a
  // record naming a system for it is IGNORED rather than honoured. Every reader
  // of a project's system comes through here, so the pin holds for all of them:
  // resolution, the listing, and the registry's still-referenced check.
  if (projectName === CONDUCT_PROJECT_NAME) {
    return { system: LOCAL_SYSTEM_ID, remoteId: null, systemPath: null };
  }
  const id = typeof meta.system === 'string' ? meta.system.trim() : '';
  // A local system forces `remoteId` null for the same reason it forces
  // `systemPath` null: cc's own machine is one machine, and a record naming a
  // target on it names nothing.
  if (!id || id === LOCAL_SYSTEM_ID) return { system: LOCAL_SYSTEM_ID, remoteId: null, systemPath: null };
  const p = typeof meta.systemPath === 'string' ? meta.systemPath.trim() : '';
  const r = typeof meta.remoteId === 'string' ? meta.remoteId.trim() : '';
  return { system: id, remoteId: r || null, systemPath: p || null };
}

export async function projectPlacement(projectName: string): Promise<ProjectPlacement> {
  return placementOf(projectName, await readProjectMeta(projectName));
}

// The System a project's tree, git repo and shell commands live on.
export async function resolveSystem(projectName: string): Promise<System> {
  const { system, remoteId } = await projectPlacement(projectName);
  if (system === LOCAL_SYSTEM_ID) return LOCAL;
  return systemById(system, remoteId, `project '${projectName}'`);
}

// One live handle per registered system, keyed by id. A System handle is a
// CONNECTION, not a value — the same reason `local` is a module singleton — so
// two handles for one id would be two provider processes claiming to be one
// machine, each with its own shell and its own view of what is running.
//
// Keyed on the launch argv as well, so editing a row's provider command
// replaces the handle instead of leaving the old process serving the new
// configuration.
//
// ONE OWNER PER ID, PLUS A BOUND VIEW PER REMOTE. The views SHARE the owner's
// connection: many targets behind one endpoint is the whole point, and
// multiplexing already carries it, so ten containers on one docker provider are
// one process rather than ten.
const HANDLES = new Map<string, { key: string; sys: ProviderSystem; views: Map<string, ProviderSystem> }>();

function handleFor(row: SystemRecord, argv: string[], remoteId: string | null): ProviderSystem {
  const key = JSON.stringify(argv);
  let cur = HANDLES.get(row.id);
  if (cur && cur.key !== key) {
    // The whole entry goes, views included: a view left behind would keep
    // serving over a connection that is about to be killed.
    disposeSystemHandle(row.id);
    cur = undefined;
  }
  if (!cur) {
    cur = { key, sys: new ProviderSystem({ id: row.id, launch: { argv } }), views: new Map() };
    HANDLES.set(row.id, cur);
  }
  if (remoteId === null) return cur.sys;
  let view = cur.views.get(remoteId);
  if (!view) {
    view = cur.sys.bindRemote(remoteId);
    cur.views.set(remoteId, view);
  }
  return view;
}

// Bumped every time a live handle is actually dropped — i.e. every time the
// MACHINE behind a registered id may now be a different machine, because its
// provider command changed or its row was removed. Read by the plugin catalog
// (src/plugins/contributions.ts), whose fragment bodies are keyed by
// (system, target, path): across an argv swap that key is byte-identical while
// the bytes behind it are not, so nothing else can invalidate it.
let handleGeneration = 0;

export function systemHandleGeneration(): number {
  return handleGeneration;
}

// Drop a system's live handle, shutting its provider process down. Called when
// a row is removed or its provider command changes, and by tests between
// fixtures.
export function disposeSystemHandle(id: string): void {
  const cur = HANDLES.get(id);
  if (!cur) return;
  handleGeneration++;
  // Views first, so each forgets its own shell before the process they all
  // share goes away. Only the OWNER's dispose kills it.
  for (const view of cur.views.values()) view.dispose();
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
export async function systemById(id: string, remoteId: string | null, subject: string): Promise<System> {
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
  const sys = handleFor(row, argv, remoteId);
  // Connecting HERE, not at first use, is what keeps the degraded listing
  // honest: tryResolveProject (src/projects.ts) turns this refusal into the
  // row's `systemUnreachable` reason, whereas a handle that connects lazily
  // would hand the listing a System that fails every fact separately with
  // nothing to say why.
  try { await sys.connect(); }
  catch (e) {
    throw systemRefusal(502, 'SYSTEM_UNREACHABLE',
      `${subject} is on system '${id}', which cannot be reached: ${e instanceof Error ? e.message : String(e)}`);
  }
  // And asking about the REMOTE here, for the same reason: a refusal at
  // resolution is what the degraded listing renders. It runs once per
  // connection generation, so this is not a round trip per resolution.
  if (remoteId !== null) {
    try { await sys.assertRemoteKnown(); }
    catch (e) {
      if (e instanceof SystemError && e.code === 'EUNSUPPORTED') {
        // A CONFIG error, like the two above: the provider cannot do this at
        // all, and the repair is to drop the remote or upgrade the provider.
        throw systemRefusal(501, 'SYSTEM_NO_REMOTES',
          `${subject} names remote '${remoteId}' on system '${id}', but ${e.message} — `
          + `clear the remote, or give the system a provider that serves named targets`);
      }
      if (e instanceof SystemError && e.code === 'ENOREMOTE') {
        // 502 for the same reason SYSTEM_UNREACHABLE is: the far side ANSWERED.
        throw systemRefusal(502, 'REMOTE_NOT_FOUND',
          `${subject} is on remote '${remoteId}' of system '${id}', which does not serve it: ${e.message}`);
      }
      throw e;
    }
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
