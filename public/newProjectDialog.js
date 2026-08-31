// New-project dialog: the sidebar ⋮ "+ New project" button, the live
// name→path preview, opt-in project-convention checkboxes (grouped per
// contributing plugin), the create POST, and a read-only confirmation of the
// returned scaffold setup directive.
// Follows the installX({...}) pattern. No module-owned state — the dialog
// reads its inputs on close.
//
// A convention may carry a CLAUDE.md fragment and/or a one-time scaffold
// directive (hasScaffold) — it is one pick either way. Contributions are
// GROUPED for presentation only: core conventions in their own section, then
// one plain section per plugin (a text heading for provenance, no master
// toggle). Every convention — core or plugin — renders as its own
// individually-selectable checkbox. On create, a picked scaffold-bearing
// convention's directive is returned in the `scaffold` field.
//
// Injected interface:
// A project can be created on a registered SYSTEM instead of under the projects
// root, in which case the caller also names the absolute path on it. Only
// systems cc can reach are offered — a row with no provider command would give a
// project every later operation refuses — and the two conditions the server
// enforces (a system needs a path; the path is absolute) are checked here too,
// where the user is still looking at the field.
//
// One system can serve many named TARGETS, so a non-local system also offers a
// `remoteId`. It is offered UNCONDITIONALLY there rather than gated on the
// provider's `remotes` capability: cc cannot know that without connecting, and
// the server's named refusal at create time (SYSTEM_NO_REMOTES /
// REMOTE_NOT_FOUND, raised before anything is written) is what answers it. Blank
// means the provider's own default target, so the field is omitted rather than
// sent empty.
//
// Injected interface:
//   - dom: { newProjectBtn, newProjectDialog, npName, npError, npPreview,
//            npContributions, npForm, npConfirm, npScaffoldText,
//            npSystem, npSystemPath, npSystemPathRow, npRemote, npRemoteRow } els.
//   - refreshProjects():      reloads the sidebar project list after a create.
//   - closeSidebarOverflow(): dismisses the sidebar ⋮ menu.

import { apiFetch } from './http.js';

