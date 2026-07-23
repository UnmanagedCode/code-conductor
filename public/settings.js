// Settings page — a full-page view inside #main, shown when the URL hash is
// `#settings`. Built as a group-nav + content scaffold: Models, Account
// (overage protection), Transcribe, TTS, Conventions (Conductor / Workspace /
// Project blocks, each a reusable conventionsPanel), Plugins, Archived. Each
// adds a nav item + a panel.
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
  onArchivedChanged, onPluginsChanged, onSessionRestored,
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
  const smRoleListEl = document.getElementById('sm-role-list');
  const smCustomListEl = document.getElementById('sm-custom-list');
  const smCustomLabelEl = document.getElementById('sm-custom-label');
  const smCustomModelEl = document.getElementById('sm-custom-model');
  const smCustomContextEl = document.getElementById('sm-custom-context');
  const smCustomAddEl = document.getElementById('sm-custom-add');
  const smCustomStatusEl = document.getElementById('sm-custom-status');
  let lastModelsData = null;
  const smCompactWindowEnabledEl = document.getElementById('sm-compact-window-enabled');
  const smCompactWindowRowEl     = document.getElementById('sm-compact-window-row');
  const smCompactWindowSliderEl  = document.getElementById('sm-compact-window');
  const smCompactWindowValEl     = document.getElementById('sm-compact-window-val');
  // Account group elements (overage protection — lives on its own settings page,
  // but its prefs ride in the shared /api/settings/models payload; see below).
  const smOverageEl = document.getElementById('sm-overage');
  const smOverageBtns = [...(smOverageEl?.querySelectorAll('[data-overage]') || [])];
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
    prefix: 'cc', base: '/api/settings/conventions/conductor',
    hasToggle: true, hasCoreRow: true, noun: 'conductor convention',
  });
  const workspacePanel = installConventionsPanel({
    prefix: 'wk', base: '/api/settings/conventions/workspace',
    hasToggle: true, hasCoreRow: true, noun: 'workspace convention',
  });
  const projectPanel = installConventionsPanel({
    prefix: 'pc', base: '/api/settings/conventions/project',
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
  // Account group (overage prefs): staged locally, committed only via Apply.
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
    lastModelsData = data; // latest catalog, read by the provider-switch handler
    const tiers = data.tiers || [];
    const providers = data.providers || [{ kind: 'claude', label: 'Claude' }, { kind: 'ollama', label: 'Ollama' }];
    const backends = data.backends || []; // Claude version catalog (MODEL_FAMILIES)
    const customBackends = data.customBackends || []; // [{label, model}]
    const ollamaCloudModels = data.ollamaCloudModels || []; // curated presets [{label, model}]
    const tierBackend = data.tierBackend || {}; // {tier: {kind, model, window?}}
    const enabledTiers = data.enabledTiers ?? {};
    const defaultTier = data.defaultSpawnTier ?? 'powerful';
    const enabledCount = tiers.filter(t => enabledTiers[t.tier] !== false).length;

    // Flattened Claude version catalog + a label lookup.
    const claudeVersions = backends.flatMap(b => b.versions.map(v => ({ ...v, family: b.family })));
    const versionLabel = (id) => claudeVersions.find(v => v.id === id)?.label || id;
    const isSonnetFixed = (id) => !!claudeVersions.find(v => v.id === id && v.fixedWindow);
    const providerLabel = (kind) => providers.find(p => p.kind === kind)?.label || kind;
    const bindingFor = (tier) => tierBackend[tier] || { kind: 'claude', model: '' };
    function describeBinding(b) {
      if (b.kind === 'ollama') return `Ollama — ${b.model}`;
      let extra = '';
      // Per-binding window (Sonnet 4.x only) — this binding's own `window`, not a
      // shared global, so two Sonnet bindings can show different windows.
      if (b.model.startsWith('claude-sonnet') && !isSonnetFixed(b.model)) extra = ` — ${b.window === '200k' ? '200k' : '1M'}`;
      return `${versionLabel(b.model)}${extra}`;
    }

    // Shared backend + model picker (Claude/Ollama), reused by both tier rows
    // and role custom bindings. `b` is a {kind, model} binding; callbacks fire
    // on a provider switch (onKind), a Claude version pick (onClaude(model,
    // window)), or an Ollama tag pick (onOllama(model)). Returns the two <select>
    // elements so the caller can place them.
    function buildBackendPicker(b, enabled, { onKind, onClaude, onOllama }) {
      // Backend (provider) select — Claude / Ollama.
      const backendSel = document.createElement('select');
      backendSel.className = 'sm-backend';
      backendSel.disabled = !enabled;
      for (const p of providers) {
        const opt = document.createElement('option');
        opt.value = p.kind;
        opt.textContent = p.label;
        if (p.kind === b.kind) opt.selected = true;
        backendSel.appendChild(opt);
      }
      backendSel.addEventListener('change', () => onKind(backendSel.value));

      // Model select, scoped to the row's backend kind.
      const sel = document.createElement('select');
      sel.className = 'sm-version';
      sel.disabled = !enabled;
      if (b.kind === 'ollama') {
        if (!ollamaCloudModels.length && !customBackends.length) {
          const opt = document.createElement('option');
          opt.textContent = '(add a model below)';
          sel.appendChild(opt);
          sel.disabled = true;
        } else {
          const addGroup = (label, list) => {
            if (!list.length) return;
            const grp = document.createElement('optgroup');
            grp.label = label;
            for (const c of list) {
              const opt = document.createElement('option');
              opt.value = c.model;
              opt.textContent = `${c.label} — ${c.model}`;
              if (c.model === b.model) opt.selected = true;
              grp.appendChild(opt);
            }
            sel.appendChild(grp);
          };
          addGroup('Ollama Cloud', ollamaCloudModels);
          addGroup('My Models', customBackends);
          sel.addEventListener('change', () => onOllama(sel.value));
        }
      } else {
        // Claude version list; Sonnet 4.x expands to 200k/1M sub-entries. The
        // chosen window rides on THIS binding (opt.dataset.window → the binding's
        // own `window`), not a global — picking one binding's window never moves
        // another's.
        const bWindow = b.window === '200k' ? '200k' : '1m';
        for (const v of claudeVersions) {
          if (v.family === 'sonnet' && !v.fixedWindow) {
            for (const w of ['200k', '1m']) {
              const opt = document.createElement('option');
              opt.value = v.id;
              opt.dataset.window = w;
              opt.textContent = `${v.label} — ${w === '200k' ? '200k' : '1M'}`;
              if (v.id === b.model && w === bWindow) opt.selected = true;
              sel.appendChild(opt);
            }
          } else {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = v.label;
            if (v.id === b.model) opt.selected = true;
            sel.appendChild(opt);
          }
        }
        sel.addEventListener('change', () => {
          const opt = sel.options[sel.selectedIndex];
          onClaude(opt.value, opt.dataset.window || null);
        });
      }
      return { backendSel, modelSel: sel };
    }

    renderCustomList(customBackends);

    if (smStatusEl) {
      smStatusEl.innerHTML = tiers.map(t => {
        const isDefault = t.tier === defaultTier;
        return `${t.label}: <strong>${escapeHtml(describeBinding(bindingFor(t.tier)))}</strong>${isDefault ? ' <em>(default)</em>' : ''}`;
      }).join(' · ');
    }

    smListEl.innerHTML = '';
    // Render frontier → fast (most capable first) — reversed from `tiers`' catalog
    // order, which the one-line summary above still uses unreversed.
    const tiersForRows = [...tiers].reverse();
    for (const t of tiersForRows) {
      const isEnabled = enabledTiers[t.tier] !== false;
      const isDefault = t.tier === defaultTier;
      const isLastEnabled = isEnabled && enabledCount === 1;
      const b = bindingFor(t.tier); // {kind, model}

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

      // Columns 3 & 4: backend (provider) + model selects (shared picker).
      const { backendSel, modelSel } = buildBackendPicker(b, isEnabled, {
        onKind: (kind) => onPickBackendKind(t.tier, kind),
        onClaude: (model, window) => onPickClaudeModel(t.tier, model, window),
        onOllama: (model) => onPickOllamaModel(t.tier, model),
      });
      backendSel.dataset.tier = t.tier;
      li.appendChild(backendSel);
      li.appendChild(modelSel);

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

    // ── Roles ────────────────────────────────────────────────────────────
    // Each role picks one of the tiers OR "Custom"; the backend + model pickers
    // (shared with tier rows) show only when Custom is selected.
    if (smRoleListEl) {
      const roles = data.roles || [];
      const roleBackend = data.roleBackend || {}; // {role: {kind:'tier',tier} | {kind,model}}
      smRoleListEl.innerHTML = '';
      for (const r of roles) {
        const rb = roleBackend[r.role] || { kind: 'tier', tier: defaultTier };
        const isCustom = rb.kind !== 'tier';

        const li = document.createElement('li');
        li.className = 'sm-role-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'sm-family-label';
        labelEl.textContent = r.label;
        li.appendChild(labelEl);

        // Binding select: one option per tier + a final "Custom".
        const bindingSel = document.createElement('select');
        bindingSel.className = 'sm-role-binding';
        for (const t of tiers) {
          const opt = document.createElement('option');
          opt.value = `tier:${t.tier}`;
          opt.textContent = t.label;
          if (!isCustom && rb.tier === t.tier) opt.selected = true;
          bindingSel.appendChild(opt);
        }
        const customOpt = document.createElement('option');
        customOpt.value = 'custom';
        customOpt.textContent = 'Custom';
        if (isCustom) customOpt.selected = true;
        bindingSel.appendChild(customOpt);
        bindingSel.addEventListener('change', () => onPickRoleBinding(r.role, bindingSel.value));
        li.appendChild(bindingSel);

        // Custom backend + model pickers, only when Custom is selected.
        if (isCustom) {
          const { backendSel, modelSel } = buildBackendPicker(rb, true, {
            onKind: (kind) => onPickRoleBackendKind(r.role, kind),
            onClaude: (model, window) => saveRoleBinding(r.role, { kind: 'claude', model }, window || undefined),
            onOllama: (model) => saveRoleBinding(r.role, { kind: 'ollama', model }),
          });
          li.appendChild(backendSel);
          li.appendChild(modelSel);
        }

        smRoleListEl.appendChild(li);
      }
    }

    // Overage prefs live on the Account page but ride in this same models payload,
    // so keep their controls in sync whenever it refreshes. See syncOverageControls.
    syncOverageControls(data);
    if (smCompactWindowEnabledEl) {
      const cw = data.conductorCompactWindow ?? { enabled: false, value: 200 };
      smCompactWindowEnabledEl.checked = cw.enabled;
      if (smCompactWindowSliderEl) smCompactWindowSliderEl.value = String(cw.value);
      if (smCompactWindowValEl)    smCompactWindowValEl.textContent = `${cw.value}k`;
      if (smCompactWindowRowEl)    smCompactWindowRowEl.hidden = !cw.enabled;
    }
  }


  // Persist a tier binding {kind, model} in one /prefs POST. For a Sonnet 4.x
  // pick the chosen context window rides ON the binding ({kind,model,window}),
  // not a sibling global — so it only affects this tier.
  async function saveTierBinding(tier, backend, window) {
    try {
      const body = { tierBackend: { tier, backend: window ? { ...backend, window } : backend } };
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Switch failed: ${e.message || e}`;
    }
  }

  // Switching a tier's provider: pick a sensible default model for the new kind
  // (Sonnet default for Claude; this tier's catalog cloud preset for Ollama —
  // fast/balanced/powerful each have one, see ollamaCloudTierDefaults — else
  // the first custom model).
  function onPickBackendKind(tier, kind) {
    if (kind === 'ollama') {
      const cloudModels = lastModelsData?.ollamaCloudModels || [];
      const tierDefaults = lastModelsData?.ollamaCloudTierDefaults || {};
      const preset = cloudModels.find(c => c.model === tierDefaults[tier]);
      const chosen = preset || lastModelsData?.customBackends?.[0];
      if (!chosen) { if (smStatusEl) smStatusEl.textContent = 'Add an Ollama model below first.'; renderModels(lastModelsData); return; }
      return saveTierBinding(tier, { kind: 'ollama', model: chosen.model });
    }
    return saveTierBinding(tier, { kind: 'claude', model: defaultClaudeModel() });
  }

  function onPickClaudeModel(tier, model, window) {
    return saveTierBinding(tier, { kind: 'claude', model }, window || undefined);
  }

  function onPickOllamaModel(tier, model) {
    return saveTierBinding(tier, { kind: 'ollama', model });
  }

  // The Claude version a "switch to Custom" / "switch to Claude" pick defaults
  // to (Sonnet default, else the first catalog version).
  function defaultClaudeModel() {
    const backends = lastModelsData?.backends || [];
    const sonnet = backends.find(b => b.family === 'sonnet') || backends[0];
    return sonnet?.default || backends[0]?.versions?.[0]?.id;
  }

  // Persist a role binding — a tier binding {kind:'tier',tier} or a custom
  // {kind, model} — in one /prefs POST. For a Sonnet 4.x custom pick the chosen
  // window rides ON the binding ({kind,model,window}), not a sibling global.
  async function saveRoleBinding(role, backend, window) {
    try {
      const body = { roleBackend: { role, backend: window ? { ...backend, window } : backend } };
      const r = await fetch('/api/settings/models/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smStatusEl) smStatusEl.textContent = `Switch failed: ${e.message || e}`;
    }
  }

  // Role binding select: a `tier:<t>` value binds to that tier; `custom` seeds a
  // default Claude custom binding so the pickers appear populated.
  function onPickRoleBinding(role, value) {
    if (value.startsWith('tier:')) return saveRoleBinding(role, { kind: 'tier', tier: value.slice(5) });
    return saveRoleBinding(role, { kind: 'claude', model: defaultClaudeModel() });
  }

  // Switching a role's custom provider: pick a sensible default model for the
  // new kind (Sonnet default for Claude; first cloud preset / custom for Ollama).
  function onPickRoleBackendKind(role, kind) {
    if (kind === 'ollama') {
      const chosen = (lastModelsData?.ollamaCloudModels || [])[0] || lastModelsData?.customBackends?.[0];
      if (!chosen) { if (smStatusEl) smStatusEl.textContent = 'Add an Ollama model below first.'; renderModels(lastModelsData); return; }
      return saveRoleBinding(role, { kind: 'ollama', model: chosen.model });
    }
    return saveRoleBinding(role, { kind: 'claude', model: defaultClaudeModel() });
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


  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Compact token formatter for the custom-model list (e.g. 1000000 → "1M").
  function fmtCtxTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
    if (n >= 1_000) return Math.round(n / 1_000) + 'k';
    return String(n);
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
      const ctx = Number.isFinite(c.contextWindow) ? ` · ${fmtCtxTokens(c.contextWindow)} ctx` : '';
      meta.textContent = `${c.label} — ${c.model}${ctx}`;
      li.appendChild(meta);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn sm-custom-remove';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => onRemoveCustomBackend(c.model));
      li.appendChild(rm);
      smCustomListEl.appendChild(li);
    }
  }

  async function onAddCustomBackend() {
    const label = smCustomLabelEl?.value?.trim();
    const model = smCustomModelEl?.value?.trim();
    if (!label || !model) {
      if (smCustomStatusEl) smCustomStatusEl.textContent = 'Label and Ollama tag are required.';
      return;
    }
    // Optional context window (tokens). Only send when non-empty; validate > 0.
    const ctxRaw = smCustomContextEl?.value?.trim();
    const body = { label, model };
    if (ctxRaw) {
      const ctx = Number(ctxRaw);
      if (!Number.isFinite(ctx) || ctx <= 0) {
        if (smCustomStatusEl) smCustomStatusEl.textContent = 'Context must be a positive number of tokens.';
        return;
      }
      body.contextWindow = ctx;
    }
    if (smCustomStatusEl) smCustomStatusEl.textContent = 'Checking Ollama…';
    if (smCustomAddEl) smCustomAddEl.disabled = true;
    try {
      const r = await fetch('/api/settings/models/custom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (smCustomLabelEl) smCustomLabelEl.value = '';
      if (smCustomModelEl) smCustomModelEl.value = '';
      if (smCustomContextEl) smCustomContextEl.value = '';
      if (smCustomStatusEl) smCustomStatusEl.textContent = 'Added.';
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smCustomStatusEl) smCustomStatusEl.textContent = `Add failed: ${e.message || e}`;
    } finally {
      if (smCustomAddEl) smCustomAddEl.disabled = false;
    }
  }

  // Remove by tag (the identity). The tag can contain ':' — encodeURIComponent.
  async function onRemoveCustomBackend(tag) {
    try {
      const r = await fetch(`/api/settings/models/custom/${encodeURIComponent(tag)}`, { method: 'DELETE' });
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

  // ── Account group ───────────────────────────────────────────────────
  // Overage protection. Its prefs (onOverage, overageThreshold) ride in the
  // shared /api/settings/models payload, so there's no separate Account fetch:
  // renderModels() calls syncOverageControls() whenever that payload refreshes.

  // Re-sync the overage controls from a models payload — but skip it while there
  // are un-applied local edits (any prefs save elsewhere, e.g. a tier toggle on
  // the Models page, also re-runs renderModels → this; it must not clobber a
  // staged-but-not-yet-Applied overage edit).
  function syncOverageControls(data) {
    if (smOverageDirty) return;
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

  // Staged, not saved: a click only updates the local pressed state and marks the
  // overage group dirty. Committed together with the threshold via Apply.
  for (const btn of smOverageBtns) {
    btn.addEventListener('click', () => {
      for (const b of smOverageBtns) b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      markOverageDirty();
    });
  }
  smOverageThreshEnabledEl?.addEventListener('change', () => {
    if (smOverageThreshRowEl) smOverageThreshRowEl.hidden = !smOverageThreshEnabledEl.checked;
    markOverageDirty();
  });
  smOverageThreshSliderEl?.addEventListener('input', () => {
    if (smOverageThreshValEl) smOverageThreshValEl.textContent = `${smOverageThreshSliderEl.value}%`;
    markOverageDirty();
  });
  smOverageApplyEl?.addEventListener('click', onApplyOveragePrefs);

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
      onSessionRestored?.({ project, worktreeName: s.worktreeName, sessionId: s.sessionId });
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
