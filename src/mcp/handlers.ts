// MCP tool handlers. Thin shells over the orchestrator's existing modules
// (InstanceManager, projects.ts, worktrees.ts) — never duplicate business
// logic, never self-HTTP. Each handler receives (args, { instances }).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { getShellEnvBundlePath, bundleShellKind } from '../claudeShellEnv.ts';
import {
  listProjects as fsListProjects,
  listSessions as fsListSessions,
  listSessionsForCwdWithCounts,
  summarizeSessions,
  createProject as fsCreateProject,
  getProject,
  findSessionLocation,
  summarizeWorkspaces,
  addWorkspace as fsAddWorkspace,
  removeWorkspace as fsRemoveWorkspace,
  renameWorkspace as fsRenameWorkspace,
  writeProjectMeta,
} from '../projects.ts';
import { CONDUCT_PROJECT_NAME } from '../conduct.ts';
import {
  isGitRepo, listWorktrees as fsListWorktrees, getWorktreeMergeStatus,
  createWorktree as fsCreateWorktree, removeWorktree, getWorktree,
  syncWorktree as fsSyncWorktree, mergeWorktreeIntoParent, buildRebasePrompt,
  worktreeDirtyLines, runGit,
  listDependentWorktrees, dependentsRefusal,
  type WorktreeMeta,
} from '../worktrees.ts';
import { DIFF_BYTE_CAP, assertValidBaseRef, parseNumstat, parseNameStatus } from '../gitDiff.ts';
import { buildApprovePrompt, buildRejectPrompt } from '../planApproval.ts';
// DOM-free formatter shared with the UI question card (public/blocks.js
// re-exports it) so an answer_question MCP answer is byte-identical to a UI
// submit — one canonical function, no fork. See public/userQuestionAnswers.js.
import { formatUserQuestionAnswers, type Question, type UserQuestionAnswer } from '../../public/userQuestionAnswers.js';
import { getCatalog as getProjectConventionsCatalog, composeProjectScaffold } from '../projectConventions.ts';
import { composeProjectConventionsDoc } from '../projectClaudeMd.ts';
import { getCatalog as getConductorConventionsCatalog, getSelection as getConductorSelection } from '../conductorConventions.ts';
import { isKnownFamily, isKnownTier, defaultVersion, familyOf, CLAUDE_BACKEND_ID } from '../modelVersions.ts';
import { getTierBackend, resolveRoleBackend, isResolvableRole, backendForModel } from '../appSettings.ts';
import { textPayload, textResult } from './content.ts';
import {
  renderProjects, renderWorktrees, renderSessions, renderProjectStatus,
  renderPlaybook,
} from './readRenderers.ts';
import { pageInstanceEvents } from '../eventArchive.ts';
import { indexDiffLines, paginateDiff } from './diffPaging.ts';
import {
  capText, MSG_TEXT_CAP, reconstructMessages, mergeRecentWithDisk, capBlockInput,
  hasPlanOrQuestions, ringTurnIndex, bondTrailingTurn, type ReconMessage,
} from './messageReconstruction.ts';
import { loadPlaybooks, isSpawnable, legalMovesFrom, decide, type Playbook } from '../playbooks.ts';
import { runMembers, type Projection } from '../playbookLedger.ts';
import { conductProjectPath, isConductorInstance } from '../conduct.ts';
import { isDeadStatus } from '../instances.ts';
import type { PlaybookGate } from './playbookGate.ts';
import type { InstanceLike, InstanceManagerLike, InstanceSummary } from '../instanceTypes.ts';
import type { UiEvent } from '../parser.ts';

// Dirty-line cap for project_status — mirror project_read/project_diff's
// bounded-output pattern so no tool can emit an unbounded body. (The
// per-message text cap MSG_TEXT_CAP now lives in ./messageReconstruction.ts.)
const DIRTY_CAP = 500;

// ---------- helpers ----------

// The per-handler call context injected by the MCP server (src/mcp/server.ts).
// `playbookGate` is the same gate the enforcement checkpoint uses, so the read
// tools below see the one projection that actually governs — not a second fold.
// Optional to match the style of its siblings; the transport always supplies it.
interface McpCtx {
  instances?: InstanceManagerLike | null;
  callerId?: string | null;
  playbookGate?: PlaybookGate;
}

// Loose type for handlers that don't destructure their args (schema-validated
// by the tool registry; see mcp/tools.ts).
type McpArgs = Record<string, unknown>;

// A soft-refusal the handler hands back as a normal (non-error) result.
interface SoftRefusal {
  ok: false;
  code: string;
  sessionId: string | null;
  reason: string;
}

// A per-file diff row (project_diff summary mode), optionally carrying the
// pre-rename path for a rename entry.
interface DiffFileRow {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  oldPath?: string;
}

// The conductor-facing projection of an instance summary.
//
// An EXPLICIT ALLOWLIST, not a spread with keys deleted. The previous
// `({id, callerInstanceId, ...rest}) => rest` form silently published every
// field ever added to summary() — that is how `sonnetWindow` reached
// list_sessions / spawn_instance / wait_for_idle.summary / respawn_instance /
// promote_session without ever being documented. Adding a key here is now a
// deliberate act, and CONDUCTOR_VIEW_KEYS is asserted against the documented
// list in src/mcp/tools.ts by tests/mcp-conductor-view.test.mjs, so the two
// cannot drift.
//
// Excluded on purpose: `id` + `callerInstanceId` (per-process instanceIds that
// die on restart — `sessionId` is the only worker handle this surface speaks),
// `debugDir` (the `debug` boolean is the signal), `autoApprovePlan` (UI-only),
// `interrupting` (transient; a conductor that called interrupt_turn knows).
export const CONDUCTOR_VIEW_KEYS = [
  'project',
  // Load-bearing for the conductor's self-identification check: it confirms its
  // own cwd ends in `.conduct` and stops if it doesn't (i.e. it is running
  // inside a worker).
  'cwd',
  'sessionId',
  'status',
  // idle-and-done vs idle-with-a-subagent-still-running — the wake semantics.
  'displayStatus',
  'activeAgentTasks',
  'mode',
  'effort',
  'thinking',
  'backend',
  'model',
  'contextWindowTokens',
  'pid',
  'worktree',
  'temp',
  'conducted',
  'debug',
  // Together with `title`, how a conductor tells its own worker from another
  // conductor's worker on the same task — enforces "only drive what you spawned".
  'firstPrompt',
  'title',
  'createdAt',
  // On a watchdog-timeout wake: "silent for 30 minutes" vs "producing until a
  // moment ago".
  'lastResponseAt',
  // Explains an unexpected wake.
  'queuedCount',
  // Explain a stalled worker and when it comes back.
  'autoResumeAt',
  'overageActive',
  'overageResetsAt',
];

// The three fields listInstances attaches on top of the shared projection (see
// the note in listInstances). Exported so the two tests that bind against the
// full list_sessions key set — the doc-drift gate in
// tests/mcp-conductor-view.test.mjs and the rendering gate in
// tests/mcp-text-render.test.mjs — read one definition instead of two copies.
export const LIST_ONLY_KEYS = ['hasIdleSubscriber', 'playbook', 'stage'];

function toConductorView(summary: InstanceSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CONDUCTOR_VIEW_KEYS) out[k] = summary[k];
  return out;
}

// The ONLY public worker lookup. LIVE-only + soft-erroring: resolves a
// stable sessionId to its single running (proc-attached) instance, or returns
// a soft-refusal object the handler hands straight back (isError stays false,
// matching the deleteWorktree/mergeWorktree soft-refusal convention). NEVER
// auto-respawns and never special-cases reads — a dead session is a refusal,
// not a resurrection.
//   - SESSION_NOT_LIVE: the session is known (in byId or on disk) but has no
//     running process → tell the conductor to spawn_instance({resume}).
//   - SESSION_UNKNOWN: no such session anywhere.
// The disk probe (findSessionLocation) runs ONLY on the not-live path, so the
// hot path stays a pure in-memory lookup.
async function getInst(instances: InstanceManagerLike | null | undefined, sessionId: string): Promise<{ inst: InstanceLike } | { soft: SoftRefusal }> {
  if (!instances) {
    throw Object.assign(new Error('orchestrator was started without an InstanceManager'), { statusCode: 500 });
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    return { soft: { ok: false, code: 'SESSION_UNKNOWN', sessionId: sessionId ?? null,
      reason: `no session ${sessionId} is known to the orchestrator.` } };
  }
  const live = instances.liveForSession(sessionId);
  if (live) return { inst: live };
  // Not live — pay for the disk probe only here so the hot path is in-memory.
  // NOTE: findSessionLocation may not match a session whose worktree is
  // unregistered; such an edge resolves to SESSION_UNKNOWN rather than
  // SESSION_NOT_LIVE. Accepted — it never throws.
  const known = !!instances.anyForSession(sessionId) || !!(await findSessionLocation(sessionId).catch(() => null));
  if (known) {
    return { soft: { ok: false, code: 'SESSION_NOT_LIVE', sessionId,
      reason: `session ${sessionId} has no running process — call spawn_instance({resume:"${sessionId}"}) to bring it back.` } };
  }
  return { soft: { ok: false, code: 'SESSION_UNKNOWN', sessionId,
    reason: `no session ${sessionId} is known to the orchestrator.` } };
}

// Resolve when `inst.status` first satisfies predicate, or reject on timeout.
// Resolves immediately if the predicate is already true.
function waitForStatus(inst: InstanceLike, predicate: (status: string) => boolean, timeoutMs: number): Promise<{ status: string; summary: InstanceSummary }> {
  return new Promise((resolve, reject) => {
    if (predicate(inst.status)) {
      resolve({ status: inst.status, summary: inst.summary() });
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    function cleanup(): void {
      if (timer) clearTimeout(timer);
      inst.off('status', onStatus);
    }
    function onStatus(s: InstanceSummary): void {
      if (predicate(s.status)) {
        cleanup();
        resolve({ status: s.status, summary: s });
      }
    }
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`wait_for_idle timed out after ${timeoutMs} ms (status=${inst.status})`));
    }, timeoutMs);
    inst.on('status', onStatus);
  });
}

