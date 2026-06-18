// MCP tool handlers. Thin shells over the orchestrator's existing modules
// (InstanceManager, projects.js, worktrees.js) — never duplicate business
// logic, never self-HTTP. Each handler receives (args, { instances }).

import path from 'node:path';
import { promises as fs } from 'node:fs';
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
import { isKnownFamily, defaultVersion } from '../modelVersions.js';
import { getModelVersion } from '../appSettings.js';
import { textPayload } from './content.js';
import { pageInstanceEvents } from '../eventArchive.js';
import { loadPersistedTranscript } from '../transcript.js';

// Per-message text cap for get_recent_messages raw blocks, and dirty-line cap
// for project_status — mirror read_file/get_worktree_diff's bounded-output
// pattern so no tool can emit an unbounded body.
const MSG_TEXT_CAP = 32 * 1024;
const DIRTY_CAP = 500;
// Upper bound on how many trailing on-disk events get_recent_messages
// reconstructs in its (rare) disk-fallback path, so a multi-MB session jsonl
// can't make the call pathological. We only need the last ≤50 messages, which
// fit comfortably in this many events.
const DISK_REPLAY_TAIL_CAP = 5000;

// Cap a string to `cap` bytes, returning { text, truncated }.
function capText(s, cap) {
  const str = typeof s === 'string' ? s : '';
  if (Buffer.byteLength(str, 'utf8') <= cap) return { text: str, truncated: false };
  return { text: Buffer.from(str, 'utf8').subarray(0, cap).toString('utf8'), truncated: true };
}

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
    // caller win.
    temp: args.temp === undefined ? true : args.temp,
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

// Parse `git diff --numstat` output into per-file {additions, deletions,
// binary}. Binary files render as "-\t-\t<path>". File order matches
// --name-status given identical flags, so callers zip the two by index.
function parseNumstat(out) {
  const rows = [];
  for (const line of (out ?? '').split('\n')) {
    if (!line) continue;
    const tab1 = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const addsField = line.slice(0, tab1);
    const delsField = line.slice(tab1 + 1, tab2);
    const binary = addsField === '-';
    rows.push({
      additions: binary ? 0 : (Number(addsField) || 0),
      deletions: binary ? 0 : (Number(delsField) || 0),
      binary,
    });
  }
  return rows;
}

// Parse `git diff --name-status` output into per-file {status, path,
// oldPath?}. Rename/copy rows (R###/C###) carry the old path first.
function parseNameStatus(out) {
  const rows = [];
  for (const line of (out ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    const status = (code[0] || 'M').toUpperCase();
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      rows.push({ status, oldPath: parts[1], path: parts[2] });
    } else {
      rows.push({ status, path: parts[parts.length - 1] });
    }
  }
  return rows;
}

// Walk a unified-diff line array once, recording for each line the file it
// belongs to: {path, preambleLines, hunkAt} where preambleLines are the
// lines from "diff --git" up to (not including) the first "@@", and
// hunkAt[i] is the index of the active "@@" header for line i (or -1).
function indexDiffLines(lines) {
  const fileOf = new Array(lines.length).fill(-1);   // index into files[]
  const hunkAt = new Array(lines.length).fill(-1);   // index of active @@ line
  const files = [];                                  // {path, start, preEnd}
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = { path: m ? m[2] : null, start: i, preEnd: i + 1, sawHunk: false };
      files.push(cur);
    }
    if (cur) {
      fileOf[i] = files.length - 1;
      if (line.startsWith('@@ ')) {
        cur.sawHunk = true;
        hunkAt[i] = i;
      } else if (!cur.sawHunk) {
        cur.preEnd = i + 1; // still in the file preamble
      } else {
        // body line — inherits the most recent @@ within this file
        let h = -1;
        for (let j = i - 1; j >= cur.start; j--) {
          if (lines[j].startsWith('@@ ')) { h = j; break; }
        }
        hunkAt[i] = h;
      }
    }
  }
  return { fileOf, hunkAt, files };
}

