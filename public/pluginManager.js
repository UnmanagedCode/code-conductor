// "Plugins" group in the settings view — a management list over
// GET /api/plugins with immediate lifecycle actions (enable/disable/
// start/stop; staged-Apply is only for value edits, which this group has
// none of), a crash-tail expander, and an active-version dropdown (main +
// the project's worktrees from /api/projects). Below it, the Plugin
// Library: a catalog of installable plugins (GET /api/plugins/library)
// with a clone-to-install action (POST .../library/:id/install) — install
// only clones the repo, it never enables/starts it. installed once by
// settings.js, which calls load() on every settings open.

export function installPluginManager({ onCatalogChange } = {}) {
  const statusEl = document.getElementById('pl-status');
  const listEl = document.getElementById('pl-list');
  const rescanBtn = document.getElementById('pl-rescan-btn');
  const libraryStatusEl = document.getElementById('pll-status');
  const libraryListEl = document.getElementById('pll-list');
  const libraryTailEl = document.getElementById('pll-tail');
  const libraryTailPre = document.getElementById('pll-tail-pre');
  if (!listEl) return { load() {} };

  let busy = false;

  function setStatusEl(el, text, isError = false) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('pl-status-err', isError);
  }

  function setStatus(text, isError = false) {
    setStatusEl(statusEl, text, isError);
  }

  function clearLibraryTail() {
    if (!libraryTailEl) return;
    libraryTailEl.hidden = true;
    if (libraryTailPre) libraryTailPre.textContent = '';
  }

  function showLibraryTail(text) {
    if (!libraryTailEl) return;
    if (libraryTailPre) libraryTailPre.textContent = text;
    libraryTailEl.hidden = false;
  }

  async function api(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || `HTTP ${r.status}`);
      if (data.tail) err.tail = data.tail;
      throw err;
    }
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
        if (row.stale) bits.push('update available');
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
      if (row.conventions?.length) contribs.push(`${row.conventions.length} project convention${row.conventions.length === 1 ? '' : 's'}`);
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
      // Per-convention preview (name — what it does, + "scaffolds" when it carries
      // a one-time scaffold directive) so the user sees what enabling adds.
      if (row.conventions?.length) {
        const prev = document.createElement('ul');
        prev.className = 'pl-scaffold-preview';
        for (const conv of row.conventions) {
          const item = document.createElement('li');
          const n = document.createElement('span');
          n.className = 'pl-scaffold-name';
          n.textContent = conv.hasScaffold ? `${conv.name} · scaffolds` : conv.name;
          const d = document.createElement('span');
          d.className = 'pl-scaffold-desc';
          d.textContent = conv.description;
          item.append(n, d);
          prev.appendChild(item);
        }
        li.appendChild(prev);
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
              if (row.state === 'ready' && row.stale) {
                actions.appendChild(btn('Restart', () => act(`Restarting ${row.id}`, () => api('POST', `/api/plugins/${row.id}/restart`))));
              }
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

  function renderLibrary(rows) {
    if (!libraryListEl) return;
    libraryListEl.innerHTML = '';
    if (rows.length === 0) {
      setStatusEl(libraryStatusEl, 'No library entries.');
      return;
    }
    setStatusEl(libraryStatusEl, `${rows.length} available`);
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'pll-row';

      const head = document.createElement('div');
      head.className = 'pll-row-head';
      const name = document.createElement('span');
      name.className = 'pll-name';
      name.textContent = row.name;
      head.appendChild(name);
      if (row.installed) {
        const badge = document.createElement('span');
        badge.className = 'pl-badge pl-badge-enabled';
        badge.textContent = 'installed';
        head.appendChild(badge);
      }
      li.appendChild(head);

      if (row.description) {
        const desc = document.createElement('div');
        desc.className = 'pll-desc';
        desc.textContent = row.description;
        li.appendChild(desc);
      }

      const repo = document.createElement('div');
      repo.className = 'pll-repo';
      repo.textContent = row.repo;
      li.appendChild(repo);

      const actions = document.createElement('div');
      actions.className = 'pll-actions st-actions';
      if (row.installed) {
        const span = document.createElement('span');
        span.className = 'pll-installed-as';
        span.textContent = `installed as ${row.installedAs}`;
        actions.appendChild(span);
        actions.appendChild(btn('Update', () => updateEntry(row)));
      } else {
        actions.appendChild(btn('Install', () => installEntry(row)));
      }
      li.appendChild(actions);

      libraryListEl.appendChild(li);
    }
  }

  // A postClone/postPull hook failure is reported by the server as a soft
  // warning on an otherwise-successful response (never thrown) — the clone/
  // pull itself succeeded, only the convenience command failed. Surfaced
  // AFTER load() so it isn't clobbered by render()'s own status text.
  function reportHookWarning(name, verb, hookLabel, hookResult) {
    if (!hookResult?.ran || hookResult.ok) return;
    setStatusEl(libraryStatusEl, `${verb} ${name}, but its ${hookLabel} command failed`, true);
    showLibraryTail(hookResult.tail);
  }

  async function installEntry(row) {
    if (busy) return;
    busy = true;
    setStatusEl(libraryStatusEl, `Installing ${row.name}…`);
    clearLibraryTail();
    try {
      const result = await api('POST', `/api/plugins/library/${row.id}/install`);
      await load();
      onCatalogChange?.();
      reportHookWarning(row.name, 'Installed', 'post-install', result.postClone);
    } catch (e) {
      setStatusEl(libraryStatusEl, `Installing ${row.name} failed: ${e.message || e}`, true);
      if (e.tail) showLibraryTail(e.tail);
      busy = false;
      return;
    }
    busy = false;
  }

  async function updateEntry(row) {
    if (busy) return;
    busy = true;
    setStatusEl(libraryStatusEl, `Updating ${row.name}…`);
    clearLibraryTail();
    try {
      const result = await api('POST', `/api/plugins/library/${row.id}/update`);
      await load();
      onCatalogChange?.();
      reportHookWarning(row.name, 'Updated', 'post-update', result.postPull);
    } catch (e) {
      setStatusEl(libraryStatusEl, `Updating ${row.name} failed: ${e.message || e}`, true);
      if (e.tail) showLibraryTail(e.tail);
      busy = false;
      return;
    }
    busy = false;
  }

  async function load() {
    try {
      const [rows, worktrees, libraryRows] = await Promise.all([
        api('GET', '/api/plugins'), fetchWorktrees(), api('GET', '/api/plugins/library'),
      ]);
      render(rows, worktrees);
      renderLibrary(libraryRows);
    } catch (e) {
      setStatus(`Failed to load plugins: ${e.message || e}`, true);
    }
  }

  rescanBtn?.addEventListener('click', () => act('Rescanning', () => api('POST', '/api/plugins/rescan')));

  return { load };
}