// Resolve when the next event matching `predicate` arrives. Rejects on
// timeout or if the instance exits/crashes mid-wait.
function waitForEvent(inst: InstanceLike, predicate: (ev: UiEvent | null) => boolean, timeoutMs: number): Promise<UiEvent | null> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    function cleanup(): void {
      if (timer) clearTimeout(timer);
      inst.off('event', onEvent);
      inst.off('status', onStatus);
    }
    function onEvent(ev: UiEvent | null): void {
      if (predicate(ev)) {
        cleanup();
        resolve(ev);
      }
    }
    function onStatus(s: InstanceSummary): void {
      if (s.status === 'exited' || s.status === 'crashed') {
        cleanup();
        reject(new Error(`instance ${s.status} before event arrived`));
      }
    }
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`wait timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    inst.on('event', onEvent);
    inst.on('status', onStatus);
  });
}

// ---------- read-only ----------

export async function listProjects(_args: McpArgs, { instances }: McpCtx) {
  const projects = await fsListProjects();
  const enriched = await Promise.all(projects.map(async (p) => {
    const worktrees = await fsListWorktrees(p.name).catch(() => []);
    const worktreesWithSessions = await Promise.all(worktrees.map(async (w) => ({
      ...w,
      sessions: await summarizeSessions(w.worktreePath).catch(() => ({ count: 0, archivedCount: 0, lastActivity: 0 })),
      mergeStatus: await getWorktreeMergeStatus(w).catch(() => ({ ahead: null, behind: null })),
    })));
    return {
      ...p,
      liveCount: instances ? instances.liveCountForProject(p.name) : 0,
      isGitRepo: await isGitRepo(p.path),
      worktrees: worktreesWithSessions,
      sessions: await summarizeSessions(p.path).catch(() => ({ count: 0, archivedCount: 0, lastActivity: 0 })),
    };
  }));
  return textResult(renderProjects(enriched));
}

// Live-row order within a list_sessions group. Map insertion order (what list() hands back) is
// creation order of the in-process Instance objects — deterministic between two
// calls, but incidental: it interleaves projects, and boot-restore reshuffles it.
// This groups a project's workers together, and within a project puts a
// worktree's workers together in spawn order — so an implementer and the
// reviewer spawned after it on the same branch read as adjacent rows. createdAt
// never mutates, so `[n]` numbering is stable across calls unless the fleet
// actually changed; sessionId is the final tiebreak that makes the order total.
// Workers with no worktree sort ahead of a project's worktree workers ('' < any
// name), which also lands the conductor's own `.conduct` row at [1].
export function compareInstanceRows(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const wt = (v: unknown) => (v && typeof v === 'object' ? s((v as Record<string, unknown>).worktreeName) : '');
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  return s(a.project).localeCompare(s(b.project))
    || wt(a.worktree).localeCompare(wt(b.worktree))
    || n(a.createdAt) - n(b.createdAt)
    || s(a.sessionId).localeCompare(s(b.sessionId));
}

// Every cwd whose sessions belong to `project` — the project root plus each of
// its worktrees. One scan target per entry.
// The WorktreeMeta rides along: it already carries the branch, and enumerating
// worktrees costs a `git worktree list` per project — doing it a second time to
// look the metadata back up was the single most expensive thing in an
// unfiltered scan.
async function sessionCwdsFor(p: { name: string; path: string }) {
  const wts = await fsListWorktrees(p.name).catch(() => []);
  return [
    { project: p.name, worktree: null as string | null, cwd: p.path, meta: null as WorktreeMeta | null },
    ...wts.map(w => ({ project: p.name, worktree: w.worktreeName, cwd: w.worktreePath, meta: w })),
  ];
}

// Branch + divergence for a group header, so a reader can judge whether
// resuming a session lands somewhere useful without a second list_worktrees
// call. Best-effort: a non-repo or a detached HEAD renders as — rather than
// failing the listing.
//
// ahead/behind is a WORKTREE fact here — commits vs the base branch it will
// merge back into, which is what decides whether resuming into it is useful. A
// main checkout gets its branch only: its equivalent number would be vs the
// remote upstream, a different question that renders `? ?` on every project
// without one, and it cost three git subprocesses per project to say nothing.
// `list_projects` still reports it for projects that do have an upstream.
async function groupGit(dir: string, meta: WorktreeMeta | null) {
  // A worktree's branch is already recorded in its metadata — only a main
  // checkout has to ask git, and only it can be on a branch we don't know.
  if (meta) return { branch: meta.branch ?? null, mergeStatus: await getWorktreeMergeStatus(meta).catch(() => null) };
  const headRef = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
  return { branch: headRef?.code === 0 ? headRef.stdout.trim() || null : null, mergeStatus: null };
}

export async function listSessions(args: McpArgs, { instances, playbookGate }: McpCtx) {
  // The filter is validated, not free-form: a typo'd name would otherwise render
  // as an empty fleet, which reads as "everything finished". getProject is the
  // check because it is the same one every project-addressing tool uses, and ''
  // fails on its name regex rather than filtering to nothing.
  //
  // `.conduct` is the exception, and it is handled by NAME rather than by a
  // directory probe: the dir is created lazily at first conductor spawn, and a
  // conductor must be able to reach its own sessions either way. An absent dir
  // just scans to nothing (the scan returns [] on ENOENT).
  const project = args?.project === undefined ? null : String(args.project ?? '');
  const worktreeArg = args?.worktree === undefined ? null : String(args.worktree ?? '');
  const includeArchived = args?.includeArchived === true;
  const conductTarget = { name: CONDUCT_PROJECT_NAME, path: conductProjectPath() };
  let target: { name: string; path: string } | null = null;
  if (project === CONDUCT_PROJECT_NAME) {
    target = conductTarget;
  } else if (project !== null) {
    try {
      target = await getProject(project);
    } catch {
      return { ok: false, code: 'PROJECT_UNKNOWN', project,
        reason: `no project '${project}' — call list_projects for the names (its own project is '${CONDUCT_PROJECT_NAME}')` };
    }
  }
  if (worktreeArg !== null && !target) {
    return { ok: false, code: 'PROJECT_REQUIRED', worktree: worktreeArg,
      reason: 'worktree narrows a project — pass `project` alongside it' };
  }
  // Read-only, and folds nothing into being: absent ledger ⇒ empty projection.
  const proj = playbookGate ? await playbookGate.readProjection() : null;
  const view = (row: InstanceSummary & { hasIdleSubscriber: boolean }): Record<string, unknown> => {
    const tracked = proj && typeof row.sessionId === 'string'
      ? proj.bySession.get(row.sessionId) : undefined;
    return {
      ...toConductorView(row),
      hasIdleSubscriber: row.hasIdleSubscriber,
      // null (not absent) for an untracked worker, so a caller can tell "not in a
      // playbook" from "this build does not report it".
      playbook: tracked?.playbook ?? null,
      stage: tracked?.stage ?? null,
    };
  };
  // A dead instance retained in byId (non-temp exits are never dropped) is not a
  // live worker: it fails isDeadStatus, so it is excluded here AND left out of
  // the exclusion set below, which is what lets it reappear as an inactive row
  // off its own transcript. Live and inactive are disjoint by construction.
  const live = (instances ? instances.list() : []).filter(r => !isDeadStatus(r.status))
    .filter(r => project === null || r.project === project)
    .map(view)
    .sort(compareInstanceRows);
  // NOT built from `live` above: those rows carry PUBLIC ids, and the exclusion
  // set below is matched against transcript filenames (backing ids). Resolved
  // per-target-cwd inside the group loop via instances.liveBackingIdsForCwd.

  // Inactive rows come off disk, from the one function that already owns "which
  // sessions exist for a cwd, and which of them are archived"
  // (listSessionsForCwdWithCounts, whose row half is also behind
  // GET /projects/:name/sessions).
  // fsListProjects skips dotdirs, so the unfiltered scope must add `.conduct`
  // back explicitly. Without it a conductor looking for its own prior session to
  // resume — after a restart, a /clear, or a crash — gets every other project's
  // stopped sessions and none of its own.
  const scope = target ? [target] : [...await fsListProjects(), conductTarget];
  let targets = (await Promise.all(scope.map(sessionCwdsFor))).flat();
  if (worktreeArg !== null) {
    targets = targets.filter(t => t.worktree === worktreeArg);
    if (!targets.length) throw new Error(`worktree '${worktreeArg}' not found under project '${project}'`);
  }

  const groups = await Promise.all(targets.map(async t => {
    // One walk yields both the rows and the archived count. On a busy project
    // archived outnumbers active ~25:1 and the per-transcript cost is the
    // first-prompt read, which the walk skips for archived rows it is not
    // listing — so the count for a `+N archived` line is effectively free.
    const attached = instances ? instances.liveBackingIdsForCwd(t.cwd) : null;
    const { rows, archivedCount } = await listSessionsForCwdWithCounts(t.cwd, attached, { includeArchived })
      .catch(() => ({ rows: [], archivedCount: 0 }));
    const liveHere = live.filter(r => r.project === t.project
      && (r.worktree && typeof r.worktree === 'object'
        ? (r.worktree as Record<string, unknown>).worktreeName : null) === t.worktree);
    // A group with nothing in it is dropped from an unfiltered listing, and its
    // branch/divergence is never computed — that header exists to help judge a
    // resume, and there is nothing here to resume. An explicitly named project
    // always renders, so `project foo` with an empty fleet reads as empty rather
    // than as a missing project.
    const empty = !liveHere.length && !rows.length && !archivedCount;
    if (empty && project === null) return null;
    const { branch, mergeStatus } = await groupGit(t.cwd, t.meta);
    const tracked = (sid: string) => (proj ? proj.bySession.get(sid) : undefined);
    return {
      project: t.project,
      worktree: t.worktree,
      path: t.cwd,
      branch,
      mergeStatus,
      live: liveHere,
      // Newest first: on a list of sessions nobody is working on, "which did I
      // touch last" is the question. A stopped session has no createdAt on this
      // surface, so the answer comes off its transcript — from the last
      // timestamped record INSIDE it, not the file's mtime, which a mass
      // subprocess exit rewrites for every session at once (see
      // sessionActivity.ts).
      inactive: [...rows]
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .map(s => ({
          ...s,
          playbook: tracked(s.sessionId)?.playbook ?? null,
          stage: tracked(s.sessionId)?.stage ?? null,
        })),
      archivedCount,
    };
  }));

  // Main checkout first within each project — it is the one group that always
  // exists, so the top of the output stays put as worktrees come and go.
  const kept = groups.filter((g): g is NonNullable<typeof g> => g !== null);
  kept.sort((a, b) => a.project.localeCompare(b.project)
    || (a.worktree === null ? -1 : b.worktree === null ? 1 : a.worktree.localeCompare(b.worktree)));

  return textResult(renderSessions(kept, { project, expanded: includeArchived }));
}

// ---------- playbooks: the read / introspection surface ----------
//
// Playbook definitions are the authority on what the graph IS; the ledger's
// projection is the authority on where workers ARE. These three tools expose
// both without ever restating the graph in prose somewhere else.
//
// Every one of them is read-only in the strong sense: a fresh install with no
// ledger answers with empty state and creates no file (see
// PlaybookGate.readProjection).

export async function listPlaybooks() {
  const { playbooks, errors } = await loadPlaybooks();
  return {
    playbooks: [...playbooks.values()].map(pb => ({
      id: pb.id,
      name: pb.name,
      description: pb.description,
      entryStages: pb.entryStages,
      // Derived, because spawn_instance FAILS CLOSED: a stage is spawnable only
      // if it names spawn_instance explicitly, and a "*" wildcard confers
      // nothing. Reporting it saves the caller re-deriving a rule it can get
      // wrong.
      spawnableStages: Object.keys(pb.stages).filter(s => isSpawnable(pb.stages[s])),
    })),
    // Load-time rejections. Without this a hand-authored definition that fails
    // validation is simply absent, with no way to find out why.
    errors,
  };
}

export async function describePlaybook({ id }: { id: string }) {
  const { playbooks } = await loadPlaybooks();
  const pb = playbooks.get(id);
  if (!pb) {
    return {
      ok: false as const,
      code: 'PLAYBOOK_UNKNOWN',
      reason: `no playbook '${id}'.`,
      known: [...playbooks.keys()].sort(),
    };
  }
  // The payload is assembled here and rendered there: the two derived fields
  // below are rules about the graph, so they stay next to the graph, and
  // renderPlaybook stays a pure function of a payload the tests can hand-build.
  return textResult(renderPlaybook({
    id: pb.id,
    name: pb.name,
    description: pb.description,
    entryStages: pb.entryStages,
    stages: Object.fromEntries(Object.entries(pb.stages).map(([name, stage]) => [name, {
      needs: stage.needs,
      workers: stage.workers,
      tools: stage.tools,
      spawnable: isSpawnable(stage),
      // The conductor's move at this stage, when the definition authors one.
      // Left undefined when unauthored, which the rendering shows by emitting no
      // description line at all rather than an empty one.
      ...(stage.description !== undefined && { description: stage.description }),
    }])),
    // `via` is computed: an edge with no `on` is driven by send_prompt, and an
    // edge WITH one can be driven by that tool only. Both are rules the caller
    // would otherwise have to know rather than read.
    transitions: pb.transitions.map(t => ({
      from: t.from, to: t.to, via: t.on ?? 'send_prompt',
      ...(t.description !== undefined && { description: t.description }),
    })),
  }));
}

const HISTORY_CAP = 200;

export async function playbookState({ sessionId }: { sessionId?: string }, ctx: McpCtx) {
  const gate = ctx.playbookGate;
  if (!gate) throw new Error('orchestrator has no playbook gate');
  const proj = await gate.readProjection();
  // The CALLING conductor's live mode, read off the instance rather than the
  // ledger: the instance is the runtime authority and the ledger is the audit
  // trail. Deliberately not the projection's enforcement map — publishing that
  // could name an instance which is not a conductor and therefore not governed.
  const caller = ctx.callerId && ctx.instances ? ctx.instances.liveForSession(ctx.callerId) : null;
  const enforcement = caller && isConductorInstance(caller)
    ? { conductorSessionId: caller.sessionId, mode: caller.playbookEnforcement }
    : null;

  // UNTARGETED form: every run at once. Also the form that can never be denied —
  // it names no worker, so policy has no subject to read a stage from. That makes
  // it the escape hatch when a stage's `tools` map denies the targeted form.
  if (typeof sessionId !== 'string' || !sessionId) {
    const roots = new Set<string>();
    for (const sid of proj.bySession.keys()) roots.add(runRootFor(proj, sid));
    return {
      tracked: false,
      runs: [...roots].sort().map(root => ({ root, members: membersOf(proj, root) })),
      enforcement,
    };
  }

  const worker = proj.bySession.get(sessionId);
  if (!worker) {
    // A normal, empty answer — NOT a refusal. "This worker is not in a playbook"
    // is a fact about the worker, not a problem with the call.
    return {
      tracked: false, worker: null, run: null, nextMoves: [], history: [],
      historyTruncated: false, enforcement,
      reason: `worker ${sessionId.slice(0, 8)} is not playbook-tracked (not conducted, or spawned without a playbook while enforcement was 'warn').`,
    };
  }

  const { playbooks } = await loadPlaybooks();
  const pb = playbooks.get(worker.playbook);
  const members = membersOf(proj, worker.runRoot);
  const memberIds = new Set(members.map(m => m.sessionId));

  const all = await gate.readHistory();
  const relevant = all.filter(ev =>
    ('sessionId' in ev && typeof ev.sessionId === 'string' && memberIds.has(ev.sessionId))
    // The caller's own enforcement changes: what made an illegal-looking move
    // legal at a given seq. Scoped to the caller, so no other session's setting
    // is ever published here.
    || (ev.kind === 'enforcement' && !!enforcement && ev.conductorSessionId === enforcement.conductorSessionId));
  const history = relevant.slice(-HISTORY_CAP);

  return {
    tracked: true,
    worker: {
      sessionId: worker.sessionId,
      playbook: worker.playbook,
      stage: worker.stage,
      stageHistory: worker.stageHistory,
      provenance: worker.provenance,
      live: worker.live,
      runRoot: worker.runRoot,
      ...(worker.project !== undefined ? { project: worker.project } : {}),
      ...(worker.worktree !== undefined ? { worktree: worker.worktree } : {}),
    },
    run: { root: worker.runRoot, members },
    nextMoves: pb ? nextMovesFor({ pb, worker: worker.sessionId, stage: worker.stage, proj }) : [],
    // Definitions are not pinned to a live run (settled), so a worker can outlive
    // its playbook. Say so rather than returning a bare empty graph.
    ...(pb ? {} : { playbookMissing: worker.playbook }),
    history,
    historyTruncated: relevant.length > history.length,
    enforcement,
  };
}

// Every outgoing edge, each answered by DRY-RUNNING the same decide() the
// enforcement checkpoint runs — never a second reading of the rules. An edge that
// would be refused comes back with the gate's own code and reason, which is
// exactly what the caller needs in order to satisfy it.
function nextMovesFor(
  { pb, worker, stage, proj }:
  { pb: Playbook; worker: string; stage: string; proj: Projection },
): Array<{ to: string; via: string; ok: boolean; code?: string; reason?: string }> {
  const playbooks = new Map([[pb.id, pb]]);
  return legalMovesFrom(pb, stage).transitions.map(({ to, via }) => {
    // send_prompt carries the destination in `stage`; an `on` tool fires its edge
    // implicitly, so it must NOT also be handed one.
    const args: Record<string, unknown> = via === 'send_prompt'
      ? { sessionId: worker, text: '', stage: to }
      : { sessionId: worker };
    const d = decide({ toolName: via, args, projection: proj, playbooks });
    return d.ok
      ? { to, via, ok: true }
      : { to, via, ok: false, code: d.code, reason: d.reason };
  });
}

function runRootFor(proj: Projection, sessionId: string): string {
  return proj.bySession.get(sessionId)?.runRoot ?? sessionId;
}

function membersOf(proj: Projection, anchor: string) {
  return runMembers(proj, anchor)
    .map(sid => proj.bySession.get(sid))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map(s => ({ sessionId: s.sessionId, playbook: s.playbook, stage: s.stage, live: s.live }));
}

// Map the shared worktree-metadata shape (whose property is `worktreeName`)
// to the MCP contract's `worktree` key. The internal/REST field stays
// `worktreeName`; this is a boundary mapping, not an alias.
function toMcpWorktree({ worktreeName, ...rest }: WorktreeMeta) {
  return { worktree: worktreeName, ...rest };
}

export async function listWorktrees({ project }: { project: string }) {
  const wts = (await fsListWorktrees(project)).map(toMcpWorktree);
  return textResult(renderWorktrees(wts));
}

export async function locateSession({ sessionId }: { sessionId?: string }) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('sessionId required');
  }
  const hit = await findSessionLocation(sessionId);
  if (!hit) {
    throw Object.assign(new Error(`session not found: ${sessionId}`), { statusCode: 404 });
  }
  // {project, worktreeName} → {project, worktree} (MCP contract).
  return { project: hit.project, worktree: hit.worktreeName ?? null };
}

// Disk-backed event paging. RING-FIRST: pageInstanceEvents serves from the
// in-memory ring and only reads the on-disk session transcript when the
// requested window crosses trimmedBefore (i.e. asks for evicted history) —
// reconciling disk + ring by _seq with no gap/dup at the seam. So ring
// eviction is invisible to the caller: a fromSeq below trimmedBefore now
// returns the dropped range from disk instead of a silent gap.
//   - fromSeq omitted → newest page (last `limit` events).
//   - fromSeq: n → forward page, INCLUSIVE (events with _seq >= n,
//     oldest-first) — fromSeq: 0 reaches the very first event. Incremental
//     polling: pass nextFrom back as the next fromSeq.
// NOTE: a single turn larger than the ring cap can leave a mid-turn gap (the
// archive's dense _seq space can't overlap the live ring); get_transcript
// covers dropped PRIOR turns — for prose mid-giant-turn use get_recent_messages.
export async function getTranscript({ sessionId, fromSeq, limit = 200 }: { sessionId: string; fromSeq?: number; limit?: number }, { instances }: McpCtx) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;
  // fromSeq is this tool's own INCLUSIVE convention; pageInstanceEvents'
  // `after` option is EXCLUSIVE (matches the REST `after=` cursor) — the
  // two surfaces deliberately differ by name, so translate at this
  // boundary rather than "unifying" them.
  const page = fromSeq == null
    ? await pageInstanceEvents(inst, { limit })
    : await pageInstanceEvents(inst, { after: fromSeq - 1, limit });
  const events = page.events;
  const nextFrom = events.length ? (events[events.length - 1]._seq as number) + 1 : page.lastSeq + 1;
  return {
    status: inst.status,
    sessionId: inst.sessionId,
    events,
    lastSeq: page.lastSeq,
    trimmedBefore: page.trimmedBefore,
    hasMore: page.hasMore,
    // Forward cursor for the next incremental poll: poll again with
    // fromSeq = nextFrom to get only events since this batch.
    nextFrom,
  };
}

// ---------- mutating: instance ----------

interface SpawnArgs {
  project: string;
  mode?: string;
  effort?: string;
  thinking?: string;
  model?: string;
  resume?: string;
  worktree?: string | boolean;
  createWorktree?: boolean;
  baseWorktree?: string;
  name?: string;
  temp?: boolean;
  debug?: boolean;
  // Playbook-policy inputs. Declared so the router's unknown-argument rejection
  // admits them; consumed entirely by src/mcp/playbookGate.ts before this
  // handler runs, so nothing here reads them.
  playbook?: string;
  stage?: string;
  provenance?: Record<string, string>;
}

// Resolve a spawn's `model` name to the concrete {model, backend} pair plus the
// tier/role it resolved THROUGH. Exported because it is the authority on which
// model names are spawnable at all: tests/playbook-schema.test.mjs runs every
// built-in playbook's `pin: {model}` through it, so a definition can never
// ship pinning a model the product cannot resolve.
export function resolveSpawnModel(input: string | null | undefined): {
  model: string | null | undefined; backend: string; tier?: string; role?: string;
} {
  // Resolve `input` to a concrete {model, backend} pair:
  //   - a capability tier (fast/balanced/powerful/frontier) → its bound
  //     {backend, model} (a Claude version id, or another backend's model id);
  //   - a role → its resolved {backend, model} (built-in, user-custom, or a
  //     plugin-owned role; a role binds to a tier or a concrete backend; disjoint
  //     name-space from tiers — custom names can't be tier/family aliases, plugin
  //     names are '/'-namespaced — so order is safe);
  //   - a legacy family alias (opus/sonnet/haiku/fable) → that family's default
  //     Claude version, independent of any tier binding;
  //   - a model id served by a configured backend, passed directly → that
  //     backend (robustness);
  //   - a Claude model id (claude-…, incl. future ones) → pass-through claude;
  //   - anything else → reject, rather than silently spawn a broken claude.
  let model: string | null | undefined = input;
  let backend = CLAUDE_BACKEND_ID;
  // Which tier/role the model was resolved THROUGH, forwarded to create() so its
  // stored default effort applies when the caller passed no `effort`. Exactly one
  // of the two is ever set (a name is a tier or a role, never both); a family
  // alias / raw model id leaves both unset → the global default.
  //
  // No window/capacity is threaded from here: a binding is {backend, model},
  // and create() resolves the one capacity that pair implies.
  let tier: string | undefined;
  let role: string | undefined;
  if (model && isKnownTier(model)) {
    const binding = getTierBackend(model); // {backend, model} — isKnownTier narrows
    tier = model;
    backend = binding.backend;
    model = binding.model;
  } else if (model && isResolvableRole(model)) {
    const binding = resolveRoleBackend(model); // {backend, model}
    role = model;
    backend = binding.backend;
    model = binding.model;
  } else if (model && isKnownFamily(model)) {
    model = defaultVersion(model);
  } else if (model) {
    // A configured backend's model id, passed directly → that backend. The old
    // `backendForModel(model) as string` re-called the guard a second time; the
    // once-called `bm` is checked before use, so the narrowing is proven.
    const bm = backendForModel(model);
    if (bm) backend = bm;
    else if (!familyOf(model)) {
      // A non-empty model that is not a tier, family alias, a configured backend's
      // model, or a Claude id — refuse instead of resolving to a broken bare-claude
      // spawn.
      throw Object.assign(
        new Error(`unknown model '${model}' — pass a capability tier (fast/balanced/powerful/frontier) or a specific model id`),
        { statusCode: 400, code: 'BAD_MODEL' },
      );
    }
  }
  return { model, backend, ...(tier ? { tier } : {}), ...(role ? { role } : {}) };
}

export async function spawnInstance(args: SpawnArgs, { instances, callerId }: McpCtx) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  // callerId is the conductor's stable sessionId (?caller=). Resolve it to the
  // conductor's live instanceId so callerInstanceId stays an instanceId.
  const callerInst = callerId ? instances.liveForSession(callerId) : null;
  const { model, backend, tier, role } = resolveSpawnModel(args.model);
  // createWorktree:true → create a fresh worktree (passed to create() as the
  // boolean `true`); worktree:"<name>" → attach to an existing one.
  // createWorktree wins if both are given. create() still accepts the
  // boolean|string internal contract unchanged.
  const worktree = args.createWorktree === true ? true : args.worktree;
  const createArgs = {
    project: args.project,
    mode: args.mode,
    effort: args.effort,
    tier,
    role,
    thinking: args.thinking,
    model,
    backend,
    resume: args.resume,
    worktree,
    // Only meaningful alongside createWorktree:true; create() refuses them
    // otherwise rather than ignoring them.
    baseWorktree: args.baseWorktree,
    name: args.name,
    // Conductor workers default to temp (disposable). Unlike the UI's temp
    // checkbox (which the REST route maps to bypassPermissions), temp here
    // does NOT affect the mode default — create() leaves it at plan, so
    // workers plan before acting. Explicit temp:false / mode from the
    // caller win. On resume, leave it undefined instead of forcing true —
    // create()'s sidecar recovery (isTemp(resume)) decides the session's
    // actual persisted state; forcing true here would silently convert a
    // persistent session into a disposable one on every MCP resume.
    temp: args.temp !== undefined ? args.temp : (args.resume ? undefined : true),
    debug: args.debug,
    // Sessions spawned through the MCP tool are "conducted" sessions
    // (the worker agents an orchestrator conducts). This is the ONLY
    // place the marker is set — the browser UI / HTTP spawn path leaves
    // it false.
    conducted: true,
    // Record which conductor spawned this worker so the frontend can
    // show a live sub-agent panel scoped to that conductor's view.
    // `callerId` is now the conductor's stable sessionId (from ?caller=) —
    // resolve it back to the conductor's live instanceId so the internal
    // Instance.callerInstanceId field stays an instanceId (consumers:
    // public/subagents.js, conductedWorkersOf — both match on instanceId).
    callerInstanceId: callerInst?.id ?? null,
  };
  let inst;
  try {
    inst = await instances.create(createArgs);
  } catch (e) {
    // A resume id with no resumable conversation on disk (mistyped/bogus, or a
    // marker-only crash stub) is soft-refused rather than surfaced as a raw
    // spawn error — mirrors respawnInstance's SESSION_NOT_LIVE shape so the
    // conductor gets an actionable hint instead of a crashed worker.
    if (errCode(e) === 'SESSION_UNKNOWN') {
      return {
        ok: false,
        code: 'SESSION_UNKNOWN',
        sessionId: args.resume ?? null,
        reason: `no resumable conversation for session ${args.resume} — verify the id via list_sessions`,
      };
    }
    throw e;
  }
  return toConductorView(inst.summary());
}

// Fold the idle-subscription registration into every turn-starting call, so a
// conductor's single send_prompt/approve_plan/reject_plan/answer_question call
// both starts the turn AND re-arms the dispatch-and-wake callback (the
// conductor role prompt's Core rule). A failure to subscribe (e.g. the caller died in between) must
// never turn a successful prompt-send into an error — it degrades to
// subscribed:false with a reason instead.
async function maybeSubscribeIdle({ instances, callerId }: McpCtx, sessionId: string, { subscribe, subscribeTimeoutMs }: { subscribe: boolean; subscribeTimeoutMs?: number }): Promise<{ subscribed: boolean; already?: boolean; subscribeSkipped?: string }> {
  if (!subscribe) return { subscribed: false };
  if (!callerId) return { subscribed: false, subscribeSkipped: 'no-caller' };
  if (callerId === sessionId) return { subscribed: false, subscribeSkipped: 'self' };
  if (!instances) return { subscribed: false, subscribeSkipped: 'no-manager' }; // unreachable (getInst threw)
  try {
    const { already } = instances.subscribeIdle(callerId, sessionId, subscribeTimeoutMs);
    return { subscribed: true, already };
  } catch (e) {
    return { subscribed: false, subscribeSkipped: errMsg(e) };
  }
}

export async function sendPrompt(
  { sessionId, text, wait = false, waitTimeoutMs = 600_000, subscribe = true, subscribeTimeoutMs }: {
    sessionId: string; text: string; wait?: boolean; waitTimeoutMs?: number; subscribe?: boolean; subscribeTimeoutMs?: number;
    // `stage`/`provenance` are playbook-policy inputs, consumed by
    // src/mcp/playbookGate.ts before this handler runs. Declared (and
    // deliberately not destructured) so the type matches the schema the router
    // validates against.
    stage?: string;
    provenance?: Record<string, string>;
  },
  { instances, callerId }: McpCtx,
) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;
  // getInst is LIVE-only, so inst.proc is guaranteed here.
  if (wait) {
    // Attach the listener *before* sending so we can't miss a fast turn_end.
    // A one-shot subscription registered here would fire on the *next* turn
    // (this one is already being awaited inline), so skip it entirely.
    const waiter = waitForEvent(inst, (ev) => ev?.kind === 'turn_end', waitTimeoutMs);
    await inst.prompt(text);
    const ev = await waiter;
    return { sessionId: inst.sessionId, turnEnd: ev, subscribed: false, subscribeSkipped: 'wait' };
  }
  await inst.prompt(text);
  const sub = await maybeSubscribeIdle({ instances, callerId }, inst.sessionId as string, { subscribe, subscribeTimeoutMs });
  return { sessionId: inst.sessionId, status: inst.status, ...sub };
}

export async function waitForIdle({ sessionId, timeoutMs = 600_000 }: { sessionId: string; timeoutMs?: number }, { instances }: McpCtx) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;
  const { status } = await waitForStatus(
    inst,
    (s) => s === 'idle' || s === 'exited' || s === 'crashed',
    timeoutMs,
  );
  return { sessionId: inst.sessionId, status, summary: toConductorView(inst.summary()) };
}

export async function setMode({ sessionId, mode }: { sessionId: string; mode: string }, { instances }: McpCtx) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;
  await inst.setMode(mode);
  return { sessionId: inst.sessionId, mode: inst.mode };
}

// Register the calling instance to receive a one-shot stub user prompt
// when the target instance next hits turn_end. Caller identity comes
// from the MCP URL's ?caller=<id> query string (baked in at spawn time
// by InstanceManager.mcpServerUrl). The stub names the target and
// points at get_recent_messages so the conductor can inspect the
// result. Re-subscribe after every callback to keep getting pings.
export async function subscribeToIdle({ sessionId, timeoutMs }: { sessionId: string; timeoutMs?: number }, { instances, callerId }: McpCtx) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  if (!callerId) {
    throw new Error(
      'caller identity missing — the MCP URL must include ?caller=<sessionId>. ' +
      'Spawn this instance through the orchestrator so its MCP config carries the caller sessionId.',
    );
  }
  // Existence check before registering, so a not-live target surfaces here
  // (soft) rather than as a silent drop at callback time.
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const res = instances.subscribeIdle(callerId, sessionId, timeoutMs);
  return { sessionId, already: res.already };
}

export async function unsubscribeFromIdle({ sessionId }: { sessionId: string }, { instances, callerId }: McpCtx) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  if (!callerId) throw new Error('caller identity missing — MCP URL lacks ?caller=…');
  // Idempotent + must work even on a dead target (to clean up), so no getInst.
  const res = instances.unsubscribeIdle(callerId, sessionId);
  return { sessionId, removed: res.removed };
}

// Renew the CALLING session: capture a self-authored handoff summary, then
// (at this turn's end) code-conductor drives a server-side `/clear` on the
// caller — rotating its context in place (fresh sessionId, SAME process) — and
// seeds the cleared session with the summary (plus a server-generated
// mechanical state block, built at reseed time) as its first user turn. Caller
// identity comes from the MCP URL's ?caller=<sessionId>, so this only works for
// a code-conductor-managed session and always acts on the caller's own session.
// The `/clear` is deferred to turn_end (not fired now) so this tool call's turn
// completes normally first — see src/sessionRenew.ts.
export async function renewSession({ summary }: { summary?: string }, { instances, callerId }: McpCtx) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  if (!callerId) {
    throw new Error(
      'caller identity missing — the MCP URL must include ?caller=<sessionId>. ' +
      'renew_session acts on the calling session, so it only works for a ' +
      'code-conductor-managed instance whose MCP config carries the caller sessionId.',
    );
  }
  if (typeof summary !== 'string' || !summary.trim()) {
    return { ok: false, code: 'INVALID_SUMMARY', sessionId: callerId,
      reason: 'summary must be a non-empty string — write the handoff context to seed the cleared session with.' };
  }
  const r = await getInst(instances, callerId);
  if ('soft' in r) return r.soft;
  instances.armSessionRenew(r.inst.id, { summary });
  return {
    ok: true,
    sessionId: callerId,
    willClearAtTurnEnd: true,
    message:
      'Checkpoint captured. Your context will be cleared when this turn ends, then ' +
      'reseeded with your summary as the first turn of the fresh session. End your ' +
      'turn now without starting new work.',
  };
}

export async function interruptTurn({ sessionId, force }: { sessionId: string; force?: boolean }, { instances }: McpCtx) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;
  await inst.interrupt({ force: !!force });
  return { sessionId: inst.sessionId, status: inst.status, interrupting: !!inst.interrupting };
}

export async function killInstance({ sessionId }: { sessionId: string }, { instances }: McpCtx) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;
  // LIVE-only: getInst resolves only running instances, so kill_instance can no
  // longer reap an already-exited non-temp instance by sessionId (it is already
  // gone from the process table; resume it first if you need to act on it).
  // Accepted under the strict-live contract.
  await instances!.remove(inst.id);
  return { sessionId };
}

// Respawn an exited/crashed instance. SPECIAL CASE: it targets a NON-live
// instance, so it cannot use the LIVE-only getInst. Resolve the sessionId to
// its in-byId instance regardless of proc; instances.respawn() 409s if it's
// actually running. No in-byId match → SESSION_NOT_LIVE soft refusal.
export async function respawnInstance({ sessionId }: { sessionId: string }, { instances }: McpCtx) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  const inst = instances.anyForSession(sessionId);
  if (!inst) {
    return { ok: false, code: 'SESSION_NOT_LIVE', sessionId,
      reason: `no in-memory instance for session ${sessionId} — call spawn_instance({resume:"${sessionId}"}) to bring it back.` };
  }
  const respawned = await instances.respawn(inst.id);
  return toConductorView(respawned.summary());
}

// Promote a temp session to a persistent one — reuses the same
// Instance.promoteToNormal() the REST endpoint calls. getInst returns a soft
// SESSION_NOT_LIVE/SESSION_UNKNOWN for a non-live/unknown session;
// promoteToNormal throws "instance is not temp" (statusCode 400) → isError.
export async function promoteSession({ sessionId }: { sessionId: string }, { instances }: McpCtx) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;
  return toConductorView(await inst.promoteToNormal());
}

// ---------- mutating: plan approval ----------

// Approve a worker's plan: flip the instance to bypassPermissions so it
// can actually act on what was just approved, then send the approval
// prompt as a normal user turn. Mirrors the UI's Approve & Implement
// button (public/app.js onPlanDecision) — phrasing comes from the
// shared planApproval module so the three entry points (UI click,
// server-side auto-approve, MCP) all look identical to the worker.
export async function approvePlan(
  { sessionId, feedback, subscribe = true, subscribeTimeoutMs }: {
    sessionId: string; feedback?: string; subscribe?: boolean; subscribeTimeoutMs?: number;
  },
  { instances, callerId }: McpCtx,
) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;
  if (inst.mode === 'plan') {
    try { await inst.setMode('bypassPermissions'); }
    catch (e) {
      throw new Error(`failed to switch session ${sessionId} to bypassPermissions: ${errMsg(e)}`);
    }
  }
  const text = buildApprovePrompt(feedback);
  await inst.prompt(text);
  const sub = await maybeSubscribeIdle({ instances, callerId }, inst.sessionId as string, { subscribe, subscribeTimeoutMs });
  return { sessionId: inst.sessionId, mode: inst.mode, sentText: text, ...sub };
}

// Reject a worker's plan: stay in plan mode, send the refinement prompt.
// The worker will produce a revised plan; the conductor loops back to
// reviewing get_recent_messages and either approves or rejects again.
export async function rejectPlan(
  { sessionId, feedback, subscribe = true, subscribeTimeoutMs }: {
    sessionId: string; feedback?: string; subscribe?: boolean; subscribeTimeoutMs?: number;
  },
  { instances, callerId }: McpCtx,
) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;
  const text = buildRejectPrompt(feedback);
  await inst.prompt(text);
  const sub = await maybeSubscribeIdle({ instances, callerId }, inst.sessionId as string, { subscribe, subscribeTimeoutMs });
  return { sessionId: inst.sessionId, mode: inst.mode, sentText: text, ...sub };
}

interface AnswerEntry {
  option?: string;
  options?: string[];
  text?: string;
  note?: string;
}

// Answer a worker's AskUserQuestion with a STRUCTURED answer. Mirrors the UI
// question card's submit (public/app.js onUserQuestionSubmit → formatUserQuestionAnswers):
// the consolidated answer goes out as a normal user turn, byte-identical to a UI
// answer because both call the same public/userQuestionAnswers.js formatter.
// The worker is NOT necessarily idle here — the can_use_tool deny only ends the
// turn if the CLI has nothing queued behind it (see Instance._handleStdoutLine),
// so the send is unconditional and picks up MID_TURN_NOTE when it lands mid-turn.
//
// `answers` is aligned BY INDEX (0-based) to the pending questions — the same
// questions get_recent_messages renders 1-based in its "--- questions ---"
// body section. Each entry is one of:
//   { option: <label> [, note] }   — single choice
//   { options: [<label>,…] [, note] } — multi-select (requires question.multiSelect)
//   { text: <string> }             — custom typed answer
//   {}                             — no answer for that question
// The pending questions are re-derived from the ring via reconstructMessages —
// the SAME source get_recent_messages uses — so we format against exactly what
// the conductor saw. Soft-refuses (never throws) on mismatch.
export async function answerQuestion(
  { sessionId, answers, subscribe = true, subscribeTimeoutMs }: {
    sessionId: string; answers: AnswerEntry[]; subscribe?: boolean; subscribeTimeoutMs?: number;
  },
  { instances, callerId }: McpCtx,
) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;

  const msgs = reconstructMessages(inst.ringSnapshot(), false);
  let questions: Question[] | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const qs = msgs[i].questions;
    if (Array.isArray(qs) && qs.length > 0) {
      questions = qs as Question[];
      break;
    }
  }
  if (!questions) {
    return { ok: false, code: 'NO_PENDING_QUESTION', sessionId: inst.sessionId,
      reason: 'No pending AskUserQuestion found for this worker. Check get_recent_messages for a `questionCount` field / a "--- questions ---" body section first.' };
  }
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return { ok: false, code: 'ANSWER_COUNT_MISMATCH', sessionId: inst.sessionId,
      expected: questions.length, got: Array.isArray(answers) ? answers.length : 0,
      reason: `Provide exactly one answer per question, in order (${questions.length} expected).` };
  }

  const states: UserQuestionAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i] ?? {};
    const validLabels = new Set((q?.options ?? []).map(o => o.label));
    const note = typeof a.note === 'string' && a.note.trim() ? a.note : undefined;
    if (typeof a.text === 'string' && a.text.trim()) {
      states.push({ kind: 'custom', text: a.text });
    } else if (Array.isArray(a.options)) {
      if (!q?.multiSelect) {
        return { ok: false, code: 'NOT_MULTISELECT', sessionId: inst.sessionId, questionIndex: i,
          reason: `Question ${i} is single-choice; use { option } not { options }.` };
      }
      const invalid = a.options.filter(l => !validLabels.has(l));
      if (invalid.length) {
        return { ok: false, code: 'INVALID_OPTION', sessionId: inst.sessionId, questionIndex: i, invalid,
          reason: `Labels not offered for question ${i}: ${invalid.join(', ')}.` };
      }
      states.push(note ? { kind: 'multi', labels: a.options, note } : { kind: 'multi', labels: a.options });
    } else if (typeof a.option === 'string') {
      if (!validLabels.has(a.option)) {
        return { ok: false, code: 'INVALID_OPTION', sessionId: inst.sessionId, questionIndex: i, invalid: [a.option],
          reason: `"${a.option}" is not an offered option for question ${i}.` };
      }
      states.push(note ? { kind: 'option', label: a.option, note } : { kind: 'option', label: a.option });
    } else {
      states.push({ kind: 'none' });
    }
  }
  if (states.every(s => s.kind === 'none')) {
    return { ok: false, code: 'EMPTY_ANSWER', sessionId: inst.sessionId,
      reason: 'No answers provided — every entry was empty.' };
  }

  const text = formatUserQuestionAnswers(questions, states);
  await inst.prompt(text);
  const sub = await maybeSubscribeIdle({ instances, callerId }, inst.sessionId as string, { subscribe, subscribeTimeoutMs });
  return { sessionId: inst.sessionId, mode: inst.mode, sentText: text, ...sub };
}

// ---------- read-only: worktree diff ----------

// Tiered drill-down diff for a worktree relative to <baseRef>...HEAD.
// baseRef defaults to the worktree's recorded baseBranch (the branch it
// was created from). Several modes keep the tool usable at any size (see the branches below):
//   - summary:true  -> a structured per-file stat (never truncated)
//   - paths:[...]    -> scope the diff (or summary) to specific files
//   - offset:<line>  -> line-based pagination; each page is <= DIFF_BYTE_CAP
//                       of whole lines, mid-file pages re-emit file/hunk
//                       headers so each page parses standalone.
// The byte cap is the per-page ceiling, never a silent terminal cut.
// DIFF_BYTE_CAP / parseNumstat / parseNameStatus are imported from
// ../gitDiff.ts (single source of truth, shared with the REST diff surface).
// The line-index + pager engine lives in ./diffPaging.ts (indexDiffLines /
// paginateDiff), imported above.

export async function projectDiff({ project, worktree, baseRef, contextLines = 3, summary = false, paths, offset = 0 }: {
  project: string; worktree: string; baseRef?: string; contextLines?: number; summary?: boolean; paths?: string[]; offset?: number;
}) {
  if (!project || !worktree) {
    throw new Error('project_diff requires {project, worktree}');
  }
  const wt = await getWorktree(project, worktree);
  if (!wt) throw new Error(`worktree '${worktree}' not found under project '${project}'`);
  // Resolve the worktree's current HEAD sha (the right edge of the diff).
  const headR = await runGit(wt.worktreePath, ['rev-parse', 'HEAD']);
  const head = headR.code === 0 ? headR.stdout.trim() : null;
  const ref = (typeof baseRef === 'string' && baseRef.trim()) ? baseRef.trim() : wt.baseBranch;
  if (typeof baseRef === 'string' && baseRef.trim()) assertValidBaseRef(ref);
  // Commit count ref..HEAD — computed directly against `ref` (not via
  // getWorktreeMergeStatus, which is pinned to the worktree's recorded
  // baseBranch and ignores a caller-supplied baseRef override).
  const aheadR = await runGit(wt.worktreePath, ['rev-list', '--count', `${ref}..HEAD`]);
  const ahead = aheadR.code === 0 ? Number.parseInt(aheadR.stdout.trim(), 10) : null;
  const ctx = Number.isInteger(contextLines) && contextLines >= 0 && contextLines <= 50 ? contextLines : 3;
  const pathArgs = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p.trim()) : [];
  const pathspec = pathArgs.length ? ['--', ...pathArgs] : [];
  const lsPathspec = pathArgs.length ? ['--', ...pathArgs] : [];

  // ---- summary mode: structured per-file stat, never truncated ----
  if (summary === true) {
    // Identical flags (incl. -M) so --numstat and --name-status list files
    // in the same order and zip cleanly by index.
    const numArgs = ['diff', '--numstat', '-M', `${ref}...HEAD`, ...pathspec];
    const nsArgs = ['diff', '--name-status', '-M', `${ref}...HEAD`, ...pathspec];
    const [rn, rns] = await Promise.all([
      runGit(wt.worktreePath, numArgs),
      runGit(wt.worktreePath, nsArgs),
    ]);
    if (rn.code !== 0) throw new Error(`git diff --numstat failed in ${wt.worktreePath}: ${rn.stderr.trim() || rn.stdout.trim()}`);
    if (rns.code !== 0) throw new Error(`git diff --name-status failed in ${wt.worktreePath}: ${rns.stderr.trim() || rns.stdout.trim()}`);
    const nums = parseNumstat(rn.stdout);
    const stats = parseNameStatus(rns.stdout);
    const files = stats.map((s, i): DiffFileRow => {
      const n = nums[i] ?? { additions: 0, deletions: 0, binary: false };
      const entry: DiffFileRow = { path: s.path, status: s.status, additions: n.additions, deletions: n.deletions, binary: n.binary };
      if (s.oldPath) entry.oldPath = s.oldPath;
      return entry;
    });
    const totals = {
      files: files.length,
      additions: files.reduce((acc, f) => acc + f.additions, 0),
      deletions: files.reduce((acc, f) => acc + f.deletions, 0),
    };
    const result: {
      project: string; worktree: string; baseRef: string; head: string | null;
      summary: boolean; ahead: number | null; totals: typeof totals; files: DiffFileRow[];
      uncommitted?: { totals: typeof totals; files: DiffFileRow[]; untracked: string[] };
    } = { project, worktree, baseRef: ref, head, summary: true, ahead, totals, files };

    // Staged + unstaged changes vs HEAD (does not include untracked files)
    const [rnu, rnsu] = await Promise.all([
      runGit(wt.worktreePath, ['diff', '--numstat', 'HEAD', ...pathspec]),
      runGit(wt.worktreePath, ['diff', '--name-status', 'HEAD', ...pathspec]),
    ]);
    const uNums = rnu.code === 0 ? parseNumstat(rnu.stdout) : [];
    const uStats = rnsu.code === 0 ? parseNameStatus(rnsu.stdout) : [];
    const uFiles = uStats.map((s, i): DiffFileRow => {
      const n = uNums[i] ?? { additions: 0, deletions: 0, binary: false };
      const entry: DiffFileRow = { path: s.path, status: s.status, additions: n.additions, deletions: n.deletions, binary: n.binary };
      if (s.oldPath) entry.oldPath = s.oldPath;
      return entry;
    });
    const uTotals = {
      files: uFiles.length,
      additions: uFiles.reduce((acc, f) => acc + f.additions, 0),
      deletions: uFiles.reduce((acc, f) => acc + f.deletions, 0),
    };
    const utR = await runGit(wt.worktreePath, ['ls-files', '--others', '--exclude-standard', ...lsPathspec]);
    const untracked = utR.code === 0
      ? utR.stdout.split('\n').map(s => s.trim()).filter(Boolean)
      : [];
    result.uncommitted = { totals: uTotals, files: uFiles, untracked };
    return result;
  }

  // ---- diff mode: full diff with line-based pagination ----
  const r = await runGit(wt.worktreePath, ['diff', `--unified=${ctx}`, `${ref}...HEAD`, ...pathspec]);
  if (r.code !== 0) {
    throw new Error(`git diff failed in ${wt.worktreePath}: ${r.stderr.trim() || r.stdout.trim()}`);
  }

  let full = r.stdout ?? '';
  let uncommittedDiff = '';
  let untracked: string[] = [];

  // Staged + unstaged vs HEAD. git diff HEAD does NOT include untracked files,
  // so list those separately via ls-files --others.
  const wu = await runGit(wt.worktreePath, ['diff', `--unified=${ctx}`, 'HEAD', ...pathspec]);
  uncommittedDiff = wu.code === 0 ? (wu.stdout ?? '') : '';
  const utR = await runGit(wt.worktreePath, ['ls-files', '--others', '--exclude-standard', ...lsPathspec]);
  untracked = utR.code === 0
    ? utR.stdout.split('\n').map(s => s.trim()).filter(Boolean)
    : [];
  if (uncommittedDiff.trim()) {
    // Append uncommitted section; separator is visually distinct from any diff
    // marker (starts with @@@ not @@ ) so indexDiffLines treats it as body text.
    full = full + '@@@ uncommitted working tree changes (git diff HEAD) @@@\n' + uncommittedDiff;
  }

  const totalBytes = Buffer.byteLength(full, 'utf8');
  // Split into real diff lines, dropping the single trailing newline's empty tail.
  const lines = full.length ? full.split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;
  const startLine = Number.isInteger(offset) && offset > 0 ? offset : 0;

  const idx = indexDiffLines(lines);
  const { diff, cutoff } = paginateDiff(lines, startLine, DIFF_BYTE_CAP, idx);
  // `truncated` means more pages remain after this one; drain by re-calling
  // with offset:nextOffset until truncated:false.
  const truncated = cutoff < totalLines;
  const nextOffset = truncated ? cutoff : null;

  const meta: {
    project: string; worktree: string; baseRef: string; head: string | null;
    contextLines: number; offset: number; truncated: boolean; nextOffset: number | null;
    totalLines: number; totalBytes: number; hasUncommittedChanges: boolean; untracked: string[]; ahead: number | null;
    includedFiles?: string[]; omittedFiles?: string[];
  } = {
    project, worktree, baseRef: ref, head,
    contextLines: ctx,
    offset: startLine,
    truncated,
    nextOffset,
    totalLines,
    totalBytes,
    hasUncommittedChanges: uncommittedDiff.trim().length > 0,
    untracked,
    ahead,
  };
  // Explicit truncation metadata: which files this page covers vs omits.
  if (truncated) {
    const included = new Set<string>();
    for (let i = startLine; i < cutoff; i++) {
      const fi = idx.fileOf[i];
      if (fi >= 0 && idx.files[fi].path) included.add(idx.files[fi].path);
    }
    const allPaths = idx.files.map(f => f.path).filter((p): p is string => !!p);
    meta.includedFiles = allPaths.filter(p => included.has(p));
    meta.omittedFiles = allPaths.filter(p => !included.has(p));
  }
  // Metadata block + a separate raw, un-escaped diff text block.
  return textPayload(meta, diff);
}

// ---------- mutating: worktrees ----------

export async function createWorktree(
  { project, baseWorktree, name }: { project: string; baseWorktree?: string; name?: string },
) {
  return toMcpWorktree(await fsCreateWorktree(project, { baseWorktree, name }));
}

export async function deleteWorktree({ project, worktree, force = false }: { project: string; worktree: string; force?: boolean }, { instances }: McpCtx) {
  let running: InstanceLike[] = [];
  if (instances) {
    running = instances.idsForWorktree(project, worktree)
      .map(id => instances.get(id))
      .filter((i): i is InstanceLike => !!i && !!i.proc);
    // Expected business refusal (not a fault): attached live instance.
    if (running.length > 0 && !force) {
      return {
        ok: false,
        code: 'WORKTREE_ATTACHED',
        reason: `worktree '${worktree}' has ${running.length} running instance(s) — kill them first or pass force=true`,
      };
    }
  }
  // Expected business refusals: another worktree is based on this one, or
  // uncommitted changes. Pre-checked here so they return soft rather than
  // throwing out of removeWorktree (which stays as a true-fault backstop,
  // called with force below, and is also what covers the REST delete path).
  if (!force) {
    // Dependents first: a clean tree does not unblock this one.
    const dependents = await listDependentWorktrees(project, worktree);
    if (dependents.length > 0) return dependentsRefusal(worktree, dependents, 'deleting');
    const wt = await getWorktree(project, worktree);
    if (wt) {
      const dirty = await worktreeDirtyLines(wt.worktreePath);
      if (dirty.ok && dirty.lines.length > 0) {
        return {
          ok: false,
          code: 'WORKTREE_DIRTY',
          reason: `worktree '${worktree}' has uncommitted changes — commit / discard them, or pass force=true`,
        };
      }
    }
  }
  if (force && running.length > 0) {
    await Promise.all(running.map(i => i.kill({ graceMs: 300 }).catch(() => {})));
  }
  await removeWorktree(project, worktree, { force });
  return { project, worktree };
}

export async function syncWorktree({ sessionId }: { sessionId: string }, { instances }: McpCtx) {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r.soft;
  const inst = r.inst;
  if (!inst.worktree) throw new Error(`session ${sessionId} is not attached to a worktree`);
  const result = await fsSyncWorktree(inst.project, inst.worktree.worktreeName);
  if (result.ok && result.action === 'rebase-required') {
    // getInst is LIVE-only, so inst.proc is guaranteed — the agent is here to
    // drive the rebase prompt.
    await inst.prompt(buildRebasePrompt(inst.worktree), [], { annotateIfMidTurn: false });
    return {
      ok: true, action: 'rebase-prompt-sent',
      ahead: result.ahead, behind: result.behind,
    };
  }
  return result;
}

export async function mergeWorktree({ project, worktree, allowDirty }: { project: string; worktree: string; allowDirty?: boolean }) {
  const wt = await getWorktree(project, worktree);
  if (!wt) throw new Error(`worktree '${worktree}' not found under project '${project}'`);
  // The behind-guard now lives inside mergeWorktreeIntoParent (shared with the
  // REST route); map its typed refusal to this surface's exact wording.
  const result = await mergeWorktreeIntoParent(project, worktree, { allowDirty: allowDirty === true });
  if (!result.ok && result.code === 'WORKTREE_BEHIND') {
    return {
      ok: false,
      code: 'WORKTREE_BEHIND',
      reason: `worktree is behind '${result.baseBranch}' by ${result.behind} commit(s) — call sync_worktree first to fast-forward / rebase`,
    };
  }
  return result;
}

// ---------- workspaces ----------
// Workspaces are sidebar-organisation primitives — registered names plus
// a `workspace` field per project. The registry persists independently
// of membership so an empty workspace still shows up. These tools mirror
// the REST endpoints in src/routes.ts (PUT /projects/:name/workspace,
// POST/PUT/DELETE /workspaces, GET /workspaces) so a conductor can set
// up its own organisation alongside the human.

export async function listWorkspaces() {
  return summarizeWorkspaces();
}

export async function createWorkspace({ name }: { name: string }) {
  return fsAddWorkspace(name);
}

export async function deleteWorkspace({ name }: { name: string }) {
  return fsRemoveWorkspace(name);
}

export async function renameWorkspace({ oldName, newName }: { oldName: string; newName: string }) {
  return fsRenameWorkspace(oldName, newName);
}

// Assign or clear a project's workspace. `workspace: null` or "" clears
// the field. Non-null values are auto-registered so freshly-named
// workspaces appear in list_workspaces immediately, matching the REST
// PUT handler's behaviour. Refuses .conduct — the hidden project can't
// belong to a workspace.
export async function setProjectWorkspace({ project, workspace }: { project: string; workspace?: string | null }) {
  if (typeof project !== 'string' || !project) throw new Error('project required');
  if (project === CONDUCT_PROJECT_NAME) {
    throw new Error('the .conduct project cannot be assigned to a workspace');
  }
  await getProject(project);
  const target = (workspace === '' || workspace === undefined) ? null : workspace;
  const meta = await writeProjectMeta(project, { workspace: target });
  if (meta.workspace) {
    try { await fsAddWorkspace(meta.workspace); } catch { /* validateWorkspace already ran */ }
  }
  return { project, workspace: meta.workspace ?? null };
}

// ---------- create / introspect ----------

export async function createProject({ name, gitInit = false, conventions = [] }: { name: string; gitInit?: boolean; conventions?: string[] }) {
  const conventionsDoc = conventions.length ? await composeProjectConventionsDoc(conventions) : null;
  const scaffold = await composeProjectScaffold(name, conventions);
  const created = await fsCreateProject(name, { conventionsDoc });
  if (gitInit) {
    const r = await runGit(created.path, ['init', '-q']);
    if (r.code !== 0) {
      throw new Error(`git init failed in ${created.path}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }
  // The scaffold directive is RETURNED, not persisted — fold it into your FIRST
  // send_prompt to the project's first worker (see conventions/conductor/core.md).
  return { ...created, gitInit: !!gitInit, ...(scaffold ? { scaffold } : {}) };
}

