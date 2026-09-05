// Change which TARGET of its system a project is on — the sidebar's system pill
// opens it, and `PUT /api/projects/:name/remote` does the work.
//
// One system can serve many named targets (one provider reaching a whole docker
// daemon), and which one a project is on is chosen per project. The system and
// the path are shown but READ-ONLY: moving a project to another machine, or to
// another path on the same one, is registration rather than a target change, and
// offering it here would let a mis-edit pass for the operation this dialog is
// named for.
//
// It uses a bare `fetch` rather than apiFetch DELIBERATELY. The refusal that
// matters here is the 409, whose body carries the live sessions and registered
// worktrees to clear — apiFetch keeps only `error`, and a list collapsed into a
// sentence is a list the user has to parse before they can act on it. The server
// refuses instead of killing sessions on the user's behalf precisely so that
// list can be acted on.
//
// Follows the installX({...}) pattern. Returns { open } — app.js wires the
// sidebar's onEditProjectRemote callback to it.
//
// Injected interface:
//   - dom: { projectRemoteDialog, prProject, prSystem, prPath, prRemote,
//            prError, prBlockers } els.
//   - refreshProjects(): reloads the sidebar project list after a change, so the
//                        pill stops naming the target the project just left.

export function installProjectRemoteDialog({ dom, refreshProjects }) {
  // The project the open dialog is about. Read on close rather than captured
  // per listener, because the sidebar re-renders under an open dialog and a
  // captured row object would be a stale one.
  let current = null;

  function clearRefusal() {
    dom.prError.textContent = '';
    dom.prBlockers.innerHTML = '';
    dom.prBlockers.hidden = true;
  }

  // The 409's list, rendered as a list. Each entry says WHAT it is, because
  // "a1b2c3d4" alone does not tell the user whether to kill a session or delete
  // a worktree.
  function showBlockers({ instances, worktrees }) {
    const rows = [
      ...(Array.isArray(instances) ? instances : []).map(id => `session ${id} — kill it`),
      ...(Array.isArray(worktrees) ? worktrees : []).map(n => `worktree ${n} — delete it`),
    ];
    dom.prBlockers.innerHTML = '';
    for (const text of rows) {
      const li = document.createElement('li');
      li.textContent = text;
      dom.prBlockers.appendChild(li);
    }
    dom.prBlockers.hidden = rows.length === 0;
  }

  function open(project) {
    current = project;
    clearRefusal();
    dom.prProject.textContent = project.name;
    dom.prSystem.value = project.system ?? '';
    dom.prPath.value = project.path ?? '';
    dom.prRemote.value = project.remoteId ?? '';
    dom.projectRemoteDialog.showModal();
  }

  dom.projectRemoteDialog.addEventListener('close', async () => {
    if (dom.projectRemoteDialog.returnValue !== 'save') return; // cancel
    const project = current;
    if (!project) return;
    // Blank IS an answer — fall back to the provider's own default target — so
    // it goes as null rather than as a target named nothing.
    const remoteId = dom.prRemote.value.trim() || null;
    clearRefusal();
    let res, body;
    try {
      res = await fetch(`/api/projects/${encodeURIComponent(project.name)}/remote`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remoteId }),
      });
      body = await res.json().catch(() => null);
    } catch (e) {
      dom.prError.textContent = e.message;
      dom.projectRemoteDialog.showModal();
      return;
    }
    if (!res.ok) {
      dom.prError.textContent = (body && body.error) || `HTTP ${res.status}`;
      if (body && body.code === 'PROJECT_PLACEMENT_IN_USE') showBlockers(body);
      // Reopened rather than dismissed: the list above is only useful while the
      // field that provoked it is still in front of the user.
      dom.projectRemoteDialog.showModal();
      return;
    }
    await refreshProjects();
  });

  return { open };
}
