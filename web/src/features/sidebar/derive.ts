// Pure derivations behind the sidebar tree: merging disk session lists with
// live instances, workspace grouping, the Projects-lens filter, and the
// reveal-on-select target. No React, no DOM.
import { sessionFromInstance, workersOf, isLiveStatus } from '@/lib/core/conductors.js';
import { promptPreview } from '@/lib/core/promptPreview.ts';
import { conductorChips, ownerLabel } from './core';
import type { Instance, Project } from '@/state/types';

export const CONDUCT_PROJECT = '.conduct';

/** A row of a Sessions subnode: a disk row with any live instance overlaid. */
export type SessionItem = {
  sessionId: string;
  title?: string | null;
  firstPrompt?: string | null;
  lastActivity?: number;
  instanceId?: string | null;
  instanceStatus?: string | null;
  instanceDisplayStatus?: string | null;
  instanceTemp?: boolean;
  instanceAwaitingWake?: boolean;
  instanceWaitingOnJob?: boolean;
  conducted?: boolean;
  archived?: boolean;
  synthetic?: boolean;
  ownerSessionId?: string | null;
  playbook?: string | null;
  stage?: string | null;
  [k: string]: unknown;
};

export type Conductors = { live: any[]; inactive: any[] };

export const wtName = (i: Instance): string | null => (i.worktree as any)?.worktreeName ?? null;

/** Sessions-cache / collapse key of a place: `project` or `project:worktree`. */
export const placeKeyOf = (project: string, worktree?: string | null) => (worktree ? `${project}:${worktree}` : project);

/**
 * Overlay live instances onto the on-disk list. A running instance whose jsonl
 * isn't on disk yet becomes a synthetic row. Newest activity first.
 */
export function mergeLive(onDisk: any[] | null | undefined, live: Instance[]): SessionItem[] {
  const byId = new Map<string, SessionItem>((onDisk ?? []).map((s) => [s.sessionId, { ...s, instanceTemp: !!s.temp }]));
  for (const inst of live) {
    if (!inst.sessionId) continue;
    const row = byId.get(inst.sessionId);
    if (row) {
      row.instanceId = inst.id;
      row.instanceStatus = inst.status;
      row.instanceDisplayStatus = inst.displayStatus;
      row.instanceMode = inst.mode;
      row.instanceTemp = !!inst.temp;
      row.instanceAwaitingWake = !!inst.awaitingWake;
      row.instanceWaitingOnJob = !!inst.waitingOnJob;
      row.conducted = !!inst.conducted || !!row.conducted;
      if (inst.title) row.title = inst.title;
      row.ownerSessionId = inst.ownerSessionId ?? null;
    } else {
      byId.set(inst.sessionId, sessionFromInstance(inst));
    }
  }
  return [...byId.values()].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
}

/** The row label: custom title → first-prompt preview (`promptPreview`) → sessionId prefix. */
export function sessionLabel(s: SessionItem): string {
  const title = (s.title ?? '').trim();
  const preview = promptPreview(s.firstPrompt);
  return title || preview || (s.synthetic ? '(new session)' : `${s.sessionId.slice(0, 8)}…`);
}

/** Live instances split by place: main checkout per project, and per `project:worktree`. */
export function partitionInstances(instances: Instance[]) {
  const directByProject = new Map<string, Instance[]>();
  const byWorktree = new Map<string, Instance[]>();
  for (const i of instances) {
    const wt = wtName(i);
    const map = wt ? byWorktree : directByProject;
    const key = wt ? `${i.project}:${wt}` : i.project;
    let arr = map.get(key);
    if (!arr) map.set(key, (arr = []));
    arr.push(i);
  }
  return { directByProject, byWorktree };
}

/** Disk count plus live sessions the cached disk list does not know yet. */
export function sessionsTotal(
  { key, liveInstances, summary }: { key: string; liveInstances: Instance[]; summary?: { count?: number } | null },
  cache: Map<string, any[]>,
) {
  const onDisk = summary?.count ?? 0;
  let extra = 0;
  if (onDisk > 0 || liveInstances.length > 0) {
    const cached = cache.get(key);
    if (cached) {
      const sids = new Set(cached.map((s) => s.sessionId));
      for (const i of liveInstances) if (i.sessionId && !sids.has(i.sessionId)) extra++;
    } else {
      extra = liveInstances.length;
    }
  }
  return onDisk + extra;
}

export const hasHandSession = ({ liveInstances, summary }: { liveInstances: Instance[]; summary?: { handCount?: number } | null }) =>
  (summary?.handCount ?? 0) > 0 || liveInstances.some((i) => !i.conducted);

/** `''` (All), `'hand'` (Hand-spawned only) or an owner sessionId. */
export type Filter = string;
export const filterOwner = (filter: Filter) => (filter && filter !== 'hand' ? filter : null);

export function chipsOf(sid: string, instances: Instance[], spawns: Record<string, any[]>, registered: Set<string>) {
  return conductorChips({ workers: workersOf(sid, instances), spawned: spawns[sid] ?? [], registered });
}

