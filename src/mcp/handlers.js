// MCP tool handlers. Thin shells over the orchestrator's existing modules
// (InstanceManager, projects.js, worktrees.js) — never duplicate business
// logic, never self-HTTP. Each handler receives (args, { instances }).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
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
import { getCatalog as getOptionalGuidelinesCatalog, composeGuidelinesBlock } from '../optionalGuidelines.js';
import { isKnownFamily, defaultVersion } from '../modelVersions.js';
import { getModelVersion } from '../appSettings.js';
import { textPayload } from './content.js';
import { pageInstanceEvents } from '../eventArchive.js';
import { parseNumstat, parseNameStatus, indexDiffLines, paginateDiff } from './diffPaging.js';
import {
  capText, MSG_TEXT_CAP, reconstructMessages, mergeRecentWithDisk, capBlockInput,
} from './messageReconstruction.js';

// Dirty-line cap for project_status — mirror read_file/get_worktree_diff's
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
  // Resolve family alias (opus/sonnet/haiku/fable) to the concrete version
  // configured in Settings → Models. Full model ids pass through unchanged.
  let model = args.model;
  if (model && isKnownFamily(model)) {
    model = getModelVersion(model) ?? defaultVersion(model);
  }
  // createWorktree:true → create a fresh worktree (passed to create() as the
  // boolean `true`); worktree:"<name>" → attach to an existing one.
  // createWorktree wins if both are given. create() still accepts the
  // boolean|string internal contract unchanged.
  const worktree = args.createWorktree === true ? true : args.worktree;
  const inst = await instances.create({
    project: args.project,
    mode: args.mode,
    effort: args.effort,
    thinking: args.thinking,
    model,
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
  });
  return toConductorView(inst.summary());
}