export async function listProjectConventions() {
  const catalog = await getProjectConventionsCatalog();
  return catalog.map(({ slug, name, description, builtin, scaffold }) => ({ slug, name, description, builtin, hasScaffold: !!scaffold }));
}

export async function listConductorConventions() {
  const [catalog, enabled] = await Promise.all([getConductorConventionsCatalog(), getConductorSelection()]);
  const on = new Set(enabled);
  return catalog.map(({ slug, name, description, builtin }) => ({
    slug, name, description, builtin, enabled: on.has(slug),
  }));
}

// reconstructMessages / buildMessageFromRing / mergeRecentWithDisk /
// capBlockInput / hasPlanOrQuestions / ringTurnIndex / bondTrailingTurn
// (+ capText / MSG_TEXT_CAP) live in ./messageReconstruction.ts, imported above.
// isTextBearing stays here — it's a handler-side filter, not part of the
// reconstruction engine.
function isTextBearing(m: ReconMessage): boolean {
  return m.text.length > 0 || hasPlanOrQuestions(m);
}

// Boundary line prefixed into each get_recent_messages body when more than one
// message is returned, so consecutive raw text blocks (content[k+1]) never
// visually run together. Presentation-only — meta's textChars/index already
// describe the raw prose.
function messageBoundaryHeader(index: number, total: number, msgId: string, textChars: number): string {
  return `--- message ${index + 1}/${total} · ${msgId} · ${textChars} chars ---`;
}

