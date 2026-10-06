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
// `remoteId`, chosen before the path because the path picker completes against
// it. It is offered UNCONDITIONALLY there rather than gated on the provider's
// `remotes` capability: cc cannot know that without connecting, and the
// server's named refusal at create time (SYSTEM_NO_REMOTES / REMOTE_NOT_FOUND,
// raised before anything is written) is what answers it. Blank means the
// provider's own default target, so the field is omitted rather than sent
// empty. When the system's provider lists the remotes it is configured for,
// the field is a dropdown of them instead — see the Remote block below.
//
// Injected interface:
//   - dom: { newProjectBtn, newProjectDialog, npName, npError, npPreview,
//            npContributions, npForm, npConfirm, npScaffoldText,
//            npScaffoldBlock, npGitSkipped,
//            npSystem, npSystemPath, npSystemPathRow, npSystemPathCompletions,
//            npSystemPathNote, npRemote, npRemoteRow, npRemoteSelect,
//            npRemoteNote } els.
//   - timers (optional):      { setTimeout, clearTimeout } for the path picker's debounce.
//   - refreshProjects():      reloads the sidebar project list after a create.
//   - closeSidebarOverflow(): dismisses the sidebar ⋮ menu.

import { apiFetch } from './http.js';
import { loadCapabilities } from './capabilities.js';
import { installPathPicker } from './pathPicker.js';

