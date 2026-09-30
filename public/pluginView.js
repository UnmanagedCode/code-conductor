// Full-page iframe view for plugin frontends, owning the `#plugin/<id>/
// <subpath>` hash space. Built on installHashView's scaffold via the
// additive `matchHash` predicate (Escape/back/teardown mechanics shared
// with review/commits/costs); opening is hash-driven here because — unlike
// those views — entry points are the app switcher, links and page load,
// not an open() call site.
//
// Loading is REST-driven so an enabled-but-stopped plugin auto-starts with
// a visible affordance: GET status → (POST start when not ready, overlay
// "Starting …") → iframe src; a start failure shows the error + crash tail
// with a Retry button instead of the proxy's raw 503 JSON inside the frame.
//
// Parent side of the plugin bridge (public/pluginBridge.js runs inside the
// iframe): child `route` messages mirror into the hash via replaceState
// (no hashchange fires, so no reload loop); external subpath changes are
// forwarded as `navigate` messages instead of reloading the iframe.
//
// Two frame tiers, chosen by the status row's `frontendKeepAlive`:
//   - a plain plugin loads into the one shared `#plugin-frame`; teardown or a
//     switch to another plugin blanks it, so a closed plugin costs no memory.
//   - a keep-alive plugin gets its own resident frame on first show. Leaving
//     only hides it (the section's `hidden`), so its page — a call, a stream —
//     keeps running; re-entry reveals it with no /start and no src change.
//     Re-entry at `/` (what the app switcher writes) keeps the frame's own
//     route and rewrites the hash to it; any other subpath is posted as a
//     `navigate`. A resident frame is evicted (removed, ending its page) only
//     when its row stops passing `keepsResident` — checked in the background on
//     re-entry and by `reconcile()`, which app.js runs after every Settings →
//     Plugins action — or when that action is one of `EVICTING_ACTIONS` on it. `onResidentChange` fires whenever the resident set
//     changes (app.js re-renders the switcher's marker off `residentIds()`).
//
// Navigation via replaceState/pushState never fires hashchange, so the
// hashchange teardown can't cover it: another main view opening, or a sidebar
// session select, supersedes this view through mainViews.js, and `close()` is the
// switcher's Conductor entry exit. `onClosed` fires after every teardown,
// supersede included (the app switcher re-syncs its dropdown off it). `onShown` fires
// on every entry into the `#plugin/` space (dropdown select, deep link,
// page-load boot) AND on a plugin-to-plugin switch within an already-open
// view (app.js uses it to collapse the mobile sidebar drawer, same idiom as
// selectInstance revealing a picked session).

import { installHashView } from './hashView.js';

const PREFIX = '#plugin/';
const HASH_RE = /^#plugin\/([a-z][a-z0-9-]*)(\/.*)?$/;

// The row states a resident frame survives: a crashed or failed backend and
// the lazy restart the page's own requests trigger keep the page, which is
// expected to cope with its backend coming back. An allowlist, so an
// unfamiliar state evicts.
const RESIDENT_STATES = ['starting', 'ready', 'crashed', 'failed'];
// The Settings → Plugins actions that put new code under a plugin: the user
// asked for it, so its page is reloaded rather than kept on the old code.
const EVICTING_ACTIONS = ['restart', 'update', 'version'];

function keepsResident(row) {
  return row.enabled === true && row.frontendKeepAlive === true && RESIDENT_STATES.includes(row.state);
}