/** Filter options: All, Hand-spawned, each conductor with a chip, then other live owners. */
export function filterOptions(
  { conductors, instances, spawns, registered }: { conductors: Conductors; instances: Instance[]; spawns: Record<string, any[]>; registered: Set<string> },
): { value: string; label: string }[] {
  const order: string[] = [];
  for (const c of [...conductors.live, ...conductors.inactive]) {
    if (chipsOf(c.sessionId, instances, spawns, registered).length > 0) order.push(c.sessionId);
  }
  for (const i of instances) {
    const sid = i.ownerSessionId;
    if (sid && !order.includes(sid)) order.push(sid);
  }
  return [
    { value: '', label: 'All sessions' },
    { value: 'hand', label: 'Hand-spawned only' },
    ...order.map((sid) => ({ value: sid, label: ownerLabel(sid, { conductors, instances }) })),
  ];
}

/** Does `filter` show this instance's row? */
export function filterShows(filter: Filter, inst: Instance) {
  const owner = filterOwner(filter);
  if (owner) return inst.ownerSessionId === owner;
  return filter === 'hand' ? !inst.conducted : true;
}

export type ProjectGroup = { workspace: string; members: Project[]; count: number };

/**
 * Workspaces (sorted, empty ones kept) then unassigned projects, both narrowed
 * by `visible`. A workspace whose members are all hidden by an active filter drops out.
 */
export function groupProjects({ projects, workspaces, visible, filtering }: {
  projects: Project[]; workspaces: string[]; visible: (p: Project) => boolean; filtering: boolean;
}): { groups: ProjectGroup[]; unassigned: Project[] } {
  const byWorkspace = new Map<string, Project[]>();
  const unassigned: Project[] = [];
  for (const p of projects) {
    const w = typeof p.workspace === 'string' && p.workspace.trim() !== '' ? p.workspace.trim() : null;
    if (!w) { unassigned.push(p); continue; }
    let arr = byWorkspace.get(w);
    if (!arr) byWorkspace.set(w, (arr = []));
    arr.push(p);
  }
  for (const name of workspaces) if (!byWorkspace.has(name)) byWorkspace.set(name, []);
  const groups = [...byWorkspace.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((workspace) => {
      const all = byWorkspace.get(workspace)!;
      return { workspace, members: all.filter(visible), count: all.length };
    })
    .filter((g) => !filtering || g.members.length > 0);
  return { groups, unassigned: unassigned.filter(visible) };
}

/** The Sessions subnode's row order: normal, then temp, then conducted (archived rows dropped). */
export function sessionSections(rows: SessionItem[]) {
  const live = rows.filter((s) => !s.archived);
  return {
    normal: live.filter((s) => !s.conducted && !s.instanceTemp),
    temp: live.filter((s) => !s.conducted && s.instanceTemp),
    conducted: live.filter((s) => s.conducted),
  };
}

export type RevealTarget = {
  workspace: string | null;
  worktreesOf: string | null;
  sessionsKey: string | null;
  conductor: string | null;
  inactive: boolean;
  filter: Filter | null;
};

/** What a selection opens in both lenses, and the filter it switches to when the current one hides it. */
export function revealTarget({ inst, projects, conductors, filter }: {
  inst: Instance; projects: Project[]; conductors: Conductors; filter: Filter;
}): RevealTarget {
  const t: RevealTarget = { workspace: null, worktreesOf: null, sessionsKey: null, conductor: null, inactive: false, filter: null };
  const isConductor = inst.project === CONDUCT_PROJECT;
  const conductorSid = isConductor ? inst.sessionId : inst.ownerSessionId;
  const inInactive = conductors.inactive.some((c) => c.sessionId === conductorSid);
  if (conductorSid && (inInactive || conductors.live.some((c) => c.sessionId === conductorSid))) {
    if (!isConductor) t.conductor = conductorSid;
    if (inInactive) t.inactive = true;
  }
  const p = isConductor ? null : projects.find((q) => q.name === inst.project);
  if (p) {
    const ws = typeof p.workspace === 'string' ? p.workspace.trim() : '';
    if (ws) t.workspace = ws;
    const wt = wtName(inst);
    if (wt) t.worktreesOf = p.name;
    t.sessionsKey = placeKeyOf(p.name, wt);
    if (!filterShows(filter, inst)) t.filter = inst.ownerSessionId || (inst.conducted ? '' : 'hand');
  }
  return t;
}

/** The dot's run state for a session-like row. */
export function dotState(s: { status?: string | null; awaitingWake?: boolean; waitingOnJob?: boolean; awaitingUser?: string | null }) {
  const status = s.status ?? 'offline';
  const onWorker = status === 'idle' && !!s.awaitingWake;
  const onJob = status === 'idle' && !s.awaitingWake && !!s.waitingOnJob;
  const needsYou = !!s.awaitingUser && status !== 'offline' && isLiveStatus(status);
  return { status, waiting: onWorker ? 'worker' : onJob ? 'job' : null, needsYou };
}

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 288;

export function clampSidebarWidth(n: number): number | null {
  return Number.isFinite(n) ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, n)) : null;
}
