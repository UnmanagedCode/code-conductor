// User-triggered session / project / worktree mutations, shared by the
// sidebar, the session header, the conversation and the commit-history view.
import { apiFetch } from '@/lib/core/http.js';
import { closeActionOf, stopNeedsConfirm } from '@/lib/core/closeAction.js';
import { appStore } from '@/state/app';
import type { Instance, Project } from '@/state/types';
import { confirmDialog, toast } from '@/ui/feedback';
import { refreshInstances, refreshProjects, selectInstance, subscribe } from './controller';
import { emit } from './events';
import { beginGesture, gestureOvertaken } from './gestures';

const instances = () => appStore.get().instances;
const activeId = () => appStore.get().activeId;
const clearActive = () => appStore.set({ activeId: null });

export async function promoteSession({ projectName, instanceId, preview }: { projectName: string; instanceId: string; preview?: string | null }) {
  if (!instanceId) return;
  const isConductor = projectName === '.conduct';
  const ok = await confirmDialog({
    title: isConductor ? 'Make this conductor persistent?' : `Keep this session in ${projectName}?`,
    description: `${preview || '(no preview yet)'}\n\n${isConductor
      ? 'It will move to Inactive instead of being archived when it stops.'
      : 'The transcript will be kept when the session stops.'}`,
    confirmLabel: 'Make persistent',
  });
  if (!ok) return;
  try {
    await apiFetch(`/api/instances/${encodeURIComponent(instanceId)}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    await refreshInstances();
  } catch (e: any) {
    toast.error('Could not make the session persistent', e.message);
  }
}

export function loadSessions(projectName: string, worktreeName?: string | null) {
  const url = worktreeName
    ? `/api/projects/${encodeURIComponent(projectName)}/worktrees/${encodeURIComponent(worktreeName)}/sessions`
    : `/api/projects/${encodeURIComponent(projectName)}/sessions`;
  return apiFetch(url);
}

export async function resumeSession({
  projectName, worktreeName, sessionId, silent = false, userGesture = !silent, gesture,
}: { projectName: string; worktreeName?: string | null; sessionId: string; silent?: boolean; userGesture?: boolean; gesture?: number }) {
  // An automatic resume (a URL anchor) never takes over a session selected while it ran. A user's
  // (`gesture`: the token of the click that started it, else its own) yields only to a newer gesture's.
  const selected = activeId();
  const token = userGesture ? gesture ?? beginGesture() : undefined;
  const wanted = () => (token === undefined ? activeId() === selected : !gestureOvertaken(token));
  try {
    const r = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: projectName, resume: sessionId, worktree: worktreeName || undefined }),
    });
    if (!r.ok) {
      if (silent) {
        // A concurrent resume (e.g. the server's restart restore) may already own it.
        await refreshInstances();
        const live = instances().find((i) => i.sessionId === sessionId);
        if (live && wanted()) selectInstance(live.id, { userGesture, gesture: token });
        return;
      }
      throw new Error((await r.json()).error);
    }
    const inst = await r.json();
    await refreshProjects();
    await refreshInstances();
    if (wanted()) selectInstance(inst.id, { userGesture, gesture: token });
  } catch (e: any) {
    if (silent) { console.warn('anchor auto-resume failed', e); return; }
    toast.error('Resume failed', e.message);
  }
}

export async function rewindActiveSession(userMessageIndex: number, text: string) {
  const id = activeId();
  if (!id) return;
  const ok = await confirmDialog({
    title: 'Rewind to here?',
    description: 'Everything after this message is discarded. The composer is prefilled with this prompt so you can edit and resend it.',
    confirmLabel: 'Rewind',
    destructive: true,
  });
  if (!ok) return;
  try {
    await apiFetch(`/api/instances/${encodeURIComponent(id)}/rewind`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userMessageIndex, text }),
    });
  } catch (e: any) {
    toast.error('Rewind failed', e.message);
  }
}

export async function forkActiveSession(userMessageIndex: number, text: string) {
  const id = activeId();
  if (!id) return;
  const ok = await confirmDialog({
    title: 'Fork from here?',
    description: 'A new session starts from the conversation up to this message. The original is left intact, and the composer is prefilled with this prompt.',
    confirmLabel: 'Fork',
  });
  if (!ok) return;
  const gesture = beginGesture();
  try {
    const { instance } = await apiFetch(`/api/instances/${encodeURIComponent(id)}/fork`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userMessageIndex, text }),
    });
    await refreshProjects();
    await refreshInstances();
    if (!gestureOvertaken(gesture)) selectInstance(instance.id, { userGesture: true, gesture });
  } catch (e: any) {
    toast.error('Fork failed', e.message);
  }
}

/** Deregister a project (and optionally delete its tree). The dialog lives in features/dialogs. */
export async function performProjectDelete({ name, deleteDirectory }: { name: string; deleteDirectory: boolean }) {
  const insts = instances().filter((i) => i.project === name);
  await apiFetch(`/api/projects/${encodeURIComponent(name)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deleteDirectory }),
  });
  if (activeId() && insts.some((i) => i.id === activeId())) clearActive();
  await refreshProjects();
  await refreshInstances();
}

