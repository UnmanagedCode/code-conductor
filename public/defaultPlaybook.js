// Settings → Conventions → Conductor → Preferred playbook picker.
//
// The selected playbook is rendered into the conductor's role prompt as a
// generated convention (see src/playbookConvention.ts), so a conductor knows its
// baseline graph without a tool call.
//
// Three states, mirroring DefaultPlaybookSelection (src/conductorConventions.ts):
// unset (resolves to the payload's `defaultPlaybookFallback`), the explicit
// "None" opt-out, and a chosen id. Never having chosen is not "chose nothing",
// so the two are separate rows.
//
// Fed by the conductor conventions panel's payload (`playbooks`,
// `playbookErrors`, `defaultPlaybook`) rather than a fetch of its own — one GET
// backs the whole block.
//
// Element ids: dp-select, dp-status.

import { apiFetch } from './http.js';

export function installDefaultPlaybook({ base }) {
  const selectEl = document.getElementById('dp-select');
  const statusEl = document.getElementById('dp-status');

  function render(data) {
    if (!selectEl) return;
    const playbooks = data.playbooks || [];
    selectEl.innerHTML = '';
    const add = (value, text) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      selectEl.appendChild(opt);
    };
    // The fallback id comes from the payload — the server constant is its one home.
    add('unset', `Unset — falls back to ${data.defaultPlaybookFallback}`);
    add('none', 'None — no playbook convention injected');
    // `playbook:` prefixed so an id of "none"/"unset" can't collide with a mode.
    for (const pb of playbooks) add(`playbook:${pb.id}`, `${pb.id} — ${pb.name}`);
    const sel = data.defaultPlaybook || { mode: 'unset' };
    selectEl.value = sel.mode === 'playbook' ? `playbook:${sel.id}` : sel.mode;
    // A definition rejected at load is simply absent from the list; without this
    // the user has no way to find out why theirs never appeared.
    const errors = data.playbookErrors || [];
    if (statusEl) {
      statusEl.textContent = errors.length
        ? `${errors.length} playbook definition(s) rejected at load: ${errors.map(e => `${e.id}: ${e.message}`).join('; ')}`
        : '';
    }
  }

  selectEl?.addEventListener('change', async () => {
    const v = selectEl.value;
    const defaultPlaybook = v.startsWith('playbook:')
      ? { mode: 'playbook', id: v.slice('playbook:'.length) }
      : { mode: v };
    try {
      await apiFetch(`${base}/default-playbook`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultPlaybook }),
      });
      if (statusEl) statusEl.textContent = '';
    } catch (e) {
      if (statusEl) statusEl.textContent = `Save failed: ${e.message || e}`;
    }
  });

  return { render };
}
