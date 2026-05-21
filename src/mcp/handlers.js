// MCP tool handlers. Thin shells over the orchestrator's existing modules
// (InstanceManager, projects.js, worktrees.js) — never duplicate business
// logic, never self-HTTP. Each handler receives (args, { instances }).

import {
  listProjects as fsListProjects,
  listSessions as fsListSessions,
  listSessionsForCwd,
  summarizeSessions,
  getProject,
} from '../projects.js';
import {
  isGitRepo, listWorktrees as fsListWorktrees, getWorktreeMergeStatus,
  createWorktree as fsCreateWorktree, removeWorktree, getWorktree,
  syncWorktree as fsSyncWorktree, mergeWorktreeIntoParent, buildRebasePrompt,
} from '../worktrees.js';

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

export async function waitForIdle({ id, timeoutMs = 120_000 }, { instances }) {
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

export async function mergeWorktree({ instanceId }, { instances }) {
  const inst = getInst(instances, instanceId);
  if (!inst.worktree) throw new Error(`instance ${instanceId} is not attached to a worktree`);
  const status = await getWorktreeMergeStatus(inst.worktree);
  if (status.behind != null && status.behind > 0) {
    return {
      ok: false,
      reason: `worktree is behind '${inst.worktree.baseBranch}' by ${status.behind} commit(s) — call sync_worktree first to fast-forward / rebase`,
    };
  }
  return mergeWorktreeIntoParent(inst.project, inst.worktree.worktreeName);
}