export function installPluginView({ onClosed, onShown, onResidentChange } = {}) {
  const view = document.getElementById('plugin-view');
  if (!view) return { close() {}, reconcile: async () => {}, residentIds: () => [] };

  let iframe = null;  // the shared frame plain plugins load into
  let overlay = null;
  // The showing plugin: a { id, subpath } target while it loads into the
  // shared frame, or the resident record itself, so a route updates it in place.
  let current = null;
  let loadToken = 0;  // invalidates in-flight loads on switch/teardown
  const resident = new Map(); // plugin id → { id, subpath, frame }

  const activeFrame = () => current?.frame ?? iframe;

  function parseHash(h) {
    const m = HASH_RE.exec(h);
    return m ? { id: m[1], subpath: m[2] ?? '/' } : null;
  }

  function ensureEls() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'plugin-overlay';
      overlay.hidden = true;
      view.appendChild(overlay);
    }
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.id = 'plugin-frame';
      iframe.addEventListener('load', () => { if (current) hideOverlay(); });
      view.appendChild(iframe);
    }
  }

  function hideOverlay() {
    if (overlay) { overlay.hidden = true; overlay.innerHTML = ''; }
  }

  function showOverlay(message, { retryTarget } = {}) {
    overlay.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'plugin-overlay-msg';
    p.textContent = message;
    overlay.appendChild(p);
    if (retryTarget) {
      overlay.classList.add('plugin-overlay-error');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Retry';
      btn.addEventListener('click', () => load(retryTarget));
      overlay.appendChild(btn);
    } else {
      overlay.classList.remove('plugin-overlay-error');
    }
    overlay.hidden = false;
  }

  async function api(method, path) {
    const r = await fetch(path, { method, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(data.error || `HTTP ${r.status}`);
      e.tail = data.tail;
      e.status = r.status;
      throw e;
    }
    return data;
  }

  const statusOf = id => api('GET', `/api/plugins/${encodeURIComponent(id)}/status`);

  // Whether a resident frame stays. Only a 404 (the id is unknown) evicts on a
  // failed read: a network blip or a 5xx must not end a call.
  async function stillResident(id) {
    try { return keepsResident(await statusOf(id)); } catch (e) { return e.status !== 404; }
  }

  function blankShared() {
    if (!iframe) return;
    iframe.src = 'about:blank';
    iframe.hidden = true;
  }

  function evict(record) {
    if (resident.get(record.id) !== record) return;
    record.frame.remove(); // discards the browsing context: tracks, sockets and timers end
    resident.delete(record.id);
    if (current === record) current = null;
    onResidentChange?.();
  }

  function mountResident(target) {
    const record = { id: target.id, subpath: target.subpath, frame: document.createElement('iframe') };
    record.frame.className = 'plugin-frame-resident';
    record.frame.dataset.pluginId = target.id;
    record.frame.addEventListener('load', () => { if (current === record) hideOverlay(); });
    // Appended once and only ever toggled with `hidden`: moving an iframe in
    // the DOM reloads it.
    view.appendChild(record.frame);
    resident.set(target.id, record);
    current = record;
    blankShared();
    record.frame.src = `/plugins/${target.id}${target.subpath}`; // overlay clears on frame load
    onResidentChange?.();
  }

  function showResident(record, target) {
    const token = ++loadToken;
    hideOverlay();
    blankShared();
    for (const r of resident.values()) r.frame.hidden = r !== record;
    current = record;
    if (target.subpath === '/' || target.subpath === record.subpath) {
      const hash = `#plugin/${record.id}${record.subpath}`;
      if (location.hash !== hash) history.replaceState(null, '', hash);
    } else {
      record.subpath = target.subpath;
      record.frame.contentWindow?.postMessage({ cc: 1, type: 'navigate', path: target.subpath }, location.origin);
    }
    // Background check, never blocking the reveal: a plugin stopped or
    // disabled elsewhere is evicted and loaded afresh the plain way.
    stillResident(record.id).then((keep) => {
      if (keep || token !== loadToken) return;
      evict(record);
      load(parseHash(location.hash) ?? target);
    });
  }

  async function load(target) {
    const record = resident.get(target.id);
    if (record) { showResident(record, target); return; }
    ensureEls();
    for (const r of resident.values()) r.frame.hidden = true;
    iframe.hidden = false;
    current = target;
    hideOverlay();
    const token = ++loadToken;
    try {
      const st = await statusOf(target.id);
      if (token !== loadToken) return;
      if (st.state !== 'ready') {
        // Lazy start on switch: the explicit start doubles as the readiness
        // wait (the route returns once the child answers, ≤30s).
        showOverlay(`Starting ${st.name || target.id}…`);
        await api('POST', `/api/plugins/${encodeURIComponent(target.id)}/start`);
        if (token !== loadToken) return;
      }
      if (st.frontendKeepAlive) mountResident(target);
      else iframe.src = `/plugins/${target.id}${target.subpath}`; // overlay clears on iframe load
    } catch (e) {
      if (token !== loadToken) return;
      showOverlay(`${target.id}: ${e.message}${e.tail ? `\n\n${e.tail}` : ''}`, { retryTarget: target });
    }
  }

  const hv = installHashView({
    name: 'plugin',
    matchHash: h => h.startsWith(PREFIX),
    navigate: () => {}, // the hash is already set by whoever navigated here
    onShow: () => {
      const target = parseHash(location.hash);
      if (target) load(target);
      onShown?.();
    },
    onTeardown: () => {
      current = null;
      loadToken++;
      hideOverlay();
      if (iframe) iframe.src = 'about:blank';
      onClosed?.();
    },
  });

  function onHashChange() {
    const target = parseHash(location.hash);
    if (!target) return; // leaving the space — hashView tears down
    if (!current) { hv.open(); return; }
    if (target.id !== current.id) { load(target); onShown?.(); return; }
    if (target.subpath !== current.subpath) {
      // Same plugin, new subpath from outside the iframe: steer the child
      // instead of reloading it.
      current.subpath = target.subpath;
      activeFrame()?.contentWindow?.postMessage({ cc: 1, type: 'navigate', path: target.subpath }, location.origin);
    }
  }
  window.addEventListener('hashchange', onHashChange);

  // Child → parent bridge messages ({cc:1} envelope; ready / route only).
  // A hidden resident frame's route is tracked on its record, never mirrored
  // into the URL — the user is somewhere else.
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin) return;
    const active = !!current && !!activeFrame() && ev.source === activeFrame().contentWindow;
    const record = active ? current
      : [...resident.values()].find(r => ev.source && ev.source === r.frame.contentWindow);
    if (!record) return;
    const d = ev.data;
    if (!d || d.cc !== 1) return;
    if (d.type === 'route' && typeof d.path === 'string') {
      record.subpath = d.path;
      // replaceState: mirrors the child's route into the URL without adding
      // history entries and without firing hashchange (no reload loop).
      if (active) history.replaceState(null, '', `#plugin/${record.id}${d.path}`);
    }
    // 'ready' needs no action in v1 — the iframe is already visible.
  });

  // Re-check every resident frame against its row, after a Settings →
  // Plugins action (`change` = {action, ids} from pluginManager.js, or
  // undefined). One that no longer qualifies, or that the action put new code
  // under, is evicted — and reloaded the plain way when it is showing.
  async function reconcile(change) {
    const renewed = EVICTING_ACTIONS.includes(change?.action) ? change.ids : [];
    await Promise.all([...resident.values()].map(async (record) => {
      if (!renewed.includes(record.id) && await stillResident(record.id)) return;
      const showing = current === record;
      evict(record);
      const target = showing ? parseHash(location.hash) : null;
      if (target) load(target);
    }));
  }

  // Page loaded directly on a plugin hash (reload, shared link).
  if (parseHash(location.hash)) hv.open();

  return { close: hv.close, reconcile, residentIds: () => [...resident.keys()] };
}