export function installNewProjectDialog({ dom, refreshProjects, closeSidebarOverflow }) {
  const pluginOf = (slug, explicit) => explicit ?? (slug.includes('/') ? slug.split('/')[0] : null);

  // One opt-in checkbox row. textContent everywhere (never innerHTML) — plugin
  // names/descriptions are trusted own code but built safely for consistency.
  function makeRow({ value, name, description }) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = value;
    input.dataset.kind = 'convention';
    const text = document.createElement('span');
    text.className = 'np-rule-text';
    const nameEl = document.createElement('span');
    nameEl.className = 'np-rule-name';
    nameEl.textContent = name;
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

  async function buildContributions() {
    dom.npContributions.innerHTML = '';
    let conventions = [];
    try {
      const r = await fetch('/api/settings/conventions/project');
      if (r.ok) conventions = (await r.json()).conventions ?? [];
    } catch { /* offline / no catalog — show nothing */ }

    const rowOf = (c) => ({ value: c.slug, name: c.name, description: c.description });

    // Core conventions (no plugin) get their own section.
    const core = conventions.filter(c => !pluginOf(c.slug, c.plugin));
    if (core.length) {
      const { wrap, list } = makeSection('Project conventions');
      for (const c of core) list.appendChild(makeRow(rowOf(c)).li);
      dom.npContributions.appendChild(wrap);
    }

    // One plain (non-interactive) heading per plugin, for provenance only.
    const byPlugin = new Map(); // pluginId -> items[]
    for (const c of conventions) {
      const p = pluginOf(c.slug, c.plugin);
      if (!p) continue;
      if (!byPlugin.has(p)) byPlugin.set(p, []);
      byPlugin.get(p).push(rowOf(c));
    }
    for (const plugin of [...byPlugin.keys()].sort()) {
      const { wrap, list } = makeSection(plugin);
      for (const item of byPlugin.get(plugin)) list.appendChild(makeRow(item).li);
      dom.npContributions.appendChild(wrap);
    }
  }

  function showForm() {
    dom.npForm.hidden = false;
    dom.npConfirm.hidden = true;
  }

  const chosenSystem = () => {
    const v = dom.npSystem?.value ?? '';
    return v && v !== 'local' ? v : null;
  };

  // Blank IS an answer — the provider's own default target — so it reads as
  // null rather than as an empty target name.
  const chosenRemote = () => (dom.npRemote?.value ?? '').trim() || null;

  // What the dialog says it is about to create — kept in step with both inputs,
  // because a preview that lags the placement is a promise about the wrong
  // machine.
  function updatePreview() {
    const name = dom.npName.value || '<name>';
    const system = chosenSystem();
    if (!system) { dom.npPreview.textContent = `~/project/${name}`; return; }
    const remote = chosenRemote();
    // Same vocabulary the server uses in its own refusals ("remote 'r' of system
    // 's'"), so the preview and the error that may follow it name one thing.
    const where = remote ? `remote '${remote}' of system '${system}'` : `system '${system}'`;
    dom.npPreview.textContent = `${dom.npSystemPath?.value || '<path>'} on ${where}`;
  }

  async function buildSystems() {
    if (!dom.npSystem) return;
    dom.npSystem.innerHTML = '';
    let systems = [{ id: 'local', label: 'This machine', managed: true }];
    try {
      const r = await fetch('/api/settings/systems');
      if (r.ok) systems = (await r.json()).systems ?? systems;
    } catch { /* offline — local is always available */ }
    for (const sys of systems) {
      // A row with no provider command cannot be reached, so a project put on
      // it could never be opened. `local` is in-process and carries none.
      if (!sys.managed && !(Array.isArray(sys.launch) && sys.launch.length)) continue;
      const opt = document.createElement('option');
      opt.value = sys.id;
      opt.textContent = sys.managed ? sys.label : `${sys.label} (${sys.id})`;
      dom.npSystem.appendChild(opt);
    }
    dom.npSystem.value = 'local';
    syncSystemPathRow();
  }

  // Both extra fields belong to the same choice: a path and a target are only
  // meaningful once the project is on a system.
  function syncSystemPathRow() {
    const on = !!chosenSystem();
    if (dom.npSystemPathRow) dom.npSystemPathRow.hidden = !on;
    if (dom.npRemoteRow) dom.npRemoteRow.hidden = !on;
    updatePreview();
  }

  dom.newProjectBtn.addEventListener('click', async () => {
    closeSidebarOverflow();
    dom.npName.value = '';
    dom.npError.textContent = '';
    if (dom.npSystemPath) dom.npSystemPath.value = '';
    if (dom.npRemote) dom.npRemote.value = '';
    showForm();
    await buildSystems();
    await buildContributions();
    dom.newProjectDialog.showModal();
  });
  dom.npName.addEventListener('input', updatePreview);
  dom.npSystem?.addEventListener('change', syncSystemPathRow);
  dom.npSystemPath?.addEventListener('input', updatePreview);
  dom.npRemote?.addEventListener('input', updatePreview);
  dom.newProjectDialog.addEventListener('close', async () => {
    if (dom.newProjectDialog.returnValue !== 'create') return; // cancel / confirmation Done
    const name = dom.npName.value.trim();
    if (!name) return;
    const conventions = [...dom.npContributions.querySelectorAll('input[data-kind="convention"]:checked')].map(cb => cb.value);
    const system = chosenSystem();
    const systemPath = (dom.npSystemPath?.value ?? '').trim();
    // The server refuses both of these too; checking here is what keeps the
    // dialog open on the field the user has to fix.
    const placementError = !system ? null
      : !systemPath ? `a path on '${system}' is required — cc has no default location on another machine`
      : !systemPath.startsWith('/') ? `the path on '${system}' must be absolute`
      : null;
    if (placementError) {
      dom.npError.textContent = placementError;
      showForm();
      dom.newProjectDialog.showModal();
      return;
    }
    try {
      const body = { name };
      if (conventions.length) body.conventions = conventions;
      if (system) {
        body.system = system;
        body.systemPath = systemPath;
        const remote = chosenRemote();
        if (remote) body.remoteId = remote;
      }
      const created = await apiFetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
