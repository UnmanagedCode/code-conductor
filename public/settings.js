// Settings page — a full-page view inside #main, shown when the URL hash is
// `#settings`. Built as a group-nav + content scaffold: Models, Backends,
// Account (overage protection), Voice (Dictation + Speech grouping boxes),
// Conventions (Conductor / Workspace / Project blocks, each a reusable
// conventionsPanel), Plugins, Archived. Each adds a nav item + a panel.
//
// Navigation is hash-driven so a refresh keeps the page. app.js owns the
// hash (it knows the active session to restore on close) and passes a
// `requestClose` callback; we just translate hashchange into show/hide.

import { formatAgo } from './sidebar.js';
import { installPluginManager } from './pluginManager.js';
import { installConventionsPanel } from './conventionsPanel.js';
import { CLAUDE_BACKEND, backendIdOf } from './models.js';

const POLL_MS = 1500;

export function installSettings({
  requestClose, onAvailabilityChange, onModelsChange,
  onTtsAvailabilityChange, onTtsPrefsChange, onOpenCostDashboard,
  onArchivedChanged, onPluginsChanged, onSessionRestored,
  requestRestartWithResume,
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
  const smRoleNameEl = document.getElementById('sm-role-name');
  const smRoleAddEl = document.getElementById('sm-role-add');
  const smRoleStatusEl = document.getElementById('sm-role-status');
  const smCustomListEl = document.getElementById('sm-custom-list');
  const smCustomLabelEl = document.getElementById('sm-custom-label');
  const smCustomBackendEl = document.getElementById('sm-custom-backend');
  const smCustomModelEl = document.getElementById('sm-custom-model');
  const smCustomContextEl = document.getElementById('sm-custom-context');
  const smCustomAddEl = document.getElementById('sm-custom-add');
  const smCustomStatusEl = document.getElementById('sm-custom-status');
  let lastModelsData = null;
  // Backends group elements (the backend registry — Settings → Backends).
  const sbStatusEl = document.getElementById('sb-status');
  const sbListEl = document.getElementById('sb-list');
  const sbIdEl = document.getElementById('sb-id');
  const sbLabelEl = document.getElementById('sb-label');
  const sbTemplateEl = document.getElementById('sb-template');
  const sbEnvEl = document.getElementById('sb-env');
  const sbSaveEl = document.getElementById('sb-save');
  const sbCancelEl = document.getElementById('sb-cancel');
  const sbFormLegendEl = document.getElementById('sb-form-legend');
  const sbFormStatusEl = document.getElementById('sb-form-status');
  // null = add mode; a backend id = editing that row (mirrors conventionsPanel).
  let sbEditingId = null;
  const smCompactWindowEnabledEl = document.getElementById('sm-compact-window-enabled');
  const smCompactWindowRowEl     = document.getElementById('sm-compact-window-row');
  const smCompactWindowSliderEl  = document.getElementById('sm-compact-window');
  const smCompactWindowValEl     = document.getElementById('sm-compact-window-val');
  // Debug-capture-by-default toggle — its own fieldset at the bottom of the
  // Models group. Backed by /api/settings/spawn[/prefs], not the models
  // payload (it's spawn policy, not a model/tier binding), so it loads via
  // its own small fetch, called alongside loadModels() in show().
  const smDebugDefaultEl = document.getElementById('sm-debug-default');
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
  // About group elements (conductor self-update).
  const abStatusEl = document.getElementById('ab-update-status');
  const abBtnEl = document.getElementById('ab-update-btn');
  const abLogEl = document.getElementById('ab-update-log');
  let abUpdating = false;
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
    loadDebugDefaultPref();
    loadTts();
    loadArchived();
    conductorPanel.load();
    workspacePanel.load();
    projectPanel.load();
    pluginManager.load();
    loadAbout();
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

  // ── Backends group ──────────────────────────────────────────────────
  // The backend registry: one card per row. Managed rows (`claude`, `ollama`)
  // are code-owned — their label/template can't be edited and they can't be
  // removed (the server refuses either way), but their env can. Removal of a
  // user row is REFUSED with 409 when custom models still reference it OR when
  // any tracked session is still on it; the message names them either way, so it
  // goes straight into the status line.
  //
  // No loader of its own: the registry rides in the shared /api/settings/models
  // payload, so renderModels() drives renderBackends() — the same arrangement the
  // Account panel's overage prefs use (see syncOverageControls).
  function envToText(env) {
    return (Array.isArray(env) ? env : []).map(e => `${e.key}=${e.value}`).join('\n');
  }

  // KEY=VALUE per line → [{key,value}]. Blank lines are skipped; a line with no
  // '=' is treated as an empty value so a half-typed row doesn't silently vanish
  // (the server validates the key shape and 400s on a bad one).
  function envFromText(text) {
    return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const i = l.indexOf('=');
      return i === -1 ? { key: l, value: '' } : { key: l.slice(0, i).trim(), value: l.slice(i + 1) };
    });
  }

  function renderBackends(data) {
    const backends = data.backends || [];
    const customModels = data.customModels || [];
    if (sbStatusEl) {
      sbStatusEl.textContent = `${backends.length} backend${backends.length === 1 ? '' : 's'} — ${backends.filter(b => b.managed).length} built in.`;
    }
    if (!sbListEl) return;
    sbListEl.innerHTML = '';
    for (const b of backends) {
      const li = document.createElement('li');
      li.className = 'sb-row';

      const head = document.createElement('div');
      head.className = 'sb-row-head';
      const label = document.createElement('span');
      label.className = 'sb-row-label';
      label.textContent = b.label;
      head.appendChild(label);
      const id = document.createElement('span');
      id.className = 'sb-row-id';
      id.textContent = b.id;
      head.appendChild(id);
      if (b.managed) {
        const badge = document.createElement('span');
        badge.className = 'sb-managed-badge';
        badge.textContent = 'built in';
        head.appendChild(badge);
      }
      const actions = document.createElement('div');
      actions.className = 'sb-row-actions';
      // Managed rows are fully read-only — no edit affordance (label/template/env
      // are all code-authoritative). User rows get Edit + Remove.
      if (!b.managed) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'btn';
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => openEditBackend(b));
        actions.appendChild(edit);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn';
        rm.textContent = 'Remove';
        rm.addEventListener('click', () => onRemoveBackend(b.id));
        actions.appendChild(rm);
      }
      head.appendChild(actions);
      li.appendChild(head);

      const tpl = document.createElement('div');
      tpl.className = 'sb-row-template';
      tpl.textContent = b.template ? b.template : 'claude';
      li.appendChild(tpl);

      if (Array.isArray(b.env) && b.env.length) {
        const env = document.createElement('div');
        env.className = 'sb-row-env';
        env.textContent = b.env.map(e => `${e.key}=${e.value}`).join('  ');
        li.appendChild(env);
      }

      const bound = customModels.filter(m => m.backend === b.id);
      if (bound.length) {
        const models = document.createElement('div');
        models.className = 'sb-row-env';
        models.textContent = `models: ${bound.map(m => m.model).join(', ')}`;
        li.appendChild(models);
      }

      sbListEl.appendChild(li);
    }
  }

  function closeBackendForm() {
    sbEditingId = null;
    if (sbIdEl) { sbIdEl.value = ''; sbIdEl.disabled = false; sbIdEl.hidden = false; }
    if (sbLabelEl) { sbLabelEl.value = ''; sbLabelEl.disabled = false; }
    if (sbTemplateEl) { sbTemplateEl.value = ''; sbTemplateEl.disabled = false; }
    if (sbEnvEl) sbEnvEl.value = '';
    if (sbSaveEl) sbSaveEl.textContent = 'Add';
    if (sbCancelEl) sbCancelEl.hidden = true;
    if (sbFormLegendEl) sbFormLegendEl.textContent = 'Add a backend';
    if (sbFormStatusEl) sbFormStatusEl.textContent = '';
  }

  function openEditBackend(b) {
    sbEditingId = b.id;
    if (sbIdEl) { sbIdEl.value = b.id; sbIdEl.disabled = true; sbIdEl.hidden = false; }
    if (sbLabelEl) { sbLabelEl.value = b.label; sbLabelEl.disabled = !!b.managed; }
    if (sbTemplateEl) { sbTemplateEl.value = b.template || ''; sbTemplateEl.disabled = !!b.managed; }
    if (sbEnvEl) { sbEnvEl.value = envToText(b.env); sbEnvEl.disabled = !!b.managed; }
    if (sbSaveEl) sbSaveEl.textContent = 'Save';
    if (sbCancelEl) sbCancelEl.hidden = false;
    if (sbFormLegendEl) {
      sbFormLegendEl.textContent = b.managed
        ? `Edit ${b.label} (built in — template and env are fixed)`
        : `Edit ${b.label}`;
    }
    if (sbFormStatusEl) sbFormStatusEl.textContent = '';
  }

  async function onSaveBackend() {
    const env = envFromText(sbEnvEl?.value);
    if (sbSaveEl) sbSaveEl.disabled = true;
    try {
      let r;
      if (sbEditingId) {
        // Editing is only offered for user rows (managed rows are read-only —
        // label/template/env are all code-authoritative), so the edit PATCH
        // always carries the full triple.
        const body = { label: sbLabelEl?.value?.trim(), template: sbTemplateEl?.value ?? '', env };
        r = await fetch(`/api/settings/models/backends/${encodeURIComponent(sbEditingId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        r = await fetch('/api/settings/models/backends', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: sbIdEl?.value?.trim(), label: sbLabelEl?.value?.trim(), template: sbTemplateEl?.value ?? '', env }),
        });
      }
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      closeBackendForm();
      renderModels(data); // also re-renders this panel (renderBackends)
      onModelsChange?.(data);
    } catch (e) {
      if (sbFormStatusEl) sbFormStatusEl.textContent = `Save failed: ${e.message || e}`;
    } finally {
      if (sbSaveEl) sbSaveEl.disabled = false;
    }
  }

  async function onRemoveBackend(id) {
    try {
      const r = await fetch(`/api/settings/models/backends/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await r.json();
      // 409 names what still references the row (bound custom models, or the
      // sessions still on it) in its message — surface it verbatim.
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (sbEditingId === id) closeBackendForm();
      renderModels(data); // also re-renders this panel (renderBackends)
      onModelsChange?.(data);
    } catch (e) {
      if (sbStatusEl) sbStatusEl.textContent = `Remove failed: ${e.message || e}`;
    }
  }

  sbSaveEl?.addEventListener('click', onSaveBackend);
  sbCancelEl?.addEventListener('click', closeBackendForm);

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

  // Debug-capture-by-default (Models → Debug capture fieldset). Persisted
  // separately from the models payload (spawn.debugByDefault in settings.json,
  // via /api/settings/spawn[/prefs]) — see spawnDialog.js openSpawnDialog,
  // which fetches the same endpoint to pre-check the New Session dialog's
  // debug checkbox.
  async function loadDebugDefaultPref() {
    if (!smDebugDefaultEl) return;
    try {
      const r = await fetch('/api/settings/spawn', { cache: 'no-store' });
      const data = await r.json();
      smDebugDefaultEl.checked = !!data.debugByDefault;
    } catch { /* ignore — leave last-known checkbox state */ }
  }

  smDebugDefaultEl?.addEventListener('change', async () => {
    try {
      await fetch('/api/settings/spawn/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ debugByDefault: smDebugDefaultEl.checked }),
      });
    } catch { /* best-effort; next open re-syncs from server */ }
  });

  function renderModels(data) {
    lastModelsData = data; // latest catalog, read by the backend-switch handler
    const tiers = data.tiers || [];
    // The backend REGISTRY (Settings → Backends): [{id,label,template,env,managed}].
    const backends = data.backends || [{ id: 'claude', label: 'Claude', managed: true }];
    const claudeFamilies = data.claudeFamilies || []; // Claude version catalog (MODEL_FAMILIES)
    const customModels = data.customModels || []; // [{label, model, backend, contextWindow}]
    const ollamaCloudModels = data.ollamaCloudModels || []; // curated presets, `ollama` backend only
    const tierBackend = data.tierBackend || {}; // {tier: {backend, model, window?}}
    const tierEffort = data.tierEffort || {};   // {tier: level} — the default-effort axis
    const efforts = data.efforts || [];         // effort levels, server-shipped catalog
    // End of the server's precedence chain, shipped in the payload. The one place
    // this panel names a level — every fallback below routes through it rather than
    // repeating a literal that could drift from DEFAULT_EFFORT.
    const defaultEffort = data.defaultEffort || 'high';
    const enabledTiers = data.enabledTiers ?? {};
    const defaultTier = data.defaultSpawnTier ?? 'powerful';
    const enabledCount = tiers.filter(t => enabledTiers[t.tier] !== false).length;

    // Flattened Claude version catalog + a label lookup.
    const claudeVersions = claudeFamilies.flatMap(b => b.versions.map(v => ({ ...v, family: b.family })));
    const versionLabel = (id) => claudeVersions.find(v => v.id === id)?.label || id;
    const isSonnetFixed = (id) => !!claudeVersions.find(v => v.id === id && v.fixedWindow);
    const backendLabel = (id) => backends.find(b => b.id === id)?.label || id;
    const bindingFor = (tier) => tierBackend[tier] || { backend: CLAUDE_BACKEND, model: '' };
    // Models bindable on a backend: its own custom-model rows, plus — for the
    // built-in `ollama` row only — the curated cloud presets.
    const modelsForBackend = (id) => ({
      curated: id === 'ollama' ? ollamaCloudModels : [],
      custom: customModels.filter(m => m.backend === id),
    });
    function describeBinding(b) {
      if (backendIdOf(b) !== CLAUDE_BACKEND) return `${backendLabel(backendIdOf(b))} — ${b.model}`;
      let extra = '';
      // Per-binding window (Sonnet 4.x only) — this binding's own `window`, not a
      // shared global, so two Sonnet bindings can show different windows.
      if (b.model.startsWith('claude-sonnet') && !isSonnetFixed(b.model)) extra = ` — ${b.window === '200k' ? '200k' : '1M'}`;
      return `${versionLabel(b.model)}${extra}`;
    }

    // Shared backend + model picker, reused by both tier rows and role custom
    // bindings. `b` is a {backend, model} binding; callbacks fire on a backend
    // switch (onBackend), a Claude version pick (onClaude(model, window)), or a
    // non-Claude model pick (onModel(model)). The backend list comes from the
    // registry, so a user-added row shows up here with no code change. Returns the
    // two <select> elements so the caller can place them.
    function buildBackendPicker(b, enabled, { onBackend, onClaude, onModel }) {
      const bBackend = backendIdOf(b);
      const backendSel = document.createElement('select');
      backendSel.className = 'sm-backend';
      backendSel.disabled = !enabled;
      for (const p of backends) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        if (p.id === bBackend) opt.selected = true;
        backendSel.appendChild(opt);
      }
      backendSel.addEventListener('change', () => onBackend(backendSel.value));

      // Model select, scoped to the row's backend.
      const sel = document.createElement('select');
      sel.className = 'sm-version';
      sel.disabled = !enabled;
      if (bBackend !== CLAUDE_BACKEND) {
        const { curated, custom } = modelsForBackend(bBackend);
        if (!curated.length && !custom.length) {
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
          addGroup(`${backendLabel(bBackend)} Cloud`, curated);
          addGroup('My Models', custom);
          sel.addEventListener('change', () => onModel(sel.value));
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

    // Default-effort select, shared by tier rows and role rows. `inheritLabel`
    // (role rows only) adds a leading `Inherit (<level>)` option whose value is
    // 'inherit' — the level shown is the server-computed `inheritsTo`, never
    // recomputed here. Tier rows pass no inheritLabel: a tier has nothing to
    // inherit from.
    function buildEffortPicker(current, enabled, onPick, inheritLabel) {
      const sel = document.createElement('select');
      sel.className = 'sm-effort';
      sel.disabled = !enabled;
      if (inheritLabel) {
        const opt = document.createElement('option');
        opt.value = 'inherit';
        opt.textContent = inheritLabel;
        sel.appendChild(opt);
      }
      for (const level of efforts) {
        const opt = document.createElement('option');
        opt.value = level;
        opt.textContent = level;
        sel.appendChild(opt);
      }
      // Select by assigning the built select's value (not `option.selected` while
      // the option is still detached — happy-dom drops that, and the panel test
      // asserts what the user would see). A value matching no option (a payload
      // without the effort axis) leaves selectedIndex at -1, i.e. a blank select —
      // fall back to the level the SERVER would resolve, never to the first entry
      // in the catalog, which would display `low` for a row that runs at `high`.
      sel.value = current;
      if (sel.selectedIndex < 0) sel.value = defaultEffort;
      if (sel.selectedIndex < 0) sel.selectedIndex = 0;
      sel.addEventListener('change', () => onPick(sel.value));
      return sel;
    }

    renderCustomList(customModels, backends);

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

      // Columns 3 & 4: backend + model selects (shared picker).
      const { backendSel, modelSel } = buildBackendPicker(b, isEnabled, {
        onBackend: (backend) => onPickTierBackend(t.tier, backend),
        onClaude: (model, window) => onPickClaudeModel(t.tier, model, window),
        onModel: (model) => onPickTierModel(t.tier, model),
      });
      backendSel.dataset.tier = t.tier;
      li.appendChild(backendSel);
      li.appendChild(modelSel);

      // Column 5: default effort (a separate axis from the binding above)
      const effortSel = buildEffortPicker(
        tierEffort[t.tier], isEnabled, (level) => onPickTierEffort(t.tier, level),
      );
      effortSel.dataset.tier = t.tier;
      effortSel.setAttribute('aria-label', `Default effort for the ${t.label} tier`);
      li.appendChild(effortSel);

      // Column 6: default radio
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
    // Built-in + user-custom roles pick one of the tiers OR "Custom" (shared
    // backend/model pickers show only when Custom is selected). A custom role is
    // name-only (the name is shown directly) with a small × remove control.
    // Plugin-owned roles are user-rebindable just like built-in/custom: the
    // rebind is an OVERRIDE of the manifest binding, persisted under roleBackend
    // and taking precedence at spawn. Marked with a plugin-name badge; no
    // delete (plugin roles are manifest-controlled). To revert an override the
    // user simply re-selects the manifest's tier/model in the same picker.
    if (smRoleListEl) {
      const roles = data.roles || [];
      const roleBackend = data.roleBackend || {}; // {role: {kind:'tier',tier} | {backend,model}}
      // {role: {effort:'inherit'|level, inheritsTo:level}} — `inheritsTo` is what
      // 'inherit' resolves to today (the bound tier's effort, or the global default
      // for a Custom-bound role), computed server-side.
      const roleEffort = data.roleEffort || {};
      smRoleListEl.innerHTML = '';
      for (const r of roles) {
        const rb = roleBackend[r.role] || { kind: 'tier', tier: defaultTier };
        const isCustom = rb.kind !== 'tier';
        const isPlugin = !!r.plugin;
        const isUserRole = !r.builtin && !isPlugin;

        const li = document.createElement('li');
        li.className = 'sm-role-row' + (isPlugin ? ' sm-role-row--plugin' : '');

        // Name + plugin provenance badge share a fixed-width column so the
        // controls after it line up the same whether or not a row has a badge.
        const nameWrap = document.createElement('div');
        nameWrap.className = 'sm-role-name-wrap';

        // Name shown directly (built-in/plugin carry a label; a custom role is
        // name-only, so fall back to the role name).
        const labelEl = document.createElement('span');
        labelEl.className = 'sm-family-label';
        labelEl.textContent = r.label || r.role;
        nameWrap.appendChild(labelEl);

        // Plugin provenance badge — kept on editable rows, stacked below the name.
        if (isPlugin) {
          const badge = document.createElement('span');
          badge.className = 'sm-role-plugin-badge';
          badge.textContent = r.plugin;
          nameWrap.appendChild(badge);
        }

        li.appendChild(nameWrap);

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
            onBackend: (backend) => onPickRoleBackend(r.role, backend),
            onClaude: (model, window) => saveRoleBinding(r.role, { backend: CLAUDE_BACKEND, model }, window || undefined),
            onModel: (model) => saveRoleBinding(r.role, { backend: backendIdOf(rb), model }),
          });
          li.appendChild(backendSel);
          li.appendChild(modelSel);
        }

        // Default effort — 'inherit' (follow the bound tier) or an explicit level.
        const re = roleEffort[r.role] || {};
        const effortSel = buildEffortPicker(
          re.effort || 'inherit', true, (level) => onPickRoleEffort(r.role, level),
          `Inherit (${re.inheritsTo || defaultEffort})`,
        );
        effortSel.setAttribute('aria-label', `Default effort for the ${r.label || r.role} role`);
        li.appendChild(effortSel);

        // Remove — user roles only. A small × icon control, not a full button.
        if (isUserRole) {
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'sm-role-remove';
          rm.textContent = '×';
          rm.title = `Remove role ${r.role}`;
          rm.setAttribute('aria-label', `Remove role ${r.role}`);
          rm.addEventListener('click', () => onRemoveRole(r.role));
          li.appendChild(rm);
        }

        smRoleListEl.appendChild(li);
      }
    }

    // Overage prefs live on the Account page but ride in this same models payload,
    // so keep their controls in sync whenever it refreshes. See syncOverageControls.
    syncOverageControls(data);
    renderBackends(data);
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

  // Persist a default effort — the tier/role's second axis — in one /prefs POST.
  // Same shape as saveTierBinding/saveRoleBinding: the response is the full
  // refreshed state, re-rendered immediately.
  async function saveEffort(body) {
    try {
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
      if (smStatusEl) smStatusEl.textContent = `Effort change failed: ${e.message || e}`;
    }
  }

  function onPickTierEffort(tier, effort) {
    return saveEffort({ tierEffort: { tier, effort } });
  }

  function onPickRoleEffort(role, effort) {
    return saveEffort({ roleEffort: { role, effort } });
  }

  // First model to bind when a tier/role switches TO a non-Claude backend: for
  // the built-in `ollama` row prefer that tier's curated cloud preset
  // (fast/balanced/powerful each have one, see ollamaCloudTierDefaults), else the
  // first custom model on the backend. Returns null when nothing is bindable yet.
  function firstModelForBackend(backend, tier) {
    const curated = backend === 'ollama' ? (lastModelsData?.ollamaCloudModels || []) : [];
    if (tier) {
      const preset = curated.find(c => c.model === (lastModelsData?.ollamaCloudTierDefaults || {})[tier]);
      if (preset) return preset;
    }
    const custom = (lastModelsData?.customModels || []).filter(m => m.backend === backend);
    return custom[0] || curated[0] || null;
  }

  function backendLabelOf(id) {
    return (lastModelsData?.backends || []).find(b => b.id === id)?.label || id;
  }

  // Switching a tier's backend: pick a sensible default model for the new backend
  // (Sonnet default for Claude; see firstModelForBackend otherwise).
  function onPickTierBackend(tier, backend) {
    if (backend !== CLAUDE_BACKEND) {
      const chosen = firstModelForBackend(backend, tier);
      if (!chosen) {
        // Re-render FIRST to snap the select back, THEN write the message —
        // renderModels rewrites smStatusEl, so the other order loses it.
        renderModels(lastModelsData);
        if (smStatusEl) smStatusEl.textContent = `Add a ${backendLabelOf(backend)} model below first.`;
        return;
      }
      return saveTierBinding(tier, { backend, model: chosen.model });
    }
    return saveTierBinding(tier, { backend: CLAUDE_BACKEND, model: defaultClaudeModel() });
  }

  function onPickClaudeModel(tier, model, window) {
    return saveTierBinding(tier, { backend: CLAUDE_BACKEND, model }, window || undefined);
  }

  function onPickTierModel(tier, model) {
    const backend = backendIdOf(lastModelsData?.tierBackend?.[tier]);
    return saveTierBinding(tier, { backend, model });
  }

  // The Claude version a "switch to Custom" / "switch to Claude" pick defaults
  // to (Sonnet default, else the first catalog version).
  function defaultClaudeModel() {
    const families = lastModelsData?.claudeFamilies || [];
    const sonnet = families.find(b => b.family === 'sonnet') || families[0];
    return sonnet?.default || families[0]?.versions?.[0]?.id;
  }

  // Persist a role binding — a tier binding {kind:'tier',tier} or a concrete
  // {backend, model} — in one /prefs POST. For a Sonnet 4.x custom pick the chosen
  // window rides ON the binding ({backend,model,window}), not a sibling global.
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
    return saveRoleBinding(role, { backend: CLAUDE_BACKEND, model: defaultClaudeModel() });
  }

  // Switching a role's custom backend: pick a sensible default model for the new
  // backend (Sonnet default for Claude; see firstModelForBackend otherwise).
  function onPickRoleBackend(role, backend) {
    if (backend !== CLAUDE_BACKEND) {
      const chosen = firstModelForBackend(backend, null);
      if (!chosen) {
        renderModels(lastModelsData); // see onPickTierBackend: re-render, then message
        if (smStatusEl) smStatusEl.textContent = `Add a ${backendLabelOf(backend)} model below first.`;
        return;
      }
      return saveRoleBinding(role, { backend, model: chosen.model });
    }
    return saveRoleBinding(role, { backend: CLAUDE_BACKEND, model: defaultClaudeModel() });
  }

  // Create a custom role — name only. It defaults to the powerful tier binding
  // (server-side); the user rebinds it afterwards via the row's picker.
  async function onAddRole() {
    const role = smRoleNameEl?.value?.trim();
    if (!role) {
      if (smRoleStatusEl) smRoleStatusEl.textContent = 'Name is required.';
      return;
    }
    if (smRoleAddEl) smRoleAddEl.disabled = true;
    try {
      const r = await fetch('/api/settings/models/roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (smRoleNameEl) smRoleNameEl.value = '';
      if (smRoleStatusEl) smRoleStatusEl.textContent = 'Added.';
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smRoleStatusEl) smRoleStatusEl.textContent = `Add failed: ${e.message || e}`;
    } finally {
      if (smRoleAddEl) smRoleAddEl.disabled = false;
    }
  }

  async function onRemoveRole(role) {
    try {
      const r = await fetch(`/api/settings/models/roles/${encodeURIComponent(role)}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smRoleStatusEl) smRoleStatusEl.textContent = `Remove failed: ${e.message || e}`;
    }
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

  // `backends` is the registry, used to fill the add-form's backend select with
  // every SUBSTITUTION backend (the identity `claude` row serves the Claude
  // version catalog, not user model rows, so it's never offered here).
  function renderCustomList(list, backends) {
    if (smCustomBackendEl) {
      const substitution = (backends || []).filter(b => b.id !== CLAUDE_BACKEND);
      const prev = smCustomBackendEl.value;
      smCustomBackendEl.innerHTML = '';
      for (const b of substitution) {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.label;
        smCustomBackendEl.appendChild(opt);
      }
      if (substitution.some(b => b.id === prev)) smCustomBackendEl.value = prev;
      smCustomBackendEl.disabled = !substitution.length;
    }
    if (!smCustomListEl) return;
    const backendLabel = (id) => (backends || []).find(b => b.id === id)?.label || id;
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
      meta.textContent = `${c.label} — ${c.model} · ${backendLabel(c.backend)}${ctx}`;
      li.appendChild(meta);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn sm-custom-remove';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => onRemoveCustomModel(c.model));
      li.appendChild(rm);
      smCustomListEl.appendChild(li);
    }
  }

  async function onAddCustomModel() {
    const label = smCustomLabelEl?.value?.trim();
    const model = smCustomModelEl?.value?.trim();
    const backend = smCustomBackendEl?.value;
    if (!label || !model || !backend) {
      if (smCustomStatusEl) smCustomStatusEl.textContent = 'Label, backend, and model id are required.';
      return;
    }
    // Context window (tokens) — REQUIRED, and must be positive.
    const ctxRaw = smCustomContextEl?.value?.trim();
    const ctx = Number(ctxRaw);
    if (!ctxRaw || !Number.isFinite(ctx) || ctx <= 0) {
      if (smCustomStatusEl) smCustomStatusEl.textContent = 'Context is required and must be a positive number of tokens.';
      return;
    }
    if (smCustomStatusEl) smCustomStatusEl.textContent = 'Adding…';
    if (smCustomAddEl) smCustomAddEl.disabled = true;
    try {
      const r = await fetch('/api/settings/models/custom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, model, backend, contextWindow: ctx }),
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

  // Remove by model id (the identity). It can contain ':' — encodeURIComponent.
  async function onRemoveCustomModel(model) {
    try {
      const r = await fetch(`/api/settings/models/custom/${encodeURIComponent(model)}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      renderModels(data);
      onModelsChange?.(data);
    } catch (e) {
      if (smCustomStatusEl) smCustomStatusEl.textContent = `Remove failed: ${e.message || e}`;
    }
  }

  smCustomAddEl?.addEventListener('click', onAddCustomModel);
  smRoleAddEl?.addEventListener('click', onAddRole);

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

  // ── About group: conductor self-update ───────────────────────────────
  // Mirrors the Plugin Library update UX (see pluginManager.js): a git-behind
  // indicator + Update button. GET reports version/behind; POST streams the
  // `git pull` + `npm install` log as NDJSON, then hands off to the shared
  // restart+resume engine (requestRestartWithResume) so the new code loads.
  function renderAbout(data) {
    if (!abStatusEl || !abBtnEl) return;
    const v = data.version ? `v${data.version}` : 'version unknown';
    if (!data.canCheck) {
      abStatusEl.textContent = `${v} · can't check for updates (no upstream branch)`;
      abBtnEl.hidden = true;
    } else if (data.diverged) {
      // Local commits + remote ahead: a fast-forward pull can't apply, so
      // don't offer an Update button that would fail.
      abStatusEl.textContent = `${v} · ${data.ahead} ahead, ${data.behind} behind ${data.upstream} — can't fast-forward`;
      abBtnEl.hidden = true;
    } else if (data.updateAvailable) {
      const n = data.behind;
      const commits = `${n} commit${n === 1 ? '' : 's'}`;
      const from = data.upstream ? ` behind ${data.upstream}` : '';
      abStatusEl.textContent = `${v} · update available (${commits}${from})`;
      abBtnEl.hidden = false;
      abBtnEl.disabled = false;
      abBtnEl.textContent = 'Update';
    } else {
      abStatusEl.textContent = `${v} · up to date`;
      abBtnEl.hidden = true;
    }
  }

  async function loadAbout() {
    if (!abStatusEl) return;
    if (abUpdating) return; // don't clobber a live update's status/log
    abStatusEl.textContent = 'Checking for updates…';
    if (abBtnEl) abBtnEl.hidden = true;
    if (abLogEl) { abLogEl.hidden = true; abLogEl.textContent = ''; }
    try {
      const r = await fetch('/api/settings/self-update', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      renderAbout(await r.json());
    } catch (e) {
      abStatusEl.textContent = `Failed to check for updates: ${e.message || e}`;
      if (abBtnEl) abBtnEl.hidden = true;
    }
  }

  // Stream the NDJSON update log into abLogEl; returns the terminal result.
  async function streamSelfUpdate() {
    const r = await fetch('/api/settings/self-update', { method: 'POST', cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('ndjson')) {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const err = new Error(data.error || `HTTP ${r.status}`); if (data.tail) err.tail = data.tail; throw err; }
      return data;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalResult = null;
    const appendLog = (text) => {
      if (!abLogEl) return;
      abLogEl.hidden = false;
      abLogEl.textContent = (abLogEl.textContent + text).slice(-8192);
      abLogEl.scrollTop = abLogEl.scrollHeight;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const evt = JSON.parse(line);
        if (evt.type === 'chunk') appendLog(evt.text);
        else if (evt.type === 'result') finalResult = evt;
      }
      if (done) break;
    }
    if (!finalResult) throw new Error('stream ended unexpectedly');
    if (!finalResult.ok) { const err = new Error(finalResult.error || 'update failed'); if (finalResult.tail) err.tail = finalResult.tail; throw err; }
    return finalResult.result;
  }

  abBtnEl?.addEventListener('click', async () => {
    if (abUpdating) return;
    abUpdating = true;
    abBtnEl.disabled = true;
    abBtnEl.textContent = 'Updating…';
    abStatusEl.textContent = 'Updating conductor…';
    try {
      const result = await streamSelfUpdate();
      if (result?.npm && !result.npm.ok) {
        // Pull succeeded but npm install failed — don't restart into a
        // half-installed tree; surface the failure and let the user retry.
        abStatusEl.textContent = 'Update pulled but npm install failed — resolve before restarting.';
        if (abLogEl && result.npm.tail) { abLogEl.hidden = false; abLogEl.textContent = result.npm.tail; }
        abBtnEl.disabled = false;
        abBtnEl.textContent = 'Retry';
        abUpdating = false;
        return;
      }
      abStatusEl.textContent = 'Update applied — restarting…';
      // Hand off to the shared restart+resume engine (bootId poll + reload).
      // Leave abUpdating true: the page reloads when the new server answers.
      if (requestRestartWithResume) requestRestartWithResume();
      else abStatusEl.textContent = 'Update applied — restart the conductor to finish.';
    } catch (e) {
      abStatusEl.textContent = `Update failed: ${e.message || e}`;
      if (abLogEl && e.tail) { abLogEl.hidden = false; abLogEl.textContent = e.tail; }
      abBtnEl.disabled = false;
      abBtnEl.textContent = 'Update';
      abUpdating = false;
    }
  });

  window.addEventListener('hashchange', sync);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen) close();
  });
  sync(); // honour an initial #settings on load

  return { open: () => { location.hash = '#settings'; }, close };
}
