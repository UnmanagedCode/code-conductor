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
  listWorkspaces as fsListWorkspaces,
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
  worktreeDirtyLines,
} from '../worktrees.js';
import { buildApprovePrompt, buildRejectPrompt } from '../planApproval.js';

// ---------- helpers ----------

function getInst(instances, id) {
  if (!instances) {
    const err = new Error('orchestrator was started without an InstanceManager');
    err.statusCode = 500;
    throw err;
  }
  if (typeof id !== 'string' || !id) {
    throw new Error('id required');
  }
  const inst = instances.get(id);
  if (!inst) {
    throw new Error(`instance not found: ${id}`);
  }
  return inst;
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
      instanceIds: instances ? instances.idsForProject(p.name) : [],
      isGitRepo: await isGitRepo(p.path),
      worktrees: worktreesWithSessions,
      sessions: await summarizeSessions(p.path).catch(() => ({ count: 0, lastMtime: 0 })),
    };
  }));
  return enriched;
}

export async function listInstances(_args, { instances }) {
  return instances ? instances.list() : [];
}

export async function listSessions({ project, worktree }) {
  if (worktree) {
    const wt = await getWorktree(project, worktree);
    if (!wt) throw new Error(`worktree '${worktree}' not found under project '${project}'`);
    return listSessionsForCwd(wt.worktreePath);
  }
  return fsListSessions(project);
}

export async function listWorktrees({ project }) {
  return fsListWorktrees(project);
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
  return hit;
}

export async function getTranscript({ id, sinceSeq = -1, limit = 200 }, { instances }) {
  const inst = getInst(instances, id);
  const all = inst.ringSnapshot();
  const filtered = sinceSeq >= 0
    ? all.filter(e => typeof e._seq === 'number' && e._seq > sinceSeq)
    : all;
  const lastSeq = all.length ? all[all.length - 1]._seq : -1;
  const events = limit > 0 ? filtered.slice(-limit) : filtered;
  return {
    id,
    status: inst.status,
    sessionId: inst.sessionId,
    events,
    lastSeq,
    truncated: filtered.length > events.length,
  };
}

// ---------- mutating: instance ----------

export async function spawnInstance(args, { instances }) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  const inst = await instances.create({
    project: args.project,
    mode: args.mode,
    effort: args.effort,
    thinking: args.thinking,
    model: args.model,
    resume: args.resume,
    worktree: args.worktree,
    temp: args.temp,
    debug: args.debug,
  });
  return inst.summary();
}

export async function sendPrompt({ id, text, wait = false, waitTimeoutMs = 600_000 }, { instances }) {
  const inst = getInst(instances, id);
  if (!inst.proc) throw new Error(`instance ${id} is not running (status=${inst.status})`);
  if (wait) {
    // Attach the listener *before* sending so we can't miss a fast turn_end.
    const waiter = waitForEvent(inst, (ev) => ev.kind === 'turn_end', waitTimeoutMs);
    await inst.prompt(text);
    const ev = await waiter;
    return { ok: true, id, sessionId: inst.sessionId, turnEnd: ev };
  }
  await inst.prompt(text);
  return { ok: true, id, sessionId: inst.sessionId, status: inst.status };
}

export async function waitForIdle({ id, timeoutMs = 600_000 }, { instances }) {
  const inst = getInst(instances, id);
  const { status } = await waitForStatus(
    inst,
    (s) => s === 'idle' || s === 'exited' || s === 'crashed',
    timeoutMs,
  );
  return { id, status, summary: inst.summary() };
}

export async function setMode({ id, mode }, { instances }) {
  const inst = getInst(instances, id);
  await inst.setMode(mode);
  return { id, mode: inst.mode };
}

// Register the calling instance to receive a one-shot stub user prompt
// when the target instance next hits turn_end. Caller identity comes
// from the MCP URL's ?caller=<id> query string (baked in at spawn time
// by InstanceManager.mcpServerUrl). The stub names the target and
// points at get_recent_messages so the conductor can inspect the
// result. Re-subscribe after every callback to keep getting pings.
export async function subscribeToIdle({ targetId }, { instances, callerId }) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  if (!callerId) {
    throw new Error(
      'caller identity missing — the MCP URL must include ?caller=<callerInstanceId>. ' +
      'Spawn this instance through the orchestrator so its MCP config carries the caller id.',
    );
  }
  if (typeof targetId !== 'string' || !targetId) {
    throw new Error('targetId required');
  }
  // Existence check before registering, so the error surfaces here
  // rather than as a silent drop at callback time.
  getInst(instances, targetId);
  const res = instances.subscribeIdle(callerId, targetId);
  return { ok: true, callerId, targetId, already: res.already };
}

