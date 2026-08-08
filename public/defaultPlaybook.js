// Settings → Conventions → Conductor → Default playbook picker.
//
// The selected playbook is rendered into the conductor's role prompt as a
// generated convention (see src/playbookConvention.ts), so a conductor knows its
// baseline graph without a tool call. "None" injects nothing.
//
// Fed by the conductor conventions panel's payload (`playbooks`,
// `playbookErrors`, `defaultPlaybook`) rather than a fetch of its own — one GET
// backs the whole block.
//
// Element ids: dp-select, dp-status.

export function installDefaultPlaybook({ base }) {
  const selectEl = document.getElementById('dp-select');
  const statusEl = document.getElementById('dp-status');

  function render(data) {
    if (!selectEl) return;
    const playbooks = data.playbooks || [];
    selectEl.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'None — no playbook convention injected';
    selectEl.appendChild(none);
    for (const pb of playbooks) {
      const opt = document.createElement('option');
      opt.value = pb.id;
      opt.textContent = `${pb.id} — ${pb.name}`;
      selectEl.appendChild(opt);
    }
    selectEl.value = data.defaultPlaybook || '';
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
    const id = selectEl.value || null;
    try {
      const r = await fetch(`${base}/default-playbook`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      if (statusEl) statusEl.textContent = '';
    } catch (e) {
      if (statusEl) statusEl.textContent = `Save failed: ${e.message || e}`;
    }
  });

  return { render };
}