// Line-based pager. Returns a page of whole lines starting at `offset`,
// filling until the next line would exceed `cap` bytes. Mid-file pages are
// prefixed with the file's preamble + active hunk header so they parse
// standalone. Snaps the cutoff back to a hunk boundary when cheap.
function paginateDiff(lines, offset, cap, idx) {
  const { fileOf, hunkAt, files } = idx;
  const total = lines.length;
  if (offset >= total) {
    return { diff: '', cutoff: total, prefixLines: [] };
  }
  // Re-emit headers when the page starts mid-file (not on the diff --git line).
  const prefixLines = [];
  const fi = fileOf[offset];
  if (offset > 0 && fi >= 0) {
    const f = files[fi];
    const startsAtPreamble = offset === f.start;
    if (!startsAtPreamble) {
      for (let j = f.start; j < f.preEnd; j++) prefixLines.push(lines[j]);
      const h = hunkAt[offset];
      // Only re-add the @@ header if the offset line isn't itself that header.
      if (h >= 0 && h !== offset) prefixLines.push(lines[h]);
    }
  }
  let bytes = 0;
  for (const p of prefixLines) bytes += Buffer.byteLength(p, 'utf8') + 1;

  let cutoff = offset;
  while (cutoff < total) {
    const lineBytes = Buffer.byteLength(lines[cutoff], 'utf8') + 1;
    if (bytes + lineBytes > cap && cutoff > offset) break;
    bytes += lineBytes;
    cutoff++;
    if (bytes >= cap && cutoff > offset) break;
  }

  // Hunk-snap (nice-to-have): if a later line in the page opened a new hunk,
  // snap the cutoff back to it so the page ends on a hunk boundary — but
  // only when it keeps most of the budget and still makes progress.
  if (cutoff < total && cutoff - offset > 1) {
    const window = Math.max(1, Math.floor((cutoff - offset) * 0.1));
    for (let j = cutoff - 1; j >= cutoff - window && j > offset; j--) {
      if (lines[j].startsWith('@@ ') || lines[j].startsWith('diff --git ')) {
        cutoff = j;
        break;
      }
    }
  }

  const body = lines.slice(offset, cutoff);
  const diff = prefixLines.length ? prefixLines.concat(body).join('\n') : body.join('\n');
  return { diff, cutoff, prefixLines };
}

export async function getWorktreeDiff({ project, worktree, baseRef, contextLines = 3, summary = false, paths, offset = 0 }) {
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
    return { project, worktree, baseRef: ref, head, summary: true, totals, files };
  }

  // ---- diff mode: full diff with line-based pagination ----
  const r = await runGit(wt.worktreePath, ['diff', `--unified=${ctx}`, `${ref}...HEAD`, ...pathspec]);
  if (r.code !== 0) {
    throw new Error(`git diff failed in ${wt.worktreePath}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const full = r.stdout ?? '';
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

export async function createProject({ name, gitInit = false }) {
  const created = await fsCreateProject(name);
  if (gitInit) {
    const r = await runGit(created.path, ['init', '-q']);
    if (r.code !== 0) {
      throw new Error(`git init failed in ${created.path}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }
  return { ...created, gitInit: !!gitInit };
}

// Reconstruct ordered assistant messages from an event array (ring or disk-
// replayed — both carry the same UI-event shape). Collects distinct top-level
// msgIds (skipping sub-agent content) then rebuilds each message.
function reconstructMessages(events, includeThinking) {
  const seen = new Set();
  const reverseIds = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.parentToolUseId) continue; // ignore sub-agent content
    if (!ev.msgId) continue;
    if (ev.kind !== 'text_delta' && ev.kind !== 'text_end'
        && ev.kind !== 'assistant_message' && ev.kind !== 'tool_use') continue;
    if (seen.has(ev.msgId)) continue;
    seen.add(ev.msgId);
    reverseIds.push(ev.msgId);
  }
  const orderedIds = reverseIds.reverse();
  return orderedIds.map(msgId => buildMessageFromRing(events, msgId, includeThinking));
}

function isTextBearing(m) {
  return m.text.length > 0 || m.plan || (Array.isArray(m.questions) && m.questions.length > 0);
}