// Render an AskUserQuestion payload into the get_recent_messages body, index-
// numbered so a reader can answer_question by index against the SAME array
// (answer_question re-derives it independently from the ring — see its
// handler — this is just a readable rendering of that same shape).
function renderQuestions(questions: Question[]): string {
  const lines = ['--- questions ---'];
  questions.forEach((q, i) => {
    const headerSuffix = q.header ? ` · header: ${q.header}` : '';
    lines.push(`${i + 1}. ${q.question ?? ''} (multiSelect: ${!!q.multiSelect})${headerSuffix}`);
    for (const opt of q.options ?? []) {
      lines.push(`   - ${opt.label ?? ''}${opt.description ? `: ${opt.description}` : ''}`);
    }
  });
  return lines.join('\n');
}

// Assemble a message's body from its prose/plan/questions segments, ordered by
// the arrival-order seq messageReconstruction.ts records (textSeq/planSeq/
// questionsSeq) — NOT hardcoded prose-then-plan — so the body reflects the
// order those blocks actually occurred in the turn. A segment missing its seq
// (shouldn't happen) sorts last rather than throwing.
function renderMessageBody(m: ReconMessage, cappedText: string): string {
  const segments: Array<{ pos: number; text: string }> = [];
  if (cappedText) segments.push({ pos: m.textSeq ?? Infinity, text: cappedText });
  if (m.plan || m.planPath) {
    // The header names the plan file when one backs this plan, so a fresh
    // worker can be handed the document itself rather than a paraphrase.
    const header = m.planPath ? `--- plan · saved to ${m.planPath} ---` : '--- plan ---';
    segments.push({ pos: m.planSeq ?? Infinity, text: m.plan ? `${header}\n${m.plan}` : header });
  }
  if (m.questions) segments.push({ pos: m.questionsSeq ?? Infinity, text: renderQuestions(m.questions as Question[]) });
  segments.sort((a, b) => a.pos - b.pos);
  return segments.map(s => s.text).join('\n');
}