export async function unsubscribeFromIdle({ targetId }, { instances, callerId }) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  if (!callerId) throw new Error('caller identity missing — MCP URL lacks ?caller=…');
  if (typeof targetId !== 'string' || !targetId) {
    throw new Error('targetId required');
  }
  const res = instances.unsubscribeIdle(callerId, targetId);
  return { ok: true, callerId, targetId, removed: res.removed };
}

export async function interruptTurn({ id }, { instances }) {
  const inst = getInst(instances, id);
  await inst.interrupt();
  return { id, status: inst.status };
}

export async function killInstance({ id }, { instances }) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  await instances.remove(id);
  return { ok: true, id };
}

export async function respawnInstance({ id }, { instances }) {
  if (!instances) throw new Error('orchestrator has no InstanceManager');
  const inst = await instances.respawn(id);
  return inst.summary();
}

// ---------- mutating: plan approval ----------

// Approve a worker's plan: flip the instance to bypassPermissions so it
// can actually act on what was just approved, then send the approval
// prompt as a normal user turn. Mirrors the UI's Approve & Implement
// button (public/app.js onPlanDecision) — phrasing comes from the
// shared planApproval module so the three entry points (UI click,
// server-side auto-approve, MCP) all look identical to the worker.
export async function approvePlan({ instanceId, feedback }, { instances }) {
  const inst = getInst(instances, instanceId);
  if (!inst.proc) throw new Error(`instance ${instanceId} is not running (status=${inst.status})`);
  if (inst.mode === 'plan') {
    try { await inst.setMode('bypassPermissions'); }
    catch (e) {
      throw new Error(`failed to switch instance ${instanceId} to bypassPermissions: ${e.message}`);
    }
  }
  const text = buildApprovePrompt(feedback);
  await inst.prompt(text);
  return { ok: true, id: instanceId, mode: inst.mode, sentText: text };
}

// Reject a worker's plan: stay in plan mode, send the refinement prompt.
// The worker will produce a revised plan; the conductor loops back to
// reviewing get_recent_messages and either approves or rejects again.
export async function rejectPlan({ instanceId, feedback }, { instances }) {
  const inst = getInst(instances, instanceId);
  if (!inst.proc) throw new Error(`instance ${instanceId} is not running (status=${inst.status})`);
  const text = buildRejectPrompt(feedback);
  await inst.prompt(text);
  return { ok: true, id: instanceId, mode: inst.mode, sentText: text };
}

// Flip the per-instance auto-approve-plan flag. While enabled, the next
// plan_request emitted by the worker auto-fires the same setMode +
// approval-prompt path as approvePlan above, server-side, without any
// further intervention. Useful for "fire N workers and let them roll".
export async function setAutoApprovePlan({ instanceId, enabled }, { instances }) {
  const inst = getInst(instances, instanceId);
  inst.setAutoApprovePlan(!!enabled);
  return { ok: true, id: instanceId, autoApprovePlan: inst.autoApprovePlan };
}

// ---------- read-only: worktree diff ----------

