// New-project dialog: the sidebar ⋮ "+ New project" button, the live
// name→path preview, and the dialog's close handler that POSTs the create and
// refreshes the project list (re-opening with an inline error on failure).
// Follows the installX({...}) pattern. No module-owned state — the dialog reads
// its input on close; the only mutation is the DOM preview.
//
// There is intentionally NO backdrop-click handler (unlike the restart dialog):
// clicking the backdrop does nothing, matching prior behavior.
//
// Injected interface:
//   - dom:                    { newProjectBtn, newProjectDialog, npName,
//                               npError, npPreview } els.
//   - refreshProjects():      reloads the sidebar project list after a create
//                            (stays in app.js — drives state/sidebar).
//   - closeSidebarOverflow(): dismisses the sidebar ⋮ menu the dialog opens
//                            from (stays in app.js — owns the overflow control).
export function installNewProjectDialog({ dom, refreshProjects, closeSidebarOverflow }) {
  dom.newProjectBtn.addEventListener('click', () => {
    closeSidebarOverflow();
    dom.npName.value = '';
    dom.npError.textContent = '';
    dom.npPreview.textContent = '~/project/<name>';
    dom.newProjectDialog.showModal();
  });
  dom.npName.addEventListener('input', () => {
    dom.npPreview.textContent = `~/project/${dom.npName.value || '<name>'}`;
  });
  dom.newProjectDialog.addEventListener('close', async () => {
    if (dom.newProjectDialog.returnValue !== 'create') return;
    const name = dom.npName.value.trim();
    if (!name) return;
    try {
      const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!r.ok) throw new Error((await r.json()).error);
      await refreshProjects();
    } catch (e) {
      dom.npError.textContent = e.message;
      dom.newProjectDialog.showModal();
    }
  });
}