// Return the most recent N assistant messages as joined text + structured
// blocks, so a coordinating agent can read what a worker said without parsing
// the raw event stream. `count` defaults to 1, clamped to [1, 50].
//
// RING-FIRST, DISK-FALLBACK-ON-DEMAND: served from the in-memory ring on the
// hot path; only when the ring's retained tail can't satisfy the requested
// recent TEXT messages (tool-event volume evicted them) AND the ring has been
// trimmed do we read back into the on-disk transcript — so ring eviction never
// produces a false-empty result. Output is the multi-block payload: a metadata
// block + one raw text body per message (block k+1 ↔ messages[k]).
//
// DEFAULT-CALL BONDING: when `count` was omitted (not merely passed as 1), a
// turn can split its prose and its ExitPlanMode/AskUserQuestion tool call
// across separate assistant messages (the CLI starts a fresh message after the
// tool_result denial), and the trailing prose can itself span 2+ messages. If
// the last message is pure prose, the selection is bonded back to the nearest
// preceding plan/question message and spans from it through the end of that
// turn (see bondTrailingTurn). The walk-back is scoped to the current turn via
// the ring's turn_end seqs, so a plan from a previous turn is never pulled in.
// A message that already carries its own plan/questions is returned alone.
// Explicit `count` (including `count:1`) is always literal.
export async function getRecentMessages(args: McpArgs, ctx: McpCtx) {
  const r = await buildRecentMessages(args as { sessionId: string; count?: number; includeToolCalls?: boolean; includeThinking?: boolean }, ctx);
  if ('soft' in r) return r.soft;
  return textPayload(r.meta, r.bodies);
}

