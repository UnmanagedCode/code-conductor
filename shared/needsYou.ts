// Pure derivations behind the sidebar's needs-you strip and the waiting-on-you
// ring on a status dot. No DOM: every function maps the rows the sidebar
// already receives (`/api/instances`, and the Conductors derivation over it) to
// plain values.
//
// The strip is built from live instances only, so an archived or disk-only
// session never reaches it: opening an entry always selects a live instance.

import { isLiveStatus, conductorTitle } from './conductors.ts';
import type { AskKind, AskSource, InstanceFields, LiveConductorRow } from './conductors.ts';

export type Waiting = 'worker' | 'job';
export type StripGroup = 'waiting' | 'running' | 'finished';

// One needs-you strip entry: a live conductor or a hand-spawned session.
export type StripEntry = {
  sessionId: string;
  instanceId: string;
  label: string;
  projectName: string;
  worktreeName: string | null;
  temp: boolean;
  synthetic: boolean;
  conductor: boolean;
  live: boolean;
  status: string | null;
  awaitingWake: boolean;
  waitingOnJob: boolean;
  awaitingUser: AskKind | null;
  awaitingUserSource: AskSource | null;
  autoResumeAt: number | null;
  queuedCount: number;
  activity?: number;
};

export type StripGroups = Record<StripGroup, StripEntry[]>;

// The run and ask state a label is read from.
type RunState = {
  status: string | null;
  awaitingWake?: boolean;
  waitingOnJob?: boolean;
  awaitingUser?: string | null;
  awaitingUserSource?: string | null;
};

// What an idle session is still waiting on: 'worker' (a held wake — it owns a
// worker whose turn is still running), 'job' (a running background Bash job on
// it or on a live session it owns), or null. A worker wins: that wait is the one
// that will wake it. Only an idle session can be waiting; any other status
// already reads as busy or dead.
export function waitingOn(status: string | null | undefined, awaitingWake?: boolean, waitingOnJob?: boolean): Waiting | null {
  if (status !== 'idle') return null;
  if (awaitingWake) return 'worker';
  return waitingOnJob ? 'job' : null;
}

const WAITING_LABEL: Record<Waiting, string> = { worker: 'on a worker', job: 'on a job' };

// WAITING_LABEL[waitingOn(…)], read as undefined for null.
const waitingLabel = (w: Waiting | null): string | undefined => (w ? WAITING_LABEL[w] : undefined);

// Which strip group an entry sits in, or null for none. `status` is the status
// the dot renders (displayStatus over status). A sticky awaitingUser wins over
// every run state: a conductor re-invoked by a worker callback is running AND
// waiting on you, and is listed once, under Waiting.
export function stripGroupOf({ live, status, awaitingWake, waitingOnJob, awaitingUser }: Pick<StripEntry, 'live' | 'status' | 'awaitingWake' | 'waitingOnJob' | 'awaitingUser'>): StripGroup | null {
  if (!live) return null;
  if (awaitingUser) return 'waiting';
  if (status === 'idle' && !waitingOn(status, awaitingWake, waitingOnJob)) return 'finished';
  return 'running';
}

// The ask a session is waiting on, from the server's (kind, source) pair.
export function askLabel(kind: string | null | undefined, source: string | null | undefined): string {
  if (source === 'text') return 'asked in text';
  return kind === 'plan' ? 'plan approval' : 'question';
}

// The run state alone.
export function runLabel<S extends string | null | undefined>(status: S, awaitingWake?: boolean, waitingOnJob?: boolean): string | S {
  if (status === 'idle') return waitingLabel(waitingOn(status, awaitingWake, waitingOnJob)) ?? 'idle';
  if (status === 'turn' || status === 'running') return 'running';
  return status;
}

