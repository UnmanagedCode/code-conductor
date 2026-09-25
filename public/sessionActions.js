// Per-session / per-project ACTION helpers, extracted from app.js. Follows the
// installX({...}) pattern.
//
// These are the user-triggered mutations wired into the sidebar (promote /
// resume / load-sessions / delete-session / delete-project / remove-worktree)
// and the header/conversation action buttons (rewind / fork). app.js stays the
// orchestrator: it holds the returned handles in a `sessionActions` holder and
// forwards every call site through it (the Sidebar and conversationOptions are
// constructed BEFORE this install runs, so they use the holder + lazy-arrow
// pattern — see app.js).
//
// Composer prefill: fork and rewind share ONE inline mechanism — the dropped
// prompt rides `droppedText` on a WS frame (fork: the new instance's first
// `snapshot`; rewind: `reset_snapshot`), consumed once server-side. Neither
// action stashes any client-side prefill state here; the wsRouter handlers do
// the composer.prefill() off the frame. These helpers just fire the HTTP
// mutation and switch focus.
//
// Injected interface:
//   - getActiveId()/setActiveId(v): read + (delete cascades) null the active id.
//   - getInstances():              the live instance list (state.instances).
//   - refreshProjects()/refreshInstances()/selectInstance(id): post-action
//                                  refresh + selection (drive app.js state/sidebar).
//   - sidebar:                     for sidebar.sessionsCache eviction in deleteSession.
//   - clearUnread(sessionId):      drop the unread badge for an archived session.
//   - headerUpdate():              repaint the header after an optimistic local
//                                  mirror (applySessionTitle). Lazy — the header
//                                  handle is assigned after this install runs.
//   - deleteProjectDom:            the delete-project dialog's elements. This
//                                  module installs that dialog and keeps the
//                                  HTTP call, so app.js wires one thing.
//
// Returns the action handles.

import { apiFetch } from './http.js';
import { send } from './ws.js';
import { installDeleteProjectDialog } from './deleteProjectDialog.js';

