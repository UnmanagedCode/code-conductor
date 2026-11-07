// Playbook state — the in-memory projection of where every playbook-bound worker
// stands, folded from the event log's rows (src/eventLog.ts). Only `call` rows
// carrying `bind` or `move`, and `config` rows, fold to anything; every other row
// is history for readers of the file.
//
// One known limitation lives next to this module — DEFINITION DRIFT (settled). A
// playbook definition edited while workers are in flight is not pinned: no
// definition snapshot, no definition hash on the binding, and a load is never
// refused for invalidating a live run. Live workers pick up the reloaded graph,
// and a worker whose stage or edge vanished under it gets a refusal instead.
// That is accepted — which is why playbooks.ts makes STAGE_UNKNOWN/
// PLAYBOOK_UNKNOWN on a LIVE worker say the definition changed, rather than
// reading like a caller error.
//
// A worker's BINDING survives a context rotation: this projection is keyed by
// the PERMANENT public sessionId, which neither a `renew_session` nor a prune
// moves (see src/sessionLineage.ts).
//
// Liveness is answered from InstanceManager.isSessionLive (src/instances.ts) —
// THE single liveness authority — never from this projection: `session` rows
// fold to nothing, so a host reboot (an unobserved death, no `exit` row) costs
// nothing. See docs/protocol.md → Playbooks for the wire contract.

import type { EventRow } from './eventLog.ts';

export interface WorkerState {
  sessionId: string;
  playbook: string;
  stage: string;
  // Every stage this worker has occupied, entry stage first — stage CHANGES, so
  // never two equal stages in a row. What makes a `needs` entry's provenance
  // half answerable.
  stageHistory: string[];
  // The `provenance` map ({stage: sessionId}) supplied when this worker entered
  // its current stage — the run-graph edges this worker contributed.
  provenance: Record<string, string>;
  // sessionId of this worker's run root (the connected component's spawn root).
  runRoot: string;
  project?: string;
  worktree?: string;
}

export interface Projection {
  bySession: Map<string, WorkerState>;
  // conductorSessionId -> playbookEnforcement mode. Folded here so backtracking
  // can explain why an illegal-looking move was allowed.
  enforcement: Map<string, string>;
  // Union-find parent map over the run graph (`provenance` edges). Internal —
  // read it through runRootOf/runMembers.
  parent: Map<string, string>;
}

export function emptyProjection(): Projection {
  return { bySession: new Map(), enforcement: new Map(), parent: new Map() };
}

// ── union-find over the run graph ───────────────────────────────────────────

function find(parent: Map<string, string>, sid: string): string {
  let cur = sid;
  // Path is short (a run is a handful of workers); walk to the root, then
  // compress so repeated runRootOf calls stay cheap.
  const seen: string[] = [];
  while (parent.get(cur) !== undefined && parent.get(cur) !== cur) {
    seen.push(cur);
    cur = parent.get(cur) as string;
  }
  for (const s of seen) parent.set(s, cur);
  return cur;
}

function union(parent: Map<string, string>, a: string, b: string): void {
  if (!parent.has(a)) parent.set(a, a);
  if (!parent.has(b)) parent.set(b, b);
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent.set(rb, ra);
}

// ── fold ────────────────────────────────────────────────────────────────────

