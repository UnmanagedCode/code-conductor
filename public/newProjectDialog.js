// New-project dialog: the sidebar ⋮ "+ New project" button, the live
// name→path preview, opt-in project-convention + project-scaffold checkboxes
// (grouped per contributing plugin), the create POST, and a read-only
// confirmation of the returned scaffold setup directive.
// Follows the installX({...}) pattern. No module-owned state — the dialog
// reads its inputs on close.
//
// Contributions are GROUPED for presentation only (no schema coupling): core
// conventions in their own section, then one section per plugin bundling that
// plugin's conventions + scaffolds under a "Set up <plugin>" master toggle
// that defaults both on when ticked; every item stays individually
// de-selectable (a scaffold without its convention, or vice versa).
//
// Injected interface:
//   - dom: { newProjectBtn, newProjectDialog, npName, npError, npPreview,
//            npContributions, npForm, npConfirm, npScaffoldText } els.
//   - refreshProjects():      reloads the sidebar project list after a create.
//   - closeSidebarOverflow(): dismisses the sidebar ⋮ menu.
export function installNewProjectDialog({ dom, refreshProjects, closeSidebarOverflow }) {
  const pluginOf = (slug, explicit) => explicit ?? (slug.includes('/') ? slug.split('/')[0] : null);

  // One opt-in checkbox row. textContent everywhere (never innerHTML) — plugin
  // names/descriptions are trusted own code but built safely for consistency.
  function makeRow({ kind, value, name, description, tag }) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = value;
    input.dataset.kind = kind; // 'convention' | 'scaffold'
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
    return { li, input };
  }

  function makeSection(labelText) {
    const wrap = document.createElement('div');
    wrap.className = 'np-rules';
    const label = document.createElement('p');
    label.className = 'np-rules-label';
    label.textContent = labelText;
    const list = document.createElement('ul');
    list.className = 'np-rules-list';
    wrap.append(label, list);
    return { wrap, list };
  }

  // A plugin group: "Set up <plugin>" master toggle bundling its items.
  function makePluginGroup(plugin, items) {
    const { wrap, list } = makeSection('');
    const label = wrap.querySelector('.np-rules-label');
    const master = document.createElement('input');
    master.type = 'checkbox';
    master.className = 'np-group-master';
    const masterLabel = document.createElement('label');
    masterLabel.className = 'np-group-head';
    const span = document.createElement('span');
    span.textContent = `Set up ${plugin}`;
    masterLabel.append(master, span);
    label.replaceWith(masterLabel);

    const inputs = [];
    for (const it of items) {
      const { li, input } = makeRow(it);
      list.appendChild(li);
      inputs.push(input);
    }
    const syncMaster = () => {
      const on = inputs.filter(i => i.checked).length;
      master.checked = on === inputs.length;
      master.indeterminate = on > 0 && on < inputs.length;
    };
    master.addEventListener('change', () => {
      for (const i of inputs) i.checked = master.checked;
      master.indeterminate = false;
    });
    for (const i of inputs) i.addEventListener('change', syncMaster);
    return wrap;
  }

  async function buildContributions() {
    dom.npContributions.innerHTML = '';
    let conventions = [];
    let scaffolds = [];
    try {
      const r = await fetch('/api/settings/project-conventions');
      if (r.ok) conventions = (await r.json()).rules ?? [];
    } catch { /* offline / no catalog — show nothing */ }
    try {
      const r = await fetch('/api/project-scaffolds');
      if (r.ok) scaffolds = (await r.json()).scaffolds ?? [];
    } catch { /* no plugins */ }

    // Core conventions (no plugin) get their own section.
    const core = conventions.filter(c => !pluginOf(c.slug, c.plugin));
    if (core.length) {
      const { wrap, list } = makeSection('Project conventions');
      for (const c of core) list.appendChild(makeRow({ kind: 'convention', value: c.slug, name: c.name, description: c.description }).li);
      dom.npContributions.appendChild(wrap);
    }

    // Group each plugin's conventions + scaffolds under one master toggle.
    const byPlugin = new Map(); // pluginId -> items[]
    const push = (id, item) => { if (!byPlugin.has(id)) byPlugin.set(id, []); byPlugin.get(id).push(item); };
    for (const c of conventions) {
      const p = pluginOf(c.slug, c.plugin);
      if (p) push(p, { kind: 'convention', value: c.slug, name: c.name, description: c.description, tag: 'convention' });
    }
    for (const s of scaffolds) {
      const p = pluginOf(s.slug, s.plugin);
      if (p) push(p, { kind: 'scaffold', value: s.slug, name: s.name, description: s.description, tag: 'scaffold' });
    }
    for (const plugin of [...byPlugin.keys()].sort()) {
      dom.npContributions.appendChild(makePluginGroup(plugin, byPlugin.get(plugin)));
    }
  }

  function showForm() {
    dom.npForm.hidden = false;
    dom.npConfirm.hidden = true;
  }

  dom.newProjectBtn.addEventListener('click', async () => {
    closeSidebarOverflow();
    dom.npName.value = '';
    dom.npError.textContent = '';
    dom.npPreview.textContent = '~/project/<name>';
    showForm();
    await buildContributions();
    dom.newProjectDialog.showModal();
  });
  dom.npName.addEventListener('input', () => {
    dom.npPreview.textContent = `~/project/${dom.npName.value || '<name>'}`;
  });
  dom.newProjectDialog.addEventListener('close', async () => {
    if (dom.newProjectDialog.returnValue !== 'create') return; // cancel / confirmation Done
    const name = dom.npName.value.trim();
    if (!name) return;
    const checked = (kind) => [...dom.npContributions.querySelectorAll(`input[data-kind="${kind}"]:checked`)].map(cb => cb.value);
    const conventions = checked('convention');
    const scaffolds = checked('scaffold');
    try {
      const body = { name };
      if (conventions.length) body.conventions = conventions;
      if (scaffolds.length) body.scaffolds = scaffolds;
      const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error);
      const created = await r.json();
      await refreshProjects();
      // A returned scaffold directive is shown read-only so it isn't lost.
      if (created.scaffold) {
        dom.npScaffoldText.value = created.scaffold;
        dom.npForm.hidden = true;
        dom.npConfirm.hidden = false;
        dom.newProjectDialog.showModal();
      }
    } catch (e) {
      dom.npError.textContent = e.message;
      showForm();
      dom.newProjectDialog.showModal();
    }
  });
}