export function installNewProjectDialog({ dom, refreshProjects, closeSidebarOverflow, timers }) {
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
    // The server does NOT send a degrade flag on this response — only the MCP
    // `list_project_conventions` tool carries one (card 2026-0282). So a
    // catalog missing an unreachable plugin's conventions arrives here looking
    // complete, and the sections below render one heading fewer with nothing
    // saying so. Anyone adding a banner has to make the route carry the flag
    // first; it is carded separately.
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

  // ── The Remote field: a dropdown when the System enumerates ────────
  //
  // A system whose provider lists the remotes it is configured for
  // (`GET /api/systems/:id/remotes` answering `listed`) offers them as a
  // dropdown: an unsubmittable placeholder, the ids, and Other…, which reveals
  // the free-text field for one it did not list. A system that is not
  // enumerable keeps the free-text field; a FAILED enumeration keeps it too and
  // says why, so it is never read as "no remotes". `local` is never asked.
  //
  // Guarded on `dom.npRemoteSelect`, as the path picker is on its input: other
  // suites install this dialog into fragments that carry no dropdown.
  //
  // The Other… sentinel carries a space, which no remoteId may hold (the server's
  // remoteId rule), so it can never collide with a listed id.
  const REMOTE_OTHER = ' other';
  // 'free': the text field is the Remote. 'select': the dropdown is.
  let remoteMode = 'free';
  // Bumped by every ask and every reset; an answer lands only if its ask is
  // still the latest one.
  let remoteSeq = 0;
  const remoteSelect = dom.npRemoteSelect;

  function showRemoteFree(note) {
    remoteMode = 'free';
    remoteSelect.hidden = true;
    remoteSelect.innerHTML = '';
    dom.npRemote.hidden = false;
    dom.npRemoteNote.textContent = note;
  }

  // On open and on choosing this machine: no remote, no dropdown, and any ask
  // still in flight is dropped when it lands.
  function resetRemote() {
    ++remoteSeq;
    if (dom.npRemote) dom.npRemote.value = '';
    if (remoteSelect) showRemoteFree('');
  }

  function showRemoteList(system, remoteIds) {
    remoteSelect.innerHTML = '';
    const add = (value, text) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      remoteSelect.appendChild(opt);
    };
    add('', '— choose a remote —');
    for (const id of remoteIds) add(id, id);
    add(REMOTE_OTHER, 'Other…');
    remoteMode = 'select';
    remoteSelect.hidden = false;
    // A remote already typed stays the answer, under Other… — so the switch
    // never changes what chosenRemote() reads.
    const typed = dom.npRemote.value.trim() !== '';
    remoteSelect.value = typed ? REMOTE_OTHER : '';
    dom.npRemote.hidden = !typed;
    dom.npRemoteNote.textContent = remoteIds.length ? ''
      : `System '${system}' lists no configured remotes right now — choose Other… to type one.`;
  }

  async function loadRemotes(system) {
    if (!remoteSelect) return;
    const mine = ++remoteSeq;
    showRemoteFree(`Listing the remotes system '${system}' is configured for…`);
    let answer;
    try {
      const res = await fetch(`/api/systems/${encodeURIComponent(system)}/remotes`);
      answer = res.ok ? await res.json() : { state: 'failed', reason: `HTTP ${res.status}` };
    } catch (e) {
      answer = { state: 'failed', reason: e.message };
    }
    if (mine !== remoteSeq || chosenSystem() !== system) return;
    if (answer.state === 'listed') showRemoteList(system, answer.remoteIds);
    else if (answer.state === 'failed') {
      showRemoteFree(`Could not list the remotes of system '${system}' (${answer.reason}) — type one.`);
    } else showRemoteFree('');
  }

  // Blank IS an answer — the provider's own default target — so it reads as
  // null rather than as an empty target name. So does the placeholder, which
  // the create refuses before it gets this far.
  const chosenRemote = () => {
    if (remoteMode === 'select' && remoteSelect.value !== REMOTE_OTHER) return remoteSelect.value || null;
    return (dom.npRemote?.value ?? '').trim() || null;
  };

  // With a dropdown up, a remote has to be chosen: the placeholder is not an
  // answer, and neither is Other… left blank.
  const remoteError = (system) => {
    if (!system || remoteMode !== 'select') return null;
    if (remoteSelect.value === '') return `choose a remote on '${system}' — it lists the remotes it is configured for`;
    if (remoteSelect.value === REMOTE_OTHER && !dom.npRemote.value.trim()) {
      return `type a remote for '${system}', or pick a listed one`;
    }
    return null;
  };

  // Directory completion for the system path. The system and remote changing
  // invalidate what it has cached.
  const pathPicker = dom.npSystemPath
    ? installPathPicker({
      input: dom.npSystemPath,
      list: dom.npSystemPathCompletions,
      note: dom.npSystemPathNote,
      getPlacement: () => ({ system: chosenSystem(), remoteId: chosenRemote() }),
      timers,
    })
    : null;

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
    // A platform without remote Systems offers only this machine: no picker,
    // no path or remote rows, no registry fetch. (Unknown flags, after a failed
    // load, leave the picker as it is; the next open retries.)
    const caps = await loadCapabilities();
    if (caps && !caps.remoteSystems) {
      const row = dom.npSystem.closest('label');
      if (row) row.hidden = true;
      syncSystemPathRow();
      return;
    }
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
    resetRemote();
    pathPicker?.reset();
    showForm();
    await buildSystems();
    await buildContributions();
    dom.newProjectDialog.showModal();
  });
  dom.npName.addEventListener('input', updatePreview);
  dom.npSystem?.addEventListener('change', () => {
    pathPicker?.reset();
    const system = chosenSystem();
    if (system) loadRemotes(system);
    else resetRemote();
    syncSystemPathRow();
  });
  dom.npSystemPath?.addEventListener('input', updatePreview);
  dom.npRemote?.addEventListener('input', () => {
    pathPicker?.reset();
    updatePreview();
  });
  remoteSelect?.addEventListener('change', () => {
    const other = remoteSelect.value === REMOTE_OTHER;
    dom.npRemote.hidden = !other;
    if (other) dom.npRemote.focus();
    pathPicker?.reset();
    updatePreview();
  });
  dom.newProjectDialog.addEventListener('close', async () => {
    if (dom.newProjectDialog.returnValue !== 'create') return; // cancel / confirmation Done
    const name = dom.npName.value.trim();
    if (!name) return;
    const conventions = [...dom.npContributions.querySelectorAll('input[data-kind="convention"]:checked')].map(cb => cb.value);
    const system = chosenSystem();
    const systemPath = (dom.npSystemPath?.value ?? '').trim();
    // The server refuses the two path checks too; checking here is what keeps
    // the dialog open on the field the user has to fix. The remote check is the
    // dialog's own: a dropdown left on its placeholder would otherwise post the
    // provider's default target, which nobody chose.
    const placementError = !system ? null
      : !systemPath ? `a path on '${system}' is required — cc has no default location on another machine`
      : !systemPath.startsWith('/') ? `the path on '${system}' must be absolute`
      : remoteError(system);
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
      // The confirm pane carries what the create returned beyond success: a
      // scaffold directive (shown read-only so it isn't lost) and/or the reason
      // git was skipped. Each block is set from its own field on every create,
      // so one create's notice never survives into the next.
      if (created.scaffold || created.gitSkipped) {
        dom.npScaffoldText.value = created.scaffold ?? '';
        dom.npScaffoldBlock.hidden = !created.scaffold;
        dom.npGitSkipped.textContent = created.gitSkipped ?? '';
        dom.npGitSkipped.hidden = !created.gitSkipped;
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
