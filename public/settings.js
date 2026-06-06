// Settings page — a full-page view inside #main, shown when the URL hash is
// `#settings`. Built as a group-nav + content scaffold; the only group today
// is Transcribe (whisper.cpp install + model picker). Future groups add a
// nav item + a panel and hang off loadGroup().
//
// Navigation is hash-driven so a refresh keeps the page. app.js owns the
// hash (it knows the active session to restore on close) and passes a
// `requestClose` callback; we just translate hashchange into show/hide.

const POLL_MS = 1500;

export function installSettings({
  requestClose, onAvailabilityChange, onModelsChange,
  onTtsAvailabilityChange, onTtsPrefsChange,
} = {}) {
  const main = document.getElementById('main');
  const view = document.getElementById('settings-view');
  const groupSelect = document.getElementById('settings-group-select');
  const statusEl = document.getElementById('st-status');
  const listEl = document.getElementById('st-model-list');
  const installBtn = document.getElementById('st-install-btn');
  const hintEl = document.getElementById('st-action-hint');
  const logEl = document.getElementById('st-install-log');
  const groups = [...view?.querySelectorAll('.settings-group') || []];
  // Models group elements.
  const smStatusEl = document.getElementById('sm-status');
  const smListEl = document.getElementById('sm-family-list');
  const smAutoStopEl = document.getElementById('sm-auto-stop');
  const smCompactWindowEnabledEl = document.getElementById('sm-compact-window-enabled');
  const smCompactWindowRowEl     = document.getElementById('sm-compact-window-row');
  const smCompactWindowSliderEl  = document.getElementById('sm-compact-window');
  const smCompactWindowValEl     = document.getElementById('sm-compact-window-val');
  const smSonnetCtxRadios        = view?.querySelectorAll('input[name="sm-sonnet-ctx"]');
  // TTS group elements.
  const ttStatusEl = document.getElementById('tt-status');
  const ttListEl = document.getElementById('tt-voice-list');
  const ttInstallBtn = document.getElementById('tt-install-btn');
  const ttHintEl = document.getElementById('tt-action-hint');
  const ttLogEl = document.getElementById('tt-install-log');
  const ttEnabledEl = document.getElementById('tt-enabled');
  const ttRateEl = document.getElementById('tt-rate');
  const ttRateValEl = document.getElementById('tt-rate-val');
  // Workspace conventions (root CLAUDE.md) group elements.
  const wcStatusEl = document.getElementById('wc-status');
  const wcKeepBtn = document.getElementById('wc-keep');
  const wcOverwriteBtn = document.getElementById('wc-overwrite');
  const wcHintEl = document.getElementById('wc-action-hint');
  const wcDiffEl = document.getElementById('wc-diff');
  if (!view) return { open() {}, close() {} };

  let isOpen = false;
  let selected = null;     // model name highlighted by the user
  let installing = false;  // an install is in flight (controls disabled)
  let installTarget = null; // model the Install button would install
  // TTS group state (independent of the transcribe install state above).
  let ttSelected = null;
  let ttInstalling = false;
  let ttInstallTarget = null;

  // ── Group nav ───────────────────────────────────────────────────────
  function showGroup(group) {
    for (const g of groups) g.hidden = g.id !== `settings-${group}`;
    if (groupSelect) groupSelect.value = group;
  }
  groupSelect?.addEventListener('change', () => showGroup(groupSelect.value));

  function show() {
    if (isOpen) return;
    isOpen = true;
    main.classList.add('settings-open');
    view.hidden = false;
    load();
    loadModels();
    loadTts();
    loadWorkspace();
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

  // ── Models group ────────────────────────────────────────────────────
  async function loadModels() {
    if (!smListEl) return;
    try {
      const r = await fetch('/api/settings/models', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      renderModels(await r.json());
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Failed to load models: ${e.message || e}`;
    }
  }

  function renderModels(data) {
    const families = data.families || [];
    const active = data.active || {};
    if (smStatusEl) {
      smStatusEl.innerHTML = families
        .map(f => `${f.label}: <strong>${labelFor(f, active[f.family])}</strong>`)
        .join(' · ');
    }
    smListEl.innerHTML = '';
    for (const f of families) {
      const li = document.createElement('li');
      li.className = 'sm-family-row';

      const label = document.createElement('span');
      label.className = 'sm-family-label';
      label.textContent = f.label;
      li.appendChild(label);

      const sel = document.createElement('select');
      sel.className = 'sm-version';
      sel.dataset.family = f.family;
      for (const v of f.versions) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.label;
        if (v.id === active[f.family]) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.disabled = f.versions.length < 2;
      sel.addEventListener('change', () => onPickVersion(f.family, sel.value));
      li.appendChild(sel);

      smListEl.appendChild(li);
    }
    if (smAutoStopEl) smAutoStopEl.checked = data.autoStopOnOverage ?? false;
    if (smCompactWindowEnabledEl) {
      const cw = data.conductorCompactWindow ?? { enabled: false, value: 200 };
      smCompactWindowEnabledEl.checked = cw.enabled;
      if (smCompactWindowSliderEl) smCompactWindowSliderEl.value = String(cw.value);
      if (smCompactWindowValEl)    smCompactWindowValEl.textContent = `${cw.value}k`;
      if (smCompactWindowRowEl)    smCompactWindowRowEl.hidden = !cw.enabled;
    }
    const scw = data.sonnetContextWindow ?? '1m';
    smSonnetCtxRadios?.forEach(r => { r.checked = (r.value === scw); });
    document.querySelectorAll('.qs-sonnet-ctx').forEach(el => {
      el.textContent = scw === '200k' ? '200k' : '1M';
    });
  }

  function labelFor(family, id) {
    return family.versions.find(v => v.id === id)?.label || id;
  }

  async function onPickVersion(family, version) {
    try {
      const r = await fetch('/api/settings/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ family, version }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data.active);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Switch failed: ${e.message || e}`;
    }
  }

  smAutoStopEl?.addEventListener('change', () => onPickAutoStop(smAutoStopEl.checked));

  async function onPickAutoStop(enabled) {
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoStopOnOverage: enabled }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Update failed: ${e.message || e}`;
    }
  }

  smCompactWindowEnabledEl?.addEventListener('change', () => {
    if (smCompactWindowRowEl) smCompactWindowRowEl.hidden = !smCompactWindowEnabledEl.checked;
    onSaveCompactWindow();
  });
  smCompactWindowSliderEl?.addEventListener('input', () => {
    if (smCompactWindowValEl) smCompactWindowValEl.textContent = `${smCompactWindowSliderEl.value}k`;
  });
  smCompactWindowSliderEl?.addEventListener('change', onSaveCompactWindow);

  async function onSaveCompactWindow() {
    const enabled = smCompactWindowEnabledEl?.checked ?? false;
    const value   = Number(smCompactWindowSliderEl?.value ?? 200);
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conductorCompactWindow: { enabled, value } }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Update failed: ${e.message || e}`;
    }
  }

  smSonnetCtxRadios?.forEach(radio => radio.addEventListener('change', () => {
    if (radio.checked) onPickSonnetWindow(radio.value);
  }));

  async function onPickSonnetWindow(val) {
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sonnetContextWindow: val }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data.active);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Update failed: ${e.message || e}`;
    }
  }

  // ── TTS group ───────────────────────────────────────────────────────
  async function loadTts() {
    if (!ttListEl) return;
    try {
      const r = await fetch('/api/settings/tts', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      renderTts(data);
      if (data.install?.running && !ttInstalling) ttBeginPoll();
    } catch (e) {
      if (ttStatusEl) ttStatusEl.textContent = `Failed to load TTS settings: ${e.message || e}`;
    }
  }

  function renderTts(data) {
    const voices = data.voices || [];
    const active = data.activeVoice;
    const activeLabel = voices.find(v => v.name === active)?.label;

    if (data.available) {
      ttStatusEl.innerHTML = `<span class="st-ok">✓ TTS available</span>` +
        (activeLabel ? ` — active voice: <strong>${activeLabel}</strong>` : '');
    } else {
      ttStatusEl.innerHTML = `<span class="st-warn">Piper not installed</span> — pick a voice and install it.`;
    }

    // Prefs (only refresh from data when present — beginPoll passes a stub).
    if (data.enabled !== undefined && ttEnabledEl) ttEnabledEl.checked = !!data.enabled;
    if (data.rate !== undefined && ttRateEl) {
      ttRateEl.value = String(data.rate);
      if (ttRateValEl) ttRateValEl.textContent = `${Number(data.rate).toFixed(2)}×`;
    }
    if (ttEnabledEl) ttEnabledEl.disabled = !data.available;

    ttListEl.innerHTML = '';
    for (const v of voices) {
      const li = document.createElement('li');
      li.className = 'st-model-row';
      const isActive = v.name === active && v.installed;
      if (isActive) li.classList.add('active');
      if (v.name === ttSelected) li.classList.add('selected');
      li.dataset.voice = v.name;

      const main2 = document.createElement('div');
      main2.className = 'st-model-main';
      main2.innerHTML = `<span class="st-model-label">${v.label}</span>` +
        `<span class="st-model-size">${v.sizeLabel}</span>`;
      li.appendChild(main2);

      const badge = document.createElement('span');
      badge.className = 'st-badge';
      if (isActive) { badge.textContent = 'active'; badge.classList.add('badge-active'); }
      else if (v.installed) { badge.textContent = 'installed'; badge.classList.add('badge-installed'); }
      else { badge.textContent = 'not installed'; badge.classList.add('badge-missing'); }
      li.appendChild(badge);

      if (!ttInstalling) li.addEventListener('click', () => onPickVoice(v));
      ttListEl.appendChild(li);
    }

    const sel = voices.find(v => v.name === ttSelected);
    if (ttInstallBtn) ttInstallBtn.disabled = ttInstalling;
    if (!sel) {
      if (ttInstallBtn) ttInstallBtn.hidden = true;
      if (ttHintEl) ttHintEl.textContent = ttInstalling ? 'Installing…' : '';
    } else if (sel.installed) {
      if (ttInstallBtn) ttInstallBtn.hidden = true;
      if (ttHintEl) ttHintEl.textContent = sel.name === active ? '' : 'Switching…';
    } else {
      ttInstallTarget = sel.name;
      if (ttInstallBtn) { ttInstallBtn.hidden = false; ttInstallBtn.textContent = `Install ${sel.label} (${sel.sizeLabel})`; }
      if (ttHintEl) ttHintEl.textContent = 'First install also builds Piper from source — can take several minutes.';
    }
  }

  async function onPickVoice(v) {
    if (ttInstalling) return;
    ttSelected = v.name;
    if (v.installed) {
      try {
        const r = await fetch('/api/settings/tts/voice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voice: v.name }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        ttSelected = null;
        renderTts(data);
        onTtsAvailabilityChange?.(data.available);
      } catch (e) {
        if (ttHintEl) ttHintEl.textContent = `Switch failed: ${e.message || e}`;
      }
    } else {
      loadTts();
    }
  }

  ttInstallBtn?.addEventListener('click', async () => {
    if (ttInstalling || !ttInstallTarget) return;
    const voice = ttInstallTarget;
    ttLogEl.hidden = false;
    ttLogEl.textContent = '';
    try {
      const r = await fetch('/api/settings/tts/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voice }),
      });
      if (r.status === 409) { if (ttHintEl) ttHintEl.textContent = 'An install is already running.'; }
      else if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
      ttBeginPoll();
    } catch (e) {
      if (ttHintEl) ttHintEl.textContent = `Install failed to start: ${e.message || e}`;
    }
  });

  function ttBeginPoll() {
    ttInstalling = true;
    ttSelected = null;
    renderTts({ voices: [] });
    ttPoll();
  }

  async function ttPoll() {
    let s;
    try {
      const r = await fetch('/api/settings/tts/install/status', { cache: 'no-store' });
      s = await r.json();
    } catch {
      setTimeout(ttPoll, POLL_MS);
      return;
    }
    ttLogEl.hidden = false;
    ttLogEl.textContent = s.log || '';
    ttLogEl.scrollTop = ttLogEl.scrollHeight;
    if (s.running) {
      setTimeout(ttPoll, POLL_MS);
    } else {
      ttInstalling = false;
      await loadTts();
      try {
        const r = await fetch('/api/settings/tts', { cache: 'no-store' });
        const data = await r.json();
        onTtsAvailabilityChange?.(data.available);
      } catch { /* ignore */ }
    }
  }

  async function savePrefs(patch) {
    try {
      const r = await fetch('/api/settings/tts/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      onTtsPrefsChange?.({ enabled: data.enabled, rate: data.rate });
    } catch (e) {
      if (ttHintEl) ttHintEl.textContent = `Save failed: ${e.message || e}`;
    }
  }

  ttEnabledEl?.addEventListener('change', () => savePrefs({ enabled: ttEnabledEl.checked }));
  ttRateEl?.addEventListener('input', () => {
    if (ttRateValEl) ttRateValEl.textContent = `${Number(ttRateEl.value).toFixed(2)}×`;
  });
  ttRateEl?.addEventListener('change', () => savePrefs({ rate: Number(ttRateEl.value) }));

  // ── Workspace conventions group (root CLAUDE.md) ────────────────────────
  const WC_STATUS_LABEL = {
    'created': '✓ created — canonical copied in',
    'up-to-date': '✓ up to date',
    'updated': '✓ updated to the latest canonical',
    'kept': '✓ your edits kept (canonical unchanged)',
    'conflict': 'conflict — your copy and the canonical have both changed',
  };

  async function loadWorkspace() {
    if (!wcStatusEl) return;
    try {
      const r = await fetch('/api/settings/workspace-claudemd', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await renderWorkspace(await r.json());
    } catch (e) {
      wcStatusEl.textContent = `Failed to load: ${e.message || e}`;
    }
  }

  async function renderWorkspace(data) {
    const label = WC_STATUS_LABEL[data.status] || data.status || 'unknown';
    if (data.conflict) {
      wcStatusEl.innerHTML = `<span class="st-warn">${label}</span>`;
    } else {
      wcStatusEl.innerHTML = `<span class="st-ok">${label}</span>`;
    }

    if (data.conflict) {
      if (wcKeepBtn) wcKeepBtn.hidden = false;
      if (wcOverwriteBtn) wcOverwriteBtn.hidden = false;
      if (wcHintEl) wcHintEl.textContent = '';
      // Fetch and show the unified diff (your copy vs canonical).
      try {
        const dr = await fetch('/api/settings/workspace-claudemd/diff', { cache: 'no-store' });
        const dd = await dr.json();
        if (wcDiffEl) { wcDiffEl.textContent = dd.diff || ''; wcDiffEl.hidden = !dd.diff; }
      } catch {
        if (wcDiffEl) wcDiffEl.hidden = true;
      }
    } else {
      if (wcKeepBtn) wcKeepBtn.hidden = true;
      if (wcOverwriteBtn) wcOverwriteBtn.hidden = true;
      if (wcDiffEl) { wcDiffEl.hidden = true; wcDiffEl.textContent = ''; }
      if (wcHintEl) wcHintEl.textContent = '';
    }
  }

  async function resolveWorkspace(action) {
    if (wcKeepBtn) wcKeepBtn.disabled = true;
    if (wcOverwriteBtn) wcOverwriteBtn.disabled = true;
    if (wcHintEl) wcHintEl.textContent = 'Resolving…';
    try {
      const r = await fetch('/api/settings/workspace-claudemd/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      await renderWorkspace(data);
    } catch (e) {
      if (wcHintEl) wcHintEl.textContent = `Failed: ${e.message || e}`;
    } finally {
      if (wcKeepBtn) wcKeepBtn.disabled = false;
      if (wcOverwriteBtn) wcOverwriteBtn.disabled = false;
    }
  }

  wcKeepBtn?.addEventListener('click', () => resolveWorkspace('keep'));
  wcOverwriteBtn?.addEventListener('click', () => resolveWorkspace('overwrite'));

  window.addEventListener('hashchange', sync);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen) close();
  });
  sync(); // honour an initial #settings on load

  return { open: () => { location.hash = '#settings'; }, close };
}
