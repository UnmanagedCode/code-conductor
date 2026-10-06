// Directory autocomplete for an absolute-path text input — the Adopt dialog's
// Directory field and the New-project dialog's "Path on that system" field.
//
// The input stays a plain text field: whatever is in it is what the dialog
// submits, so typing a path by hand is the same action with or without the
// list. The list is a combobox listbox of the subdirectories of the text up to
// the last `/`, fetched from `GET /api/fs/dirs` for the placement the dialog
// reports through `getPlacement()`.
//
// BARE `fetch`, NOT `apiFetch`: the endpoint answers 200 + {ok:false, code,
// reason} for every refusal, and apiFetch would read that as success. The
// reason is shown in the note; a bare code never is.
//
// CACHE. One listing per (system, remoteId, directory). Typing within a loaded
// directory only re-filters — no timer, no request. A refusal is cached too
// (the same directory is not asked again) unless its code is in
// TRANSIENT_REFUSAL_CODES; a transport failure is never cached. The
// dialog calls `reset()` whenever the placement or the dialog itself resets.
//
// STALENESS. Every request carries a sequence number and an AbortController; a
// response whose number is not the latest is dropped, and a response for a
// directory the input no longer names is cached but not rendered.
//
// Injected interface:
//   - input: the text input.   - list: the <ul role="listbox"> (needs an id).
//   - note: element that carries the status line.
//   - getPlacement(): { system: string|null, remoteId: string|null }.
//   - timers: { setTimeout, clearTimeout } — injectable for tests.
//
// textContent everywhere, never innerHTML: names come off a disk.

export const PATH_PICKER_DEBOUNCE_MS = 250;

// Refusal codes that describe the moment, not the directory: they show their
// reason but are not cached, so typing in that directory again retries. Every
// other refusal (ENOENT, EACCES, …) is a fact about the path and stays cached.
export const TRANSIENT_REFUSAL_CODES = new Set(['LIST_TIMEOUT', 'ETIMEDOUT', 'ETRANSPORT', 'SYSTEM_UNREACHABLE']);

// `/a/b/pre` → dir `/a/b`, dirSlash `/a/b/`, prefix `pre`. Only POSIX-absolute
// text is completed; anything else (a Windows `C:\…` path, a relative path,
// empty) returns null and is left to free typing.
export function splitPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const i = value.lastIndexOf('/');
  return {
    dir: i === 0 ? '/' : value.slice(0, i),
    dirSlash: value.slice(0, i + 1),
    prefix: value.slice(i + 1),
  };
}

export function installPathPicker({
  input, list, note, getPlacement,
  timers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) },
}) {
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');

  const cache = new Map();
  let timer = null;
  let controller = null;
  let inflightDir = null;
  let seq = 0;
  let shown = [];
  let active = -1;
  let current = null; // the splitPath of the rendered list, for completion

  const keyOf = (placement, dir) => `${placement.system ?? 'local'}\n${placement.remoteId ?? ''}\n${dir}`;
  const listOpen = () => !list.hidden && shown.length > 0;

  function close() {
    shown = [];
    active = -1;
    list.hidden = true;
    list.textContent = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function abort() {
    if (controller) controller.abort();
    controller = null;
    inflightDir = null;
  }

  function setActive(i) {
    active = i;
    [...list.children].forEach((li, n) => li.setAttribute('aria-selected', n === i ? 'true' : 'false'));
    if (i >= 0) input.setAttribute('aria-activedescendant', `${list.id}-opt-${i}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function render(entry, s) {
    const { names, unresolved, truncated, max } = entry;
    shown = names.filter(n => n.startsWith(s.prefix) && (s.prefix.startsWith('.') || !n.startsWith('.')));
    current = s;
    note.textContent = truncated
      ? `${s.dir} has more than ${max} directories; only the first ${max} by name are offered.`
      : '';
    list.textContent = '';
    if (shown.length === 0) { close(); return; }
    shown.forEach((name, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.id = `${list.id}-opt-${i}`;
      li.setAttribute('aria-selected', 'false');
      li.textContent = name;
      if (unresolved.has(name)) {
        li.className = 'path-completion-unresolved';
        li.title = 'symlink — not checked to be a directory';
      }
      list.appendChild(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  }

  function show(entry, s) {
    if (entry.refusal) {
      close();
      note.textContent = entry.refusal.reason || `could not list ${s.dir}.`;
      return;
    }
    render(entry, s);
  }

  async function fetchDir(s, placement, key) {
    abort();
    const mySeq = ++seq;
    controller = new AbortController();
    inflightDir = s.dir;
    const params = new URLSearchParams({ path: s.dir });
    if (placement.system) params.set('system', placement.system);
    if (placement.remoteId) params.set('remoteId', placement.remoteId);
    note.textContent = `Listing ${s.dir}…`;
    let data;
    try {
      const res = await fetch('/api/fs/dirs?' + params, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      if (mySeq !== seq || e?.name === 'AbortError') return;
      inflightDir = null;
      note.textContent = `Could not list ${s.dir} (${e.message}).`;
      return;
    }
    if (mySeq !== seq) return;
    inflightDir = null;
    const entry = data?.ok === true
      ? {
        names: [...(data.entries ?? []), ...(data.links ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        unresolved: new Set(data.links ?? []),
        truncated: !!data.truncated,
        max: data.max,
      }
      : { refusal: { reason: typeof data?.reason === 'string' ? data.reason : '' } };
    if (!(entry.refusal && TRANSIENT_REFUSAL_CODES.has(data?.code))) cache.set(key, entry);
    const now = splitPath(input.value);
    if (!now || now.dir !== s.dir) return;
    show(entry, now);
  }

  function onInput() {
    if (timer !== null) { timers.clearTimeout(timer); timer = null; }
    const s = splitPath(input.value);
    if (!s) {
      abort();
      seq++;
      close();
      note.textContent = '';
      return;
    }
    const placement = getPlacement();
    const key = keyOf(placement, s.dir);
    const hit = cache.get(key);
    if (hit) {
      abort();
      seq++;
      show(hit, s);
      return;
    }
    if (inflightDir !== null && inflightDir !== s.dir) { abort(); seq++; }
    close();
    note.textContent = '';
    timer = timers.setTimeout(() => {
      timer = null;
      fetchDir(s, placement, key);
    }, PATH_PICKER_DEBOUNCE_MS);
  }

  function complete(name) {
    if (!current) return;
    input.value = current.dirSlash + name + '/';
    close();
    input.dispatchEvent(new (input.ownerDocument.defaultView.Event)('input', { bubbles: true }));
  }

  function onKeydown(e) {
    if (!listOpen()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = shown.length;
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1);
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      complete(shown[active >= 0 ? active : 0]);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      complete(shown[active]);
    } else if (e.key === 'Escape') {
      // The dialog's own Esc would cancel the whole form.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  input.addEventListener('blur', close);
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', e => {
    const li = e.target.closest?.('li');
    if (!li || !list.contains(li)) return;
    const i = [...list.children].indexOf(li);
    if (i >= 0) complete(shown[i]);
  });

  return {
    reset() {
      if (timer !== null) { timers.clearTimeout(timer); timer = null; }
      abort();
      seq++;
      cache.clear();
      close();
      note.textContent = '';
    },
  };
}
