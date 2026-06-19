// Workspace dialog. Double-duty for new + edit:
//   - new mode (workspaceDialogOriginalName === null): blank name input,
//     no tickboxes pre-checked, Delete-workspace button hidden. Submitting
//     with no projects ticked creates an empty workspace via POST /api/workspaces.
//   - edit mode (workspaceDialogOriginalName === '<name>'): name pre-filled,
//     current members ticked, Delete button shown.
// On submit, we first rename the workspace via PUT /api/workspaces/:old
// if the name changed, then diff the rendered ticks against the original
// membership and fire one PUT /api/projects/:name/workspace per
// changed project in parallel.
//
// Follows the installX({...}) pattern. Module-owned state:
// workspaceDialogOriginalName / workspaceDialogOriginalMembers. Returns
// { openNew, openEdit }: app.js wires the newWorkspaceBtn click to openNew
// (after closing the sidebar overflow itself) and the sidebar's
// onEditWorkspace callback to openEdit.
//
// Injected interface:
//   - dom:               { workspaceDialog, gdTitle, gdName, gdProjectList,
//                          gdEmptyHint, gdError, gdDelete, gdSave } els.
//   - getProjects():     reads the live project list (state.projects) for the
//                        membership tickboxes (stays in app.js — the store).
//   - refreshProjects(): reloads the sidebar project list after a save/delete
//                        (stays in app.js — drives state/sidebar).
export function installWorkspaceDialog({ dom, getProjects, refreshProjects }) {
  let workspaceDialogOriginalName = null;
  let workspaceDialogOriginalMembers = new Set();

  function renderWorkspaceDialogProjectList() {
    dom.gdProjectList.innerHTML = '';
    const projects = getProjects();
    if (projects.length === 0) {
      dom.gdEmptyHint.hidden = false;
      return;
    }
    dom.gdEmptyHint.hidden = true;
    for (const p of projects) {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'gd-project-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = p.name;
      cb.checked = workspaceDialogOriginalMembers.has(p.name);
      label.appendChild(cb);
      const name = document.createElement('span');
      name.className = 'gd-project-name';
      name.textContent = p.name;
      label.appendChild(name);
      const currentWorkspace = (typeof p.workspace === 'string' && p.workspace.trim() !== '') ? p.workspace.trim() : null;
      if (currentWorkspace && currentWorkspace !== workspaceDialogOriginalName) {
        const tag = document.createElement('span');
        tag.className = 'gd-project-current-workspace';
        tag.textContent = `in '${currentWorkspace}'`;
        tag.title = `Ticking this project will move it out of '${currentWorkspace}'.`;
        label.appendChild(tag);
      }
      li.appendChild(label);
      dom.gdProjectList.appendChild(li);
    }
  }

  function openNewWorkspaceDialog() {
    workspaceDialogOriginalName = null;
    workspaceDialogOriginalMembers = new Set();
    dom.gdTitle.textContent = 'New workspace';
    dom.gdName.value = '';
    dom.gdError.textContent = '';
    dom.gdDelete.hidden = true;
    dom.gdSave.textContent = 'Create';
    renderWorkspaceDialogProjectList();
    dom.workspaceDialog.showModal();
    // Focus the name field once the dialog is up.
    setTimeout(() => dom.gdName.focus(), 0);
  }

  function openEditWorkspaceDialog(workspaceName) {
    workspaceDialogOriginalName = workspaceName;
    workspaceDialogOriginalMembers = new Set(
      getProjects().filter(p => (p.workspace ?? '').trim() === workspaceName).map(p => p.name),
    );
    dom.gdTitle.textContent = `Edit workspace '${workspaceName}'`;
    dom.gdName.value = workspaceName;
    dom.gdError.textContent = '';
    dom.gdDelete.hidden = false;
    dom.gdSave.textContent = 'Save';
    renderWorkspaceDialogProjectList();
    dom.workspaceDialog.showModal();
  }

  // Delete-workspace: hits DELETE /api/workspaces/:name which removes the
  // registry entry AND clears the workspace field on every current member.
  // The projects themselves are untouched; they fall back to unassigned.
  // Sits inside the form but is a type=button so it doesn't submit it —
  // we handle it explicitly and close the dialog ourselves.
  dom.gdDelete.addEventListener('click', async () => {
    if (!workspaceDialogOriginalName) return;
    if (!confirm(`Delete workspace '${workspaceDialogOriginalName}'?\nMember projects will move back to unassigned (no project data is removed).`)) return;
    dom.gdDelete.disabled = true;
    dom.gdError.textContent = '';
    try {
      const r = await fetch(`/api/workspaces/${encodeURIComponent(workspaceDialogOriginalName)}`, { method: 'DELETE' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      dom.workspaceDialog.close('deleted');
      await refreshProjects();
    } catch (e) {
      dom.gdError.textContent = e.message;
    } finally {
      dom.gdDelete.disabled = false;
    }
  });

  async function setProjectWorkspace(projectName, workspace) {
    const r = await fetch(`/api/projects/${encodeURIComponent(projectName)}/workspace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error ?? `${projectName}: HTTP ${r.status}`);
    }
  }

  async function createEmptyWorkspace(name) {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
  }

  async function renameWorkspaceServerSide(oldName, newName) {
    const r = await fetch(`/api/workspaces/${encodeURIComponent(oldName)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
  }

  dom.workspaceDialog.addEventListener('close', async () => {
    if (dom.workspaceDialog.returnValue !== 'save') return;
    const newName = dom.gdName.value.trim();
    if (!newName) {
      dom.gdError.textContent = 'Workspace name is required';
      dom.workspaceDialog.showModal();
      return;
    }
    const ticked = new Set();
    for (const cb of dom.gdProjectList.querySelectorAll('input[type="checkbox"]')) {
      if (cb.checked) ticked.add(cb.value);
    }

    try {
      // Edit mode + rename: do the atomic server-side rename first so the
      // subsequent membership PUTs operate against the new name.
      if (workspaceDialogOriginalName && newName !== workspaceDialogOriginalName) {
        await renameWorkspaceServerSide(workspaceDialogOriginalName, newName);
      }
      // New mode + no projects ticked: explicitly create the empty
      // workspace so it persists in the registry.
      if (!workspaceDialogOriginalName && ticked.size === 0) {
        await createEmptyWorkspace(newName);
        await refreshProjects();
        return;
      }
      // Diff the ticked set against the original membership. Renamed
      // members were already rewritten by the rename call above, so we
      // only need to PUT for ticks that differ.
      const updates = [];
      for (const name of ticked) {
        if (!workspaceDialogOriginalMembers.has(name)) {
          updates.push(setProjectWorkspace(name, newName));
        }
      }
      for (const name of workspaceDialogOriginalMembers) {
        if (!ticked.has(name)) {
          updates.push(setProjectWorkspace(name, null));
        }
      }
      if (updates.length > 0) await Promise.all(updates);
      await refreshProjects();
    } catch (e) {
      dom.gdError.textContent = e.message;
      dom.workspaceDialog.showModal();
    }
  });

  return { openNew: openNewWorkspaceDialog, openEdit: openEditWorkspaceDialog };
}
