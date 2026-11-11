// Pure derivations behind the sidebar's Conductors lens and its ownership
// colour. No DOM: every function maps the rows the sidebar already receives
// (`/api/instances` and the `.conduct` disk list) to plain values.
//
// Ownership is live-only by construction: the server reports `rootSessionId`
// (the root conductor of a spawn chain) only on a live conducted instance
// (null on a hand-spawned session and on anything dead, never on a disk row),
// so nothing here needs its own liveness check to decide what a conductor
// owns. liveDirectOwnerOf refines that root to the direct owner — the live
// section lead that spawned the worker — and keeps the live-only gate.
// Spawn history is a separate,
// disk-derived input (`GET /api/conductors/projects`: the projects and the
// recorded worktree names) that reaches the sidebar only through
// conductorChips (the chips, the Conductors tree, the filter), never
// ownership.

import { sessionLabel } from './promptPreview.ts';

export const CONDUCT_PROJECT = '.conduct';
export const CONDUCTOR_LABEL = 'Conductor';
/** A project's display name: the conductor's hidden project reads as CONDUCTOR_LABEL. */
export function projectLabel(project: string): string {
  return project === CONDUCT_PROJECT ? CONDUCTOR_LABEL : project;
}

export type AskKind = 'question' | 'plan';
export type AskSource = 'tool' | 'text';

// The instance-summary fields (`/api/instances`) these derivations read.
export type InstanceFields = {
  id: string;
  project: string;
  status: string;
  displayStatus?: string | null;
  sessionId: string | null;
  mode?: string;
  temp?: boolean;
  conducted?: boolean;
  rootSessionId?: string | null;
  callerInstanceId?: string | null;
  awaitingWake?: boolean;
  waitingOnJob?: boolean;
  awaitingUser?: AskKind | null;
  awaitingUserSource?: AskSource | null;
  autoResumeAt?: number | null;
  queuedCount?: number;
  firstPrompt?: string | null;
  title?: string | null;
  lastResponseAt?: number | null;
  createdAt?: number;
  playbook?: string | null;
  stage?: string | null;
  worktree?: { worktreeName: string } | null;
};

// A `.conduct` disk session row's fields read here.
export type ConductRow = {
  sessionId?: string | null;
  archived?: boolean;
  conducted?: boolean;
  title?: string | null;
  firstPrompt?: string | null;
  lastActivity?: number;
};

export type ConductorRow = {
  sessionId: string;
  title: string | null;
  firstPrompt: string | null;
  lastActivity: number;
  onDisk: boolean;
  instanceId: string | null;
  instanceStatus: string | null;
  instanceDisplayStatus: string | null;
  instanceAwaitingWake: boolean;
  instanceWaitingOnJob: boolean;
  awaitingUser: AskKind | null;
  awaitingUserSource: AskSource | null;
  instanceTemp: boolean;
  autoResumeAt: number | null;
  queuedCount: number;
  live: boolean;
};

// A live row is placed by its instance, so the instance fields are set.
export type LiveConductorRow = ConductorRow & { instanceId: string; instanceStatus: string; live: true };

export type ConductorsSplit = { live: LiveConductorRow[]; inactive: ConductorRow[] };

export function isLiveConductor(c: ConductorRow): c is LiveConductorRow {
  return c.live;
}

// sessionFromInstance's row; `sessionId` is the instance's, narrowed or not.
export type InstanceSessionRow<S extends string | null = string | null> = {
  sessionId: S;
  firstPrompt: string | null;
  title: string | null;
  lastActivity: number | undefined;
  size: number;
  instanceId: string;
  instanceStatus: string;
  instanceDisplayStatus: string | null | undefined;
  instanceMode: string | undefined;
  instanceTemp: boolean;
  instanceAwaitingWake: boolean;
  instanceWaitingOnJob: boolean;
  conducted: boolean;
  rootSessionId: string | null;
  playbook: string | null;
  stage: string | null;
  synthetic: true;
};

