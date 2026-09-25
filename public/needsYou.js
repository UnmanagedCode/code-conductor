// Pure derivations behind the sidebar's needs-you strip and the waiting-on-you
// ring on a status dot. No DOM: every function maps the rows the sidebar
// already receives (`/api/instances`, and the Missions derivation over it) to
// plain values.
//
// The strip is built from live instances only, so an archived or disk-only
// session never reaches it: opening an entry always selects a live instance.

import { isLiveStatus, missionTitle } from './missions.js';

// Which strip group an entry sits in, or null for none. `status` is the status
// the dot renders (displayStatus over status). A sticky awaitingUser wins over
// every run state: a conductor re-invoked by a worker callback is running AND
// waiting on you, and is listed once, under Waiting.
export function stripGroupOf({ live, status, awaitingWake, awaitingUser }) {
  if (!live) return null;
  if (awaitingUser) return 'waiting';
  if (status === 'idle' && !awaitingWake) return 'finished';
  return 'running';
}

// The ask a session is waiting on, from the server's (kind, source) pair.
export function askLabel(kind, source) {
  if (source === 'text') return 'asked in text';
  return kind === 'plan' ? 'plan approval' : 'question';
}

// The run state alone.
export function runLabel(status, awaitingWake) {
  if (status === 'idle') return awaitingWake ? 'on a worker' : 'idle';
  if (status === 'turn' || status === 'running') return 'running';
  return status;
}

// Why an entry is in its group, for its tooltip and accessible name only.
export function entryReason(entry, group) {
  if (group === 'waiting') {
    return `${askLabel(entry.awaitingUser, entry.awaitingUserSource)} · ${runLabel(entry.status, entry.awaitingWake)}`;
  }
  if (group === 'running') return entry.awaitingWake ? 'on a worker' : 'working';
  return 'turn ended';
}

// The tooltip of a ringed dot.
export function needsYouTitle({ status, awaitingWake, awaitingUser, awaitingUserSource }) {
  return `waiting on you (${askLabel(awaitingUser, awaitingUserSource)}) · ${runLabel(status, awaitingWake)}`;
}

function conductorEntry(c) {
  return {
    sessionId: c.sessionId,
    instanceId: c.instanceId,
    label: missionTitle(c).text,
    conductor: true,
    live: isLiveStatus(c.instanceStatus),
    status: c.instanceDisplayStatus ?? c.instanceStatus,
    awaitingWake: !!c.instanceAwaitingWake,
    awaitingUser: c.awaitingUser ?? null,
    awaitingUserSource: c.awaitingUserSource ?? null,
  };
}

function handEntry(inst) {
  return {
    sessionId: inst.sessionId,
    instanceId: inst.id,
    label: missionTitle(inst).text,
    conductor: false,
    live: isLiveStatus(inst.status),
    status: inst.displayStatus ?? inst.status,
    awaitingWake: !!inst.awaitingWake,
    awaitingUser: inst.awaitingUser ?? null,
    awaitingUserSource: inst.awaitingUserSource ?? null,
    activity: inst.lastResponseAt ?? inst.createdAt ?? 0,
  };
}

// The strip's groups. `conductors` is deriveMissions(...).live, in its order;
// `instances` is the raw /api/instances list, from which the hand-spawned
// sessions (not conducted, not a conductor) are taken, newest first. Conducted
// workers are never listed; Running lists conductors only.
export function deriveStrip({ conductors = [], instances = [] } = {}) {
  const hand = instances
    .filter(i => i.sessionId && !i.conducted && i.project !== '.conduct' && isLiveStatus(i.status))
    .map(handEntry)
    .sort((a, b) => b.activity - a.activity);
  const pool = [...conductors.map(conductorEntry), ...hand];
  const groups = { waiting: [], running: [], finished: [] };
  for (const e of pool) {
    const g = stripGroupOf(e);
    if (!g || (g === 'running' && !e.conductor)) continue;
    groups[g].push(e);
  }
  return groups;
}

export function isStripEmpty(groups) {
  return groups.waiting.length === 0 && groups.running.length === 0 && groups.finished.length === 0;
}