// Core of get_recent_messages: resolve the session, reconstruct + bond + cap the
// recent assistant messages, and return `{ meta, bodies }` (or `{ soft }` for a
// soft-refusal). Split out so the idle-subscription wake-callback can fold the
// SAME content a default get_recent_messages call returns into its stub without
// re-deriving the selection/bonding logic. `getRecentMessages` wraps this in a
// textPayload; the wake path flattens it (see src/mcp/content.ts flattenPayload).
export async function buildRecentMessages({ sessionId, count, includeToolCalls = false, includeThinking = false }: {
  sessionId: string; count?: number; includeToolCalls?: boolean; includeThinking?: boolean;
}, { instances }: McpCtx): Promise<{ meta: Record<string, unknown>; bodies: string[] } | { soft: SoftRefusal }> {
  const r = await getInst(instances, sessionId);
  if ('soft' in r) return r;
  const inst = r.inst;
  const isDefaultCount = count === undefined;
  const n = Math.max(1, Math.min(typeof count === 'number' && Number.isInteger(count) ? count : 1, 50));
  // A defaulted call may bond in one preceding plan/question message, so the
  // ring must satisfy n+1 text messages before we trust it over disk.
  const bondNeed = isDefaultCount ? n + 1 : n;

  const ring = inst.ringSnapshot();
  let all = reconstructMessages(ring, includeThinking);
  let source = 'ring';

  // Disk-fallback only when the ring genuinely can't satisfy the request.
  const ringSatisfies = (includeToolCalls ? all : all.filter(isTextBearing)).length >= bondNeed;
  if (!ringSatisfies && inst.sessionId && inst.ring.trimmedBefore > 0) {
    const merged = await mergeRecentWithDisk(inst, all, includeThinking);
    if (merged) { all = merged; source = 'disk'; }
  }

  const filtered = includeToolCalls ? all : all.filter(isTextBearing);
  let messages = filtered.slice(-n);
  // A defaulted single-message slice bonds back to the turn's plan/question
  // message and spans through the end of the turn (turn-scoped via the ring's
  // turn_end seqs). See bondTrailingTurn.
  if (isDefaultCount && messages.length === 1) {
    messages = bondTrailingTurn(filtered, ringTurnIndex(ring));
  }
  const omittedToolOnly = includeToolCalls ? 0 : (all.length - filtered.length);

  // Multi-block: metadata block describes each message; one raw text block per
  // message carries its rendered body (prose + plan/questions, order-faithful
  // — see renderMessageBody), in order — block k+1 ↔ messages[k]. When more
  // than one message is returned, each body is prefixed with a boundary line
  // (messageBoundaryHeader) so consecutive raw text blocks never visually run
  // together. meta stays untouched either way: textChars/index/etc. always
  // describe the raw prose, not the decorated body. plan/questions CONTENT
  // lives only in the body now — meta carries just presence markers
  // (hasPlan/questionCount) so a caller scanning metadata across a multi-
  // message result can spot which index to read without opening every body.
  const bodies: string[] = [];
  const total = messages.length;
  const metaMessages = messages.map((m, index) => {
    const textChars = (m.text ?? '').length;
    const capped = capText(m.text ?? '', MSG_TEXT_CAP);
    const rendered = renderMessageBody(m, capped.text);
    const body = total > 1
      ? messageBoundaryHeader(index, total, m.msgId, textChars) + (rendered ? `\n${rendered}` : '')
      : rendered;
    bodies.push(body);
    const entry: Record<string, unknown> = {
      index,
      msgId: m.msgId,
      hasToolUse: m.hasToolUse,
      textChars,
      textTruncated: capped.truncated,
    };
    if (m.plan || m.planPath) entry.hasPlan = true;
    if (m.planPath) entry.planPath = m.planPath;
    if (m.questions) entry.questionCount = (m.questions as Question[]).length;
    if (m.blocks) entry.blocks = m.blocks.map(capBlockInput);
    return entry;
  });

  const lastSeq = ring.length ? ring[ring.length - 1]._seq : -1;
  const meta: Record<string, unknown> = {
    sessionId: inst.sessionId,
    messages: metaMessages,
    source,
    omittedToolOnly,
    retained: { firstSeq: inst.ring.trimmedBefore, lastSeq, trimmed: inst.ring.trimmedBefore > 0 },
  };
  // Never a bare ambiguous result: when we couldn't fill the request, say why.
  if (messages.length < n) {
    if (omittedToolOnly > 0) {
      meta.hint = `Showing ${messages.length} text message(s); ${omittedToolOnly} recent assistant message(s) had only tool calls — the agent is active. Pass includeToolCalls:true, or use get_transcript to inspect tool activity.`;
    } else if (messages.length === 0) {
      meta.hint = inst.ring.trimmedBefore > 0 && source !== 'disk'
        ? 'No assistant messages retained in memory and the session transcript was unavailable (e.g. an exited temp session). Try get_transcript.'
        : 'No assistant text messages have arrived yet.';
    }
  }
  return { meta, bodies };
}