// A recorded spawn history entry (SpawnedProject, src/conductorSpawns.ts).
export type SpawnedProject = { project: string; lastSpawnAt: string; worktrees?: string[] | null };

export type ConductorChip = { project: string; live: boolean; worktrees: string[] };

export type WorktreeOwnership = { kind: 'none' } | { kind: 'single'; owner: string } | { kind: 'mixed' };

// Whether an instance has a session yet; narrows `sessionId` for the caller.
export function hasSessionId<I extends { sessionId: string | null }>(inst: I): inst is I & { sessionId: string } {
  return !!inst.sessionId;
}

// The client-side spelling of the server's isDeadStatus.
export function isLiveStatus(status: string | null | undefined): boolean {
  return status !== 'exited' && status !== 'crashed';
}

// The session-row shape for a live instance with no on-disk row to overlay.
// sidebar.js's mergeLive builds its synthetic rows through this, and the
// Conductors tree renders its worker rows from it.
export function sessionFromInstance<I extends InstanceFields>(inst: I): InstanceSessionRow<I['sessionId']> {
  return {
    sessionId: inst.sessionId,
    firstPrompt: inst.firstPrompt ?? null,
    title: inst.title ?? null,
    // Both fallbacks are stable across renders — see mergeLive for why a
    // per-render Date.now() here would be wrong.
    lastActivity: inst.lastResponseAt ?? inst.createdAt,
    size: 0,
    instanceId: inst.id,
    instanceStatus: inst.status,
    instanceDisplayStatus: inst.displayStatus,
    instanceMode: inst.mode,
    instanceTemp: !!inst.temp,
    instanceAwaitingWake: !!inst.awaitingWake,
    instanceWaitingOnJob: !!inst.waitingOnJob,
    conducted: !!inst.conducted,
    rootSessionId: inst.rootSessionId ?? null,
    playbook: inst.playbook ?? null,
    stage: inst.stage ?? null,
    synthetic: true,
  };
}

/** A conductor of its own: a conductor-project session no conductor spawned. A section lead (conducted, in `.conduct`) is a worker. */
export function isTopLevelConductor(s: { project: string; conducted?: boolean | null }): boolean {
  return s.project === CONDUCT_PROJECT && !s.conducted;
}

const byActivityDesc = (a: ConductorRow, b: ConductorRow) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0);

// A conductor row from its `.conduct` disk row alone: every instance field at
// its not-live value. `onDisk` false is the placeholder for an instance with
// no disk row yet.
function conductorRowFromDisk(r: ConductRow & { sessionId: string }, onDisk: boolean): ConductorRow {
  return {
    sessionId: r.sessionId,
    title: r.title ?? null,
    firstPrompt: r.firstPrompt ?? null,
    lastActivity: r.lastActivity ?? 0,
    onDisk,
    instanceId: null,
    instanceStatus: null,
    instanceDisplayStatus: null,
    instanceAwaitingWake: false,
    instanceWaitingOnJob: false,
    // Instance-only: a dead conductor is never waiting on you, whatever
    // its disk row reports.
    awaitingUser: null,
    awaitingUserSource: null,
    // Instance-only: only a live instance can be promoted.
    instanceTemp: false,
    // Instance-only: an armed overage resume and its queue live on the
    // instance.
    autoResumeAt: null,
    queuedCount: 0,
    live: false,
  };
}

// Places a conductor row by its instance: the instance fields, its title over
// the disk row's, its first prompt where the disk row has none, and the later
// activity of the two.
function overlayInstance(row: ConductorRow, inst: InstanceFields): void {
  row.instanceId = inst.id;
  row.instanceStatus = inst.status;
  row.instanceDisplayStatus = inst.displayStatus ?? null;
  row.instanceAwaitingWake = !!inst.awaitingWake;
  row.instanceWaitingOnJob = !!inst.waitingOnJob;
  row.awaitingUser = inst.awaitingUser ?? null;
  row.awaitingUserSource = inst.awaitingUserSource ?? null;
  row.instanceTemp = !!inst.temp;
  row.autoResumeAt = inst.autoResumeAt ?? null;
  row.queuedCount = inst.queuedCount ?? 0;
  if (inst.title) row.title = inst.title;
  if (!row.firstPrompt && inst.firstPrompt) row.firstPrompt = inst.firstPrompt;
  row.lastActivity = Math.max(row.lastActivity ?? 0, inst.lastResponseAt ?? inst.createdAt ?? 0);
  row.live = isLiveStatus(inst.status);
}

