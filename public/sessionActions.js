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
//
// Returns the eight action handles.

export function installSessionActions({
  getActiveId, setActiveId, getInstances,
  refreshProjects, refreshInstances, selectInstance,
  sidebar, clearUnread,
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
      const r = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/promote`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
      });
      if (!r.ok) throw new Error((await r.json()).error);
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
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json()).error);
    return r.json();
  }

  // One-click resume from the sidebar. We POST with worktree carried
  // through (so resuming a worktree session lands in the same worktree
  // cwd) and use orchestrator defaults for mode/effort/thinking. The
  // orchestrator's resume default is `code` (bypassPermissions) — fresh
  // spawns default to plan, but a resume is almost always continuing
  // real work. Switch via the header mode dropdown if needed.
  async function resumeSession({ projectName, worktreeName, sessionId }) {
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
      if (!r.ok) throw new Error((await r.json()).error);
      const inst = await r.json();
      await refreshProjects();
      await refreshInstances();
      selectInstance(inst.id);
    } catch (e) {
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
      const r = await fetch(`/api/instances/${encodeURIComponent(id)}/rewind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userMessageIndex }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      // Prefill rides on the `reset_snapshot` WS frame (carries droppedText
      // directly) so there's no race between this HTTP response and the
      // server-side emit. Just drain the body to release the connection.
      await r.json();
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
      const r = await fetch(`/api/instances/${encodeURIComponent(id)}/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userMessageIndex }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      const { instance: newInst } = await r.json();
      await refreshProjects();
      await refreshInstances();
      selectInstance(newInst.id);
    } catch (e) {
      alert(`fork failed: ${e.message}`);
    }
  }

  async function deleteProject(project) {
    const insts = getInstances().filter(i => i.project === project.name);
    const wts = project.worktrees ?? [];
    const summary = [
      `Delete project '${project.name}'?`,
      `Path: ${project.path}`,
      ``,
      `This will:`,
      `  • kill ${insts.length} running instance${insts.length === 1 ? '' : 's'}`,
      `  • remove ${wts.length} worktree${wts.length === 1 ? '' : 's'} (dir + branch)`,
      `  • rm -rf the project directory itself`,
      ``,
      `(Your ~/.claude/projects/ session history is left in place.)`,
      `Type the project name to confirm:`,
    ].join('\n');
    const typed = window.prompt(summary, '');
    if (typed !== project.name) {
      if (typed !== null) alert(`Name mismatch — nothing deleted.`);
      return;
    }
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project.name)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error);
      if (getActiveId() && insts.some(i => i.id === getActiveId())) {
        setActiveId(null);
      }
      await refreshProjects();
      await refreshInstances();
    } catch (e) {
      alert(`delete project failed: ${e.message}`);
    }
  }

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

  return {
    promoteSession, loadSessions, resumeSession,
    rewindActiveSession, forkActiveSession,
    deleteProject, deleteSession, removeWorktree,
  };
}