// Unified diff of <baseRef>...HEAD in a worktree. baseRef defaults to
// the worktree's recorded baseBranch (the branch it was created from).
// Capped at ~200 KB to keep this cheap to call from an LLM loop;
// `truncated: true` in the result tells the caller to drill in with
// read_file for specific files.
const DIFF_BYTE_CAP = 200 * 1024;
export async function getWorktreeDiff({ project, worktreeName, baseRef, contextLines = 3 }) {
  if (!project || !worktreeName) {
    throw new Error('get_worktree_diff requires {project, worktreeName}');
  }
  const wt = await getWorktree(project, worktreeName);
  if (!wt) throw new Error(`worktree '${worktreeName}' not found under project '${project}'`);
  const ref = (typeof baseRef === 'string' && baseRef.trim()) ? baseRef.trim() : wt.baseBranch;
  const ctx = Number.isInteger(contextLines) && contextLines >= 0 && contextLines <= 50 ? contextLines : 3;
  const r = await runGitInDir(wt.worktreePath, ['diff', `--unified=${ctx}`, `${ref}...HEAD`]);
  if (r.code !== 0) {
    throw new Error(`git diff failed in ${wt.worktreePath}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const full = r.stdout ?? '';
  const sizeBytes = Buffer.byteLength(full, 'utf8');
  const truncated = sizeBytes > DIFF_BYTE_CAP;
  const diff = truncated ? full.slice(0, DIFF_BYTE_CAP) : full;
  return {
    project, worktreeName, baseRef: ref,
    contextLines: ctx,
    diff, sizeBytes, truncated,
  };
}

// ---------- mutating: worktrees ----------

export async function createWorktree({ project }) {
  return fsCreateWorktree(project);
}

export async function deleteWorktree({ project, worktreeName, force = false }, { instances }) {
  if (instances) {
    const running = instances.idsForWorktree(project, worktreeName)
      .map(id => instances.get(id))
      .filter(i => i && i.proc);
    if (running.length > 0 && !force) {
      throw new Error(
        `worktree '${worktreeName}' has ${running.length} running instance(s) — kill them first or pass force=true`,
      );
    }
    if (force) {
      await Promise.all(running.map(i => i.kill({ graceMs: 300 }).catch(() => {})));
    }
  }
  await removeWorktree(project, worktreeName, { force });
  return { ok: true, project, worktreeName };
}

export async function syncWorktree({ instanceId }, { instances }) {
  const inst = getInst(instances, instanceId);
  if (!inst.worktree) throw new Error(`instance ${instanceId} is not attached to a worktree`);
  const result = await fsSyncWorktree(inst.project, inst.worktree.worktreeName);
  if (result.ok && result.action === 'rebase-required') {
    if (!inst.proc) {
      return {
        ok: false,
        reason: 'instance is not running — Resume it before calling sync_worktree so the agent can rebase',
      };
    }
    await inst.prompt(buildRebasePrompt(inst.worktree));
    return {
      ok: true, action: 'rebase-prompt-sent',
      ahead: result.ahead, behind: result.behind,
    };
  }
  return result;
}

export async function mergeWorktree({ instanceId, project, worktreeName }, { instances }) {
  let projectName, wtName, meta;
  if (instanceId) {
    const inst = getInst(instances, instanceId);
    if (!inst.worktree) throw new Error(`instance ${instanceId} is not attached to a worktree`);
    projectName = inst.project;
    wtName = inst.worktree.worktreeName;
    meta = inst.worktree;
  } else {
    if (!project || !worktreeName) {
      throw new Error('merge_worktree requires either instanceId or both {project, worktreeName}');
    }
    projectName = project;
    wtName = worktreeName;
    meta = await getWorktree(projectName, wtName);
    if (!meta) throw new Error(`worktree '${wtName}' not found under project '${projectName}'`);
  }
  const status = await getWorktreeMergeStatus(meta);
  if (status.behind != null && status.behind > 0) {
    return {
      ok: false,
      reason: `worktree is behind '${meta.baseBranch}' by ${status.behind} commit(s) — call sync_worktree first to fast-forward / rebase`,
    };
  }
  return mergeWorktreeIntoParent(projectName, wtName);
}

// ---------- workspaces ----------
// Workspaces are sidebar-organisation primitives — registered names plus
// a `workspace` field per project. The registry persists independently
// of membership so an empty workspace still shows up. These tools mirror
// the REST endpoints in src/routes.js (PUT /projects/:name/workspace,
// POST/PUT/DELETE /workspaces, GET /workspaces) so a conductor can set
// up its own organisation alongside the human.

export async function listWorkspaces() {
  const registered = await fsListWorkspaces();
  const projects = await fsListProjects();
  const counts = new Map();
  const derived = new Set();
  for (const p of projects) {
    if (p.workspace) {
      derived.add(p.workspace);
      counts.set(p.workspace, (counts.get(p.workspace) ?? 0) + 1);
    }
  }
  const names = [...new Set([...registered, ...derived])].sort((a, b) => a.localeCompare(b));
  return names.map(name => ({ name, projectCount: counts.get(name) ?? 0 }));
}

export async function createWorkspace({ name }) {
  const result = await fsAddWorkspace(name);
  return { ok: true, ...result };
}

export async function deleteWorkspace({ name }) {
  const result = await fsRemoveWorkspace(name);
  return { ok: true, ...result };
}

export async function renameWorkspace({ oldName, newName }) {
  const result = await fsRenameWorkspace(oldName, newName);
  return { ok: true, ...result };
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
  return { ok: true, project, workspace: meta.workspace ?? null };
}

// ---------- create / introspect ----------

export async function createProject({ name, gitInit = false }) {
  const created = await fsCreateProject(name);
  if (gitInit) {
    const r = await runGitInDir(created.path, ['init', '-q']);
    if (r.code !== 0) {
      throw new Error(`git init failed in ${created.path}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }
  return { ...created, gitInit: !!gitInit };
}

// Walk the event ring backward, find the most recent N assistant messages,
// and return each as joined text (concatenation of all text blocks in that
// msgId, in stream order) plus structured blocks. Useful when a coordinating
// agent just wants to read what the spawned agent said without parsing the
// raw event stream. `count` defaults to 1 (last message only); clamped to
// [1, 50]. Returns `{ id, messages }` — oldest-first.
export async function getRecentMessages({ id, count, includeToolCalls = false, includeThinking = false }, { instances }) {
  const inst = getInst(instances, id);
  const ring = inst.ringSnapshot();
  const n = Math.max(1, Math.min(Number.isInteger(count) ? count : 1, 50));
  // Collect all distinct msgIds from the ring, walking backward.
  // No early stop — filtering happens after building messages.
  const seen = new Set();
  const reverseIds = [];
  for (let i = ring.length - 1; i >= 0; i--) {
    const ev = ring[i];
    if (ev.parentToolUseId) continue; // ignore sub-agent content
    if (!ev.msgId) continue;
    if (ev.kind !== 'text_delta' && ev.kind !== 'text_end'
        && ev.kind !== 'assistant_message' && ev.kind !== 'tool_use') continue;
    if (seen.has(ev.msgId)) continue;
    seen.add(ev.msgId);
    reverseIds.push(ev.msgId);
  }
  const orderedIds = reverseIds.reverse();
  const allMessages = orderedIds.map(msgId => buildMessageFromRing(ring, msgId, includeThinking));
  // By default, exclude tool-call-only messages (no text content).
  const filtered = includeToolCalls
    ? allMessages
    : allMessages.filter(m => m.text.length > 0);
  const messages = filtered.slice(-n);
  return { id, messages };
}

function buildMessageFromRing(ring, targetMsgId, includeThinking = false) {
  const byBlock = new Map();
  const blockOrder = [];
  const otherBlocks = []; // tool_use blocks etc, for context
  let hasToolUse = false;
  let assistantMessage = null;
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
      otherBlocks.push({ type: 'tool_use', name: ev.name, input: ev.input, toolUseId: ev.toolUseId });
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
        blocks.push({ type: 'tool_use', name: block.name, input: block.input, toolUseId: block.id });
      } else if (block?.type === 'thinking' && includeThinking) {
        blocks.push({ type: 'thinking', text: block.thinking ?? '' });
      }
    }
    return { msgId: targetMsgId, text: textParts.join(''), ...(blocks.length ? { blocks } : {}), hasToolUse };
  }
  const text = blockOrder.map(idx => byBlock.get(idx)).join('');
  return { msgId: targetMsgId, text, ...(otherBlocks.length ? { blocks: otherBlocks } : {}), hasToolUse };
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

