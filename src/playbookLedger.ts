// Playbook ledger — the append-only JSONL source of truth for worker stage
// state, plus the in-memory projection folded from it.
//
// APPEND-ONLY, `fs.appendFile`, NEVER writeFileAtomic or a rewritten JSON
// document: the `archive-store-corruption` wiki page records
// archived-sessions.json wiping itself when pre-commit tests leaked into the
// real store from a worktree. An append-only file removes that class outright.
//
// The store path resolves through a LAZY per-call function (`ledgerFile`, and
// the injectable `file` option), the discipline fragmentCatalog.ts documents for
// `storeFile` — "so PROJECTS_ROOT overrides in tests are honoured per-call".
// Resolving it once at module load would make the test suite append to the real
// ledger.
//
// One known limitation lives next to this module — DEFINITION DRIFT (settled). A
// playbook definition edited while workers are in flight is not pinned: no
// definition snapshot, no definition hash on the `spawn` event, and a load is
// never refused for invalidating a live run. Live workers pick up the reloaded
// graph, and a worker whose stage or edge vanished under it gets a refusal
// instead. That is accepted — which is why playbooks.ts makes
// STAGE_UNKNOWN/PLAYBOOK_UNKNOWN on a LIVE worker say the definition changed,
// rather than reading like a caller error.
//
// A worker's BINDING survives a context rotation, by both mechanisms: this
// projection is keyed by the PERMANENT public sessionId, which neither a
// `renew_session` nor a prune moves any more (see src/sessionLineage.ts). So the
// stage, the playbook and the stage history stay filed under the id the worker
// still answers to, and no orphan row appears under a rotated backing id.
//
// This module owns STAGE STATE and HISTORY only. Liveness is answered from
// InstanceManager.isSessionLive (src/instances.ts) — THE single liveness
// authority — never from this projection: `retire` and `resume` are audit
// EVENTS (the ledger's history of what the manager observed and what a
// governed call did), and they fold to no state beyond appearing in
// `stageHistory`'s implicit ordering. There is no `live` field for a second
// reader to consult, so a host reboot (an unobserved death — no retire is ever
// written for it) costs nothing: capacity and `needs.liveness` both read
// `isSessionLive` directly, and a session this process's registry never heard
// of simply holds no slot. See docs/protocol.md → Playbooks for the wire
// contract and docs/architecture.md → Playbooks for the full shape.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';

// Lazy — see the header. Never call this at module scope.
export function ledgerFile(): string {
  return path.join(orchStoreRoot(), 'playbook-ledger.jsonl');
}

export type LedgerEvent =
  | { seq: number; ts: string; kind: 'spawn'; sessionId: string; playbook: string; stage: string;
      provenance?: Record<string, string>; project?: string; worktree?: string }
  | { seq: number; ts: string; kind: 'transition'; sessionId: string; from: string; to: string;
      via: string; provenance?: Record<string, string>;
      // send_prompt's forward source, present only when the call named one.
      // Audit-only: applyEvent never reads it.
      forwardSessionId?: string }
  | { seq: number; ts: string; kind: 'retire'; sessionId: string; reason: string }
  // A resumed worker coming back to life. NOT a second `spawn`: the spawn arm
  // below REPLACES the worker's state (stageHistory reset to the entered stage,
  // provenance emptied), which for a mid-run worker would erase the history
  // every downstream `needs` is answered from. Audit-only, like `retire` — it
  // folds to no state; liveness itself is answered from
  // InstanceManager.isSessionLive, never from this event.
  | { seq: number; ts: string; kind: 'resume'; sessionId: string }
  // `forwardSessionId` is send_prompt's SECOND subject (the forward source),
  // recorded whenever the call named a resolvable one — the audit trail records
  // every worker the call named, and `code` already says which side was refused.
  | { seq: number; ts: string; kind: 'refusal'; sessionId?: string; forwardSessionId?: string;
      tool: string; code: string; reason: string }
  // `from: null` is a BIRTH — the conductor was created at this level and was
  // never in any prior one, so naming the other level would assert a past it
  // never had. Distinct from a change, and deliberately an explicit null rather
  // than an absent key so a reader can tell "born this way" from "field missing".
  // Every conductor records a birth, at either level.
  | { seq: number; ts: string; kind: 'enforcement'; conductorSessionId: string; from: string | null; to: string };

// A ledger event as handed to append() — seq/ts are assigned by the ledger.
export type NewLedgerEvent =
  | Omit<Extract<LedgerEvent, { kind: 'spawn' }>, 'seq' | 'ts'>
  | Omit<Extract<LedgerEvent, { kind: 'transition' }>, 'seq' | 'ts'>
  | Omit<Extract<LedgerEvent, { kind: 'retire' }>, 'seq' | 'ts'>
  | Omit<Extract<LedgerEvent, { kind: 'resume' }>, 'seq' | 'ts'>
  | Omit<Extract<LedgerEvent, { kind: 'refusal' }>, 'seq' | 'ts'>
  | Omit<Extract<LedgerEvent, { kind: 'enforcement' }>, 'seq' | 'ts'>;

