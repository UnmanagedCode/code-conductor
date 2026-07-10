// "Plugins" group in the settings view — a management list over
// GET /api/plugins with immediate lifecycle actions (enable/disable/
// start/stop; staged-Apply is only for value edits, which this group has
// none of), a crash-tail expander, and an active-version dropdown (main +
// the project's worktrees from /api/projects). installed once by
// settings.js, which calls load() on every settings open.

export function installPluginManager({ onCatalogChange } = {}) {
  const statusEl = document.getElementById('pl-status');
  const listEl = document.getElementById('pl-list');
  const rescanBtn = document.getElementById('pl-rescan-btn');
  if (!listEl) return { load() {} };

  let busy = false;

  function setStatus(text, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('pl-status-err', isError);
  }

  async function api(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  // project → worktree names, for the version dropdowns.
  async function fetchWorktrees() {
    try {
      const projects = await api('GET', '/api/projects');
      const map = {};
      for (const p of projects) {
        map[p.name] = (p.worktrees || []).map(w => w.worktreeName).filter(Boolean);
      }
      return map;
    } catch {
      return {};
    }
  }

  async function act(label, fn) {
    if (busy) return;
    busy = true;
    setStatus(`${label}…`);
    try {
      await fn();
      await load();
      onCatalogChange?.();
    } catch (e) {
      setStatus(`${label} failed: ${e.message || e}`, true);
      busy = false;
      return;
    }
    busy = false;
  }

  function versionLabel(row) {
    const v = row.activeVersion || { type: 'main' };
    return v.type === 'worktree' ? v.name : 'main';
  }

  function render(rows, worktrees) {
    listEl.innerHTML = '';
    if (rows.length === 0) {
      setStatus('No plugins found — a plugin is a project with a conductor.plugin.json at its root.');
      return;
    }
    setStatus(`${rows.length} plugin${rows.length === 1 ? '' : 's'}`);
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'pl-row';

      const head = document.createElement('div');
      head.className = 'pl-row-head';
      const name = document.createElement('span');
      name.className = 'pl-name';
      name.textContent = row.name;
      const badge = document.createElement('span');
      badge.className = `pl-badge pl-badge-${row.state}`;
      badge.textContent = row.state;
      head.append(name, badge);
      li.appendChild(head);

      const meta = document.createElement('div');
      meta.className = 'pl-meta';
      const bits = [`project ${row.project}`];
      if (row.version) bits.push(`v${row.version}`);
      if (row.state === 'ready') {
        bits.push(`running ${versionLabel(row)}${row.gitHead ? ` @ ${row.gitHead.slice(0, 7)}` : ''}`);
        if (row.port) bits.push(`port ${row.port}`);
      } else if ((row.activeVersion?.type ?? 'main') === 'worktree') {
        bits.push(`version ${versionLabel(row)}`);
      }
      if (row.manifestSource?.type === 'worktree') {
        bits.push(`manifest from worktree ${row.manifestSource.name}`);
      }
      meta.textContent = bits.join(' · ');
      li.appendChild(meta);

      // Contribution badges: what a plugin adds beyond a backend (so a
      // backendless conventions-only plugin visibly earns its place).
      const contribs = [];
      if (row.guidelines?.length) contribs.push(`${row.guidelines.length} guideline${row.guidelines.length === 1 ? '' : 's'}`);
      if (row.setupPrompt) contribs.push('setup prompt');
      if (contribs.length) {
        const c = document.createElement('div');
        c.className = 'pl-contribs';
        for (const label of contribs) {
          const tag = document.createElement('span');
          tag.className = 'pl-contrib';
          tag.textContent = label;
          c.appendChild(tag);
        }
        li.appendChild(c);
      }

      if (row.errors?.length) {
        const errs = document.createElement('div');
        errs.className = 'pl-errors';
        errs.textContent = row.errors.join('; ');
        li.appendChild(errs);
      }

      if (row.crashTail) {
        const details = document.createElement('details');
        details.className = 'pl-tail';
        const summary = document.createElement('summary');
        summary.textContent = 'Crash output';
        const pre = document.createElement('pre');
        pre.textContent = row.crashTail;
        details.append(summary, pre);
        li.appendChild(details);
      }

      const actions = document.createElement('div');
      actions.className = 'pl-actions st-actions';
      const usable = !['invalid', 'incompatible', 'conflict'].includes(row.state);
      if (usable) {
        if (!row.enabled) {
          actions.appendChild(btn('Enable', () => act(`Enabling ${row.id}`, () => api('POST', `/api/plugins/${row.id}/enable`))));
        } else {
          // A backendless (conventions-only) plugin has no process lifecycle —
          // no Start/Stop/version, only Disable.
          if (row.hasBackend) {
            if (row.state === 'ready' || row.state === 'starting') {
              actions.appendChild(btn('Stop', () => act(`Stopping ${row.id}`, () => api('POST', `/api/plugins/${row.id}/stop`))));
            } else {
              actions.appendChild(btn('Start', () => act(`Starting ${row.id}`, () => api('POST', `/api/plugins/${row.id}/start`))));
            }
          }
          actions.appendChild(btn('Disable', () => act(`Disabling ${row.id}`, () => api('POST', `/api/plugins/${row.id}/disable`))));
          if (row.hasBackend) actions.appendChild(versionSelect(row, worktrees[row.project] || []));
        }
      }
      if (actions.childElementCount > 0) li.appendChild(actions);
      listEl.appendChild(li);
    }
  }

  function btn(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function versionSelect(row, worktreeNames) {
    const sel = document.createElement('select');
    sel.className = 'pl-version';
    sel.title = 'Active version — which checkout the plugin runs from';
    const main = document.createElement('option');
    main.value = 'main';
    main.textContent = 'main';
    sel.appendChild(main);
    for (const w of worktreeNames) {
      const opt = document.createElement('option');
      opt.value = `worktree:${w}`;
      opt.textContent = `worktree ${w}`;
      sel.appendChild(opt);
    }
    const v = row.activeVersion || { type: 'main' };
    sel.value = v.type === 'worktree' ? `worktree:${v.name}` : 'main';
    if (sel.value === '') sel.value = 'main'; // active worktree vanished
    sel.addEventListener('change', () => {
      const val = sel.value;
      const body = val === 'main' ? { type: 'main' } : { type: 'worktree', name: val.slice('worktree:'.length) };
      act(`Switching ${row.id} to ${val}`, () => api('POST', `/api/plugins/${row.id}/version`, body));
    });
    return sel;
  }

  async function load() {
    try {
      const [rows, worktrees] = await Promise.all([api('GET', '/api/plugins'), fetchWorktrees()]);
      render(rows, worktrees);
    } catch (e) {
      setStatus(`Failed to load plugins: ${e.message || e}`, true);
    }
  }

  rescanBtn?.addEventListener('click', () => act('Rescanning', () => api('POST', '/api/plugins/rescan')));

  return { load };
}
