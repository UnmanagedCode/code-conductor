// Settings page — a full-page view inside #main, shown when the URL hash is
// `#settings`. Built as a group-nav + content scaffold: Models, Transcribe,
// TTS, Conventions (Conductor / Workspace / Project blocks, each a reusable
// conventionsPanel), Plugins, Archived. Each adds a nav item + a panel.
//
// Navigation is hash-driven so a refresh keeps the page. app.js owns the
// hash (it knows the active session to restore on close) and passes a
// `requestClose` callback; we just translate hashchange into show/hide.

import { formatAgo } from './sidebar.js';
import { installPluginManager } from './pluginManager.js';
import { installConventionsPanel } from './conventionsPanel.js';

const POLL_MS = 1500;

export function installSettings({
  requestClose, onAvailabilityChange, onModelsChange,
  onTtsAvailabilityChange, onTtsPrefsChange, onOpenCostDashboard,
  onArchivedChanged, onPluginsChanged,
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
  const smListEl = document.getElementById('sm-tier-list');
  const smCustomListEl = document.getElementById('sm-custom-list');
  const smCustomLabelEl = document.getElementById('sm-custom-label');
  const smCustomModelEl = document.getElementById('sm-custom-model');
  const smCustomHostEl = document.getElementById('sm-custom-host');
  const smCustomAddEl = document.getElementById('sm-custom-add');
  const smCustomStatusEl = document.getElementById('sm-custom-status');
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
  const smOverageApplyEl         = document.getElementById('sm-overage-apply');
  const smOverageDirtyEl         = document.getElementById('sm-overage-dirty');
  const smOverageStatusEl        = document.getElementById('sm-overage-status');
  // TTS group elements.
  const ttStatusEl = document.getElementById('tt-status');
  const ttListEl = document.getElementById('tt-voice-list');
  const ttInstallBtn = document.getElementById('tt-install-btn');
  const ttHintEl = document.getElementById('tt-action-hint');
  const ttLogEl = document.getElementById('tt-install-log');
  const ttEnabledEl = document.getElementById('tt-enabled');
  const ttRateEl = document.getElementById('tt-rate');
  const ttRateValEl = document.getElementById('tt-rate-val');
  // Archived group elements.
  const arStatusEl = document.getElementById('ar-status');
  const arListEl = document.getElementById('ar-list');
  if (!view) return { open() {}, close() {} };

  // Conventions group — one reusable widget mounted three times (cascade order
  // Conductor → Workspace → Project). Each owns its own DOM (by id prefix) and
  // its scope's REST endpoints; see public/conventionsPanel.js.
  const conductorPanel = installConventionsPanel({
    prefix: 'cc', base: '/api/settings/conductor-modules',
    hasToggle: true, hasCoreRow: true, noun: 'conductor convention',
  });
  const workspacePanel = installConventionsPanel({
    prefix: 'wk', base: '/api/settings/workspace-conventions',
    hasToggle: true, hasCoreRow: true, noun: 'workspace convention',
  });
  const projectPanel = installConventionsPanel({
    prefix: 'pc', base: '/api/settings/project-conventions',
    hasToggle: false, hasCoreRow: false, noun: 'project convention',
  });

  // Plugins group — feature logic lives in its own module; settings only owns
  // the group panel + calls load() on open. Enabling/disabling/installing a
  // plugin can change what the conventions panels above show, so refresh them
  // whenever the plugin catalog changes.
  const pluginManager = installPluginManager({
    onCatalogChange: () => {
      conductorPanel.load();
      workspacePanel.load();
      projectPanel.load();
      onPluginsChanged?.();
    },
  });

  let isOpen = false;
  let selected = null;     // model name highlighted by the user
  let installing = false;  // an install is in flight (controls disabled)
  let installTarget = null; // model the Install button would install
  // TTS group state (independent of the transcribe install state above).
  let ttSelected = null;
  let ttInstalling = false;
  let ttInstallTarget = null;
  // Overage-prefs group: staged locally, committed only via the Apply button.
  let smOverageDirty = false;
  function markOverageDirty() {
    smOverageDirty = true;
    if (smOverageApplyEl) smOverageApplyEl.disabled = false;
    if (smOverageDirtyEl) smOverageDirtyEl.hidden = false;
    clearOverageStatus(); // a new edit invalidates any prior applied/failed message
  }
  function clearOverageDirty() {
    smOverageDirty = false;
    if (smOverageApplyEl) smOverageApplyEl.disabled = true;
    if (smOverageDirtyEl) smOverageDirtyEl.hidden = true;
  }
  function clearOverageStatus() {
    if (!smOverageStatusEl) return;
    smOverageStatusEl.hidden = true;
    smOverageStatusEl.textContent = '';
    smOverageStatusEl.classList.remove('sm-status-ok', 'sm-status-err');
  }
  function setOverageStatus(text, ok) {
    if (!smOverageStatusEl) return;
    smOverageStatusEl.textContent = text;
    smOverageStatusEl.hidden = false;
    smOverageStatusEl.classList.toggle('sm-status-ok', ok);
    smOverageStatusEl.classList.toggle('sm-status-err', !ok);
  }

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
    clearOverageDirty(); // discard any un-applied edit from a prior open before refetching
    clearOverageStatus(); // discard any stale applied/failed message from a prior open
    loadModels();
    loadTts();
    loadArchived();
    conductorPanel.load();
    workspacePanel.load();
    projectPanel.load();
    pluginManager.load();
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
    const tiers = data.tiers || [];
    const backends = data.backends || [];
    const customBackends = data.customBackends || [];
    const activeVersions = data.activeVersions || {};
    const tierBackend = data.tierBackend || {};
    const sonnetWindow = data.sonnetContextWindow ?? '1m';
    const enabledTiers = data.enabledTiers ?? {};
    const defaultTier = data.defaultSpawnTier ?? 'powerful';
    const enabledCount = tiers.filter(t => enabledTiers[t.tier] !== false).length;

    const backendFor = (family) => backends.find(b => b.family === family);
    const customFor = (id) => customBackends.find(c => c.id === id);

    renderCustomList(customBackends);

    if (smStatusEl) {
      smStatusEl.innerHTML = tiers.map(t => {
        const isDefault = t.tier === defaultTier;
        const custom = customFor(tierBackend[t.tier]);
        if (custom) {
          return `${t.label}: <strong>${escapeHtml(custom.label)} — ${escapeHtml(custom.model)}</strong>${isDefault ? ' <em>(default)</em>' : ''}`;
        }
        const backend = backendFor(tierBackend[t.tier]);
        if (!backend) return `${t.label}: <strong>—</strong>`;
        const vLabel = labelFor(backend, activeVersions[backend.family]);
        let extra = '';
        if (backend.family === 'sonnet') {
          const activeEntry = backend.versions.find(v => v.id === activeVersions[backend.family]);
          const win = activeEntry?.fixedWindow || sonnetWindow;
          extra = ` — ${win === '200k' ? '200k' : '1M'}`;
        }
        return `${t.label}: <strong>${backend.label} ${vLabel}${extra}</strong>${isDefault ? ' <em>(default)</em>' : ''}`;
      }).join(' · ');
    }

    smListEl.innerHTML = '';
    for (const t of tiers) {
      const isEnabled = enabledTiers[t.tier] !== false;
      const isDefault = t.tier === defaultTier;
      const isLastEnabled = isEnabled && enabledCount === 1;
      const boundKey = tierBackend[t.tier];
      const custom = customFor(boundKey);
      const backend = custom ? null : (backendFor(boundKey) || backends[0]);
      if (!custom && !backend) continue;

      const li = document.createElement('li');
      li.className = 'sm-family-row' + (isEnabled ? '' : ' sm-family-row--disabled');

      // Column 1: enable checkbox
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'sm-enable';
      chk.dataset.tier = t.tier;
      chk.checked = isEnabled;
      chk.disabled = isLastEnabled; // prevent disabling the last one
      chk.addEventListener('change', () => onPickTierEnabled(t.tier, chk.checked));
      li.appendChild(chk);

      // Column 2: tier label
      const labelEl = document.createElement('span');
      labelEl.className = 'sm-family-label';
      labelEl.textContent = t.label;
      li.appendChild(labelEl);

      // Column 3: backend select — Claude families followed by custom (Ollama)
      // backends. Option value = family key OR custom-backend id.
      const backendSel = document.createElement('select');
      backendSel.className = 'sm-backend';
      backendSel.dataset.tier = t.tier;
      backendSel.disabled = !isEnabled;
      for (const b of backends) {
        const opt = document.createElement('option');
        opt.value = b.family;
        opt.textContent = b.label;
        if (!custom && b.family === backend.family) opt.selected = true;
        backendSel.appendChild(opt);
      }
      for (const c of customBackends) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.label} (Ollama)`;
        if (custom && c.id === custom.id) opt.selected = true;
        backendSel.appendChild(opt);
      }
      backendSel.addEventListener('change', () => onPickTierBackend(t.tier, backendSel.value));
      li.appendChild(backendSel);

      // Column 4: version select. A custom (Ollama) backend has no versions and
      // no context-window choice — render a single disabled option showing the
      // tag, so the column stays aligned.
      if (custom) {
        const sel = document.createElement('select');
        sel.className = 'sm-version';
        sel.disabled = true;
        const opt = document.createElement('option');
        opt.textContent = custom.model;
        sel.appendChild(opt);
        li.appendChild(sel);
        // Column 5: default radio
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'sm-default-tier';
        radio.className = 'sm-default-radio';
        radio.value = t.tier;
        radio.checked = isDefault;
        radio.disabled = !isEnabled;
        radio.addEventListener('change', () => { if (radio.checked) onPickDefaultTier(t.tier); });
        li.appendChild(radio);
        smListEl.appendChild(li);
        continue;
      }
      const sel = document.createElement('select');
      sel.className = 'sm-version';
      sel.dataset.family = backend.family;
      sel.disabled = !isEnabled || backend.versions.length < 2;
      if (backend.family === 'sonnet') {
        for (const v of backend.versions) {
          if (v.fixedWindow) {
            // Fixed-window version (Sonnet 5, no 200k build) — plain single
            // option, same shape as the generic non-Sonnet branch below.
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = v.label;
            if (v.id === activeVersions[backend.family]) opt.selected = true;
            sel.appendChild(opt);
          } else {
            // Preference-driven version (Sonnet 4.x) — existing 200k/1m sub-choice.
            for (const w of ['200k', '1m']) {
              const opt = document.createElement('option');
              opt.value = v.id;
              opt.dataset.window = w;
              opt.textContent = `${v.label} — ${w === '200k' ? '200k' : '1M'}`;
              if (v.id === activeVersions[backend.family] && w === sonnetWindow) opt.selected = true;
              sel.appendChild(opt);
            }
          }
        }
        sel.addEventListener('change', () => {
          const opt = sel.options[sel.selectedIndex];
          if (opt.dataset.window) onPickSonnetVersionAndWindow(opt.value, opt.dataset.window);
          else onPickVersion('sonnet', opt.value);
        });
      } else {
        for (const v of backend.versions) {
          const opt = document.createElement('option');
          opt.value = v.id;
          opt.textContent = v.label;
          if (v.id === activeVersions[backend.family]) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => onPickVersion(backend.family, sel.value));
      }
      li.appendChild(sel);

      // Column 5: default radio
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'sm-default-tier';
      radio.className = 'sm-default-radio';
      radio.value = t.tier;
      radio.checked = isDefault;
      radio.disabled = !isEnabled;
      radio.addEventListener('change', () => { if (radio.checked) onPickDefaultTier(t.tier); });
      li.appendChild(radio);

      smListEl.appendChild(li);
    }

    // Skip re-syncing the overage group while it has un-applied local edits (e.g. an
    // unrelated save elsewhere on this page, like a tier toggle, also calls
    // renderModels — it must not clobber a staged-but-not-yet-Applied overage edit).
    if (!smOverageDirty) {
      const overage = data.onOverage ?? 'none';
      for (const btn of smOverageBtns) {
        btn.setAttribute('aria-pressed', btn.dataset.overage === overage ? 'true' : 'false');
      }
      if (smOverageThreshEnabledEl) {
        const ot = data.overageThreshold ?? { enabled: false, value: 85 };
        smOverageThreshEnabledEl.checked = ot.enabled;
        if (smOverageThreshSliderEl) smOverageThreshSliderEl.value = String(ot.value);
        if (smOverageThreshValEl)    smOverageThreshValEl.textContent = `${ot.value}%`;
        if (smOverageThreshRowEl)    smOverageThreshRowEl.hidden = !ot.enabled;
      }
    }
    if (smCompactWindowEnabledEl) {
      const cw = data.conductorCompactWindow ?? { enabled: false, value: 200 };
      smCompactWindowEnabledEl.checked = cw.enabled;
      if (smCompactWindowSliderEl) smCompactWindowSliderEl.value = String(cw.value);
      if (smCompactWindowValEl)    smCompactWindowValEl.textContent = `${cw.value}k`;
      if (smCompactWindowRowEl)    smCompactWindowRowEl.hidden = !cw.enabled;
    }
  }

  function labelFor(backend, id) {
    return backend.versions.find(v => v.id === id)?.label || id;
  }

  async function onPickVersion(backend, version) {
    try {
      const r = await fetch('/api/settings/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backend, version }),
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
        body: JSON.stringify({ backend: 'sonnet', version }),
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

  // Staged, not saved: a click only updates the local pressed state and marks the
  // overage group dirty. Committed together with the threshold via Apply.
  for (const btn of smOverageBtns) {
    btn.addEventListener('click', () => {
      for (const b of smOverageBtns) b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      markOverageDirty();
    });
  }

  async function onPickTierEnabled(tier, enabled) {
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tierEnabled: { tier, enabled } }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Update failed: ${e.message || e}`;
    }
  }

  async function onPickDefaultTier(tier) {
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultSpawnTier: tier }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Update failed: ${e.message || e}`;
    }
  }

  async function onPickTierBackend(tier, backend) {
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tierBackend: { tier, backend } }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Update failed: ${e.message || e}`;
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderCustomList(list) {
    if (!smCustomListEl) return;
    smCustomListEl.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'sm-custom-empty';
      li.textContent = 'No custom models yet.';
      smCustomListEl.appendChild(li);
      return;
    }
    for (const c of list) {
      const li = document.createElement('li');
      li.className = 'sm-custom-item';
      const meta = document.createElement('span');
      meta.className = 'sm-custom-meta';
      meta.textContent = `${c.label} — ${c.model}${c.host ? ` @ ${c.host}` : ''}`;
      li.appendChild(meta);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn sm-custom-remove';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => onRemoveCustomBackend(c.id));
      li.appendChild(rm);
      smCustomListEl.appendChild(li);
    }
  }

  async function onAddCustomBackend() {
    const label = smCustomLabelEl?.value?.trim();
    const model = smCustomModelEl?.value?.trim();
    const host = smCustomHostEl?.value?.trim();
    if (!label || !model) {
      if (smCustomStatusEl) smCustomStatusEl.textContent = 'Label and Ollama tag are required.';
      return;
    }
    if (smCustomStatusEl) smCustomStatusEl.textContent = 'Checking Ollama…';
    if (smCustomAddEl) smCustomAddEl.disabled = true;
    try {
      const r = await fetch('/api/settings/models/custom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, model, host }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (smCustomLabelEl) smCustomLabelEl.value = '';
      if (smCustomModelEl) smCustomModelEl.value = '';
      if (smCustomHostEl) smCustomHostEl.value = '';
      if (smCustomStatusEl) smCustomStatusEl.textContent = 'Added.';
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smCustomStatusEl) smCustomStatusEl.textContent = `Add failed: ${e.message || e}`;
    } finally {
      if (smCustomAddEl) smCustomAddEl.disabled = false;
    }
  }

  async function onRemoveCustomBackend(id) {
    try {
      const r = await fetch(`/api/settings/models/custom/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smCustomStatusEl) smCustomStatusEl.textContent = `Remove failed: ${e.message || e}`;
    }
  }

  smCustomAddEl?.addEventListener('click', onAddCustomBackend);

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
    markOverageDirty();
  });
  smOverageThreshSliderEl?.addEventListener('input', () => {
    if (smOverageThreshValEl) smOverageThreshValEl.textContent = `${smOverageThreshSliderEl.value}%`;
    markOverageDirty();
  });
  smOverageApplyEl?.addEventListener('click', onApplyOveragePrefs);
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

  async function onApplyOveragePrefs() {
    const action  = smOverageBtns.find(b => b.getAttribute('aria-pressed') === 'true')?.dataset.overage || 'none';
    const enabled = smOverageThreshEnabledEl?.checked ?? false;
    const value   = Number(smOverageThreshSliderEl?.value ?? 85);
    try {
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ onOverage: action, overageThreshold: { enabled, value } }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      clearOverageDirty();   // before renderModels, so its (now-unguarded) sync applies
      renderModels(data);    // re-syncs from the server's clamped/snapped values
      setOverageStatus('Overage settings applied', true);
    } catch (e) {
      setOverageStatus(`Update failed: ${e.message || e}`, false);
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
    const list = Array.isArray(groups) ? groups.slice() : [];
    const conductIdx = list.findIndex(g => g.project === '.conduct');
    if (conductIdx > 0) {
      const [conduct] = list.splice(conductIdx, 1);
      list.unshift(conduct);
    }
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
      if (g.project === '.conduct') {
        const icon = document.createElement('span');
        icon.className = 'archived-group-icon';
        icon.textContent = '🎼';
        sum.appendChild(icon);
        sum.appendChild(document.createTextNode(`Conductor (${g.sessions.length})`));
      } else {
        sum.textContent = `${g.project} (${g.sessions.length})`;
      }
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

  window.addEventListener('hashchange', sync);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen) close();
  });
  sync(); // honour an initial #settings on load

  return { open: () => { location.hash = '#settings'; }, close };
}
