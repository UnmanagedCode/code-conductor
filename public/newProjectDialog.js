// New-project dialog: the sidebar ⋮ "+ New project" button, the live
// name→path preview, project-convention checkboxes, and the dialog's
// close handler that POSTs the create and refreshes the project list.
// Follows the installX({...}) pattern. No module-owned state — the dialog
// reads its inputs on close.
//
// There is intentionally NO backdrop-click handler (unlike the restart dialog):
// clicking the backdrop does nothing, matching prior behavior.
//
// Injected interface:
//   - dom:                    { newProjectBtn, newProjectDialog, npName, npError,
//                               npPreview, npGuidelines, npGuidelinesList,
//                               npSetupPrompts, npSetupPromptsList } els.
//   - refreshProjects():      reloads the sidebar project list after a create
//                            (stays in app.js — drives state/sidebar).
//   - closeSidebarOverflow(): dismisses the sidebar ⋮ menu the dialog opens
//                            from (stays in app.js — owns the overflow control).
export function installNewProjectDialog({ dom, refreshProjects, closeSidebarOverflow }) {
  // Build one opt-in checkbox row: <li><label><input value=<value>/>…name…desc…tag</label></li>.
  // textContent everywhere (never innerHTML) — plugin-contributed names/descriptions
  // are trusted own code but constructed safely for consistency.
  function renderRow(listEl, { value, name, description, tag }) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = value;
    const text = document.createElement('span');
    text.className = 'np-rule-text';
    const nameEl = document.createElement('span');
    nameEl.className = 'np-rule-name';
    nameEl.textContent = name;
    if (tag) {
      const tagEl = document.createElement('span');
      tagEl.className = 'np-rule-tag';
      tagEl.textContent = tag;
      nameEl.append(' ', tagEl);
    }
    const descEl = document.createElement('span');
    descEl.className = 'np-rule-desc';
    descEl.textContent = description;
    text.append(nameEl, descEl);
    label.append(input, text);
    li.appendChild(label);
    listEl.appendChild(li);
  }

  // Project conventions (core + plugin-contributed). Plugin slugs are namespaced
  // <plugin-id>/<slug>; show the source plugin as a tag.
  async function loadConventions() {
    dom.npGuidelinesList.innerHTML = '';
    try {
      const r = await fetch('/api/settings/project-conventions');
      if (!r.ok) { dom.npGuidelines.hidden = true; return; }
      const { rules } = await r.json();
      if (!rules || rules.length === 0) { dom.npGuidelines.hidden = true; return; }
      for (const rule of rules) {
        const plugin = rule.plugin ?? (rule.slug.includes('/') ? rule.slug.split('/')[0] : null);
        renderRow(dom.npGuidelinesList, { value: rule.slug, name: rule.name, description: rule.description, tag: plugin ? `from ${plugin}` : null });
      }
      dom.npGuidelines.hidden = false;
    } catch { dom.npGuidelines.hidden = true; }
  }

  // Plugin-offered setup prompts (opt-in; folded into the first agent turn).
  async function loadSetupPrompts() {
    dom.npSetupPromptsList.innerHTML = '';
    try {
      const r = await fetch('/api/setup-prompts');
      if (!r.ok) { dom.npSetupPrompts.hidden = true; return; }
      const { setupPrompts } = await r.json();
      if (!setupPrompts || setupPrompts.length === 0) { dom.npSetupPrompts.hidden = true; return; }
      for (const sp of setupPrompts) {
        renderRow(dom.npSetupPromptsList, { value: sp.pluginId, name: sp.name, description: sp.description, tag: `from ${sp.pluginId}` });
      }
      dom.npSetupPrompts.hidden = false;
    } catch { dom.npSetupPrompts.hidden = true; }
  }

  dom.newProjectBtn.addEventListener('click', async () => {
    closeSidebarOverflow();
    dom.npName.value = '';
    dom.npError.textContent = '';
    dom.npPreview.textContent = '~/project/<name>';
    await Promise.all([loadConventions(), loadSetupPrompts()]);
    dom.newProjectDialog.showModal();
  });
  dom.npName.addEventListener('input', () => {
    dom.npPreview.textContent = `~/project/${dom.npName.value || '<name>'}`;
  });
  dom.newProjectDialog.addEventListener('close', async () => {
    if (dom.newProjectDialog.returnValue !== 'create') return;
    const name = dom.npName.value.trim();
    if (!name) return;
    const conventions = [...dom.npGuidelinesList.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
    const setupPrompts = [...dom.npSetupPromptsList.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
    try {
      const body = { name };
      if (conventions.length > 0) body.conventions = conventions;
      if (setupPrompts.length > 0) body.setupPrompts = setupPrompts;
      const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error);
      await refreshProjects();
    } catch (e) {
      dom.npError.textContent = e.message;
      dom.newProjectDialog.showModal();
    }
  });
}