export function installSessionActions({
  getActiveId, setActiveId, getInstances,
  refreshProjects, refreshInstances, selectInstance,
  sidebar, clearUnread, headerUpdate, deleteProjectDom,
}) {
  // Promote a live temp session into a regular one. The server flips the
  // temp flag, writes the resume-picker metadata, and broadcasts the
  // status change — the sidebar's `instances` re-fetch then migrates the
  // row from the Temp Sessions subnode into the regular Sessions list.
  async function promoteSession({ projectName, instanceId, preview }) {
    if (!instanceId) return;
    const ok = confirm(
      `Promote this temp session to a normal session in '${projectName}'?\n\n` +
      `${preview || '(no preview yet)'}\n\n` +
      `The transcript will be preserved when the session ends.`,
    );
    if (!ok) return;
    try {
      await apiFetch(`/api/instances/${encodeURIComponent(instanceId)}/promote`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
      });
      await refreshInstances();
    } catch (e) {
      alert(`Failed to promote: ${e.message}`);
    }
  }

  // Fetches sessions for a project (or for a specific worktree under it).
  // Called by the sidebar when the user expands the "Sessions" subnode.
  async function loadSessions(projectName, worktreeName) {
    const url = worktreeName
      ? `/api/projects/${encodeURIComponent(projectName)}/worktrees/${encodeURIComponent(worktreeName)}/sessions`
      : `/api/projects/${encodeURIComponent(projectName)}/sessions`;
    return apiFetch(url);
  }

  // One-click resume from the sidebar. We POST with worktree carried
  // through (so resuming a worktree session lands in the same worktree
  // cwd) and use orchestrator defaults for mode/effort/thinking. Naming no
  // mode means the resume inherits the one the session was recorded in, or
  // `code` (bypassPermissions) when it has no record — fresh spawns default
  // to plan, but a resume is usually continuing real work. Switch via the
  // header Code/Plan switch if needed.
  // `silent` is used by the anchor auto-resume: a concurrent resume (the
  // server's manifest restore, or a manual stop+resume) may already own this
  // session, so the POST can 409 ("already attached") even though the session
  // IS coming up. Rather than alert, re-sync and select whatever instance now
  // owns the sessionId; only clear focus if it truly didn't come up.
  async function resumeSession({ projectName, worktreeName, sessionId, silent = false }) {
    try {
      const r = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: projectName,
          resume: sessionId,
          worktree: worktreeName || undefined,
        }),
      });
      if (!r.ok) {
        if (silent) {
          // Someone else is/just resumed it — find and select that instance.
          await refreshInstances();
          const live = getInstances().find(i => i.sessionId === sessionId);
          if (live) selectInstance(live.id);
          return;
        }
        throw new Error((await r.json()).error);
      }
      const inst = await r.json();
      await refreshProjects();
      await refreshInstances();
      selectInstance(inst.id);
    } catch (e) {
      if (silent) { console.warn('anchor auto-resume failed', e); return; }
      alert(`resume failed: ${e.message}`);
    }
  }

  // Rewind the active instance's session to before the Nth user prompt. The
  // orchestrator kills the subprocess, truncates the jsonl, broadcasts a
  // `reset_snapshot` (handled in app.js) so this view clears, and respawns
  // against the truncated history. We prefill the composer with the
  // dropped prompt so the user can edit and re-send.
  async function rewindActiveSession(userMessageIndex) {
    const id = getActiveId();
    if (!id) return;
    if (!confirm('Rewind to here? Everything after this message will be discarded; the composer will be prefilled with this prompt so you can edit and resend.')) return;
    try {
      // Prefill rides on the `reset_snapshot` WS frame (carries droppedText
      // directly) so there's no race between this HTTP response and the
      // server-side emit, and the returned body is deliberately unused —
      // apiFetch drains it, which is what releases the connection.
      await apiFetch(`/api/instances/${encodeURIComponent(id)}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userMessageIndex }),
      });
    } catch (e) {
      alert(`rewind failed: ${e.message}`);
    }
  }

  // Fork the active instance's session: copy the prefix into a new
  // sessionId, spawn a new instance against it, and switch focus to it.
  // The composer prefill (the dropped prompt) rides the new instance's
  // first `snapshot` WS frame as `droppedText` — no client-side handshake;
  // the wsRouter snapshot handler applies it.
  async function forkActiveSession(userMessageIndex) {
    const id = getActiveId();
    if (!id) return;
    if (!confirm('Fork from here? A new session is created from the prefix; the original session is left intact and the composer is prefilled with this prompt.')) return;
    try {
      const { instance: newInst } = await apiFetch(`/api/instances/${encodeURIComponent(id)}/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userMessageIndex }),
      });
      await refreshProjects();
      await refreshInstances();
      selectInstance(newInst.id);
    } catch (e) {
      alert(`fork failed: ${e.message}`);
    }
  }

  // The sidebar delete action DEREGISTERS the project: its record goes, its
  // tree stays unless the user ticks the opt-in in the dialog. The confirm
  // lives in public/deleteProjectDialog.js — it needs a checkbox, which
  // `window.prompt` cannot hold. The HTTP call and the active-instance
  // bookkeeping stay here; the dialog owns only the wording and the tick.
  function deleteProject(project) {
    const insts = getInstances().filter(i => i.project === project.name);
    // Installed on first use, not at install time: the dialog reads its
    // elements out of the document, and most of this module's callers never
    // reach the delete path.
    deleteProjectDialog ??= installDeleteProjectDialog({
      dom: deleteProjectDom, deleteProject: performProjectDelete,
    });
    deleteProjectDialog.open(project, { instanceCount: insts.length });
  }

  // Handed to the dialog: resolves on success and THROWS on failure, so the
  // dialog reopens with the server's reason inline. A worktree that is dirty,
  // dirty-unknown or depended-on refuses the whole delete, and that refusal is
  // the one the user has to read.
  async function performProjectDelete({ name, deleteDirectory }) {
    const insts = getInstances().filter(i => i.project === name);
    await apiFetch(`/api/projects/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deleteDirectory }),
    });
    if (getActiveId() && insts.some(i => i.id === getActiveId())) {
      setActiveId(null);
    }
    await refreshProjects();
    await refreshInstances();
  }

  let deleteProjectDialog = null;

  // The sidebar × action archives a session (keeps its transcript) rather
  // than deleting it — it moves to Settings → Archived, where it can be
  // restored or permanently deleted. Sessions are never deleted from here.
  async function deleteSession({ projectName, worktreeName, sessionId, preview, synthetic }) {
    const label = preview && preview !== '(new session)' && preview !== `${sessionId.slice(0, 8)}…`
      ? `"${preview}"`
      : sessionId.slice(0, 8) + '…';
    if (!confirm(`Archive session ${label}?\nIt moves to Settings → Archived (transcript kept, still resumable).`)) return;

    // Synthetic sessions have no persisted .jsonl yet — the archive endpoint
    // would return 404. Just kill the running instance (if any) and clean up.
    if (synthetic) {
      try {
        const inst = getInstances().find(i => i.sessionId === sessionId);
        if (inst) await fetch(`/api/instances/${encodeURIComponent(inst.id)}`, { method: 'DELETE' });
        if (inst && getActiveId() === inst.id) setActiveId(null);
        if (sidebar.sessionsCache) {
          const key = worktreeName ? `${projectName}:${worktreeName}` : projectName;
          sidebar.sessionsCache.delete(key);
        }
        clearUnread(sessionId);
        await refreshProjects();
        await refreshInstances();
      } catch (e) {
        alert(`archive session failed: ${e.message}`);
      }
      return;
    }

    const base = worktreeName
      ? `/api/projects/${encodeURIComponent(projectName)}/worktrees/${encodeURIComponent(worktreeName)}/sessions/${encodeURIComponent(sessionId)}/archive`
      : `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionId)}/archive`;
    try {
      let r = await fetch(base, { method: 'POST' });
      if (r.status === 409) {
        // Session is attached to a live instance; the user already confirmed
        // the archive, so stop the instance and retry without a second prompt.
        r = await fetch(`${base}?force=1`, { method: 'POST' });
      }
      if (!r.ok) {
        let errMsg;
        try { errMsg = (await r.json()).error; } catch { errMsg = `HTTP ${r.status}`; }
        throw new Error(errMsg);
      }
      // If we were focused on this session's instance, drop the focus.
      const inst = getInstances().find(i => i.sessionId === sessionId);
      if (inst && getActiveId() === inst.id) setActiveId(null);
      // Drop any cached sessions for the affected scope so the
      // subnode re-fetches on next render (archived rows are hidden).
      if (sidebar.sessionsCache) {
        const key = worktreeName ? `${projectName}:${worktreeName}` : projectName;
        sidebar.sessionsCache.delete(key);
      }
      // Don't keep an unread entry for a session that's left the sidebar.
      clearUnread(sessionId);
      await refreshProjects();
      await refreshInstances();
    } catch (e) {
      alert(`archive session failed: ${e.message}`);
    }
  }

  async function removeWorktree(project, worktreeName) {
    if (!confirm(`Remove worktree '${worktreeName}'?\nThis will delete the directory and branch.`)) return;
    try {
      let r = await fetch(`/api/projects/${encodeURIComponent(project)}/worktrees/${encodeURIComponent(worktreeName)}`, { method: 'DELETE' });
      if (r.status === 409) {
        // Either a running instance or uncommitted changes — offer force.
        const { error } = await r.json();
        if (!confirm(`${error}\n\nForce remove anyway?`)) return;
        r = await fetch(`/api/projects/${encodeURIComponent(project)}/worktrees/${encodeURIComponent(worktreeName)}?force=1`, { method: 'DELETE' });
      }
      if (!r.ok) throw new Error((await r.json()).error);
      await refreshProjects();
      await refreshInstances();
    } catch (e) {
      alert(`remove worktree failed: ${e.message}`);
    }
  }

  // PUT a session title and mirror it locally. Shared by ⋮ Rename and the
  // summary dialog's "Use as session title" button.
  //
  // Bare fetch, not apiFetch: the error path reads `error` off a non-ok body,
  // which apiFetch throws before exposing. Card 2026-0170 owns this family.
  async function applySessionTitle(sessionId, title) {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim().slice(0, 100) }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    const result = await r.json();
    // Optimistic local mirror — the broadcast `status` frame will reassert.
    const inst = getInstances().find(i => i.sessionId === sessionId);
    if (inst) inst.title = result.title ?? null;
    headerUpdate();
    await refreshProjects();
    return result.title ?? null;
  }

  // Sync only measures + lands what git can do alone. Dispatching the rebase is a
  // separate, confirmed call, because it starts a turn in someone's session.
  async function syncWorktree() {
    const id = getActiveId();
    if (!id) return;
    try {
      const result = await apiFetch(`/api/instances/${id}/sync`, { method: 'POST' });
      if (!result.ok) { alert(`Cannot sync:\n${result.reason}`); return; }
      if (result.action === 'already-in-sync') {
        alert('Worktree is already up to date with its parent branch.');
      } else if (result.action === 'fast-forwarded') {
        alert(`Synced worktree → ${result.newSha?.slice(0, 12) ?? '?'}`);
      } else if (result.action === 'rebased') {
        alert(`Worktree auto-rebased onto ${result.newSha?.slice(0, 12) ?? '?'} — click Merge when ready.`);
      }
      await refreshProjects();
      if (result.action === 'commit-required' || result.action === 'rebase-conflict') {
        await offerRebasePrompt(id, result);
      }
    } catch (e) { alert(`sync failed: ${e.message}`); }
  }

  // git can't land this one. Name the session that would be asked to do it and get
  // consent before starting a turn in it; with no live session there is nobody to
  // ask, and the worktree still needs rebasing — say so instead of failing silently.
  async function offerRebasePrompt(id, result) {
    const inst = getInstances().find(i => i.id === id);
    const what = result.action === 'commit-required'
      ? `has uncommitted changes and is ${result.behind} commit(s) behind ${result.baseBranch}`
      : `conflicts with ${result.baseBranch} — the automatic rebase was aborted, so nothing changed`;
    if (!inst || inst.status === 'crashed' || inst.status === 'exited') {
      alert(`This worktree ${what}.\n\nNo agent is running here to rebase it — Resume the session ` +
            `(or rebase ${result.branch} yourself), then click Sync again.`);
      return;
    }
    const who = inst.title || `session ${(inst.sessionId || inst.id).slice(0, 8)}`;
    if (!confirm(`This worktree ${what}.\n\nSend the rebase prompt to ${who}? That starts a turn in ` +
                 `this session — watch the conversation for REBASE_DONE, then click Merge.`)) return;
    try {
      const sent = await apiFetch(`/api/instances/${id}/rebase-prompt`, { method: 'POST' });
      if (!sent.ok) { alert(`Cannot ask the agent to rebase:\n${sent.reason}`); return; }
      alert('Rebase prompt sent — watch the conversation for REBASE_DONE, then click Merge.');
    } catch (e) { alert(`rebase prompt failed: ${e.message}`); }
  }

  async function mergeWorktree() {
    const id = getActiveId();
    if (!id) return;
    if (!confirm('Merge this worktree\'s branch into the parent? A merge commit will be created on the parent.')) return;
    try {
      const result = await apiFetch(`/api/instances/${id}/merge`, { method: 'POST' });
      if (result.ok) {
        alert(`Merged into parent → ${result.newSha?.slice(0, 12) ?? '?'}`);
        await refreshProjects();
      } else {
        alert(`Cannot merge:\n${result.reason}`);
      }
    } catch (e) { alert(`merge failed: ${e.message}`); }
  }

  // Respawn a crashed/exited instance in place and re-subscribe to it. Reads
  // the active id again after the refresh — the same guard the original had.
  async function respawnActive() {
    const id = getActiveId();
    if (!id) return;
    try {
      await apiFetch(`/api/instances/${id}/respawn`, { method: 'POST' });
      await refreshInstances();
      if (getActiveId()) send('subscribe', { id: getActiveId() });
    } catch (e) { alert(`resume failed: ${e.message}`); }
  }

  return {
    promoteSession, loadSessions, resumeSession,
    rewindActiveSession, forkActiveSession,
    deleteProject, deleteSession, removeWorktree,
    applySessionTitle, syncWorktree, mergeWorktree, respawnActive,
  };
}