export async function sendPrompt({ sessionId, text, wait = false, waitTimeoutMs = 600_000 }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  // getInst is LIVE-only, so inst.proc is guaranteed here.
  if (wait) {
    // Attach the listener *before* sending so we can't miss a fast turn_end.
    const waiter = waitForEvent(inst, (ev) => ev.kind === 'turn_end', waitTimeoutMs);
    await inst.prompt(text);
    const ev = await waiter;
    return { sessionId: inst.sessionId, turnEnd: ev };
  }
  await inst.prompt(text);
  return { sessionId: inst.sessionId, status: inst.status };
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
export async function approvePlan({ sessionId, feedback }, { instances }) {
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
  return { sessionId: inst.sessionId, mode: inst.mode, sentText: text };
}

// Reject a worker's plan: stay in plan mode, send the refinement prompt.
// The worker will produce a revised plan; the conductor loops back to
// reviewing get_recent_messages and either approves or rejects again.
export async function rejectPlan({ sessionId, feedback }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  const text = buildRejectPrompt(feedback);
  await inst.prompt(text, [], { annotateIfMidTurn: false });
  return { sessionId: inst.sessionId, mode: inst.mode, sentText: text };
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
export async function answerQuestion({ sessionId, answers }, { instances }) {
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
  return { sessionId: inst.sessionId, mode: inst.mode, sentText: text };
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

export async function getWorktreeDiff({ project, worktree, baseRef, contextLines = 3, summary = false, paths, offset = 0, includeWorkingTree = false }) {
  if (!project || !worktree) {
    throw new Error('get_worktree_diff requires {project, worktree}');
  }
  const wt = await getWorktree(project, worktree);
  if (!wt) throw new Error(`worktree '${worktree}' not found under project '${project}'`);
  // Resolve the worktree's current HEAD sha (the right edge of the diff).
  const headR = await runGit(wt.worktreePath, ['rev-parse', 'HEAD']);
  const head = headR.code === 0 ? headR.stdout.trim() : null;
  const ref = (typeof baseRef === 'string' && baseRef.trim()) ? baseRef.trim() : wt.baseBranch;
  if (typeof baseRef === 'string' && baseRef.trim()) assertValidBaseRef(ref);
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
    const result = { project, worktree, baseRef: ref, head, summary: true, totals, files };

    if (includeWorkingTree) {
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
      result.includeWorkingTree = true;
      result.uncommitted = { totals: uTotals, files: uFiles, untracked };
    }
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

  if (includeWorkingTree) {
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
  };
  if (includeWorkingTree) {
    meta.includeWorkingTree = true;
    meta.hasUncommittedChanges = uncommittedDiff.trim().length > 0;
    meta.untracked = untracked;
  }
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

export async function mergeWorktree({ sessionId, project, worktree }, { instances }) {
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
  const result = await mergeWorktreeIntoParent(projectName, wtName);
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

export async function createProject({ name, gitInit = false, guidelines = [] }) {
  const appendToCLAUDEmd = await composeGuidelinesBlock(guidelines);
  const created = await fsCreateProject(name, { appendToCLAUDEmd });
  if (gitInit) {
    const r = await runGit(created.path, ['init', '-q']);
    if (r.code !== 0) {
      throw new Error(`git init failed in ${created.path}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }
  return { ...created, gitInit: !!gitInit };
}

export async function listOptionalGuidelines() {
  const catalog = await getOptionalGuidelinesCatalog();
  return catalog.map(({ slug, name, description, builtin }) => ({ slug, name, description, builtin }));
}

// reconstructMessages / buildMessageFromRing / mergeRecentWithDisk /
// capBlockInput (+ capText / MSG_TEXT_CAP) live in ./messageReconstruction.js,
// imported above. isTextBearing/hasPlanOrQuestions stay here — they're
// handler-side filters, not part of the reconstruction engine.
function hasPlanOrQuestions(m) {
  return !!m.plan || (Array.isArray(m.questions) && m.questions.length > 0);
}
function isTextBearing(m) {
  return m.text.length > 0 || hasPlanOrQuestions(m);
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
// across two separate assistant messages (the CLI starts a fresh message
// after the tool_result denial). If the last message is pure prose and the
// one immediately before it carries a plan/questions, that predecessor is
// bonded in too — at most one extra message, never walked back further. A
// message that already carries its own plan/questions is always returned
// alone. Explicit `count` (including `count:1`) is always literal.
export async function getRecentMessages({ sessionId, count, includeToolCalls = false, includeThinking = false }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
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
  if (isDefaultCount && messages.length === 1) {
    const lastIdx = filtered.length - 1;
    const last = filtered[lastIdx];
    const lastIsPureProse = !hasPlanOrQuestions(last) && (last.text ?? '').length > 0;
    const prev = filtered[lastIdx - 1];
    if (lastIsPureProse && prev && hasPlanOrQuestions(prev)) {
      messages = [prev, last];
    }
  }
  const omittedToolOnly = includeToolCalls ? 0 : (all.length - filtered.length);

  // Multi-block: metadata block describes each message; one raw text block per
  // message carries its (capped) prose, in order — block k+1 ↔ messages[k].
  const bodies = [];
  const metaMessages = messages.map((m, index) => {
    const capped = capText(m.text ?? '', MSG_TEXT_CAP);
    bodies.push(capped.text);
    const entry = {
      index,
      msgId: m.msgId,
      hasToolUse: m.hasToolUse,
      textChars: (m.text ?? '').length,
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
  return textPayload(meta, bodies);
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
  // response (mirrors read_file / get_worktree_diff's bounded-output pattern).
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
export async function readFile({ project, worktree, relativePath,
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

// ---- grep / glob helpers ----

// File-type shorthand → extension list (mirrors ripgrep's built-in type system).
const TYPE_EXTS = {
  js:   ['.js', '.mjs', '.cjs'],
  ts:   ['.ts', '.tsx', '.mts', '.cts'],
  jsx:  ['.jsx'],
  py:   ['.py', '.pyw'],
  json: ['.json', '.jsonc'],
  md:   ['.md', '.mdx'],
  html: ['.html', '.htm'],
  css:  ['.css', '.scss', '.sass', '.less'],
  sh:   ['.sh', '.bash'],
  yaml: ['.yaml', '.yml'],
  toml: ['.toml'],
  go:   ['.go'],
  rust: ['.rs'],
  java: ['.java'],
  c:    ['.c', '.h'],
  cpp:  ['.cpp', '.cc', '.cxx', '.hpp', '.hh'],
};

// Convert a minimatch-style glob to a RegExp.
// Handles: **/ (zero or more path segments), ** (any), * (non-slash run), ? (one non-slash).
function globToRegex(pattern) {
  let s = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { s += '(?:[^/]+/)*'; i += 3; }
      else { s += '.*'; i += 2; }
    } else if (c === '*') {
      s += '[^/]*'; i++;
    } else if (c === '?') {
      s += '[^/]'; i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      s += '\\' + c; i++;
    } else {
      s += c; i++;
    }
  }
  return new RegExp('^' + s + '$');
}

// Recursively collect { fullPath, relPath } under dir.
// Skips .git/, node_modules/, and ALL symlinks (never follows them — on this
// host worktrees have node_modules symlinked to the parent repo's tree, which
// would cause a massive irrelevant descent).
// Optionally filters by extFilter (lowercase ext array) and/or globRegex.
async function walkProjectDir(dir, rootDir, { extFilter = null, globRegex = null } = {}) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  const results = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);
    if (entry.isDirectory()) {
      const sub = await walkProjectDir(fullPath, rootDir, { extFilter, globRegex });
      for (const f of sub) results.push(f);
    } else if (entry.isFile()) {
      if (extFilter && !extFilter.includes(path.extname(entry.name).toLowerCase())) continue;
      if (globRegex && !globRegex.test(relPath)) continue;
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

// Build non-overlapping match windows for context-line output.
// Returns [{start, end, matchLines: Set<number>}] (0-based indices).
function collectGrepGroups(lines, regex, beforeCtx, afterCtx) {
  const groups = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (!regex.test(lines[i])) continue;
    const winStart = Math.max(0, i - beforeCtx);
    const winEnd = Math.min(lines.length - 1, i + afterCtx);
    if (cur === null) {
      cur = { start: winStart, end: winEnd, matchLines: new Set([i]) };
    } else if (winStart <= cur.end + 1) {
      cur.end = Math.max(cur.end, winEnd);
      cur.matchLines.add(i);
    } else {
      groups.push(cur);
      cur = { start: winStart, end: winEnd, matchLines: new Set([i]) };
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

// Render a single file's grep groups into a text block.
// Match lines use ':' separator; context lines use '-' (grep/rg style).
function formatGrepGroups(relPath, lines, groups) {
  const parts = [];
  for (const g of groups) {
    const chunk = [];
    for (let i = g.start; i <= g.end; i++) {
      const sep = g.matchLines.has(i) ? ':' : '-';
      chunk.push(`${relPath}:${i + 1}${sep}${lines[i]}`);
    }
    parts.push(chunk.join('\n'));
  }
  return parts.join('\n--\n');
}

// Cached ripgrep availability (undefined = unchecked; null = absent; 'rg' = found).
let _rgAvail = undefined;
async function checkRg() {
  if (_rgAvail !== undefined) return _rgAvail;
  return new Promise(resolve => {
    execFile('rg', ['--version'], { timeout: 3000 }, err => {
      _rgAvail = err ? null : 'rg';
      resolve(_rgAvail);
    });
  });
}

// Generic execFile wrapper → { code, stdout, stderr }.
function runCmd(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

// Ripgrep backend for grepProject. Uses text output (not --json) so the
// format is already identical to the JS path's output.
async function grepWithRg(cwd, project, worktree, pattern, { mode, caseInsensitive, effBefore, effAfter, globPat, type, limit }) {
  const args = ['--color=never', '--no-heading'];
  if (caseInsensitive) args.push('-i');
  // rg excludes .git by default; also exclude node_modules explicitly.
  args.push('--glob=!node_modules/');
  if (type && TYPE_EXTS[type]) {
    for (const ext of TYPE_EXTS[type]) args.push(`--glob=*${ext}`);
  }
  if (globPat) args.push(`--glob=${globPat}`);

  if (mode === 'files_with_matches') {
    args.push('-l');
  } else if (mode === 'count') {
    args.push('-c');
  } else { // content
    args.push('-n');
    if (effBefore > 0) args.push(`-B${effBefore}`);
    if (effAfter > 0) args.push(`-A${effAfter}`);
  }
  args.push('--', pattern, '.');

  const r = await runCmd('rg', args, { cwd });
  // rg: exit 0 = matches found, 1 = no matches (not an error), 2 = real error.
  if (r.code === 2) throw new Error(`rg failed: ${r.stderr.trim()}`);

  if (mode === 'files_with_matches') {
    const files = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    const truncated = files.length > limit;
    const result = truncated ? files.slice(0, limit) : files;
    return { project, worktree: worktree ?? null, pattern, outputMode: mode, files: result, fileCount: result.length, truncated };
  }

  if (mode === 'count') {
    const entries = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    const files = [];
    for (const e of entries) {
      const col = e.lastIndexOf(':');
      if (col < 0) continue;
      const count = parseInt(e.slice(col + 1), 10);
      if (!isNaN(count) && count > 0) files.push({ path: e.slice(0, col), count });
    }
    const truncated = files.length > limit;
    const result = truncated ? files.slice(0, limit) : files;
    const totalMatches = result.reduce((s, f) => s + f.count, 0);
    return { project, worktree: worktree ?? null, pattern, outputMode: mode, files: result, totalMatches, truncated };
  }

  // content mode: apply byte cap
  let body = r.stdout;
  let truncated = false;
  if (Buffer.byteLength(body, 'utf8') > DIFF_BYTE_CAP) {
    const enc = Buffer.from(body, 'utf8').subarray(0, DIFF_BYTE_CAP);
    body = enc.toString('utf8');
    const lastNl = body.lastIndexOf('\n');
    if (lastNl > 0) body = body.slice(0, lastNl + 1);
    truncated = true;
  }
  const filesSeen = new Set();
  let matchCount = 0;
  for (const line of body.split('\n')) {
    if (!line || line === '--') continue;
    const m = line.match(/^([^:]+):\d+:/);
    if (m) { filesSeen.add(m[1]); matchCount++; }
  }
  const meta = { project, worktree: worktree ?? null, pattern, outputMode: mode, matchCount, fileCount: filesSeen.size, truncated };
  return textPayload(meta, body);
}

// Search file contents by regex across a project/worktree tree.
// Path-traversal guarded (resolveProjectCwd anchors cwd; walk never leaves it).
// Excludes .git/, node_modules/, and never follows symlinks.
// Prefers ripgrep if available; otherwise pure JS.
export async function grepProject({
  project, worktree, pattern,
  glob: globPat, type,
  outputMode = 'files_with_matches',
  caseInsensitive = false,
  before: beforeCtx = 0, after: afterCtx = 0, context: ctxLines = 0,
  headLimit = 250,
}) {
  if (typeof pattern !== 'string' || !pattern) throw new Error('grep requires a pattern');

  let regex;
  try { regex = new RegExp(pattern, caseInsensitive ? 'i' : ''); }
  catch (e) { throw new Error(`invalid pattern: ${e.message}`); }

  const mode = ['files_with_matches', 'content', 'count'].includes(outputMode) ? outputMode : 'files_with_matches';
  const limit = Number.isInteger(headLimit) && headLimit >= 1 ? headLimit : 250;
  const effBefore = ctxLines > 0 ? ctxLines : (Number.isInteger(beforeCtx) && beforeCtx > 0 ? beforeCtx : 0);
  const effAfter = ctxLines > 0 ? ctxLines : (Number.isInteger(afterCtx) && afterCtx > 0 ? afterCtx : 0);

  const { cwd } = await resolveProjectCwd(project, worktree);

  const extFilter = (typeof type === 'string' && type) ? (TYPE_EXTS[type] ?? null) : null;
  const globRegex = (typeof globPat === 'string' && globPat) ? globToRegex(globPat) : null;

  if (await checkRg()) {
    return grepWithRg(cwd, project, worktree, pattern, { mode, caseInsensitive, effBefore, effAfter, globPat, type, limit });
  }

  // ---- pure JS path ----
  const fileList = await walkProjectDir(cwd, cwd, { extFilter, globRegex });

  if (mode === 'files_with_matches') {
    const files = [];
    let truncated = false;
    for (const { fullPath, relPath } of fileList) {
      let text;
      try { text = await fs.readFile(fullPath, 'utf8'); } catch { continue; }
      if (regex.test(text)) {
        if (files.length < limit) {
          files.push(relPath);
        } else {
          truncated = true;
          break;
        }
      }
    }
    return { project, worktree: worktree ?? null, pattern, outputMode: mode, files, fileCount: files.length, truncated };
  }

  if (mode === 'count') {
    const files = [];
    let truncated = false;
    for (const { fullPath, relPath } of fileList) {
      let text;
      try { text = await fs.readFile(fullPath, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      let count = 0;
      for (const line of lines) if (regex.test(line)) count++;
      if (count > 0) {
        if (files.length < limit) {
          files.push({ path: relPath, count });
        } else {
          truncated = true;
          break;
        }
      }
    }
    const totalMatches = files.reduce((s, f) => s + f.count, 0);
    return { project, worktree: worktree ?? null, pattern, outputMode: mode, files, totalMatches, truncated };
  }

  // content mode
  const parts = [];
  let totalBytes = 0;
  let matchCount = 0;
  let fileCount = 0;
  let truncated = false;

  for (const { fullPath, relPath } of fileList) {
    if (fileCount >= limit) { truncated = true; break; }
    let text;
    try { text = await fs.readFile(fullPath, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    const groups = collectGrepGroups(lines, regex, effBefore, effAfter);
    if (groups.length === 0) continue;

    const chunk = formatGrepGroups(relPath, lines, groups);
    const sep = parts.length > 0 ? '\n--\n' : '';
    const needed = Buffer.byteLength(sep + chunk, 'utf8');
    if (totalBytes + needed > DIFF_BYTE_CAP) { truncated = true; break; }

    if (sep) parts.push(sep);
    parts.push(chunk);
    totalBytes += needed;
    fileCount++;
    for (const g of groups) matchCount += g.matchLines.size;
  }

  const body = parts.join('');
  const meta = { project, worktree: worktree ?? null, pattern, outputMode: mode, matchCount, fileCount, truncated };
  return textPayload(meta, body);
}

// Find files by glob pattern within a project/worktree tree.
// Path-traversal guarded. Excludes .git/, node_modules/, and never follows symlinks.
// Returns project-relative paths sorted newest-first by mtime.
export async function globProject({ project, worktree, pattern, headLimit = 1000 }) {
  if (typeof pattern !== 'string' || !pattern) throw new Error('glob requires a pattern');
  const limit = Number.isInteger(headLimit) && headLimit >= 1 ? headLimit : 1000;
  const { cwd } = await resolveProjectCwd(project, worktree);
  const globRegex = globToRegex(pattern);

  const fileList = await walkProjectDir(cwd, cwd, { globRegex });

  // Stat each file for mtime; failures silently fall back to mtime = 0.
  const withMtimes = await Promise.all(fileList.map(async ({ fullPath, relPath }) => {
    try {
      const s = await fs.stat(fullPath);
      return { relPath, mtime: s.mtimeMs };
    } catch {
      return { relPath, mtime: 0 };
    }
  }));

  withMtimes.sort((a, b) => b.mtime - a.mtime);

  const total = withMtimes.length;
  const truncated = total > limit;
  const result = truncated ? withMtimes.slice(0, limit) : withMtimes;

  return {
    project,
    worktree: worktree ?? null,
    pattern,
    files: result.map(f => f.relPath),
    total,
    truncated,
  };
}
