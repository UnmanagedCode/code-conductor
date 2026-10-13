// Pure derivations behind the sidebar's Conductors lens and its ownership
// colour. No DOM: every function maps the rows the sidebar already receives
// (`/api/instances` and the `.conduct` disk list) to plain values.
//
// Ownership is live-only by construction: the server reports `ownerSessionId`
// only on a live conducted instance (null on a hand-spawned session and on
// anything dead, never on a disk row), so nothing here needs its own liveness
// check to decide what a conductor owns. Spawn history is a separate,
// disk-derived input (`GET /api/conductors/projects`: the projects and the
// recorded worktree names) that reaches the sidebar only through
// conductorChips (the chips, the Conductors tree, the filter), never
// ownership.

import { promptPreview } from './promptPreview.ts';

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
  ownerSessionId?: string | null;
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
  ownerSessionId: string | null;
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
    ownerSessionId: inst.ownerSessionId ?? null,
    playbook: inst.playbook ?? null,
    stage: inst.stage ?? null,
    synthetic: true,
  };
}

const byActivityDesc = (a: ConductorRow, b: ConductorRow) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0);

// Every conductor — the non-archived `.conduct` disk rows unioned with the
// `.conduct` instances, keyed by sessionId — split into live (an instance in a
// live status) and inactive (disk-only, or an exited/crashed instance, which
// keeps its instanceId so opening it behaves as it does for any dead session).
// A conductor with a listed instance is placed by that instance whatever its
// disk row says: an instance does not report its session's archived state.
// `onDisk` says whether the `.conduct` list carries its transcript — false for
// an instance-only conductor that has not written one yet.
export function deriveConductors({ conductRows = [], instances = [] }: { conductRows?: readonly ConductRow[]; instances?: readonly InstanceFields[] } = {}): ConductorsSplit {
  const bySid = new Map<string, ConductorRow>();
  for (const r of conductRows) {
    if (!r?.sessionId || r.archived) continue;
    bySid.set(r.sessionId, {
      sessionId: r.sessionId,
      title: r.title ?? null,
      firstPrompt: r.firstPrompt ?? null,
      lastActivity: r.lastActivity ?? 0,
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
      onDisk: true,
    });
  }
  for (const inst of instances) {
    if (inst.project !== '.conduct' || !inst.sessionId) continue;
    // The instance fields after onDisk are placeholders, in the order the
    // assignments below write them.
    const row: ConductorRow = bySid.get(inst.sessionId) ?? {
      sessionId: inst.sessionId, title: null, firstPrompt: null, lastActivity: 0, onDisk: false,
      instanceId: null, instanceStatus: null, instanceDisplayStatus: null, instanceAwaitingWake: false,
      instanceWaitingOnJob: false, awaitingUser: null, awaitingUserSource: null, instanceTemp: false,
      autoResumeAt: null, queuedCount: 0, live: false,
    };
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
    bySid.set(inst.sessionId, row);
  }
  const all = [...bySid.values()];
  return {
    live: all.filter((c): c is LiveConductorRow => c.live).sort(byActivityDesc),
    inactive: all.filter(c => !c.live).sort(byActivityDesc),
  };
}

// The label a conductor row shows: its own title, else the first prompt (the
// same promptPreview as a session row), else the sessionId prefix. `untitled`
// says the text is a fallback, which the row renders muted italic.
export function conductorTitle(row: { title?: string | null; firstPrompt?: string | null; sessionId: string | null }): { text: string; untitled: boolean } {
  const custom = (row.title ?? '').trim();
  if (custom) return { text: custom, untitled: false };
  const preview = promptPreview(row.firstPrompt);
  if (preview) return { text: preview, untitled: true };
  return { text: `${String(row.sessionId).slice(0, 8)}…`, untitled: true };
}

// A conductor's live workers, nested ones included (they carry the same root
// owner).
export function workersOf<T extends { ownerSessionId?: string | null }>(conductorSid: string, instances: readonly T[]): T[] {
  return instances.filter(i => i.ownerSessionId === conductorSid);
}

// The distinct projects a set of workers sits in, sorted.
export function conductorProjects(workers: readonly { project: string }[]): string[] {
  return [...new Set(workers.map(w => w.project))].sort((a, b) => a.localeCompare(b));
}

// A conductor's chips: one per project it has a live owned worker in (live,
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

// place key → Set of the owners of the live conducted instances there.
export function ownersByPlace(instances: readonly InstanceFields[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const i of instances) {
    if (!i.ownerSessionId) continue;
    const k = placeKey(i);
    let set = out.get(k);
    if (!set) { set = new Set(); out.set(k, set); }
    set.add(i.ownerSessionId);
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
  if (inst) {
    const t = (inst.title ?? '').trim()
      || promptPreview(inst.firstPrompt);
    if (t) return t;
  }
  return `${String(sid).slice(0, 8)}…`;
}

// A worker's playbook binding as one line, verbatim; null when unbound.
export function stageText(s: { playbook?: string | null; stage?: string | null }): string | null {
  const parts = [s.playbook, s.stage].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}