// Resolve { project, worktree? } to an absolute cwd, throwing with a
// useful message if either is missing.
async function resolveProjectCwd(projectName: string, worktreeName?: string | null): Promise<{ cwd: string; worktreeMeta: WorktreeMeta | null; projectPath: string }> {
  const proj = await getProject(projectName);
  if (worktreeName) {
    const wt = await getWorktree(projectName, worktreeName);
    if (!wt) throw new Error(`worktree '${worktreeName}' not found under project '${projectName}'`);
    return { cwd: wt.worktreePath, worktreeMeta: wt, projectPath: proj.path };
  }
  return { cwd: proj.path, worktreeMeta: null, projectPath: proj.path };
}

// Read the top-level directory listing, hiding dotfiles by default.
// Used by project_status for a quick "what's in this dir?" snapshot.
// Errors return an empty list.
async function listTopLevelEntries(cwd: string): Promise<Array<{ name: string; kind: string }>> {
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : (e.isFile() ? 'file' : 'other') }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

// Read-only project / worktree introspection. Returns the cwd, git state
// (branch + head + dirty + recent commits), top-level files, and — for
// worktrees — the mergeStatus + a diff stat vs the base branch.
export async function projectStatus({ project, worktree, logLimit = 20 }: { project: string; worktree?: string; logLimit?: number }) {
  const { cwd, worktreeMeta } = await resolveProjectCwd(project, worktree);
  const out: {
    project: string; worktree: string | null; cwd: string;
    files: Array<{ name: string; kind: string }>;
    isGitRepo: boolean;
    branch?: string | null;
    head?: { sha: string | null; subject: string | null } | null;
    dirty?: string[];
    dirtyTotal?: number;
    dirtyTruncated?: boolean;
    recentCommits?: string[];
    baseBranch?: string;
    baseSha?: string;
    mergeStatus?: { ahead: number | null; behind: number | null };
    diffStat?: string;
  } = {
    project,
    worktree: worktree ?? null,
    cwd,
    files: await listTopLevelEntries(cwd),
    isGitRepo: false,
  };
  if (!(await isGitRepo(cwd))) {
    return textResult(renderProjectStatus(out));
  }
  out.isGitRepo = true;
  // Branch (may be null on detached HEAD).
  const branchR = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  out.branch = branchR.code === 0 ? branchR.stdout.trim() || null : null;
  // HEAD sha + subject.
  const headR = await runGit(cwd, ['log', '-1', '--pretty=%H%n%s']);
  if (headR.code === 0) {
    const [sha, ...subj] = headR.stdout.trim().split('\n');
    out.head = { sha: sha ?? null, subject: subj.join('\n') || null };
  } else {
    out.head = null;
  }
  // Dirty lines (porcelain). For worktrees, filter out our own dotdir.
  if (worktreeMeta) {
    const d = await worktreeDirtyLines(cwd);
    out.dirty = d.ok ? d.lines : [];
  } else {
    const d = await runGit(cwd, ['status', '--porcelain']);
    out.dirty = d.code === 0
      ? d.stdout.split('\n').map(s => s.trim()).filter(Boolean)
      : [];
  }
  // Cap the dirty list so a pathological working tree can't blow up the
  // response (mirrors project_read / project_diff's bounded-output pattern).
  const dirty = out.dirty ?? [];
  if (dirty.length > DIRTY_CAP) {
    out.dirtyTotal = dirty.length;
    out.dirty = dirty.slice(0, DIRTY_CAP);
    out.dirtyTruncated = true;
  } else {
    out.dirtyTruncated = false;
  }
  // Recent commits (oneline). Negative or 0 logLimit → skip.
  if (typeof logLimit === 'number' && Number.isInteger(logLimit) && logLimit > 0) {
    const logR = await runGit(cwd, ['log', `-${logLimit}`, '--pretty=%h %s']);
    out.recentCommits = logR.code === 0
      ? logR.stdout.split('\n').map(s => s.trim()).filter(Boolean)
      : [];
  }
  // Worktree-only: mergeStatus + diff stat vs base.
  if (worktreeMeta) {
    out.baseBranch = worktreeMeta.baseBranch;
    out.baseSha = worktreeMeta.baseSha;
    out.mergeStatus = await getWorktreeMergeStatus(worktreeMeta).catch(() => ({ ahead: null, behind: null }));
    const diffR = await runGit(cwd, ['diff', '--stat', `${worktreeMeta.baseBranch}...HEAD`]);
    out.diffStat = diffR.code === 0 ? diffR.stdout.trim() : '';
  }
  return textResult(renderProjectStatus(out));
}

