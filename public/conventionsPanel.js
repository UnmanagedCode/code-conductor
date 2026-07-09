// Reusable "conventions" module-list widget — one implementation shared by all
// three scopes on the Settings → Conventions page (Conductor / Workspace /
// Project). Renders an optional always-on core row, a per-module enable toggle
// (when the scope has a global selection), built-in rows as read-only, and
// custom rows with Add/Edit/Delete. Backed by a scope's REST endpoints.
//
// GET  <base>            → { core?, modules?, enabled? } | { rules }
// PUT  <base>/selection  → { enabled:[...] }        (only when hasToggle)
// POST <base>            → { slug, name, description, body }
// PUT  <base>/<slug>     → { name, description, body }
// DELETE <base>/<slug>
//
// Element ids are derived from `prefix`: <prefix>-status, <prefix>-module-list,
// <prefix>-add-btn/-form/-slug/-name/-desc/-body/-save/-cancel/-error.

export function installConventionsPanel({ prefix, base, hasToggle = false, hasCoreRow = false, noun = 'convention' }) {
  const $ = (suffix) => document.getElementById(`${prefix}-${suffix}`);
  const statusEl = $('status');
  const listEl = $('module-list');
  const addBtn = $('add-btn');
  const addForm = $('add-form');
  const addSlug = $('add-slug');
  const addName = $('add-name');
  const addDesc = $('add-desc');
  const addBody = $('add-body');
  const addSave = $('add-save');
  const addCancel = $('add-cancel');
  const addError = $('add-error');

  let editingSlug = null;       // null = add mode
  let enabled = new Set();      // enabled slugs (mirrors server selection)

  function render(data) {
    if (statusEl) statusEl.textContent = '';
    if (!listEl) return;
    enabled = new Set(data.enabled || []);
    listEl.innerHTML = '';

    // Always-on core row (non-toggleable).
    if (hasCoreRow && data.core) {
      const coreLi = document.createElement('li');
      coreLi.className = 'cc-module-item cc-core-item';
      const titleEl = document.createElement('span');
      titleEl.className = 'or-rule-name';
      titleEl.textContent = data.core.name;
      const descEl = document.createElement('span');
      descEl.className = 'or-rule-desc';
      descEl.textContent = data.core.description;
      const badge = document.createElement('span');
      badge.className = 'cc-core-badge';
      badge.textContent = 'always on';
      coreLi.appendChild(titleEl);
      coreLi.appendChild(badge);
      coreLi.appendChild(descEl);
      listEl.appendChild(coreLi);
    }

    const modules = data.modules || data.rules || [];
    for (const mod of modules) {
      const li = document.createElement('li');
      li.className = hasToggle ? 'cc-module-item' : 'or-rule-item';
      if (hasToggle) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'cc-module-toggle';
        cb.checked = enabled.has(mod.slug);
        cb.setAttribute('aria-label', `Enable ${mod.name}`);
        cb.addEventListener('change', () => toggle(mod.slug, cb.checked));
        li.appendChild(cb);
      }
      const titleEl = document.createElement('span');
      titleEl.className = 'or-rule-name';
      titleEl.textContent = mod.name;
      const tagEl = document.createElement('span');
      tagEl.className = 'or-rule-slug';
      tagEl.textContent = mod.slug;
      const descEl = document.createElement('span');
      descEl.className = 'or-rule-desc';
      descEl.textContent = mod.description;
      li.appendChild(titleEl);
      li.appendChild(tagEl);
      li.appendChild(descEl);
      if (!mod.builtin) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => openEditForm(mod));
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => remove(mod.slug));
        li.appendChild(editBtn);
        li.appendChild(delBtn);
      } else {
        const badge = document.createElement('span');
        badge.className = 'or-builtin-badge';
        badge.textContent = 'built-in';
        li.appendChild(badge);
      }
      listEl.appendChild(li);
    }
  }

  async function toggle(slug, on) {
    if (on) enabled.add(slug); else enabled.delete(slug);
    try {
      const r = await fetch(`${base}/selection`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: [...enabled] }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
    } catch (e) {
      if (statusEl) statusEl.textContent = `Save failed: ${e.message || e}`;
      load(); // resync from server on failure
    }
  }

  function openAddForm() {
    editingSlug = null;
    if (addSlug) { addSlug.value = ''; addSlug.disabled = false; }
    if (addName) addName.value = '';
    if (addDesc) addDesc.value = '';
    if (addBody) addBody.value = '';
    if (addError) addError.textContent = '';
    if (addForm) addForm.hidden = false;
    if (addBtn) addBtn.hidden = true;
    addSlug?.focus();
  }

  function openEditForm(mod) {
    editingSlug = mod.slug;
    if (addSlug) { addSlug.value = mod.slug; addSlug.disabled = true; }
    if (addName) addName.value = mod.name;
    if (addDesc) addDesc.value = mod.description;
    if (addBody) addBody.value = mod.body || '';
    if (addError) addError.textContent = '';
    if (addForm) addForm.hidden = false;
    if (addBtn) addBtn.hidden = true;
    addName?.focus();
  }

  function closeAddForm() {
    editingSlug = null;
    if (addForm) addForm.hidden = true;
    if (addBtn) addBtn.hidden = false;
    if (addError) addError.textContent = '';
  }

  async function save() {
    const slug = addSlug?.value.trim();
    const name = addName?.value.trim();
    const description = addDesc?.value.trim();
    const body = addBody?.value;
    if (addError) addError.textContent = '';
    try {
      if (editingSlug) {
        await fetch(`${base}/${encodeURIComponent(editingSlug)}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, description, body }),
        }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); });
      } else {
        await fetch(base, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug, name, description, body }),
        }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); });
      }
      closeAddForm();
      load();
    } catch (e) {
      if (addError) addError.textContent = e.message || String(e);
    }
  }

  async function remove(slug) {
    if (!confirm(`Delete ${noun} "${slug}"?`)) return;
    try {
      const r = await fetch(`${base}/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error);
      load();
    } catch (e) {
      if (statusEl) statusEl.textContent = `Delete failed: ${e.message || e}`;
    }
  }

  async function load() {
    if (statusEl) statusEl.textContent = 'Loading…';
    try {
      const r = await fetch(base, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      render(await r.json());
    } catch (e) {
      if (statusEl) statusEl.textContent = `Failed: ${e.message || e}`;
    }
  }

  addBtn?.addEventListener('click', openAddForm);
  addCancel?.addEventListener('click', closeAddForm);
  addSave?.addEventListener('click', save);

  return { load };
}
