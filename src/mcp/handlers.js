// MCP tool handlers. Thin shells over the orchestrator's existing modules
// (InstanceManager, projects.js, worktrees.js) — never duplicate business
// logic, never self-HTTP. Each handler receives (args, { instances }).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { getShellEnvBundlePath, bundleShellKind } from '../claudeShellEnv.js';
import {
  listProjects as fsListProjects,
  listSessions as fsListSessions,
  listSessionsForCwd,
  summarizeSessions,
  createProject as fsCreateProject,
  getProject,
  findSessionLocation,
  summarizeWorkspaces,
  addWorkspace as fsAddWorkspace,
  removeWorkspace as fsRemoveWorkspace,
  renameWorkspace as fsRenameWorkspace,
  writeProjectMeta,
} from '../projects.js';
import { CONDUCT_PROJECT_NAME } from '../conduct.js';
import {
  isGitRepo, listWorktrees as fsListWorktrees, getWorktreeMergeStatus,
  createWorktree as fsCreateWorktree, removeWorktree, getWorktree,
  syncWorktree as fsSyncWorktree, mergeWorktreeIntoParent, buildRebasePrompt,
  worktreeDirtyLines, runGit, DIFF_BYTE_CAP, assertValidBaseRef,
} from '../worktrees.js';
import { buildApprovePrompt, buildRejectPrompt } from '../planApproval.js';
// DOM-free formatter shared with the UI question card (public/blocks.js
// re-exports it) so an answer_question MCP answer is byte-identical to a UI
// submit — one canonical function, no fork. See public/userQuestionAnswers.js.
import { formatUserQuestionAnswers } from '../../public/userQuestionAnswers.js';
import { getCatalog as getProjectConventionsCatalog, composeProjectConventionsBlock, composeProjectScaffold } from '../projectConventions.js';
import { getCatalog as getConductModulesCatalog, getSelection as getConductSelection } from '../conductModules.js';
import { isKnownFamily, isKnownTier, isKnownRole, defaultVersion, familyOf } from '../modelVersions.js';
import { getTierBackend, resolveRoleBackend, isKnownOllamaModel } from '../appSettings.js';
import { textPayload } from './content.js';
import { pageInstanceEvents } from '../eventArchive.js';
import { parseNumstat, parseNameStatus, indexDiffLines, paginateDiff } from './diffPaging.js';
import {
  capText, MSG_TEXT_CAP, reconstructMessages, mergeRecentWithDisk, capBlockInput,
  hasPlanOrQuestions, ringTurnIndex, bondTrailingTurn,
} from './messageReconstruction.js';

// Dirty-line cap for project_status — mirror project_read/project_diff's
// bounded-output pattern so no tool can emit an unbounded body. (The
// per-message text cap MSG_TEXT_CAP now lives in ./messageReconstruction.js.)
const DIRTY_CAP = 500;

// ---------- helpers ----------