// Path-traversal-guarded file read. Path is project-relative; absolute
// paths or `..` segments that escape the project / worktree root are
// rejected. Caps at maxBytes (default per the projectRead param) so this stays cheap to
// call from an LLM loop. Returns text content with lineCount; binary
// files are reported as base64 (line params ignored for binary).
// Optional line params (text only): offset (1-based start line, default per projectRead),
// limit (max lines, default: to EOF), lineNumbers (cat-n prefix).
export async function projectRead({ project, worktree, relativePath,
  maxBytes = 256 * 1024, lineNumbers = false, offset = 1, limit }: {
  project: string; worktree?: string; relativePath: string;
  maxBytes?: number; lineNumbers?: boolean; offset?: number; limit?: number;
}) {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new Error('relativePath required');
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error('relativePath must be project-relative (no absolute paths)');
  }
  const { cwd } = await resolveProjectCwd(project, worktree);
  const resolved = path.resolve(cwd, relativePath);
  // Path-traversal guard: resolved must stay under cwd.
  const rel = path.relative(cwd, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`relativePath escapes project root: ${relativePath}`);
  }
  let stat;
  try { stat = await fs.stat(resolved); }
  catch (e) {
    if (errCode(e) === 'ENOENT') {
      throw Object.assign(new Error(`file not found: ${relativePath}`), { statusCode: 404 });
    }
    throw e;
  }
  if (stat.isDirectory()) {
    throw new Error(`'${relativePath}' is a directory — use project_status to list it`);
  }
  if (!stat.isFile()) {
    throw new Error(`'${relativePath}' is not a regular file`);
  }
  const cap = typeof maxBytes === 'number' && Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 256 * 1024;

  // Always read up to cap bytes first (preserves existing binary behaviour and
  // avoids loading huge files on the fast path).
  const fh = await fs.open(resolved, 'r');
  let buf: Buffer;
  let truncatedByBytes: boolean;
  try {
    const len = Math.min(stat.size, cap);
    buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    truncatedByBytes = stat.size > cap;
  } finally {
    await fh.close();
  }

  // Best-effort text detection: probe for NULs in the first 4 KB (unchanged).
  const probe = buf.slice(0, Math.min(4096, buf.length));
  const isBinary = probe.includes(0);
  if (isBinary) {
    // Binary: line params ignored. Metadata block + a base64 body block.
    return textPayload(
      { path: relativePath, size: stat.size, truncated: truncatedByBytes, encoding: 'base64' },
      buf.toString('base64'),
    );
  }

  // Fast path: no line params requested — preserve the byte-capped read.
  // lineCount reflects lines in the bytes we have; if truncated it may be
  // partial (the truncated flag already signals that to the caller).
  const lineParamsActive = lineNumbers || offset !== 1 || limit != null;
  if (!lineParamsActive) {
    const text = buf.toString('utf8');
    const rawLines = text.split('\n');
    const lineCount = text.endsWith('\n') ? rawLines.length - 1 : rawLines.length;
    // lineCountExact:false → the byte cap may have cut a partial final line.
    return textPayload(
      { path: relativePath, size: stat.size, truncated: truncatedByBytes,
        encoding: 'utf8', lineCount, lineCountExact: !truncatedByBytes },
      text,
    );
  }

  // Slow path: line params active — read the full file for accurate line ops.
  const fullText = truncatedByBytes
    ? await fs.readFile(resolved, 'utf8')
    : buf.toString('utf8');

  const allLines = fullText.split('\n');
  const hasTrailingNL = fullText.endsWith('\n');
  if (hasTrailingNL) allLines.pop(); // remove sentinel empty element
  const lineCount = allLines.length;

  const startIdx = typeof offset === 'number' && Number.isInteger(offset) && offset >= 1 ? offset - 1 : 0;
  const endIdx = typeof limit === 'number' && Number.isInteger(limit) && limit >= 1
    ? Math.min(startIdx + limit, lineCount)
    : lineCount;

  const slicedLines = allLines.slice(startIdx, endIdx); // empty [] if past EOF
  const startLine = startIdx + 1;
  // endLine: last line number served; equals startLine when slice is empty
  const endLine = Math.max(startLine, startLine + slicedLines.length - 1);

  // Reassemble; restore trailing newline when the slice ends at the last line.
  const atEof = slicedLines.length > 0 && endLine >= lineCount;
  let content: string;
  if (lineNumbers) {
    const w = String(lineCount).length;
    content = slicedLines
      .map((line, i) => String(startLine + i).padStart(w) + '\t' + line)
      .join('\n');
    if (atEof && hasTrailingNL) content += '\n';
  } else {
    content = slicedLines.join('\n');
    if (atEof && hasTrailingNL) content += '\n';
  }

  // Final byte-cap: safety net so a large slice can't produce a huge response.
  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > cap) {
    content = Buffer.from(content, 'utf8').subarray(0, cap).toString('utf8');
    truncated = true;
  }

  // Slow path read the full file, so lineCount covers the whole file.
  const meta: {
    path: string; size: number; truncated: boolean; encoding: string;
    lineCount: number; lineCountExact: boolean; startLine?: number; endLine?: number;
  } = {
    path: relativePath, size: stat.size, truncated, encoding: 'utf8',
    lineCount, lineCountExact: true,
  };
  if (offset !== 1 || limit != null) {
    meta.startLine = startLine;
    meta.endLine = endLine;
  }
  return textPayload(meta, content);
}

// ---- project_bash ----

const BASH_OUTPUT_CAP = 200 * 1024; // matches the old grep content-mode cap (DIFF_BYTE_CAP)
const BASH_DEFAULT_TIMEOUT_MS = 120_000; // matches the built-in Bash tool's default
const BASH_MAX_TIMEOUT_MS = 600_000;     // matches the built-in Bash tool's documented max

export function clampBashTimeoutMs(timeout: unknown): number {
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return BASH_DEFAULT_TIMEOUT_MS;
  return Math.min(timeout, BASH_MAX_TIMEOUT_MS);
}

// Single-quote-escape for safe interpolation inside a single-quoted bash
// string — orchStoreRoot() derives from user-configurable PROJECTS_ROOT.
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// Run a shell command inside a project/worktree cwd, in claude's own
// restored shell environment (rg/find/grep shims + shell functions, via the
// cached bundle from claudeShellEnv.ts). The bundle is sourced with the same
// shell (bash or zsh) that produced it — see bundleShellKind(). Read-only
// inspection only (see the tool description in mcp/tools.ts). `description`
// is accepted for schema parity with the built-in Bash tool but is unused
// server-side.
export async function bashProject({ project, worktree, command, timeout }: {
  project: string; worktree?: string; command: string; timeout?: number;
}) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('project_bash requires a non-empty command string');
  }
  const timeoutMs = clampBashTimeoutMs(timeout);
  const { cwd } = await resolveProjectCwd(project, worktree);
  const bundlePath = await getShellEnvBundlePath();
  const wrapped = `source ${shQuote(bundlePath)} >/dev/null 2>&1; ${command}`;
  const shell = bundleShellKind(bundlePath);
  const [spawnCmd, spawnArgs] = shell === 'zsh'
    ? ['zsh', ['--no-rcs', '-c', wrapped]]
    : ['bash', ['--noprofile', '--norc', '-c', wrapped]];

  return new Promise((resolve) => {
    const start = Date.now();
    let timedOut = false;
    let capped = false;
    const chunks: Buffer[] = [];
    let bytes = 0;

    let proc;
    try {
      proc = spawn(spawnCmd, spawnArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve(textPayload(
        { project, worktree: worktree ?? null, cwd, exitCode: null,
          durationMs: Date.now() - start, error: true },
        errMsg(err),
      ));
      return;
    }

    const killGroup = () => {
      try { process.kill(-proc.pid!, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      setTimeout(() => {
        try { process.kill(-proc.pid!, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      }, 100).unref();
    };
    // Keep draining both pipes to completion (avoids backpressure stalling
    // the process) but stop RETAINING bytes past the cap — matches the
    // built-in Bash tool's semantics (truncate what's *shown*, let the
    // command run to completion). timeoutMs is the only hard kill.
    const onData = (chunk: Buffer) => {
      if (bytes >= BASH_OUTPUT_CAP) { capped = true; return; }
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes >= BASH_OUTPUT_CAP) capped = true;
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const raw = Buffer.concat(chunks).toString('utf8');
      const output = capped ? raw + '\n… [truncated at the output cap]' : raw;
      const meta: {
        project: string; worktree: string | null; cwd: string;
        exitCode: number | null; durationMs: number; truncated?: boolean; timedOut?: boolean;
      } = {
        project, worktree: worktree ?? null, cwd,
        exitCode: timedOut ? null : (code ?? null),
        durationMs,
      };
      if (capped) meta.truncated = true;
      if (timedOut) meta.timedOut = true;
      resolve(textPayload(meta, output.trimEnd()));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve(textPayload(
        { project, worktree: worktree ?? null, cwd, exitCode: null,
          durationMs: Date.now() - start, error: true },
        err.message,
      ));
    });
  });
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple every store to storeLock for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