export interface WorkerState {
  sessionId: string;
  playbook: string;
  stage: string;
  // Every stage this worker has occupied, entry stage first. This is what makes
  // a `needs` entry's provenance half answerable.
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
  // can explain why an illegal-looking move was allowed (step 4 writes them).
  enforcement: Map<string, string>;
  seq: number;
  // Union-find parent map over the run graph: `provenance` edges ∪ same-worker
  // transitions (the latter are same-worker by construction, so they never
  // merge components). Internal — read it through runRootOf/runMembers.
  parent: Map<string, string>;
}

export function emptyProjection(): Projection {
  return { bySession: new Map(), enforcement: new Map(), seq: 0, parent: new Map() };
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

// Apply one event to a projection, in place. The SINGLE code path both
// foldProjection and the live append() use, so an incrementally-updated
// projection can never diverge from one folded from the file on boot.
export function applyEvent(p: Projection, ev: LedgerEvent): void {
  if (typeof ev.seq === 'number' && ev.seq > p.seq) p.seq = ev.seq;
  switch (ev.kind) {
    case 'spawn': {
      const provenance = ev.provenance && typeof ev.provenance === 'object' ? { ...ev.provenance } : {};
      p.bySession.set(ev.sessionId, {
        sessionId: ev.sessionId,
        playbook: ev.playbook,
        stage: ev.stage,
        stageHistory: [ev.stage],
        provenance,
        runRoot: ev.sessionId, // recomputed below
        ...(ev.project !== undefined ? { project: ev.project } : {}),
        ...(ev.worktree !== undefined ? { worktree: ev.worktree } : {}),
      });
      if (!p.parent.has(ev.sessionId)) p.parent.set(ev.sessionId, ev.sessionId);
      // A `provenance` value is a run-graph edge: the spawned worker joins the
      // component of every worker it names. None ⇒ it is its own run root.
      for (const target of Object.values(provenance)) union(p.parent, target, ev.sessionId);
      break;
    }
    case 'transition': {
      const st = p.bySession.get(ev.sessionId);
      if (!st) break; // transition for an unknown worker — nothing to fold
      st.stage = ev.to;
      st.stageHistory.push(ev.to);
      if (ev.provenance && typeof ev.provenance === 'object') {
        st.provenance = { ...st.provenance, ...ev.provenance };
        for (const target of Object.values(ev.provenance)) union(p.parent, target, ev.sessionId);
      }
      break;
    }
    case 'retire':
      // Audit-only, like `refusal` — liveness is answered from
      // InstanceManager.isSessionLive, never from this projection. A retire's
      // sessionId is not required to already have a row (same tolerance as
      // `resume`), so there is nothing to fold into `bySession` here.
      break;
    case 'resume':
      // Audit-only. A resume re-attaches a worker where it already is, so its
      // stage, stageHistory, provenance and run membership are all unchanged —
      // and it carries no liveness bit to fold any more.
      break;
    case 'refusal':
      break; // audit-only; no state change
    case 'enforcement':
      // Only `to` is folded, so a birth (`from: null`) sets the initial mode by
      // exactly the same path a change does — `from` is audit-only, there to say
      // what the mode WAS, and the projection has no notion of a transition to
      // get wrong. Do not start branching on `from` here.
      p.enforcement.set(ev.conductorSessionId, ev.to);
      break;
  }
  // runRoot is derived, so refresh it after any event that could have merged
  // components rather than letting a stored value go stale.
  for (const st of p.bySession.values()) st.runRoot = find(p.parent, st.sessionId);
}

// Pure: events -> projection. Exported so policy tests can hand-build a
// projection from a fixture event list with no filesystem at all.
export function foldProjection(events: LedgerEvent[]): Projection {
  const p = emptyProjection();
  for (const ev of events) applyEvent(p, ev);
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

// ── the ledger itself ───────────────────────────────────────────────────────

export interface PlaybookLedger {
  load(): Promise<Projection>;
  projection(): Projection;
  append(ev: NewLedgerEvent): Promise<LedgerEvent>;
  file(): string;
}

// `file` is a FUNCTION, never a resolved string — see the header. Tests inject
// their own `() => <tmp>/ledger.jsonl`.
export function createPlaybookLedger({ file = ledgerFile }: { file?: () => string } = {}): PlaybookLedger {
  let proj = emptyProjection();

  async function load(): Promise<Projection> {
    proj = foldProjection(await readEvents(file()));
    return proj;
  }

  async function append(ev: NewLedgerEvent): Promise<LedgerEvent> {
    const full = { seq: proj.seq + 1, ts: new Date().toISOString(), ...ev } as LedgerEvent;
    const target = file();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, JSON.stringify(full) + '\n', 'utf8');
    applyEvent(proj, full);
    return full;
  }

  return { load, projection: () => proj, append, file };
}

// Read + parse the JSONL. A malformed line is warned and skipped rather than
// thrown: an append-only file can be cut mid-write by a crash, and one torn
// trailing line must not make every worker's stage unreadable on boot.
export async function readEvents(target: string): Promise<LedgerEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return [];
    throw e;
  }
  const out: LedgerEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch {
      console.warn(`playbookLedger: skipping malformed line in ${target}`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`playbookLedger: skipping non-object line in ${target}`);
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.kind !== 'string') {
      console.warn(`playbookLedger: skipping line with no kind in ${target}`);
      continue;
    }
    out.push(rec as unknown as LedgerEvent);
  }
  return out;
}

function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
