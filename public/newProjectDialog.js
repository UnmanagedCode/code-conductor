// New-project dialog: the sidebar ⋮ "+ New project" button, the live
// name→path preview, optional rule-module checkboxes, and the dialog's
// close handler that POSTs the create and refreshes the project list.
// Follows the installX({...}) pattern. No module-owned state — the dialog
// reads its inputs on close.
//
// There is intentionally NO backdrop-click handler (unlike the restart dialog):
// clicking the backdrop does nothing, matching prior behavior.
//
// Injected interface:
//   - dom:                    { newProjectBtn, newProjectDialog, npName,
//                               npError, npPreview, npRules, npRulesList } els.
//   - refreshProjects():      reloads the sidebar project list after a create
//                            (stays in app.js — drives state/sidebar).
//   - closeSidebarOverflow(): dismisses the sidebar ⋮ menu the dialog opens
//                            from (stays in app.js — owns the overflow control).
export function installNewProjectDialog({ dom, refreshProjects, closeSidebarOverflow }) {
  dom.newProjectBtn.addEventListener('click', async () => {
    closeSidebarOverflow();
    dom.npName.value = '';
    dom.npError.textContent = '';
    dom.npPreview.textContent = '~/project/<name>';
    // Fetch catalog and render checkboxes (unchecked by default).
    try {
      const r = await fetch('/api/settings/optional-rules');
      if (r.ok) {
        const { rules } = await r.json();
        dom.npRulesList.innerHTML = '';
        if (rules && rules.length > 0) {
          for (const rule of rules) {
            const li = document.createElement('li');
            const id = `np-rule-${rule.slug}`;
            li.innerHTML = `<label><input type="checkbox" id="${id}" value="${rule.slug}" /><span class="np-rule-text"><span class="np-rule-name">${rule.name}</span><span class="np-rule-desc">${rule.description}</span></span></label>`;
            dom.npRulesList.appendChild(li);
          }
          dom.npRules.hidden = false;
        } else {
          dom.npRules.hidden = true;
        }
      } else {
        dom.npRules.hidden = true;
      }
    } catch {
      dom.npRules.hidden = true;
    }
    dom.newProjectDialog.showModal();
  });
  dom.npName.addEventListener('input', () => {
    dom.npPreview.textContent = `~/project/${dom.npName.value || '<name>'}`;
  });
  dom.newProjectDialog.addEventListener('close', async () => {
    if (dom.newProjectDialog.returnValue !== 'create') return;
    const name = dom.npName.value.trim();
    if (!name) return;
    const checked = [...dom.npRulesList.querySelectorAll('input[type="checkbox"]:checked')];
    const rules = checked.map(cb => cb.value);
    try {
      const body = rules.length > 0 ? { name, rules } : { name };
      const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error);
      await refreshProjects();
    } catch (e) {
      dom.npError.textContent = e.message;
      dom.newProjectDialog.showModal();
    }
  });
}