// Apply one row to a projection, in place. The SINGLE code path both
// foldPlaybookState and the live writer's onWritten use, so an incrementally
// updated projection can never diverge from one folded from the file on boot.
export function applyRow(p: Projection, row: EventRow): void {
  if (row.kind === 'config') {
    // Only `to` is folded, so a birth (no `from`) sets the initial mode by the
    // same path a change does.
    if (row.key === 'enforcement') p.enforcement.set(row.subject, row.to);
  } else if (row.kind === 'call' && typeof row.subject === 'string') {
    const sid = row.subject;
    if (row.bind) {
      // A bind REPLACES the worker's state: a second bind for one session starts
      // it over, stageHistory and provenance included.
      const b = row.bind;
      const provenance = b.provenance && typeof b.provenance === 'object' ? { ...b.provenance } : {};
      p.bySession.set(sid, {
        sessionId: sid,
        playbook: b.playbook,
        stage: b.stage,
        stageHistory: [b.stage],
        provenance,
        runRoot: sid, // recomputed below
        ...(b.project !== undefined ? { project: b.project } : {}),
        ...(b.worktree !== undefined ? { worktree: b.worktree } : {}),
      });
      if (!p.parent.has(sid)) p.parent.set(sid, sid);
      // A `provenance` value is a run-graph edge: the bound worker joins the
      // component of every worker it names. None ⇒ it is its own run root.
      for (const target of Object.values(provenance)) union(p.parent, target, sid);
    } else if (row.move) {
      const st = p.bySession.get(sid);
      // A move onto the stage the worker already holds folds nothing — the
      // writer never produces one (it re-checks `from` at append time), and a
      // repeat would put the same stage twice in a row in stageHistory.
      if (st && st.stage !== row.move.to) {
        st.stage = row.move.to;
        st.stageHistory.push(row.move.to);
        const prov = row.move.provenance;
        if (prov && typeof prov === 'object') {
          st.provenance = { ...st.provenance, ...prov };
          for (const target of Object.values(prov)) union(p.parent, target, sid);
        }
      }
    }
  } else {
    return; // session / turn / wake rows fold to nothing
  }
  // runRoot is derived, so refresh it after any row that could have merged
  // components rather than letting a stored value go stale.
  for (const st of p.bySession.values()) st.runRoot = find(p.parent, st.sessionId);
}

// Pure: rows -> projection. Exported so policy tests can hand-build a projection
// from a fixture row list with no filesystem at all.
export function foldPlaybookState(rows: EventRow[]): Projection {
  const p = emptyProjection();
  for (const row of rows) applyRow(p, row);
  return p;
}

// ── run-graph queries (pure, over a folded projection) ──────────────────────

export function runRootOf(p: Projection, sessionId: string): string | null {
  if (!p.parent.has(sessionId)) return null;
  return find(p.parent, sessionId);
}

export function runMembers(p: Projection, sessionId: string): string[] {
  const root = runRootOf(p, sessionId);
  if (root === null) return [];
  return [...p.bySession.keys()].filter(sid => find(p.parent, sid) === root);
}

export function sameRun(p: Projection, a: string, b: string): boolean {
  const ra = runRootOf(p, a);
  return ra !== null && ra === runRootOf(p, b);
}

// Live occupants of `stage` within the run `anchor` belongs to, as sessionIds
// rather than a bare count — capacity reads this to name the blocking worker in
// a STAGE_AT_CAPACITY refusal. `isLive` is the caller's liveness oracle
// (InstanceManager.isSessionLive) — a REQUIRED parameter, not a fold read off
// `p`, so a session the manager no longer knows about never holds a slot.
export function liveSessionsInStage(
  p: Projection, anchor: string, stage: string, isLive: (sessionId: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const sid of runMembers(p, anchor)) {
    const st = p.bySession.get(sid);
    if (st && st.stage === stage && isLive(sid)) out.push(sid);
  }
  return out;
}

// Live workers bound to `playbook`, as sessionIds — GET /api/playbooks/:id's
// `liveWorkers`. The binding is read through playbookBinding, the one binding
// reader; `isLive` is the caller's liveness oracle, as for liveSessionsInStage.
export function liveSessionsOnPlaybook(
  p: Projection, playbook: string, isLive: (sessionId: string) => boolean,
): string[] {
  return [...p.bySession.keys()].filter(sid => playbookBinding(p, sid).playbook === playbook && isLive(sid));
}

export function hasEverBeen(p: Projection, sessionId: string, stage: string): boolean {
  return !!p.bySession.get(sessionId)?.stageHistory.includes(stage);
}

// The one binding reader every surface that reports a worker's playbook/stage
// goes through (MCP's conductorRowView/describeSession, REST's GET
// /api/instances) — so they can never drift on what "untracked" means. Returns
// null/null for an untracked worker, a null projection, or a non-string
// sessionId — null (not absent) so a caller can tell "not in a playbook" from
// "this build does not report it".
export function playbookBinding(
  p: Projection | null, sessionId: unknown,
): { playbook: string | null; stage: string | null } {
  const tracked = p && typeof sessionId === 'string' ? p.bySession.get(sessionId) : undefined;
  return { playbook: tracked?.playbook ?? null, stage: tracked?.stage ?? null };
}
