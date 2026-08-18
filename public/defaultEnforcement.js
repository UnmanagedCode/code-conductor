// Settings → Conventions → Conductor → Playbook enforcement picker.
//
// The persisted level a NEWLY SPAWNED conductor starts at (applied in
// Manager._doCreate, src/instances.ts). The ⋮ overflow toggle
// (#playbook-enforcement-btn, public/header.js) is a per-session override and
// deliberately does NOT write here.
//
// Rows come from the payload's `playbookEnforcementModes`, not a client-side
// list: src/playbooks.ts owns the allow-list.
//
// Fed by the conductor conventions panel's payload alongside the preferred-playbook
// picker — one GET backs the whole block.
//
// Element ids: dpe-select, dpe-status.

import { apiFetch } from './http.js';

// Row text per mode. A mode with no entry still renders (by its bare id), so the
// server list stays the authority on which rows exist.
const LABELS = {
  enforce: 'Enforce — off-graph calls are refused',
  warn: 'Warn — off-graph calls are ledgered and proceed',
};

export function installDefaultEnforcement({ base }) {
  const selectEl = document.getElementById('dpe-select');
  const statusEl = document.getElementById('dpe-status');

  function render(data) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    for (const mode of data.playbookEnforcementModes || []) {
      const opt = document.createElement('option');
      opt.value = mode;
      opt.textContent = LABELS[mode] || mode;
      selectEl.appendChild(opt);
    }
    if (data.defaultPlaybookEnforcement) selectEl.value = data.defaultPlaybookEnforcement;
  }

  selectEl?.addEventListener('change', async () => {
    try {
      await apiFetch(`${base}/default-playbook-enforcement`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: selectEl.value }),
      });
      if (statusEl) statusEl.textContent = '';
    } catch (e) {
      if (statusEl) statusEl.textContent = `Save failed: ${e.message || e}`;
    }
  });

  return { render };
}
