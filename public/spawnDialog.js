// Spawn + Conduct dialogs and the shared model-picker helpers, extracted from
// app.js. Follows the installX({...}) pattern.
//
// The two model-picker sync helpers have callers OUTSIDE this module — app.js's
// settings `onModelsChange` callback and the boot-time loadModelVersions().then.
// Both run before installSpawnDialog, so app.js holds the returned handles in a
// `spawnHandles` holder and calls them lazily (see app.js).
//
// models.js getters are imported directly: models.js is a singleton ESM module,
// so these read the same state that app.js's setActive* setters mutate. app.js's
// onModelsChange calls the setters first, then the returned sync handles, so the
// getters always see fresh state.
//
// Injected interface:
//   - dom:                the 17 spawn/conduct dialog els (see app.js dom map).
//   - getProjects():      reads the live project list (state.projects in app.js)
//                         for openSpawnDialog's git-repo lookup.
//   - refreshProjects()/refreshInstances()/selectInstance(id): post-spawn refresh
//                         + selection (drive app.js state/sidebar).
//   - closeSidebarOverflow(): used by openConductDialog.
//
// Returns { openSpawnDialog, syncSonnetPickerLabels, syncFamilyVisibility } — the
// only handles with external callers; openConductDialog/makeModeToggle/
// spawnInstance/defaultSpawnFamily stay internal.
import { resolveSpawnModel, getActiveSonnetWindow, getActiveVersion, isSonnetFixedWindowVersion,
  getFamilyList, getActiveFamilyEnabled, getActiveDefaultSpawnFamily } from './models.js';