function sessionLabel(preview: string | null | undefined, sessionId: string) {
  return preview && preview !== '(new session)' && preview !== `${sessionId.slice(0, 8)}…` ? `“${preview}”` : `${sessionId.slice(0, 8)}…`;
}

export type CloseArgs = {
  projectName: string;
  worktreeName?: string | null;
  instanceId?: string | null;
  sessionId: string;
  preview?: string | null;
  status?: string | null;
  synthetic?: boolean;
  temp?: boolean;
};

/** A session's ×: one step down from where it is (closeAction.js decides stop vs archive). */
export function closeSession(args: CloseArgs) {
  return closeActionOf({ instanceId: args.instanceId ?? null, status: args.status ?? null, temp: !!args.temp }) === 'stop' ? stopSession(args) : archiveSession(args);
}

export async function stopSession({ projectName, worktreeName, instanceId, preview, sessionId, status }: CloseArgs) {
  if (!instanceId) return;
  if (stopNeedsConfirm(status) && !(await confirmDialog({
    title: `Stop session ${sessionLabel(preview, sessionId)}?`,
    description: 'It is still working, and the running work will be killed. The transcript is kept and the session stays resumable.',
    confirmLabel: 'Stop session',
    destructive: true,
  }))) return;
  try {
    await apiFetch(`/api/instances/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
    if (activeId() === instanceId) clearActive();
    emit('sessionsStale', { project: projectName, worktree: worktreeName ?? null });
    await refreshProjects();
    await refreshInstances();
  } catch (e: any) {
    toast.error('Could not stop the session', e.message);
  }
}

export async function archiveSession({ projectName, worktreeName, sessionId, preview, synthetic }: CloseArgs) {
  const ok = await confirmDialog({
    title: `Archive session ${sessionLabel(preview, sessionId)}?`,
    description: 'It moves to Settings → Archived. The transcript is kept and the session stays resumable.',
    confirmLabel: 'Archive',
  });
  if (!ok) return;
  if (synthetic) {
    try {
      const inst = instances().find((i) => i.sessionId === sessionId);
      if (inst) await fetch(`/api/instances/${encodeURIComponent(inst.id)}`, { method: 'DELETE' });
      if (inst && activeId() === inst.id) clearActive();
      emit('sessionsStale', { project: projectName, worktree: worktreeName ?? null });
      await refreshProjects();
      await refreshInstances();
    } catch (e: any) {
      toast.error('Could not archive the session', e.message);
    }
    return;
  }
  const base = worktreeName
    ? `/api/projects/${encodeURIComponent(projectName)}/worktrees/${encodeURIComponent(worktreeName)}/sessions/${encodeURIComponent(sessionId)}/archive`
    : `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionId)}/archive`;
  try {
    let r = await fetch(base, { method: 'POST' });
    if (r.status === 409) r = await fetch(`${base}?force=1`, { method: 'POST' });
    if (!r.ok) {
      let msg: string;
      try { msg = (await r.json()).error; } catch { msg = `HTTP ${r.status}`; }
      throw new Error(msg);
    }
    const inst = instances().find((i) => i.sessionId === sessionId);
    if (inst && activeId() === inst.id) clearActive();
    emit('sessionsStale', { project: projectName, worktree: worktreeName ?? null });
    await refreshProjects();
    await refreshInstances();
  } catch (e: any) {
    toast.error('Could not archive the session', e.message);
  }
}

export async function removeWorktree(project: string, worktreeName: string) {
  const ok = await confirmDialog({
    title: `Remove worktree ${worktreeName}?`,
    description: 'This deletes the worktree directory and its branch.',
    confirmLabel: 'Remove worktree',
    destructive: true,
  });
  if (!ok) return;
  const url = `/api/projects/${encodeURIComponent(project)}/worktrees/${encodeURIComponent(worktreeName)}`;
  try {
    let r = await fetch(url, { method: 'DELETE' });
    if (r.status === 409) {
      const { error } = await r.json();
      if (!(await confirmDialog({ title: 'Force remove?', description: error, confirmLabel: 'Force remove', destructive: true }))) return;
      r = await fetch(`${url}?force=1`, { method: 'DELETE' });
    }
    if (!r.ok) throw new Error((await r.json()).error);
    await refreshProjects();
    await refreshInstances();
  } catch (e: any) {
    toast.error('Could not remove the worktree', e.message);
  }
}

export async function applySessionTitle(sessionId: string, title: string): Promise<string | null> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim().slice(0, 100) }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  const result = await r.json();
  const list = instances().map((i) => (i.sessionId === sessionId ? { ...i, title: result.title ?? null } : i));
  appStore.set({ instances: list });
  await refreshProjects();
  return result.title ?? null;
}

export type WorktreeTarget = { project: string; worktree: string };

function worktreeSession({ project, worktree }: WorktreeTarget): Instance | undefined {
  const mine = instances().filter((i) => i.project === project && (i.worktree as any)?.worktreeName === worktree);
  const live = mine.filter((i) => i.status !== 'crashed' && i.status !== 'exited');
  return live.find((i) => i.id === activeId()) ?? live[0] ?? mine.find((i) => i.id === activeId()) ?? mine[0];
}

async function refreshProjectsAfterOp() {
  try { await refreshProjects(); } catch (e) { console.warn('refreshProjects after worktree op failed:', e); }
}

export async function syncWorktree(target?: WorktreeTarget | null) {
  const id = activeId();
  if (!target && !id) return null;
  const url = target
    ? `/api/projects/${encodeURIComponent(target.project)}/worktrees/${encodeURIComponent(target.worktree)}/sync`
    : `/api/instances/${id}/sync`;
  try {
    const result = await apiFetch(url, { method: 'POST' });
    if (!result.ok) {
      toast.error('Cannot sync', result.reason);
      return result;
    }
    if (result.action === 'already-in-sync') toast.info('Already up to date', 'The worktree matches its parent branch.');
    else if (result.action === 'fast-forwarded') toast.success('Worktree synced', `Now at ${result.newSha?.slice(0, 12) ?? '?'}.`);
    else if (result.action === 'rebased') toast.success('Worktree rebased', `Rebased onto ${result.newSha?.slice(0, 12) ?? '?'}. Merge it from the worktree's commit history when ready.`);
    await refreshProjectsAfterOp();
    if (result.action === 'commit-required' || result.action === 'rebase-conflict') {
      await offerRebasePrompt(target ? worktreeSession(target) : instances().find((i) => i.id === id), result);
    }
    return result;
  } catch (e: any) {
    toast.error('Sync failed', e.message);
    return null;
  }
}