// Project an internal instance summary down to the conductor-facing view:
// strip the per-process `id` (instanceId) and `callerInstanceId` so the
// conductor never sees — nor can come to depend on — a handle that dies on
// restart. `sessionId` (stable across respawn / --resume / full restart) is
// the only worker handle the MCP surface speaks.
function toConductorView({ id, callerInstanceId, ...rest }) {
  return rest;
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
async function getInst(instances, sessionId) {
  if (!instances) {
    const err = new Error('orchestrator was started without an InstanceManager');
    err.statusCode = 500;
    throw err;
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
function waitForStatus(inst, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (predicate(inst.status)) {
      resolve({ status: inst.status, summary: inst.summary() });
      return;
    }
    const onStatus = (s) => {
      if (predicate(s.status)) {
        cleanup();
        resolve({ status: s.status, summary: s });
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`wait_for_idle timed out after ${timeoutMs} ms (status=${inst.status})`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      inst.off('status', onStatus);
    };
    inst.on('status', onStatus);
  });
}

// Resolve when the next event matching `predicate` arrives. Rejects on
// timeout or if the instance exits/crashes mid-wait.
function waitForEvent(inst, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const onEvent = (ev) => {
      if (predicate(ev)) {
        cleanup();
        resolve(ev);
      }
    };
    const onStatus = (s) => {
      if (s.status === 'exited' || s.status === 'crashed') {
        cleanup();
        reject(new Error(`instance ${s.status} before event arrived`));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`wait timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      inst.off('event', onEvent);
      inst.off('status', onStatus);
    };
    inst.on('event', onEvent);
    inst.on('status', onStatus);
  });
}

// ---------- read-only ----------

export async function listProjects(_args, { instances }) {
  const projects = await fsListProjects();
  const enriched = await Promise.all(projects.map(async (p) => {
    const worktrees = await fsListWorktrees(p.name).catch(() => []);
    const worktreesWithSessions = await Promise.all(worktrees.map(async (w) => ({
      ...w,
      sessions: await summarizeSessions(w.worktreePath).catch(() => ({ count: 0, lastMtime: 0 })),
      mergeStatus: await getWorktreeMergeStatus(w).catch(() => ({ ahead: null, behind: null })),
    })));
    return {
      ...p,
      sessionIds: instances ? instances.sessionIdsForProject(p.name) : [],
      isGitRepo: await isGitRepo(p.path),
      worktrees: worktreesWithSessions,
      sessions: await summarizeSessions(p.path).catch(() => ({ count: 0, lastMtime: 0 })),
    };
  }));
  return enriched;
}

export async function listInstances(_args, { instances }) {
  // Scrub instanceId + callerInstanceId from every row; sessionId is the
  // conductor-facing handle. hasIdleSubscriber (added by list()) is preserved.
  return instances ? instances.list().map(toConductorView) : [];
}

export async function listSessions({ project, worktree, includeArchived = false }) {
  let sessions;
  if (worktree) {
    const wt = await getWorktree(project, worktree);
    if (!wt) throw new Error(`worktree '${worktree}' not found under project '${project}'`);
    sessions = await listSessionsForCwd(wt.worktreePath);
  } else {
    sessions = await fsListSessions(project);
  }
  return includeArchived ? sessions : sessions.filter(s => !s.archived);
}

// Map the shared worktree-metadata shape (whose property is `worktreeName`)
// to the MCP contract's `worktree` key. The internal/REST field stays
// `worktreeName`; this is a boundary mapping, not an alias.
function toMcpWorktree({ worktreeName, ...rest }) {
  return { worktree: worktreeName, ...rest };
}

export async function listWorktrees({ project }) {
  const wts = await fsListWorktrees(project);
  return wts.map(toMcpWorktree);
}

export async function locateSession({ sessionId }) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('sessionId required');
  }
  const hit = await findSessionLocation(sessionId);
  if (!hit) {
    const err = new Error(`session not found: ${sessionId}`);
    err.statusCode = 404;
    throw err;
  }
  // {project, worktreeName} → {project, worktree} (MCP contract).
  return { project: hit.project, worktree: hit.worktreeName ?? null };
}

// Disk-backed event paging. RING-FIRST: pageInstanceEvents serves from the
// in-memory ring and only reads the on-disk session transcript when the
// requested window crosses trimmedBefore (i.e. asks for evicted history) —
// reconciling disk + ring by _seq with no gap/dup at the seam. So ring
// eviction is invisible to the caller: a sinceSeq below trimmedBefore now
// returns the dropped range from disk instead of a silent gap.
//   - sinceSeq >= 0 → forward page (events with _seq > sinceSeq, oldest-first).
//     Incremental polling: pass nextAfter back as the next sinceSeq.
//   - sinceSeq omitted/-1 → newest page (last `limit` events).
// NOTE: a single turn larger than the ring cap can leave a mid-turn gap (the
// archive's dense _seq space can't overlap the live ring); get_transcript
// covers dropped PRIOR turns — for prose mid-giant-turn use get_recent_messages.
export async function getTranscript({ sessionId, sinceSeq = -1, limit = 200 }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  const page = sinceSeq >= 0
    ? await pageInstanceEvents(inst, { after: sinceSeq, limit })
    : await pageInstanceEvents(inst, { limit });
  const events = page.events;
  const nextAfter = events.length ? events[events.length - 1]._seq : sinceSeq;
  return {
    status: inst.status,
    sessionId: inst.sessionId,
    events,
    lastSeq: page.lastSeq,
    trimmedBefore: page.trimmedBefore,
    hasMore: page.hasMore,
    // Forward cursor for the next incremental poll: poll again with
    // sinceSeq = nextAfter to get only events since this batch.
    nextAfter,
  };
}

// ---------- mutating: instance ----------

export async function spawnInstance(args, { instances, callerId }) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  // callerId is the conductor's stable sessionId (?caller=). Resolve it to the
  // conductor's live instanceId so callerInstanceId stays an instanceId.
  const callerInst = callerId ? instances.liveForSession(callerId) : null;
  // Resolve `args.model` to a concrete {model, backendKind} pair:
  //   - a capability tier (fast/balanced/powerful/frontier) → its bound
  //     {kind, model} (a Claude version id, or an Ollama tag);
  //   - a role → its resolved {kind, model} (a role binds to a tier or a
  //     custom backend; disjoint name-space from tiers, so order is safe);
  //   - a legacy family alias (opus/sonnet/haiku/fable) → that family's default
  //     Claude version, independent of any tier binding;
  //   - a known Ollama tag passed directly → {kind:'ollama'} (robustness);
  //   - a Claude model id (claude-…, incl. future ones) → pass-through claude;
  //   - anything else → reject, rather than silently spawn a broken claude.
  let model = args.model;
  let backendKind = 'claude';
  // The Sonnet context window ('1m'|'200k') carried by the resolved binding,
  // threaded to create() explicitly — a 200k Sonnet is stored bare, so its
  // window can't ride in the model-id suffix. Undefined for non-tier/role
  // resolutions (family alias / raw id / ollama) → create() defaults to '1m'.
  let sonnetWindow;
  if (model && isKnownTier(model)) {
    const binding = getTierBackend(model); // {kind, model, window?}
    backendKind = binding.kind;
    model = binding.model;
    sonnetWindow = binding.window;
  } else if (model && isKnownRole(model)) {
    const binding = resolveRoleBackend(model); // {kind, model, window?}
    backendKind = binding.kind;
    model = binding.model;
    sonnetWindow = binding.window;
  } else if (model && isKnownFamily(model)) {
    model = defaultVersion(model);
  } else if (model && isKnownOllamaModel(model)) {
    backendKind = 'ollama';
  } else if (model && !familyOf(model)) {
    // A non-empty model that is not a tier, family alias, known Ollama tag, or
    // Claude id — refuse instead of resolving to a broken bare-claude spawn.
    throw Object.assign(
      new Error(`unknown model '${model}' — pass a capability tier (fast/balanced/powerful/frontier) or a specific model id`),
      { statusCode: 400, code: 'BAD_MODEL' },
    );
  }
  // createWorktree:true → create a fresh worktree (passed to create() as the
  // boolean `true`); worktree:"<name>" → attach to an existing one.
  // createWorktree wins if both are given. create() still accepts the
  // boolean|string internal contract unchanged.
  const worktree = args.createWorktree === true ? true : args.worktree;
  const createArgs = {
    project: args.project,
    mode: args.mode,
    effort: args.effort,
    thinking: args.thinking,
    model,
    sonnetWindow,
    backendKind,
    resume: args.resume,
    worktree,
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
    if (e?.code === 'SESSION_UNKNOWN') {
      return {
        ok: false,
        code: 'SESSION_UNKNOWN',
        sessionId: args.resume,
        reason: `no resumable conversation for session ${args.resume} — verify the id via list_sessions`,
      };
    }
    throw e;
  }
  return toConductorView(inst.summary());
}

// Fold the idle-subscription registration into every turn-starting call, so a
// conductor's single send_prompt/approve_plan/reject_plan/answer_question call
// both starts the turn AND re-arms the dispatch-and-wake callback (CONDUCT.md's
// Core rule). A failure to subscribe (e.g. the caller died in between) must
// never turn a successful prompt-send into an error — it degrades to
// subscribed:false with a reason instead.
async function maybeSubscribeIdle({ instances, callerId }, sessionId, { subscribe, subscribeTimeoutMs }) {
  if (!subscribe) return { subscribed: false };
  if (!callerId) return { subscribed: false, subscribeSkipped: 'no-caller' };
  if (callerId === sessionId) return { subscribed: false, subscribeSkipped: 'self' };
  try {
    const { already } = instances.subscribeIdle(callerId, sessionId, subscribeTimeoutMs);
    return { subscribed: true, already };
  } catch (e) {
    return { subscribed: false, subscribeSkipped: e.message };
  }
}

export async function sendPrompt(
  { sessionId, text, wait = false, waitTimeoutMs = 600_000, subscribe = true, subscribeTimeoutMs },
  { instances, callerId },
) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  // getInst is LIVE-only, so inst.proc is guaranteed here.
  if (wait) {
    // Attach the listener *before* sending so we can't miss a fast turn_end.
    // A one-shot subscription registered here would fire on the *next* turn
    // (this one is already being awaited inline), so skip it entirely.
    const waiter = waitForEvent(inst, (ev) => ev.kind === 'turn_end', waitTimeoutMs);
    await inst.prompt(text);
    const ev = await waiter;
    return { sessionId: inst.sessionId, turnEnd: ev, subscribed: false, subscribeSkipped: 'wait' };
  }
  await inst.prompt(text);
  const sub = await maybeSubscribeIdle({ instances, callerId }, inst.sessionId, { subscribe, subscribeTimeoutMs });
  return { sessionId: inst.sessionId, status: inst.status, ...sub };
}

export async function waitForIdle({ sessionId, timeoutMs = 600_000 }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  const { status } = await waitForStatus(
    inst,
    (s) => s === 'idle' || s === 'exited' || s === 'crashed',
    timeoutMs,
  );
  return { sessionId: inst.sessionId, status, summary: toConductorView(inst.summary()) };
}

export async function setMode({ sessionId, mode }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
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
export async function subscribeToIdle({ sessionId, timeoutMs }, { instances, callerId }) {
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
  if (r.soft) return r.soft;
  const res = instances.subscribeIdle(callerId, sessionId, timeoutMs);
  return { sessionId, already: res.already };
}

export async function unsubscribeFromIdle({ sessionId }, { instances, callerId }) {
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
// completes normally first — see src/sessionRenew.js.
export async function renewSession({ summary }, { instances, callerId }) {
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
  if (r.soft) return r.soft;
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

export async function interruptTurn({ sessionId, force }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  await inst.interrupt({ force: !!force });
  return { sessionId: inst.sessionId, status: inst.status, interrupting: !!inst.interrupting };
}

export async function killInstance({ sessionId }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  // LIVE-only: getInst resolves only running instances, so kill_instance can no
  // longer reap an already-exited non-temp instance by sessionId (it is already
  // gone from the process table; resume it first if you need to act on it).
  // Accepted under the strict-live contract.
  await instances.remove(inst.id);
  return { sessionId };
}

// Respawn an exited/crashed instance. SPECIAL CASE: it targets a NON-live
// instance, so it cannot use the LIVE-only getInst. Resolve the sessionId to
// its in-byId instance regardless of proc; instances.respawn() 409s if it's
// actually running. No in-byId match → SESSION_NOT_LIVE soft refusal.
export async function respawnInstance({ sessionId }, { instances }) {
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
export async function promoteSession({ sessionId }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
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
  { sessionId, feedback, subscribe = true, subscribeTimeoutMs },
  { instances, callerId },
) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  if (inst.mode === 'plan') {
    try { await inst.setMode('bypassPermissions'); }
    catch (e) {
      throw new Error(`failed to switch session ${sessionId} to bypassPermissions: ${e.message}`);
    }
  }
  const text = buildApprovePrompt(feedback);
  await inst.prompt(text, [], { annotateIfMidTurn: false });
  const sub = await maybeSubscribeIdle({ instances, callerId }, inst.sessionId, { subscribe, subscribeTimeoutMs });
  return { sessionId: inst.sessionId, mode: inst.mode, sentText: text, ...sub };
}

// Reject a worker's plan: stay in plan mode, send the refinement prompt.
// The worker will produce a revised plan; the conductor loops back to
// reviewing get_recent_messages and either approves or rejects again.
export async function rejectPlan(
  { sessionId, feedback, subscribe = true, subscribeTimeoutMs },
  { instances, callerId },
) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  const text = buildRejectPrompt(feedback);
  await inst.prompt(text, [], { annotateIfMidTurn: false });
  const sub = await maybeSubscribeIdle({ instances, callerId }, inst.sessionId, { subscribe, subscribeTimeoutMs });
  return { sessionId: inst.sessionId, mode: inst.mode, sentText: text, ...sub };
}

// Answer a worker's AskUserQuestion with a STRUCTURED answer. Mirrors the UI
// question card's submit (public/app.js onUserQuestionSubmit → formatUserQuestionAnswers):
// the worker's turn ended on the can_use_tool deny, so it's idle and we send the
// consolidated answer as a normal user turn — byte-identical to a UI answer
// because both call the same public/userQuestionAnswers.js formatter.
//
// `answers` is aligned BY INDEX to the pending questions (the same ordered array
// the conductor read from get_recent_messages). Each entry is one of:
//   { option: <label> [, note] }   — single choice
//   { options: [<label>,…] [, note] } — multi-select (requires question.multiSelect)
//   { text: <string> }             — custom typed answer
//   {}                             — no answer for that question
// The pending questions are re-derived from the ring via reconstructMessages —
// the SAME source get_recent_messages uses — so we format against exactly what
// the conductor saw. Soft-refuses (never throws) on mismatch.
export async function answerQuestion(
  { sessionId, answers, subscribe = true, subscribeTimeoutMs },
  { instances, callerId },
) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;

  const msgs = reconstructMessages(inst.ringSnapshot(), false);
  let questions = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (Array.isArray(msgs[i].questions) && msgs[i].questions.length > 0) {
      questions = msgs[i].questions;
      break;
    }
  }
  if (!questions) {
    return { ok: false, code: 'NO_PENDING_QUESTION', sessionId: inst.sessionId,
      reason: 'No pending AskUserQuestion found for this worker. Check get_recent_messages for a `questions` field first.' };
  }
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return { ok: false, code: 'ANSWER_COUNT_MISMATCH', sessionId: inst.sessionId,
      expected: questions.length, got: Array.isArray(answers) ? answers.length : 0,
      reason: `Provide exactly one answer per question, in order (${questions.length} expected).` };
  }

  const states = [];
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
  await inst.prompt(text, [], { annotateIfMidTurn: false });
  const sub = await maybeSubscribeIdle({ instances, callerId }, inst.sessionId, { subscribe, subscribeTimeoutMs });
  return { sessionId: inst.sessionId, mode: inst.mode, sentText: text, ...sub };
}

// Flip the per-instance auto-approve-plan flag. While enabled, the next
// plan_request emitted by the worker auto-fires the same setMode +
// approval-prompt path as approvePlan above, server-side, without any
// further intervention. Useful for "fire N workers and let them roll".
export async function setAutoApprovePlan({ sessionId, enabled }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  inst.setAutoApprovePlan(!!enabled);
  return { sessionId: inst.sessionId, autoApprovePlan: inst.autoApprovePlan };
}

// ---------- read-only: worktree diff ----------

// Tiered drill-down diff for a worktree relative to <baseRef>...HEAD.
// baseRef defaults to the worktree's recorded baseBranch (the branch it
// was created from). Three modes keep the tool usable at any size:
//   - summary:true  -> a structured per-file stat (never truncated)
//   - paths:[...]    -> scope the diff (or summary) to specific files
//   - offset:<line>  -> line-based pagination; each page is <= DIFF_BYTE_CAP
//                       of whole lines, mid-file pages re-emit file/hunk
//                       headers so each page parses standalone.
// The byte cap is the per-page ceiling, never a silent terminal cut.
// DIFF_BYTE_CAP is imported from ../worktrees.js (single source of truth).
// The numstat/name-status parsing + line-index + pager engine lives in
// ./diffPaging.js (parseNumstat / parseNameStatus / indexDiffLines /
// paginateDiff), imported above.

export async function projectDiff({ project, worktree, baseRef, contextLines = 3, summary = false, paths, offset = 0 }) {
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
    const files = stats.map((s, i) => {
      const n = nums[i] ?? { additions: 0, deletions: 0, binary: false };
      const entry = { path: s.path, status: s.status, additions: n.additions, deletions: n.deletions, binary: n.binary };
      if (s.oldPath) entry.oldPath = s.oldPath;
      return entry;
    });
    const totals = {
      files: files.length,
      additions: files.reduce((acc, f) => acc + f.additions, 0),
      deletions: files.reduce((acc, f) => acc + f.deletions, 0),
    };
    const result = { project, worktree, baseRef: ref, head, summary: true, ahead, totals, files };

    // Staged + unstaged changes vs HEAD (does not include untracked files)
    const [rnu, rnsu] = await Promise.all([
      runGit(wt.worktreePath, ['diff', '--numstat', 'HEAD', ...pathspec]),
      runGit(wt.worktreePath, ['diff', '--name-status', 'HEAD', ...pathspec]),
    ]);
    const uNums = rnu.code === 0 ? parseNumstat(rnu.stdout) : [];
    const uStats = rnsu.code === 0 ? parseNameStatus(rnsu.stdout) : [];
    const uFiles = uStats.map((s, i) => {
      const n = uNums[i] ?? { additions: 0, deletions: 0, binary: false };
      const entry = { path: s.path, status: s.status, additions: n.additions, deletions: n.deletions, binary: n.binary };
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
  let untracked = [];

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

  const meta = {
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
    const included = new Set();
    for (let i = startLine; i < cutoff; i++) {
      const fi = idx.fileOf[i];
      if (fi >= 0 && idx.files[fi].path) included.add(idx.files[fi].path);
    }
    const allPaths = idx.files.map(f => f.path).filter(Boolean);
    meta.includedFiles = allPaths.filter(p => included.has(p));
    meta.omittedFiles = allPaths.filter(p => !included.has(p));
  }
  // Metadata block + a separate raw, un-escaped diff text block.
  return textPayload(meta, diff);
}

// ---------- mutating: worktrees ----------

export async function createWorktree({ project }) {
  return toMcpWorktree(await fsCreateWorktree(project));
}

export async function deleteWorktree({ project, worktree, force = false }, { instances }) {
  let running = [];
  if (instances) {
    running = instances.idsForWorktree(project, worktree)
      .map(id => instances.get(id))
      .filter(i => i && i.proc);
    // Expected business refusal (not a fault): attached live instance.
    if (running.length > 0 && !force) {
      return {
        ok: false,
        code: 'WORKTREE_ATTACHED',
        reason: `worktree '${worktree}' has ${running.length} running instance(s) — kill them first or pass force=true`,
      };
    }
  }
  // Expected business refusal: uncommitted changes. Pre-check here so it
  // returns soft rather than throwing out of removeWorktree (which stays as
  // a true-fault backstop, called with force below).
  if (!force) {
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

export async function syncWorktree({ sessionId }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
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

export async function mergeWorktree({ sessionId, project, worktree, allowDirty }, { instances }) {
  let projectName, wtName, meta;
  if (sessionId) {
    const r = await getInst(instances, sessionId);
    if (r.soft) return r.soft;
    const inst = r.inst;
    if (!inst.worktree) throw new Error(`session ${sessionId} is not attached to a worktree`);
    projectName = inst.project;
    wtName = inst.worktree.worktreeName;
    meta = inst.worktree;
  } else {
    if (!project || !worktree) {
      throw new Error('merge_worktree requires either sessionId or both {project, worktree}');
    }
    projectName = project;
    wtName = worktree;
    meta = await getWorktree(projectName, wtName);
    if (!meta) throw new Error(`worktree '${wtName}' not found under project '${projectName}'`);
  }
  // The behind-guard now lives inside mergeWorktreeIntoParent (shared with the
  // REST route); map its typed refusal to this surface's exact wording.
  const result = await mergeWorktreeIntoParent(projectName, wtName, { allowDirty: allowDirty === true });
  if (result.code === 'WORKTREE_BEHIND') {
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
// the REST endpoints in src/routes.js (PUT /projects/:name/workspace,
// POST/PUT/DELETE /workspaces, GET /workspaces) so a conductor can set
// up its own organisation alongside the human.

export async function listWorkspaces() {
  return summarizeWorkspaces();
}

export async function createWorkspace({ name }) {
  return fsAddWorkspace(name);
}

export async function deleteWorkspace({ name }) {
  return fsRemoveWorkspace(name);
}

export async function renameWorkspace({ oldName, newName }) {
  return fsRenameWorkspace(oldName, newName);
}

// Assign or clear a project's workspace. `workspace: null` or "" clears
// the field. Non-null values are auto-registered so freshly-named
// workspaces appear in list_workspaces immediately, matching the REST
// PUT handler's behaviour. Refuses .conduct — the hidden project can't
// belong to a workspace.
export async function setProjectWorkspace({ project, workspace }) {
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

export async function createProject({ name, gitInit = false, conventions = [] }) {
  const appendToCLAUDEmd = await composeProjectConventionsBlock(conventions);
  const scaffold = await composeProjectScaffold(name, conventions);
  const created = await fsCreateProject(name, { appendToCLAUDEmd });
  if (gitInit) {
    const r = await runGit(created.path, ['init', '-q']);
    if (r.code !== 0) {
      throw new Error(`git init failed in ${created.path}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }
  // The scaffold directive is RETURNED, not persisted — fold it into your FIRST
  // send_prompt to the project's first worker (see conduct/core.md).
  return { ...created, gitInit: !!gitInit, ...(scaffold ? { scaffold } : {}) };
}

export async function listProjectConventions() {
  const catalog = await getProjectConventionsCatalog();
  return catalog.map(({ slug, name, description, builtin, scaffold }) => ({ slug, name, description, builtin, hasScaffold: !!scaffold }));
}

export async function listConductorModules() {
  const [catalog, enabled] = await Promise.all([getConductModulesCatalog(), getConductSelection()]);
  const on = new Set(enabled);
  return catalog.map(({ slug, name, description, builtin }) => ({
    slug, name, description, builtin, enabled: on.has(slug),
  }));
}

// reconstructMessages / buildMessageFromRing / mergeRecentWithDisk /
// capBlockInput / hasPlanOrQuestions / ringTurnIndex / bondTrailingTurn
// (+ capText / MSG_TEXT_CAP) live in ./messageReconstruction.js, imported above.
// isTextBearing stays here — it's a handler-side filter, not part of the
// reconstruction engine.
function isTextBearing(m) {
  return m.text.length > 0 || hasPlanOrQuestions(m);
}

// Boundary line prefixed into each get_recent_messages body when more than one
// message is returned, so consecutive raw text blocks (content[k+1]) never
// visually run together. Presentation-only — meta's textChars/index already
// describe the raw prose.
function messageBoundaryHeader(index, total, msgId, textChars) {
  return `--- message ${index + 1}/${total} · ${msgId} · ${textChars} chars ---`;
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
export async function getRecentMessages(args, ctx) {
  const r = await buildRecentMessages(args, ctx);
  if (r.soft) return r.soft;
  return textPayload(r.meta, r.bodies);
}

// Core of get_recent_messages: resolve the session, reconstruct + bond + cap the
// recent assistant messages, and return `{ meta, bodies }` (or `{ soft }` for a
// soft-refusal). Split out so the idle-subscription wake-callback can fold the
// SAME content a default get_recent_messages call returns into its stub without
// re-deriving the selection/bonding logic. `getRecentMessages` wraps this in a
// textPayload; the wake path flattens it (see src/mcp/content.js flattenPayload).
export async function buildRecentMessages({ sessionId, count, includeToolCalls = false, includeThinking = false }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r;
  const inst = r.inst;
  const isDefaultCount = count === undefined;
  const n = Math.max(1, Math.min(Number.isInteger(count) ? count : 1, 50));
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
  // message carries its (capped) prose, in order — block k+1 ↔ messages[k].
  // When more than one message is returned, each body is prefixed with a
  // boundary line (messageBoundaryHeader) so consecutive raw text blocks never
  // visually run together — a text-less (plan/question-only) message's body is
  // then just that line rather than ''. meta stays untouched either way:
  // textChars/index/etc. always describe the raw prose, not the decorated body.
  const bodies = [];
  const total = messages.length;
  const metaMessages = messages.map((m, index) => {
    const textChars = (m.text ?? '').length;
    const capped = capText(m.text ?? '', MSG_TEXT_CAP);
    const body = total > 1
      ? messageBoundaryHeader(index, total, m.msgId, textChars) + (capped.text ? `\n${capped.text}` : '')
      : capped.text;
    bodies.push(body);
    const entry = {
      index,
      msgId: m.msgId,
      hasToolUse: m.hasToolUse,
      textChars,
      textTruncated: capped.truncated,
    };
    if (m.plan) entry.plan = m.plan;
    if (m.questions) entry.questions = m.questions;
    if (m.blocks) entry.blocks = m.blocks.map(capBlockInput);
    return entry;
  });

  const lastSeq = ring.length ? ring[ring.length - 1]._seq : -1;
  const meta = {
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
async function resolveProjectCwd(projectName, worktreeName) {
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
async function listTopLevelEntries(cwd) {
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
export async function projectStatus({ project, worktree, logLimit = 20 }) {
  const { cwd, worktreeMeta } = await resolveProjectCwd(project, worktree);
  const out = {
    project,
    worktree: worktree ?? null,
    cwd,
    files: await listTopLevelEntries(cwd),
    isGitRepo: false,
  };
  if (!(await isGitRepo(cwd))) {
    return out;
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
  if (out.dirty.length > DIRTY_CAP) {
    out.dirtyTotal = out.dirty.length;
    out.dirty = out.dirty.slice(0, DIRTY_CAP);
    out.dirtyTruncated = true;
  } else {
    out.dirtyTruncated = false;
  }
  // Recent commits (oneline). Negative or 0 logLimit → skip.
  if (Number.isInteger(logLimit) && logLimit > 0) {
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
  return out;
}

// Path-traversal-guarded file read. Path is project-relative; absolute
// paths or `..` segments that escape the project / worktree root are
// rejected. Caps at maxBytes (default 256 KB) so this stays cheap to
// call from an LLM loop. Returns text content with lineCount; binary
// files are reported as base64 (line params ignored for binary).
// Optional line params (text only): offset (1-based start line, default 1),
// limit (max lines, default: to EOF), lineNumbers (cat-n prefix).
export async function projectRead({ project, worktree, relativePath,
  maxBytes = 256 * 1024, lineNumbers = false, offset = 1, limit }) {
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
    if (e.code === 'ENOENT') {
      const err = new Error(`file not found: ${relativePath}`);
      err.statusCode = 404;
      throw err;
    }
    throw e;
  }
  if (stat.isDirectory()) {
    throw new Error(`'${relativePath}' is a directory — use project_status to list it`);
  }
  if (!stat.isFile()) {
    throw new Error(`'${relativePath}' is not a regular file`);
  }
  const cap = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 256 * 1024;

  // Always read up to cap bytes first (preserves existing binary behaviour and
  // avoids loading huge files on the fast path).
  const fh = await fs.open(resolved, 'r');
  let buf, truncatedByBytes;
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

  const startIdx = Number.isInteger(offset) && offset >= 1 ? offset - 1 : 0;
  const endIdx = Number.isInteger(limit) && limit >= 1
    ? Math.min(startIdx + limit, lineCount)
    : lineCount;

  const slicedLines = allLines.slice(startIdx, endIdx); // empty [] if past EOF
  const startLine = startIdx + 1;
  // endLine: last line number served; equals startLine when slice is empty
  const endLine = Math.max(startLine, startLine + slicedLines.length - 1);

  // Reassemble; restore trailing newline when the slice ends at the last line.
  const atEof = slicedLines.length > 0 && endLine >= lineCount;
  let content;
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
  const meta = {
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

export function clampBashTimeoutMs(timeout) {
  if (!Number.isFinite(timeout) || timeout <= 0) return BASH_DEFAULT_TIMEOUT_MS;
  return Math.min(timeout, BASH_MAX_TIMEOUT_MS);
}

// Single-quote-escape for safe interpolation inside a single-quoted bash
// string — orchStoreRoot() derives from user-configurable PROJECTS_ROOT.
function shQuote(p) {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// Run a shell command inside a project/worktree cwd, in claude's own
// restored shell environment (rg/find/grep shims + shell functions, via the
// cached bundle from claudeShellEnv.js). The bundle is sourced with the same
// shell (bash or zsh) that produced it — see bundleShellKind(). Read-only
// inspection only (see the tool description in mcp/tools.js). `description`
// is accepted for schema parity with the built-in Bash tool but is unused
// server-side.
export async function bashProject({ project, worktree, command, timeout }) {
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
    const chunks = [];
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
        err.message,
      ));
      return;
    }

    const killGroup = () => {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      }, 100).unref();
    };
    // Keep draining both pipes to completion (avoids backpressure stalling
    // the process) but stop RETAINING bytes past the cap — matches the
    // built-in Bash tool's semantics (truncate what's *shown*, let the
    // command run to completion). timeoutMs is the only hard kill.
    const onData = (chunk) => {
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
      const output = capped ? raw + '\n… [truncated at 200 KB]' : raw;
      const meta = {
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