// Disk-fallback for getRecentMessages: load the on-disk transcript tail and
// merge its reconstructed messages with the ring's, keyed by msgId. The ring
// entry wins on collision (freshest / in-flight); disk fills evicted and
// completed-but-evicted current-turn messages. Bounded by DISK_REPLAY_TAIL_CAP.
// Returns null when no transcript exists (e.g. exited temp session) so the
// caller degrades gracefully to ring-only.
async function mergeRecentWithDisk(inst, ringMessages, includeThinking) {
  const result = await loadPersistedTranscript({
    cwd: inst.cwd, sessionId: inst.sessionId, seqHint: 0,
  }).catch(() => null);
  if (!result) return null;
  let diskEvents = [];
  for (const line of result.lines) for (const ev of line.events) diskEvents.push(ev);
  if (diskEvents.length > DISK_REPLAY_TAIL_CAP) diskEvents = diskEvents.slice(-DISK_REPLAY_TAIL_CAP);
  const diskMessages = reconstructMessages(diskEvents, includeThinking);
  // Ordered merge by msgId: disk first (chronological), ring overrides in place
  // / appends newer (Map keeps first-insert position, updates value).
  const byId = new Map();
  for (const m of diskMessages) byId.set(m.msgId, m);
  for (const m of ringMessages) byId.set(m.msgId, m);
  return [...byId.values()];
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
export async function getRecentMessages({ sessionId, count, includeToolCalls = false, includeThinking = false }, { instances }) {
  const r = await getInst(instances, sessionId);
  if (r.soft) return r.soft;
  const inst = r.inst;
  const n = Math.max(1, Math.min(Number.isInteger(count) ? count : 1, 50));

  const ring = inst.ringSnapshot();
  let all = reconstructMessages(ring, includeThinking);
  let source = 'ring';

  // Disk-fallback only when the ring genuinely can't satisfy the request.
  const ringSatisfies = (includeToolCalls ? all : all.filter(isTextBearing)).length >= n;
  if (!ringSatisfies && inst.sessionId && inst.ring.trimmedBefore > 0) {
    const merged = await mergeRecentWithDisk(inst, all, includeThinking);
    if (merged) { all = merged; source = 'disk'; }
  }

  const filtered = includeToolCalls ? all : all.filter(isTextBearing);
  const messages = filtered.slice(-n);
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

// Cap a block's large field for inline inclusion in the metadata block. A
// tool_use input stays a structured object when small; when oversized it
// becomes a truncated JSON string flagged with inputTruncated. A thinking
// block's text is capped the same way.
function capBlockInput(b) {
  if (b.type === 'tool_use') {
    const json = JSON.stringify(b.input ?? null);
    const { text, truncated } = capText(json, MSG_TEXT_CAP);
    return {
      type: 'tool_use', name: b.name, toolUseId: b.toolUseId,
      input: truncated ? text : b.input,
      inputTruncated: truncated,
    };
  }
  if (b.type === 'thinking') {
    const { text, truncated } = capText(b.text ?? '', MSG_TEXT_CAP);
    return { type: 'thinking', text, inputTruncated: truncated };
  }
  return b;
}

function buildMessageFromRing(ring, targetMsgId, includeThinking = false) {
  const byBlock = new Map();
  const blockOrder = [];
  const otherBlocks = []; // tool_use blocks etc, for context
  let hasToolUse = false;
  let assistantMessage = null;
  let plan = null;
  let questions = null;
  for (const ev of ring) {
    if (ev.parentToolUseId) continue;
    if (ev.msgId !== targetMsgId) continue;
    if (ev.kind === 'text_delta') {
      if (!byBlock.has(ev.blockIdx)) {
        byBlock.set(ev.blockIdx, '');
        blockOrder.push(ev.blockIdx);
      }
      byBlock.set(ev.blockIdx, byBlock.get(ev.blockIdx) + (ev.text ?? ''));
    } else if (ev.kind === 'tool_use') {
      hasToolUse = true;
      let hoisted = false;
      if (ev.name === 'ExitPlanMode') {
        const p = ev.input?.plan;
        if (typeof p === 'string' && p.length > 0) {
          plan = p;
          hoisted = true;
        } else {
          const fp = ev.input?.planFilePath ?? ev.input?.planPath;
          if (typeof fp === 'string' && fp.length > 0) { plan = `(plan at ${fp})`; hoisted = true; }
        }
      } else if (ev.name === 'AskUserQuestion') {
        const q = ev.input?.questions;
        if (Array.isArray(q) && q.length > 0) { questions = q; hoisted = true; }
      }
      if (!hoisted) {
        otherBlocks.push({ type: 'tool_use', name: ev.name, input: ev.input, toolUseId: ev.toolUseId });
      }
    } else if (ev.kind === 'assistant_message') {
      assistantMessage = ev.message ?? null;
    }
  }
  // If a reconciled assistant_message arrived (real CLI), it's the
  // authoritative source — extract text blocks from it instead of the
  // delta accumulation (handles edge cases like deltas trimmed by the ring).
  if (assistantMessage && Array.isArray(assistantMessage.content)) {
    const textParts = [];
    const blocks = [];
    for (const block of assistantMessage.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block?.type === 'tool_use') {
        hasToolUse = true;
        let hoisted = false;
        if (block.name === 'ExitPlanMode') {
          const p = block.input?.plan;
          if (typeof p === 'string' && p.length > 0) {
            plan = p;
            hoisted = true;
          } else {
            const fp = block.input?.planFilePath ?? block.input?.planPath;
            if (typeof fp === 'string' && fp.length > 0) { plan = `(plan at ${fp})`; hoisted = true; }
          }
        } else if (block.name === 'AskUserQuestion') {
          const q = block.input?.questions;
          if (Array.isArray(q) && q.length > 0) { questions = q; hoisted = true; }
        }
        if (!hoisted) {
          blocks.push({ type: 'tool_use', name: block.name, input: block.input, toolUseId: block.id });
        }
      } else if (block?.type === 'thinking' && includeThinking) {
        blocks.push({ type: 'thinking', text: block.thinking ?? '' });
      }
    }
    return { msgId: targetMsgId, text: textParts.join(''), ...(blocks.length ? { blocks } : {}), hasToolUse,
      ...(plan ? { plan } : {}), ...(questions ? { questions } : {}) };
  }
  const text = blockOrder.map(idx => byBlock.get(idx)).join('');
  return { msgId: targetMsgId, text, ...(otherBlocks.length ? { blocks: otherBlocks } : {}), hasToolUse,
    ...(plan ? { plan } : {}), ...(questions ? { questions } : {}) };
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
