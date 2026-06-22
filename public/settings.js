// Settings page — a full-page view inside #main, shown when the URL hash is
// `#settings`. Built as a group-nav + content scaffold with four groups today:
// Transcribe, TTS, Models, and Workspace Conventions. Each adds a nav item +
// a panel hanging off loadGroup().
//
// Navigation is hash-driven so a refresh keeps the page. app.js owns the
// hash (it knows the active session to restore on close) and passes a
// `requestClose` callback; we just translate hashchange into show/hide.

import { formatAgo } from './sidebar.js';

const POLL_MS = 1500;

export function installSettings({
  requestClose, onAvailabilityChange, onModelsChange,
  onTtsAvailabilityChange, onTtsPrefsChange, onOpenCostDashboard,
  onArchivedChanged,
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
  const smOverageEl = document.getElementById('sm-overage');
  const smOverageBtns = [...(smOverageEl?.querySelectorAll('[data-overage]') || [])];
  const smCompactWindowEnabledEl = document.getElementById('sm-compact-window-enabled');
  const smCompactWindowRowEl     = document.getElementById('sm-compact-window-row');
  const smCompactWindowSliderEl  = document.getElementById('sm-compact-window');
  const smCompactWindowValEl     = document.getElementById('sm-compact-window-val');
  const smOverageThreshEnabledEl = document.getElementById('sm-overage-threshold-enabled');
  const smOverageThreshRowEl     = document.getElementById('sm-overage-threshold-row');
  const smOverageThreshSliderEl  = document.getElementById('sm-overage-threshold');
  const smOverageThreshValEl     = document.getElementById('sm-overage-threshold-val');
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
  // Archived group elements.
  const arStatusEl = document.getElementById('ar-status');
  const arListEl = document.getElementById('ar-list');
  // Optional rules group elements.
  const orStatusEl = document.getElementById('or-status');
  const orRuleListEl = document.getElementById('or-rule-list');
  const orAddBtn = document.getElementById('or-add-btn');
  const orAddForm = document.getElementById('or-add-form');
  const orAddSlug = document.getElementById('or-add-slug');
  const orAddName = document.getElementById('or-add-name');
  const orAddDesc = document.getElementById('or-add-desc');
  const orAddBody = document.getElementById('or-add-body');
  const orAddSave = document.getElementById('or-add-save');
  const orAddCancel = document.getElementById('or-add-cancel');
  const orAddError = document.getElementById('or-add-error');
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
    loadArchived();
    loadOptionalRules();
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
    const sonnetWindow = data.sonnetContextWindow ?? '1m';
    const enabledFamilies = data.enabledFamilies ?? {};
    const defaultFamily = data.defaultSpawnFamily ?? 'opus';
    const enabledCount = families.filter(f => enabledFamilies[f.family] !== false).length;

    if (smStatusEl) {
      smStatusEl.innerHTML = families.map(f => {
        const vLabel = labelFor(f, active[f.family]);
        const extra = f.family === 'sonnet'
          ? ` — ${sonnetWindow === '200k' ? '200k' : '1M'}`
          : '';
        const isDefault = f.family === defaultFamily;
        return `${f.label}: <strong>${vLabel}${extra}</strong>${isDefault ? ' <em>(default)</em>' : ''}`;
      }).join(' · ');
    }

    smListEl.innerHTML = '';
    for (const f of families) {
      const isEnabled = enabledFamilies[f.family] !== false;
      const isDefault = f.family === defaultFamily;
      const isLastEnabled = isEnabled && enabledCount === 1;

      const li = document.createElement('li');
      li.className = 'sm-family-row' + (isEnabled ? '' : ' sm-family-row--disabled');

      // Column 1: enable checkbox
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'sm-enable';
      chk.dataset.family = f.family;
      chk.checked = isEnabled;
      chk.disabled = isLastEnabled; // prevent disabling the last one
      chk.addEventListener('change', () => onPickFamilyEnabled(f.family, chk.checked));
      li.appendChild(chk);

      // Column 2: family label
      const labelEl = document.createElement('span');
      labelEl.className = 'sm-family-label';
      labelEl.textContent = f.label;
      li.appendChild(labelEl);

      // Column 3: version select
      const sel = document.createElement('select');
      sel.className = 'sm-version';
      sel.dataset.family = f.family;
      sel.disabled = !isEnabled || f.versions.length < 2;
      if (f.family === 'sonnet') {
        for (const v of f.versions) {
          for (const w of ['200k', '1m']) {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.dataset.window = w;
            opt.textContent = `${v.label} — ${w === '200k' ? '200k' : '1M'}`;
            if (v.id === active[f.family] && w === sonnetWindow) opt.selected = true;
            sel.appendChild(opt);
          }
        }
        sel.addEventListener('change', () => {
          const opt = sel.options[sel.selectedIndex];
          onPickSonnetVersionAndWindow(opt.value, opt.dataset.window);
        });
      } else {
        for (const v of f.versions) {
          const opt = document.createElement('option');
          opt.value = v.id;
          opt.textContent = v.label;
          if (v.id === active[f.family]) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => onPickVersion(f.family, sel.value));
      }
      li.appendChild(sel);

      // Column 4: default radio
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'sm-default-family';
      radio.className = 'sm-default-radio';
      radio.value = f.family;
      radio.checked = isDefault;
      radio.disabled = !isEnabled;
      radio.addEventListener('change', () => { if (radio.checked) onPickDefaultFamily(f.family); });
      li.appendChild(radio);

      smListEl.appendChild(li);
    }

    const overage = data.onOverage ?? 'none';
    for (const btn of smOverageBtns) {
      btn.setAttribute('aria-pressed', btn.dataset.overage === overage ? 'true' : 'false');
    }
    if (smCompactWindowEnabledEl) {
      const cw = data.conductorCompactWindow ?? { enabled: false, value: 200 };
      smCompactWindowEnabledEl.checked = cw.enabled;
      if (smCompactWindowSliderEl) smCompactWindowSliderEl.value = String(cw.value);
      if (smCompactWindowValEl)    smCompactWindowValEl.textContent = `${cw.value}k`;
      if (smCompactWindowRowEl)    smCompactWindowRowEl.hidden = !cw.enabled;
    }
    if (smOverageThreshEnabledEl) {
      const ot = data.overageThreshold ?? { enabled: false, value: 85 };
      smOverageThreshEnabledEl.checked = ot.enabled;
      if (smOverageThreshSliderEl) smOverageThreshSliderEl.value = String(ot.value);
      if (smOverageThreshValEl)    smOverageThreshValEl.textContent = `${ot.value}%`;
      if (smOverageThreshRowEl)    smOverageThreshRowEl.hidden = !ot.enabled;
    }
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
      onModelsChange?.(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Switch failed: ${e.message || e}`;
    }
  }

  async function onPickSonnetVersionAndWindow(version, window) {
    try {
      const r1 = await fetch('/api/settings/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ family: 'sonnet', version }),
      });
      if (!r1.ok) { const d = await r1.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r1.status}`); }
      const r2 = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sonnetContextWindow: window }),
      });
      const data = await r2.json();
      if (!r2.ok) throw new Error(data.error || `HTTP ${r2.status}`);
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Switch failed: ${e.message || e}`;
    }
  }

  for (const btn of smOverageBtns) {
    btn.addEventListener('click', () => onPickOverageAction(btn.dataset.overage));
  }

  async function onPickOverageAction(action) {
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ onOverage: action }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Update failed: ${e.message || e}`;
    }
  }

  async function onPickFamilyEnabled(family, enabled) {
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ familyEnabled: { family, enabled } }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Update failed: ${e.message || e}`;
    }
  }

  async function onPickDefaultFamily(family) {
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultSpawnFamily: family }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data);
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
  smOverageThreshEnabledEl?.addEventListener('change', () => {
    if (smOverageThreshRowEl) smOverageThreshRowEl.hidden = !smOverageThreshEnabledEl.checked;
    onSaveOverageThreshold();
  });
  smOverageThreshSliderEl?.addEventListener('input', () => {
    if (smOverageThreshValEl) smOverageThreshValEl.textContent = `${smOverageThreshSliderEl.value}%`;
  });
  smOverageThreshSliderEl?.addEventListener('change', onSaveOverageThreshold);
  document.getElementById('sm-cost-dashboard-btn')?.addEventListener('click', () => {
    onOpenCostDashboard?.();
  });

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

  async function onSaveOverageThreshold() {
    const enabled = smOverageThreshEnabledEl?.checked ?? false;
    const value   = Number(smOverageThreshSliderEl?.value ?? 85);
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ overageThreshold: { enabled, value } }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
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

  // ── Archived group ──────────────────────────────────────────────────
  // Lists every archived session grouped by project (collapsed by
  // default), each with Restore (back to the sidebar) and Delete
  // (permanent jsonl removal, confirmed). Backed by GET /api/archived.
  function sessionUrl(project, worktreeName, sessionId, suffix) {
    const enc = encodeURIComponent;
    const base = worktreeName
      ? `/api/projects/${enc(project)}/worktrees/${enc(worktreeName)}/sessions/${enc(sessionId)}`
      : `/api/projects/${enc(project)}/sessions/${enc(sessionId)}`;
    return base + suffix;
  }

  async function restoreArchived(project, s) {
    try {
      const r = await fetch(sessionUrl(project, s.worktreeName, s.sessionId, '/restore'), { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onArchivedChanged?.();
      await loadArchived();
    } catch (e) {
      alert(`restore failed: ${e.message || e}`);
    }
  }

  async function deleteArchived(project, s, label) {
    if (!confirm(`Permanently delete transcript for ${label}?\nThis removes the jsonl from disk and cannot be undone.`)) return;
    try {
      const r = await fetch(sessionUrl(project, s.worktreeName, s.sessionId, ''), { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onArchivedChanged?.();
      await loadArchived();
    } catch (e) {
      alert(`delete failed: ${e.message || e}`);
    }
  }

  function renderArchived({ groups }) {
    const list = Array.isArray(groups) ? groups : [];
    const total = list.reduce((n, g) => n + g.sessions.length, 0);
    arStatusEl.innerHTML = total > 0
      ? `<span class="st-ok">${total} archived session${total === 1 ? '' : 's'}</span> across ${list.length} project${list.length === 1 ? '' : 's'}.`
      : 'No archived sessions.';

    arListEl.innerHTML = '';
    for (const g of list) {
      const det = document.createElement('details');
      det.className = 'archived-group'; // collapsed by default (no `open`)
      const sum = document.createElement('summary');
      sum.className = 'archived-group-summary';
      sum.textContent = `${g.project} (${g.sessions.length})`;
      det.appendChild(sum);

      for (const s of g.sessions) {
        const row = document.createElement('div');
        row.className = 'archived-row';

        const main = document.createElement('div');
        main.className = 'archived-row-main';
        const labelText = s.title || s.firstPrompt || `${s.sessionId.slice(0, 8)}…`;
        const titleSpan = document.createElement('span');
        titleSpan.className = 'archived-row-title';
        titleSpan.textContent = labelText;
        titleSpan.title = s.sessionId;
        main.appendChild(titleSpan);
        const meta = document.createElement('span');
        meta.className = 'archived-row-meta';
        meta.textContent = (s.worktreeName ? `⌥ ${s.worktreeName} · ` : '') + `last ${formatAgo(s.mtime)}`;
        main.appendChild(meta);
        row.appendChild(main);

        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'archived-restore';
        restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', () => restoreArchived(g.project, s));
        row.appendChild(restoreBtn);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'archived-delete';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => deleteArchived(g.project, s, `"${labelText}"`));
        row.appendChild(delBtn);

        det.appendChild(row);
      }
      arListEl.appendChild(det);
    }
  }

  async function loadArchived() {
    try {
      const r = await fetch('/api/archived', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      renderArchived(await r.json());
    } catch (e) {
      if (arStatusEl) arStatusEl.textContent = `Failed: ${e.message || e}`;
      if (arListEl) arListEl.innerHTML = '';
    }
  }

  // ── Optional rules group ────────────────────────────────────────────────

  // Tracks which slug is being edited (null = add mode).
  let orEditingSlug = null;

  function renderOptionalRules(rules) {
    if (orStatusEl) orStatusEl.textContent = '';
    if (!orRuleListEl) return;
    orRuleListEl.innerHTML = '';
    for (const rule of rules) {
      const li = document.createElement('li');
      li.className = 'or-rule-item';
      const titleEl = document.createElement('span');
      titleEl.className = 'or-rule-name';
      titleEl.textContent = rule.name;
      const descEl = document.createElement('span');
      descEl.className = 'or-rule-desc';
      descEl.textContent = rule.description;
      const tagEl = document.createElement('span');
      tagEl.className = 'or-rule-slug';
      tagEl.textContent = rule.slug;
      li.appendChild(titleEl);
      li.appendChild(tagEl);
      li.appendChild(descEl);
      if (!rule.builtin) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => openEditForm(rule));
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => deleteOptionalRule(rule.slug));
        li.appendChild(editBtn);
        li.appendChild(delBtn);
      } else {
        const badge = document.createElement('span');
        badge.className = 'or-builtin-badge';
        badge.textContent = 'built-in';
        li.appendChild(badge);
      }
      orRuleListEl.appendChild(li);
    }
  }

  function openAddForm() {
    orEditingSlug = null;
    if (orAddSlug) { orAddSlug.value = ''; orAddSlug.disabled = false; }
    if (orAddName) orAddName.value = '';
    if (orAddDesc) orAddDesc.value = '';
    if (orAddBody) orAddBody.value = '';
    if (orAddError) orAddError.textContent = '';
    if (orAddForm) orAddForm.hidden = false;
    if (orAddBtn) orAddBtn.hidden = true;
    orAddSlug?.focus();
  }

  function openEditForm(rule) {
    orEditingSlug = rule.slug;
    if (orAddSlug) { orAddSlug.value = rule.slug; orAddSlug.disabled = true; }
    if (orAddName) orAddName.value = rule.name;
    if (orAddDesc) orAddDesc.value = rule.description;
    if (orAddBody) orAddBody.value = rule.body || '';
    if (orAddError) orAddError.textContent = '';
    if (orAddForm) orAddForm.hidden = false;
    if (orAddBtn) orAddBtn.hidden = true;
    orAddName?.focus();
  }

  function closeAddForm() {
    orEditingSlug = null;
    if (orAddForm) orAddForm.hidden = true;
    if (orAddBtn) orAddBtn.hidden = false;
    if (orAddError) orAddError.textContent = '';
  }

  async function saveOptionalRule() {
    const slug = orAddSlug?.value.trim();
    const name = orAddName?.value.trim();
    const description = orAddDesc?.value.trim();
    const body = orAddBody?.value;
    if (orAddError) orAddError.textContent = '';
    try {
      if (orEditingSlug) {
        await fetch(`/api/settings/optional-rules/${encodeURIComponent(orEditingSlug)}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, description, body }),
        }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); });
      } else {
        await fetch('/api/settings/optional-rules', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug, name, description, body }),
        }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); });
      }
      closeAddForm();
      loadOptionalRules();
    } catch (e) {
      if (orAddError) orAddError.textContent = e.message || String(e);
    }
  }

  async function deleteOptionalRule(slug) {
    if (!confirm(`Delete rule "${slug}"?`)) return;
    try {
      const r = await fetch(`/api/settings/optional-rules/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error);
      loadOptionalRules();
    } catch (e) {
      if (orStatusEl) orStatusEl.textContent = `Delete failed: ${e.message || e}`;
    }
  }

  async function loadOptionalRules() {
    if (orStatusEl) orStatusEl.textContent = 'Loading…';
    try {
      const r = await fetch('/api/settings/optional-rules', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { rules } = await r.json();
      renderOptionalRules(rules);
    } catch (e) {
      if (orStatusEl) orStatusEl.textContent = `Failed: ${e.message || e}`;
    }
  }

  orAddBtn?.addEventListener('click', openAddForm);
  orAddCancel?.addEventListener('click', closeAddForm);
  orAddSave?.addEventListener('click', saveOptionalRule);

  window.addEventListener('hashchange', sync);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen) close();
  });
  sync(); // honour an initial #settings on load

  return { open: () => { location.hash = '#settings'; }, close };
}