async function offerRebasePrompt(inst: Instance | undefined, result: any) {
  const what = result.action === 'commit-required'
    ? `has uncommitted changes and is ${result.behind} commit(s) behind ${result.baseBranch}`
    : `conflicts with ${result.baseBranch}. The automatic rebase was aborted, so nothing changed`;
  if (!inst || inst.status === 'crashed' || inst.status === 'exited') {
    toast.warning('Worktree needs a rebase', `This worktree ${what}. No agent is running here: resume the session (or rebase ${result.branch} yourself), then sync again.`);
    return;
  }
  const who = inst.title || `session ${(inst.sessionId || inst.id).slice(0, 8)}`;
  const ok = await confirmDialog({
    title: 'Ask the agent to rebase?',
    description: `This worktree ${what}.\n\nSending the rebase prompt to ${who} starts a turn in that session. Watch the conversation for REBASE_DONE, then merge from the worktree's commit history.`,
    confirmLabel: 'Send rebase prompt',
  });
  if (!ok) return;
  try {
    const sent = await apiFetch(`/api/instances/${inst.id}/rebase-prompt`, { method: 'POST' });
    if (!sent.ok) toast.error('Cannot ask the agent to rebase', sent.reason);
    else toast.success('Rebase prompt sent', 'Watch the conversation for REBASE_DONE, then merge from the commit history.');
  } catch (e: any) {
    toast.error('Rebase prompt failed', e.message);
  }
}

export async function mergeWorktree(target: WorktreeTarget) {
  const ok = await confirmDialog({
    title: 'Merge into the parent branch?',
    description: "This worktree's branch is merged into the parent with a merge commit.",
    confirmLabel: 'Merge',
  });
  if (!ok) return null;
  try {
    const result = await apiFetch(`/api/projects/${encodeURIComponent(target.project)}/worktrees/${encodeURIComponent(target.worktree)}/merge`, { method: 'POST' });
    if (result.ok) {
      toast.success('Merged into parent', `Now at ${result.newSha?.slice(0, 12) ?? '?'}.`);
      await refreshProjectsAfterOp();
    } else {
      toast.error('Cannot merge', result.reason);
    }
    return result;
  } catch (e: any) {
    toast.error('Merge failed', e.message);
    return null;
  }
}

export async function setWorktreeLock(target: WorktreeTarget, locked: boolean) {
  try {
    const result = await apiFetch(`/api/projects/${encodeURIComponent(target.project)}/worktrees/${encodeURIComponent(target.worktree)}/lock`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locked }),
    });
    if (result.ok) await refreshProjectsAfterOp();
    else toast.error('Cannot change the lock', result.reason);
    return result;
  } catch (e: any) {
    toast.error('Lock failed', e.message);
    return null;
  }
}

export async function respawnActive() {
  const id = activeId();
  if (!id) return;
  try {
    await apiFetch(`/api/instances/${id}/respawn`, { method: 'POST' });
    await refreshInstances();
    const active = activeId();
    if (active) subscribe(active);
  } catch (e: any) {
    toast.error('Resume failed', e.message);
  }
}

export type { Project };
