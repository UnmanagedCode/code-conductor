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
// Teardown blanks the iframe so a closed plugin costs no memory. `close()`
// is the deterministic exit used by app.js when navigation happens via
// replaceState/pushState (sidebar session select, review open, the
// switcher's Conductor entry) — those never fire hashchange, so the
// hashchange teardown can't cover them; `onClosed` fires after every
// teardown (the app switcher re-syncs its dropdown off it). `onShown` fires
// once per entry into the `#plugin/` space (dropdown select, deep link,
// page-load boot) — NOT on a plugin-to-plugin switch within an already-open
// view (app.js uses it to collapse the mobile sidebar drawer, same idiom as
// selectInstance revealing a picked session).

import { installHashView } from './hashView.js';

const PREFIX = '#plugin/';
const HASH_RE = /^#plugin\/([a-z][a-z0-9-]*)(\/.*)?$/;

export function installPluginView({ onClosed, onShown } = {}) {
  const view = document.getElementById('plugin-view');
  if (!view) return { close() {} };

  let iframe = null;
  let overlay = null;
  let current = null; // { id, subpath } of the loaded iframe
  let loadToken = 0;  // invalidates in-flight loads on switch/teardown

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
      throw e;
    }
    return data;
  }

  async function load(target) {
    current = target;
    ensureEls();
    hideOverlay();
    const token = ++loadToken;
    try {
      const st = await api('GET', `/api/plugins/${encodeURIComponent(target.id)}/status`);
      if (token !== loadToken) return;
      if (st.state !== 'ready') {
        // Lazy start on switch: the explicit start doubles as the readiness
        // wait (the route returns once the child answers, ≤30s).
        showOverlay(`Starting ${st.name || target.id}…`);
        await api('POST', `/api/plugins/${encodeURIComponent(target.id)}/start`);
        if (token !== loadToken) return;
      }
      iframe.src = `/plugins/${target.id}${target.subpath}`; // overlay clears on iframe load
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
    if (target.id !== current.id) { load(target); return; }
    if (target.subpath !== current.subpath) {
      // Same plugin, new subpath from outside the iframe: steer the child
      // instead of reloading it.
      current.subpath = target.subpath;
      iframe?.contentWindow?.postMessage({ cc: 1, type: 'navigate', path: target.subpath }, location.origin);
    }
  }
  window.addEventListener('hashchange', onHashChange);

  // Child → parent bridge messages ({cc:1} envelope; ready / route only).
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin) return;
    if (!current || !iframe || ev.source !== iframe.contentWindow) return;
    const d = ev.data;
    if (!d || d.cc !== 1) return;
    if (d.type === 'route' && typeof d.path === 'string') {
      current.subpath = d.path;
      // replaceState: mirrors the child's route into the URL without adding
      // history entries and without firing hashchange (no reload loop).
      history.replaceState(null, '', `#plugin/${current.id}${d.path}`);
    }
    // 'ready' needs no action in v1 — the iframe is already visible.
  });

  // Page loaded directly on a plugin hash (reload, shared link).
  if (parseHash(location.hash)) hv.open();

  return { close: hv.close };
}
