// "Plugins" group in the settings view — a management list over
// GET /api/plugins with immediate lifecycle actions (enable/disable/
// start/stop; staged-Apply is only for value edits, which this group has
// none of), a crash-tail expander, and an active-version dropdown (main +
// the project's worktrees from /api/projects). Below it, the Plugin
// Library: a catalog of installable plugins (GET /api/plugins/library)
// with a clone-to-install action (POST .../library/:id/install), per-entry
// Update, and an Update all that runs every available update sequentially —
// install only clones the repo, it never enables/starts it. installed once by
// settings.js, which calls load() on every settings open.

export function installPluginManager({ onCatalogChange } = {}) {
  const statusEl = document.getElementById('pl-status');
  const listEl = document.getElementById('pl-list');
  const rescanBtn = document.getElementById('pl-rescan-btn');
  const libraryStatusEl = document.getElementById('pll-status');
  const libraryListEl = document.getElementById('pll-list');
  const libraryTailEl = document.getElementById('pll-tail');
  const libraryTailPre = document.getElementById('pll-tail-pre');
  const updateAllBtn = document.getElementById('pll-update-all-btn');
  if (!listEl) return { load() {} };

  let busy = false;
  // The rendered rows that carry an Update button ({row, li, button}) —
  // exactly what Update all runs over.
  let updatables = [];
  // Set for the length of an Update all run, so a mid-run load() (settings
  // re-open) can't re-arm the button.
  let updatingAll = false;

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

  const LIVE_OUTPUT_CAP = 8 * 1024;

  // Install/update POST responses either stay a single plain JSON body (a
  // validation failure the server caught before starting any work — same
  // shape/errors as api() above) or switch to NDJSON chunk/result lines once
  // real work (clone/pull/hook) starts. onChunk(text) is called live as
  // output streams in; the resolved value is the final `result` payload
  // (same shape api()'s POST calls used to return), or throws an Error
  // (with .tail if present) on a post-validation failure.
  async function streamAction(method, path, onChunk) {
    const r = await fetch(path, { method, cache: 'no-store' });
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('ndjson')) {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(data.error || `HTTP ${r.status}`);
        if (data.tail) err.tail = data.tail;
        throw err;
      }
      return data;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalResult = null;
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const evt = JSON.parse(line);
        if (evt.type === 'chunk') onChunk(evt.text);
        else if (evt.type === 'result') finalResult = evt;
      }
      if (done) break;
    }
    if (!finalResult) throw new Error('stream ended unexpectedly');
    if (!finalResult.ok) {
      const err = new Error(finalResult.error || 'operation failed');
      if (finalResult.tail) err.tail = finalResult.tail;
      throw err;
    }
    return finalResult.result;
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
      if (row.roles?.length) contribs.push(`${row.roles.length} role${row.roles.length === 1 ? '' : 's'}`);
      if (row.playbooks?.length) contribs.push(`${row.playbooks.length} playbook${row.playbooks.length === 1 ? '' : 's'}`);
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
          const enableBtn = btn('Enable', () => act(`Enabling ${row.id}`, () => api('POST', `/api/plugins/${row.id}/enable`)));
          enableBtn.className = 'pl-toggle-enable';
          actions.appendChild(enableBtn);
        } else {
          // A backendless (conventions-only) plugin has no process lifecycle —
          // no Start/Stop/version, only Disable.
          const actionsRow = document.createElement('div');
          actionsRow.className = 'pl-actions-row';
          // BUCKET 3: capabilities that only run on the machine cc runs on. The
          // server returns these same codes; the control is hidden rather than
          // offered, because a button whose only outcome is a refusal teaches
          // nothing except that cc is broken.
          const localOnly = Array.isArray(row.localOnly) ? row.localOnly : [];
          const backendLocalOnly = localOnly.includes('PLUGIN_BACKEND_LOCAL_ONLY');
          if (row.hasBackend && !backendLocalOnly) {
            if (row.state === 'ready' || row.state === 'starting') {
              actionsRow.appendChild(btn('Stop', () => act(`Stopping ${row.id}`, () => api('POST', `/api/plugins/${row.id}/stop`))));
              if (row.state === 'ready' && row.stale) {
                actionsRow.appendChild(btn('Restart', () => act(`Restarting ${row.id}`, () => api('POST', `/api/plugins/${row.id}/restart`))));
              }
            } else {
              actionsRow.appendChild(btn('Start', () => act(`Starting ${row.id}`, () => api('POST', `/api/plugins/${row.id}/start`))));
            }
            actionsRow.appendChild(versionSelect(row, worktrees[row.project] || []));
          }
          if (actionsRow.childElementCount > 0) actions.appendChild(actionsRow);
          if (localOnly.length > 0) {
            const note = document.createElement('div');
            note.className = 'pl-local-only';
            note.textContent = `on system '${row.system}': ${localOnly.join(', ')}`;
            note.title = 'these plugin capabilities run only on the machine code-conductor runs on';
            actions.appendChild(note);
          }
          const disableBtn = btn('Disable', () => act(`Disabling ${row.id}`, () => api('POST', `/api/plugins/${row.id}/disable`)));
          disableBtn.className = 'pl-toggle-disable';
          actions.appendChild(disableBtn);
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
    updatables = [];
    if (rows.length === 0) {
      setStatusEl(libraryStatusEl, 'No library entries.');
      syncUpdateAllBtn();
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
        span.textContent = row.updateAvailable
          ? `installed as ${row.installedAs}`
          : `installed as ${row.installedAs} · up to date`;
        actions.appendChild(span);
        if (row.updateAvailable) {
          const updateBtn = btn('Update', () => updateEntry(row, li, updateBtn));
          actions.appendChild(updateBtn);
          updatables.push({ row, li, button: updateBtn });
        }
      } else {
        const installBtn = btn('Install', () => installEntry(row, li, installBtn));
        actions.appendChild(installBtn);
      }
      li.appendChild(actions);

      libraryListEl.appendChild(li);
    }
    syncUpdateAllBtn();
  }

  function syncUpdateAllBtn() {
    if (!updateAllBtn || updatingAll) return;
    const n = updatables.length;
    updateAllBtn.disabled = n === 0;
    updateAllBtn.textContent = n ? `Update all (${n})` : 'Update all';
  }

  // Live output box for the row currently running install/update — created
  // on demand, appended after the row's actions, capped so a chatty hook
  // (npm install, browser-binary downloads) can't grow the DOM unbounded.
  function ensureLiveOutput(li) {
    let pre = li.querySelector('.pll-live');
    if (!pre) {
      pre = document.createElement('pre');
      pre.className = 'pll-live';
      li.appendChild(pre);
    }
    return pre;
  }

  function appendLive(pre, text) {
    pre.textContent += text;
    if (pre.textContent.length > LIVE_OUTPUT_CAP) pre.textContent = pre.textContent.slice(-LIVE_OUTPUT_CAP);
    pre.scrollTop = pre.scrollHeight;
  }

  // A postClone/postPull hook failure is reported by the server as a soft
  // warning on an otherwise-successful response (never thrown) — the clone/
  // pull itself succeeded, only the convenience command failed. Surfaced
  // AFTER load() so it isn't clobbered by render()'s own status text.
  function reportHookWarning(name, verb, hookLabel, hookResult) {
    if (!hookResult?.ran || hookResult.ok) return false;
    setStatusEl(libraryStatusEl, `${verb} ${name}, but its ${hookLabel} command failed`, true);
    showLibraryTail(hookResult.tail);
    return true;
  }

  async function installEntry(row, li, buttonEl) {
    if (busy) return;
    busy = true;
    buttonEl.disabled = true;
    buttonEl.textContent = 'Installing…';
    setStatusEl(libraryStatusEl, `Installing ${row.name}…`);
    clearLibraryTail();
    const livePre = ensureLiveOutput(li);
    try {
      const result = await streamAction('POST', `/api/plugins/library/${row.id}/install`, (text) => appendLive(livePre, text));
      await load();
      onCatalogChange?.();
      reportHookWarning(row.name, 'Installed', 'post-install', result.postClone);
    } catch (e) {
      buttonEl.disabled = false;
      buttonEl.textContent = 'Install';
      setStatusEl(libraryStatusEl, `Installing ${row.name} failed: ${e.message || e}`, true);
      if (e.tail) showLibraryTail(e.tail);
      busy = false;
      return;
    }
    busy = false;
  }

  // Streams one entry's update into its row's live box. Resolves to
  // {ok, result} or {ok:false, error, tail} — never throws, and leaves busy,
  // the status line and the reload to the caller.
  async function streamUpdate(row, li, buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Updating…';
    const livePre = ensureLiveOutput(li);
    try {
      const result = await streamAction('POST', `/api/plugins/library/${row.id}/update`, (text) => appendLive(livePre, text));
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message || String(e), tail: e.tail };
    }
  }

  // The soft warning a successful update carries ({text, tail?}), or null.
  // A failed post-update hook wins over a failed restart.
  function updateWarning(name, result) {
    const hookFailed = result.postPull?.ran && !result.postPull.ok;
    if (result.restarted?.skipped) {
      // Skipping is conditioned on that same hook failure — extend its
      // warning so the user also learns the backend itself was left alone,
      // not silently restarted into a half-built tree.
      return {
        text: `Updated ${name}, but its post-update command failed — its backend was left running the old code`,
        tail: hookFailed ? result.postPull.tail : undefined,
      };
    }
    if (hookFailed) return { text: `Updated ${name}, but its post-update command failed`, tail: result.postPull.tail };
    if (result.restarted && !result.restarted.ok) {
      return { text: `Updated ${name}, but restarting its backend failed: ${result.restarted.error}` };
    }
    return null;
  }

  async function updateEntry(row, li, buttonEl) {
    if (busy) return;
    busy = true;
    setStatusEl(libraryStatusEl, `Updating ${row.name}…`);
    clearLibraryTail();
    const outcome = await streamUpdate(row, li, buttonEl);
    if (outcome.ok) {
      await load();
      onCatalogChange?.();
      // Surfaced AFTER load() so it isn't clobbered by render()'s own status text.
      const warning = updateWarning(row.name, outcome.result);
      if (warning) {
        setStatusEl(libraryStatusEl, warning.text, true);
        if (warning.tail) showLibraryTail(warning.tail);
      }
    } else {
      buttonEl.disabled = false;
      buttonEl.textContent = 'Update';
      setStatusEl(libraryStatusEl, `Updating ${row.name} failed: ${outcome.error}`, true);
      if (outcome.tail) showLibraryTail(outcome.tail);
    }
    busy = false;
  }

  // One at a time: each update rescans the registry, restarts backends and
  // rewrites referencing projects' CONVENTIONS.md, and the server holds no
  // lock against a concurrent one.
  async function updateAll() {
    if (busy || updatables.length === 0) return;
    busy = true;
    updatingAll = true;
    const targets = updatables.slice();
    const n = targets.length;
    updateAllBtn.disabled = true;
    for (const b of libraryListEl.querySelectorAll('button')) b.disabled = true;
    clearLibraryTail();
    const outcomes = [];
    for (const [i, { row, li, button }] of targets.entries()) {
      updateAllBtn.textContent = `Updating ${i + 1}/${n}…`;
      setStatusEl(libraryStatusEl, `Updating ${row.name} (${i + 1}/${n})…`);
      outcomes.push({ name: row.name, ...await streamUpdate(row, li, button) });
    }
    updatingAll = false;
    await load();
    const okCount = outcomes.filter(o => o.ok).length;
    if (okCount > 0) onCatalogChange?.();
    const problems = [];
    for (const o of outcomes) {
      if (!o.ok) {
        problems.push({ name: o.name, text: `${o.name} failed: ${o.error}`, tail: o.tail });
      } else {
        const warning = updateWarning(o.name, o.result);
        if (warning) problems.push({ name: o.name, text: warning.text, tail: warning.tail });
      }
    }
    setStatusEl(libraryStatusEl,
      `Updated ${okCount} of ${n} plugin${n === 1 ? '' : 's'}`
      + (problems.length ? ` — ${problems.map(p => p.text).join('; ')}` : ''),
      problems.length > 0);
    const tails = problems.filter(p => p.tail);
    // The reload dropped every row's live box, so the tails are collected here.
    if (tails.length) showLibraryTail(tails.map(p => `── ${p.name} ──\n${p.tail}`).join('\n\n'));
    busy = false;
  }

  async function load() {
    try {
      const [pluginsData, worktrees, libraryData] = await Promise.all([
        api('GET', '/api/plugins'), fetchWorktrees(), api('GET', '/api/plugins/library'),
      ]);
      render(pluginsData.rows, worktrees);
      renderLibrary(libraryData.entries);
      // Both status lines are written AFTER their render, which sets a count —
      // a load failure is the more important thing to be looking at.
      if (pluginsData.notices?.length) {
        setStatus(pluginsData.notices.map(n => `${n.file} was unreadable (${n.reason})`
          + (n.backup ? ` — moved aside to ${n.backup}; plugin enable/version state was reset` : '')).join(' · '), true);
      }
      if (libraryData.skipped?.length) {
        setStatusEl(libraryStatusEl,
          `Skipped ${libraryData.skipped.length} library drop-in(s): `
          + libraryData.skipped.map(s => (s.file === null
            ? `${s.dir} (${s.reason})`
            : `${s.dir}/${s.file} (${s.reason})`)).join(', '), true);
      }
    } catch (e) {
      setStatus(`Failed to load plugins: ${e.message || e}`, true);
    }
  }

  rescanBtn?.addEventListener('click', () => act('Rescanning', () => api('POST', '/api/plugins/rescan')));
  updateAllBtn?.addEventListener('click', () => updateAll());

  return { load };
}