export function installSpawnDialog({ dom, getProjects, refreshProjects, refreshInstances, selectInstance, closeSidebarOverflow }) {
  // ── Shared spawn-dialog helpers ───────────────────────────────────────
  // The conduct dialog uses this two-button toggle helper.
  function makeModeToggle(codeBtn, planBtn) {
    let planMode = false;
    function sync() {
      codeBtn.setAttribute('aria-pressed', planMode ? 'false' : 'true');
      planBtn.setAttribute('aria-pressed', planMode ? 'true' : 'false');
    }
    codeBtn.addEventListener('click', e => { e.preventDefault(); planMode = false; sync(); });
    planBtn.addEventListener('click', e => { e.preventDefault(); planMode = true; sync(); });
    return { get planMode() { return planMode; }, reset() { planMode = false; sync(); } };
  }

  // POSTs a temp instance, closes the dialog, and selects the new session.
  // Used by the conduct dialog.
  async function spawnInstance({ project, model, planMode, dialogEl, errorEl }) {
    errorEl.textContent = '';
    try {
      const mode = planMode ? 'plan' : 'bypassPermissions';
      const r = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, model, temp: true, mode, autoApprovePlan: planMode }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      const inst = await r.json();
      dialogEl.close();
      await refreshProjects();
      await refreshInstances();
      selectInstance(inst.id);
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  // Updates the Sonnet button labels in all spawn pickers to match the active
  // version's context window, so the UI reflects what will actually be
  // spawned. Sonnet 5 has no 200k build (always 1M); Sonnet 4.x reflects the
  // stored preference.
  function syncSonnetPickerLabels() {
    const w = isSonnetFixedWindowVersion(getActiveVersion('sonnet'))
      ? '1M'
      : (getActiveSonnetWindow() === '200k' ? '200k' : '1M');
    document.querySelectorAll('.qs-model[data-family="sonnet"] .qs-ctx')
      .forEach(el => { el.textContent = w; });
  }

  // Shows or hides every family button across all dialogs. If the currently
  // selected family gets disabled, resets selection to the resolved default.
  function syncFamilyVisibility() {
    // Family enum from the shipped catalog (getFamilyList() is seeded non-empty,
    // and these calls run only after loadModelVersions() resolves). Order is
    // irrelevant here: per-family visibility toggle + an all-disabled check.
    const families = getFamilyList();
    for (const family of families) {
      const enabled = getActiveFamilyEnabled(family);
      document.querySelectorAll(`.qs-model[data-family="${family}"]`).forEach(btn => {
        btn.hidden = !enabled;
      });
    }
    // Guard: if every family ended up hidden (unreachable via the Settings UI,
    // which blocks disabling the last enabled family, but possible via a manual
    // settings.json edit), un-hide the fallback so the picker is never empty.
    if (families.every(f => !getActiveFamilyEnabled(f))) {
      const fallback = defaultSpawnFamily();
      document.querySelectorAll(`.qs-model[data-family="${fallback}"]`).forEach(btn => {
        btn.hidden = false;
      });
    }
    if (!getActiveFamilyEnabled(selectedSpawnFamily)) {
      selectedSpawnFamily = defaultSpawnFamily();
      updateSpawnModelSelection();
    }
  }

  // Resolves the configured default family for the spawn dialog initial selection,
  // falling back to the first enabled family if the configured default is disabled.
  function defaultSpawnFamily() {
    const d = getActiveDefaultSpawnFamily();
    if (getActiveFamilyEnabled(d)) return d;
    // Deliberate fallback-preference order (NOT the catalog order) — mirrors the
    // server's reassign policy in src/appSettings.js setFamilyEnabled().
    for (const f of ['sonnet', 'haiku', 'opus', 'fable']) {
      if (getActiveFamilyEnabled(f)) return f;
    }
    return 'sonnet';
  }

  // ── Unified spawn dialog ──────────────────────────────────────────────
  // Opened by the + (new session) sidebar button.
  // Collapsed face: model cards + Code/Plan toggle.
  // Defaults: configured default model (Opus out of the box; set via Settings →
  // Models), temp ON, worktree OFF — reproduces the old quick-spawn behaviour
  // when the user never opens Advanced options.
  let pendingSpawnProject = null;
  // null = project root | true = fresh worktree | '<name>' = existing worktree
  let pendingSpawnWorktreeIntent = null;
  let selectedSpawnFamily = 'opus';

  function updateSpawnModelSelection() {
    dom.spawnDialog.querySelectorAll('.qs-model').forEach(btn => {
      btn.classList.toggle('qs-selected', btn.dataset.family === selectedSpawnFamily);
    });
  }

  let sdModeValue = 'bypassPermissions';
  function resetSdMode() {
    sdModeValue = 'bypassPermissions';
    dom.sdModeCode.setAttribute('aria-pressed', 'true');
    dom.sdModePlan.setAttribute('aria-pressed', 'false');
  }
  dom.sdModeCode.addEventListener('click', e => {
    e.preventDefault();
    sdModeValue = 'bypassPermissions';
    dom.sdModeCode.setAttribute('aria-pressed', 'true');
    dom.sdModePlan.setAttribute('aria-pressed', 'false');
  });
  dom.sdModePlan.addEventListener('click', e => {
    e.preventDefault();
    sdModeValue = 'plan';
    dom.sdModeCode.setAttribute('aria-pressed', 'false');
    dom.sdModePlan.setAttribute('aria-pressed', 'true');
  });

  // Model card click: select only, do not spawn.
  dom.spawnDialog.addEventListener('click', e => {
    const btn = e.target.closest('.qs-model');
    if (!btn) return;
    e.preventDefault();
    selectedSpawnFamily = btn.dataset.family;
    updateSpawnModelSelection();
  });

  async function openSpawnDialog(projectName, opts = {}) {
    pendingSpawnProject = projectName;
    pendingSpawnWorktreeIntent = opts.worktreeName ?? null;
    dom.sdProject.textContent = projectName;
    dom.sdError.textContent = '';
    resetSdMode();

    selectedSpawnFamily = defaultSpawnFamily();
    updateSpawnModelSelection();

    dom.sdEffort.value = 'high';
    dom.sdThinking.value = 'adaptive';
    dom.sdDebug.checked = false;

    const proj = getProjects().find(p => p.name === projectName);
    const isGit = !!proj?.isGitRepo;
    if (pendingSpawnWorktreeIntent) {
      dom.sdWorktree.checked = true;
      dom.sdWorktree.disabled = true;
      dom.sdWorktreeHint.textContent = `will spawn into existing worktree: ${pendingSpawnWorktreeIntent}`;
      dom.sdTemp.checked = false;
    } else {
      dom.sdWorktree.checked = false;
      dom.sdWorktree.disabled = !isGit;
      dom.sdWorktreeHint.textContent = isGit
        ? 'creates a sibling worktree under ~/project/, branched off current HEAD'
        : 'project is not a git repo — `git init` first to use worktrees';
      dom.sdTemp.checked = true;
    }

    dom.sdAdvanced.removeAttribute('open');
    dom.spawnDialog.showModal();
  }

  dom.spawnDialog.addEventListener('close', async () => {
    // Restore the Spawn button after a hook-result re-open (non-spawn close).
    dom.sdSpawn.disabled = false;
    if (dom.spawnDialog.returnValue !== 'spawn') return;
    // Clear any previous hook result from a prior spawn.
    dom.sdHookResult.hidden = true;
    dom.sdError.textContent = '';
    const project  = pendingSpawnProject;
    const mode     = sdModeValue;
    const model    = resolveSpawnModel(selectedSpawnFamily);
    const effort   = dom.sdEffort.value;
    const thinking = dom.sdThinking.value;
    const temp     = dom.sdTemp.checked || undefined;
    const debug    = dom.sdDebug.checked || undefined;
    const autoApprovePlan = (mode === 'plan') || undefined;
    let worktree;
    if (typeof pendingSpawnWorktreeIntent === 'string') worktree = pendingSpawnWorktreeIntent;
    else if (dom.sdWorktree.checked) worktree = true;
    try {
      const r = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, mode, effort, thinking, model, worktree, temp, debug, autoApprovePlan }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      const inst = await r.json();
      await refreshProjects();
      await refreshInstances();
      selectInstance(inst.id);
      // If a post-worktree-create hook ran, show its result in the dialog.
      const hook = inst.worktree?.postWorktreeCreate;
      if (hook?.ran) {
        const exitLabel = hook.timedOut ? 'timed out'
          : hook.exitCode === 0 ? 'exit 0 ✓'
          : `exit ${hook.exitCode} ⚠`;
        const timeLabel = hook.durationMs != null ? ` (${hook.durationMs}ms)` : '';
        const truncLabel = hook.truncated ? ' — output truncated' : '';
        dom.sdHookSummary.textContent = `Hook: ${exitLabel}${timeLabel}${truncLabel}`;
        dom.sdHookOutput.textContent = hook.output || '';
        dom.sdHookResult.hidden = false;
        dom.sdSpawn.disabled = true;
        dom.spawnDialog.showModal();
      }
    } catch (e) {
      dom.sdError.textContent = e.message;
      dom.spawnDialog.showModal();
    }
  });

  // ── Conduct mode ─────────────────────────────────────────────────────
  // The 🎼 Conduct button spawns a temp Claude session in the hidden
  // `.conduct` project, lazy-created on first open via
  // POST /api/projects/.conduct/ensure.
  const cdMode = makeModeToggle(dom.cdModeCode, dom.cdModePlan);

  async function openConductDialog() {
    closeSidebarOverflow();
    dom.cdError.textContent = '';
    cdMode.reset();
    try {
      const r = await fetch('/api/projects/.conduct/ensure', { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        dom.cdError.textContent = err.error || `ensure failed (${r.status})`;
      }
    } catch (e) {
      dom.cdError.textContent = e.message;
    }
    dom.conductDialog.showModal();
  }
  dom.conductBtn.addEventListener('click', openConductDialog);
  dom.conductDialog.addEventListener('click', (e) => {
    const btn = e.target.closest('.cd-model');
    if (!btn) return;
    e.preventDefault();
    const family = btn.dataset.family;
    if (!family) return;
    const model = resolveSpawnModel(family);
    if (model) spawnInstance({ project: '.conduct', model, planMode: cdMode.planMode, dialogEl: dom.conductDialog, errorEl: dom.cdError });
  });

  return { openSpawnDialog, syncSonnetPickerLabels, syncFamilyVisibility };
}
