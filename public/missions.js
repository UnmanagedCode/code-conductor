// Pure derivations behind the sidebar's Missions lens and its ownership
// colour. No DOM: every function maps the rows the sidebar already receives
// (`/api/instances` and the `.conduct` disk list) to plain values.
//
// Ownership is live-only by construction: the server reports `ownerSessionId`
// only on a live conducted instance (null on a hand-spawned session and on
// anything dead, never on a disk row), so nothing here needs its own liveness
// check to decide what a conductor owns.

// The client-side spelling of the server's isDeadStatus.
export function isLiveStatus(status) {
  return status !== 'exited' && status !== 'crashed';
}

// The session-row shape for a live instance with no on-disk row to overlay.
// sidebar.js's mergeLive builds its synthetic rows through this, and the
// Missions tree renders its worker rows from it.
export function sessionFromInstance(inst) {
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
    autoResumeAt: inst.autoResumeAt ?? null,
    queuedCount: inst.queuedCount ?? 0,
    conducted: !!inst.conducted,
    ownerSessionId: inst.ownerSessionId ?? null,
    playbook: inst.playbook ?? null,
    stage: inst.stage ?? null,
    synthetic: true,
  };
}

const byActivityDesc = (a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0);

// Every conductor — the `.conduct` disk rows (archived ones included: a temp
// conductor is archived on exit) unioned with the `.conduct` instances, keyed
// by sessionId — split into live (an instance in a live status) and inactive
// (disk-only, or an exited/crashed instance, which keeps its instanceId so
// opening it behaves as it does for any dead session).
export function deriveMissions({ conductRows = [], instances = [] } = {}) {
  const bySid = new Map();
  for (const r of conductRows) {
    if (!r?.sessionId) continue;
    bySid.set(r.sessionId, {
      sessionId: r.sessionId,
      title: r.title ?? null,
      firstPrompt: r.firstPrompt ?? null,
      lastActivity: r.lastActivity ?? 0,
      instanceId: null,
      instanceStatus: null,
      instanceDisplayStatus: null,
      instanceAwaitingWake: false,
      archived: !!r.archived,
      live: false,
    });
  }
  for (const inst of instances) {
    if (inst.project !== '.conduct' || !inst.sessionId) continue;
    const row = bySid.get(inst.sessionId) ?? {
      sessionId: inst.sessionId, title: null, firstPrompt: null, lastActivity: 0, archived: false,
    };
    row.instanceId = inst.id;
    row.instanceStatus = inst.status;
    row.instanceDisplayStatus = inst.displayStatus ?? null;
    row.instanceAwaitingWake = !!inst.awaitingWake;
    if (inst.title) row.title = inst.title;
    if (!row.firstPrompt && inst.firstPrompt) row.firstPrompt = inst.firstPrompt;
    row.lastActivity = Math.max(row.lastActivity ?? 0, inst.lastResponseAt ?? inst.createdAt ?? 0);
    row.live = isLiveStatus(inst.status);
    bySid.set(inst.sessionId, row);
  }
  const all = [...bySid.values()];
  return {
    live: all.filter(c => c.live).sort(byActivityDesc),
    inactive: all.filter(c => !c.live).sort(byActivityDesc),
  };
}

// The label a mission row shows: its own title, else the first prompt (the
// same preview rule as a session row), else the sessionId prefix. `untitled`
// says the text is a fallback, which the row renders muted italic.
export function missionTitle(row) {
  const custom = (row.title ?? '').trim();
  if (custom) return { text: custom, untitled: false };
  const preview = (row.firstPrompt ?? '').slice(0, 80).replace(/\s+/g, ' ').trim();
  if (preview) return { text: preview, untitled: true };
  return { text: `${String(row.sessionId).slice(0, 8)}…`, untitled: true };
}

// A conductor's live workers, nested ones included (they carry the same root
// owner).
export function workersOf(conductorSid, instances) {
  return instances.filter(i => i.ownerSessionId === conductorSid);
}

// The distinct projects a set of workers sits in, sorted.
export function missionProjects(workers) {
  return [...new Set(workers.map(w => w.project))].sort((a, b) => a.localeCompare(b));
}

// The place key sidebar.js buckets instances by: the project for its main
// checkout, `project:worktreeName` for a worktree.
export function placeKey(inst) {
  return inst.worktree?.worktreeName ? `${inst.project}:${inst.worktree.worktreeName}` : inst.project;
}

// place key → Set of the owners of the live conducted instances there.
export function ownersByPlace(instances) {
  const out = new Map();
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
export function worktreeOwnership(ownerSet) {
  const size = ownerSet?.size ?? 0;
  if (size === 0) return { kind: 'none' };
  if (size === 1) return { kind: 'single', owner: [...ownerSet][0] };
  return { kind: 'mixed' };
}

// A human label for an owner sessionId: its mission title, else a live
// instance's title or first prompt, else the sessionId prefix.
export function ownerLabel(sid, { missions, instances = [] } = {}) {
  const m = missions && [...(missions.live ?? []), ...(missions.inactive ?? [])].find(c => c.sessionId === sid);
  if (m) return missionTitle(m).text;
  const inst = instances.find(i => i.sessionId === sid);
  if (inst) {
    const t = (inst.title ?? '').trim()
      || (inst.firstPrompt ?? '').slice(0, 80).replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return `${String(sid).slice(0, 8)}…`;
}

// A worker's playbook binding as one line, verbatim; null when unbound.
export function stageText(s) {
  const parts = [s.playbook, s.stage].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}