// Why an entry is in its group, for its tooltip and accessible name only.
// `unread` (a Finished entry with an unseen turn end) is read in Finished only.
export function entryReason(entry: RunState, group: StripGroup, unread = false): string {
  if (group === 'waiting') {
    return `${askLabel(entry.awaitingUser, entry.awaitingUserSource)} · ${runLabel(entry.status, entry.awaitingWake, entry.waitingOnJob)}`;
  }
  if (group === 'running') return waitingLabel(waitingOn(entry.status, entry.awaitingWake, entry.waitingOnJob)) ?? 'working';
  return unread ? 'turn ended · unread' : 'turn ended';
}

// The tooltip of a ringed dot.
export function needsYouTitle({ status, awaitingWake, waitingOnJob, awaitingUser, awaitingUserSource }: RunState): string {
  return `waiting on you (${askLabel(awaitingUser, awaitingUserSource)}) · ${runLabel(status, awaitingWake, waitingOnJob)}`;
}

function conductorEntry(c: LiveConductorRow): StripEntry {
  return {
    sessionId: c.sessionId,
    instanceId: c.instanceId,
    label: conductorTitle(c).text,
    projectName: '.conduct',
    worktreeName: null,
    temp: !!c.instanceTemp,
    synthetic: !c.onDisk,
    conductor: true,
    live: isLiveStatus(c.instanceStatus),
    status: c.instanceDisplayStatus ?? c.instanceStatus,
    awaitingWake: !!c.instanceAwaitingWake,
    waitingOnJob: !!c.instanceWaitingOnJob,
    awaitingUser: c.awaitingUser ?? null,
    awaitingUserSource: c.awaitingUserSource ?? null,
    autoResumeAt: c.autoResumeAt ?? null,
    queuedCount: c.queuedCount ?? 0,
  };
}

function handEntry(inst: InstanceFields & { sessionId: string }): StripEntry & { activity: number } {
  return {
    sessionId: inst.sessionId,
    instanceId: inst.id,
    label: conductorTitle(inst).text,
    projectName: inst.project,
    worktreeName: inst.worktree?.worktreeName ?? null,
    temp: !!inst.temp,
    // A live temp session's transcript is never listed while it is alive, so
    // its sidebar row is synthetic too — this matches what that row's × sends.
    synthetic: !!inst.temp,
    conductor: false,
    live: isLiveStatus(inst.status),
    status: inst.displayStatus ?? inst.status,
    awaitingWake: !!inst.awaitingWake,
    waitingOnJob: !!inst.waitingOnJob,
    awaitingUser: inst.awaitingUser ?? null,
    awaitingUserSource: inst.awaitingUserSource ?? null,
    autoResumeAt: inst.autoResumeAt ?? null,
    queuedCount: inst.queuedCount ?? 0,
    activity: inst.lastResponseAt ?? inst.createdAt ?? 0,
  };
}

// Every top-level session, grouped or not: `conductors` is
// deriveConductors(...).live, in its order; `instances` is the raw
// /api/instances list, from which the hand-spawned sessions (not conducted, not
// a conductor) are taken, newest first. Conducted workers are never included.
// The strip and the attention notifier share this population.
export function topLevelEntries({ conductors = [], instances = [] }: { conductors?: readonly LiveConductorRow[]; instances?: readonly InstanceFields[] } = {}): StripEntry[] {
  const hand = instances
    .filter((i): i is InstanceFields & { sessionId: string } => !!(i.sessionId && !i.conducted && i.project !== '.conduct' && isLiveStatus(i.status)))
    .map(handEntry)
    .sort((a, b) => b.activity - a.activity);
  return [...conductors.map(conductorEntry), ...hand];
}

// The strip's groups.
export function deriveStrip({ conductors = [], instances = [] }: { conductors?: readonly LiveConductorRow[]; instances?: readonly InstanceFields[] } = {}): StripGroups {
  const groups: StripGroups = { waiting: [], running: [], finished: [] };
  for (const e of topLevelEntries({ conductors, instances })) {
    const g = stripGroupOf(e);
    if (!g) continue;
    groups[g].push(e);
  }
  return groups;
}

export function isStripEmpty(groups: StripGroups): boolean {
  return groups.waiting.length === 0 && groups.running.length === 0 && groups.finished.length === 0;
}
