// Settings page — a full-page view inside #main, shown when the URL hash is
// `#settings`. Built as a group-nav + content scaffold; the only group today
// is Transcribe (whisper.cpp install + model picker). Future groups add a
// nav item + a panel and hang off loadGroup().
//
// Navigation is hash-driven so a refresh keeps the page. app.js owns the
// hash (it knows the active session to restore on close) and passes a
// `requestClose` callback; we just translate hashchange into show/hide.

const POLL_MS = 1500;

export function installSettings({ requestClose, onAvailabilityChange } = {}) {
  const main = document.getElementById('main');
  const view = document.getElementById('settings-view');
  const closeBtn = document.getElementById('settings-close');
  const statusEl = document.getElementById('st-status');
  const listEl = document.getElementById('st-model-list');
  const installBtn = document.getElementById('st-install-btn');
  const hintEl = document.getElementById('st-action-hint');
  const logEl = document.getElementById('st-install-log');
  if (!view) return { open() {}, close() {} };

  let isOpen = false;
  let selected = null;     // model name highlighted by the user
  let installing = false;  // an install is in flight (controls disabled)
  let installTarget = null; // model the Install button would install

  function show() {
    if (isOpen) return;
    isOpen = true;
    main.classList.add('settings-open');
    view.hidden = false;
    load();
  }

  function hide() {
    if (!isOpen) return;
    isOpen = false;
    main.classList.remove('settings-open');
    view.hidden = true;
  }

  // hash → visibility
  function sync() {
    if (location.hash === '#settings') show();
    else hide();
  }

  function close() {
    hide();
    requestClose?.();
  }

  closeBtn?.addEventListener('click', () => { close(); });

  async function load() {
    try {
      const r = await fetch('/api/settings/transcribe', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      render(data);
      // If an install is mid-flight (e.g. we re-opened the page), resume polling.
      if (data.install?.running && !installing) beginPoll();
    } catch (e) {
      statusEl.textContent = `Failed to load settings: ${e.message || e}`;
    }
  }

  function render(data) {
    const models = data.models || [];
    const active = data.activeModel;
    const activeLabel = models.find(m => m.name === active)?.label;

    if (data.available) {
      statusEl.innerHTML = `<span class="st-ok">✓ Whisper available</span>` +
        (activeLabel ? ` — active model: <strong>${activeLabel}</strong>` : '');
    } else {
      statusEl.innerHTML = `<span class="st-warn">Whisper not installed</span> — pick a model and install it.`;
    }

    listEl.innerHTML = '';
    for (const m of models) {
      const li = document.createElement('li');
      li.className = 'st-model-row';
      const isActive = m.name === active && m.installed;
      if (isActive) li.classList.add('active');
      if (m.name === selected) li.classList.add('selected');
      li.dataset.model = m.name;

      const main2 = document.createElement('div');
      main2.className = 'st-model-main';
      main2.innerHTML = `<span class="st-model-label">${m.label}</span>` +
        `<span class="st-model-size">${m.sizeLabel}</span>`;
      li.appendChild(main2);

      const badge = document.createElement('span');
      badge.className = 'st-badge';
      if (isActive) { badge.textContent = 'active'; badge.classList.add('badge-active'); }
      else if (m.installed) { badge.textContent = 'installed'; badge.classList.add('badge-installed'); }
      else { badge.textContent = 'not installed'; badge.classList.add('badge-missing'); }
      li.appendChild(badge);

      if (!installing) li.addEventListener('click', () => onPick(m));
      listEl.appendChild(li);
    }

    // Action area reflects the current selection.
    const sel = models.find(m => m.name === selected);
    installBtn.disabled = installing;
    if (!sel) {
      installBtn.hidden = true;
      hintEl.textContent = installing ? 'Installing…' : '';
    } else if (sel.installed) {
      installBtn.hidden = true;
      hintEl.textContent = sel.name === active ? '' : 'Switching…';
    } else {
      installTarget = sel.name;
      installBtn.hidden = false;
      installBtn.textContent = `Install ${sel.label} (${sel.sizeLabel})`;
      hintEl.textContent = 'First install also builds whisper.cpp from source — can take several minutes.';
    }
  }

  async function onPick(m) {
    if (installing) return;
    selected = m.name;
    if (m.installed) {
      // Switch the active model immediately.
      try {
        const r = await fetch('/api/settings/transcribe/model', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: m.name }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        selected = null;
        render(data);
        onAvailabilityChange?.(data.available);
      } catch (e) {
        hintEl.textContent = `Switch failed: ${e.message || e}`;
      }
    } else {
      // Just highlight + reveal Install; re-render to update the action area.
      load();
    }
  }

  installBtn?.addEventListener('click', async () => {
    if (installing || !installTarget) return;
    const model = installTarget;
    logEl.hidden = false;
    logEl.textContent = '';
    try {
      const r = await fetch('/api/settings/transcribe/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (r.status === 409) { hintEl.textContent = 'An install is already running.'; }
      else if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
      beginPoll();
    } catch (e) {
      hintEl.textContent = `Install failed to start: ${e.message || e}`;
    }
  });

  function beginPoll() {
    installing = true;
    selected = null;
    render({ models: [] }); // disable controls; full state refreshes on next poll
    poll();
  }

  async function poll() {
    let s;
    try {
      const r = await fetch('/api/settings/transcribe/install/status', { cache: 'no-store' });
      s = await r.json();
    } catch {
      // transient — retry
      setTimeout(poll, POLL_MS);
      return;
    }
    logEl.hidden = false;
    logEl.textContent = s.log || '';
    logEl.scrollTop = logEl.scrollHeight;
    if (s.running) {
      setTimeout(poll, POLL_MS);
    } else {
      installing = false;
      await load(); // refresh model list + active + availability
      // mic visibility is refreshed inside onPick/load via onAvailabilityChange;
      // do an explicit check here too since this path didn't go through a switch.
      try {
        const r = await fetch('/api/settings/transcribe', { cache: 'no-store' });
        const data = await r.json();
        onAvailabilityChange?.(data.available);
      } catch { /* ignore */ }
    }
  }

  window.addEventListener('hashchange', sync);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen) close();
  });
  sync(); // honour an initial #settings on load

  return { open: () => { location.hash = '#settings'; }, close };
}