// Every top-level conductor — the non-archived, non-conducted `.conduct` disk rows unioned with the
// non-conducted `.conduct` instances, keyed by sessionId — split into live (an instance in a
// live status) and inactive (disk-only, or an exited/crashed instance, which
// keeps its instanceId so opening it behaves as it does for any dead session).
// A conductor with a listed instance is placed by that instance whatever its
// disk row says: an instance does not report its session's archived state.
// `onDisk` says whether the `.conduct` list carries its transcript — false for
// an instance-only conductor that has not written one yet.
export function deriveConductors({ conductRows = [], instances = [] }: { conductRows?: readonly ConductRow[]; instances?: readonly InstanceFields[] } = {}): ConductorsSplit {
  const bySid = new Map<string, ConductorRow>();
  for (const r of conductRows) {
    if (!r?.sessionId || r.archived || r.conducted) continue;
    bySid.set(r.sessionId, conductorRowFromDisk(r as ConductRow & { sessionId: string }, true));
  }
  for (const inst of instances) {
    if (!hasSessionId(inst) || inst.project !== CONDUCT_PROJECT) continue;
    if (!isTopLevelConductor(inst)) { bySid.delete(inst.sessionId); continue; }
    const row = bySid.get(inst.sessionId) ?? conductorRowFromDisk({ sessionId: inst.sessionId }, false);
    overlayInstance(row, inst);
    bySid.set(inst.sessionId, row);
  }
  const all = [...bySid.values()];
  return {
    live: all.filter((c): c is LiveConductorRow => c.live).sort(byActivityDesc),
    inactive: all.filter(c => !c.live).sort(byActivityDesc),
  };
}

// The label a conductor row shows: its sessionLabel (the row is never
// synthetic, so an unprompted one reads as its sessionId prefix). `untitled`
// says the text is a fallback, which the row renders muted italic.
export function conductorTitle(row: { title?: string | null; firstPrompt?: string | null; sessionId: string | null }): { text: string; untitled: boolean } {
  return { text: sessionLabel(row), untitled: !(row.title ?? '').trim() };
}

// A section lead's conductor row: its conducted `.conduct` disk row (or the
// no-disk-row placeholder) overlaid with its instance, as deriveConductors
// builds a top-level conductor's.
export function sectionLeadRow(inst: InstanceFields & { sessionId: string }, conductRows: readonly ConductRow[]): ConductorRow {
  const r = conductRows.find(c => c?.sessionId === inst.sessionId && c.conducted);
  const row = r ? conductorRowFromDisk({ ...r, sessionId: inst.sessionId }, true) : conductorRowFromDisk({ sessionId: inst.sessionId }, false);
  overlayInstance(row, inst);
  return row;
}

// Who owns a worker, nearest first: the instance that spawned it when that is
// a live section lead (conducted, in `.conduct`, with a session), else the
// root the server reports (`rootSessionId`).
export function directOwnerOf(inst: InstanceFields, instances: readonly InstanceFields[]): string | null {
  const spawner = inst.callerInstanceId ? instances.find(i => i.id === inst.callerInstanceId) : undefined;
  if (spawner && spawner.project === CONDUCT_PROJECT && spawner.conducted && isLiveStatus(spawner.status) && spawner.sessionId) return spawner.sessionId;
  return inst.rootSessionId ?? null;
}

// directOwnerOf for a live owned instance only: null wherever the server
// reports no owner, so a dead worker of a live section lead is nobody's.
export function liveDirectOwnerOf(inst: InstanceFields, instances: readonly InstanceFields[]): string | null {
  return inst.rootSessionId ? directOwnerOf(inst, instances) : null;
}