// Run `git` with the standard execFile wrapper, never throwing — always
// returns {stdout, stderr, code}. Mirrors src/worktrees.js's runGit.
function runGitInDir(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? err.message ?? '', code: typeof err.code === 'number' ? err.code : 1 });
      } else {
        resolve({ stdout, stderr, code: 0 });
      }
    });
  });
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
  const branchR = await runGitInDir(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  out.branch = branchR.code === 0 ? branchR.stdout.trim() || null : null;
  // HEAD sha + subject.
  const headR = await runGitInDir(cwd, ['log', '-1', '--pretty=%H%n%s']);
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
    const d = await runGitInDir(cwd, ['status', '--porcelain']);
    out.dirty = d.code === 0
      ? d.stdout.split('\n').map(s => s.trim()).filter(Boolean)
      : [];
  }
  // Recent commits (oneline). Negative or 0 logLimit → skip.
  if (Number.isInteger(logLimit) && logLimit > 0) {
    const logR = await runGitInDir(cwd, ['log', `-${logLimit}`, '--pretty=%h %s']);
    out.recentCommits = logR.code === 0
      ? logR.stdout.split('\n').map(s => s.trim()).filter(Boolean)
      : [];
  }
  // Worktree-only: mergeStatus + diff stat vs base.
  if (worktreeMeta) {
    out.baseBranch = worktreeMeta.baseBranch;
    out.baseSha = worktreeMeta.baseSha;
    out.mergeStatus = await getWorktreeMergeStatus(worktreeMeta).catch(() => ({ ahead: null, behind: null }));
    const diffR = await runGitInDir(cwd, ['diff', '--stat', `${worktreeMeta.baseBranch}...HEAD`]);
    out.diffStat = diffR.code === 0 ? diffR.stdout.trim() : '';
  }
  return out;
}

// Path-traversal-guarded file read. Path is project-relative; absolute
// paths or `..` segments that escape the project / worktree root are
// rejected. Caps at maxBytes (default 256 KB) so this stays cheap to
// call from an LLM loop. Returns text content; binary files are
// reported as base64.
export async function readFile({ project, worktree, relativePath, maxBytes = 256 * 1024 }) {
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
  const fh = await fs.open(resolved, 'r');
  try {
    const len = Math.min(stat.size, cap);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const truncated = stat.size > cap;
    // Best-effort text detection: probe for NULs in the first 4 KB.
    const probe = buf.slice(0, Math.min(4096, buf.length));
    const isBinary = probe.includes(0);
    if (isBinary) {
      return {
        path: relativePath, size: stat.size, truncated, encoding: 'base64',
        content: buf.toString('base64'),
      };
    }
    return {
      path: relativePath, size: stat.size, truncated, encoding: 'utf8',
      content: buf.toString('utf8'),
    };
  } finally {
    await fh.close();
  }
}