// A conductor's live direct workers: a live section lead's workers belong to
// the section lead, not to its lead.
export function workersOf<T extends InstanceFields>(conductorSid: string, instances: readonly T[]): T[] {
  return instances.filter(i => liveDirectOwnerOf(i, instances) === conductorSid);
}

// The distinct projects a set of workers sits in, sorted.
export function conductorProjects(workers: readonly { project: string }[]): string[] {
  return [...new Set(workers.map(w => w.project))].sort((a, b) => a.localeCompare(b));
}

// A conductor's chips: one per project it has a live direct worker in (live,
// by name), then one per other project it has ever spawned into (idle, newest
// spawn first). An idle project that is no longer registered is dropped.
// Each chip carries `worktrees`, the recorded worktree names of its project's
// spawned entry (none when it has no entry).
export function conductorChips({ workers, spawned = [], registered }: {
  workers: readonly { project: string }[];
  spawned?: readonly SpawnedProject[];
  registered: ReadonlySet<string>;
}): ConductorChip[] {
  const live = conductorProjects(workers);
  const liveSet = new Set(live);
  const recorded = (e: SpawnedProject | undefined): string[] => (Array.isArray(e?.worktrees) ? e.worktrees : []);
  const byProject = new Map(spawned.map(e => [e.project, e]));
  const idle = spawned
    .filter(e => !liveSet.has(e.project) && registered.has(e.project))
    .sort((a, b) => (a.lastSpawnAt < b.lastSpawnAt ? 1 : a.lastSpawnAt > b.lastSpawnAt ? -1 : a.project.localeCompare(b.project)));
  return [
    ...live.map(project => ({ project, live: true, worktrees: recorded(byProject.get(project)) })),
    ...idle.map(e => ({ project: e.project, live: false, worktrees: recorded(e) })),
  ];
}

// The place key sidebar.js buckets instances by: the project for its main
// checkout, `project:worktreeName` for a worktree.
export function placeKey(inst: { project: string; worktree?: { worktreeName?: string } | null }): string {
  return inst.worktree?.worktreeName ? `${inst.project}:${inst.worktree.worktreeName}` : inst.project;
}

// place key → Set of the owners of the instances there, as `ownerOf` names
// them; an instance it maps to null has none.
export function ownersByPlace(instances: readonly InstanceFields[], ownerOf: (i: InstanceFields) => string | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const i of instances) {
    const owner = ownerOf(i);
    if (!owner) continue;
    const k = placeKey(i);
    let set = out.get(k);
    if (!set) { set = new Set(); out.set(k, set); }
    set.add(owner);
  }
  return out;
}

// How a worktree is coloured, from the owners of everything in it — never a
// filtered view of it.
export function worktreeOwnership(ownerSet: ReadonlySet<string> | null | undefined): WorktreeOwnership {
  const size = ownerSet?.size ?? 0;
  if (size === 0) return { kind: 'none' };
  if (size === 1) return { kind: 'single', owner: [...ownerSet!][0] };
  return { kind: 'mixed' };
}

// A human label for an owner sessionId: its conductor title, else a live
// instance's title or first prompt, else the sessionId prefix.
export function ownerLabel(sid: string, { conductors, instances = [] }: {
  conductors?: ConductorsSplit | null;
  instances?: readonly InstanceFields[];
} = {}): string {
  const m = conductors && [...(conductors.live ?? []), ...(conductors.inactive ?? [])].find(c => c.sessionId === sid);
  if (m) return conductorTitle(m).text;
  const inst = instances.find(i => i.sessionId === sid);
  if (inst) return sessionLabel({ ...inst, sessionId: sid });
  return `${String(sid).slice(0, 8)}…`;
}

// A worker's playbook binding as one line, verbatim; a stage named as its playbook shows once; null when unbound.
export function stageText(s: { playbook?: string | null; stage?: string | null }): string | null {
  const parts = s.playbook && s.playbook === s.stage ? [s.playbook] : [s.playbook, s.stage].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}
